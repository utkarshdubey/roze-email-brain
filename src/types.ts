// The vocabulary every module shares: mail, the memory extracted from it, the entities and concepts built
// on top, and the few predicates that must mean the same thing everywhere. Types and pure functions only.

export interface EmailMessage {
  id: string;
  threadId: string;
  /** Sender-local ISO timestamp and day; the day is the citation coordinate. */
  date: string;
  day: string;
  timestamp: number;
  fromName: string;
  fromEmail: string;
  to: string;
  cc: string;
  subject: string;
  labels: string[];
  listId: string;
  snippet: string;
  body: string;
}

export interface EmailThread {
  id: string;
  messages: EmailMessage[];
}

export interface MessageHeader {
  id: string;
  threadId: string;
  timestamp: number;
  day: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  labels: string[];
  listId: string;
  count?: number;
  /** Gmail's free body preview; a cached row without one is refetched. */
  snippet?: string;
}

export function collapseHeadersToThreads(rows: readonly MessageHeader[]): MessageHeader[] {
  const threads = new Map<string, MessageHeader>();
  for (const row of rows) {
    const prior = threads.get(row.threadId);
    if (!prior) {
      threads.set(row.threadId, { ...row, count: row.count ?? 1 });
    } else {
      const count = (prior.count ?? 1) + (row.count ?? 1);
      if (row.timestamp < prior.timestamp) {
        threads.set(row.threadId, { ...row, count });
      } else {
        prior.count = count;
      }
    }
  }
  return [...threads.values()];
}

const AUTOMATED_SENDER = new RegExp(
  String.raw`(^|[._-])(no-?reply|noreply|do-?not-?reply|notifications?|notify|mailer|bounce|alerts?|` +
    String.raw`newsletter|digest|updates?|info|hello|team|support|billing|receipts?|invoice|marketing|news|` +
    String.raw`hi|calendar-notification|inmail-hit-reply|hit-reply|messages-noreply|jobs-noreply)([._-]|@|$)`,
  "u",
);

const BULK_LABELS = new Set([
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_FORUMS",
  "CATEGORY_UPDATES",
  "SPAM",
  "TRASH",
]);

/** Automation signals beat display names: a false positive fetches many expensive bodies. */
export function looksLikeAHuman(sender: Pick<MessageHeader, "fromEmail" | "labels" | "listId">): boolean {
  if (sender.listId || sender.labels.some((label) => BULK_LABELS.has(label))) return false;
  const [local = "", domain = ""] = sender.fromEmail.toLowerCase().split("@", 2);
  return Boolean(
    local && domain && !AUTOMATED_SENDER.test(local) && !AUTOMATED_SENDER.test(`${domain.split(".")[0]}@`),
  );
}

export function threadIncludesUser(thread: Pick<EmailThread, "messages">, userEmail: string): boolean {
  const user = userEmail.trim().toLowerCase();
  return thread.messages.some((message) => message.fromEmail.trim().toLowerCase() === user);
}

type ThreadState = "open" | "resolved" | "none";

export interface Mention {
  name: string;
  kind: "person" | "organization";
  email: string;
  org: string;
  role: string;
}

export interface MemoryItem {
  entity: string;
  entityType: string;
  date: string;
  text: string;
  kind: "fact" | "loop";
  loopStatus: string;
}

const ENTITY_TYPE_WORDS: [string, string[]][] = [
  ["person", ["person", "people", "recruiter", "contact"]],
  ["organization", ["organization", "organisation", "company", "org", "school", "university", "team", "employer"]],
  [
    "project",
    ["project", "opportunity", "application", "process", "role", "job", "offer", "commitment", "follow-up", "followup"],
  ],
  ["interest", ["interest", "topic", "subject", "hobby", "tool"]],
  ["place", ["place", "location", "apartment", "housing"]],
  ["account", ["account", "service", "subscription", "payment", "finance"]],
];

export function canonicalizeEntityType(raw: string): string {
  const value = raw.trim().toLowerCase();
  return ENTITY_TYPE_WORDS.find(([, words]) => words.some((word) => value.includes(word)))?.[0] ?? "topic";
}

export interface ThreadExtraction {
  threadId: string;
  firstDay: string;
  lastDay: string;
  userStarted: boolean;
  summary: string;
  state: ThreadState;
  stateNote: string;
  mentions: Mention[];
  items: MemoryItem[];
  /** Deterministic provenance: the days that actually head a message in the thread. */
  messageDays: string[];
}

export interface Citation {
  threadId: string;
  day: string;
}

interface EntityMemoryItem extends Citation {
  text: string;
  kind: "fact" | "loop";
  loopStatus: string;
  /** Preserves the loose item name when it was filed under the thread's primary entity. */
  label: string;
}

export interface Entity {
  slug: string;
  name: string;
  type: "person" | "organization";
  typeRaw: string;
  aliases: string[];
  emails: string[];
  orgs: string[];
  roles: string[];
  threadIds: string[];
  firstSeen: string;
  lastSeen: string;
  items: EntityMemoryItem[];
  /** Ambiguous identities are surfaced, never auto-merged. */
  mergeCandidates: string[];
  threadDays: Record<string, [string, string]>;
}

export interface ThreadCard {
  threadId: string;
  days: string[];
  userParticipated: boolean;
  userStarted: boolean;
  subjects: string[];
  summary: string;
  state: ThreadState;
  stateNote: string;
  mentions: Mention[];
  items: MemoryItem[];
  firstDay: string;
  lastDay: string;
  engaged: boolean;
  substantive: boolean;
}

export type DomainTags = Record<string, { domains: string[]; topic: string }>;

export interface ThreadCluster {
  key: string;
  anchor: string;
  aliases: string[];
  kind: "entity" | "domain" | "topic";
  threadIds: string[];
}

