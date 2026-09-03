// The one terminal writer. Plain mode is the byte-identical line output this CLI has always produced;
// rich mode routes every write through a single status board.
//
// TERMINAL-OUTPUT INVARIANT — every terminal write in rich mode goes through the status board.
//
// Stages overlap by design: the Gmail-bound participated-thread fetch runs while the model-bound inbox
// skim runs, and later phases extract while other stages are still reporting. So never create a second
// cursor-owning widget while a stage is live. `@clack/prompts` bars are spinners, and its spinner
// redraws by moving the cursor up and erasing *down from wherever the cursor happens to be*, on its own
// 80 ms interval; two of them own the same line. That produced the 2026-09-03 screenshot: one bar drawn,
// `17/344.` and `67/1500.` stacked at its right edge, the second bar's label lost, and a stray cursor
// mid-row.
//
// The rules that keep it fixed:
//   1. createStatusBoard owns a block of terminal lines and is the only thing that moves the cursor. It
//      keeps one row per active stage and repaints the whole block in place.
//   2. Every other line — step, info, warn, error, cost, summary — is handed to the board, which erases
//      the block, writes the line, and repaints below it. Text can never land inside the board.
//   3. clack's intro/outro/spinner are still used for the non-concurrent moments (`auth`), and only when
//      no stage is live and the real process streams are in play. `board.live` is the guard.
//   4. A render never throws: a fault degrades the run to plain newline-terminated lines forever after.
//
// Plain mode (no TTY, `--quiet`, `NO_COLOR`, `ROZE_PLAIN`) is untouched and byte-identical to the output
// this CLI has always produced.

import * as clack from "@clack/prompts";
import pc from "picocolors";

/** Returned by Ui.spinner: a transient status line the caller updates or resolves. */
export interface Spinner {
  message(text: string): void;
  stop(text: string): void;
}

/** Returned by Ui.progress: call with the running completed count for that stage. */
export interface ProgressUpdate {
  (done: number): void;
  /** Retires the bar without filling it: a stage that ended short, or a reporter a new phase replaces. */
  close(): void;
}

/**
 * One facade for all command output. Rich mode serializes every call through the status board; otherwise
 * every call degrades to the plain line the CLI has always printed, so non-TTY runs, `--quiet`, and
 * `NO_COLOR`/`ROZE_PLAIN` stay byte-identical. Channel is fixed per method: `intro`/`outro`/`step`/
 * `spinner` are primary content on stdout, the rest are chrome on stderr.
 */
export interface Ui {
  readonly rich: boolean;
  intro(text: string): void;
  outro(text: string): void;
  step(text: string): void;
  info(text: string): void;
  warn(text: string): void;
  error(text: string): void;
  spinner(label: string): Spinner;
  progress(label: string, total: number): ProgressUpdate;
  cost(line: string): void;
  /** Rich mode prints `compact` and, when something happened, `detail`; plain mode prints `plain`. */
  summary(counters: { compact: string; plain: string; detail?: string }): void;
}

