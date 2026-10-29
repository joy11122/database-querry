import mongoose, { type InferSchemaType, type Model } from "mongoose";

const usageEventSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  kind: { type: String, required: true, index: true },
  createdAt: { type: Date, default: Date.now, index: true },
  durationMs: { type: Number },
  rowCount: { type: Number },
  metadata: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: false });

usageEventSchema.index({ userId: 1, createdAt: -1 });

export type UsageEvent = InferSchemaType<typeof usageEventSchema>;
export const UsageEventModel: Model<UsageEvent> =
  (mongoose.models.UsageEvent as Model<UsageEvent> | undefined) ??
  mongoose.model<UsageEvent>("UsageEvent", usageEventSchema);
