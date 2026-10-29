import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/mongoose";
import { UsageEventModel } from "@/db/models/usage-event.model";
import { NextResponse } from "next/server";

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await connectMongoose();
    const events = await UsageEventModel.find({ userId: session.user.id })
      .sort({ createdAt: -1 })
      .limit(5000)
      .select("createdAt kind durationMs rowCount")
      .lean()
      .exec();

    const rows = [
      ["date", "event", "duration_ms", "rows"],
      ...events.map((event) => [
        new Date(event.createdAt).toISOString(),
        event.kind,
        event.durationMs ?? "",
        event.rowCount ?? "",
      ]),
    ];
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="ai-analytics-usage.csv"',
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Unable to export usage report." }, { status: 500 });
  }
}
