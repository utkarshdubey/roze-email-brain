#!/usr/bin/env node
// Built entry point: `npm run build` compiles src/ into dist/. During development use `npm run roze -- <args>`.
import("../dist/src/cli.js").then((m) => m.main(process.argv.slice(2))).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
