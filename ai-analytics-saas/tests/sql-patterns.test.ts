import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSqlWords, quoteSqlIdentifier, SQL_INTENT_PATTERNS, unquoteSqlIdentifier } from "../src/lib/sql-patterns";

test("SQL question normalization is deterministic", () => {
  assert.equal(normalizeSqlWords("Total Revenue — FY 2026"), "total revenue fy 2026");
});

test("count intent wins over total/sum intent", () => {
  const question = normalizeSqlWords("total number of customers");
  assert.equal(SQL_INTENT_PATTERNS.count.test(question), true);
  assert.equal(SQL_INTENT_PATTERNS.sum.test(question), true);
});

test("sum intent recognizes total and sum without matching unrelated words", () => {
  assert.equal(SQL_INTENT_PATTERNS.sum.test("sum of revenue"), true);
  assert.equal(SQL_INTENT_PATTERNS.sum.test("total revenue"), true);
  assert.equal(SQL_INTENT_PATTERNS.sum.test("customer list"), false);
});

test("list, availability and limit patterns are bounded", () => {
  assert.equal(SQL_INTENT_PATTERNS.list.test("show customers"), true);
  assert.equal(SQL_INTENT_PATTERNS.availability.test("show active users"), true);
  assert.equal(SQL_INTENT_PATTERNS.limit.exec("show 250 customers")?.[1], "250");
  assert.equal(SQL_INTENT_PATTERNS.limit.test("showcase customers"), false);
});

test("SQL identifier quoting escapes dialect-specific delimiters", () => {
  assert.equal(quoteSqlIdentifier('odd"name', "postgresql"), '"odd""name"');
  assert.equal(quoteSqlIdentifier("odd" + String.fromCharCode(96) + "name", "mysql"), String.fromCharCode(96) + "odd" + String.fromCharCode(96) + String.fromCharCode(96) + "name" + String.fromCharCode(96));
});

test("SQL identifier unquoting handles all supported quoting styles", () => {
  const tick = String.fromCharCode(96);
  assert.equal(unquoteSqlIdentifier('"users"'), "users");
  assert.equal(unquoteSqlIdentifier(tick + "users" + tick), "users");
  assert.equal(unquoteSqlIdentifier("[users]"), "users");
  assert.equal(unquoteSqlIdentifier('"odd""name"'), 'odd"name');
  assert.equal(unquoteSqlIdentifier(tick + "odd" + tick + tick + "name" + tick), "odd" + tick + "name");
  assert.equal(unquoteSqlIdentifier("[odd]]name]"), "odd]name");
});
