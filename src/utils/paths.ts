import { mkdir, readFile, rename, rm, writeFile, appendFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function atomicWrite(file: string, content: string): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "EPERM" || code === "EACCES") {
      await rm(file, { force: true });
      await rename(tmp, file);
    } else {
      await rm(tmp, { force: true });
      throw err;
    }
  }
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, JSON.stringify(value, null, 2) + "\n");
}

export async function appendJsonl(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await appendFile(file, JSON.stringify(value) + "\n", "utf8");
}

export async function readJsonl<T>(file: string): Promise<T[]> {
  try {
    const raw = await readFile(file, "utf8");
    return raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Resolve `candidate` under `root`, rejecting traversal and absolute escapes. */
export function safeJoin(root: string, candidate: string): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error("Path must be a non-empty string");
  }
  const normalizedCandidate = candidate.replaceAll("\\", "/");
  if (path.isAbsolute(candidate)) {
    const resolved = path.resolve(candidate);
    if (!isInside(root, resolved)) throw new Error(`Path escapes workspace: ${candidate}`);
    return resolved;
  }
  const resolved = path.resolve(root, normalizedCandidate);
  if (!isInside(root, resolved)) throw new Error(`Path escapes workspace: ${candidate}`);
  return resolved;
}

export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (rel === "") return true;
  const normalized = process.platform === "win32" ? rel.toLowerCase() : rel;
  return !normalized.startsWith("..") && !path.isAbsolute(rel);
}

export function matchesAnyGlob(relativePath: string, patterns: string[]): boolean {
  const p = relativePath.replaceAll("\\", "/");
  for (const pattern of patterns) {
    if (globToRegExp(pattern).test(p)) return true;
  }
  return false;
}

export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export async function copyDirFiltered(
  source: string,
  dest: string,
  skip: (relative: string) => boolean,
): Promise<void> {
  await ensureDir(dest);
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const rel = entry.name;
    if (skip(rel)) continue;
    const src = path.join(source, entry.name);
    const dst = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirFiltered(src, dst, (child) => skip(path.join(rel, child).replaceAll("\\", "/")));
    } else if (entry.isFile()) {
      const content = await readFile(src);
      if (content.length > 0) await writeFile(dst, content);
    }
  }
}

export async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
