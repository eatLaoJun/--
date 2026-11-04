/**
 * Produce a URL slug for a course title.
 * Current behavior only lowercases and replaces whitespace; punctuation survives.
 */
export function slugify(input) {
  return String(input).trim().toLowerCase().replace(/\s+/g, "-");
}
