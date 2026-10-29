type UsagePoint = { label: string; count: number };

export function UsageChart({ values }: { values: UsagePoint[] }) {
  const max = Math.max(1, ...values.map((point) => point.count));
  return (
    <div role="img" aria-label="Bar chart showing query activity" className="flex h-40 items-end gap-2">
      {values.map((point, index) => (
        <div key={`${point.label}-${index}`} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-2">
          <span className="text-xs text-slate-500">{point.count || ""}</span>
          <div className="w-full max-w-10 rounded-t-md bg-indigo-500" style={{ height: `${Math.max(4, (point.count / max) * 100)}px` }} title={`${point.label}: ${point.count} queries`} />
          <span className="truncate text-[10px] text-slate-500">{point.label}</span>
        </div>
      ))}
    </div>
  );
}
