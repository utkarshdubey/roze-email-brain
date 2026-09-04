// The second concept stage, and the reason the pipeline is cluster-first: the judge never sees the whole
// mailbox, only one small, coherent group of threads at a time — an ENTITY cluster around one recurring
// counterparty, a DOMAIN cluster around one life-domain tag, or a TOPIC cluster around related labels.
import { compareText, createSlug, normalizeNameKey, organizationNamesAreCompatible } from "../shared/text.js";
import type { DomainTags, ThreadCard, ThreadCluster } from "../types.js";
import { LIFE_DOMAINS } from "./tagLifeDomains.js";
import { formTopicGroups } from "./topicClusters.js";

/** The cap is what one judge request may see; the minimum keeps one-off mail from becoming a cluster. */
const ENTITY_CAP = 30;
const DOMAIN_CAP = 40;
const ENTITY_MINIMUM = 2;
const DOMAIN_MINIMUM = 3;
/** Two entity groups sharing this much of their thread sets are treated as one recurring counterparty. */
const MERGE_JACCARD = 0.5;

// ENTITY GROUPING — one node per mention, merged by union-find into one group per counterparty.

interface Node {
  id: number;
  name: string;
  type: "person" | "organization";
  email: string;
  organization: string;
  threadId: string;
}
interface EntityGroup {
  anchor: string;
  aliases: string[];
  threads: Set<string>;
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
    const a = this.root(left);
    const b = this.root(right);
    if (a !== b) {
      this.parents[b] = a;
    }
  }
}
function jaccardOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let common = 0;
  left.forEach((value) => {
    if (right.has(value)) {
      common += 1;
    }
  });
  return common / (left.size + right.size - common || 1);
}
function makeEntityNodes(cards: readonly ThreadCard[]): Node[] {
  const nodes: Node[] = [];
  const add = (name: string, type: Node["type"], threadId: string, email = "", organization = ""): void => {
    if (!name.trim()) return;
    nodes.push({
      id: nodes.length,
      name: name.trim(),
      type,
      email: email.trim().toLowerCase(),
      organization: organization.trim(),
      threadId,
    });
  };
  for (const card of cards)
    for (const mention of card.mentions) {
      add(mention.name, mention.kind, card.threadId, mention.email, mention.org);
      // The employer must stay visible even if extraction omitted a separate org mention.
      if (mention.kind === "person" && mention.org.trim()) {
        add(mention.org, "organization", card.threadId);
      }
    }
  return nodes;
}
function joinNodesThatClearlyBelongTogether(nodes: readonly Node[], sets: UnionFind): void {
  const firstByName = new Map<string, number>();
  const firstByEmail = new Map<string, number>();
  for (const node of nodes) {
    const nameKey = `${node.type}\0${normalizeNameKey(node.name)}`;
    const sameName = firstByName.get(nameKey);
    if (sameName === undefined) {
      firstByName.set(nameKey, node.id);
    } else {
      sets.join(sameName, node.id);
    }
    if (node.type === "person" && node.email) {
      const sameEmail = firstByEmail.get(node.email);
      if (sameEmail === undefined) {
        firstByEmail.set(node.email, node.id);
      } else {
        sets.join(sameEmail, node.id);
      }
    }
  }
  const organizations = nodes.filter((node) => node.type === "organization");
  // Compatible org names merge only inside one thread, where the shared context makes it safe.
  for (let left = 0; left < organizations.length; left += 1)
    for (let right = left + 1; right < organizations.length; right += 1) {
      const a = organizations[left]!;
      const b = organizations[right]!;
      if (a.threadId === b.threadId && organizationNamesAreCompatible(a.name, b.name)) {
        sets.join(a.id, b.id);
      }
    }
  for (const person of nodes.filter((node) => node.type === "person"))
    for (const organization of organizations)
      if (person.organization && organizationNamesAreCompatible(person.organization, organization.name))
        sets.join(organization.id, person.id);
}
/**
 * Co-occurrence improves judge recall but is never an identity merge: it only decides which threads are
 * shown together, and the entity files keep the names apart.
 */
function joinGroupsThatRecurTogether(nodes: readonly Node[], sets: UnionFind): void {
  const threadsByRoot = new Map<number, Set<string>>();
  for (const node of nodes) {
    const root = sets.root(node.id);
    const threads = threadsByRoot.get(root) ?? new Set<string>();
    threads.add(node.threadId);
    threadsByRoot.set(root, threads);
  }
  const roots = [...threadsByRoot.keys()];
  for (let left = 0; left < roots.length; left += 1)
    for (let right = left + 1; right < roots.length; right += 1) {
      const a = sets.root(roots[left]!);
      const b = sets.root(roots[right]!);
      if (a === b) continue;
      const leftThreads = threadsByRoot.get(roots[left]!)!;
      const rightThreads = threadsByRoot.get(roots[right]!)!;
      if (jaccardOverlap(leftThreads, rightThreads) >= MERGE_JACCARD) {
        sets.join(a, b);
        threadsByRoot.set(sets.root(a), new Set([...leftThreads, ...rightThreads]));
      }
    }
}
function chooseAnchorAndAliases(members: readonly Node[]): EntityGroup | undefined {
  const threads = new Set<string>();
  const byName = new Map<string, { name: string; type: Node["type"]; threads: Set<string> }>();
  for (const node of members) {
    threads.add(node.threadId);
    const key = `${node.type}\0${normalizeNameKey(node.name)}`;
    const row = byName.get(key) ?? { name: node.name, type: node.type, threads: new Set<string>() };
    row.threads.add(node.threadId);
    byName.set(key, row);
  }
  const ordered = [...byName.values()].sort(
    (a, b) =>
      Number(a.type !== "organization") - Number(b.type !== "organization") ||
      b.threads.size - a.threads.size ||
      compareText(a.name, b.name),
  );
  const anchor = ordered[0];
  return anchor ? { anchor: anchor.name, aliases: ordered.slice(1, 6).map((row) => row.name), threads } : undefined;
}
function formEntityGroups(cards: readonly ThreadCard[]): EntityGroup[] {
  const nodes = makeEntityNodes(cards);
  const sets = new UnionFind(nodes.length);
  joinNodesThatClearlyBelongTogether(nodes, sets);
  joinGroupsThatRecurTogether(nodes, sets);
  const membersByRoot = new Map<number, Node[]>();
  for (const node of nodes) {
    const root = sets.root(node.id);
    const members = membersByRoot.get(root) ?? [];
    members.push(node);
    membersByRoot.set(root, members);
  }
  return [...membersByRoot.values()].flatMap((members) => chooseAnchorAndAliases(members) ?? []);
}

