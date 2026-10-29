import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/mongoose";
import { DBConnectionModel } from "@/db/models/db-connection.model";
import { SubscriptionModel } from "@/db/models/subscription.model";
import { UsageEventModel } from "@/db/models/usage-event.model";
import { toPublicError } from "@/lib/errors";
export const runtime = "nodejs";
function isAdmin(email?: string | null): boolean { const allow = (process.env.ADMIN_EMAILS ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean); return Boolean(email && allow.includes(email.toLowerCase())); }
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: "Authentication required." } }, { status: 401 });
    if (!isAdmin(session.user.email)) return NextResponse.json({ success: false, error: { code: "FORBIDDEN", message: "Administrator access required." } }, { status: 403 });
    await connectMongoose();
    const since = new Date(); since.setUTCDate(1); since.setUTCHours(0, 0, 0, 0);
    const [connections, activeSubscriptions, queriesThisMonth, recentEvents] = await Promise.all([
      DBConnectionModel.countDocuments({ isActive: true }).exec(),
      SubscriptionModel.countDocuments({ plan: { $in: ["pro", "business"] }, status: { $in: ["active", "trialing"] } }).exec(),
      UsageEventModel.countDocuments({ kind: "query_success", createdAt: { $gte: since } }).exec(),
      UsageEventModel.find().sort({ createdAt: -1 }).limit(20).select("userId kind durationMs rowCount createdAt").lean().exec()
    ]);
    return NextResponse.json({ success: true, data: { connections, activeSubscriptions, queriesThisMonth, recentEvents } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { const safe = toPublicError(error); return NextResponse.json({ success: false, error: { code: safe.code, message: safe.message } }, { status: safe.statusCode }); }
}
