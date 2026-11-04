import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.js";

test("lowercases and joins words with a dash", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("  Already  Spaced  "), "already-spaced");
});

test("empty input stays empty", () => {
  assert.equal(slugify(""), "");
});
