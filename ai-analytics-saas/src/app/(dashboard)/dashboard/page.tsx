import Link from "next/link";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { connectMongoose } from "@/lib/mongoose";
import { DBConnectionModel } from "@/db/models/db-connection.model";
import { UsageEventModel } from "@/db/models/usage-event.model";
import { getUserPlan } from "@/services/billing/usage";
import { UsageChart } from "@/components/dashboard/usage-chart";

export const dynamic = "force-dynamic";
export default async function DashboardPage() {
  const session = await auth(); if (!session?.user?.id) redirect("/login");
  await connectMongoose();
  const [connectionCount, plan, lastEvents] = await Promise.all([
    DBConnectionModel.countDocuments({ userId: session.user.id, isActive: true }).exec(),
    getUserPlan(session.user.id),
    UsageEventModel.find({ userId: session.user.id, kind: "query_success", createdAt: { $gte: new Date(Date.now() - 6 * 86400000) } }).select("createdAt").lean().exec()
  ]);
  const chart = Array.from({ length: 7 }, (_, i) => { const date = new Date(); date.setDate(date.getDate() - (6 - i)); const key = date.toISOString().slice(0, 10); return { label: date.toLocaleDateString("en", { weekday: "short", timeZone: "UTC" }), count: lastEvents.filter((event) => new Date(event.createdAt).toISOString().slice(0, 10) === key).length }; });
  const cards = [{ label: "AI questions this month", value: `${plan.used.toLocaleString()} / ${plan.monthlyQueries.toLocaleString()}`, hint: `${plan.remaining.toLocaleString()} remaining` }, { label: "Active connections", value: String(connectionCount), hint: `Up to ${plan.connections} on ${plan.plan}` }, { label: "Current plan", value: plan.plan[0].toUpperCase() + plan.plan.slice(1), hint: plan.status }];
  return <section className="space-y-8"><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm font-semibold uppercase tracking-wider text-indigo-600">Workspace overview</p><h1 className="mt-2 text-3xl font-semibold">Welcome{session.user.name ? `, ${session.user.name.split(" ")[0]}` : " back"}</h1><p className="mt-2 text-slate-600">Understand your business data with natural-language analytics.</p></div><Link href="/chat" className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white">Ask AI a question ↗</Link></div>
    <div className="grid gap-4 md:grid-cols-3">{cards.map((card) => <article key={card.label} className="rounded-2xl border bg-white p-5"><p className="text-sm text-slate-500">{card.label}</p><p className="mt-3 text-3xl font-semibold">{card.value}</p><p className="mt-2 text-xs text-slate-500">{card.hint}</p></article>)}</div>
    <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]"><article className="rounded-2xl border bg-white p-6"><div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">AI activity</h2><p className="mt-1 text-sm text-slate-500">Successful analytics queries over the last 7 days</p></div><span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">Live usage</span></div><div className="mt-5"><UsageChart values={chart} /></div></article><article className="rounded-2xl border bg-white p-6"><h2 className="font-semibold">Get started</h2><div className="mt-4 space-y-3">{[{href:"/connections",title:"Connect a database",desc:"Add a read-only reporting connection."},{href:"/chat",title:"Ask your first question",desc:"Use plain language instead of SQL."},{href:"/billing",title:"Explore plans",desc:"Review limits and upgrade when ready."}].map((item) => <Link key={item.href} href={item.href} className="block rounded-xl border p-4 transition hover:border-indigo-300 hover:bg-indigo-50/40"><p className="font-medium">{item.title} <span aria-hidden="true">↗</span></p><p className="mt-1 text-sm text-slate-500">{item.desc}</p></Link>)}</div></article></div>
  </section>;
}
