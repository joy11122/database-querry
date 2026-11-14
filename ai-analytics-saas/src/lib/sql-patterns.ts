export const SQL_INTENT_PATTERNS = {
  count: /\\b(how many|count|number of|total number of)\\b/,
  sum: /\\b(total|sum)\\b/,
  list: /\\b(show|list|get|find|display|fetch|what are|which)\\b/,
  availability: /\\b(available|availability|active|enabled|in stock)\\b/,
  limit: /\\b(?:top|first|last|show|list|get)\\s+(\\d{1,3})\\b/,
} as const;

export function normalizeSqlWords(question: string): string {
  return question.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function unquoteSqlIdentifier(value: string): string {
  return value.replace(/^[`"\\[]/, "").replace(/[`"\\]]$/, "")
    .replace(/""/g, '"').replace(/``/g, "`").replace(/\\]\\]/g, "]");
}

export function quoteSqlIdentifier(identifier: string, dialect: "postgresql" | "mysql"): string {
  return dialect === "mysql"
    ? "`" + identifier.replace(/`/g, "``") + "`"
    : "\"" + identifier.replace(/"/g, "\"\"") + "\"";
}
