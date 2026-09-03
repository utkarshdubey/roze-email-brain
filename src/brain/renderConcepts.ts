// One file per durable project and recurring interest, their indexes, the proposal trace, and the
// `concepts.json` the review pass and offline validator read back. Every claim carries thread citations.
import { join } from "node:path";
import { TRACE_FINAL_TARGET, type TracedConcept } from "../concepts/conceptTrace.js";
import { clearMarkdownDirectory, ensureDirectory, writeFileAtomically } from "../shared/atomicFiles.js";
import { cleanText, compareText, createSlug, hashText } from "../shared/text.js";
import type {
  Citation,
  ConceptReviewLog,
  ConceptTrace,
  ConceptTraceStage,
  Interest,
  Project,
  RejectionCounts,
  RelatedThread,
} from "../types.js";

const renderCitations = (evidence: readonly Citation[]): string =>
  evidence.map((row) => `[t:${row.threadId} ${row.day}]`).join(" ");

function renderRelated(rows: readonly RelatedThread[]): string[] {
  if (!rows.length) return [];
  return [
    "",
    "## Related threads (name the concept; not cited above)",
    ...rows.map((row) => `- ${row.day} ${row.subject} [t:${row.threadId} ${row.day}]`),
  ];
}

export function renderProject(project: Project): string {
  const lines = [
    `# ${project.name}`,
    "",
    `- Goal: ${project.goal}`,
    `- Status: ${project.status}`,
    `- Outcome: ${project.outcome || "not established"}`,
    `- Activity: ${project.firstSeen}..${project.lastActivity}`,
  ];
  if (project.aliases.length) {
    lines.push(`- Aliases: ${project.aliases.join(", ")}`);
  }
  if (project.people.length) {
    lines.push(`- People: ${project.people.join(", ")}`);
  }
  if (project.organizations.length) {
    lines.push(`- Organizations: ${project.organizations.join(", ")}`);
  }
  if (project.narrative) {
    lines.push("", "## Story", project.narrative);
  }
  if (project.tracks.length) {
    lines.push("", "## Tracks");
    for (const track of project.tracks) {
      lines.push(
        `- ${track.name} — ${track.status}${track.outcome ? `: ${track.outcome}` : ""} ` +
          `[t:${track.threadId} ${track.day}]`,
      );
    }
  }
  lines.push(
    "",
    "## Evidence",
    ...project.evidence.map((row) => `- ${row.day} [${row.role}] ${row.reason} [t:${row.threadId} ${row.day}]`),
    ...renderRelated(project.related),
  );
  return `${lines.join("\n")}\n`;
}

