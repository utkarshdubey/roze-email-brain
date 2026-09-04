// Topic clustering links threads that lack a shared counterparty or narrow domain by combining the tagger's
// short topic with normalized subject vocabulary. Exact topic labels form the initial groups; deterministic
// Jaccard unions then reconcile nearby labels without adding another model decision.
import { compareText } from "../shared/text.js";
import type { DomainTags, ThreadCard } from "../types.js";

const TOPIC_MERGE_JACCARD = 0.5;
const FUNCTION_WORDS = new Set([
  "about",
  "and",
  "are",
  "for",
  "from",
  "has",
  "have",
  "into",
  "that",
  "the",
  "their",
  "these",
  "this",
  "those",
  "through",
  "was",
  "were",
  "with",
  "within",
  "without",
  "you",
  "your",
]);

interface TopicLabelGroup {
  label: string;
  threads: Set<string>;
  tokens: Set<string>;
}

export interface TopicGroup {
  anchor: string;
  aliases: string[];
  threads: Set<string>;
}

/** Keeps only stable content words; mail reply prefixes do not distinguish one effort from another. */
export function normalizeTopicLabel(label: string): string {
  const withoutMailPrefixes = label
    .trim()
    .toLowerCase()
    .replace(/^(?:(?:re|fwd|fw)\s*:\s*)+/u, "");
  const tokens = withoutMailPrefixes
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/u)
    .filter((token) => Array.from(token).length >= 3 && !FUNCTION_WORDS.has(token));
  return tokens.join(" ");
}

function tokensFrom(label: string): string[] {
  return label.split(" ").filter(Boolean);
}

function makeInitialGroups(cards: readonly ThreadCard[], tags: DomainTags): TopicLabelGroup[] {
  const groups = new Map<string, TopicLabelGroup>();
  for (const card of cards) {
    const subjects = card.subjects.map(normalizeTopicLabel).filter(Boolean);
    const topic = normalizeTopicLabel(tags[card.threadId]?.topic ?? "");
    if (!topic) {
      continue;
    }
    const group = groups.get(topic) ?? { label: topic, threads: new Set<string>(), tokens: new Set<string>() };
    group.threads.add(card.threadId);
    for (const token of [topic, ...subjects].flatMap(tokensFrom)) {
      group.tokens.add(token);
    }
    groups.set(topic, group);
  }
  return [...groups.values()].sort((left, right) => compareText(left.label, right.label));
}

class UnionFind {
  private readonly parents: number[];

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index);
  }

  root(value: number): number {
    let root = value;
    while (this.parents[root] !== root) {
      root = this.parents[root]!;
    }
    while (this.parents[value] !== value) {
      const next = this.parents[value]!;
      this.parents[value] = root;
      value = next;
    }
    return root;
  }

  join(left: number, right: number): void {
    const leftRoot = this.root(left);
    const rightRoot = this.root(right);
    if (leftRoot !== rightRoot) {
      this.parents[rightRoot] = leftRoot;
    }
  }
}

/** Candidate pairs share a token; counting those intersections avoids an all-pairs mailbox scan. */
function countSharedTokens(groups: readonly TopicLabelGroup[]): Map<number, number> {
  const groupIndexesByToken = new Map<string, number[]>();
  for (const [index, group] of groups.entries()) {
    for (const token of group.tokens) {
      const indexes = groupIndexesByToken.get(token) ?? [];
      indexes.push(index);
      groupIndexesByToken.set(token, indexes);
    }
  }
  const sharedByPair = new Map<number, number>();
  for (const indexes of groupIndexesByToken.values()) {
    for (let left = 0; left < indexes.length; left += 1) {
      for (let right = left + 1; right < indexes.length; right += 1) {
        const pair = indexes[left]! * groups.length + indexes[right]!;
        sharedByPair.set(pair, (sharedByPair.get(pair) ?? 0) + 1);
      }
    }
  }
  return sharedByPair;
}

function joinOverlappingGroups(groups: readonly TopicLabelGroup[], sets: UnionFind): void {
  for (const [pair, shared] of countSharedTokens(groups)) {
    const left = Math.floor(pair / groups.length);
    const right = pair % groups.length;
    const unionSize = groups[left]!.tokens.size + groups[right]!.tokens.size - shared;
    if (shared / unionSize >= TOPIC_MERGE_JACCARD) {
      sets.join(left, right);
    }
  }
}

function combineGroups(groups: readonly TopicLabelGroup[]): TopicGroup {
  const ordered = [...groups].sort(
    (left, right) => right.threads.size - left.threads.size || compareText(left.label, right.label),
  );
  return {
    anchor: ordered[0]!.label,
    aliases: ordered.slice(1, 6).map((group) => group.label),
    threads: new Set(ordered.flatMap((group) => [...group.threads])),
  };
}

export function formTopicGroups(cards: readonly ThreadCard[], tags: DomainTags): TopicGroup[] {
  const groups = makeInitialGroups(cards, tags);
  const sets = new UnionFind(groups.length);
  joinOverlappingGroups(groups, sets);
  const groupsByRoot = new Map<number, TopicLabelGroup[]>();
  for (const [index, group] of groups.entries()) {
    const root = sets.root(index);
    const members = groupsByRoot.get(root) ?? [];
    members.push(group);
    groupsByRoot.set(root, members);
  }
  return [...groupsByRoot.values()].map(combineGroups);
}
