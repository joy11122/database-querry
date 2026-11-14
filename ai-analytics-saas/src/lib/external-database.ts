import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import mysql from "mysql2/promise";
import { Client as PgClient } from "pg";
import { MongoClient } from "mongodb";
import { decryptConnectionSecret } from "@/lib/connection-crypto";
import type { DBConnection } from "@/db/models/db-connection.model";

function isInIpv4Range(address: string, network: string, prefix: number): boolean {
  const toNumber = (value: string) => value.split(".").reduce((total, part) => (total << 8n) | BigInt(Number(part)), 0n);
  const mask = prefix === 0 ? 0n : ((0xffffffffn << BigInt(32 - prefix)) & 0xffffffffn);
  return (toNumber(address) & mask) === (toNumber(network) & mask);
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some(part => !/^\\d{1,3}$/.test(part) || Number(part) > 255)) return true;
  const blocked: Array<[string, number]> = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
    ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
    ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
    ["224.0.0.0", 4], ["240.0.0.0", 4],
  ];
  return blocked.some(([network, prefix]) => isInIpv4Range(address, network, prefix));
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  const mapped = normalized.match(/::ffff:(\\d+\\.\\d+\\.\\d+\\.\\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  // Permit only globally-routable unicast (2000::/3); reject unspecified,
  // loopback, ULA, link-local, multicast, documentation and transition space.
  if (!/^[23]/.test(normalized)) return true;
  return normalized.startsWith("2001:db8") || normalized.startsWith("2001:10:") ||
    normalized.startsWith("2002:");
}

function matchesHostAllowlist(host: string): boolean {
  const configured = process.env.OUTBOUND_DB_ALLOWED_HOSTS?.split(",").map(value => value.trim().toLowerCase()).filter(Boolean) ?? [];
  if (process.env.NODE_ENV === "production" && configured.length === 0) return false;
  if (configured.length === 0) return true;
  return configured.some(entry => {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === entry;
  });
}

async function assertPublicDnsHost(host: string): Promise<void> {
  const version = isIP(host);
  if (version === 4) {
    if (isBlockedIpv4(host)) throw new Error("Private or reserved database hosts are not allowed.");
    return;
  }
  if (version === 6) {
    if (isBlockedIpv6(host)) throw new Error("Private or reserved database hosts are not allowed.");
    return;
  }
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => item.family === 4 ? isBlockedIpv4(item.address) : isBlockedIpv6(item.address))) {
    throw new Error("Database host resolves to a private or reserved address.");
  }
}

/**
 * Validate external destinations before each outbound database operation.
 * Production deployments must configure an exact host allowlist (or a narrowly
 * scoped *.domain suffix) and enforce provider/network-level egress controls.
 */
export async function assertSafeExternalHost(host: string): Promise<void> {
  const normalized = host.trim().replace(/^\\[|\\]$/g, "").toLowerCase().replace(/\\.$/, "");
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost") ||
      normalized.endsWith(".local") || normalized.endsWith(".internal") ||
      normalized.endsWith(".test") || !matchesHostAllowlist(normalized)) {
    throw new Error("This database host is not allowed by outbound host policy.");
  }
  await assertPublicDnsHost(normalized);
}

export async function assertSafeMongoUri(uri: string): Promise<void> {
  const parsed = new URL(uri);
  if (parsed.protocol !== "mongodb:" && parsed.protocol !== "mongodb+srv:") {
    throw new Error("Only MongoDB connection URIs are supported.");
  }
  if (parsed.protocol === "mongodb+srv:") {
    const hostname = parsed.hostname.toLowerCase().replace(/\\.$/, "");
    await assertSafeExternalHost(hostname);
    const service = parsed.searchParams.get("srvServiceName") || "mongodb";
    const records = await import("node:dns/promises").then(({ resolveSrv }) => resolveSrv(`_${service}._tcp.${hostname}`));
    if (!records.length) throw new Error("MongoDB SRV record did not return any database hosts.");
    for (const record of records) await assertSafeExternalHost(record.name);
  } else {
    for (const host of parsed.host.split(",")) {
      const hostname = host.trim().replace(/^.*@/, "").replace(/^\\[|\\]$/g, "").split(":")[0];
      await assertSafeExternalHost(hostname);
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
    if (!parsed.uri || !parsed.database) throw new Error("Stored MongoDB configuration is invalid");
    return parsed;
  }
  if (![ "postgres", "mysql" ].includes(parsed.type) || !parsed.host || !parsed.database || !parsed.username) throw new Error("Stored connection configuration is invalid");
  return parsed;
}

export async function testExternalDb(config: ExternalDbConfig): Promise<void> {
  if (config.type === "mongodb") {
    await assertSafeMongoUri(config.uri);
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
    await assertSafeMongoUri(config.uri);
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
