import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { consumeRateLimit } from "@/services/billing/usage";

export const runtime = "nodejs";
const inputSchema = z.object({ plan: z.enum(["pro", "business"]) });

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  try {
    const input = inputSchema.parse(await request.json());
    const secret = process.env.STRIPE_SECRET_KEY;
    const priceId = input.plan === "pro" ? process.env.STRIPE_PRICE_PRO : process.env.STRIPE_PRICE_BUSINESS;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL;
    if (!secret || !priceId || !appUrl) {
      return NextResponse.json({ error: "Paid checkout is not configured. Add Stripe keys, price IDs, and the application URL." }, { status: 503 });
    }
    const rate = await consumeRateLimit("billing-checkout:" + session.user.id, 5, 10 * 60_000);
    if (!rate.allowed) return NextResponse.json({ error: "Too many checkout attempts. Please wait." }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } });

    const origin = new URL(appUrl);
    if (process.env.NODE_ENV === "production" && origin.protocol !== "https:") {
      return NextResponse.json({ error: "The production application URL must use HTTPS." }, { status: 500 });
    }

    const form = new URLSearchParams();
    form.set("mode", "subscription");
    form.set("line_items[0][price]", priceId);
    form.set("line_items[0][quantity]", "1");
    form.set("client_reference_id", session.user.id);
    form.set("metadata[userId]", session.user.id);
    form.set("metadata[plan]", input.plan);
    form.set("subscription_data[metadata][userId]", session.user.id);
    form.set("subscription_data[metadata][plan]", input.plan);
    if (session.user.email) form.set("customer_email", session.user.email);
    form.set("success_url", new URL("/billing?checkout=success", origin).toString());
    form.set("cancel_url", new URL("/billing?checkout=cancelled", origin).toString());

    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer " + secret, "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      cache: "no-store",
    });
    const payload = await response.json() as { url?: unknown; error?: { message?: string } };
    if (!response.ok || typeof payload.url !== "string" || !payload.url.startsWith("https://checkout.stripe.com/")) {
      console.error("Stripe checkout session creation failed", { status: response.status, message: payload.error?.message });
      return NextResponse.json({ error: "Could not start secure checkout. Please try again." }, { status: 502 });
    }
    return NextResponse.json({ url: payload.url }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Invalid checkout request." }, { status: 400 });
  }
}
