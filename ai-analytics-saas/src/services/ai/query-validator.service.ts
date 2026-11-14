import type { SchemaMetadata } from "@/types/database";

export interface ValidatedMongoAnalyticsQuery {
  collection: string;
  pipeline: Record<string, unknown>[];
}

const ALLOWED_STAGES = new Set([
  "$match", "$project", "$group", "$sort", "$skip", "$limit", "$count",
  "$unwind", "$addFields", "$set", "$unset",
]);
const ALLOWED_EXPRESSION_OPERATORS = new Set([
  "$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$and", "$or", "$nor", "$not",
  "$exists", "$type", "$size", "$all", "$elemMatch", "$sum", "$avg", "$min", "$max",
  "$add", "$subtract", "$multiply", "$divide", "$mod", "$abs", "$ceil", "$floor", "$round",
  "$ifNull", "$cond", "$switch", "$concat", "$toString", "$toInt", "$toLong", "$toDouble",
  "$toDecimal", "$toDate", "$arrayElemAt", "$first", "$last", "$literal",
  "$dateToString", "$year", "$month", "$dayOfMonth", "$hour", "$minute", "$second",
]);
const FORBIDDEN_KEYS = new Set([
  "$out", "$merge", "$where", "$function", "$accumulator", "$lookup", "$unionWith",
  "$graphLookup", "$changeStream", "$currentOp", "$documents", "$search", "$searchMeta",
  "$vectorSearch", "$regex", "$expr", "$jsonSchema", "$text", "$geoNear", "$near",
]);

function assertSafeValue(value: unknown, knownFields: Set<string>, depth = 0): void {
  if (depth > 20) throw new Error("Query nesting is too deep.");
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new Error("Query array is too large.");
    for (const item of value) assertSafeValue(item, knownFields, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && value.startsWith("$$")) {
      throw new Error("System and user-defined aggregation variables are not allowed.");
    }
    if (typeof value === "string" && value.startsWith("$")) {
      const fieldPath = value.slice(1);
      const root = fieldPath.split(".")[0];
      if (!root || !knownFields.has(root)) throw new Error("Query references a field outside the inspected collection schema.");
    }
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor" || key.includes("\\0")) {
      throw new Error("Query contains an unsafe object key.");
    }
    if (FORBIDDEN_KEYS.has(key)) throw new Error("Query contains a prohibited operator.");
    if (key.startsWith("$")) {
      if (!(depth === 0 && ALLOWED_STAGES.has(key)) && !ALLOWED_EXPRESSION_OPERATORS.has(key)) {
        throw new Error("Query contains an unsupported expression operator.");
      }
    } else if (key.startsWith("$") || key.split(".").some(part => !part || part.startsWith("$"))) {
      throw new Error("Query contains an unsafe field path.");
    }
    assertSafeValue(nested, knownFields, depth + 1);
  }
}

const QUERY_MATCH_OPERATORS = new Set([
  "$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin",
  "$and", "$or", "$nor", "$not", "$exists", "$type", "$size", "$all", "$elemMatch",
]);

function assertMatchShape(value: unknown, knownFields: Set<string>, parentPath = ""): void {
  if (Array.isArray(value)) {
    for (const item of value) assertMatchShape(item, knownFields, parentPath);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith("$")) {
      if (!QUERY_MATCH_OPERATORS.has(key)) throw new Error("Query filter contains an unsupported query operator.");
      assertMatchShape(nested, knownFields, parentPath);
      continue;
    }
    const path = parentPath ? parentPath + "." + key : key;
    if (!knownFields.has(path.split(".")[0])) throw new Error("Query filter references a field outside the inspected collection schema.");
    assertMatchShape(nested, knownFields, path);
  }
}

