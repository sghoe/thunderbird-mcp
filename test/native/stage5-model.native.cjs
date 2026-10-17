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

// Revoking a client stops its registered automatic sending rules; rules the
// user changed afterwards are reported, not disabled.
describe("filter register and revocation (native)", { skip: !h.thunderbirdBinary() && "THUNDERBIRD_BIN not set" }, () => {
  let tb;
  const NS = h.prefNamespace();
  before(async () => {
    tb = await h.startThunderbird({
      extraPrefs: { "extensions.webextensions.remote": false, [`${NS}allowFilterSendActions`]: true, "mail.forward_message_mode": 0 },
      clients: [{ name: "harness" }, { name: "rule-maker" }],
    });
  });
  after(async () => { await tb?.stop(); });

  const rule = (name, value, subject) => tb.call("createFilter", {
    accountId: "account1", name, type: 17,
    conditions: [{ attrib: "subject", op: "contains", value: subject }], actions: [{ type: "forward", value }],
  }, { client: "rule-maker" });

  it("revocation in the options page disables unchanged registered sending rules and reports changed ones", async () => {
    assert.equal((await rule("Kept forward", "a@sink.test", "one")).result?.success, true);
    assert.equal((await rule("User-changed forward", "b@sink.test", "two")).result?.success, true);
    // The user changes the second rule directly in Thunderbird.
    await tb.marionette.run(`
      const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      const list = MailServices.accounts.getAccount("account1").incomingServer.getFilterList(null);
      for (let i = 0; i < list.filterCount; i++) {
        const filter = list.getFilterAt(i);
        if (filter.filterName === "User-changed forward") filter.getActionAt(0).strValue = "c@sink.test";
      }
      // Windows can briefly lock the rules file right after the previous save.
      for (let attempt = 0; ; attempt++) {
        try { list.saveToDefaultFile(); break; }
        catch (e) {
          if (attempt >= 20) throw e;
          await new Promise(r => setTimeout(r, 100));
        }
      }
      return true;
    `);
    const status = await tb.marionette.run(`
      const url = WebExtensionPolicy.getByID(args.id).getURL("options.html");
      const win = Services.wm.getMostRecentWindow("mail:3pane");
      const tab = win.document.getElementById("tabmail").openTab("contentTab", { url, background: false });
      let doc;
      for (let i = 0; i < 200; i++) {
        doc = tab.browser?.contentDocument;
        if (doc?.readyState === "complete" && doc.getElementById("clientList")?.textContent.includes("rule-maker")) break;
        await new Promise(r => setTimeout(r, 50));
      }
      const item = [...doc.querySelectorAll("#clientList li")].find(li => li.textContent.includes("rule-maker"));
      [...item.querySelectorAll("button")].find(b => b.textContent === "Revoke").click();
      for (let i = 0; i < 200; i++) {
        const text = doc.getElementById("clientStatus").textContent;
        if (text.includes("Revoked")) return text;
        await new Promise(r => setTimeout(r, 50));
      }
      return null;
    `, { id: h.addonId() }, { timeoutMs: 60000 });
    assert.match(status, /Disabled automatic sending rules: "Kept forward" \(account1\)/);
    assert.match(status, /User-changed forward.*changed or removed/);
    const list = await tb.call("listFilters", { accountId: "account1" });
    const byName = Object.fromEntries(list.result[0].filters.map((x) => [x.name, x.enabled]));
    assert.deepEqual(byName, { "Kept forward": false, "User-changed forward": true });
  });
});