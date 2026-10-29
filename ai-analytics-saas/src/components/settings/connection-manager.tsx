import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { connectMongoose } from "@/lib/mongoose";
import { DBConnectionModel } from "@/db/models/db-connection.model";
import { ConnectionManagerClient } from "@/components/settings/connection-manager-client";

export async function ConnectionManager() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  await connectMongoose();
  const connections = await DBConnectionModel.find({ userId: session.user.id })
    .select("name databaseType host database isActive createdAt")
    .sort({ createdAt: -1 }).lean().exec();
  const initialConnections = connections.map((connection) => ({
    id: String(connection._id),
    name: connection.name,
    databaseType: connection.databaseType,
    host: connection.host ?? "",
    database: connection.database ?? "",
    isActive: connection.isActive,
    createdAt: connection.createdAt instanceof Date ? connection.createdAt.toISOString() : String(connection.createdAt ?? ""),
  }));
  return <section className="space-y-6">
    <div><p className="text-sm font-semibold uppercase tracking-wider text-indigo-600">Workspace data</p><h1 className="mt-2 text-3xl font-semibold">Database connections</h1><p className="mt-2 text-slate-600">Connections are isolated to your account. Credentials are encrypted at rest.</p></div>
    <ConnectionManagerClient initialConnections={initialConnections} />
  </section>;
}
