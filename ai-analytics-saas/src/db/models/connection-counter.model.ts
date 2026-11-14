import mongoose, { type InferSchemaType, type Model } from "mongoose";

const connectionCounterSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  count: { type: Number, required: true, min: 0, default: 0 },
}, { timestamps: true });

export type ConnectionCounter = InferSchemaType<typeof connectionCounterSchema>;
export const ConnectionCounterModel: Model<ConnectionCounter> =
  (mongoose.models.ConnectionCounter as Model<ConnectionCounter> | undefined) ??
  mongoose.model<ConnectionCounter>("ConnectionCounter", connectionCounterSchema);
