import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/mongoose";
import { DBConnectionModel } from "@/db/models/db-connection.model";
import { decryptConnectionSecret } from "@/lib/connection-crypto";
import { inspectExternalDb, testExternalDb, type ExternalDbConfig } from "@/lib/external-database";

export const runtime = "nodejs";
const idSchema = z.string().regex(/^[a-f\d]{24}$/i);
export async function DELETE(_request: Request, context: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: { message: "Please sign in." } }, { status: 401 });
  if (!idSchema.safeParse(context.params.id).success) return NextResponse.json({ error: { message: "Invalid connection id." } }, { status: 400 });
  await connectMongoose();
  const deleted = await DBConnectionModel.findOneAndDelete({ _id: context.params.id, userId: session.user.id }).exec();
  if (!deleted) return NextResponse.json({ error: { message: "Connection not found." } }, { status: 404 });
  return NextResponse.json({ success: true });
}

export async function POST(_request: Request, context: { params: { id: string } }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: { message: "Please sign in." } }, { status: 401 });
  if (!idSchema.safeParse(context.params.id).success) return NextResponse.json({ error: { message: "Invalid connection id." } }, { status: 400 });
  await connectMongoose();
  const connection = await DBConnectionModel.findOne({ _id: context.params.id, userId: session.user.id }).exec();
  if (!connection) return NextResponse.json({ error: { message: "Connection not found." } }, { status: 404 });
  try {
    const config = JSON.parse(decryptConnectionSecret(connection.encryptedCredentials)) as ExternalDbConfig;
    await testExternalDb(config);
    const schema = await inspectExternalDb(config);
    return NextResponse.json({ success: true, tables: schema.tables });
  } catch {
    return NextResponse.json({ error: { message: "Connection test failed. Check database availability and credentials." } }, { status: 400 });
  }
}
