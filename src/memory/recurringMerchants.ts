// Recurring merchants from the transactions table: receipts the promotion tier never read still show what
// the user repeatedly pays for. Deterministic; the review pass in `concepts/` decides what they mean.
import { normalizeNameKey } from "../shared/text.js";
import type { EmailThread, MerchantRow } from "../types.js";
import { parseTransaction, type Transaction } from "./transactions.js";

const MAX_EXAMPLES = 4;

function spreadExamples(rows: readonly Transaction[]): Transaction[] {
  if (rows.length <= MAX_EXAMPLES) return [...rows];
  const picked = new Set<number>([0, rows.length - 1]);
  for (let step = 1; picked.size < MAX_EXAMPLES; step += 1) {
    picked.add(Math.round((step * (rows.length - 1)) / (MAX_EXAMPLES - 1)));
  }
  return [...picked].sort((a, b) => a - b).map((index) => rows[index]!);
}

function groupByMerchant(threads: readonly EmailThread[]): Transaction[][] {
  const groups = new Map<string, Transaction[]>();
  for (const thread of threads) {
    const row = parseTransaction(thread);
    if (!row) continue;
    const key = normalizeNameKey(row.merchant);
    if (!key) continue;
    const group = groups.get(key);
    if (group) {
      group.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.day.localeCompare(b.day) || a.threadId.localeCompare(b.threadId));
  }
  return [...groups.values()];
}

function repeats(rows: readonly Transaction[]): boolean {
  const days = new Set(rows.map((row) => row.day));
  const threadIds = new Set(rows.map((row) => row.threadId));
  return days.size >= 2 && threadIds.size >= 2;
}

/** Re-rounded on every addition, so a long run of receipts cannot drift into fractions of a cent. */
function totalsByCurrency(rows: readonly Transaction[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const row of rows) {
    totals[row.currency] = Math.round(((totals[row.currency] ?? 0) + row.amount) * 100) / 100;
  }
  return totals;
}

function commonestSpelling(rows: readonly Transaction[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.merchant, (counts.get(row.merchant) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
}

function summarizeMerchant(rows: readonly Transaction[]): MerchantRow {
  return {
    merchant: commonestSpelling(rows),
    kinds: [...new Set(rows.map((row) => row.kind))].sort(),
    count: rows.length,
    firstDay: rows[0]!.day,
    lastDay: rows.at(-1)!.day,
    months: new Set(rows.map((row) => row.day.slice(0, 7))).size,
    totals: totalsByCurrency(rows),
    examples: spreadExamples(rows).map((row) => ({
      threadId: row.threadId,
      day: row.day,
      subject: row.subject.slice(0, 70),
      amount: row.amount,
      currency: row.currency,
    })),
  };
}

export function recurringMerchants(threads: readonly EmailThread[]): MerchantRow[] {
  const merchants = groupByMerchant(threads).filter(repeats).map(summarizeMerchant);
  // Months with a receipt rank above raw count: a tool paid yearly for years matters more than a lunch spot.
  return merchants
    .sort(
      (a, b) =>
        b.months - a.months ||
        b.count - a.count ||
        b.lastDay.localeCompare(a.lastDay) ||
        a.merchant.localeCompare(b.merchant),
    )
    .slice(0, 150);
}
