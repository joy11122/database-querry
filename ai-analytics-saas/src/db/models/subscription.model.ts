import mongoose, { type InferSchemaType, type Model } from "mongoose";

const subscriptionSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  plan: { type: String, enum: ["free", "pro", "business"], default: "free", index: true },
  status: { type: String, enum: ["active", "trialing", "past_due", "canceled", "incomplete"], default: "active", index: true },
  stripeCustomerId: { type: String },
  stripeSubscriptionId: { type: String },
  currentPeriodEnd: { type: Date },
}, { timestamps: true });

export type Subscription = InferSchemaType<typeof subscriptionSchema>;
export const SubscriptionModel: Model<Subscription> =
  (mongoose.models.Subscription as Model<Subscription> | undefined) ??
  mongoose.model<Subscription>("Subscription", subscriptionSchema);
