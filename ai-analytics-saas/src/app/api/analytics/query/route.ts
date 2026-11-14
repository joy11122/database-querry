import { NextResponse } from "next/server";
import OpenAI from "openai";
import { Parser } from "node-sql-parser";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/mongoose";
import { DBConnectionModel } from "@/db/models/db-connection.model";
import { UsageEventModel } from "@/db/models/usage-event.model";
import { consumeRateLimit, getUserPlan, releaseQueryUsage, reserveQueryUsage } from "@/services/billing/usage";
import { assertSafeExternalHost, assertSafeMongoUri, decodeExternalDbConfig } from "@/lib/external-database";
import { toPublicError } from "@/lib/errors";
import { validateMongoAnalyticsQuery } from "@/services/ai/query-validator.service";
import { Client as PgClient } from "pg";
import mysql from "mysql2/promise";
import { MongoClient } from "mongodb";
import { normalizeSqlWords, quoteSqlIdentifier, SQL_INTENT_PATTERNS, unquoteSqlIdentifier } from "@/lib/sql-patterns";

export const runtime = "nodejs";
const inputSchema = z.object({ question: z.string().trim().min(3).max(2000), connectionId: z.string().regex(/^[a-f\d]{24}$/i) });
const parser = new Parser();

function validateReadOnlySql(raw: string, dialect: "postgresql" | "mysql", schema?: SqlSchemaRow[], currentDatabase?: string): string {
  const sql = raw.trim().replace(/;+\s*$/, "");
  if (!/^\s*select\b/i.test(sql) || sql.includes(";") || sql.includes("--") || sql.includes("/*") || sql.includes("*/") || sql.length > 12000) throw new Error("The generated query is not a single statement.");
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|execute|into|outfile|load_file|information_schema|pg_catalog|mysql\.user|sleep|benchmark)\b/i.test(sql) || /\b(pg_sleep|pg_read_file|pg_ls_dir|lo_import|lo_export|load_file|sleep|benchmark|get_lock|release_lock)\s*\(/i.test(sql) || /\bfor\s+(update|share)\b|\block\s+in\s+share\s+mode\b/i.test(sql)) throw new Error("Only read-only SELECT queries are allowed.");
  const dialectName = dialect === "postgresql" ? "Postgresql" : "MySQL";
  const ast = parser.astify(sql, { database: dialectName });
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1 || !statements[0] || (statements[0] as { type?: string }).type !== "select") throw new Error("Only SELECT queries are allowed.");
  if (schema) {
    const tables = new Map<string, Set<string>>();
    for (const row of schema) {
      if (typeof row.table_name !== "string" || typeof row.column_name !== "string") continue;
      const name = row.table_name.toLowerCase();
      const columns = tables.get(name) ?? new Set<string>();
      columns.add(row.column_name.toLowerCase());
      tables.set(name, columns);
    }
    const referencedTables = parser.tableList(sql, { database: dialectName });
    const allowed = new Set<string>();
    for (const reference of referencedTables) {
      const rawName = reference.split("::").at(-1) ?? "";
      const parts = rawName.split(".");
      if (parts.length > 1) {
        const qualifier = unquoteSqlIdentifier(parts[parts.length - 2]);
        const expectedSchema = dialect === "postgresql" ? "public" : undefined;
        if (expectedSchema && qualifier.toLowerCase() !== expectedSchema) throw new Error("Query references a schema outside the inspected database.");
        if (dialect === "mysql" && currentDatabase && qualifier.toLowerCase() !== currentDatabase.toLowerCase()) {
          throw new Error("Query references a database outside the connected database.");
        }
      }
      const tableName = unquoteSqlIdentifier(parts.at(-1) ?? "").toLowerCase();
      if (!tableName || !tables.has(tableName)) throw new Error("Query references a table outside the connected database schema.");
      allowed.add(tableName);
    }
    if (!allowed.size) throw new Error("Query must reference an inspected table.");
    const referencedColumns = parser.columnList(sql, { database: dialectName });
    for (const reference of referencedColumns) {
      const rawColumn = reference.split("::").at(-1) ?? "";
      const columnName = unquoteSqlIdentifier(rawColumn.split(".").at(-1) ?? "").toLowerCase();
      if (!columnName || columnName === "*" || columnName === "1") continue;
      if (![...allowed].some(table => tables.get(table)?.has(columnName))) {
        throw new Error("Query references a column outside the inspected database schema.");
      }
    }
  }
  const limited = /\blimit\s+(\d+)/i.exec(sql);
  if (limited) return sql.replace(/\blimit\s+\d+/i, `LIMIT ${Math.min(100, Math.max(1, Number(limited[1])))}`);
  return `${sql} LIMIT 100`;
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Please sign in." } }, { status: 401 });
  const started = Date.now();
  let stage = "parse-request";
  let databaseType: string | undefined;
  let usageReservation: { monthKey: string } | null = null;
  let usageCommitted = false;
  try {
    const input = inputSchema.parse(await request.json());
    stage = "connect-app-database";
    await connectMongoose();
    const rateLimit = await consumeRateLimit(`analytics:${session.user.id}`, 30, 60_000);
    if (!rateLimit.allowed) return NextResponse.json({ error: { code: "RATE_LIMITED", message: "Too many analytics requests. Please wait before trying again." } }, { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } });
    stage = "load-plan-and-connection";
    const [plan, connection] = await Promise.all([
      getUserPlan(session.user.id),
      DBConnectionModel.findOne({ _id: input.connectionId, userId: session.user.id, isActive: true }).exec(),
    ]);
    if (!connection) return NextResponse.json({ error: { code: "CONNECTION_NOT_FOUND", message: "Choose an active database connection that belongs to your account." } }, { status: 404 });
    usageReservation = await reserveQueryUsage(session.user.id, plan.monthlyQueries);
    if (!usageReservation) return NextResponse.json({ error: { code: "USAGE_LIMIT", message: "Your monthly query limit has been reached." } }, { status: 429 });
    const apiKey = process.env.OPENAI_API_KEY;
    stage = "decrypt-connection";
    const config = decodeExternalDbConfig(connection);
    databaseType = config.type;
    if (config.type === "mongodb") {
      await assertSafeMongoUri(config.uri);
      const mongo = new MongoClient(config.uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
      try {
        stage = "connect-external-mongodb";
        await mongo.connect();
        const db = mongo.db(config.database);
        stage = "inspect-mongodb-collections";
        const collections = (await db.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name).filter(name => !name.startsWith("system."));
        // Inspect several documents per collection. A single document is not a reliable
        // schema source because optional fields may be absent from the first record.
        const schema = [];
        for (const name of collections.slice(0, 100)) {
          const samples = await db.collection(name)
            .find({}, { projection: { _id: 0 } })
            .limit(8)
            .maxTimeMS(3000)
            .toArray();
          const fields = new Map<string, Set<string>>();
          const addFields = (value: unknown, prefix = "", depth = 0) => {
            if (!value || typeof value !== "object" || value instanceof Date || depth > 3) return;
            const entries = Array.isArray(value)
              ? value.slice(0, 3).map((item, index) => [String(index), item] as const)
              : Object.entries(value as Record<string, unknown>);
            for (const [key, nested] of entries) {
              const field = prefix ? `${prefix}.${key}` : key;
              const type = nested === null ? "null"
                : nested instanceof Date ? "date"
                : Array.isArray(nested) ? "array"
                : typeof nested === "object" ? "object"
                : typeof nested;
              const types = fields.get(field) ?? new Set<string>();
              types.add(type);
              fields.set(field, types);
              if (nested && typeof nested === "object" && !(nested instanceof Date)) {
                if (Array.isArray(nested)) {
                  for (const item of nested.slice(0, 3)) addFields(item, field, depth + 1);
                } else {
                  addFields(nested, field, depth + 1);
                }
              }
            }
          };
          for (const sample of samples) addFields(sample);
          schema.push({
            collection: name,
            sampleDocuments: samples.length,
            fields: [...fields.entries()].slice(0, 160).map(([field, types]) => ({
              name: field,
              types: [...types],
            })),
          });
        }
        const simpleQuery = buildSimpleMongoQuery(input.question, schema, collections);
        if (simpleQuery) {
          stage = "execute-simple-mongodb-query";
          const rows = await db.collection(simpleQuery.collection).aggregate(simpleQuery.pipeline, {
            maxTimeMS: 10000,
            allowDiskUse: false,
          }).toArray();
          const columns = [...new Set(rows.flatMap(row => Object.keys(row)))].slice(0, 100);
          stage = "save-query-usage";
          await UsageEventModel.create({
            userId: session.user.id,
            kind: "query_success",
            createdAt: new Date(),
            durationMs: Date.now() - started,
            rowCount: rows.length,
            metadata: { connectionId: String(connection._id), dialect: "mongodb", queryMode: "deterministic" },
          });
          usageCommitted = true;
          return NextResponse.json({
            summary: simpleQuery.pipeline.some(item => "$count" in item)
              ? `${simpleQuery.summary} ${Number(rows[0]?.count ?? 0)} records found.`
              : simpleQuery.summary,
            sql: JSON.stringify({ collection: simpleQuery.collection, pipeline: simpleQuery.pipeline }, null, 2),
            columns,
            rows: rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [
              key,
              value instanceof Date ? value.toISOString() : typeof value === "object" && value !== null ? JSON.stringify(value) : value,
            ]))),
            rowCount: rows.length,
            truncated: rows.length >= 100,
            remaining: Math.max(0, plan.remaining - 1),
            queryMode: "deterministic",
          });
        }
        if (!apiKey) {
          if (usageReservation) await releaseQueryUsage(session.user.id, usageReservation.monthKey);
          usageReservation = null;
          return NextResponse.json({
            error: { code: "AI_NOT_CONFIGURED", message: "This question needs AI query generation. Add OPENAI_API_KEY to your deployment environment." },
          }, { status: 503 });
        }
        stage = "generate-mongodb-aggregation";
        const client = new OpenAI({ apiKey });
        const completion = await client.chat.completions.create({
          model: process.env.OPENAI_MODEL || "gpt-4o-mini", temperature: 0, max_tokens: 800,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: `Translate the business question into a MongoDB aggregation pipeline. Return JSON only: {"collection":"name","pipeline":[...],"summary":"short explanation"}. Use only the provided collection and field names. Interpret natural-language intent carefully: for "how many" questions use a count aggregation; for "available" or "active" questions, apply a status/availability filter only when the supplied schema contains a clearly relevant field (such as status, isActive, isAvailable, available, enabled, or stock). Do not guess status values or field names; inspect the supplied field names and types. Match plural business nouns such as services/customers/products to the most relevant collection name. If the schema does not support the requested meaning, do not fabricate a result; return a valid read-only aggregation and explain the limitation in summary. The pipeline must be read-only and use only $match, $group, $project, $sort, $limit, $unwind, $count, $addFields, $set, $skip. Never use $out, $merge, $lookup, $function, $where, $accumulator, $unionWith, $documents, $geoNear, $changeStream, $search, or system collections. No more than 8 stages. Do not invent fields.` },
            { role: "user", content: `MongoDB collections and sample fields: ${JSON.stringify(schema)}\nQuestion: ${input.question}` }
          ]
        });
        stage = "validate-mongodb-aggregation";
        const text = completion.choices[0]?.message.content;
        if (!text) throw new Error("AI did not return a pipeline.");
        const generated = z.object({ collection: z.string().min(1).max(120), pipeline: z.array(z.record(z.unknown())).min(1).max(8), summary: z.string().max(500).default("Query completed.") }).parse(JSON.parse(text));
        if (!collections.includes(generated.collection)) throw new Error("Unknown collection.");
        const validationSchema = {
          databaseType: "mongodb" as const,
          tables: schema.map((item: { collection: string; fields: Array<{ name: string; types: string[] }> }) => ({
            name: item.collection,
            columns: item.fields.map(field => ({ name: field.name, type: field.types.join("|") })),
          })),
        };
        const validated = validateMongoAnalyticsQuery(JSON.stringify({ collection: generated.collection, pipeline: generated.pipeline }), validationSchema, 100);
        generated.pipeline = validated.pipeline;
        const allowed = new Set(["$match", "$group", "$project", "$sort", "$limit", "$unwind", "$count", "$addFields", "$set", "$skip"]);
        for (const stage of generated.pipeline) {
          const keys = Object.keys(stage);
          if (keys.length !== 1 || !allowed.has(keys[0])) throw new Error("Unsupported aggregation stage.");
          if (keys[0] === "$limit") stage.$limit = Math.min(100, Math.max(1, Number(stage.$limit) || 100));
          if (keys[0] === "$skip") stage.$skip = Math.min(10000, Math.max(0, Number(stage.$skip) || 0));
          if (keys[0] === "$match" && JSON.stringify(stage).match(/\$where|\$function|\$regex/i)) throw new Error("Unsafe match expression.");
        }
        if (!generated.pipeline.some(stage => "$limit" in stage)) generated.pipeline.push({ $limit: 100 });
        stage = "execute-mongodb-aggregation";
        const rows = await db.collection(generated.collection).aggregate(generated.pipeline as import("mongodb").Document[], { maxTimeMS: 10000, allowDiskUse: false }).toArray();
        const columns = [...new Set(rows.flatMap(row => Object.keys(row)))].slice(0, 100);
        stage = "save-query-usage";
        await UsageEventModel.create({ userId: session.user.id, kind: "query_success", createdAt: new Date(), durationMs: Date.now() - started, rowCount: rows.length, metadata: { connectionId: String(connection._id), dialect: "mongodb" } });
        usageCommitted = true;
        return NextResponse.json({ summary: generated.summary, sql: JSON.stringify({ collection: generated.collection, pipeline: generated.pipeline }, null, 2), columns, rows: rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : typeof value === "object" && value !== null ? JSON.stringify(value) : value]))), rowCount: rows.length, truncated: rows.length >= 100, remaining: Math.max(0, plan.remaining - 1) });
      } finally { await mongo.close(); }
    }
    await assertSafeExternalHost(config.host);
    stage = "inspect-sql-schema";
    const schema = config.type === "postgres" ? await getSchema(config, "postgresql") : await getSchema(config, "mysql");
    const simpleSql = buildSimpleSqlQuery(input.question, schema, config.type === "postgres" ? "postgresql" : "mysql");
    if (simpleSql) {
      stage = "execute-simple-sql-query";
      const safeSql = validateReadOnlySql(simpleSql.sql, config.type === "postgres" ? "postgresql" : "mysql", schema, config.database);
      const result = await executeReadOnly(config, safeSql);
      stage = "save-query-usage";
      await UsageEventModel.create({ userId: session.user.id, kind: "query_success", createdAt: new Date(), durationMs: Date.now() - started, rowCount: result.rows.length, metadata: { connectionId: String(connection._id), dialect: config.type, queryMode: "deterministic" } });
      usageCommitted = true;
      const count = simpleSql.isCount ? Number(result.rows[0]?.count ?? 0) : undefined;
      return NextResponse.json({ summary: simpleSql.isCount ? simpleSql.summary + " " + count + " records found." : simpleSql.summary, sql: safeSql, columns: result.columns, rows: result.rows, rowCount: result.rows.length, truncated: !simpleSql.isCount && result.rows.length >= simpleSql.limit, remaining: Math.max(0, plan.remaining - 1), queryMode: "deterministic" });
    }
    if (!apiKey) {
      if (usageReservation) await releaseQueryUsage(session.user.id, usageReservation.monthKey);
      usageReservation = null;
      return NextResponse.json({
        error: { code: "AI_NOT_CONFIGURED", message: "This question needs AI query generation. Add OPENAI_API_KEY to your deployment environment." },
      }, { status: 503 });
    }
    stage = "generate-sql-query";
    const client = new OpenAI({ apiKey });
    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0,
      max_tokens: 700,
      messages: [
        { role: "system", content: `You convert natural-language business questions into ONE read-only SQL SELECT query for the specified database dialect. Return JSON only: {\"sql\":\"...\",\"summary\":\"short plain-English explanation\"}. Use only the exact tables and columns listed in the supplied schema; never invent or rename identifiers. Match business nouns to the closest table in the schema. For "how many" questions, return a COUNT aggregate rather than listing rows. For "available", "active", "enabled", "in stock", or "inactive" questions, use a clearly relevant status/availability column only if it exists in the schema (for example status, is_active, isavailable, available, enabled, or stock); do not assume status values such as active/available/1 unless the schema or question establishes them. If the schema cannot support the requested meaning, do not fabricate a filter or result; return the safest relevant SELECT and explain the limitation in summary. Use dialect-compatible syntax (PostgreSQL or MySQL). Never use comments, multiple statements, DDL, DML, system catalogs, file/network functions, sleep/benchmark/lock functions, or write operations. Do not include a semicolon. The server applies a 100-row cap.` },
        { role: "user", content: `Database dialect: ${config.type}. Schema JSON: ${JSON.stringify(schema)}\nQuestion: ${input.question}` },
      ],
      response_format: { type: "json_object" },
    });
    stage = "validate-generated-sql";
    const content = completion.choices[0]?.message.content;
    if (!content) throw new Error("AI did not return a query.");
    const generated = z.object({ sql: z.string().min(1).max(12000), summary: z.string().max(500).default("Query completed.") }).parse(JSON.parse(content));
    const sql = validateReadOnlySql(generated.sql, config.type === "postgres" ? "postgresql" : "mysql", schema, config.database);
    stage = "execute-sql-query";
    const result = await executeReadOnly(config, sql);
    stage = "save-query-usage";
    await UsageEventModel.create({ userId: session.user.id, kind: "query_success", createdAt: new Date(), durationMs: Date.now() - started, rowCount: result.rows.length, metadata: { connectionId: String(connection._id), dialect: config.type } });
      usageCommitted = true;
    return NextResponse.json({ summary: generated.summary, sql, columns: result.columns, rows: result.rows, rowCount: result.rows.length, truncated: result.rows.length >= 100, remaining: Math.max(0, plan.remaining - 1) });
  } catch (error) {
    if (usageReservation && !usageCommitted) {
      try { await releaseQueryUsage(session.user.id, usageReservation.monthKey); }
      catch (releaseError) { console.error("Could not release query quota reservation", { userId: session.user.id, name: releaseError instanceof Error ? releaseError.name : "UnknownError" }); }
    }
    const safe = toPublicError(error);
    if (safe.statusCode === 400) return NextResponse.json({ error: { code: safe.code, message: "Please enter a clear question and try again." } }, { status: 400 });
    const diagnostic = error && typeof error === "object" ? error as { name?: unknown; code?: unknown; codeName?: unknown; status?: unknown; type?: unknown } : {};
    console.error("Analytics query failed", {
      stage,
      databaseType,
      errorName: typeof diagnostic.name === "string" ? diagnostic.name : "UnknownError",
      errorCode: typeof diagnostic.code === "string" || typeof diagnostic.code === "number" ? diagnostic.code : undefined,
      codeName: typeof diagnostic.codeName === "string" ? diagnostic.codeName : undefined,
      httpStatus: typeof diagnostic.status === "number" ? diagnostic.status : undefined,
      errorType: typeof diagnostic.type === "string" ? diagnostic.type : undefined,
      durationMs: Date.now() - started,
    });
    return NextResponse.json({ error: { code: "QUERY_FAILED", message: "The analytics query could not be completed. Check your connection and question, then try again." } }, { status: safe.statusCode >= 500 ? 500 : 400 });
  }
}

