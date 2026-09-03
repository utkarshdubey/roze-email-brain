// Mentions and items from many thread extractions become one set of people and organizations with dated,
// cited items. Identity never merges on a model's say-so: every index answers only when exactly one record
// is compatible, and anything ambiguous becomes a new record plus a `mergeCandidates` pointer for review.
import { isCalendarDay } from "../shared/dates.js";
import { createSlug, normalizeNameKey, organizationNamesAreCompatible, textContainsWholeName } from "../shared/text.js";
import { closeLoopsWhoseThreadResolved, loopIsMaterial } from "./openLoops.js";
import { canonicalizeEntityType, type Entity, type MemoryItem, type Mention, type ThreadExtraction } from "../types.js";

/** The mailbox owner, or a faceless desk; never a contact worth a record. */
const GENERIC_SELF_NAMES = ["me", "you", "user", "team", "support", "hr", "recruiting"];

function addToIndex(index: Map<string, Set<string>>, key: string, slug: string): void {
  if (!key) return;
  const values = index.get(key) ?? new Set<string>();
  values.add(slug);
  index.set(key, values);
}

function firstName(name: string): string {
  return normalizeNameKey(name).split(" ")[0] ?? "";
}

function recordSighting(
  entity: Entity,
  thread: ThreadExtraction,
  firstDay = thread.firstDay,
  lastDay = thread.lastDay,
): void {
  if (!entity.threadIds.includes(thread.threadId)) {
    entity.threadIds.push(thread.threadId);
  }
  entity.threadDays[thread.threadId] = [thread.firstDay, thread.lastDay];
  if (firstDay < entity.firstSeen) entity.firstSeen = firstDay;
  if (lastDay > entity.lastSeen) entity.lastSeen = lastDay;
}

/** A model date is evidence only when it exactly names a real message day. */
function findExactSupportDay(requested: unknown, extraction: ThreadExtraction): string | undefined {
  const days = new Set(extraction.messageDays.filter(isCalendarDay));
  return typeof requested === "string" && isCalendarDay(requested) && days.has(requested) ? requested : undefined;
}

interface ItemDestination {
  slug?: string;
  label: string;
}

export class EntityRegistry {
  invalidDateItemsSkipped = 0;
  selfPersonItemsRehomed = 0;
  selfPersonItemsOmitted = 0;

  private readonly emails = new Map<string, Set<string>>();
  private readonly names = new Map<string, Set<string>>();
  private readonly firstNames = new Map<string, Set<string>>();
  private readonly namesAndOrganizations = new Map<string, Set<string>>();
  private readonly records = new Map<string, Entity>();
  private readonly selfNames = new Set<string>();
  private readonly threadEntities = new Map<string, string[]>();
  private readonly threadPrimary = new Map<string, string | undefined>();
  private readonly participated: Set<string>;
  private readonly userEmail: string;

  constructor(userEmail: string, participated: ReadonlySet<string> = new Set(), selfNames: Iterable<string> = []) {
    this.userEmail = userEmail.trim().toLowerCase();
    this.participated = new Set(participated);
    for (const value of [...GENERIC_SELF_NAMES, ...selfNames]) {
      const key = normalizeNameKey(value);
      if (key) {
        this.selfNames.add(key);
      }
    }
  }

  static fromExtractions(
    extractions: readonly ThreadExtraction[],
    userEmail: string,
    participated: ReadonlySet<string> = new Set(),
  ): EntityRegistry {
    const owner = userEmail.trim().toLowerCase();
    const selfNames = extractions.flatMap((extraction) =>
      extraction.mentions
        .filter((mention) => mention.email.trim().toLowerCase() === owner && mention.name.trim())
        .map((mention) => mention.name.trim()),
    );
    const registry = new EntityRegistry(userEmail, participated, selfNames);
    const ordered = [...extractions].sort((left, right) => left.firstDay.localeCompare(right.firstDay));
    for (const extraction of ordered) {
      registry.indexMentionsFromThread(extraction);
    }
    for (const extraction of ordered) {
      registry.fileItemsFromThread(extraction);
    }
    return registry;
  }

