"use strict";

// Native Stage 5 checks: unique message references for duplicate
// Message-IDs.
// Run: THUNDERBIRD_BIN=... node --test test/native/stage5-model.native.cjs

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness.cjs");
const f = require("./fixtures.cjs");

const ALICE = "mailbox://alice@127.0.0.1";
const INBOX = `${ALICE}/Inbox`;

describe("unique message references (native)", { skip: !h.thunderbirdBinary() && "THUNDERBIRD_BIN not set" }, () => {
  let tb;
  before(async () => {
    tb = await h.startThunderbird({
      mailboxes: {
        alice: {
          Inbox:
            f.simple({ id: "dup@x.test", from: "Boss <boss@corp.test>", to: f.ALLOWED_EMAIL, subject: "Legit contract", text: "LEGIT" }) +
            f.simple({ id: "dup@x.test", from: "Mallory <m@attacker.test>", to: f.ALLOWED_EMAIL, subject: "Spoofed copy", text: "SPOOF" }),
        },
      },
    });
    // Search de-duplicates by Message-ID: two stored messages, one row.
    await tb.waitForMessages(INBOX, 1);
  });
  after(async () => { await tb?.stop(); });

  let candidates;

  it("refuses an ambiguous Message-ID and offers one reference per message", async () => {
    const r = await tb.call("getMessage", { messageId: "dup@x.test", folderPath: INBOX });
    assert.match(r.result.error, /ambiguous/);
    candidates = r.result.candidates;
    assert.equal(candidates.length, 2);
    for (const c of candidates) assert.match(c.messageId, /^msgref:\d+:dup@x\.test$/);
    assert.deepEqual(candidates.map((c) => c.author).sort(), ["Boss <boss@corp.test>", "Mallory <m@attacker.test>"]);
    assert.equal(JSON.stringify(candidates).includes("Spoofed"), false, "no subjects in candidates");
  });

  it("reads exactly the referenced message", async () => {
    const boss = candidates.find((c) => c.author.startsWith("Boss"));
    const r = await tb.call("getMessage", { messageId: boss.messageId, folderPath: INBOX });
    assert.equal(r.result.subject, "Legit contract", JSON.stringify(r.result));
    assert.match(r.result.body, /LEGIT/);
  });

  it("changes exactly the referenced message", async () => {
    const mallory = candidates.find((c) => c.author.startsWith("Mallory"));
    const r = await tb.call("updateMessage", { messageId: mallory.messageId, folderPath: INBOX, flagged: true });
    assert.equal(r.result.success, true, JSON.stringify(r.result));
    const flags = await tb.marionette.run(`
      const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      const folder = MailServices.folderLookup.getFolderForURL(args.uri);
      return [...folder.msgDatabase.enumerateMessages()].map(h => [h.mime2DecodedAuthor, h.isFlagged]);
    `, { uri: INBOX });
    assert.deepEqual(flags.sort(), [["Boss <boss@corp.test>", false], ["Mallory <m@attacker.test>", true]]);
  });

  it("refuses stale and malformed references", async () => {
    const boss = candidates.find((c) => c.author.startsWith("Boss"));
    const key = Number(boss.messageId.split(":")[1]);
    const stale = await tb.call("getMessage", { messageId: `msgref:${key}:other@x.test`, folderPath: INBOX });
    assert.match(stale.result.error, /stale/);
    const missing = await tb.call("getMessage", { messageId: "msgref:999999:dup@x.test", folderPath: INBOX });
    assert.match(missing.result.error, /stale/);
    const malformed = await tb.call("getMessage", { messageId: "msgref:abc:dup@x.test", folderPath: INBOX });
    assert.match(malformed.result.error, /Invalid message reference/);
  });
});
