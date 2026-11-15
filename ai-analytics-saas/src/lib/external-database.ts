import "server-only";
import { lookup, resolveSrv } from "node:dns/promises";
import { isIP } from "node:net";
import mysql from "mysql2/promise";
import { Client as PgClient } from "pg";
import { MongoClient } from "mongodb";
import { decryptConnectionSecret } from "@/lib/connection-crypto";
import type { DBConnection } from "@/db/models/db-connection.model";

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 88 && c === 99);
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff") || normalized.startsWith("2001:db8")) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isBlockedIpv4(mapped[1]) : false;
}

/**
 * Reject loopback, private, link-local, multicast and reserved destinations.
 * Deployments must also enforce outbound egress rules to mitigate DNS rebinding.
 */
export async function assertSafeExternalHost(host: string, options: { srv?: boolean } = {}): Promise<void> {
  const normalized = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost") ||
      normalized.endsWith(".local") || normalized.endsWith(".internal") ||
      normalized.endsWith(".test")) {
    throw new Error("This database host is not allowed.");
  }
  const version = isIP(normalized);
  if (version === 4) {
    if (isBlockedIpv4(normalized)) throw new Error("Private or reserved database hosts are not allowed.");
    return;
  }
  if (version === 6) {
    if (isBlockedIpv6(normalized)) throw new Error("Private or reserved database hosts are not allowed.");
    return;
  }
  // Atlas mongodb+srv hosts are discovered through SRV records. The SRV
  // root hostname may not have an A/AAAA record, so validate every SRV target
  // instead of incorrectly resolving the root as a regular host.
  const targets = options.srv
    ? (await resolveSrv(`_mongodb._tcp.${normalized}`)).map(record => record.name.replace(/\.$/, ""))
    : [normalized];

  if (!targets.length) throw new Error("Database host has no DNS records.");

  for (const target of targets) {
    if (!target || target === normalized && options.srv) {
      throw new Error("Database SRV record contains an invalid target.");
    }
    const targetVersion = isIP(target);
    if (targetVersion === 4) {
      if (isBlockedIpv4(target)) throw new Error("Database host resolves to a private or reserved address.");
      continue;
    }
    if (targetVersion === 6) {
      if (isBlockedIpv6(target)) throw new Error("Database host resolves to a private or reserved address.");
      continue;
    }
    const addresses = await lookup(target, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => item.family === 4 ? isBlockedIpv4(item.address) : isBlockedIpv6(item.address))) {
      throw new Error("Database host resolves to a private or reserved address.");
    }
  }
}

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
  const host = config.type === "mongodb" ? new URL(config.uri).hostname : config.host;
  await assertSafeExternalHost(host, { srv: config.type === "mongodb" && config.uri.startsWith("mongodb+srv://") });
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
  const host = config.type === "mongodb" ? new URL(config.uri).hostname : config.host;
  await assertSafeExternalHost(host, { srv: config.type === "mongodb" && config.uri.startsWith("mongodb+srv://") });
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
