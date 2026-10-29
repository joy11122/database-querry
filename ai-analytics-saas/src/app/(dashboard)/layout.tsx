import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { signOut } from "@/lib/auth";
export default async function DashboardLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  return <div className="min-h-screen">
    <header className="border-b bg-white"><div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
      <Link href="/dashboard" className="font-semibold">AI Analytics</Link>
      <div className="flex items-center gap-4"><nav className="flex flex-wrap gap-4 text-sm text-slate-600"><Link href="/dashboard">Dashboard</Link><Link href="/chat">Chat</Link><Link href="/connections">Connections</Link><Link href="/reports">Reports</Link><Link href="/billing">Billing</Link><Link href="/settings">Settings</Link>{(process.env.ADMIN_EMAILS ?? "").split(",").map((v) => v.trim().toLowerCase()).includes((session.user.email ?? "").toLowerCase()) ? <Link href="/admin">Admin</Link> : null}</nav><form action={async () => { "use server"; await signOut({ redirectTo: "/login" }); }}><button type="submit" className="rounded-lg border px-3 py-2 text-xs font-medium">Sign out</button></form></div>
    </div></header>
    <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
  </div>;
}