const ANSI = /\u001B\[[0-9;]*m/gu;
const CITATION = /\[t:[0-9a-f]{8,}\s+\d{4}-\d{2}-\d{2}\]/gu;

/** 100 columns when stdout cannot say (a pipe, or a dumb terminal). */
export function terminalWidth(): number {
  return process.stdout.columns && process.stdout.columns > 20 ? process.stdout.columns : 100;
}

function visibleLength(text: string): number {
  return text.replace(ANSI, "").length;
}

/** Code first, so `**` inside a code span stays literal, then citations, bold, italics. */
function inlineStyles(text: string): string {
  return text
    .split(/(`[^`]+`)/u)
    .map((part) =>
      part.length > 1 && part.startsWith("`") && part.endsWith("`")
        ? pc.cyan(part.slice(1, -1))
        : part
            .replace(CITATION, (citation) => pc.dim(citation))
            .replace(/\*\*([^*]+)\*\*/gu, (_, inner: string) => pc.bold(inner))
            .replace(/(?<![\p{L}\p{N}*_])[*_]([^*_\n]+)[*_](?![\p{L}\p{N}*_])/gu, (_, inner: string) => pc.italic(inner)),
    )
    .join("");
}

/** Measures visible width, so ANSI styling never eats into the column budget. */
function wrapStyled(text: string, width: number, firstPrefix: string, restPrefix: string): string[] {
  const words = text.split(/\s+/u).filter(Boolean);
  if (!words.length) return [firstPrefix.trimEnd()];
  const lines: string[] = [];
  let prefix = firstPrefix;
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && visibleLength(prefix) + visibleLength(candidate) > width) {
      lines.push(prefix + line);
      prefix = restPrefix;
      line = word;
    } else line = candidate;
  }
  lines.push(prefix + line);
  return lines;
}

function renderBlockLine(line: string, columns: number): string[] | undefined {
  const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
  if (heading) return wrapStyled(pc.bold(pc.underline(inlineStyles(heading[2]!))), columns, "", "");

  const quote = /^\s*>\s?(.*)$/u.exec(line);
  if (quote) return wrapStyled(pc.dim(inlineStyles(quote[1]!)), columns, pc.dim("│ "), pc.dim("│ "));

  const bullet = /^(\s*)[-*+]\s+(.*)$/u.exec(line);
  if (bullet) {
    const indent = "  ".repeat(Math.floor(bullet[1]!.length / 2));
    return wrapStyled(inlineStyles(bullet[2]!), columns, `${indent}• `, `${indent}  `);
  }

  const numbered = /^(\s*)(\d{1,3})[.)]\s+(.*)$/u.exec(line);
  if (numbered) {
    const indent = "  ".repeat(Math.floor(numbered[1]!.length / 2));
    const marker = `${numbered[2]!}. `;
    return wrapStyled(inlineStyles(numbered[3]!), columns, indent + marker, indent + " ".repeat(marker.length));
  }
  return undefined;
}

/**
 * The Markdown subset the answers actually use, as styled terminal text: prose reflows to `width` and
 * list items wrap with a hanging indent.
 */
export function renderMarkdown(text: string, width: number = terminalWidth()): string {
  const columns = Math.max(40, width);
  const out: string[] = [];
  let fenced = false;
  // Consecutive prose lines are one paragraph, so hard-wrapped source reflows to this width.
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length) out.push(...wrapStyled(inlineStyles(paragraph.join(" ")), columns, "", ""));
    paragraph = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/u, "");
    if (/^\s*(```|~~~)/u.test(line)) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      out.push(pc.dim(`  ${line}`));
      continue;
    }
    if (!line.trim()) {
      flush();
      out.push("");
      continue;
    }
    const block = renderBlockLine(line, columns);
    if (block) {
      flush();
      out.push(...block);
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return out.join("\n");
}

export interface UiOptions {
  /** Primary-channel sink; tests inject this to capture output without a real TTY. */
  write?: (text: string) => void;
  writeError?: (text: string) => void;
  quiet?: boolean;
  /** Forces the rich path without a TTY. Only tests set it, so the status board can be driven offline. */
  rich?: boolean;
  /** Injected with `rich` so the board's throttling and elapsed seconds need no real clock or timers. */
  now?: () => number;
  columns?: number;
}

/** Decided once per invocation: an interactive stderr, not quieted, and no color opt-out. */
export function richOutputEnabled(quiet: boolean): boolean {
  return !quiet && !process.env.NO_COLOR && !process.env.ROZE_PLAIN && Boolean(process.stderr.isTTY);
}

/** Cells in a drawn bar. Both renderers share it so neither can ask for a run of negative width. */
const BAR_SLOTS = 40;
const ROW_LABEL_WIDTH = 12;

/**
 * How many of BAR_SLOTS are filled. Every caller-supplied number is untrusted: a stage may report more
 * than its total (a resumed count, a stale reporter), none at all, or a total of zero, and a bar is
 * decoration — it clamps rather than throws, so `"█".repeat(cells)` and `"░".repeat(slots - cells)` are
 * always valid counts.
 */
export function barCells(completed: number, total: number, slots: number = BAR_SLOTS): number {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return 0;
  const cells = Math.floor((slots * completed) / total);
  return Number.isFinite(cells) ? Math.max(0, Math.min(slots, cells)) : 0;
}

/** True once a stage has reported all its work, which latches the bar so a late update cannot reprint. */
function isComplete(completed: number, total: number): boolean {
  return Number.isFinite(completed) && total > 0 && completed >= total;
}

/** The bar this CLI has always drawn: one row per stage, latched once it fills. */
function plainProgress(label: string, total: number, write: (text: string) => void): ProgressUpdate {
  const started = Date.now();
  let finished = false;
  const update = (completed: number): void => {
    if (finished) return;
    const elapsed = String(Math.round((Date.now() - started) / 1_000)).padStart(5, " ");
    const cells = barCells(completed, total);
    const bar = `${"█".repeat(cells)}${"░".repeat(BAR_SLOTS - cells)}`;
    write(`\r  ${label.padEnd(ROW_LABEL_WIDTH)} ${bar} ${completed}/${total}  ${elapsed}s`);
    if (isComplete(completed, total)) {
      write("\n");
      finished = true;
    }
  };
  update.close = (): void => {
    if (finished) return;
    write("\n");
    finished = true;
  };
  return update;
}

