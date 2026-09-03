// Typed transaction rows parsed once at build time from automated mail, so spend and frequency questions
// are answered by aggregating a table instead of re-reading receipts. Pure text parsing: no model.
import { looksLikeAHuman, type EmailThread } from "../types.js";

export type TransactionKind = "order" | "refund" | "subscription" | "invoice" | "transfer" | "receipt";

export interface Transaction {
  threadId: string;
  day: string;
  merchant: string;
  kind: TransactionKind;
  amount: number;
  currency: string;
  sender: string;
  subject: string;
}

const CURRENCY: Array<[RegExp, string]> = [
  [/\$/u, "USD"],
  [/€/u, "EUR"],
  [/£/u, "GBP"],
  [/₹|\bINR\b|\bRs\.?/u, "INR"],
];

/** A stated total wins over any other figure in the mail. */
const TOTAL = /\b(?:order |grand |estimated )?total\b[^\d\n]{0,40}([$€£₹])\s?(\d[\d,]*\.\d{2})/iu;

/** An amount only counts when a payment word sits just before it; balances, limits, and prizes never do. */
const PAYMENT_AMOUNT = new RegExp(
  String.raw`\b(amount|charged?|paid|payment|price|cost|subtotal|due|fee|billed|bill|` +
    String.raw`renews?(?: at)?|renewal|debited|credited|refund(?:ed)?(?: of)?)\b` +
    String.raw`[^\d\n$€£₹]{0,30}([$€£₹])\s?(\d[\d,]*\.\d{2})`,
  "iu",
);

const MARKETING =
  /\b(sweepstakes|prize|winner|win\b|deal|sale|offer|save|discount|% ?off|coupon|promo|last chance)\b/iu;

const MAX_PLAUSIBLE_AMOUNT = 25_000;

const KINDS: Array<[TransactionKind, RegExp]> = [
  ["refund", /\brefund/iu],
  ["subscription", /\b(subscription|renew(al|s|ed)?|membership|your plan|trial)\b/iu],
  ["invoice", /\binvoice\b/iu],
  ["transfer", /\b(transfer|sent you|you sent|paid you|you paid)\b/iu],
  ["order", /\b(order|purchase|delivery|shipped)\b/iu],
];

const MERCHANT_IN_SUBJECT = [
  /\bfrom ([^|:]+?)(?:(?:\s*[|:(]|\s-).*)?$/iu,
  /^your ([^|:]+?) (?:receipt|order|invoice|subscription)/iu,
  /^(?:receipt|invoice) (?:from|for) ([^|:]+?)$/iu,
];

/** The subject names the merchant far more reliably than the sending address does. */
function merchantOf(subject: string, fromName: string, fromEmail: string): string {
  const oneLineSubject = subject.replace(/\s+/gu, " ").trim();
  for (const pattern of MERCHANT_IN_SUBJECT) {
    const match = pattern.exec(oneLineSubject);
    if (match?.[1] && match[1].length <= 60) return match[1].trim();
  }
  if (fromName.trim() && !/no-?reply|notification/iu.test(fromName)) return fromName.trim();
  return fromEmail.split("@")[1]?.split(".").slice(-2, -1)[0] ?? fromEmail;
}

function findAmount(text: string): { symbol: string; figure: string } | undefined {
  const total = TOTAL.exec(text);
  if (total) return { symbol: total[1]!, figure: total[2]! };
  const payment = PAYMENT_AMOUNT.exec(text);
  if (payment) return { symbol: payment[2]!, figure: payment[3]! };
  return undefined;
}

/** An automated sender whose first message states an amount; a person's mail is never a transaction. */
export function parseTransaction(thread: EmailThread): Transaction | undefined {
  const first = thread.messages[0];
  if (!first || looksLikeAHuman(first) || MARKETING.test(first.subject)) return undefined;
  const text = `${first.subject}\n${first.body}`;
  const found = findAmount(text);
  if (!found) return undefined;
  const amount = Number(found.figure.replace(/,/gu, ""));
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_PLAUSIBLE_AMOUNT) return undefined;
  return {
    threadId: thread.id,
    day: first.day,
    merchant: merchantOf(first.subject, first.fromName, first.fromEmail),
    kind: KINDS.find(([, pattern]) => pattern.test(text))?.[0] ?? "receipt",
    amount,
    currency: CURRENCY.find(([pattern]) => pattern.test(found.symbol))?.[1] ?? "USD",
    sender: first.fromEmail,
    subject: first.subject.replace(/\s+/gu, " ").trim(),
  };
}
