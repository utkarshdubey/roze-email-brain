# roze

A CLI that turns one Gmail account into a local, readable memory and answers questions from it.
The memory is a folder of Markdown. Every answer cites the thread and day it came from.

```text
roze auth              sign in to Gmail (read-only scope)
roze generate          build brain/ from the mailbox
roze prompt <query>    answer one question from brain/
```

## Setup

You need Node.js 20 or newer and an OpenAI API key.

```bash
git clone https://github.com/utkarshdubey/roze-email-brain
cd roze-email-brain
npm install
cp .env.example .env
```

Put your `OPENAI_API_KEY` in `.env`. That is all: the Google OAuth client and the small proxy that
holds its secret are baked in, so sign-in works without any Google credentials of your own (set
`GOOGLE_CLIENT_SECRET` in `.env` to use your own client instead). The Gmail account you sign in
with must be a test user on the OAuth project; agent@roze.ai already is.

## Run

```bash
npm run roze -- auth
```

Opens Google sign-in in the browser and saves a token to `.token.json`. Read-only scope. Tokens for a
Testing-mode project expire after seven days; run `auth` again if `generate` asks you to.

```bash
npm run roze -- generate
```

**Expect this to run for about twenty minutes on a mid-size mailbox.** The limit is Gmail's per-user
read quota, not the models. The brain publishes after each phase, so about two and a half minutes
in you can already ask questions from a second terminal while it keeps going. It prints the expected
model cost before every paid stage; a full build of a 20,000-thread mailbox costs about $1.40, and
rerunning it unchanged costs $0. Pass `--budget 2.00` to stop before any stage that would exceed
that.

```bash
npm run roze -- prompt "What projects am I currently driving, and where does each one stand?"
npm run roze -- prompt "Who do I email most about work this year, and what did we last discuss?"
npm run roze -- prompt "How much have I spent on food delivery this year, and on which service?"
```

Each answer takes 30 to 60 seconds and about ten cents, and shows the searches and reads it made
before answering. Every claim ends in `[t:<thread> <day>]`; the thread is in
`brain/evidence/threads/<thread>.md`.

## What is in brain/

```text
brain/
  people/  organizations/     one profile per person or organization, dated and cited
  projects/  interests/       one file per project or interest, with its evidence
  open_loops/INDEX.md         unresolved commitments, newest first
  threads/                    one summary line per thread, by year
  evidence/threads/<id>.md    the raw messages; the only authority
  evidence/transactions-*.md  typed receipt rows (merchant, kind, amount)
  concepts/TRACE.md           what happened to every project and interest proposal
  INDEX.md  meta.json         navigation and build status
```

Open the folder and read it. Nothing needs a server or a client.

## Verify

```bash
npm run typecheck
npm test            # 100 offline tests, no network
npm run validate    # checks every citation in brain/ against its raw message
```

## Options you may want

- `generate --recent 6` reads six months of inbox instead of 24 (mail you replied to or starred is
  always read in full, for all time).
- `generate --publish-once` publishes only at the end, useful when rebuilding over a brain you are
  still using.
- `prompt --quiet` prints only the answer.
- `ROZE_BRAIN_DIR=path` uses a different brain folder for either command.

## Read more

[ARCHITECTURE.md](ARCHITECTURE.md) is the file map and contracts. [NOTES.md](NOTES.md) explains the
design choices. `docs/` is an Obsidian vault with every settled decision, the evaluation numbers, and
the gotchas. `bench/` holds the evaluation harness; its scripts are explicit about which ones call a
model.
