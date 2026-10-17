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
    for (const c of candidates) assert.match(c.messageId, /^msgref:\d+:\d+:dup@x\.test$/);
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
    const [, key, date] = boss.messageId.split(":");
    const stale = await tb.call("getMessage", { messageId: `msgref:${key}:${date}:other@x.test`, folderPath: INBOX });
    assert.match(stale.result.error, /stale/);
    const otherDate = await tb.call("getMessage", { messageId: `msgref:${key}:${Number(date) + 1}:dup@x.test`, folderPath: INBOX });
    assert.match(otherDate.result.error, /stale/, "the date is part of the reference");
    assert.match(stale.result.error, /stale/);
    const missing = await tb.call("getMessage", { messageId: `msgref:999999:${date}:dup@x.test`, folderPath: INBOX });
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

// Honest operation states: what the result says matches what the SMTP sink
// and Thunderbird actually observed; nothing is retried.
describe("operation states (native)", { skip: !h.thunderbirdBinary() && "THUNDERBIRD_BIN not set" }, () => {
  let tb;
  before(async () => {
    tb = await h.startThunderbird({ mailboxes: { alice: { Inbox: f.simple({ id: "orig@x.test", subject: "Original", text: "x" }) } } });
    await tb.waitForMessages(INBOX, 1);
  });
  after(async () => { await tb?.stop(); });
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  // Thunderbird reports failed sends in its own alert; Marionette dismisses
  // an open alert on the next command and reports it, so retry once.
  const closeWindows = async () => {
    try { return await closeWindowsOnce(); } catch (e) {
      if (!/unexpected alert open/i.test(e.message)) throw e;
      return closeWindowsOnce();
    }
  };
  const closeWindowsOnce = () => tb.marionette.run(`
    let closed = 0;
    for (const type of ["msgcompose", "Calendar:EventDialog", "Calendar:EventSummaryDialog"]) {
      for (const win of Services.wm.getEnumerator(type)) { win.close(); closed++; }
    }
    for (const win of Services.wm.getEnumerator(null)) {
      if (win.document?.documentElement?.id === "commonDialogWindow") { win.close(); closed++; }
    }
    return closed;
  `);

  it("reports completed when the server confirmed delivery", async () => {
    tb.smtp.mode = "accept";
    const before = tb.smtp.messages.length;
    const r = await tb.call("sendMail", { to: "ok@sink.test", subject: "state ok", body: "b", skipReview: true });
    assert.equal(r.result.operationState, "completed", JSON.stringify(r.result));
    assert.equal(tb.smtp.messages.length, before + 1);
  });

  it("reports failed when the server refused the recipient", async () => {
    tb.smtp.mode = "reject-rcpt";
    const before = tb.smtp.messages.length;
    const r = await tb.call("sendMail", { to: "nobody@sink.test", subject: "state refused", body: "b", skipReview: true });
    tb.smtp.mode = "accept";
    assert.equal(r.result.operationState, "failed", JSON.stringify(r.result));
    assert.doesNotMatch(r.result.error, /may have accepted/);
    assert.equal(tb.smtp.messages.length, before);
    await closeWindows();
  });

  it("reports unknown when the connection broke after the message was handed over, and never resends", async () => {
    tb.smtp.mode = "reset-after-data";
    const before = tb.smtp.messages.length;
    const r = await tb.call("sendMail", { to: "maybe@sink.test", subject: "state reset", body: "b", skipReview: true });
    assert.equal(r.result.operationState, "unknown", JSON.stringify(r.result));
    assert.match(r.result.error, /check Sent before retrying/);
    assert.equal(tb.smtp.messages.length, before + 1, "the server did receive it");
    tb.smtp.mode = "accept";
    await settle(3000);
    assert.equal(tb.smtp.messages.length, before + 1, "no automatic resend");
    await closeWindows();
  });

  it("reports opened-for-review for the compose window and completed for a saved draft", async () => {
    const before = tb.smtp.messages.length;
    const review = await tb.call("sendMail", { to: "review@sink.test", subject: "state review", body: "b" });
    assert.equal(review.result.operationState, "opened-for-review", JSON.stringify(review.result));
    const draft = await tb.call("saveDraft", { to: "draft@sink.test", subject: "state draft", body: "b" });
    assert.equal(draft.result.operationState, "completed", JSON.stringify(draft.result));
    // Native compose-window save: confirmed by the draft's Message-ID in Drafts.
    const replyDraft = await tb.call("replyToMessage", { messageId: "orig@x.test", folderPath: INBOX, body: "r", saveAsDraft: true });
    assert.equal(replyDraft.result.operationState, "completed", JSON.stringify(replyDraft.result));
    assert.ok(await closeWindows() >= 1);
    assert.equal(tb.smtp.messages.length, before);
  });

  it("reports failed for a refusal before any effect", async () => {
    const r = await tb.call("forwardMessage", { messageId: "missing@x.test", folderPath: INBOX, to: "x@sink.test", skipReview: true });
    assert.ok(r.result.error, JSON.stringify(r.result));
    assert.equal(r.result.operationState, "failed");
    const other = await tb.call("getMessage", { messageId: "missing@x.test", folderPath: INBOX });
    assert.equal(other.result.operationState, undefined, "only sending, draft and calendar tools carry a state");
  });

  it("reports submitted for a direct calendar write and opened-for-review for the dialog", async () => {
    const event = { title: "State event", startDate: "2030-01-02T10:00:00Z", endDate: "2030-01-02T11:00:00Z", calendarId: "testcal" };
    const direct = await tb.call("createEvent", { ...event, skipReview: true });
    assert.equal(direct.result.operationState, "submitted", JSON.stringify(direct.result));
    const dialog = await tb.call("createEvent", event);
    assert.equal(dialog.result.operationState, "opened-for-review", JSON.stringify(dialog.result));
    await settle(500);
    await closeWindows();
  });
});

