import { signIn } from "@/lib/auth";
import { env } from "@/config/env";
export default function LoginPage() {
  return <main className="flex min-h-screen items-center justify-center px-6">
    <section className="w-full max-w-md rounded-2xl border bg-white p-8 shadow-sm">
      <h1 className="text-2xl font-semibold">Welcome back</h1>
      <p className="mt-2 text-sm text-slate-600">Sign in to your AI Analytics workspace.</p>
      {env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? <form className="mt-8" action={async () => { "use server"; await signIn("google", { redirectTo: "/dashboard" }); }}>
        <button type="submit" className="w-full rounded-lg border px-4 py-3 text-sm font-medium hover:bg-slate-50">Continue with Google</button>
      </form> : null}
      {env.AUTH_EMAIL_SERVER ? <form className="mt-3" action={async (formData: FormData) => { "use server"; const email = String(formData.get("email") ?? ""); await signIn("nodemailer", { email, redirectTo: "/dashboard" }); }}>
        <label htmlFor="email" className="text-sm font-medium">Email magic link</label>
        <input id="email" name="email" type="email" required className="mt-2 w-full rounded-lg border px-3 py-2" placeholder="you@company.com" />
        <button type="submit" className="mt-3 w-full rounded-lg bg-slate-900 px-4 py-3 text-sm font-medium text-white">Send sign-in link</button>
      </form> : null}
      {!env.AUTH_EMAIL_SERVER && !(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) ? <p role="alert" className="mt-5 text-sm text-red-700">Sign-in is not configured. Set Google OAuth or email provider environment variables.</p> : null}
    </section>
  </main>;
}