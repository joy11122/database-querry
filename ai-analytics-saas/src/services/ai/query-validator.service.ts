import type { SchemaMetadata } from "@/types/database";

export interface ValidatedMongoAnalyticsQuery {
  collection: string;
  pipeline: Record<string, unknown>[];
}

const ALLOWED_STAGES = new Set([
  "$match",
  "$project",
  "$group",
  "$sort",
  "$skip",
  "$limit",
  "$count",
  "$unwind",
  "$addFields",
  "$set",
  "$unset",
]);
const FORBIDDEN_KEYS = new Set([
  "$out",
  "$merge",
  "$where",
  "$function",
  "$accumulator",
  "$lookup",
  "$unionWith",
  "$graphLookup",
  "$changeStream",
  "$currentOp",
  "$documents",
  "$search",
  "$searchMeta",
  "$vectorSearch",
]);

function assertSafeValue(value: unknown, depth = 0): void {
  if (depth > 20) throw new Error("Query nesting is too deep.");
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new Error("Query array is too large.");
    for (const item of value) assertSafeValue(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error("Query contains a prohibited operator.");
    if (key === "$expr" || key === "$jsonSchema" || key === "$where") {
      throw new Error("Query contains a prohibited expression.");
    }
    assertSafeValue(nested, depth + 1);
  }
}

export function validateMongoAnalyticsQuery(
  rawQuery: string,
  schema: SchemaMetadata,
  maxRows = 500,
): ValidatedMongoAnalyticsQuery {
  if (typeof rawQuery !== "string" || rawQuery.length === 0 || rawQuery.length > 50_000) {
    throw new Error("Query must be a non-empty JSON string under 50 KB.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawQuery);
  } catch {
    throw new Error("Query must be valid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Query must be a JSON object.");
  }

  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.collection !== "string" || !Array.isArray(candidate.pipeline)) {
    throw new Error("Query must include a collection and pipeline.");
  }

  const knownCollection = schema.tables.find((table) => table.name === candidate.collection);
  if (!knownCollection) throw new Error("Query references an unknown collection.");
  if (candidate.pipeline.length > 20) throw new Error("Query has too many pipeline stages.");

  const pipeline: Record<string, unknown>[] = candidate.pipeline.map((stage) => {
    if (!stage || typeof stage !== "object" || Array.isArray(stage)) {
      throw new Error("Each pipeline stage must be an object.");
    }
    const entries = Object.entries(stage as Record<string, unknown>);
    if (entries.length !== 1 || !ALLOWED_STAGES.has(entries[0][0])) {
      throw new Error("Query contains an unsupported aggregation stage.");
    }
    assertSafeValue(stage);
    return stage as Record<string, unknown>;
  });

  // Enforce a server-side result cap regardless of any model-provided $limit.
  const cap = Math.max(1, Math.min(Math.floor(maxRows), 500));
  const cappedPipeline = pipeline.filter((stage) => !("$limit" in stage));
  cappedPipeline.push({ $limit: cap });

  return { collection: knownCollection.name, pipeline: cappedPipeline };
}
