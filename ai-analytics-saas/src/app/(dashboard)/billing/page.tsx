import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getUserPlan } from "@/services/billing/usage";
import { PLANS } from "@/services/billing/plans";
import { BillingActions } from "@/components/billing/billing-actions";

export const dynamic = "force-dynamic";
export default async function BillingPage() {
  const session = await auth(); if (!session?.user?.id) redirect("/login");
  const usage = await getUserPlan(session.user.id);
  return <section className="space-y-8">
    <div><p className="text-sm font-semibold uppercase tracking-wider text-indigo-600">Plans & billing</p><h1 className="mt-2 text-3xl font-semibold">Choose a plan that scales with you</h1><p className="mt-2 text-slate-600">Upgrade or manage your subscription securely through Stripe.</p></div>
    <div className="grid gap-5 lg:grid-cols-3">
      {(Object.entries(PLANS) as Array<[keyof typeof PLANS, (typeof PLANS)[keyof typeof PLANS]]>).map(([id, plan]) => <article key={id} className={`rounded-2xl border bg-white p-6 ${usage.plan === id ? "border-indigo-500 ring-1 ring-indigo-500" : ""}`}>
        <div className="flex items-center justify-between"><h2 className="text-xl font-semibold">{plan.name}</h2>{usage.plan === id ? <span className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700">Current</span> : null}</div>
        <p className="mt-4 text-3xl font-bold">{plan.price === 0 ? "Free" : `$${plan.price}`}<span className="text-sm font-normal text-slate-500">{plan.price ? "/ month" : " forever"}</span></p>
        <ul className="mt-5 space-y-3 text-sm text-slate-600">{plan.features.map((feature) => <li key={feature} className="flex gap-2"><span className="text-emerald-600">✓</span>{feature}</li>)}</ul>
      </article>)}
    </div>
    <div className="rounded-2xl border bg-white p-6"><div className="flex flex-wrap items-start justify-between gap-5"><div><h2 className="text-lg font-semibold">Your usage this month</h2><p className="mt-1 text-sm text-slate-600">{usage.used.toLocaleString()} of {usage.monthlyQueries.toLocaleString()} AI questions used</p><div className="mt-4 h-2.5 w-full max-w-xl overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-indigo-600" style={{ width: `${Math.min(100, usage.used / usage.monthlyQueries * 100)}%` }} /></div><p className="mt-2 text-xs text-slate-500">{usage.remaining.toLocaleString()} questions remaining · {usage.connections} active connection limit</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-sm capitalize">{usage.plan} · {usage.status}</span></div><div className="mt-6"><BillingActions plan={usage.plan} /></div><p className="mt-4 text-xs leading-5 text-slate-500">Paid plans require Stripe price IDs and a configured webhook. Prices shown are sample USD amounts; configure matching prices in your Stripe account before enabling checkout.</p></div>
  </section>;
}
