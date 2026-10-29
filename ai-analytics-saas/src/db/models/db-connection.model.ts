import mongoose, { type InferSchemaType, type Model } from "mongoose";

const dbConnectionSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true },
  provider: { type: String, required: true, trim: true },
  databaseType: { type: String, required: true, trim: true },
  encryptedCredentials: { type: String, required: true },
  host: { type: String },
  database: { type: String },
  isActive: { type: Boolean, default: true, index: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: true, minimize: false });

export type DBConnection = InferSchemaType<typeof dbConnectionSchema>;
export const DBConnectionModel: Model<DBConnection> =
  (mongoose.models.DBConnection as Model<DBConnection> | undefined) ??
  mongoose.model<DBConnection>("DBConnection", dbConnectionSchema);
