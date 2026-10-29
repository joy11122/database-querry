import type { PlanId } from "@/services/billing/plans";

export function BillingActions({ plan }: { plan: PlanId }) {
  return (
    <div className="rounded-xl border border-dashed p-4">
      <p className="text-sm font-medium">Current plan: {plan}</p>
      <p className="mt-1 text-sm text-slate-600">Checkout is disabled until Stripe price IDs, a checkout endpoint, and webhook verification are configured.</p>
    </div>
  );
}
