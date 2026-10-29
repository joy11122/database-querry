"use client";

import { useEffect, useState } from "react";

type Connection = { id: string; name: string; databaseType: string; isActive: boolean };
type Result = { summary: string; sql: string; columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; remaining: number };

export function ChatShell() {
  const [question, setQuestion] = useState("");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  useEffect(() => {
    let active = true;
    fetch("/api/connections", { cache: "no-store" }).then(async response => {
      if (!response.ok) return;
      const data = await response.json() as { connections: Connection[] };
      if (active) {
        const available = data.connections.filter(item => item.isActive);
        setConnections(available);
        setConnectionId(previous => previous || available[0]?.id || "");
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  async function ask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!question.trim() || !connectionId || loading) return;
    setLoading(true); setError(""); setResult(null);
    try {
      const response = await fetch("/api/analytics/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, connectionId }) });
      const data = await response.json() as Result & { error?: { message?: string } };
      if (!response.ok) throw new Error(data.error?.message ?? "Could not run this question.");
      setResult(data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Query failed."); }
    finally { setLoading(false); }
  }

  return <section className="mx-auto flex min-h-[60vh] max-w-5xl flex-col">
    <div><p className="text-sm font-semibold uppercase tracking-wider text-indigo-600">AI analytics</p><h1 className="mt-2 text-3xl font-semibold">Ask your data</h1><p className="mt-2 text-slate-600">Ask a business question in plain English. Queries are restricted to read-only SELECT statements.</p></div>
    <form onSubmit={ask} className="mt-8 rounded-2xl border bg-white p-5 shadow-sm">
      <label htmlFor="analytics-connection" className="text-sm font-medium">Database connection</label>
      <select id="analytics-connection" value={connectionId} onChange={event => setConnectionId(event.target.value)} className="mt-2 w-full rounded-xl border px-3 py-2.5 text-sm" required disabled={!connections.length}>
        {connections.length ? connections.map(item => <option key={item.id} value={item.id}>{item.name} ({item.databaseType})</option>) : <option value="">No active connections — add one in Connections</option>}
      </select>
      <label htmlFor="analytics-question" className="mt-4 block text-sm font-medium">Your question</label>
      <textarea id="analytics-question" value={question} onChange={event => setQuestion(event.target.value)} rows={3} maxLength={2000} placeholder="e.g. Show monthly revenue by region" className="mt-2 w-full resize-y rounded-xl border px-3 py-3 text-sm outline-none focus:ring-2 focus:ring-indigo-500" required />
      {error && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <button type="submit" disabled={!question.trim() || !connectionId || loading} className="mt-4 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{loading ? "Analyzing…" : "Ask AI"}</button>
    </form>
    {!connections.length && <p className="mt-4 text-sm text-slate-600">First, <a className="font-semibold text-indigo-600 underline" href="/connections">connect PostgreSQL or MySQL</a>. Configure OPENAI_API_KEY and CONNECTION_ENCRYPTION_KEY in the deployment environment.</p>}
    {result && <section aria-live="polite" className="mt-6 space-y-4 rounded-2xl border bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">Results</h2><span className="text-sm text-slate-500">{result.rowCount} rows · {result.remaining} questions remaining</span></div>
      <p className="text-sm text-slate-700">{result.summary}</p>
      <details><summary className="cursor-pointer text-sm font-medium text-indigo-700">View generated SQL</summary><pre className="mt-2 overflow-x-auto rounded-lg bg-slate-950 p-4 text-xs text-slate-100">{result.sql}</pre></details>
      {result.truncated && <p className="text-xs text-amber-700">Showing up to 100 rows. Refine your question for a smaller result.</p>}
      <div className="overflow-x-auto"><table className="min-w-full border-collapse text-left text-sm"><thead><tr>{result.columns.map(column => <th key={column} className="border-b px-3 py-2 font-semibold">{column}</th>)}</tr></thead><tbody>{result.rows.map((row, index) => <tr key={index} className="odd:bg-slate-50">{result.columns.map(column => <td key={column} className="max-w-xs border-b px-3 py-2 align-top">{row[column] == null ? "—" : typeof row[column] === "object" ? JSON.stringify(row[column]) : String(row[column])}</td>)}</tr>)}</tbody></table></div>
    </section>}
  </section>;
}