/** Moves up one line and erases it; repeated once per drawn row, it retracts the whole board. */
const RETRACT_ROW = "\u001B[1A\u001B[2K";
/** At most one repaint per this many milliseconds; a stage that finishes repaints regardless. */
const REPAINT_INTERVAL_MS = 80;

/**
 * The one cursor owner in rich mode. It keeps a row per live stage, repaints the block in place, and
 * serializes every other line so text is always inserted *above* the block rather than into it.
 */
export interface StatusBoard {
  /** True while at least one stage owns a row: no other widget may take the cursor. */
  readonly live: boolean;
  /** Writes one finished line above the board through `sink` (stdout or stderr), then repaints. */
  line(text: string, sink: (text: string) => void): void;
  /** Adds a row; the returned updater retires it — filled, or short via `close()`. */
  stage(label: string, total: number): ProgressUpdate;
}

interface BoardRow {
  label: string;
  total: number;
  done: number;
  started: number;
  retired: boolean;
}

export interface StatusBoardOptions {
  /** The terminal sink the board draws into; every cursor movement it makes goes here. */
  write: (text: string) => void;
  /** Injected in tests so throttling and elapsed seconds are deterministic and need no real timers. */
  now?: () => number;
  columns?: () => number;
  repaintIntervalMs?: number;
}

export function createStatusBoard(options: StatusBoardOptions): StatusBoard {
  const now = options.now ?? ((): number => Date.now());
  const columns = options.columns ?? terminalWidth;
  const interval = options.repaintIntervalMs ?? REPAINT_INTERVAL_MS;
  const rows: BoardRow[] = [];
  /** Terminal lines the board currently occupies, and therefore how far up a retraction must reach. */
  let drawn = 0;
  let lastPaint = Number.NEGATIVE_INFINITY;
  /** A render fault (or a sink that rejected a write) drops cursor control for the rest of the run. */
  let degraded = false;
  let dead = false;

  const emit = (text: string): void => {
    if (dead || !text) return;
    try {
      options.write(text);
    } catch {
      dead = true;
    }
  };

  const seconds = (row: BoardRow): number => Math.max(0, Math.round((now() - row.started) / 1_000));

  /** Rows must never wrap: a wrapped row occupies two terminal lines and breaks the retraction count. */
  const paintRow = (row: BoardRow): string => {
    const width = Math.max(20, columns());
    const label = row.label.slice(0, ROW_LABEL_WIDTH).padEnd(ROW_LABEL_WIDTH);
    const counter = `${row.done}/${row.total}`;
    const tail = `  ${seconds(row)}s`;
    const slots = Math.max(4, Math.min(BAR_SLOTS, width - 1 - (4 + label.length + counter.length + tail.length)));
    const cells = barCells(row.done, row.total, slots);
    const filled = "█".repeat(cells);
    const empty = "░".repeat(slots - cells);
    const plain = `  ${label} ${filled}${empty} ${counter}${tail}`;
    if (plain.length > width - 1) return `${plain.slice(0, width - 1)}\n`;
    return `  ${pc.bold(label)} ${pc.cyan(filled)}${pc.dim(empty)} ${counter}${pc.dim(tail)}\n`;
  };

  const retract = (): string => (drawn > 0 ? `\r${RETRACT_ROW.repeat(drawn)}` : "");

  const paint = (force: boolean): void => {
    const at = now();
    if (!force && at - lastPaint < interval) return;
    lastPaint = at;
    try {
      // Degraded: no cursor movement is trusted any more, so rows fall out as plain appended lines.
      if (degraded) {
        emit(rows.map((row) => `${row.label} ${row.done}/${row.total}\n`).join(""));
        return;
      }
      const block = rows.map(paintRow).join("");
      emit(`${retract()}${block}`);
      drawn = rows.length;
    } catch {
      degraded = true;
      drawn = 0;
    }
  };

  const line = (text: string, sink: (text: string) => void): void => {
    try {
      if (!degraded && drawn > 0) {
        emit(retract());
        drawn = 0;
      }
      sink(`${text}\n`);
    } catch {
      degraded = true;
      drawn = 0;
    }
    paint(true);
  };

  const stage = (label: string, total: number): ProgressUpdate => {
    const max = Math.max(1, Number.isFinite(total) ? Math.trunc(total) : 1);
    const row: BoardRow = { label, total: max, done: 0, started: now(), retired: false };
    rows.push(row);
    paint(true);
    /** Exactly one completion line per stage: the row leaves the block, its history stays in scrollback. */
    const retire = (fill: boolean): void => {
      if (row.retired) return;
      row.retired = true;
      if (fill) row.done = row.total;
      const index = rows.indexOf(row);
      if (index >= 0) rows.splice(index, 1);
      line(pc.dim(`  ${row.label} ${row.done}/${row.total} in ${seconds(row)}s`), options.write);
    };
    const update = (completed: number): void => {
      if (row.retired) return;
      if (Number.isFinite(completed)) row.done = Math.max(0, Math.min(row.total, Math.trunc(completed)));
      if (isComplete(row.done, row.total)) retire(true);
      else paint(false);
    };
    update.close = (): void => retire(false);
    return update;
  };

  return {
    get live(): boolean {
      return rows.length > 0;
    },
    line,
    stage,
  };
}

