import { auth, signOut } from "@/lib/auth";
import { redirect } from "next/navigation";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  return <section className="max-w-3xl space-y-6">
    <div><h1 className="text-3xl font-semibold">Settings</h1><p className="mt-2 text-slate-600">Manage your account and review the workspace security model.</p></div>
    <div className="rounded-2xl border bg-white p-6">
      <h2 className="font-semibold">Account</h2>
      <dl className="mt-4 grid gap-4 sm:grid-cols-2"><div><dt className="text-sm text-slate-500">Name</dt><dd className="mt-1 font-medium">{session.user.name || "Not provided"}</dd></div><div><dt className="text-sm text-slate-500">Email</dt><dd className="mt-1 font-medium">{session.user.email || "Not provided"}</dd></div></dl>
      <form className="mt-6" action={async () => { "use server"; await signOut({ redirectTo: "/login" }); }}><button type="submit" className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-slate-50">Sign out</button></form>
    </div>
    <div className="rounded-2xl border bg-white p-6"><h2 className="font-semibold">Data security</h2><ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-slate-600"><li>Saved database credentials are encrypted with AES-256-GCM.</li><li>Use dedicated read-only accounts with access only to approved reporting tables or collections.</li><li>Application access is scoped to the authenticated account; do not share connection credentials or IDs with other users.</li><li>Rotate credentials immediately if you suspect they have been exposed.</li></ul></div>
  </section>;
}