export function renderInterest(interest: Interest): string {
  const lines = [
    `# ${interest.topic}`,
    "",
    `- Kind: ${interest.kind}`,
    `- Current state: ${interest.currentState}`,
    `- Evidence basis: ${interest.engagement === "direct" ? "direct participation" : "receipts/notices only"}`,
    `- Seen: ${interest.firstSeen}..${interest.lastSeen}`,
    `- Why: ${interest.summary} ${renderCitations(interest.evidence)}`,
  ];
  if (interest.narrative) {
    lines.push("", "## Story", interest.narrative);
  }
  lines.push(
    "",
    "## Evidence",
    ...interest.evidence.map((row) => `- ${row.day} [${row.role}] ${row.reason} [t:${row.threadId} ${row.day}]`),
    ...renderRelated(interest.related),
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Hashing the concept's own name rather than its position keeps a filename stable when the list around it
 * changes. `ordinal` separates exact name twins; the digest widens until nothing else has claimed it.
 */
function hashedSlug(base: string, name: string, ordinal: number, used: ReadonlySet<string>): string {
  const digest = hashText(ordinal === 0 ? name : `${name}\0${ordinal}`);
  let width = 8;
  let candidate = `${base.slice(0, 50)}-${digest.slice(0, width)}`;
  while (used.has(candidate.toLowerCase())) {
    width += 2;
    candidate = `${base.slice(0, 48)}-${digest.slice(0, width)}`;
  }
  return candidate;
}

function chooseSafeSlugs<T>(rows: readonly T[], nameOf: (row: T) => string): string[] {
  const bases = rows.map((row) => createSlug(nameOf(row)));
  const baseCounts = new Map<string, number>();
  for (const base of bases) {
    baseCounts.set(base.toLowerCase(), (baseCounts.get(base.toLowerCase()) ?? 0) + 1);
  }
  const nameCounts = new Map<string, number>();
  const used = new Set(["index"]);
  return rows.map((row, index) => {
    const base = bases[index]!;
    const name = cleanText(nameOf(row), 160).toLowerCase();
    const ordinal = nameCounts.get(name) ?? 0;
    nameCounts.set(name, ordinal + 1);
    if (baseCounts.get(base.toLowerCase()) === 1 && !used.has(base.toLowerCase())) {
      used.add(base.toLowerCase());
      return base;
    }
    const candidate = hashedSlug(base, name, ordinal, used);
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

function writeProjectViews(root: string, projects: readonly Project[]): string[] {
  const directory = join(root, "projects");
  const index = [
    "# Durable projects",
    "",
    "Outcome-oriented efforts supported across at least two cited threads, newest first. An umbrella " +
      "effort lists its parallel tracks (companies, offices, lease cycles) inside its file.",
    "",
  ];
  clearMarkdownDirectory(directory);
  const slugs = chooseSafeSlugs(projects, (project) => project.name);
  projects.forEach((project, position) => {
    const slug = slugs[position]!;
    const tracks = project.tracks.length ? ` (tracks: ${project.tracks.map((track) => track.name).join(", ")})` : "";
    writeFileAtomically(join(directory, `${slug}.md`), renderProject(project));
    index.push(
      `- ${project.lastActivity} [${project.status}] ${project.name}${tracks} → projects/${slug}.md ` +
        renderCitations(project.evidence.slice(0, 2)),
    );
  });
  if (!projects.length) {
    index.push("- none");
  }
  writeFileAtomically(join(directory, "INDEX.md"), `${index.join("\n")}\n`);
  return slugs;
}

function writeInterestViews(root: string, interests: readonly Interest[]): string[] {
  const directory = join(root, "interests");
  const index = [
    "# Recurring interests",
    "",
    "Recurring behavior supported across at least two cited threads, newest first. The first section is " +
      "what the user actively does or pursues (they wrote or replied in at least two cited threads); the " +
      "second is services, tools, and accounts known only from receipts and notices.",
    "",
    "## Pursued interests (direct evidence)",
    "",
  ];
  const lines: Record<Interest["engagement"], string[]> = { direct: [], passive: [] };
  clearMarkdownDirectory(directory);
  const slugs = chooseSafeSlugs(interests, (interest) => interest.topic);
  interests.forEach((interest, position) => {
    const slug = slugs[position]!;
    writeFileAtomically(join(directory, `${slug}.md`), renderInterest(interest));
    lines[interest.engagement].push(
      `- ${interest.lastSeen} [${interest.currentState}] [${interest.kind}] ${interest.topic} ` +
        `→ interests/${slug}.md ${renderCitations(interest.evidence.slice(0, 2))}`,
    );
  });
  index.push(
    ...(lines.direct.length ? lines.direct : ["- none"]),
    "",
    "## Services, tools and accounts (receipts and notices only)",
    "",
    ...(lines.passive.length ? lines.passive : ["- none"]),
  );
  writeFileAtomically(join(directory, "INDEX.md"), `${index.join("\n")}\n`);
  return slugs;
}

function storedTrace(
  trace: readonly ConceptTrace[],
  projectSlugs: readonly string[],
  interestSlugs: readonly string[],
): ConceptTrace[] {
  return trace.map((entry) => {
    const { [TRACE_FINAL_TARGET]: target, ...stored } = entry as TracedConcept;
    if (!target) {
      return stored;
    }
    const slugs = target.kind === "project" ? projectSlugs : interestSlugs;
    const slug = slugs[target.index];
    if (!slug) {
      throw new Error(`Concept trace points outside the final ${target.kind} list`);
    }
    return { ...stored, finalFile: `${target.kind}s/${slug}.md` };
  });
}

const stageRank = (stage: ConceptTraceStage["stage"]): number =>
  ["judge", "initial_gates", "initial_dedupe", "review", "final_gates", "final_dedupe"].indexOf(stage);

function traceOutcome(stage: ConceptTraceStage): string {
  const counters = Object.entries(stage.counters ?? {})
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, count]) => `\`${name}\`${count === 1 ? "" : ` × ${count}`}`)
    .join(", ");
  const detail = counters ? ` (${counters})` : "";
  if (stage.outcome === "collapsed") return `collapsed into **${stage.into}**${detail}`;
  if (stage.outcome === "merged") return `merged into **${stage.into}**`;
  if (stage.outcome === "umbrella") return `included in umbrella **${stage.into}**`;
  if (stage.outcome === "demoted") return `demoted: ${stage.reason}`;
  if (stage.outcome === "rejected") return `rejected${detail}`;
  return `${stage.outcome}${detail}`;
}

function renderTrace(trace: readonly ConceptTrace[]): string {
  const ordered = [...trace].sort((left, right) => {
    const leftRank = left.finalFile ? 6 : Math.max(...left.stages.map((stage) => stageRank(stage.stage)));
    const rightRank = right.finalFile ? 6 : Math.max(...right.stages.map((stage) => stageRank(stage.stage)));
    const leftDay = left.citations.map((citation) => citation.day).sort().at(-1) ?? "";
    const rightDay = right.citations.map((citation) => citation.day).sort().at(-1) ?? "";
    return rightRank - leftRank || compareText(rightDay, leftDay) || compareText(left.name, right.name);
  });
  const lines = [
    "# Concept proposal trace",
    "",
    "Every cluster-judge proposal, ordered by the latest stage it reached and then newest evidence. " +
      "Stages inside each proposal are newest first.",
  ];
  if (!ordered.length) {
    lines.push("", "- none");
    return `${lines.join("\n")}\n`;
  }
  for (const entry of ordered) {
    lines.push("", `## ${entry.name} (${entry.kind})`);
    if (entry.finalFile) {
      lines.push(`- Final file: ${entry.finalFile}`);
    } else if (entry.droppedAt) {
      lines.push(`- Dropped at: ${entry.droppedAt}`);
    }
    for (const stage of [...entry.stages].reverse()) {
      lines.push(`- ${stage.stage}: ${traceOutcome(stage)}`);
    }
    const citations = renderCitations(entry.citations);
    lines.push(
      `- Judge source: \`${entry.sourceClusterKey}\` (${entry.sourceClusterKind}); ` +
        `cited ${citations || "no threads"}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function writeConceptFiles(
  projects: readonly Project[],
  interests: readonly Interest[],
  rejections: Readonly<RejectionCounts>,
  root: string,
  review?: Readonly<ConceptReviewLog>,
  trace?: readonly ConceptTrace[],
): void {
  ensureDirectory(root);
  const projectSlugs = writeProjectViews(root, projects);
  const interestSlugs = writeInterestViews(root, interests);
  const publishedTrace = trace === undefined ? undefined : storedTrace(trace, projectSlugs, interestSlugs);
  if (publishedTrace) {
    const directory = join(root, "concepts");
    clearMarkdownDirectory(directory);
    writeFileAtomically(join(directory, "TRACE.md"), renderTrace(publishedTrace));
  }
  writeFileAtomically(
    join(root, "concepts.json"),
    `${JSON.stringify(
      {
        projects,
        interests,
        rejected: rejections,
        ...(review ? { review } : {}),
        ...(publishedTrace ? { trace: publishedTrace } : {}),
      },
      null,
      2,
    )}\n`,
  );
}
