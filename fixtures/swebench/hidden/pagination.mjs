import { totalPages } from "../src/pagination.js";

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (err) {
    results.push({ name, passed: false, error: err.message });
  }
}

check("exact multiple page count", () => {
  if (totalPages(40, 20) !== 2) throw new Error(`40/20 -> ${totalPages(40, 20)}, expected 2`);
  if (totalPages(20, 20) !== 1) throw new Error(`20/20 -> ${totalPages(20, 20)}, expected 1`);
  if (totalPages(60, 15) !== 4) throw new Error(`60/15 -> ${totalPages(60, 15)}, expected 4`);
});

check("non-multiple rounds up", () => {
  if (totalPages(41, 20) !== 3) throw new Error(`41/20 -> ${totalPages(41, 20)}, expected 3`);
  if (totalPages(1, 20) !== 1) throw new Error(`1/20 -> ${totalPages(1, 20)}, expected 1`);
});

check("zero total", () => {
  if (totalPages(0, 20) !== 0) throw new Error(`0/20 -> ${totalPages(0, 20)}, expected 0`);
});

console.log(JSON.stringify({ results }));
process.exit(results.every((r) => r.passed) ? 0 : 1);
