"use client";

import { useCallback, useEffect, useState } from "react";
type Connection = { id: string; name: string; databaseType: string; host?: string; database?: string; isActive: boolean; createdAt?: string };
type Field = "name" | "type" | "host" | "port" | "database" | "username" | "password" | "ssl" | "uri";
const initial = { name: "", type: "mongodb", host: "", port: "5432", database: "", username: "", password: "", ssl: true, uri: "" };

export function ConnectionManagerClient({ initialConnections }: { initialConnections: Connection[] }) {
  const [connections, setConnections] = useState(initialConnections);
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const response = await fetch("/api/connections", { cache: "no-store" });
    if (response.ok) { const data = await response.json() as { connections: Connection[] }; setConnections(data.connections); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  function update(field: Field, value: string | boolean) {
    setForm(previous => ({ ...previous, [field]: value, ...(field === "type" ? { port: value === "mysql" ? "3306" : "5432" } : {}) }));
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const payload = form.type === "mongodb" ? { name: form.name, type: form.type, uri: form.uri, database: form.database } : { name: form.name, type: form.type, host: form.host, port: Number(form.port), database: form.database, username: form.username, password: form.password, ssl: form.ssl };
      const response = await fetch("/api/connections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json() as { error?: { message?: string }; tables?: { name: string; columns: string[] }[] };
      if (!response.ok) throw new Error(data.error?.message ?? "Could not save this connection.");
      setNotice(`Connected successfully. ${data.tables?.length ?? 0} tables/collections discovered.`); setForm(initial); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Connection failed."); }
    finally { setBusy(false); }
  }
  async function test(id: string) {
    setBusy(true); setError(""); setNotice("");
    try { const response = await fetch(`/api/connections/${id}`, { method: "POST" }); const data = await response.json() as { error?: { message?: string }; tables?: unknown[] }; if (!response.ok) throw new Error(data.error?.message ?? "Connection test failed."); setNotice(`Connection is healthy. ${data.tables?.length ?? 0} tables/collections available.`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Connection test failed."); } finally { setBusy(false); }
  }
  async function remove(id: string) {
    if (!window.confirm("Delete this saved connection? Credentials will be removed from this app.")) return;
    setBusy(true); setError(""); setNotice("");
    try { const response = await fetch(`/api/connections/${id}`, { method: "DELETE" }); const data = await response.json() as { error?: { message?: string } }; if (!response.ok) throw new Error(data.error?.message ?? "Could not delete connection."); setConnections(items => items.filter(item => item.id !== id)); setNotice("Connection deleted."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Delete failed."); } finally { setBusy(false); }
  }
  const inputClass = "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100";
  return <div className="space-y-6">
    <div className="rounded-2xl border bg-white p-6">
      <h2 className="text-lg font-semibold">Add a database</h2>
      <p className="mt-1 text-sm text-slate-600">Supports MongoDB Atlas, PostgreSQL and MySQL. Use a dedicated read-only database user and allow network access from your deployment.</p>
      {error && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="mt-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{notice}</p>}
      <form onSubmit={submit} className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium">Connection name<input className={inputClass} required maxLength={80} value={form.name} onChange={e => update("name", e.target.value)} placeholder="My Atlas database" /></label>
        <label className="text-sm font-medium">Database type<select className={inputClass} value={form.type} onChange={e => update("type", e.target.value)}><option value="mongodb">MongoDB Atlas</option><option value="postgres">PostgreSQL</option><option value="mysql">MySQL</option></select></label>
        {form.type === "mongodb" ? <>
          <label className="text-sm font-medium sm:col-span-2">MongoDB connection URI<input className={inputClass} type="password" required value={form.uri} onChange={e => update("uri", e.target.value)} placeholder="mongodb+srv://username:password@cluster.example.mongodb.net/" autoComplete="new-password" /><span className="mt-1 block text-xs font-normal text-slate-500">Atlas → Cluster → Connect → Drivers → copy the URI and replace the username/password placeholders. Keep this secret.</span></label>
          <label className="text-sm font-medium sm:col-span-2">Database name<input className={inputClass} required value={form.database} onChange={e => update("database", e.target.value)} placeholder="test" autoComplete="off" /></label>
        </> : <>
          <label className="text-sm font-medium sm:col-span-2">Host<input className={inputClass} required value={form.host} onChange={e => update("host", e.target.value)} placeholder="db.example.com" autoComplete="off" /></label>
          <label className="text-sm font-medium">Port<input className={inputClass} required type="number" min="1" max="65535" value={form.port} onChange={e => update("port", e.target.value)} /></label>
          <label className="text-sm font-medium">Database name<input className={inputClass} required value={form.database} onChange={e => update("database", e.target.value)} autoComplete="off" /></label>
          <label className="text-sm font-medium">Username<input className={inputClass} required value={form.username} onChange={e => update("username", e.target.value)} autoComplete="username" /></label>
          <label className="text-sm font-medium">Password<input className={inputClass} required type="password" value={form.password} onChange={e => update("password", e.target.value)} autoComplete="new-password" /></label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={form.ssl} onChange={e => update("ssl", e.target.checked)} /> Require TLS/SSL (recommended)</label>
        </>}
        <div className="sm:col-span-2"><button disabled={busy} className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Testing connection…" : "Test and save connection"}</button></div>
      </form>
      <p className="mt-4 text-xs leading-5 text-slate-500">Connection secrets are encrypted with AES-256-GCM before storage. Configure CONNECTION_ENCRYPTION_KEY in your deployment. Credentials are never sent back to the browser.</p>
    </div>
    <div className="rounded-2xl border bg-white p-6"><h2 className="text-lg font-semibold">Saved connections ({connections.length})</h2>
      {connections.length === 0 ? <p className="mt-3 text-sm text-slate-600">No connections yet. Add one above to start analyzing your data.</p> : <ul className="mt-3 divide-y">{connections.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-4"><div><p className="font-medium">{item.name}</p><p className="mt-1 text-sm text-slate-500">{item.databaseType} · {item.host} · {item.database}</p></div><div className="flex gap-2"><button type="button" disabled={busy} onClick={() => void test(item.id)} className="rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50">Test</button><button type="button" disabled={busy} onClick={() => void remove(item.id)} className="rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-700 disabled:opacity-50">Delete</button></div></li>)}</ul>}
    </div>
  </div>;
}
