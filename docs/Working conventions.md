---
title: Working conventions
tags: [conventions]
---
# Working conventions

**Read the vault first**, then [[ARCHITECTURE]] for the file map. Every decision you make goes into a note
here (a new note under `docs/decisions/` for a settled decision; an entry in [[Evaluation]] for a number).

## Hard rules
- **No cheating.** No logic, regex, stopword, threshold, prompt example, or special case that targets one
  inbox, one sender, one vendor, or a benchmark question. Everything must be what a general product for any
  mailbox would contain. `grep -rn -i` over `src/` for inbox names must stay empty. See
  [[No test-specific or inbox-specific rules]].
- **Prompts are frozen inputs.** Prompt text is part of the cache key and a paid input; change a prompt
  only for a reason you can state, and expect the stage to repay (see [[Costs and caching]]).
- **Gates and audits only get stricter or more general**, never weaker to make something pass. Every gate
  increments a named counter in `concepts.json`; every citation is audited before an answer is shown.
- **Rendered bytes are the contract.** The offline validators compare the published brain byte for byte.
- **Meter every model call.** Print the expected cost before a paid stage; the target is cents per brain.
- **Never commit `brain/`, `.env`, `.token.json`, `examples/`.**

## Guards (run after every change)
```bash
npx tsc -p tsconfig.json --noEmit
npm test                          # node:test, injected models, fake fetch; no network
npm run validate                  # citation + concept validators over a real brain (read-only)
```
`ROZE_BRAIN_DIR=<path to a generated brain> npm run validate` when the brain lives elsewhere.

## Style
Readable over short: 120-column prettier-style formatting, one statement per line, names that say what
things are, a one-paragraph header per module, comments only for a *why*. Do not pad and do not pack.
See [[Lines are not the metric]].

## Cost discipline
Extraction repays when its prompt or the rendered thread text changes (≈ $0.35 on the reference mailbox);
tags ≈ $0.03; the cluster judge ≈ $0.6–0.8; the review ≈ $0.15; a `prompt` ≈ 6¢ with gpt-5.4. An unchanged
rebuild costs $0. `bench/rebuildConcepts.ts` rebuilds only the concept layer from caches.
