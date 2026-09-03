import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeTransactionFiles } from "../src/brain/renderEvidence.js";
import { parseTransaction } from "../src/memory/transactions.js";
import { message } from "./helpers.js";

function receipt(id: string, day: string, from: string, subject: string, body: string) {
  const row = message(id, day, from, subject);
  return { id, messages: [{ ...row, fromName: "DoorDash", body }] };
}

test("receipts parse into merchant, kind, amount, and currency; mail from people is never a transaction", () => {
  const order = parseTransaction(
    receipt(
      "aaaaaaaa11111111",
      "2026-08-31",
      "no-reply@doordash.com",
      "Order Confirmation for Utkarsh from honeygrow",
      "Subtotal $13.00\nPaid with Visa Ending in 5691 honeygrow Total: $15.02",
    ),
  );
  assert.deepEqual(
    { ...order, sender: undefined, subject: undefined },
    {
      threadId: "aaaaaaaa11111111",
      day: "2026-08-31",
      merchant: "honeygrow",
      kind: "order",
      amount: 15.02,
      currency: "USD",
      sender: undefined,
      subject: undefined,
    },
  );
  const refund = parseTransaction(
    receipt(
      "aaaaaaaa22222222",
      "2026-08-01",
      "noreply@amazon.com",
      "Refund issued for your order",
      "We refunded €4.50 to your card.",
    ),
  );
  assert.deepEqual([refund?.kind, refund?.amount, refund?.currency], ["refund", 4.5, "EUR"]);
  const plan = parseTransaction(
    receipt(
      "aaaaaaaa33333333",
      "2026-07-15",
      "billing@service.example",
      "Your subscription renews soon",
      "Your plan renews at $9.99/month on Aug 1.",
    ),
  );
  assert.deepEqual([plan?.kind, plan?.amount, plan?.merchant], ["subscription", 9.99, "DoorDash"]);
  assert.equal(
    parseTransaction(receipt("aaaaaaaa44444444", "2026-07-15", "alice@example.com", "Dinner", "You owe me $20.00")),
    undefined,
    "a person's mail is not a transaction",
  );
  assert.equal(
    parseTransaction(
      receipt("aaaaaaaa55555555", "2026-07-15", "noreply@shop.example", "Weekly deals", "Save big this week!"),
    ),
    undefined,
    "no amount, no row",
  );
  assert.equal(
    parseTransaction(
      receipt(
        "aaaaaaaa88888888",
        "2026-07-15",
        "rewards@customermail.microsoft.com",
        "Last chance to enter the $2,000,000 USD Sweepstakes",
        "Enter now for $2,000,000.00",
      ),
    ),
    undefined,
    "prizes are not transactions",
  );
  assert.equal(
    parseTransaction(
      receipt(
        "aaaaaaaa99999999",
        "2026-07-15",
        "alerts@bank.example",
        "Account alert",
        "Your available balance is $4,113,672.21",
      ),
    ),
    undefined,
    "a balance is not a payment",
  );
  assert.equal(
    parseTransaction(
      receipt(
        "aaaaaaaa00000000",
        "2026-07-15",
        "alerts@bank.example",
        "Account alert",
        "Your card was charged $42.00 at a merchant",
      ),
    )?.amount,
    42,
    "a charge is",
  );
  assert.equal(
    parseTransaction(
      receipt(
        "aaaaaaaa77777777",
        "2026-07-15",
        "no-reply@doordash.com",
        "Order Confirmation for Sam from 7-Eleven - Main St",
        "Total: $8.00",
      ),
    )?.merchant,
    "7-Eleven",
    "a hyphen inside a name is not a separator",
  );
});

test("transaction files are written per year, newest first, with citable ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "roze-transactions-"));
  try {
    const threads = [
      receipt(
        "aaaaaaaa11111111",
        "2026-08-31",
        "no-reply@doordash.com",
        "Order Confirmation for Utkarsh from honeygrow",
        "Total: $15.02",
      ),
      receipt(
        "aaaaaaaa66666666",
        "2025-12-20",
        "no-reply@doordash.com",
        "Order Confirmation for Utkarsh from Bikanervala",
        "Total: $42.10",
      ),
      receipt(
        "aaaaaaaa77777777",
        "2026-01-05",
        "no-reply@doordash.com",
        "Order Confirmation for Utkarsh from Tacoria",
        "Total: $18.00",
      ),
    ];
    assert.equal(writeTransactionFiles(threads, dir), 3);
    const rows = readFileSync(join(dir, "transactions-2026.md"), "utf8").trim().split("\n").slice(2);
    assert.deepEqual(
      rows.map((row) => row.split(" | ").slice(0, 5).join(" | ")),
      [
        "aaaaaaaa11111111 | 2026-08-31 | honeygrow | order | 15.02",
        "aaaaaaaa77777777 | 2026-01-05 | Tacoria | order | 18.00",
      ],
    );
    assert.match(
      readFileSync(join(dir, "transactions-2025.md"), "utf8"),
      /aaaaaaaa66666666 \| 2025-12-20 \| Bikanervala \| order \| 42\.10 \| USD/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
