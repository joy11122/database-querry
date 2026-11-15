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
  "$lookup",
]);
const ALLOWED_EXPRESSION_OPERATORS = new Set([
  "$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$and", "$or", "$nor", "$not",
  "$exists", "$type", "$size", "$all", "$elemMatch", "$sum", "$avg", "$min", "$max",
  "$add", "$subtract", "$multiply", "$divide", "$mod", "$abs", "$ceil", "$floor", "$round",
  "$ifNull", "$cond", "$switch", "$concat", "$toString", "$toInt", "$toLong", "$toDouble",
  "$toDecimal", "$toDate", "$arrayElemAt", "$first", "$last", "$size", "$literal",
  "$dateToString", "$year", "$month", "$dayOfMonth", "$hour", "$minute", "$second",
]);
const FORBIDDEN_KEYS = new Set([
  "$out",
  "$merge",
  "$where",
  "$function",
  "$accumulator",
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
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error("Query contains an unsafe object key.");
    }
    if (FORBIDDEN_KEYS.has(key)) throw new Error("Query contains a prohibited operator.");
    if (key.startsWith("$") && !ALLOWED_STAGES.has(key) && !ALLOWED_EXPRESSION_OPERATORS.has(key)) {
      throw new Error("Query contains an unsupported expression operator.");
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

  for (const stage of pipeline) {
    if ("$lookup" in stage) {
      const lookup = stage.$lookup as Record<string, unknown>;
      if (!lookup || typeof lookup.from !== "string" || !schema.tables.some(table => table.name === lookup.from)) {
        throw new Error("Lookup references a collection outside the connected database schema.");
      }
      if (typeof lookup.localField !== "string" || typeof lookup.foreignField !== "string" || typeof lookup.as !== "string") {
        throw new Error("Only equality lookups with known collection names are supported.");
      }
    }
  }

  // Enforce a server-side result cap regardless of any model-provided $limit.
  const cap = Math.max(1, Math.min(Math.floor(maxRows), 500));
  const requestedLimits = pipeline
    .map((stage) => Number(stage.$limit))
    .filter((value) => Number.isFinite(value) && value > 0);
  const effectiveLimit = requestedLimits.length ? Math.min(cap, ...requestedLimits) : cap;
  const cappedPipeline = pipeline.filter((stage) => !("$limit" in stage));
  cappedPipeline.push({ $limit: effectiveLimit });

  return { collection: knownCollection.name, pipeline: cappedPipeline };
}
