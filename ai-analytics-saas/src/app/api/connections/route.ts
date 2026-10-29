import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/mongoose";
import { DBConnectionModel } from "@/db/models/db-connection.model";
import { getUserPlan } from "@/services/billing/usage";
import { encryptConnectionSecret } from "@/lib/connection-crypto";
import { inspectExternalDb, testExternalDb, type ExternalDbConfig } from "@/lib/external-database";
import { toPublicError } from "@/lib/errors";

export const runtime = "nodejs";
const connectionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.enum(["postgres", "mysql"]),
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535),
  database: z.string().trim().min(1).max(128),
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(1024),
  ssl: z.boolean().default(true),
});

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Please sign in." } }, { status: 401 });
  try {
    await connectMongoose();
    const connections = await DBConnectionModel.find({ userId: session.user.id })
      .select("name databaseType host database isActive createdAt").sort({ createdAt: -1 }).lean().exec();
    return NextResponse.json({ connections: connections.map((item) => ({ id: String(item._id), name: item.name, databaseType: item.databaseType, host: item.host, database: item.database, isActive: item.isActive, createdAt: item.createdAt })) });
  } catch (error) {
    const safe = toPublicError(error); return NextResponse.json({ error: { code: safe.code, message: safe.message } }, { status: safe.statusCode });
  }
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Please sign in." } }, { status: 401 });
  try {
    const body = connectionSchema.parse(await request.json());
    await connectMongoose();
    const plan = await getUserPlan(session.user.id);
    if (plan.activeConnections >= plan.connections) {
      return NextResponse.json({ error: { code: "CONNECTION_LIMIT", message: `Your ${plan.plan} plan allows ${plan.connections} active connection(s).` } }, { status: 403 });
    }
    const config: ExternalDbConfig = body.type === "mongodb"
      ? { type: "mongodb", uri: body.uri, database: body.database }
      : { type: body.type, host: body.host, port: body.port, database: body.database, username: body.username, password: body.password, ssl: body.ssl };
    await testExternalDb(config);
    const schema = await inspectExternalDb(config);
    if (!schema.tables.length) return NextResponse.json({ error: { code: "EMPTY_SCHEMA", message: "Connected successfully, but no tables or collections were found in this database." } }, { status: 422 });
    const created = await DBConnectionModel.create({
      userId: session.user.id, name: body.name, provider: body.type,
      databaseType: body.type, host: body.host, database: body.database,
      encryptedCredentials: encryptConnectionSecret(JSON.stringify(config)), isActive: true,
    });
    return NextResponse.json({ connection: { id: String(created._id), name: created.name, databaseType: created.databaseType, host: created.host, database: created.database, isActive: created.isActive }, tables: schema.tables }, { status: 201 });
  } catch (error) {
    const safe = toPublicError(error);
    if (safe.statusCode !== 500) return NextResponse.json({ error: { code: safe.code, message: safe.message } }, { status: safe.statusCode });
    console.error("Connection creation failed", error instanceof Error ? error.name : "unknown error");
    return NextResponse.json({ error: { code: "CONNECTION_FAILED", message: "Could not connect. Verify host, port, database, credentials, TLS settings, and network access. Secrets were not saved." } }, { status: 400 });
  }
}
