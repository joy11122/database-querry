"use client";

import { useState } from "react";
import type { PlanId } from "@/services/billing/plans";

export function BillingActions({ plan }: { plan: PlanId }) {
  const [loading, setLoading] = useState<PlanId | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function startCheckout(nextPlan: "pro" | "business") {
    setLoading(nextPlan);
    setError(null);
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: nextPlan }),
      });
      const payload = await response.json() as { url?: string; error?: string };
      if (!response.ok || !payload.url) throw new Error(payload.error || "Could not start checkout.");
      window.location.assign(payload.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start checkout.");
      setLoading(null);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-dashed p-4">
      <p className="text-sm font-medium">Current plan: <span className="capitalize">{plan}</span></p>
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={() => startCheckout("pro")} disabled={loading !== null || plan === "pro"} className="rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">
          {loading === "pro" ? "Opening checkout…" : plan === "pro" ? "Pro plan active" : "Upgrade to Pro"}
        </button>
        <button type="button" onClick={() => startCheckout("business")} disabled={loading !== null || plan === "business"} className="rounded-lg border px-4 py-2.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50">
          {loading === "business" ? "Opening checkout…" : plan === "business" ? "Business plan active" : "Upgrade to Business"}
        </button>
      </div>
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
    </div>
  );
}
