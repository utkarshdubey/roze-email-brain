// What `roze generate` builds, in what order, and what is still missing while it runs. A phase is a point
// at which a complete brain can be published, and `buildStatus` turns "we are here" into the counters and
// the "not yet available" sentence in meta.json and INDEX.md, so a mid-build question is answered honestly.

export type Phase = "full-read" | "fast-inbox" | "complete-inbox" | "body-evidence" | "concepts";

export interface GenerationOptions {
  noPromote: boolean;
  noSynthesize: boolean;
  noSkim: boolean;
  publishOnce: boolean;
  recentMonths: number;
  budget?: number;
}

export interface BuildStatus {
  phase: number;
  phases: number;
  complete: boolean;
  pending: string[];
}

/** How a not-yet-run phase is described to whoever queries the brain in the meantime. */
function pendingDescription(phase: Phase, recentMonths: number): string {
  if (phase === "full-read") return "threads you took part in";
  if (phase === "fast-inbox") return "inbox threads from senders you never replied to";
  if (phase === "complete-inbox") {
    const window = recentMonths === 24 ? "two-year" : `${recentMonths}-month`;
    return `the complete ${window} inbox index and automated senders (banks, tools, recruiting systems)`;
  }
  if (phase === "body-evidence") {
    return "raw bodies of the remaining inbox threads (until then, use read_email for header rows)";
  }
  return "projects and interests";
}

/** Bodies come first: receipts the promotion tier never read still feed recurring interests. */
export function planPhases(options: GenerationOptions): Phase[] {
  return [
    "full-read",
    ...(options.noSkim ? [] : (["fast-inbox", "complete-inbox", "body-evidence"] as const)),
    ...(options.noSynthesize ? [] : (["concepts"] as const)),
  ];
}

export function buildStatus(plan: readonly Phase[], current: Phase, recentMonths = 24): BuildStatus {
  const index = plan.indexOf(current);
  return {
    phase: index + 1,
    phases: plan.length,
    complete: index === plan.length - 1,
    pending: plan.slice(index + 1).map((phase) => pendingDescription(phase, recentMonths)),
  };
}