function assertStageShape(stage: Record<string, unknown>): void {
  const [operator, value] = Object.entries(stage)[0] ?? [];
  if (!operator) throw new Error("Aggregation stage is empty.");
  if (["$match", "$project", "$group", "$sort", "$addFields", "$set"].includes(operator)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Aggregation stage requires an object argument.");
    }
  }
  if (operator === "$group" && !Object.prototype.hasOwnProperty.call(value, "_id")) {
    throw new Error("$group must define an _id grouping expression.");
  }
  if (operator === "$sort") {
    for (const direction of Object.values(value as Record<string, unknown>)) {
      if (direction !== 1 && direction !== -1) throw new Error("$sort directions must be 1 or -1.");
    }
  }
  if (operator === "$limit" && (!Number.isSafeInteger(value) || Number(value) < 1)) {
    throw new Error("$limit must be a positive integer.");
  }
  if (operator === "$skip" && (!Number.isSafeInteger(value) || Number(value) < 0)) {
    throw new Error("$skip must be a non-negative integer.");
  }
  if (operator === "$count" && (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))) {
    throw new Error("$count requires a valid output field name.");
  }
  if (operator === "$unwind" && !(typeof value === "string" || (value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).path === "string"))) {
    throw new Error("$unwind requires a field path.");
  }
  if (operator === "$unset" && !(typeof value === "string" || (Array.isArray(value) && value.every(item => typeof item === "string")))) {
    throw new Error("$unset requires a field name or array of field names.");
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
  if (Object.keys(candidate).some(key => key !== "collection" && key !== "pipeline")) {
    throw new Error("Query contains unsupported top-level properties.");
  }

  const knownCollection = schema.tables.find(table => table.name === candidate.collection);
  if (!knownCollection) throw new Error("Query references an unknown collection.");
  if (candidate.pipeline.length > 20) throw new Error("Query has too many pipeline stages.");

  const knownFields = new Set(knownCollection.columns.map(column => column.name.split(".")[0]));
  knownFields.add("_id");
  const pipeline: Record<string, unknown>[] = candidate.pipeline.map(stage => {
    if (!stage || typeof stage !== "object" || Array.isArray(stage)) {
      throw new Error("Each pipeline stage must be an object.");
    }
    const entries = Object.entries(stage as Record<string, unknown>);
    if (entries.length !== 1 || !ALLOWED_STAGES.has(entries[0][0])) {
      throw new Error("Query contains an unsupported aggregation stage.");
    }
    assertStageShape(stage as Record<string, unknown>);
    assertSafeValue(stage, knownFields);
    if (entries[0][0] === "$match") assertMatchShape(entries[0][1], knownFields);
    if (entries[0][0] === "$sort") {
      for (const field of Object.keys(entries[0][1] as Record<string, unknown>)) {
        if (!knownFields.has(field.split(".")[0])) throw new Error("$sort references an unknown schema field.");
      }
    }
    if (entries[0][0] === "$project") {
      for (const [field, projection] of Object.entries(entries[0][1] as Record<string, unknown>)) {
        if ((projection === 0 || projection === 1) && !knownFields.has(field.split(".")[0])) {
          throw new Error("$project references an unknown schema field.");
        }
      }
    }
    if (entries[0][0] === "$unset") {
      const fields = typeof entries[0][1] === "string" ? [entries[0][1]] : entries[0][1] as string[];
      if (fields.some(field => !knownFields.has(field.split(".")[0]))) throw new Error("$unset references an unknown schema field.");
    }
    return stage as Record<string, unknown>;
  });

  const cap = Math.max(1, Math.min(Math.floor(maxRows), 500));
  const requestedLimits = pipeline
    .map(stage => Number(stage.$limit))
    .filter(value => Number.isFinite(value) && value > 0);
  const effectiveLimit = requestedLimits.length ? Math.min(cap, ...requestedLimits) : cap;
  const cappedPipeline = pipeline.filter(stage => !("$limit" in stage));
  cappedPipeline.push({ $limit: effectiveLimit });

  return { collection: knownCollection.name, pipeline: cappedPipeline };
}
