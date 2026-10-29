import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { connectMongoose } from "@/lib/mongoose";
import { UsageEventModel } from "@/db/models/usage-event.model";
import { getUserPlan } from "@/services/billing/usage";
import { UsageChart } from "@/components/dashboard/usage-chart";
export const dynamic = "force-dynamic";
export default async function ReportsPage() {
  const session = await auth(); if (!session?.user?.id) redirect("/login");
  await connectMongoose();
  const since = new Date(Date.now() - 29 * 86400000);
  const [events, plan] = await Promise.all([UsageEventModel.find({ userId: session.user.id, createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(1000).lean().exec(), getUserPlan(session.user.id)]);
  const chart = Array.from({ length: 30 }, (_, i) => { const d = new Date(Date.now() - (29 - i) * 86400000); const key = d.toISOString().slice(0, 10); return { label: d.getUTCDate() % 5 === 0 || i === 29 ? `${d.getUTCDate()}` : "", count: events.filter((e) => e.kind === "query_success" && new Date(e.createdAt).toISOString().slice(0, 10) === key).length }; });
  const reportRows = events.map((event) => ({ date: new Date(event.createdAt).toISOString(), event: event.kind, durationMs: event.durationMs ?? "", rows: event.rowCount ?? "" }));
  return <section className="space-y-6"><div className="flex flex-wrap items-end justify-between gap-4"><div><h1 className="text-3xl font-semibold">Usage reports</h1><p className="mt-2 text-slate-600">Your analytics activity over the last 30 days.</p></div><a download="ai-analytics-usage.csv" href="/api/reports/export" className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white">Export CSV</a></div>
    <div className="grid gap-4 sm:grid-cols-3"><div className="rounded-2xl border bg-white p-5"><p className="text-sm text-slate-500">Successful queries (30d)</p><p className="mt-2 text-3xl font-semibold">{events.filter((e) => e.kind === "query_success").length}</p></div><div className="rounded-2xl border bg-white p-5"><p className="text-sm text-slate-500">Average execution time</p><p className="mt-2 text-3xl font-semibold">{Math.round(events.filter((e) => e.kind === "query_success" && typeof e.durationMs === "number").reduce((sum, e) => sum + (e.durationMs ?? 0), 0) / Math.max(1, events.filter((e) => e.kind === "query_success" && typeof e.durationMs === "number").length))} ms</p></div><div className="rounded-2xl border bg-white p-5"><p className="text-sm text-slate-500">Plan remaining</p><p className="mt-2 text-3xl font-semibold">{plan.remaining.toLocaleString()}</p></div></div>
    <article className="rounded-2xl border bg-white p-6"><h2 className="font-semibold">Daily query activity</h2><div className="mt-4"><UsageChart values={chart} /></div></article>
    <article className="overflow-hidden rounded-2xl border bg-white"><div className="border-b p-5"><h2 className="font-semibold">Recent activity</h2><p className="mt-1 text-sm text-slate-500">Up to 1,000 events from the last 30 days.</p></div><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-slate-500"><tr><th className="px-5 py-3">Time</th><th className="px-5 py-3">Event</th><th className="px-5 py-3">Duration</th><th className="px-5 py-3">Rows</th></tr></thead><tbody>{reportRows.slice(0,100).map((row,index)=><tr key={`${row.date}-${index}`} className="border-t"><td className="whitespace-nowrap px-5 py-3">{new Date(row.date).toLocaleString()}</td><td className="px-5 py-3">{row.event.replaceAll("_"," ")}</td><td className="px-5 py-3">{row.durationMs ? `${row.durationMs} ms` : "—"}</td><td className="px-5 py-3">{row.rows === "" ? "—" : row.rows}</td></tr>)}</tbody></table></div></article>
  </section>;
}
