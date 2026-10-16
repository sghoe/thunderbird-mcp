"use strict";

// Native regressions for findings B, C and D on an isolated profile with an
// account restriction: account1 (alice) and Local Folders are allowed,
// account2 (bob) is restricted.
// Run: THUNDERBIRD_BIN=... node --test test/native/stage2-policy.native.cjs

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./harness.cjs");
const f = require("./fixtures.cjs");

const ALICE = "mailbox://alice@127.0.0.1";
const BOB = "mailbox://bob@127.0.0.1";
const NS = h.prefNamespace();

function template(id, subject) {
  return f.simple({ id, from: "Alice Test <alice@allowed.test>", to: "", subject, text: `Template ${subject}` });
}

describe("account-bound policy for templates, drafts and calendar items (native)", { skip: !h.thunderbirdBinary() && "THUNDERBIRD_BIN not set" }, () => {
  let tb;
  const folderCount = (uri) => tb.marionette.run(`
    const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
    const folder = MailServices.folderLookup.getFolderForURL(args.uri);
    return [...folder.msgDatabase.enumerateMessages()].length;
  `, { uri });
  const setPref = (name, value) => tb.marionette.run(
    typeof value === "string"
      ? "Services.prefs.setStringPref(args.name, args.value); return true;"
      : "Services.prefs.setBoolPref(args.name, args.value); return true;",
    { name, value });

  before(async () => {
    tb = await h.startThunderbird({
      mailboxes: {
        alice: {
          Inbox: f.simple({ id: "incoming@sender.test", from: "Carol <carol@sender.test>", to: f.ALLOWED_EMAIL, subject: "Invoice", text: "Hi" }) +
            f.simple({ id: "dup@x.test", from: "Boss <boss@corp.test>", to: f.ALLOWED_EMAIL, subject: "Legit contract", text: "LEGIT" }) +
            f.simple({ id: "dup@x.test", from: "Mallory <m@attacker.test>", to: f.ALLOWED_EMAIL, subject: "Spoofed copy", text: "SPOOF" }),
          Templates: template("alice-tpl@allowed.test", "Thanks"),
        },
        bob: { Templates: template("bob-tpl@blocked.test", "Secret template") },
      },
      extraPrefs: {
        [`${NS}allowedAccounts`]: JSON.stringify(["account1", "account3"]),
        [`${NS}allowFilterSendActions`]: true,
        [`${NS}allowAllCalendars`]: true,
      },
    });
    // Search de-duplicates by Message-ID: 3 stored messages, 2 rows.
    await tb.waitForMessages(`${ALICE}/Inbox`, 2);
  });
  after(async () => { await tb?.stop(); });

  // ── D: new drafts only into the authorized Drafts destination ──
  it("D: saves a new draft into the identity's accessible Drafts folder", async () => {
    const before = await folderCount(`${ALICE}/Drafts`);
    const r = await tb.call("saveDraft", { to: "x@sink.test", subject: "ok", body: "b", from: f.ALLOWED_EMAIL });
    assert.equal(r.result.success, true, r.result.error);
    await h.waitFor(async () => (await folderCount(`${ALICE}/Drafts`)) > before, { label: "draft saved" });
  });

  it("D: refuses a new draft whose identity saves into a restricted account", async () => {
    await setPref("mail.identity.id1.draft_folder", `${BOB}/Drafts`);
    try {
      const before = await folderCount(`${BOB}/Drafts`);
      const r = await tb.call("saveDraft", { to: "x@sink.test", subject: "leak", body: "b", from: f.ALLOWED_EMAIL });
      assert.match(r.result.error, /Drafts folder is not accessible/);
      assert.doesNotMatch(JSON.stringify(r.result), /bob@/);
      await h.sleep(1500);
      assert.equal(await folderCount(`${BOB}/Drafts`), before);
    } finally {
      await setPref("mail.identity.id1.draft_folder", `${ALICE}/Drafts`);
    }
  });

  // ── B: reply templates follow the account restriction ──
  const conditions = [{ attrib: "subject", op: "contains", value: "invoice" }];
  it("B: refuses a reply filter whose template lives in a restricted account", async () => {
    const r = await tb.call("createFilter", { accountId: "account1", name: "Leak", conditions,
      actions: [{ type: "reply", value: `${BOB}/Templates?messageId=bob-tpl@blocked.test&subject=Secret template` }] });
    assert.match(r.result.error, /Reply template folder not accessible/);
    const list = await tb.call("listFilters", { accountId: "account1" });
    assert.equal(JSON.stringify(list.result).includes("Leak"), false);
  });

  it("B: refuses a reply template outside a Templates folder", async () => {
    const r = await tb.call("createFilter", { accountId: "account1", name: "Inbox template", conditions,
      actions: [{ type: "reply", value: `${ALICE}/Inbox?messageId=incoming@sender.test&subject=Invoice` }] });
    assert.match(r.result.error, /Templates flag/);
  });

  it("B: accepts an accessible template, then skips the rule after it is pointed at a restricted one", async () => {
    const created = await tb.call("createFilter", { accountId: "account1", name: "Auto reply", type: 16, conditions,
      actions: [{ type: "reply", value: `${ALICE}/Templates?messageId=alice-tpl@allowed.test&subject=Thanks` }] });
    assert.equal(created.result.success, true, created.result.error);
    // Simulate a rule changed outside MCP (e.g. by another tool or the user).
    await tb.marionette.run(`
      const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
      const server = MailServices.accounts.getAccount("account1").incomingServer;
      const list = server.getFilterList(null);
      for (let i = 0; i < list.filterCount; i++) {
        const filter = list.getFilterAt(i);
        if (filter.filterName === "Auto reply") filter.getActionAt(0).strValue = args.value;
      }
      return true;
    `, { value: `${BOB}/Templates?messageId=bob-tpl@blocked.test&subject=Secret template` });
    const sentBefore = tb.smtp.messages.length;
    const applied = await tb.call("applyFilters", { accountId: "account1", folderPath: `${ALICE}/Inbox` });
    assert.equal(applied.result.success, true, applied.result.error);
    assert.deepEqual(applied.result.skipped.find((s) => s.name === "Auto reply"), { name: "Auto reply", reason: "inaccessible-template" });
    const renamed = await tb.call("updateFilter", { accountId: "account1", filterIndex: 0, name: "Renamed" });
    assert.match(renamed.result.error, /Reply template not accessible/);
    await h.sleep(2000);
    assert.equal(tb.smtp.messages.length, sentBefore);
  });

  // ── C: task tools never modify events ──
  it("C: updateTask refuses an event, even with the review block disabled", async () => {
    const created = await tb.call("createEvent", { title: "Board meeting", startDate: "2030-03-01T10:00:00Z", endDate: "2030-03-01T11:00:00Z",
      calendarId: "testcal", skipReview: true, attendees: [{ email: "guest@external.test" }] });
    assert.equal(created.result.success, true, created.result.error);
    const events = await tb.call("listEvents", { calendarId: "testcal", startDate: "2030-03-01", endDate: "2030-03-02" });
    const event = events.result.find((e) => e.title === "Board meeting");
    const r = await tb.call("updateTask", { taskId: event.id, calendarId: "testcal", title: "Hijacked", completed: true });
    assert.match(r.result.error, /not a task/);
    const after = await tb.call("listEvents", { calendarId: "testcal", startDate: "2030-03-01", endDate: "2030-03-02" });
    assert.ok(after.result.some((e) => e.id === event.id && e.title === "Board meeting"));
  });

  it("C: deleteEvent refuses a task", async () => {
    const created = await tb.call("createTask", { title: "Keep me", calendarId: "testcal", skipReview: true });
    assert.equal(created.result.success, true, created.result.error);
    const tasks = await tb.call("listTasks", { calendarId: "testcal" });
    const task = tasks.result.find((t) => t.title === "Keep me");
    const r = await tb.call("deleteEvent", { eventId: task.id, calendarId: "testcal" });
    assert.match(r.result.error, /not an event/);
    const again = await tb.call("listTasks", { calendarId: "testcal" });
    assert.ok(again.result.some((t) => t.id === task.id));
  });

  // ── Message-ID duplicates are refused instead of silently choosing ──
  for (const [tool, args] of [
    ["getMessage", { messageId: "dup@x.test", folderPath: `${ALICE}/Inbox` }],
    ["deleteMessages", { messageIds: ["dup@x.test"], folderPath: `${ALICE}/Inbox` }],
    ["updateMessage", { messageIds: ["incoming@sender.test", "dup@x.test"], folderPath: `${ALICE}/Inbox`, flagged: true }],
    ["replyToMessage", { messageId: "dup@x.test", folderPath: `${ALICE}/Inbox`, body: "ok", skipReview: true }],
  ]) {
    it(`refuses an ambiguous Message-ID in ${tool} without side effects`, async () => {
      const sent = tb.smtp.messages.length;
      const r = await tb.call(tool, args);
      assert.match(r.result.error, /Message-ID is ambiguous/);
      const rows = await tb.call("searchMessages", { query: "", folderPath: `${ALICE}/Inbox`, dedupByMessageId: false });
      assert.equal(rows.result.filter((m) => m.id === "dup@x.test").length, 2);
      assert.equal(rows.result.some((m) => m.flagged), false);
      assert.equal(tb.smtp.messages.length, sent);
    });
  }
});