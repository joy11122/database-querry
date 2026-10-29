import { MongoClient, type Db, type Document } from "mongodb";
import { BaseDatabaseAdapter, type QueryExecutionOptions, type QueryExecutionResult } from "./base.adapter";
import type { MongoCredentials, SchemaMetadata } from "@/types/database";
import { validateMongoAnalyticsQuery } from "@/services/ai/query-validator.service";

export class MongoDatabaseAdapter extends BaseDatabaseAdapter {
  public readonly type = "mongodb" as const;
  private client: MongoClient | null = null;
  private database: Db | null = null;

  public constructor(private readonly credentials: MongoCredentials) { super(); }
  public async connect(): Promise<void> {
    if (this.client) return;
    this.client = new MongoClient(this.credentials.uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 });
    try {
      await this.client.connect();
      this.database = this.client.db(this.credentials.database);
    } catch (error) {
      await this.client.close().catch(() => undefined);
      this.client = null;
      this.database = null;
      throw error;
    }
  }
  public async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.database = null;
    if (client) await client.close();
  }
  public async executeQuery(query: string, options?: QueryExecutionOptions): Promise<QueryExecutionResult> {
    if (!this.database) throw new Error("MongoDB adapter is not connected.");
    const maxRows = Math.max(1, Math.min(options?.maxRows ?? 500, 500));
    const safeQuery = validateMongoAnalyticsQuery(query, await this.getSchemaMetadata(), maxRows);
    const pipeline: Document[] = [...safeQuery.pipeline, { $limit: maxRows }];
    const started = Date.now();
    const rows = await this.database.collection(safeQuery.collection).aggregate(pipeline, {
      maxTimeMS: Math.max(1000, Math.min(options?.timeoutMs ?? 10000, 15000)),
      allowDiskUse: false
    }).toArray();
    return { rows, rowCount: rows.length, executionTimeMs: Date.now() - started };
  }
  public async getSchemaMetadata(): Promise<SchemaMetadata> {
    if (!this.database) throw new Error("MongoDB adapter is not connected.");
    const collections = await this.database.listCollections({}, { nameOnly: true }).toArray();
    const tables: SchemaMetadata["tables"][number][] = [];
    for (const collection of collections.filter((item) => !item.name.startsWith("system.")).slice(0, 100)) {
      // Return field names/types only; never send document values to the AI provider.
      const sample = await this.database.collection(collection.name).aggregate([
        { $limit: 1 },
        {
          $project: {
            fields: {
              $map: {
                input: { $objectToArray: "$$ROOT" },
                as: "field",
                in: { name: "$$field.k", type: { $type: "$$field.v" } }
              }
            }
          }
        }
      ], { maxTimeMS: 2000, allowDiskUse: false }).next().catch(() => null);
      const fields = Array.isArray(sample?.fields) ? sample.fields as Array<{ name?: unknown; type?: unknown }> : [];
      tables.push({
        name: collection.name,
        columns: fields.filter((field) => typeof field.name === "string" && typeof field.type === "string")
          .slice(0, 100).map((field) => ({ name: String(field.name), type: String(field.type) }))
      });
    }
    return { databaseType: "mongodb", tables };
  }
}
