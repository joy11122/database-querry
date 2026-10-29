export type DatabaseType = "mongodb" | "postgresql" | "mysql";

export interface MongoCredentials {
  readonly uri: string;
  readonly database: string;
}

export interface PostgreSQLCredentials {
  readonly dsn: string;
  readonly schema?: string;
}

export interface MySQLCredentials {
  readonly host: string;
  readonly port?: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
  readonly ssl?: boolean;
}

export type DatabaseCredentials =
  | MongoCredentials
  | PostgreSQLCredentials
  | MySQLCredentials;

export interface SchemaColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable?: boolean;
}

export interface SchemaTable {
  readonly name: string;
  readonly columns: readonly SchemaColumn[];
}

export interface SchemaMetadata {
  readonly databaseType: DatabaseType;
  readonly tables: readonly SchemaTable[];
}
