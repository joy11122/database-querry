import type { DatabaseAdapter } from "./base.adapter";
import { MongoDatabaseAdapter } from "./mongo.adapter";
import { PostgreSQLAdapter } from "./postgres.adapter";
import { MySQLAdapter } from "./mysql.adapter";
import type { DatabaseCredentials, DatabaseType } from "@/types/database";

export function createDatabaseAdapter(type: DatabaseType, credentials: DatabaseCredentials): DatabaseAdapter {
  switch (type) {
    case "mongodb":
      if (!("uri" in credentials)) throw new Error("Invalid MongoDB credentials.");
      return new MongoDatabaseAdapter(credentials);
    case "postgresql":
      if (!("dsn" in credentials)) throw new Error("Invalid PostgreSQL credentials.");
      return new PostgreSQLAdapter(credentials);
    case "mysql":
      if (!("host" in credentials)) throw new Error("Invalid MySQL credentials.");
      return new MySQLAdapter(credentials);
  }
}