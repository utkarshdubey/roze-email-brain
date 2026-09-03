// Two regressions live here.
//
// The Windows crash of 2026-09-03: three phases reported to one "extracting" bar and every progress
// callback threw `RangeError: Invalid count value: -107`, aborting a paid extraction stage that had
// already succeeded.
//
// The corrupted phase 1 of 2026-09-03: the participated-thread fetch and the fast inbox skim overlap by
// design, and each drew its own `@clack/prompts` bar. Both are spinners that redraw by moving the cursor
// up and erasing down from wherever it stands, so they fought over one line — one bar with "17/344." and
// "67/1500." stacked at its right edge, and the second bar's label lost. One status board now owns the
// block, and these tests hold it to that.
import assert from "node:assert/strict";
import test from "node:test";

import { createPipelineLog, mapAtLimitedConcurrency } from "../src/context.js";
import { barCells, createStatusBoard, createUi, type ProgressUpdate, type Ui } from "../src/tui.js";

/** A Ui whose progress bars are recorded; everything else is a sink. */
function recordingUi(progress: Ui["progress"]): { ui: Ui; lines: string[] } {
  const lines: string[] = [];
  const ui: Ui = {
    rich: true,
    intro: (text) => lines.push(text),
    outro: (text) => lines.push(text),
    step: (text) => lines.push(text),
    info: (text) => lines.push(text),
    warn: (text) => lines.push(text),
    error: (text) => lines.push(text),
    spinner: () => ({ message: () => undefined, stop: () => undefined }),
    progress,
    cost: (line) => lines.push(line),
    summary: ({ plain }) => lines.push(plain),
  };
  return { ui, lines };
}

