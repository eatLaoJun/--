import { totalPages } from "../src/pagination.js";

const actual = totalPages(40, 20);
if (actual === 3) {
  console.log("REPRODUCED: total=40 pageSize=20 -> 3 pages, expected 2");
  console.log("The third page is empty because floor(total/pageSize)+1 adds a page for an exact multiple.");
  process.exit(0);
}
console.error(`NOT_REPRODUCED: totalPages(40,20) returned ${actual}`);
process.exit(1);
