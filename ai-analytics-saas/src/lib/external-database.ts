import "server-only";
import mysql from "mysql2/promise";
import { Client as PgClient } from "pg";
import { MongoClient } from "mongodb";
import { decryptConnectionSecret } from "@/lib/connection-crypto";
import type { DBConnection } from "@/db/models/db-connection.model";

export type SqlDbConfig = {
  type: "postgres" | "mysql";
  host: string; port: number; database: string; username: string; password: string; ssl: boolean;
};
export type MongoDbConfig = { type: "mongodb"; uri: string; database: string };
export type ExternalDbConfig = SqlDbConfig | MongoDbConfig;

export function decodeExternalDbConfig(connection: Pick<DBConnection, "encryptedCredentials">): ExternalDbConfig {
  const parsed = JSON.parse(decryptConnectionSecret(connection.encryptedCredentials)) as ExternalDbConfig;
  if (parsed.type === "mongodb") {
    if (!parsed.uri?.startsWith("mongodb") || !parsed.database) throw new Error("Stored MongoDB configuration is invalid");
    return parsed;
  }
  if (![ "postgres", "mysql" ].includes(parsed.type) || !parsed.host || !parsed.database || !parsed.username) throw new Error("Stored connection configuration is invalid");
  return parsed;
}

export async function testExternalDb(config: ExternalDbConfig): Promise<void> {
  if (config.type === "mongodb") {
    const client = new MongoClient(config.uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
    try { await client.connect(); await client.db(config.database).command({ ping: 1 }); }
    finally { await client.close(); }
    return;
  }
  if (config.type === "postgres") {
    const client = new PgClient({ host: config.host, port: config.port, database: config.database, user: config.username, password: config.password, ssl: config.ssl ? { rejectUnauthorized: true } : false, connectionTimeoutMillis: 8000, statement_timeout: 8000 });
    try { await client.connect(); await client.query("SELECT 1"); } finally { await client.end().catch(() => undefined); }
    return;
  }
  const connection = await mysql.createConnection({ host: config.host, port: config.port, database: config.database, user: config.username, password: config.password, ssl: config.ssl ? { rejectUnauthorized: true } : undefined, connectTimeout: 8000, multipleStatements: false });
  try { await connection.query("SELECT 1"); } finally { await connection.end(); }
}

export async function inspectExternalDb(config: ExternalDbConfig): Promise<{ tables: { name: string; columns: string[] }[] }> {
  if (config.type === "mongodb") {
    const client = new MongoClient(config.uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
    try {
      await client.connect();
      const db = client.db(config.database);
      const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name).filter(name => !name.startsWith("system."));
      const tables: { name: string; columns: string[] }[] = [];
      for (const name of names.slice(0, 100)) {
        const sample = await db.collection(name).findOne({}, { projection: { _id: 0 }, maxTimeMS: 3000 });
        tables.push({ name, columns: sample && typeof sample === "object" ? Object.keys(sample).slice(0, 100) : [] });
      }
      return { tables };
    } finally { await client.close(); }
  }
  if (config.type === "postgres") {
    const client = new PgClient({ host: config.host, port: config.port, database: config.database, user: config.username, password: config.password, ssl: config.ssl ? { rejectUnauthorized: true } : false, connectionTimeoutMillis: 8000, statement_timeout: 8000 });
    try {
      await client.connect();
      const result = await client.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position LIMIT 1000");
      return groupColumns(result.rows as { table_name: string; column_name: string }[]);
    } finally { await client.end().catch(() => undefined); }
  }
  const connection = await mysql.createConnection({ host: config.host, port: config.port, database: config.database, user: config.username, password: config.password, ssl: config.ssl ? { rejectUnauthorized: true } : undefined, connectTimeout: 8000, multipleStatements: false });
  try {
    const [rows] = await connection.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = ? ORDER BY table_name, ordinal_position LIMIT 1000", [config.database]);
    return groupColumns(rows as { table_name: string; column_name: string }[]);
  } finally { await connection.end(); }
}

function groupColumns(rows: { table_name: string; column_name: string }[]) {
  const map = new Map<string, string[]>();
  for (const row of rows) { const columns = map.get(row.table_name) ?? []; if (!columns.includes(row.column_name)) columns.push(row.column_name); map.set(row.table_name, columns); }
  return { tables: [...map.entries()].map(([name, columns]) => ({ name, columns })) };
}
