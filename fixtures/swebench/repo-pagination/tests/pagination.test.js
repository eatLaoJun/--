import test from "node:test";
import assert from "node:assert/strict";
import { totalPages, pageSlice } from "../src/pagination.js";

test("exact multiple does not add an empty page", () => {
  assert.equal(totalPages(40, 20), 2);
  assert.equal(totalPages(20, 20), 1);
  assert.equal(totalPages(60, 15), 4);
});

test("non-multiple rounds up", () => {
  assert.equal(totalPages(41, 20), 3);
  assert.equal(totalPages(1, 20), 1);
});

test("empty list has zero pages", () => {
  assert.equal(totalPages(0, 20), 0);
});

test("pageSlice returns the last full page", () => {
  const items = Array.from({ length: 40 }, (_, index) => index + 1);
  assert.deepEqual(pageSlice(items, 2, 20), items.slice(20, 40));
});

test("pageSlice rejects invalid page sizes", () => {
  assert.throws(() => totalPages(10, 0), /pageSize/);
  assert.throws(() => totalPages(-1, 10), /total/);
});
