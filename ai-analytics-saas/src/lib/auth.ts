import NextAuth from "next-auth";
import type { Provider } from "next-auth/providers";
import Google from "next-auth/providers/google";
import Nodemailer from "next-auth/providers/nodemailer";
import { MongoDBAdapter } from "@auth/mongodb-adapter";
import { env } from "@/config/env";
import { authMongoClientPromise } from "@/lib/mongodb";

const providers: Provider[] = [];

if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    Google({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    }),
  );
}

if (env.AUTH_EMAIL_SERVER && env.AUTH_EMAIL_FROM) {
  providers.push(
    Nodemailer({
      server: env.AUTH_EMAIL_SERVER,
      from: env.AUTH_EMAIL_FROM,
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: MongoDBAdapter(authMongoClientPromise, {
    databaseName: env.MONGODB_DATABASE,
  }),
  providers,
  session: { strategy: "database" },
  pages: { signIn: "/login" },
  trustHost: true,
});
