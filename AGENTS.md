# For agents working on this repository

Start with `docs/Home.md` (an Obsidian vault; open the repository folder in Obsidian, or read the Markdown
directly). It holds the architecture in one page, the settled decisions with their reasons, the evaluation
numbers, the gotchas, and the working conventions. `ARCHITECTURE.md` is the exact file map and contract
reference; `NOTES.md` explains the tradeoffs for a reviewer; `README.md` is how to run it.

Non-negotiables, in short: no inbox-, sender-, vendor-, or benchmark-specific logic; prompts are frozen,
metered inputs; gates and audits only get stricter or more general; rendered bytes are the contract; run
`npx tsc -p tsconfig.json --noEmit && npm test && npm run validate` after every change; never commit
`brain/`, `.env`, `.token.json`. Record every decision as a note under `docs/decisions/`.
