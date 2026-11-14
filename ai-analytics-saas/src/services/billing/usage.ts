import { connectMongoose } from "@/lib/mongoose";
import { SubscriptionModel } from "@/db/models/subscription.model";
import { UsageEventModel } from "@/db/models/usage-event.model";
import { UsageCounterModel } from "@/db/models/usage-counter.model";
import { ConnectionCounterModel } from "@/db/models/connection-counter.model";
import { RateLimitModel } from "@/db/models/rate-limit.model";
import { DBConnectionModel } from "@/db/models/db-connection.model";
import { PLANS, type PlanId } from "@/services/billing/plans";

function getCurrentMonth() {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { monthStart, monthKey: monthStart.toISOString().slice(0, 7) };
}

export async function consumeRateLimit(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  await connectMongoose();
  const now = new Date();
  const resetAt = new Date(now.getTime() + windowMs);
  const active = await RateLimitModel.findOneAndUpdate(
    { key, resetAt: { $gt: now }, count: { $lt: limit } },
    { $inc: { count: 1 } },
    { new: true },
  ).lean().exec();
  if (active) return { allowed: true, retryAfterSeconds: 0 };

  const expired = await RateLimitModel.findOneAndUpdate(
    { key, resetAt: { $lte: now } },
    { $set: { count: 1, resetAt } },
    { new: true },
  ).lean().exec();
  if (expired) return { allowed: true, retryAfterSeconds: 0 };

  const existing = await RateLimitModel.findOne({ key }).lean().exec();
  if (existing) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt.getTime() - now.getTime()) / 1000)) };
  }

  try {
    await RateLimitModel.create({ key, count: 1, resetAt });
    return { allowed: true, retryAfterSeconds: 0 };
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (code !== 11000) throw error;
    const raced = await RateLimitModel.findOneAndUpdate(
      { key, resetAt: { $gt: now }, count: { $lt: limit } },
      { $inc: { count: 1 } },
      { new: true },
    ).lean().exec();
    if (raced) return { allowed: true, retryAfterSeconds: 0 };
    const current = await RateLimitModel.findOne({ key }).lean().exec();
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(((current?.resetAt.getTime() ?? resetAt.getTime()) - now.getTime()) / 1000)) };
  }
}

export async function reserveQueryUsage(userId: string, limit: number): Promise<{ monthKey: string } | null> {
  await connectMongoose();
  const { monthStart, monthKey } = getCurrentMonth();
  const filter = { userId, monthKey, count: { $lt: limit } };
  const updated = await UsageCounterModel.findOneAndUpdate(filter, { $inc: { count: 1 } }, { new: true }).lean().exec();
  if (updated) return { monthKey };

  const existing = await UsageCounterModel.findOne({ userId, monthKey }).lean().exec();
  if (existing) return null;

  // Seed the counter with legacy successful events so existing users keep their
  // current month's usage when this atomic counter is introduced.
  const legacyUsed = await UsageEventModel.countDocuments({
    userId, kind: "query_success", createdAt: { $gte: monthStart },
  }).exec();
  if (legacyUsed >= limit) return null;

  try {
    await UsageCounterModel.create({ userId, monthKey, count: legacyUsed + 1 });
    return { monthKey };
  } catch (error) {
    // Another request may have initialized this user's monthly counter first.
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (code !== 11000) throw error;
    const raced = await UsageCounterModel.findOneAndUpdate(filter, { $inc: { count: 1 } }, { new: true }).lean().exec();
    return raced ? { monthKey } : null;
  }
}

export async function releaseQueryUsage(userId: string, monthKey: string): Promise<void> {
  await connectMongoose();
  await UsageCounterModel.updateOne(
    { userId, monthKey, count: { $gt: 0 } },
    { $inc: { count: -1 } },
  ).exec();
}

export async function reserveConnectionSlot(userId: string, limit: number): Promise<boolean> {
  await connectMongoose();
  const filter = { userId, count: { $lt: limit } };
  const updated = await ConnectionCounterModel.findOneAndUpdate(filter, { $inc: { count: 1 } }, { new: true }).lean().exec();
  if (updated) return true;
  const existing = await ConnectionCounterModel.findOne({ userId }).lean().exec();
  if (existing) return false;
  const legacyCount = await DBConnectionModel.countDocuments({ userId, isActive: true }).exec();
  if (legacyCount >= limit) return false;
  try {
    await ConnectionCounterModel.create({ userId, count: legacyCount + 1 });
    return true;
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (code !== 11000) throw error;
    const raced = await ConnectionCounterModel.findOneAndUpdate(filter, { $inc: { count: 1 } }, { new: true }).lean().exec();
    return Boolean(raced);
  }
}

export async function releaseConnectionSlot(userId: string): Promise<void> {
  await connectMongoose();
  await ConnectionCounterModel.updateOne({ userId, count: { $gt: 0 } }, { $inc: { count: -1 } }).exec();
}

export async function getUserPlan(userId: string) {
  await connectMongoose();
  const subscription = await SubscriptionModel.findOne({
    userId,
    status: { $in: ["active", "trialing"] },
  }).sort({ updatedAt: -1 }).lean().exec();

  const plan = (subscription?.plan && subscription.plan in PLANS
    ? subscription.plan
    : "free") as PlanId;
  const current = PLANS[plan];
  const { monthStart, monthKey } = getCurrentMonth();

  const [counter, legacyUsed, connectionCounter, legacyConnections] = await Promise.all([
    UsageCounterModel.findOne({ userId, monthKey }).lean().exec(),
    UsageEventModel.countDocuments({
      userId, kind: "query_success", createdAt: { $gte: monthStart },
    }).exec(),
    ConnectionCounterModel.findOne({ userId }).lean().exec(),
    DBConnectionModel.countDocuments({ userId, isActive: true }).exec(),
  ]);
  const used = counter?.count ?? legacyUsed;
  const connections = connectionCounter?.count ?? legacyConnections;

  return {
    plan,
    status: subscription?.status ?? "active",
    used,
    monthlyQueries: current.monthlyQueries,
    remaining: Math.max(0, current.monthlyQueries - used),
    connections: current.connections,
    activeConnections: connections,
  };
}
