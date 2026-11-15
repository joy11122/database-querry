import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { signOut } from "@/lib/auth";
import { DashboardNavbar } from "@/components/dashboard/dashboard-navbar";

export default async function DashboardLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const isAdmin = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .includes((session.user.email ?? "").toLowerCase());

  return (
    <div className="min-h-screen">
      <header className="relative z-40 border-b border-slate-200 bg-white">
        <div className="relative mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:gap-6 lg:py-4">
          <Link href="/dashboard" className="shrink-0 text-base font-bold tracking-tight text-slate-950 sm:text-lg">
            AI Analytics
          </Link>

          <div className="flex min-w-0 items-center gap-2 lg:gap-3">
            <DashboardNavbar isAdmin={isAdmin} />
            <form action={async () => { "use server"; await signOut({ redirectTo: "/login" }); }}>
              <button type="submit" className="min-h-10 whitespace-nowrap rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 sm:text-sm">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
