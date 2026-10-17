"use strict";

// Native: the optional diagnostic log records operations and outcomes and
// nothing sensitive; when it is off (default) no file is written.
// Run: THUNDERBIRD_BIN=... node --test test/native/diagnostic-log.native.cjs

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const h = require("./harness.cjs");
const f = require("./fixtures.cjs");

const INBOX = "mailbox://alice@127.0.0.1/Inbox";
const logFile = (tb) => path.join(tb.profileDir, "thunderbird-mcp-hardened", "diagnostic.log");

describe("diagnostic log (native)", { skip: !h.thunderbirdBinary() && "THUNDERBIRD_BIN not set" }, () => {
  let tb;
  before(async () => {
    tb = await h.startThunderbird({
      mailboxes: { alice: { Inbox: f.simple({ id: "diag@x.test", subject: "Quarterly salaries", text: "secret body" }) } },
      clients: [{ name: "harness" }, { name: "reader", capabilities: ["accounts.read"] }],
      extraPrefs: { [`${h.prefNamespace()}diagnosticLog`]: true },
    });
    await tb.waitForMessages(INBOX, 1);
  });
  after(async () => { await tb?.stop(); });

  it("records outcomes, refusals and redacted errors without content", async () => {
    await tb.call("listAccounts", {});
    await tb.call("getMessage", { messageId: "diag@x.test", folderPath: INBOX });
    await tb.call("getMessage", { messageId: "missing.person@secret.test", folderPath: INBOX });
    await tb.call("getMessage", { messageId: "diag@x.test", folderPath: INBOX }, { client: "reader" });
    const send = await tb.call("sendMail", { to: "bob.private@sink.test", subject: "Layoff list", body: "very secret", skipReview: true });
    assert.equal(send.result.operationState, "completed", JSON.stringify(send.result)); // the harness profile allows direct sending
    const text = fs.readFileSync(logFile(tb), "utf8");
    const entries = text.trim().split("\n").map((line) => JSON.parse(line));
    const tools = entries.filter((e) => e.event === "tool");
    assert.ok(entries.some((e) => e.event === "server" && e.outcome === "started"));
    assert.ok(tools.some((e) => e.tool === "listAccounts" && e.outcome === "ok" && e.client === "harness" && Number.isInteger(e.ms)));
    assert.ok(tools.some((e) => e.tool === "getMessage" && e.outcome === "error" && /Message not found: <addr>/.test(e.error)));
    assert.ok(tools.some((e) => e.tool === "getMessage" && e.outcome === "refused" && e.client === "reader" && e.missing.includes("mail.body")));
    assert.ok(tools.some((e) => e.tool === "sendMail" && e.outcome === "ok" && e.operationState === "completed"));
    for (const secret of ["missing.person", "secret.test", "bob.private", "Layoff", "very secret", "Quarterly", "secret body", "diag@x.test", "127.0.0.1"]) {
      assert.equal(text.includes(secret), false, `log must not contain ${secret}`);
    }
    for (const token of Object.values(tb.clientTokens)) assert.equal(text.includes(token), false, "no token");
  });

  it("logs refused unauthenticated requests without the presented token", async () => {
    const bogus = "f".repeat(64);
    const r = await tb.rpc("tools/list", {}, { header: `Bearer ${bogus}` });
    assert.equal(r.status, 403);
    const text = fs.readFileSync(logFile(tb), "utf8");
    const entries = text.trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(entries.some((e) => e.event === "request" && e.outcome === "refused" && e.status === 403 && e.detail === "auth" && e.client === undefined));
    assert.equal(text.includes(bogus), false);
  });
});

describe("diagnostic log off by default (native)", { skip: !h.thunderbirdBinary() && "THUNDERBIRD_BIN not set" }, () => {
  let tb;
  // Extension pages in the parent process so Marionette can drive the options page.
  before(async () => { tb = await h.startThunderbird({ extraPrefs: { "extensions.webextensions.remote": false } }); });
  after(async () => { await tb?.stop(); });

  it("writes no file", async () => {
    await tb.call("listAccounts", {});
    await tb.call("getMessage", { messageId: "missing@x.test", folderPath: INBOX });
    assert.equal(fs.existsSync(logFile(tb)), false);
  });

  it("is switched on, shown and deleted in the options page", async () => {
    const view = await tb.marionette.run(`
      const url = WebExtensionPolicy.getByID(args.id).getURL("options.html");
      const win = Services.wm.getMostRecentWindow("mail:3pane");
      const tab = win.document.getElementById("tabmail").openTab("contentTab", { url, background: false });
      const wait = async (check) => {
        for (let i = 0; i < 200; i++) {
          const value = check();
          if (value) return value;
          await new Promise(r => setTimeout(r, 50));
        }
        throw new Error("options page did not react");
      };
      const doc = await wait(() => {
        const d = tab.browser?.contentDocument;
        return d?.readyState === "complete" && d.getElementById("diagnosticLogPath")?.textContent.includes("diagnostic.log") ? d : null;
      });
      const box = doc.getElementById("diagnosticLog");
      if (box.checked) throw new Error("must be off by default");
      box.click();
      await wait(() => doc.getElementById("diagnosticLogStatus").textContent === "Logging on.");
      doc.getElementById("showDiagnosticLogBtn").click();
      const shown = await wait(() => !doc.getElementById("diagnosticLogView").hidden && doc.getElementById("diagnosticLogView").textContent.includes("log-enabled") && doc.getElementById("diagnosticLogView").textContent);
      doc.getElementById("clearDiagnosticLogBtn").click();
      await wait(() => doc.getElementById("diagnosticLogStatus").textContent === "Deleted.");
      box.click();
      await wait(() => doc.getElementById("diagnosticLogStatus").textContent === "Logging off.");
      return shown;
    `, { id: h.addonId() }, { timeoutMs: 60000 });
    assert.match(view, /"event":"server","outcome":"log-enabled"/);
    const pref = await tb.marionette.run(`return Services.prefs.getBoolPref(args.name, false);`, { name: `${h.prefNamespace()}diagnosticLog` });
    assert.equal(pref, false, "switched off again");
    // Switching off records the switch, after the deletion.
    const lines = fs.readFileSync(logFile(tb), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((e) => e.outcome), ["log-disabled"]);
  });
});
