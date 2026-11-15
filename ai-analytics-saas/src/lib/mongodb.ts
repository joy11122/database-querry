import { MongoClient, type MongoClientOptions } from "mongodb";
import { env } from "@/config/env";

const uri = env.MONGODB_URI;

const options: MongoClientOptions = {
  maxPoolSize: 10,
  minPoolSize: 0,
  retryReads: true,
};

declare global {
  // eslint-disable-next-line no-var
  var _authMongoClientPromise: Promise<MongoClient> | undefined;
}

function createClientPromise(): Promise<MongoClient> {
  if (!uri) {
    return Promise.reject(new Error("MONGODB_URI is not configured"));
  }

  return new MongoClient(uri, options).connect();
}

// Reuse one MongoClient connection pool per warm serverless instance.
// This avoids opening a new pool for every module initialization in production.
const clientPromise =
  global._authMongoClientPromise ??
  (global._authMongoClientPromise = createClientPromise());

// Mark the rejection as observed to prevent an unhandled-rejection warning
// during module initialization. The original promise remains rejected for
// Auth.js to receive and report through its adapter error handling.
void clientPromise.catch(() => {
  if (global._authMongoClientPromise === clientPromise) {
    global._authMongoClientPromise = undefined;
  }
});

export const authMongoClientPromise = clientPromise;