  createEntity(name: string, type: Entity["type"], typeRaw: string, email = "", organization = ""): string {
    const base = createSlug(name);
    let slug = base;
    for (let suffix = 2; this.records.has(slug); suffix += 1) {
      slug = `${base}-${suffix}`;
    }
    const normalizedEmail = email.trim().toLowerCase();
    this.records.set(slug, {
      slug,
      name: name.trim(),
      type,
      typeRaw,
      aliases: [],
      emails: normalizedEmail ? [normalizedEmail] : [],
      orgs: organization ? [organization] : [],
      roles: [],
      threadIds: [],
      firstSeen: "9999",
      lastSeen: "0000",
      items: [],
      mergeCandidates: [],
      threadDays: {},
    });
    addToIndex(this.emails, normalizedEmail, slug);
    addToIndex(this.names, normalizeNameKey(name), slug);
    addToIndex(this.firstNames, firstName(name), slug);
    return slug;
  }

  requireEntity(slug: string): Entity {
    const entity = this.records.get(slug);
    if (!entity) throw new Error(`Unknown entity slug: ${slug}`);
    return entity;
  }

  listEntities(): Entity[] {
    return [...this.records.values()].map((entity) => ({
      ...entity,
      aliases: [...entity.aliases],
      emails: [...entity.emails],
      orgs: [...entity.orgs],
      roles: [...entity.roles],
      threadIds: [...entity.threadIds],
      items: entity.items.map((item) => ({ ...item })),
      mergeCandidates: [...entity.mergeCandidates].sort(),
      threadDays: { ...entity.threadDays },
    }));
  }

  uniqueEntityForEmail(value: string): string | undefined {
    const candidates = this.emails.get(value.trim().toLowerCase());
    return candidates?.size === 1 ? [...candidates][0] : undefined;
  }

