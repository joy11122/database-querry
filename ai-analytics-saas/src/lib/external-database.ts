import "server-only";
import mysql from "mysql2/promise";
import { Client as PgClient } from "pg";
import { decryptConnectionSecret } from "@/lib/connection-crypto";
import type { DBConnection } from "@/db/models/db-connection.model";

export type ExternalDbConfig = {
  type: "postgres" | "mysql";
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
};

export function decodeExternalDbConfig(connection: Pick<DBConnection, "encryptedCredentials">): ExternalDbConfig {
  const parsed = JSON.parse(decryptConnectionSecret(connection.encryptedCredentials)) as ExternalDbConfig;
  if (!["postgres", "mysql"].includes(parsed.type) || !parsed.host || !parsed.database || !parsed.username) {
    throw new Error("Stored connection configuration is invalid");
  }
  return parsed;
}

export async function testExternalDb(config: ExternalDbConfig): Promise<void> {
  if (config.type === "postgres") {
    const client = new PgClient({
      host: config.host, port: config.port, database: config.database,
      user: config.username, password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: true } : false,
      connectionTimeoutMillis: 8000, statement_timeout: 8000,
    });
    try { await client.connect(); await client.query("SELECT 1"); }
    finally { await client.end().catch(() => undefined); }
    return;
  }
  const connection = await mysql.createConnection({
    host: config.host, port: config.port, database: config.database,
    user: config.username, password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
    connectTimeout: 8000, multipleStatements: false,
  });
  try { await connection.query("SELECT 1"); }
  finally { await connection.end(); }
}

export async function inspectExternalDb(config: ExternalDbConfig): Promise<{ tables: { name: string; columns: string[] }[] }> {
  if (config.type === "postgres") {
    const client = new PgClient({
      host: config.host, port: config.port, database: config.database,
      user: config.username, password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: true } : false,
      connectionTimeoutMillis: 8000, statement_timeout: 8000,
    });
    try {
      await client.connect();
      const result = await client.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position LIMIT 1000`);
      return groupColumns(result.rows as { table_name: string; column_name: string }[]);
    } finally { await client.end().catch(() => undefined); }
  }
  const connection = await mysql.createConnection({
    host: config.host, port: config.port, database: config.database,
    user: config.username, password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
    connectTimeout: 8000, multipleStatements: false,
  });
  try {
    const [rows] = await connection.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = ? ORDER BY table_name, ordinal_position LIMIT 1000`, [config.database]);
    return groupColumns(rows as { table_name: string; column_name: string }[]);
  } finally { await connection.end(); }
}

function groupColumns(rows: { table_name: string; column_name: string }[]) {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const columns = map.get(row.table_name) ?? [];
    if (!columns.includes(row.column_name)) columns.push(row.column_name);
    map.set(row.table_name, columns);
  }
  return { tables: [...map.entries()].map(([name, columns]) => ({ name, columns })) };
}
