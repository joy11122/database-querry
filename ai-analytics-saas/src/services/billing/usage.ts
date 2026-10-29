import { connectMongoose } from "@/lib/mongoose";
import { SubscriptionModel } from "@/db/models/subscription.model";
import { UsageEventModel } from "@/db/models/usage-event.model";
import { DBConnectionModel } from "@/db/models/db-connection.model";
import { PLANS, type PlanId } from "@/services/billing/plans";

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
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [used, connections] = await Promise.all([
    UsageEventModel.countDocuments({
      userId,
      kind: "query_success",
      createdAt: { $gte: monthStart },
    }).exec(),
    DBConnectionModel.countDocuments({ userId, isActive: true }).exec(),
  ]);

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
