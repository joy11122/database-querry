import { NextResponse } from "next/server";
import OpenAI from "openai";
import { Parser } from "node-sql-parser";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/mongoose";
import { DBConnectionModel } from "@/db/models/db-connection.model";
import { UsageEventModel } from "@/db/models/usage-event.model";
import { getUserPlan } from "@/services/billing/usage";
import { decodeExternalDbConfig } from "@/lib/external-database";
import { toPublicError } from "@/lib/errors";
import { Client as PgClient } from "pg";
import mysql from "mysql2/promise";
import { MongoClient } from "mongodb";

export const runtime = "nodejs";
const inputSchema = z.object({ question: z.string().trim().min(3).max(2000), connectionId: z.string().regex(/^[a-f\d]{24}$/i) });
const parser = new Parser();

function validateReadOnlySql(raw: string, dialect: "postgresql" | "mysql"): string {
  const sql = raw.trim().replace(/;+\s*$/, "");
  if (!sql || sql.includes(";") || sql.includes("--") || sql.includes("/*") || sql.includes("*/") || sql.length > 12000) throw new Error("The generated query is not a single statement.");
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|execute|into|outfile|load_file|information_schema|sleep|benchmark)\b/i.test(sql) || /\bfor\s+(update|share)\b|\block\s+in\s+share\s+mode\b/i.test(sql)) throw new Error("Only read-only SELECT queries are allowed.");
  const ast = parser.astify(sql, { database: dialect === "postgresql" ? "Postgresql" : "MySQL" });
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1 || !statements[0] || (statements[0] as { type?: string }).type !== "select") throw new Error("Only SELECT queries are allowed.");
  const limited = /\blimit\s+(\d+)/i.exec(sql);
  if (limited) return sql.replace(/\blimit\s+\d+/i, `LIMIT ${Math.min(100, Math.max(1, Number(limited[1])))}`);
  return `${sql} LIMIT 100`;
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Please sign in." } }, { status: 401 });
  const started = Date.now();
  try {
    const input = inputSchema.parse(await request.json());
    await connectMongoose();
    const [plan, connection] = await Promise.all([
      getUserPlan(session.user.id),
      DBConnectionModel.findOne({ _id: input.connectionId, userId: session.user.id, isActive: true }).exec(),
    ]);
    if (!connection) return NextResponse.json({ error: { code: "CONNECTION_NOT_FOUND", message: "Choose an active database connection that belongs to your account." } }, { status: 404 });
    if (plan.remaining <= 0) return NextResponse.json({ error: { code: "USAGE_LIMIT", message: "Your monthly AI question limit has been reached." } }, { status: 429 });
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: { code: "AI_NOT_CONFIGURED", message: "AI query generation is not configured. Add OPENAI_API_KEY to your deployment environment." } }, { status: 503 });
    const config = decodeExternalDbConfig(connection);
    if (config.type === "mongodb") {
      const mongo = new MongoClient(config.uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
      try {
        await mongo.connect();
        const db = mongo.db(config.database);
        const collections = (await db.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name).filter(name => !name.startsWith("system."));
        const schema = [];
        for (const name of collections.slice(0, 100)) {
          const sample = await db.collection(name).findOne({}, { projection: { _id: 0 }, maxTimeMS: 2500 });
          schema.push({ collection: name, fields: sample && typeof sample === "object" ? Object.keys(sample).slice(0, 80) : [] });
        }
        const client = new OpenAI({ apiKey });
        const completion = await client.chat.completions.create({
          model: process.env.OPENAI_MODEL || "gpt-4o-mini", temperature: 0, max_tokens: 800,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "Translate the business question to a MongoDB aggregation pipeline. Return JSON only: {\\"collection\\":\\"name\\",\\"pipeline\\":[...],\\"summary\\":\\"short explanation\\"}. Only use the provided collection and field names. The pipeline must be read-only and use only $match, $group, $project, $sort, $limit, $unwind, $count, $addFields, $set, $skip. Never use $out, $merge, $lookup, $function, $where, $accumulator, $unionWith, $documents, $geoNear, $changeStream, $search, or system collections. No more than 8 stages. Do not invent fields." },
            { role: "user", content: `MongoDB collections and sample fields: ${JSON.stringify(schema)}\nQuestion: ${input.question}` }
          ]
        });
        const text = completion.choices[0]?.message.content;
        if (!text) throw new Error("AI did not return a pipeline.");
        const generated = z.object({ collection: z.string().min(1).max(120), pipeline: z.array(z.record(z.unknown())).min(1).max(8), summary: z.string().max(500).default("Query completed.") }).parse(JSON.parse(text));
        if (!collections.includes(generated.collection)) throw new Error("Unknown collection.");
        const allowed = new Set(["$match", "$group", "$project", "$sort", "$limit", "$unwind", "$count", "$addFields", "$set", "$skip"]);
        for (const stage of generated.pipeline) {
          const keys = Object.keys(stage);
          if (keys.length !== 1 || !allowed.has(keys[0])) throw new Error("Unsupported aggregation stage.");
          if (keys[0] === "$limit") stage.$limit = Math.min(100, Math.max(1, Number(stage.$limit) || 100));
          if (keys[0] === "$skip") stage.$skip = Math.min(10000, Math.max(0, Number(stage.$skip) || 0));
          if (keys[0] === "$match" && JSON.stringify(stage).match(/\\$where|\\$function|\\$regex/i)) throw new Error("Unsafe match expression.");
        }
        if (!generated.pipeline.some(stage => "$limit" in stage)) generated.pipeline.push({ $limit: 100 });
        const rows = await db.collection(generated.collection).aggregate(generated.pipeline as import("mongodb").Document[], { maxTimeMS: 10000, allowDiskUse: false }).toArray();
        const columns = [...new Set(rows.flatMap(row => Object.keys(row)))].slice(0, 100);
        await UsageEventModel.create({ userId: session.user.id, kind: "query_success", createdAt: new Date(), durationMs: Date.now() - started, rowCount: rows.length, metadata: { connectionId: String(connection._id), dialect: "mongodb" } });
        return NextResponse.json({ summary: generated.summary, sql: JSON.stringify({ collection: generated.collection, pipeline: generated.pipeline }, null, 2), columns, rows: rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : typeof value === "object" && value !== null ? JSON.stringify(value) : value]))), rowCount: rows.length, truncated: rows.length >= 100, remaining: Math.max(0, plan.remaining - 1) });
      } finally { await mongo.close(); }
    }
    const schema = config.type === "postgres" ? await getSchema(config, "postgresql") : await getSchema(config, "mysql");
    const client = new OpenAI({ apiKey });
    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0,
      max_tokens: 700,
      messages: [
        { role: "system", content: "You convert business questions into ONE read-only SQL SELECT query. Return JSON only: {\"sql\":\"...\",\"summary\":\"short plain-English explanation\"}. Use only tables and columns listed in the schema. Never invent columns. Never use comments, multiple statements, DDL, DML, system catalogs, or write operations. Do not include a semicolon. The server applies a 100-row cap." },
        { role: "user", content: `Database dialect: ${config.type}. Schema JSON: ${JSON.stringify(schema)}\nQuestion: ${input.question}` },
      ],
      response_format: { type: "json_object" },
    });
    const content = completion.choices[0]?.message.content;
    if (!content) throw new Error("AI did not return a query.");
    const generated = z.object({ sql: z.string().min(1).max(12000), summary: z.string().max(500).default("Query completed.") }).parse(JSON.parse(content));
    const sql = validateReadOnlySql(generated.sql, config.type === "postgres" ? "postgresql" : "mysql");
    const result = await executeReadOnly(config, sql);
    await UsageEventModel.create({ userId: session.user.id, kind: "query_success", createdAt: new Date(), durationMs: Date.now() - started, rowCount: result.rows.length, metadata: { connectionId: String(connection._id), dialect: config.type } });
    return NextResponse.json({ summary: generated.summary, sql, columns: result.columns, rows: result.rows, rowCount: result.rows.length, truncated: result.rows.length >= 100, remaining: Math.max(0, plan.remaining - 1) });
  } catch (error) {
    const safe = toPublicError(error);
    if (safe.statusCode === 400) return NextResponse.json({ error: { code: safe.code, message: "Please enter a clear question and try again." } }, { status: 400 });
    console.error("Analytics query failed", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: { code: "QUERY_FAILED", message: "The analytics query could not be completed. Check your connection and question, then try again." } }, { status: 400 });
  }
}

