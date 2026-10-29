import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { connectMongoose } from "@/lib/mongoose";
import { DBConnectionModel } from "@/db/models/db-connection.model";
import { SubscriptionModel } from "@/db/models/subscription.model";
import { UsageEventModel } from "@/db/models/usage-event.model";
function isAdmin(email?: string | null) { const emails = (process.env.ADMIN_EMAILS ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean); return Boolean(email && emails.includes(email.toLowerCase())); }
export const dynamic = "force-dynamic";
export default async function AdminPage() {
  const session = await auth(); if (!session?.user?.id) redirect("/login");
  if (!isAdmin(session.user.email)) redirect("/dashboard");
  await connectMongoose();
  const since = new Date(); since.setUTCDate(1); since.setUTCHours(0,0,0,0);
  const [users, connections, paid, queries, events] = await Promise.all([
    import("@/lib/mongodb").then(async ({ authMongoClientPromise }) => { const client = await authMongoClientPromise; return client.db(process.env.MONGODB_DATABASE).collection("users").countDocuments(); }),
    DBConnectionModel.countDocuments({ isActive: true }).exec(),
    SubscriptionModel.countDocuments({ plan: { $in: ["pro", "business"] }, status: { $in: ["active", "trialing"] } }).exec(),
    UsageEventModel.countDocuments({ kind: "query_success", createdAt: { $gte: since } }).exec(),
    UsageEventModel.find().sort({ createdAt: -1 }).limit(25).select("userId kind createdAt durationMs rowCount").lean().exec()
  ]);
  return <section className="space-y-6"><div><p className="text-sm font-semibold uppercase tracking-wider text-indigo-600">Restricted access</p><h1 className="mt-2 text-3xl font-semibold">Admin overview</h1><p className="mt-2 text-slate-600">Operational counts and recent usage events. This page does not expose customer database credentials.</p></div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[{label:"Registered users",value:users},{label:"Active connections",value:connections},{label:"Paid subscriptions",value:paid},{label:"Queries this month",value:queries}].map((item)=><div key={item.label} className="rounded-2xl border bg-white p-5"><p className="text-sm text-slate-500">{item.label}</p><p className="mt-2 text-3xl font-semibold">{item.value.toLocaleString()}</p></div>)}</div><div className="overflow-hidden rounded-2xl border bg-white"><div className="border-b p-5"><h2 className="font-semibold">Recent events</h2></div><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-slate-50"><tr><th className="px-5 py-3">Date</th><th className="px-5 py-3">User ID</th><th className="px-5 py-3">Event</th><th className="px-5 py-3">Duration</th></tr></thead><tbody>{events.map((event,index)=><tr key={`${event._id}-${index}`} className="border-t"><td className="whitespace-nowrap px-5 py-3">{new Date(event.createdAt).toLocaleString()}</td><td className="max-w-48 truncate px-5 py-3 font-mono text-xs">{event.userId}</td><td className="px-5 py-3">{event.kind.replaceAll("_"," ")}</td><td className="px-5 py-3">{event.durationMs ? `${event.durationMs} ms` : "—"}</td></tr>)}</tbody></table></div></div></section>;
}