type SimpleMongoPlan = { collection: string; pipeline: import("mongodb").Document[]; summary: string };

function normalizeWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function buildSimpleMongoQuery(
  question: string,
  schema: Array<{ collection: string; fields: Array<{ name: string; types: string[] }> }>,
  collections: string[],
): SimpleMongoPlan | null {
  const normalized = question.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const words = new Set(normalized.split(/\s+/).filter(Boolean));
  const isCount = /\b(how many|count|number of|total number of)\b/.test(normalized);
  const isSum = /\b(total|sum)\b/.test(normalized) && !isCount;
  const isList = /\b(show|list|get|find|display|fetch|what are|which)\b/.test(normalized);
  if (!isCount && !isSum && !isList) return null;

  const ranked = schema
    .filter(item => collections.includes(item.collection))
    .map(item => {
      const nameWords = normalizeWords(item.collection);
      const score = nameWords.reduce((total, word) => {
        const singular = word.endsWith("s") ? word.slice(0, -1) : word;
        return total + (words.has(word) || words.has(singular) ? 1 : 0);
      }, 0);
      return { item, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length || (ranked.length > 1 && ranked[0].score === ranked[1].score)) return null;

  const selected = ranked[0].item;
  const wantsAvailability = /\b(available|availability|active|enabled|in stock)\b/.test(normalized);
  const pipeline: import("mongodb").Document[] = [];
  if (wantsAvailability) {
    const booleanAvailabilityField = selected.fields.find(field =>
      /^(isactive|isavailable|available|enabled|active|instock)$/i.test(field.name.replace(/[._]/g, "")) &&
      field.types.includes("boolean")
    );
    if (!booleanAvailabilityField) return null;
    pipeline.push({ $match: { [booleanAvailabilityField.name]: true } });
  }

  if (isCount) {
    pipeline.push({ $count: "count" });
    return {
      collection: selected.collection,
      pipeline,
      summary: wantsAvailability
        ? `Count of available records in ${selected.collection}.`
        : `Total number of records in ${selected.collection}.`,
    };
  }

  if (isSum) {
    const numericFields = selected.fields.filter(field =>
      /^(amount|total|price|revenue|sales|value|subtotal|grandtotal|totalamount|cost|balance)$/i.test(field.name.replace(/[._]/g, "")) &&
      field.types.some(type => ["number", "int", "long", "double", "decimal"].includes(type))
    );
    if (numericFields.length !== 1) return null;
    pipeline.push({ $group: { _id: null, total: { $sum: `$${numericFields[0].name}` } } });
    pipeline.push({ $project: { _id: 0, total: 1 } });
    return {
      collection: selected.collection,
      pipeline,
      summary: `Sum of ${numericFields[0].name} in ${selected.collection}.`,
    };
  }

  const requestedLimit = /\b(?:top|first|last|show|list|get)\s+(\d{1,3})\b/.exec(normalized);
  const limit = requestedLimit ? Math.min(100, Math.max(1, Number(requestedLimit[1]))) : 20;
  pipeline.push({ $limit: limit });
  return {
    collection: selected.collection,
    pipeline,
    summary: wantsAvailability
      ? `Showing up to ${limit} available records from ${selected.collection}.`
      : `Showing up to ${limit} records from ${selected.collection}.`,
  };
}

type SqlSchemaRow = { table_name?: unknown; column_name?: unknown; data_type?: unknown };
type SimpleSqlPlan = { sql: string; summary: string; isCount: boolean; limit: number };

function buildSimpleSqlQuery(question: string, schema: SqlSchemaRow[], dialect: "postgresql" | "mysql"): SimpleSqlPlan | null {
  const normalized = normalizeSqlWords(question);
  const words = new Set(normalized.split(/\s+/).filter(Boolean));
  const isCount = SQL_INTENT_PATTERNS.count.test(normalized);
  const isSum = SQL_INTENT_PATTERNS.sum.test(normalized) && !isCount;
  const isList = SQL_INTENT_PATTERNS.list.test(normalized);
  if (!isCount && !isList && !isSum) return null;
  const tables = new Map<string, { columns: Array<{ name: string; type: string }> }>();
  for (const row of schema) {
    if (typeof row.table_name !== "string" || typeof row.column_name !== "string") continue;
    const table = tables.get(row.table_name) ?? { columns: [] };
    table.columns.push({ name: row.column_name, type: typeof row.data_type === "string" ? row.data_type : "" });
    tables.set(row.table_name, table);
  }
  const ranked = [...tables.entries()].map(([name, details]) => {
    const score = normalizeWords(name).reduce((total, word) => { const singular = word.endsWith("s") ? word.slice(0, -1) : word; return total + (words.has(word) || words.has(singular) ? 1 : 0); }, 0);
    return { name, ...details, score };
  }).filter(table => table.score > 0).sort((a, b) => b.score - a.score);
  if (!ranked.length || (ranked.length > 1 && ranked[0].score === ranked[1].score)) return null;
  const selected = ranked[0];
  const quote = (identifier: string) => quoteSqlIdentifier(identifier, dialect);
  const tableName = quote(selected.name);
  const wantsAvailability = SQL_INTENT_PATTERNS.availability.test(normalized);
  let where = "";
  if (wantsAvailability) {
    const field = selected.columns.find(column => /^(isactive|is_active|isavailable|is_available|available|enabled|active|instock|in_stock)$/i.test(column.name) && /^(bool|boolean|tinyint|bit)$/i.test(column.type));
    if (!field) return null;
    where = " WHERE " + quote(field.name) + " = " + (dialect === "mysql" && /tinyint|bit/i.test(field.type) ? "1" : "TRUE");
  }
  if (isCount) return { sql: "SELECT COUNT(*) AS count FROM " + tableName + where, summary: wantsAvailability ? "Count of available records in " + selected.name + "." : "Total number of records in " + selected.name + ".", isCount: true, limit: 1 };
  if (isSum) {
    const numericFields = selected.columns.filter(column => /^(smallint|integer|bigint|numeric|decimal|real|double precision|float|double|int|mediumint)$/i.test(column.type) && /^(amount|total|price|revenue|sales|value|subtotal|grand_total|total_amount)$/i.test(column.name));
    if (numericFields.length !== 1) return null;
    return { sql: "SELECT SUM(" + quote(numericFields[0].name) + ") AS total FROM " + tableName + where, summary: "Sum of " + numericFields[0].name + " in " + selected.name + ".", isCount: false, limit: 100 };
  }
  const requested = SQL_INTENT_PATTERNS.limit.exec(normalized);
  const limit = requested ? Math.min(100, Math.max(1, Number(requested[1]))) : 20;
  return { sql: "SELECT * FROM " + tableName + where + " LIMIT " + limit, summary: wantsAvailability ? "Showing up to " + limit + " available records from " + selected.name + "." : "Showing up to " + limit + " records from " + selected.name + ".", isCount: false, limit };
}
async function getSchema(config: Extract<ReturnType<typeof decodeExternalDbConfig>, { type: "postgres" | "mysql" }>, dialect: "postgresql" | "mysql"): Promise<SqlSchemaRow[]> {
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
    const [rows] = await connection.query("SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, DATA_TYPE AS data_type FROM information_schema.columns WHERE table_schema = ? ORDER BY table_name, ordinal_position LIMIT 1000", [config.database]);
    if (!Array.isArray(rows)) throw new Error("Could not inspect SQL database schema.");
    return rows as SqlSchemaRow[];
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
