import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  AUTH_SECRET: z.string().min(1).optional(),
  AUTH_URL: z.string().url().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  AUTH_EMAIL_SERVER: z.string().optional(),
  AUTH_EMAIL_FROM: z.string().email().optional(),
  MONGODB_URI: z.string().min(1).optional(),
  MONGODB_DATABASE: z.string().min(1).optional(),
  ADMIN_EMAILS: z.string().optional(),
});

export const env = envSchema.parse({
  NODE_ENV: process.env.NODE_ENV,
  AUTH_SECRET: process.env.AUTH_SECRET,
  AUTH_URL: process.env.AUTH_URL,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  AUTH_EMAIL_SERVER: process.env.AUTH_EMAIL_SERVER,
  AUTH_EMAIL_FROM: process.env.AUTH_EMAIL_FROM,
  MONGODB_URI: process.env.MONGODB_URI,
  MONGODB_DATABASE: process.env.MONGODB_DATABASE,
  ADMIN_EMAILS: process.env.ADMIN_EMAILS,
});