// A path attachment is bound to the content it had when it was checked:
// replacing the file while the review window is open changes nothing.
describe("content-bound path attachments (native)", { skip: !h.thunderbirdBinary() && "THUNDERBIRD_BIN not set" }, () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { makeAllowedTempDir } = require("../helpers/fixture-dir.cjs");
  let tb;
  let dir;
  before(async () => {
    // A directory the attachment policy allows (Windows temp lies in AppData).
    dir = makeAllowedTempDir("tb-mcp-stage5-");
    tb = await h.startThunderbird({});
  });
  after(async () => {
    await tb?.stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });
  const outgoingFiles = () => tb.marionette.run(`
    const dir = Services.dirsvc.get("TmpD", Ci.nsIFile);
    dir.append("thunderbird-mcp-hardened");
    dir.append("outgoing");
    return dir.exists() ? [...dir.directoryEntries].map(f => f.leafName) : [];
  `);

  it("sends the reviewed content even if the file is replaced before Send", async () => {
    const file = path.join(dir, "report.txt");
    fs.writeFileSync(file, "VERSION-A reviewed content");
    const before = tb.smtp.messages.length;
    const r = await tb.call("sendMail", { to: "review@sink.test", subject: "bound attachment", body: "b", attachments: [file] });
    assert.equal(r.result.operationState, "opened-for-review", JSON.stringify(r.result));
    assert.equal((await outgoingFiles()).filter((n) => n.endsWith("_report.txt")).length, 1, "private copy while the window is open");
    const ready = await tb.marionette.run(`
      for (let i = 0; i < 100; i++) {
        const win = Services.wm.getMostRecentWindow("msgcompose");
        if (win?.gAttachmentBucket?.itemCount === 1) return true;
        await new Promise(r => setTimeout(r, 100));
      }
      return false;
    `);
    assert.equal(ready, true, "compose window with one attachment");
    fs.writeFileSync(file, "VERSION-B swapped after review!!");
    await tb.marionette.run(`Services.wm.getMostRecentWindow("msgcompose").goDoCommand("cmd_sendNow"); return true;`);
    const deadline = Date.now() + 30000;
    while (tb.smtp.messages.length === before && Date.now() < deadline) await new Promise((res) => setTimeout(res, 200));
    assert.equal(tb.smtp.messages.length, before + 1, "message sent from the review window");
    const data = tb.smtp.messages.at(-1).data;
    const part = /filename="report\.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n(?:\r\n)?--/.exec(data);
    assert.ok(part, "base64 attachment part");
    const sent = Buffer.from(part[1].replace(/\s/g, ""), "base64").toString("utf8");
    assert.equal(sent, "VERSION-A reviewed content");
  });

  it("keeps the copy of an open review window when the add-on is disabled and re-enabled", async () => {
    const file = path.join(dir, "reload.txt");
    fs.writeFileSync(file, "RELOAD-A reviewed content");
    const before = tb.smtp.messages.length;
    const r = await tb.call("sendMail", { to: "reload@sink.test", subject: "reload attachment", body: "b", attachments: [file] });
    assert.equal(r.result.operationState, "opened-for-review", JSON.stringify(r.result));
    const url = await tb.marionette.run(`
      for (let i = 0; i < 100; i++) {
        const win = Services.wm.getMostRecentWindow("msgcompose");
        const item = win?.gAttachmentBucket?.itemChildren?.[0];
        if (item?.attachment?.url) return item.attachment.url;
        await new Promise(r => setTimeout(r, 100));
      }
      return null;
    `);
    assert.match(url || "", /thunderbird-mcp-hardened\/outgoing\/\d+_\d+_reload\.txt$/, "the window attaches the private copy");
    await tb.marionette.run(`
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const addon = await AddonManager.getAddonByID(args.id);
      await addon.disable();
      await addon.enable();
      return true;
    `, { id: h.addonId() });
    await tb.reconnect();
    assert.equal((await outgoingFiles()).filter((n) => n.endsWith("_reload.txt")).length, 1, "copy kept for the open window");
    fs.writeFileSync(file, "RELOAD-B swapped");
    await tb.marionette.run(`Services.wm.getMostRecentWindow("msgcompose").goDoCommand("cmd_sendNow"); return true;`);
    const deadline = Date.now() + 30000;
    while (tb.smtp.messages.length === before && Date.now() < deadline) await new Promise((res) => setTimeout(res, 200));
    assert.equal(tb.smtp.messages.length, before + 1, "message sent from the review window");
    const part = /filename="reload\.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n(?:\r\n)?--/.exec(tb.smtp.messages.at(-1).data);
    assert.ok(part, "base64 attachment part");
    assert.equal(Buffer.from(part[1].replace(/\s/g, ""), "base64").toString("utf8"), "RELOAD-A reviewed content");
  });
  it("removes the private copy after a completed direct send", async () => {
    const file = path.join(dir, "direct.txt");
    fs.writeFileSync(file, "direct content");
    const r = await tb.call("sendMail", { to: "x@sink.test", subject: "direct attachment", body: "b", attachments: [file], skipReview: true });
    assert.equal(r.result.operationState, "completed", JSON.stringify(r.result));
    assert.match(tb.smtp.messages.at(-1).data, /filename="?direct\.txt"?/);
    assert.equal((await outgoingFiles()).filter((n) => n.endsWith("_direct.txt")).length, 0);
  });

  it("hands kept copies to the re-enabled add-on, which removes them at application shutdown", async () => {
    const file = path.join(dir, "handoff.txt");
    fs.writeFileSync(file, "handoff content");
    const r = await tb.call("sendMail", { to: "handoff@sink.test", subject: "handoff", body: "b", attachments: [file] });
    assert.equal(r.result.operationState, "opened-for-review", JSON.stringify(r.result));
    await tb.marionette.run(`
      for (let i = 0; i < 100; i++) {
        const win = Services.wm.getMostRecentWindow("msgcompose");
        if (win?.gAttachmentBucket?.itemCount === 1) return true;
        await new Promise(r => setTimeout(r, 100));
      }
      return false;
    `);
    await tb.marionette.run(`
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const addon = await AddonManager.getAddonByID(args.id);
      await addon.disable();
      await addon.enable();
      return true;
    `, { id: h.addonId() });
    await tb.reconnect();
    const outgoing = path.join(tb.tmpDir, "thunderbird-mcp-hardened", "outgoing");
    const kept = fs.readdirSync(outgoing).filter((n) => n.endsWith("_handoff.txt"));
    assert.equal(kept.length, 1, "kept for the open window");
    const pref = await tb.marionette.run(`return Services.prefs.getStringPref("extensions.thunderbird-mcp-hardened.retainedAttachments.0", "");`);
    assert.equal(pref, "", "the new instance took the hand-over");
    // Quit Thunderbird (no prompts); the adopting instance must remove the file.
    try { await tb.marionette.run(`Services.startup.quit(Ci.nsIAppStartup.eForceQuit); return true;`); } catch { /* connection ends */ }
    const deadline = Date.now() + 30000;
    while (tb.child.exitCode === null && Date.now() < deadline) await new Promise((res) => setTimeout(res, 200));
    assert.notEqual(tb.child.exitCode, null, "Thunderbird exited");
    assert.equal(fs.readdirSync(outgoing).filter((n) => n.endsWith("_handoff.txt")).length, 0, "removed at application shutdown");
  });
});