async function getSchema(config: Extract<ReturnType<typeof decodeExternalDbConfig>, { type: "postgres" | "mysql" }>, dialect: "postgresql" | "mysql") {
  if (dialect === "postgresql") {
    const client = new PgClient({ host: config.host, port: config.port, database: config.database, user: config.username, password: config.password, ssl: config.ssl ? { rejectUnauthorized: true } : false, connectionTimeoutMillis: 8000, statement_timeout: 8000 });
    try {
      await client.connect();
      const result = await client.query("SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position LIMIT 1000");
      return result.rows;
    } finally { await client.end().catch(() => undefined); }
  }
  const connection = await mysql.createConnection({ host: config.host, port: config.port, database: config.database, user: config.username, password: config.password, ssl: config.ssl ? { rejectUnauthorized: true } : undefined, connectTimeout: 8000, multipleStatements: false });
  try {
    const [rows] = await connection.query("SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = ? ORDER BY table_name, ordinal_position LIMIT 1000", [config.database]);
    return rows;
  } finally { await connection.end(); }
}

async function executeReadOnly(config: Extract<ReturnType<typeof decodeExternalDbConfig>, { type: "postgres" | "mysql" }>, sql: string): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  if (config.type === "postgres") {
    const client = new PgClient({ host: config.host, port: config.port, database: config.database, user: config.username, password: config.password, ssl: config.ssl ? { rejectUnauthorized: true } : false, connectionTimeoutMillis: 8000, statement_timeout: 10000, query_timeout: 10000 });
    try {
      await client.connect();
      await client.query("BEGIN READ ONLY");
      const result = await client.query(sql);
      await client.query("ROLLBACK");
      return { columns: result.fields.map(field => field.name), rows: result.rows as Record<string, unknown>[] };
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { await client.end().catch(() => undefined); }
  }
  const connection = await mysql.createConnection({ host: config.host, port: config.port, database: config.database, user: config.username, password: config.password, ssl: config.ssl ? { rejectUnauthorized: true } : undefined, connectTimeout: 8000, multipleStatements: false });
  try {
    await connection.query("SET TRANSACTION READ ONLY");
    await connection.query("START TRANSACTION READ ONLY");
    await connection.query("SET SESSION MAX_EXECUTION_TIME=10000");
    const [rows, fields] = await connection.query(sql);
    await connection.query("ROLLBACK");
    return { columns: (fields as { name: string }[]).map(field => field.name), rows: rows as Record<string, unknown>[] };
  } finally { await connection.end(); }
}
