import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/mongoose";
import { DBConnectionModel } from "@/db/models/db-connection.model";
import { decryptConnectionSecret } from "@/lib/connection-crypto";
import { releaseConnectionSlot } from "@/services/billing/usage";
import { inspectExternalDb, testExternalDb, type ExternalDbConfig } from "@/lib/external-database";
import { toPublicError } from "@/lib/errors";

export const runtime = "nodejs";
const idSchema = z.string().regex(/^[a-f\\d]{24}$/i);

export async function DELETE(_request: Request, context: { params: { id: string } }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Please sign in." } }, { status: 401 });
    if (!idSchema.safeParse(context.params.id).success) return NextResponse.json({ error: { code: "INVALID_ID", message: "Invalid connection id." } }, { status: 400 });
    await connectMongoose();
    const deleted = await DBConnectionModel.findOneAndDelete({ _id: context.params.id, userId: session.user.id }).exec();
    if (!deleted) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Connection not found." } }, { status: 404 });
    if (deleted.isActive) {
      try { await releaseConnectionSlot(session.user.id); }
      catch (error) {
        console.error("Connection was deleted but its usage counter could not be released", {
          userId: session.user.id,
          name: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    const safe = toPublicError(error);
    console.error("Connection deletion failed", { code: safe.code, statusCode: safe.statusCode });
    return NextResponse.json({ error: { code: safe.code, message: safe.message } }, { status: safe.statusCode });
  }
}

export async function POST(_request: Request, context: { params: { id: string } }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Please sign in." } }, { status: 401 });
    if (!idSchema.safeParse(context.params.id).success) return NextResponse.json({ error: { code: "INVALID_ID", message: "Invalid connection id." } }, { status: 400 });
    await connectMongoose();
    const connection = await DBConnectionModel.findOne({ _id: context.params.id, userId: session.user.id }).exec();
    if (!connection) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Connection not found." } }, { status: 404 });
    try {
      const config = JSON.parse(decryptConnectionSecret(connection.encryptedCredentials)) as ExternalDbConfig;
      await testExternalDb(config);
      const schema = await inspectExternalDb(config);
      return NextResponse.json({ success: true, tables: schema.tables });
    } catch (error) {
      console.error("Connection test failed", { name: error instanceof Error ? error.name : "UnknownError" });
      return NextResponse.json({ error: { code: "CONNECTION_TEST_FAILED", message: "Connection test failed. Check database availability, credentials and outbound host policy." } }, { status: 400 });
    }
  } catch (error) {
    const safe = toPublicError(error);
    console.error("Connection test request failed", { code: safe.code, statusCode: safe.statusCode });
    return NextResponse.json({ error: { code: safe.code, message: safe.message } }, { status: safe.statusCode });
  }
}
