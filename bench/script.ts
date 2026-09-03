// The shell every bench script shares: run main only when this file is the entry point, and turn a thrown
// error into one stderr line and a failing exit code.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function runAsScript(importMetaUrl: string, main: () => Promise<void>, label: string): void {
  if (!process.argv[1] || pathToFileURL(resolve(process.argv[1])).href !== importMetaUrl) return;
  main().catch((error: unknown) => {
    process.stderr.write(`${label} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export function writeOut(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
