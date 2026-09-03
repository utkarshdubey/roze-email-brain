import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EnronMaildirClient, normalizeSubject } from "../bench/enron/enronClient.js";

function mail(id: string, from: string, to: string, subject: string, date: string, body: string): string {
  return `Message-ID: <${id}.JavaMail.evans@thyme>\nDate: ${date}\nFrom: ${from}\nTo: ${to}\nSubject: ${subject}\nX-Folder: x\n\n${body}\n`;
}

test("an Enron inbox becomes threads with sender-local days and the owner inferred from sent folders", async () => {
  const root = mkdtempSync(join(tmpdir(), "roze-enron-"));
  try {
    mkdirSync(join(root, "sent"));
    mkdirSync(join(root, "inbox"));
    mkdirSync(join(root, "all_documents"));
    writeFileSync(
      join(root, "inbox", "1."),
      mail(
        "1",
        "elizabeth.sager@enron.com",
        "stephanie.panus@enron.com",
        "Ameren termination",
        "Thu, 27 Dec 2001 13:13:00 -0800 (PST)",
        "We received a termination notice.",
      ),
    );
    writeFileSync(
      join(root, "sent", "2."),
      mail(
        "2",
        "stephanie.panus@enron.com",
        "elizabeth.sager@enron.com",
        "RE: Ameren termination",
        "Thu, 27 Dec 2001 13:31:00 -0800 (PST)",
        "Forwarding to Don, Kevin and Ed.",
      ),
    );
    writeFileSync(
      join(root, "all_documents", "3."),
      mail(
        "2",
        "stephanie.panus@enron.com",
        "elizabeth.sager@enron.com",
        "RE: Ameren termination",
        "Thu, 27 Dec 2001 13:31:00 -0800 (PST)",
        "Forwarding to Don, Kevin and Ed.",
      ),
    );
    writeFileSync(
      join(root, "inbox", "4."),
      mail(
        "4",
        "news@enron.com",
        "stephanie.panus@enron.com",
        "Weekly",
        "Fri, 28 Dec 2001 09:00:00 -0800 (PST)",
        "Digest.",
      ),
    );
    const client = new EnronMaildirClient(root);
    assert.equal(client.userEmail, "stephanie.panus@enron.com");
    assert.deepEqual(
      { messages: client.messageCount, threads: client.threadCount, latest: client.latestDay },
      { messages: 3, threads: 2, latest: "2001-12-28" },
    );
    const [sentThread] = await client.listThreadIds("in:sent -in:chats");
    assert.equal(
      (await client.listThreadIds("in:sent -in:chats")).length,
      1,
      "only participated threads are listed as sent",
    );
    const thread = await client.fetchThread(sentThread!);
    assert.deepEqual(
      thread.messages.map((message) => [message.day, message.date, message.labels[0]]),
      [
        ["2001-12-27", "2001-12-27T13:13:00-08:00", "INBOX"],
        ["2001-12-27", "2001-12-27T13:31:00-08:00", "SENT"],
      ],
    );
    assert.equal(client.threadIdForPath("all_documents/3."), sentThread, "duplicates map to the same thread");
    assert.deepEqual(await client.listThreadIds("is:starred -in:chats"), []);
    const skim = await client.listMessageIds("anything");
    assert.equal(skim.length, 1);
    assert.equal((await client.fetchMessageHeaders(skim[0]!)).subject, "Weekly");
    assert.equal(normalizeSubject("Re: FW: re: Ameren  termination"), "ameren termination");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
