import mongoose from "mongoose";
import { env } from "@/config/env";

const uri = env.MONGODB_URI;
if (!uri) {
  // Keep static builds working; callers receive an actionable runtime error.
}

type MongooseCache = { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null };

declare global {
  // eslint-disable-next-line no-var
  var _mongooseCache: MongooseCache | undefined;
}

const cached = global._mongooseCache ?? (global._mongooseCache = { conn: null, promise: null });

export async function connectMongoose(): Promise<typeof mongoose> {
  if (cached.conn) return cached.conn;
  if (!uri) throw new Error("MONGODB_URI is not configured");
  if (!cached.promise) {
    cached.promise = mongoose.connect(uri, {
      dbName: env.MONGODB_DATABASE,
      bufferCommands: false,
    });
  }
  cached.conn = await cached.promise;
  return cached.conn;
}
