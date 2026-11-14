import mongoose, { type InferSchemaType, type Model } from "mongoose";

const usageCounterSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  monthKey: { type: String, required: true },
  count: { type: Number, required: true, min: 0, default: 0 },
}, { timestamps: true });

usageCounterSchema.index({ userId: 1, monthKey: 1 }, { unique: true });

export type UsageCounter = InferSchemaType<typeof usageCounterSchema>;
export const UsageCounterModel: Model<UsageCounter> =
  (mongoose.models.UsageCounter as Model<UsageCounter> | undefined) ??
  mongoose.model<UsageCounter>("UsageCounter", usageCounterSchema);