// CLUSTER ASSEMBLY — entity, life-domain, and topic groups, each capped to one judge request.

function compareCardsByPriority(left: ThreadCard, right: ThreadCard): number {
  return (
    Number(right.userParticipated) - Number(left.userParticipated) ||
    Number(right.engaged) - Number(left.engaged) ||
    Number(right.substantive) - Number(left.substantive) ||
    compareText(right.lastDay, left.lastDay) ||
    compareText(left.threadId, right.threadId)
  );
}
export function buildClusters(cards: readonly ThreadCard[], tags: DomainTags): ThreadCluster[] {
  const byId = new Map(cards.map((card) => [card.threadId, card]));
  const clusters: ThreadCluster[] = [];
  const takenKeys = new Set<string>();
  function uniqueKey(kind: string, anchor: string): string {
    const base = createSlug(`${kind}-${anchor}`);
    let key = base;
    for (let ordinal = 2; takenKeys.has(key); ordinal += 1) {
      key = `${base}-${ordinal}`;
    }
    takenKeys.add(key);
    return key;
  }
  function addCluster(kind: ThreadCluster["kind"], anchor: string, aliases: string[], ids: ReadonlySet<string>): void {
    const [cap, minimumEngaged] =
      kind === "domain" ? [DOMAIN_CAP, DOMAIN_MINIMUM] : [ENTITY_CAP, ENTITY_MINIMUM];
    const memberCards = [...ids].flatMap((id) => byId.get(id) ?? []);
    if (memberCards.filter((card) => card.engaged).length < minimumEngaged) return;
    clusters.push({
      key: uniqueKey(kind, anchor),
      anchor: anchor.trim().slice(0, 120),
      aliases: aliases.map((alias) => alias.trim().slice(0, 120)),
      kind,
      threadIds: memberCards.sort(compareCardsByPriority).slice(0, cap).map((card) => card.threadId),
    });
  }
  for (const group of formEntityGroups(cards)) {
    if (group.threads.size <= ENTITY_CAP) {
      addCluster("entity", group.anchor, group.aliases, group.threads);
      continue;
    }
    for (const [year, ids] of splitByYear(group.threads, byId)) {
      addCluster("entity", `${group.anchor} ${year}`, group.aliases, ids);
    }
  }
  for (const [domain, members] of collectDomainMembers(tags, byId)) {
    if (members.size <= DOMAIN_CAP) {
      addCluster("domain", domain, [], members);
      continue;
    }
    // A domain larger than one request is judged per year, so a multi-year domain keeps its recent efforts
    // instead of losing everything past the cap.
    for (const [year, ids] of splitByYear(members, byId)) addCluster("domain", `${domain} ${year}`, [], ids);
  }
  for (const group of formTopicGroups(cards, tags)) {
    if (group.threads.size <= ENTITY_CAP) {
      addCluster("topic", group.anchor, group.aliases, group.threads);
      continue;
    }
    for (const [year, ids] of splitByYear(group.threads, byId)) {
      addCluster("topic", `${group.anchor} ${year}`, group.aliases, ids);
    }
  }
  return clusters.sort(
    (a, b) => compareText(a.kind, b.kind) || b.threadIds.length - a.threadIds.length || compareText(a.key, b.key),
  );
}
/** Domains are walked in taxonomy order so cluster keys and batches stay stable between runs. */
function collectDomainMembers(tags: DomainTags, byId: ReadonlyMap<string, ThreadCard>): Array<[string, Set<string>]> {
  const members = new Map<string, Set<string>>();
  for (const [threadId, tag] of Object.entries(tags)) {
    const card = byId.get(threadId);
    if (!card || (!card.engaged && !card.substantive)) continue;
    for (const domain of tag.domains) {
      members.set(domain, (members.get(domain) ?? new Set()).add(threadId));
    }
  }
  return LIFE_DOMAINS.flatMap((domain) => {
    const ids = members.get(domain);
    return ids ? [[domain, ids] as [string, Set<string>]] : [];
  });
}
function splitByYear(
  members: ReadonlySet<string>,
  byId: ReadonlyMap<string, ThreadCard>,
): Array<[string, Set<string>]> {
  const byYear = new Map<string, Set<string>>();
  for (const id of members) {
    const year = byId.get(id)!.lastDay.slice(0, 4) || "undated";
    byYear.set(year, (byYear.get(year) ?? new Set()).add(id));
  }
  return [...byYear].sort();
}
