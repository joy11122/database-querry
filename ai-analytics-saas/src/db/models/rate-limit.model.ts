import mongoose, { type InferSchemaType, type Model } from "mongoose";

const rateLimitSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  count: { type: Number, required: true, min: 0, default: 0 },
  resetAt: { type: Date, required: true },
}, { timestamps: true });

rateLimitSchema.index({ resetAt: 1 }, { expireAfterSeconds: 0 });

export type RateLimit = InferSchemaType<typeof rateLimitSchema>;
export const RateLimitModel: Model<RateLimit> =
  (mongoose.models.RateLimit as Model<RateLimit> | undefined) ??
  mongoose.model<RateLimit>("RateLimit", rateLimitSchema);
