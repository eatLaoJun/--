/**
 * Pagination helper used by the course list API.
 *
 * Bug: exact multiples of pageSize return one extra empty page.
 * Example: total=40, pageSize=20 -> 3 (expected 2).
 */
export function totalPages(total, pageSize) {
  if (!Number.isInteger(total) || total < 0) {
    throw new TypeError("total must be a non-negative integer");
  }
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new TypeError("pageSize must be a positive integer");
  }
  if (total === 0) return 0;
  return Math.floor(total / pageSize) + 1;
}

export function pageSlice(items, page, pageSize) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  const pages = totalPages(items.length, pageSize);
  if (page < 1 || page > Math.max(1, pages)) return [];
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}
