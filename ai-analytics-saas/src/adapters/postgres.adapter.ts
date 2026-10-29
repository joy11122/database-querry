import { Pool, type PoolConfig } from "pg";
import { BaseDatabaseAdapter, type QueryExecutionOptions, type QueryExecutionResult } from "./base.adapter";
import type { PostgreSQLCredentials, SchemaMetadata } from "@/types/database";

export class PostgreSQLAdapter extends BaseDatabaseAdapter {
  public readonly type = "postgresql" as const;
  private pool: Pool | null = null;
  public constructor(private readonly credentials: PostgreSQLCredentials) { super(); }

  public async connect(): Promise<void> {
    if (this.pool) return;
    const config: PoolConfig = { connectionString: this.credentials.dsn, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 };
    this.pool = new Pool(config);
    try { await this.pool.query("SELECT 1"); } catch (error) { await this.pool.end(); this.pool = null; throw error; }
  }
  public async disconnect(): Promise<void> {
    if (this.pool) await this.pool.end();
    this.pool = null;
  }
  public async executeQuery(query: string, options?: QueryExecutionOptions): Promise<QueryExecutionResult> {
    if (!this.pool) throw new Error("PostgreSQL adapter is not connected.");
    const started = Date.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      const timeoutMs = Math.max(1000, Math.min(options?.timeoutMs ?? 10000, 15000));
      await client.query("SELECT set_config('statement_timeout', $1, true)", [`${timeoutMs}ms`]);
      const maxRows = Math.max(1, Math.min(options?.maxRows ?? 500, 500));
      const result = await client.query(`SELECT * FROM (${query}) AS analytics_limited_result LIMIT ${maxRows}`);
      await client.query("COMMIT");
      const rows = result.rows;
      return { rows, rowCount: rows.length, executionTimeMs: Date.now() - started };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve original error. */ }
      throw error;
    } finally { client.release(); }
  }
  public async getSchemaMetadata(): Promise<SchemaMetadata> {
    if (!this.pool) throw new Error("PostgreSQL adapter is not connected.");
    const result = await this.pool.query(
      "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position LIMIT 10000",
      [this.credentials.schema ?? "public"]
    );
    const grouped = new Map<string, { name: string; type: string; nullable: boolean }[]>();
    for (const row of result.rows) {
      const columns = grouped.get(row.table_name) ?? [];
      columns.push({ name: row.column_name, type: row.data_type, nullable: row.is_nullable === "YES" });
      grouped.set(row.table_name, columns);
    }
    return { databaseType: "postgresql", tables: Array.from(grouped, ([name, columns]) => ({ name, columns: columns.slice(0, 100) })).slice(0, 100) };
  }
}