// The retrieval sandbox: every path the answer agent or a validator turns into a file goes through
// `resolveMemoryFile`, which accepts only the shapes `roze generate` publishes and rejects everything else
// before touching the disk. `listFiles` expands the per-scope globs through the same allowlist, so a scope
// can never widen the sandbox.
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, sep, win32 } from "node:path";

import { RUBRIC_DIRECTORIES, VIEW_GLOBS_BY_SCOPE, type SearchScope } from "../brain/storage.js";

export class MemoryPathError extends Error {
  override readonly name = "MemoryPathError";
}

/** Shape, extension, and depth only; existence and symlinks are checked separately. */
function pathLooksAllowlisted(path: string): boolean {
  if (path.includes("\\") || isAbsolute(path) || win32.isAbsolute(path)) return false;
  const parts = path.split("/");
  const traversalOrHidden = parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."));
  if (traversalOrHidden) return false;
  if (parts.length === 1) return path === "INDEX.md";
  if (![".md", ".txt"].includes(extname(path).toLowerCase())) return false;
  if ([...RUBRIC_DIRECTORIES, "threads"].includes(parts[0]!)) return parts.length === 2;
  return parts[0] === "evidence" && (parts.length === 2 || (parts.length === 3 && parts[1] === "threads"));
}

/** A mistyped raw-thread path is the common miss, so name the two real shapes in the error. */
function hintForMissingFile(path: string): string {
  const looksLikeARawThread = /^evidence\/threads\/(?![0-9a-f]{8,}\.md$)/u.test(path);
  return looksLikeARawThread
    ? " (raw threads are evidence/threads/<16-hex thread id>.md; the per-year lists are evidence/threads-<year>.md)"
    : "";
}

/** Every component is checked before realpath, so no plausible path escapes through a symlink. */
export function resolveMemoryFile(brainDir: string, path: string): string {
  if (!path.trim() || path.includes("\0")) throw new MemoryPathError("path must be a non-empty relative string");
  if (!pathLooksAllowlisted(path)) throw new MemoryPathError(`path is outside the generated memory allowlist: ${path}`);

  let root: string;
  try {
    root = realpathSync(brainDir);
  } catch (error) {
    throw new MemoryPathError(`memory root does not exist: ${brainDir}`, { cause: error });
  }

  let candidate = root;
  for (const part of path.split("/")) {
    candidate = join(candidate, part);
    try {
      if (lstatSync(candidate).isSymbolicLink())
        throw new MemoryPathError(`symlinks are not readable through memory tools: ${path}`);
    } catch (error) {
      if (error instanceof MemoryPathError) throw error;
      throw new MemoryPathError(`memory file does not exist: ${path}${hintForMissingFile(path)}`, { cause: error });
    }
  }

  const resolved = realpathSync(candidate);
  const fromRoot = relative(root, resolved);
  const escapesRoot = !fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`);
  if (escapesRoot || !statSync(resolved).isFile()) throw new MemoryPathError(`memory file does not exist: ${path}`);
  return resolved;
}

function expandPattern(root: string, pattern: string): string[] {
  if (!pattern.includes("*")) return [pattern];
  const slash = pattern.lastIndexOf("/");
  const parent = pattern.slice(0, slash);
  const [prefix, suffix] = pattern.slice(slash + 1).split("*") as [string, string];
  try {
    return readdirSync(join(root, parent))
      .sort()
      .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
      .map((name) => `${parent}/${name}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

export function listFiles(brainDir: string, scope: SearchScope): Array<[string, string]> {
  const root = realpathSync(brainDir);
  const seen = new Set<string>();
  const files: Array<[string, string]> = [];
  for (const pattern of VIEW_GLOBS_BY_SCOPE[scope])
    for (const path of expandPattern(root, pattern)) {
      let resolved: string;
      try {
        resolved = resolveMemoryFile(root, path);
      } catch (error) {
        if (error instanceof MemoryPathError) continue;
        throw error;
      }
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      files.push([path, resolved]);
    }
  return files;
}
