import mysql, { type Pool, type PoolConnection } from "mysql2/promise";
import { BaseDatabaseAdapter, type QueryExecutionOptions, type QueryExecutionResult } from "./base.adapter";
import type { MySQLCredentials, SchemaMetadata } from "@/types/database";

export class MySQLAdapter extends BaseDatabaseAdapter {
  public readonly type = "mysql" as const;
  private pool: Pool | null = null;
  public constructor(private readonly credentials: MySQLCredentials) { super(); }
  public async connect(): Promise<void> {
    if (this.pool) return;
    this.pool = mysql.createPool({
      host: this.credentials.host, port: this.credentials.port, user: this.credentials.username,
      password: this.credentials.password, database: this.credentials.database,
      ssl: this.credentials.ssl ? {} : undefined, connectionLimit: 5, waitForConnections: true
    });
    let connection: PoolConnection | undefined;
    try {
      connection = await this.pool.getConnection();
      await connection.ping();
    } catch (error) {
      await this.pool.end().catch(() => undefined);
      this.pool = null;
      throw error;
    } finally { connection?.release(); }
  }
  public async disconnect(): Promise<void> {
    if (this.pool) await this.pool.end();
    this.pool = null;
  }
  public async executeQuery(query: string, options?: QueryExecutionOptions): Promise<QueryExecutionResult> {
    if (!this.pool) throw new Error("MySQL adapter is not connected.");
    const started = Date.now();
    const connection = await this.pool.getConnection();
    try {
      await connection.query("SET TRANSACTION READ ONLY");
      await connection.beginTransaction();
      const timeoutMs = Math.max(1000, Math.min(options?.timeoutMs ?? 10000, 15000));
      const maxRows = Math.max(1, Math.min(options?.maxRows ?? 500, 500));
      const [result] = await connection.query({ sql: `SELECT * FROM (${query}) AS analytics_limited_result LIMIT ${maxRows}`, timeout: timeoutMs });
      await connection.commit();
      const rows = Array.isArray(result) ? result as Record<string, unknown>[] : [];
      return { rows, rowCount: rows.length, executionTimeMs: Date.now() - started };
    } catch (error) {
      try { await connection.rollback(); } catch { /* Preserve original error. */ }
      throw error;
    } finally { connection.release(); }
  }
  public async getSchemaMetadata(): Promise<SchemaMetadata> {
    if (!this.pool) throw new Error("MySQL adapter is not connected.");
    const [result] = await this.pool.query(
      "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION LIMIT 10000"
    );
    const grouped = new Map<string, { name: string; type: string; nullable: boolean }[]>();
    for (const row of result as Array<Record<string, unknown>>) {
      const table = String(row.TABLE_NAME);
      const columns = grouped.get(table) ?? [];
      columns.push({ name: String(row.COLUMN_NAME), type: String(row.DATA_TYPE), nullable: row.IS_NULLABLE === "YES" });
      grouped.set(table, columns);
    }
    return { databaseType: "mysql", tables: Array.from(grouped, ([name, columns]) => ({ name, columns: columns.slice(0, 100) })).slice(0, 100) };
  }
}