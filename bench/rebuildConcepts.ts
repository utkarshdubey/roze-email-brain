// Rebuilds only the concept layer from the caches, so iterating on gates, rendering, or the review costs
// nothing or cents. Writes a preview directory unless --publish replaces the brain's own concept files.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { readPublishedBrain } from "../src/brain/storage.js";
import { buildConcepts, estimateConceptCost } from "../src/concepts/buildConcepts.js";
import { writeConceptFiles } from "../src/brain/renderConcepts.js";
import { createPipelineLog, type PipelineContext } from "../src/context.js";
import { cachedModelCall, checkBudgetBeforeStage, resetModelState, usageLedger } from "../src/llm/models.js";
import { listOpenLoops } from "../src/memory/openLoops.js";
import { EntityRegistry } from "../src/memory/resolveEntities.js";
import { readJson } from "../src/shared/atomicFiles.js";
import { readCurrentCalendarDay } from "../src/shared/dates.js";
import { createUi } from "../src/tui.js";
import { threadIncludesUser } from "../src/types.js";
import { brainMetaSchema, loadCachedBrain } from "./publishedBrain.js";
import { runAsScript } from "./script.js";

function publishedExtractedIds(threadsDir: string): Set<string> {
  const ids = new Set<string>();
  for (const name of readdirSync(threadsDir)) {
    if (!/^threads-\d{4}\.md$/u.test(name)) continue;
    for (const line of readFileSync(join(threadsDir, name), "utf8").split("\n")) {
      const id = line.split(" | ")[0]?.trim();
      if (id && /^[0-9a-f]{8,}$/u.test(id)) ids.add(id);
    }
  }
  return ids;
}

async function rebuildConcepts(options: {
  brain?: string;
  out?: string;
  publish?: boolean;
  budget?: number;
  today?: string;
}) {
  const published = readPublishedBrain(options.brain);
  const paths = published.paths;
  const meta = brainMetaSchema.parse(readJson(paths.metaFile));
  const context: PipelineContext = {
    paths,
    today: options.today ?? readCurrentCalendarDay(),
    log: createPipelineLog(createUi({ write: (text) => process.stderr.write(text) })),
    callModel: (request) => cachedModelCall({ ...request, budget: options.budget }),
  };
  // The extracted set is what the brain published, not every cached extraction: the agent's live reads
  // add cached threads that the next generate, not this rebuild, decides whether to extract.
  const { threads, bodies, extractions } = await loadCachedBrain(
    paths,
    published.timezone,
    meta.userEmail,
    context,
    publishedExtractedIds(paths.threadsDir),
  );
  const participated = new Set(
    threads.filter((thread) => threadIncludesUser(thread, meta.userEmail)).map((thread) => thread.id),
  );
  const loops = listOpenLoops(
    EntityRegistry.fromExtractions(extractions, meta.userEmail, participated).listEntities(),
    context.today,
  );
  context.log(
    `${threads.length} extracted threads, ${bodies.length} body-only threads, ${loops.length} open loops (as of ${context.today})`,
  );
  resetModelState();
  checkBudgetBeforeStage(
    "synthesis",
    estimateConceptCost(extractions, threads, meta.userEmail, context),
    options.budget,
    context,
  );
  const concepts = await buildConcepts(extractions, threads, meta.userEmail, context, bodies, loops);
  const root = options.publish ? paths.root : resolve(options.out ?? "concepts-preview");
  writeConceptFiles(concepts.projects, concepts.interests, concepts.rejections, root, concepts.review);
  return {
    root,
    counts: concepts.counts,
    rejections: concepts.rejections,
    review: concepts.review,
    usage: usageLedger.summaryLine(),
  };
}

runAsScript(
  import.meta.url,
  async () => {
    const { values } = parseArgs({
      options: {
        brain: { type: "string" },
        out: { type: "string" },
        publish: { type: "boolean" },
        budget: { type: "string" },
        "as-of": { type: "string" },
      },
      strict: true,
    });
    const report = await rebuildConcepts({
      brain: values.brain,
      out: values.out,
      publish: values.publish,
      today: values["as-of"],
      budget: values.budget === undefined ? undefined : Number(values.budget),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  },
  "Concept rebuild",
);
