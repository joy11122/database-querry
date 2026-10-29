import { MongoClient, type MongoClientOptions } from "mongodb";
import { env } from "@/config/env";

const uri = env.MONGODB_URI;
if (!uri) {
  // Fail at use-time with a clear message instead of breaking unrelated build steps.
}

const options: MongoClientOptions = {};
let clientPromise: Promise<MongoClient>;

declare global {
  // eslint-disable-next-line no-var
  var _authMongoClientPromise: Promise<MongoClient> | undefined;
}

if (!uri) {
  clientPromise = Promise.reject(new Error("MONGODB_URI is not configured"));
} else if (process.env.NODE_ENV === "development") {
  global._authMongoClientPromise ??= new MongoClient(uri, options).connect();
  clientPromise = global._authMongoClientPromise;
} else {
  clientPromise = new MongoClient(uri, options).connect();
}

export const authMongoClientPromise = clientPromise;
