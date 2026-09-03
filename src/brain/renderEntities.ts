// Person and organization profiles plus the open-loop index across them: one file per entity with dated,
// cited items, an ALL list, a newest-first index per directory, and `open_loops/INDEX.md`.
import { join } from "node:path";
import { clearMarkdownDirectory, ensureDirectory, writeFileAtomically } from "../shared/atomicFiles.js";
import { listOpenLoops } from "../memory/openLoops.js";
import type { EntityRegistry } from "../memory/resolveEntities.js";
import type { Entity, OpenLoopRow } from "../types.js";

const MAX_INDEX_ENTITIES = 80;
const MAX_INDEX_LOOPS = 60;

const renderEntitySummaryLine = (entity: Entity): string =>
  `${entity.slug} | ${entity.type} | ${entity.lastSeen} | ${entity.items.length} | ` +
  `${entity.emails.join(" ") || entity.orgs.slice(0, 2).join(" / ")}`;

function renderFrontmatter(entity: Entity): string[] {
  const fields: Array<[string, string | string[]]> = [
    ["type", entity.type],
    ["type_raw", entity.typeRaw || entity.type],
    ["name", entity.name],
    ["aliases", entity.aliases],
    ["emails", entity.emails],
    ["orgs", entity.orgs],
    ["roles", entity.roles.slice(0, 3)],
    ["first_seen", entity.firstSeen],
    ["last_seen", entity.lastSeen],
    ["threads", [...entity.threadIds].sort()],
    ["merge_candidates", [...entity.mergeCandidates].sort()],
  ];
  return fields.map(([key, value]) => {
    const rendered = Array.isArray(value) ? `[${value.map((row) => JSON.stringify(row)).join(", ")}]` : value;
    return `${key}: ${rendered}`;
  });
}

/** A stable profile shape lets retrieval stay literal instead of teaching the agent format variants. */
function renderEntityAsMarkdown(entity: Entity): string {
  const lines = ["---", ...renderFrontmatter(entity), "---", `# ${entity.name}`, ""];
  const items = [...entity.items].sort((left, right) => left.day.localeCompare(right.day));
  for (const item of items) {
    lines.push(
      `- ${item.day}${item.kind === "loop" ? ` [loop ${item.loopStatus}]` : ""} ` +
        `${item.label ? `[${item.label}] ${item.text}` : item.text} ` +
        `[t:${item.threadId} ${item.day}]`,
    );
  }
  // An entity nobody said anything about is still worth citing: list the episodes it appeared in.
  const observed = items.length
    ? []
    : Object.entries(entity.threadDays ?? {})
        .sort((a, b) => b[1][1].localeCompare(a[1][1]))
        .slice(0, 20);
  if (observed.length) {
    lines.push(
      "## Observed in threads",
      "",
      ...observed.map(
        ([threadId, [firstDay, lastDay]]) =>
          `- Mentioned in this episode (${firstDay}..${lastDay}). [t:${threadId} ${lastDay}]`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

function writeEntityDirectory(entities: readonly Entity[], directory: string, kind: "people" | "organizations"): void {
  clearMarkdownDirectory(directory);
  for (const entity of entities) {
    writeFileAtomically(join(directory, `${entity.slug}.md`), renderEntityAsMarkdown(entity));
  }
  const noun = kind === "people" ? "people" : "organizations";
  writeFileAtomically(
    join(directory, "ALL.md"),
    `# All ${noun} (slug | type | last seen | items | emails or orgs)\n\n` +
      `${entities.map(renderEntitySummaryLine).join("\n")}\n`,
  );
  const index = [
    `# ${kind === "people" ? "People" : "Organizations"} index`,
    "",
    `${entities.length} ${noun}, one file each: ${kind}/<slug>.md with dated, cited facts and loops. ` +
      `This index shows the newest; ${kind}/ALL.md lists every one ` +
      "(slug | type | last seen | items | emails or orgs). To find one, use search_memory with " +
      `scope=${kind} and a name, ${kind === "people" ? "surname," : ""} or email domain.`,
    "",
    ...entities.slice(0, MAX_INDEX_ENTITIES).map(renderEntitySummaryLine),
  ];
  if (entities.length > MAX_INDEX_ENTITIES) {
    index.push(`… ${entities.length - MAX_INDEX_ENTITIES} more: search_memory scope=${kind}`);
  }
  writeFileAtomically(join(directory, "INDEX.md"), `${index.join("\n")}\n`);
}

function renderOpenLoopsIndex(loops: readonly OpenLoopRow[]): string[] {
  const lines = [
    "# Open loops",
    "",
    `${loops.length} unresolved commitments, requests, and pending items, newest first, each filed under ` +
      "the person or organization it involves. Loops older than a year, or whose every named date has " +
      "passed, live only in the person or organization file. Status and ownership come from the cited " +
      "thread; read it before reporting a loop as still open.",
    "",
    ...(loops.length
      ? loops
          .slice(0, MAX_INDEX_LOOPS)
          .map((loop) => `- ${loop.day} ${loop.entity} (${loop.path}): ${loop.text} [t:${loop.threadId} ${loop.day}]`)
      : ["- none"]),
  ];
  if (loops.length > MAX_INDEX_LOOPS) {
    lines.push(`… ${loops.length - MAX_INDEX_LOOPS} more: search_memory scope=open_loops`);
  }
  return lines;
}

export function writeEntityFiles(source: EntityRegistry, root: string, asOfDay: string) {
  const allEntities = source.listEntities();
  const entities = allEntities
    .filter((entity) => entity.items.length || entity.emails.length || entity.threadIds.length)
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.items.length - a.items.length);
  const loops = listOpenLoops(entities, asOfDay);
  writeEntityDirectory(
    entities.filter((entity) => entity.type === "person"),
    join(root, "people"),
    "people",
  );
  writeEntityDirectory(
    entities.filter((entity) => entity.type !== "person"),
    join(root, "organizations"),
    "organizations",
  );
  const loopDirectory = join(root, "open_loops");
  ensureDirectory(loopDirectory);
  writeFileAtomically(join(loopDirectory, "INDEX.md"), `${renderOpenLoopsIndex(loops).join("\n")}\n`);
  return {
    entities: allEntities.length,
    items: allEntities.reduce((total, entity) => total + entity.items.length, 0),
    invalidDateItemsSkipped: source.invalidDateItemsSkipped,
    selfPersonItemsRehomed: source.selfPersonItemsRehomed,
    selfPersonItemsOmitted: source.selfPersonItemsOmitted,
    openLoops: loops.length,
  };
}