const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/gu;
/** The board's retraction: a carriage return, then one cursor-up + erase-line per drawn row. */
const RETRACTION = /\r(?:\u001B\[1A\u001B\[2K)+/u;

/**
 * A rich Ui writing into one buffer, so the assertions read exactly what a terminal would receive, in
 * order, from both channels. The clock is a counter the test advances: no real timers anywhere.
 */
function fakeTerminal(columns = 100): {
  ui: Ui;
  tick(milliseconds: number): void;
  output(): string;
} {
  const chunks: string[] = [];
  let clock = 0;
  const sink = (text: string): void => {
    chunks.push(text);
  };
  return {
    ui: createUi({ rich: true, columns, now: () => clock, write: sink, writeError: sink }),
    tick: (milliseconds) => {
      clock += milliseconds;
    },
    output: () => chunks.join(""),
  };
}

/** What a terminal would end up showing, with the cursor control stripped out. */
function visibleLines(output: string): string[] {
  return output.replace(ANSI, "").split("\n");
}

/** One repaint's worth of output: everything written between two retractions of the block. */
function frames(output: string): string[][] {
  return output
    .split(RETRACTION)
    .map((frame) => frame.replace(ANSI, "").split("\n").filter((line) => line.trim().length > 0))
    .filter((frame) => frame.length > 0);
}

const isBarRow = (line: string): boolean => /[█░]/u.test(line);
const rowLabel = (line: string): string => line.trim().split(/\s+/u)[0] ?? "";

/** The tester's build: 54 threads read in full, then 199 promoted, then 225 more, all under "extracting". */
const PHASES: ReadonlyArray<readonly [string, number]> = [
  ["full-read", 54],
  ["fast-inbox", 199],
  ["complete-inbox", 225],
];

test("a stage name repeated by a later phase gets its own bar instead of the previous phase's geometry", () => {
  const created: Array<{ label: string; total: number }> = [];
  const updates: Array<{ total: number; done: number }> = [];
  const { ui } = recordingUi((label, total) => {
    created.push({ label, total });
    const update: ProgressUpdate = (done) => updates.push({ total, done });
    update.close = () => undefined;
    return update;
  });
  const log = createPipelineLog(ui);

  for (const [, total] of PHASES) {
    for (let done = 1; done <= total; done += 1) log("extracting", done, total);
  }

  assert.deepEqual(
    created,
    PHASES.map(([, total]) => ({ label: "extracting", total })),
    "each phase extracts a different set, so each phase draws its own bar",
  );
  for (const { total, done } of updates) {
    assert.ok(done >= 0 && done <= total, `a bar was fed ${done} of ${total}`);
  }
});

test("three phases of extraction never wind a progress row past either end of its track", () => {
  const terminal = fakeTerminal();
  const log = createPipelineLog(terminal.ui);

  // Before the fix this threw RangeError: Invalid count value: -107, then -253, -398, -543, -686 — one per
  // extraction in the third phase, because the bar built for phase one's 54 threads was advanced by 1 - 199.
  assert.doesNotThrow(() => {
    for (const [, total] of PHASES) {
      for (let done = 1; done <= total; done += 1) {
        terminal.tick(50);
        log("extracting", done, total);
      }
    }
  });
  const lines = visibleLines(terminal.output());
  const bars = lines.filter(isBarRow).map((line) => /[█░]+/u.exec(line)?.[0] ?? "");
  assert.ok(bars.length > 0, "the board was actually drawn");
  for (const bar of bars) assert.equal(bar.length, 40, `a row drew ${bar.length} cells`);
  assert.equal(
    lines.filter((line) => /extracting \d+\/\d+ in \d+s/u.test(line)).length,
    PHASES.length,
    "each phase's row retires with exactly one completion line",
  );
});

test("a progress bar that throws is dropped, never failing the paid stage that reported to it", async () => {
  const { ui } = recordingUi(() => {
    const update: ProgressUpdate = () => {
      throw new RangeError("Invalid count value: -107");
    };
    update.close = () => undefined;
    return update;
  });
  const log = createPipelineLog(ui);
  const items = Array.from({ length: 8 }, (_unused, index) => index);

  const results = await mapAtLimitedConcurrency(
    items,
    4,
    async (item) => item * 2,
    (done) => log("extracting", done, items.length),
  );

  assert.deepEqual(results, items.map((item) => item * 2), "every unit of work still returns its result");
});

test("bar geometry survives a count past its total, a zero total, and a count that is not a number", () => {
  const written: string[] = [];
  const ui = createUi({ writeError: (text) => written.push(text) });
  assert.equal(ui.rich, false, "a test run has no TTY, so this is the plain bar");

  const update = ui.progress("extracting", 199);
  assert.doesNotThrow(() => {
    update(-107);
    update(0);
    update(500);
  });
  const drawn = written.filter((line) => line.includes("extracting"));
  assert.equal(drawn.length, 3, "every update draws its row");
  for (const line of drawn) {
    const bar = /[█░]+/u.exec(line)?.[0] ?? "";
    assert.equal(bar.length, 40, `bar was ${bar.length} cells wide: ${JSON.stringify(line)}`);
  }

  assert.doesNotThrow(() => {
    const zero = ui.progress("empty", 0);
    zero(0);
    zero(3);
    zero.close();
  });
  assert.equal(barCells(Number.NaN, 199), 0);
  assert.equal(barCells(199, 0), 0);
  assert.equal(barCells(-107, 199), 0);
  assert.equal(barCells(500, 199), 40);
});

test("two overlapping stages share one board: a row each, no orphaned counters, text above the block", () => {
  const terminal = fakeTerminal();
  const threads = terminal.ui.progress("threads", 344);
  const skim = terminal.ui.progress("skim", 1500);
  const notice = "promotion decided for 41 senders";

  // Phase 1 exactly as the tester saw it: a Gmail-bound thread fetch interleaved with a model-bound skim.
  for (let done = 1; done <= 344; done += 1) {
    terminal.tick(25);
    threads(done);
    terminal.tick(25);
    skim(done * 4);
    if (done === 170) terminal.ui.info(notice);
  }
  skim(1500);

  const output = terminal.output();
  const lines = visibleLines(output);

  // (a) One row per active stage in every repaint, and never two rows for the same stage.
  let sawBothStages = false;
  for (const frame of frames(output)) {
    const labels = frame.filter(isBarRow).map(rowLabel);
    assert.deepEqual([...new Set(labels)], labels, `a repaint drew two rows for one stage: ${JSON.stringify(frame)}`);
    for (const label of labels) assert.ok(["threads", "skim"].includes(label), `unknown row label: ${label}`);
    assert.ok(labels.length <= 2, `a repaint drew ${labels.length} rows for at most 2 live stages`);
    if (labels.length === 2) sawBothStages = true;
  }
  assert.ok(sawBothStages, "both stages were live at once, so a repaint drew both rows");

  // (b) Every counter sits on a row that names its own stage, and no row carries a second stage's counter.
  for (const line of lines) {
    const counters = line.match(/\d+\/\d+/gu) ?? [];
    if (!counters.length) continue;
    assert.equal(counters.length, 1, `two counters stacked on one row: ${JSON.stringify(line)}`);
    assert.match(line, /^\s*(threads|skim)\b/u, `a counter was drawn without its label: ${JSON.stringify(line)}`);
  }

  // (c) The mid-run info line is inserted above the block, with the repainted rows below it.
  const noticeAt = lines.findIndex((line) => line.includes(notice));
  assert.ok(noticeAt >= 0, "the info line was printed on a line of its own");
  assert.ok(!isBarRow(lines[noticeAt] ?? ""), "the info line never lands on a row of the block");
  assert.ok(
    lines.slice(noticeAt + 1).some(isBarRow),
    "the board was repainted below the info line, so no row was overwritten by it",
  );

  // (d) Each stage retires with exactly one completion line.
  for (const finished of ["threads 344/344 in", "skim 1500/1500 in"]) {
    assert.equal(lines.filter((line) => line.includes(finished)).length, 1, `"${finished}" printed more than once`);
  }
});

test("a render fault drops the cursor and finishes the run as plain lines instead of throwing", () => {
  const chunks: string[] = [];
  let clock = 0;
  let measurements = 0;
  const board = createStatusBoard({
    write: (text) => chunks.push(text),
    now: () => (clock += 100),
    // The third measurement fails, standing in for any render fault while a paid stage reports to it.
    columns: () => {
      measurements += 1;
      if (measurements > 2) throw new Error("the terminal went away");
      return 100;
    },
  });

  const stage = board.stage("extracting", 10);
  assert.doesNotThrow(() => {
    for (let done = 1; done <= 10; done += 1) stage(done);
  });
  const output = chunks.join("");
  const visible = output.replace(ANSI, "");
  assert.match(visible, /^extracting 5\/10$/mu, "the stage keeps reporting as plain appended lines");
  assert.match(visible, /extracting 10\/10 in \d+s/u, "and still retires with its completion line");
  assert.doesNotMatch(
    output.slice(output.indexOf("extracting 5/10")),
    /\u001B\[[0-9]*[ABCDJK]/u,
    "nothing moves or erases the cursor once rendering has been dropped",
  );
});