/** Closed vocabularies: the concept schemas bind the model to exactly these words. */
export const PROJECT_STATUSES = ["active", "cancelled", "completed", "paused", "unknown"] as const;
export const INTEREST_KINDS = ["hobby", "organization", "subject", "tool"] as const;
export const INTEREST_STATES = ["active", "former", "unclear"] as const;
export const PROJECT_EVIDENCE_ROLES = ["current_state", "dependency", "goal", "outcome", "progress"] as const;
export const INTEREST_EVIDENCE_ROLES = [
  "active_signal",
  "current_negative",
  "current_positive",
  "negative_signal",
  "passive_signal",
  "reaffirmed",
] as const;

type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type ProjectEvidenceRole = (typeof PROJECT_EVIDENCE_ROLES)[number];
type InterestKind = (typeof INTEREST_KINDS)[number];
type InterestState = (typeof INTEREST_STATES)[number];
export type InterestEvidenceRole = (typeof INTEREST_EVIDENCE_ROLES)[number];

export interface EvidenceRow<Role extends string> extends Citation {
  reason: string;
  role: Role;
}

export interface ProposedProject {
  name: string;
  aliases: string[];
  goal: string;
  status: ProjectStatus;
  outcome: string;
  people: string[];
  organizations: string[];
  evidence: EvidenceRow<ProjectEvidenceRole>[];
}

export interface ProposedInterest {
  topic: string;
  kind: InterestKind;
  currentState: InterestState;
  summary: string;
  evidence: EvidenceRow<InterestEvidenceRole>[];
}

export interface ProjectTrack extends Citation {
  name: string;
  status: ProjectStatus;
  outcome: string;
}

/** Names the concept but was not cited; listed so the agent can read further. */
export interface RelatedThread extends Citation {
  subject: string;
}

export interface Project extends ProposedProject {
  firstSeen: string;
  lastActivity: string;
  /** Written by the review pass: how it started, what happened, where it stands. Empty when unreviewed. */
  narrative: string;
  tracks: ProjectTrack[];
  related: RelatedThread[];
}

export interface Interest extends ProposedInterest {
  firstSeen: string;
  lastSeen: string;
  engagement: "direct" | "passive";
  narrative: string;
  related: RelatedThread[];
}

interface ClusteredProject extends ProposedProject {
  cluster: string;
}

interface ClusteredInterest extends ProposedInterest {
  cluster: string;
}

export type RejectionCounts = Record<string, number>;

export const reject = (counts: RejectionCounts, name: string, count = 1): void => {
  if (count > 0) {
    counts[name] = (counts[name] ?? 0) + count;
  }
};

export function mergeRejections(into: RejectionCounts, from: Readonly<RejectionCounts>): void {
  for (const [name, count] of Object.entries(from)) {
    reject(into, name, count);
  }
}

export interface ClusterJudgment {
  projects: ClusteredProject[];
  interests: ClusteredInterest[];
  rejections: RejectionCounts;
  proposals: {
    projects: JudgeProposalTraceSource[];
    interests: JudgeProposalTraceSource[];
  };
}

export interface JudgeProposalTraceSource {
  name: string;
  cluster: string;
  citations: Citation[];
  gateInputIndex?: number;
  rejectedBy?: string;
}

/** Per-proposal gate accounting, kept separate from aggregate rejection counters. */
export interface GateRuleOutcome {
  proposalIndex: number;
  name: string;
  passed: boolean;
  counters: RejectionCounts;
}

export interface GateRuleResult<T> {
  accepted: T[];
  acceptedProposalIndexes: number[];
  outcomes: GateRuleOutcome[];
}

export interface ProposalGateOutcome extends GateRuleOutcome {
  dedupe?: { outcome: "passed" } | { outcome: "collapsed"; counter: string; into: string };
  /** Position in the accepted list, or the survivor's position after a collapse. */
  outputIndex?: number;
}

export interface ConceptGateResult {
  projects: Project[];
  interests: Interest[];
  rejections: RejectionCounts;
  outcomes: {
    projects: ProposalGateOutcome[];
    interests: ProposalGateOutcome[];
  };
}

export interface ConceptReviewOutcome {
  inputIndex: number;
  name: string;
  verdict: "kept" | "merged" | "umbrella" | "demoted";
  into?: string;
  reason?: string;
  outputIndex?: number;
}

export interface ConceptTraceStage {
  stage: "judge" | "initial_gates" | "initial_dedupe" | "review" | "final_gates" | "final_dedupe";
  outcome: "passed" | "rejected" | "collapsed" | "kept" | "merged" | "umbrella" | "demoted";
  counters?: RejectionCounts;
  into?: string;
  reason?: string;
}

/** One original judge proposal and every deterministic or reviewed disposition it reached. */
export interface ConceptTrace {
  name: string;
  kind: "project" | "interest";
  sourceClusterKey: string;
  sourceClusterKind: ThreadCluster["kind"] | "unknown";
  citations: Citation[];
  stages: ConceptTraceStage[];
  finalFile?: string;
  droppedAt?: ConceptTraceStage["stage"];
}

export interface OpenLoopRow extends Citation {
  entity: string;
  path: string;
  text: string;
}

export interface MerchantRow {
  merchant: string;
  kinds: string[];
  count: number;
  firstDay: string;
  lastDay: string;
  months: number;
  totals: Record<string, number>;
  examples: Array<Citation & { subject: string; amount: number; currency: string }>;
}

/** Kept in concepts.json so consolidation is auditable without the model. */
export interface ConceptReviewLog {
  merged: Array<{ into: string; members: string[] }>;
  demoted: Array<{ name: string; reason: string }>;
  rejections: RejectionCounts;
}

export interface ModelUsage {
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  usd: number;
}