function plainUi(write: (text: string) => void, writeError: (text: string) => void): Ui {
  const line =
    (sink: (text: string) => void) =>
    (text: string): void =>
      sink(`${text}\n`);
  return {
    rich: false,
    intro: line(write),
    outro: line(write),
    step: line(write),
    info: line(writeError),
    warn: line(writeError),
    error: line(writeError),
    spinner: (label) => {
      write(`${label}\n`);
      return { message: line(write), stop: line(write) };
    },
    progress: (label, total) => plainProgress(label, total, writeError),
    cost: line(writeError),
    summary: ({ plain }) => writeError(`${plain}\n`),
  };
}

/**
 * `soloWidget` is rule 3 of the invariant at the top of this file: clack owns the cursor for as long as
 * it draws, so it is used only when nothing else can be — no live stage row, and the real process
 * streams (a caller that injected sinks gets board lines instead).
 */
function richUi(
  board: StatusBoard,
  write: (text: string) => void,
  writeError: (text: string) => void,
  soloWidget: () => boolean,
): Ui {
  return {
    rich: true,
    intro: (text) =>
      soloWidget() ? clack.intro(pc.bold(text), { output: process.stdout }) : board.line(pc.bold(text), write),
    outro: (text) =>
      soloWidget() ? clack.outro(pc.green(text), { output: process.stdout }) : board.line(pc.green(text), write),
    step: (text) => board.line(`${pc.green("◇")}  ${text}`, write),
    info: (text) => board.line(`${pc.cyan("●")}  ${text}`, writeError),
    warn: (text) => board.line(`${pc.yellow("▲")}  ${text}`, writeError),
    error: (text) => board.line(`${pc.red("■")}  ${text}`, writeError),
    spinner: (label) => {
      if (!soloWidget()) {
        board.line(`${pc.cyan("●")}  ${label}`, write);
        return {
          message: (text) => board.line(`${pc.cyan("●")}  ${text}`, write),
          stop: (text) => board.line(`${pc.green("◇")}  ${text}`, write),
        };
      }
      const running = clack.spinner({ output: process.stdout });
      running.start(label);
      return {
        message: (text) => running.message(text),
        stop: (text) => running.stop(text),
      };
    },
    progress: (label, total) => board.stage(label, total),
    cost: (line) => board.line(pc.dim(`  ${line}`), writeError),
    summary: ({ compact, detail }) => {
      board.line(pc.dim(compact), writeError);
      if (detail) board.line(pc.dim(detail), writeError);
    },
  };
}

export function createUi(options: UiOptions = {}): Ui {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const writeError = options.writeError ?? ((text: string) => process.stderr.write(text));
  const rich = options.rich ?? richOutputEnabled(options.quiet ?? false);
  if (!rich) return plainUi(write, writeError);
  // The board draws on the diagnostic channel, which is the stream rich mode was enabled for. It also
  // serializes the primary channel: when stdout is the same terminal, an unserialized write would land
  // inside the block; when stdout is a pipe, the extra repaint is invisible and the pipe is unchanged.
  const board = createStatusBoard({
    write: writeError,
    now: options.now,
    columns: options.columns === undefined ? undefined : () => options.columns!,
  });
  const ownStreams = !options.write && !options.writeError;
  return richUi(board, write, writeError, () => ownStreams && !board.live);
}
