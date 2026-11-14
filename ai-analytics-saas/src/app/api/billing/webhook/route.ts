import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { connectMongoose } from "@/lib/mongoose";
import { SubscriptionModel } from "@/db/models/subscription.model";

export const runtime = "nodejs";

function verifyStripeSignature(payload: string, header: string, secret: string): boolean {
  const parts = header.split(",").map(part => part.split("=", 2));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || !/^\d+$/.test(timestamp) || !signatures.length) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > 300) return false;
  const expected = createHmac("sha256", secret).update(timestamp + "." + payload, "utf8").digest();
  return signatures.some(signature => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    const actual = Buffer.from(signature, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Webhook is not configured." }, { status: 503 });
  const payload = await request.text();
  const signature = request.headers.get("stripe-signature") ?? "";
  if (!verifyStripeSignature(payload, signature, secret)) {
    return NextResponse.json({ error: "Invalid webhook signature." }, { status: 400 });
  }

  try {
    const event = JSON.parse(payload) as {
      type?: string;
      data?: { object?: Record<string, unknown> };
    };
    const object = event.data?.object;
    if (!object) return NextResponse.json({ received: true });

    if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type ?? "")) {
      const subscriptionId = typeof object.id === "string" ? object.id : "";
      const metadata = object.metadata && typeof object.metadata === "object" ? object.metadata as Record<string, unknown> : {};
      const userId = typeof metadata.userId === "string" ? metadata.userId : "";
      const plan = metadata.plan === "pro" || metadata.plan === "business" ? metadata.plan : null;
      if (!subscriptionId) return NextResponse.json({ error: "Subscription ID missing." }, { status: 400 });

      await connectMongoose();
      const existing = await SubscriptionModel.findOne({ stripeSubscriptionId: subscriptionId }).lean().exec();
      const resolvedUserId = userId || existing?.userId;
      const resolvedPlan = plan || existing?.plan;
      if (!resolvedUserId || !resolvedPlan) {
        console.error("Stripe subscription event missing application metadata", { subscriptionId, eventType: event.type });
        return NextResponse.json({ error: "Subscription metadata is incomplete." }, { status: 400 });
      }
      const statusValue = event.type === "customer.subscription.deleted" ? "canceled" : object.status;
      const allowedStatuses = new Set(["active", "trialing", "past_due", "canceled", "incomplete"]);
      const status = typeof statusValue === "string" && allowedStatuses.has(statusValue) ? statusValue : "incomplete";
      const customerId = typeof object.customer === "string"
        ? object.customer
        : object.customer && typeof object.customer === "object" && "id" in object.customer
          ? String((object.customer as { id: unknown }).id)
          : undefined;
      const periodEnd = typeof object.current_period_end === "number"
        ? new Date(object.current_period_end * 1000)
        : undefined;
      await SubscriptionModel.findOneAndUpdate(
        { stripeSubscriptionId: subscriptionId },
        { $set: {
          userId: resolvedUserId,
          plan: resolvedPlan,
          status,
          stripeCustomerId: customerId ?? existing?.stripeCustomerId,
          stripeSubscriptionId: subscriptionId,
          ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
        } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).exec();
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook processing failed", { name: error instanceof Error ? error.name : "UnknownError" });
    return NextResponse.json({ error: "Webhook processing failed." }, { status: 500 });
  }
}
