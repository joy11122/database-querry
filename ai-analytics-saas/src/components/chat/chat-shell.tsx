"use client";

import { useState } from "react";

export function ChatShell() {
  const [question, setQuestion] = useState("");
  return (
    <section className="mx-auto flex min-h-[60vh] max-w-4xl flex-col">
      <div>
        <p className="text-sm font-semibold uppercase tracking-wider text-indigo-600">AI analytics</p>
        <h1 className="mt-2 text-3xl font-semibold">Ask your data</h1>
        <p className="mt-2 text-slate-600">Connect a database before running an analytics query.</p>
      </div>
      <div className="mt-8 rounded-2xl border bg-white p-5">
        <label htmlFor="analytics-question" className="text-sm font-medium">Your question</label>
        <textarea
          id="analytics-question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="e.g. Show monthly revenue by region"
          className="mt-2 w-full resize-y rounded-xl border px-3 py-3 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <p className="mt-2 text-xs text-slate-500">Query execution is unavailable until a database connection and query API are configured.</p>
        <button type="button" disabled={!question.trim()} className="mt-4 rounded-lg bg-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-600 disabled:cursor-not-allowed">
          Ask AI (not configured)
        </button>
      </div>
    </section>
  );
}
