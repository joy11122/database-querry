import type { DatabaseType, SchemaMetadata } from "@/types/database";
export interface QueryExecutionOptions {
  readonly timeoutMs?: number;
  readonly maxRows?: number;
}
export interface QueryExecutionResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number;
  readonly executionTimeMs: number;
}
export interface DatabaseAdapter {
  readonly type: DatabaseType;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  executeQuery(query: string, options?: QueryExecutionOptions): Promise<QueryExecutionResult>;
  getSchemaMetadata(): Promise<SchemaMetadata>;
}
export abstract class BaseDatabaseAdapter implements DatabaseAdapter {
  public abstract readonly type: DatabaseType;
  public abstract connect(): Promise<void>;
  public abstract disconnect(): Promise<void>;
  public abstract executeQuery(query: string, options?: QueryExecutionOptions): Promise<QueryExecutionResult>;
  public abstract getSchemaMetadata(): Promise<SchemaMetadata>;
}