  uniqueEntityForName(value: string, type?: Entity["type"]): string | undefined {
    const candidates = [...(this.names.get(normalizeNameKey(value)) ?? [])].filter(
      (slug) => !type || this.requireEntity(slug).type === type,
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  /** An unambiguous existing record, or a new one; undefined for the owner, never filed as a contact. */
  resolveEntityForMention(source: Mention): string | undefined {
    const mention = {
      ...source,
      name: source.name.trim(),
      email: source.email.trim().toLowerCase(),
      org: source.org.trim(),
    };
    const nameKey = normalizeNameKey(mention.name);
    if (mention.email === this.userEmail && nameKey) {
      this.selfNames.add(nameKey);
    }
    if (!mention.name || mention.email === this.userEmail || (this.selfNames.has(nameKey) && !mention.email))
      return undefined;

    const pools = this.candidatePools(mention.name, mention.email, mention.org);
    let slug = pools.map((pool) => this.chooseOne(pool, mention)).find(Boolean);
    if (slug) {
      this.addAlias(slug, mention.name);
    } else {
      slug = this.createEntity(
        mention.name,
        mention.kind,
        mention.kind,
        mention.email,
        mention.kind === "person" ? mention.org : "",
      );
      // Ambiguity is surfaced for review; it is never silently converted into an identity merge.
      this.linkMergeCandidates(slug, pools);
    }
    this.rememberMentionDetails(slug, mention);
    return slug;
  }

  private linkMergeCandidates(slug: string, pools: readonly ReadonlySet<string>[]): void {
    for (const other of new Set(pools.flatMap((pool) => [...pool]))) {
      if (other === slug) continue;
      const current = this.requireEntity(slug);
      const candidate = this.requireEntity(other);
      if (!current.mergeCandidates.includes(other)) {
        current.mergeCandidates.push(other);
      }
      if (!candidate.mergeCandidates.includes(slug)) {
        candidate.mergeCandidates.push(slug);
      }
    }
  }

  private rememberMentionDetails(slug: string, mention: Mention): void {
    const entity = this.requireEntity(slug);
    if (mention.email && !entity.emails.includes(mention.email)) {
      entity.emails.push(mention.email);
      addToIndex(this.emails, mention.email, slug);
    }
    if (mention.org && !entity.orgs.includes(mention.org) && mention.org.toLowerCase() !== entity.name.toLowerCase()) {
      entity.orgs.push(mention.org);
    }
    if (mention.role && !entity.roles.includes(mention.role)) {
      entity.roles.push(mention.role);
    }
    addToIndex(this.namesAndOrganizations, `${firstName(mention.name)}\0${normalizeNameKey(mention.org)}`, slug);
  }

  private addAlias(slug: string, name: string): void {
    const entity = this.requireEntity(slug);
    const alias = name.trim();
    const key = normalizeNameKey(alias);
    if (alias && key !== normalizeNameKey(entity.name) && !entity.aliases.includes(alias)) {
      entity.aliases.push(alias);
    }
    addToIndex(this.names, key, slug);
    addToIndex(this.firstNames, firstName(alias), slug);
  }

  private belongsToSameOrganization(entity: Entity, organization: string): boolean {
    return Boolean(organization) && entity.orgs.some((known) => organizationNamesAreCompatible(known, organization));
  }

  /**
   * An exact name match is the normal route; a bare first name is accepted only inside a matching
   * organization, and a conflicting address or organization vetoes the match unless the name is exact
   * and the organization agrees.
   */
  private identityIsCompatible(slug: string, name: string, email: string, organization: string): boolean {
    const entity = this.requireEntity(slug);
    const knownNames = [entity.name, ...entity.aliases];
    const normalized = normalizeNameKey(name);
    const parts = normalized.split(" ").filter(Boolean);
    const exact = knownNames.some((known) => normalizeNameKey(known) === normalized);
    const firstMatches = knownNames.some((known) => firstName(known) === parts[0]);
    if (exact && email && entity.emails.includes(email)) return true;
    const shortenedSameOrg =
      firstMatches &&
      organization &&
      this.belongsToSameOrganization(entity, organization) &&
      (parts.length === 1 || knownNames.some((known) => normalizeNameKey(known).split(" ").length === 1));
    if (!exact && !shortenedSameOrg) return false;
    if (organization && entity.orgs.length && !this.belongsToSameOrganization(entity, organization)) return false;
    if (email && entity.emails.length && !entity.emails.includes(email))
      return exact && this.belongsToSameOrganization(entity, organization);
    return true;
  }

  private chooseOne(candidates: ReadonlySet<string>, mention: Mention): string | undefined {
    const matches = [...candidates].filter(
      (slug) =>
        this.requireEntity(slug).type === mention.kind &&
        this.identityIsCompatible(slug, mention.name.trim(), mention.email.trim().toLowerCase(), mention.org.trim()),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  private candidatePools(name: string, email: string, organization: string): Set<string>[] {
    const pools = email ? [new Set(this.emails.get(email) ?? [])] : [];
    pools.push(new Set(this.names.get(normalizeNameKey(name)) ?? []));
    if (organization) {
      pools.push(
        new Set(this.firstNames.get(firstName(name)) ?? []),
        new Set(this.namesAndOrganizations.get(`${firstName(name)}\0${normalizeNameKey(organization)}`) ?? []),
      );
    }
    return pools;
  }

  /**
   * Items name their subject freely ("EAD start date"), so after the address and name indexes come a
   * whole-name scan of the item text, then the thread's primary entity with that subject kept as a label.
   */
  private findEntityForItem(item: MemoryItem, primary?: string, candidates?: readonly string[]): ItemDestination {
    const name = item.entity.trim();
    const type = canonicalizeEntityType(item.entityType);
    if (type === "person" && this.selfNames.has(normalizeNameKey(name)))
      return primary ? { slug: primary, label: name } : { label: name };

    const byEmail = this.uniqueEntityForEmail(name.toLowerCase());
    if (byEmail) return { slug: byEmail, label: "" };

    const entityType = type === "person" || type === "organization" ? type : undefined;
    const byName = entityType ? this.uniqueEntityForName(name, entityType) : undefined;
    if (byName) return { slug: byName, label: "" };

    const haystack = `${name.toLowerCase()} ${item.text.toLowerCase()}`;
    const mentioned = (candidates ?? [...this.records.keys()]).filter((slug) => {
      const entity = this.requireEntity(slug);
      return [entity.name, ...entity.aliases].some(
        (candidate) => candidate.length >= 3 && textContainsWholeName(haystack, candidate),
      );
    });
    if (new Set(mentioned).size === 1) return { slug: mentioned[0], label: "" };

    if (primary && !entityType) return { slug: primary, label: name };
    if (entityType && name) return { slug: this.createEntity(name, entityType, item.entityType), label: "" };
    return primary ? { slug: primary, label: name } : { label: name };
  }

  private indexMentionsFromThread(extraction: ThreadExtraction): void {
    const mentions = extraction.mentions.map((mention) => ({ ...mention }));
    const organizations = new Set(
      mentions.filter((mention) => mention.kind === "organization").map((mention) => normalizeNameKey(mention.name)),
    );
    for (const mention of [...mentions]) {
      const organization = mention.org.trim();
      const key = normalizeNameKey(organization);
      if (
        mention.kind === "person" &&
        organization &&
        !organizations.has(key) &&
        !this.selfNames.has(key) &&
        key !== normalizeNameKey(mention.name)
      ) {
        mentions.push({ name: organization, kind: "organization", email: "", org: "", role: "" });
        organizations.add(key);
      }
    }
    const slugs = mentions.flatMap((mention) => this.resolveEntityForMention(mention) ?? []);
    for (const slug of slugs) {
      recordSighting(this.requireEntity(slug), extraction);
    }
    const primary = slugs.find((slug) => this.requireEntity(slug).type === "organization") ?? slugs[0];
    this.threadEntities.set(extraction.threadId, slugs);
    this.threadPrimary.set(extraction.threadId, primary);
  }

  private fileItemsFromThread(extraction: ThreadExtraction): void {
    const primary = this.threadPrimary.get(extraction.threadId);
    for (const source of extraction.items) {
      const day = findExactSupportDay(source.date, extraction);
      if (!day) {
        this.invalidDateItemsSkipped += 1;
        continue;
      }
      const isSelfItem =
        canonicalizeEntityType(source.entityType) === "person" && this.selfNames.has(normalizeNameKey(source.entity));
      const { slug, label } = this.findEntityForItem(source, primary, this.threadEntities.get(extraction.threadId));
      if (!slug) {
        if (isSelfItem) {
          this.selfPersonItemsOmitted += 1;
        }
        continue;
      }
      if (isSelfItem) {
        this.selfPersonItemsRehomed += 1;
      }
      const entity = this.requireEntity(slug);
      const text = source.text.trim();
      let item: MemoryItem = { ...source, date: day, text, loopStatus: source.loopStatus.trim() };
      item = this.demoteImmaterialLoop(item, entity, extraction, label ? `[${label}] ${text}` : text);
      item = closeLoopsWhoseThreadResolved(item, extraction);
      entity.items.push({
        day,
        text: item.text,
        kind: item.kind,
        loopStatus: item.loopStatus.trim(),
        label,
        threadId: extraction.threadId,
      });
      recordSighting(entity, extraction, day, day);
    }
  }

  /**
   * Loops from threads the user never took part in survive only if they ask something of the user. A
   * registry built without a participated set (validators, tests) skips the gate entirely.
   */
  private demoteImmaterialLoop(
    item: MemoryItem,
    entity: Entity,
    extraction: ThreadExtraction,
    renderedText: string,
  ): MemoryItem {
    if (item.kind !== "loop" || this.participated.has(extraction.threadId) || this.participated.size === 0) return item;
    const appearsInParticipatedThread = entity.threadIds.some((id) => this.participated.has(id));
    if (loopIsMaterial(renderedText, appearsInParticipatedThread, extraction.userStarted)) return item;
    return { ...item, kind: "fact", loopStatus: "" };
  }
}
