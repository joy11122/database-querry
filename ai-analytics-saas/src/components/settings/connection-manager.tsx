import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { connectMongoose } from "@/lib/mongoose";
import { DBConnectionModel } from "@/db/models/db-connection.model";

export async function ConnectionManager() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  await connectMongoose();
  const connections = await DBConnectionModel.find({ userId: session.user.id })
    .select("name databaseType isActive createdAt")
    .sort({ createdAt: -1 })
    .lean()
    .exec();

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm font-semibold uppercase tracking-wider text-indigo-600">Workspace data</p>
        <h1 className="mt-2 text-3xl font-semibold">Database connections</h1>
        <p className="mt-2 text-slate-600">Connections are isolated to your account.</p>
      </div>
      <div className="rounded-2xl border bg-white p-6">
        {connections.length ? (
          <ul className="divide-y">
            {connections.map((connection) => (
              <li key={String(connection._id)} className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-0 last:pb-0">
                <div><p className="font-medium">{connection.name}</p><p className="mt-1 text-sm text-slate-500">{connection.databaseType}</p></div>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs">{connection.isActive ? "Active" : "Inactive"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div><h2 className="font-semibold">No connections yet</h2><p className="mt-2 text-sm text-slate-600">Connection creation is not enabled in this build. Do not store database credentials until encryption and connection testing are configured.</p></div>
        )}
      </div>
    </section>
  );
}
