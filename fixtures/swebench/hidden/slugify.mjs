import { slugify } from "../src/slugify.js";

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (err) {
    results.push({ name, passed: false, error: err.message });
  }
}

check("punctuation removed", () => {
  if (slugify("Hello, World!") !== "hello-world") {
    throw new Error(`"Hello, World!" -> "${slugify("Hello, World!")}", expected "hello-world"`);
  }
});

check("dash runs collapsed", () => {
  if (slugify("A -- B") !== "a-b") {
    throw new Error(`"A -- B" -> "${slugify("A -- B")}", expected "a-b"`);
  }
});

check("basic whitespace behavior preserved", () => {
  if (slugify("Hello World") !== "hello-world") throw new Error("basic whitespace regression");
  if (slugify("") !== "") throw new Error("empty input regression");
});

console.log(JSON.stringify({ results }));
process.exit(results.every((r) => r.passed) ? 0 : 1);
