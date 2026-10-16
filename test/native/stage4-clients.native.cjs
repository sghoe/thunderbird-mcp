"use strict";

// Native Stage 4 checks: paired clients with their own tokens and
// capabilities, per-client account/calendar/address-book scope, the bridge
// marker for inlined local files, revocation and a corrupt registry.
// Run: THUNDERBIRD_BIN=... node --test test/native/stage4-clients.native.cjs

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const h = require("./harness.cjs");
const f = require("./fixtures.cjs");
const { makeAllowedTempDir } = require("../helpers/fixture-dir.cjs");

const ALICE = "mailbox://alice@127.0.0.1";
const BOB = "mailbox://bob@127.0.0.1";
const NS = h.prefNamespace();
const BRIDGE = path.join(h.REPO_ROOT, "mcp-bridge.cjs");

const READ_ONLY = ["accounts.read", "mail.metadata", "mail.body", "attachments.read", "contacts.read", "calendar.read", "filters.read"];
const DRAFTS = [...READ_ONLY, "mail.flag", "compose.draft", "compose.review"];

function viaBridge(connectionFile, token, message) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, THUNDERBIRD_MCP_CONNECTION_FILE: connectionFile, THUNDERBIRD_MCP_TOKEN: token };
    delete env.THUNDERBIRD_MCP_TOKEN_FILE;
    const child = spawn(process.execPath, [BRIDGE], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`bridge timeout: ${err}`)); }, 120000);
    child.stdout.on("data", (d) => {
      out += d;
      const line = out.split("\n").find((l) => l.trim());
      if (line) {
        clearTimeout(timer);
        child.stdin.end();
        child.kill();
        resolve(JSON.parse(line));
      }
    });
    child.stderr.on("data", (d) => { err += d; });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

describe("paired clients (native)", { skip: !h.thunderbirdBinary() && "THUNDERBIRD_BIN not set" }, () => {
  let tb;
  let fixtureDir;
  const folderCount = (uri) => tb.marionette.run(`
    const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
    const folder = MailServices.folderLookup.getFolderForURL(args.uri);
    return [...folder.msgDatabase.enumerateMessages()].length;
  `, { uri });
  const registryPref = () => tb.marionette.run("return Services.prefs.getStringPref(args.name);", { name: `${NS}clients` });
  const setRegistryPref = (value) => tb.marionette.run("Services.prefs.setStringPref(args.name, args.value); return true;", { name: `${NS}clients`, value });

  before(async () => {
    tb = await h.startThunderbird({
      mailboxes: {
        alice: { Inbox: f.simple({ id: "a1@sender.test", from: "Carol <carol@sender.test>", to: f.ALLOWED_EMAIL, subject: "Alice mail", text: "for alice" }) },
        bob: { Inbox: f.simple({ id: "b1@sender.test", from: "Dave <dave@sender.test>", to: "bob@127.0.0.1", subject: "Bob mail", text: "for bob" }) },
      },
      clients: [
        { name: "harness" },
        { name: "reader", profile: "read-only", capabilities: READ_ONLY, accounts: ["account1"], calendars: false, addressBooks: false },
        { name: "drafter", profile: "drafts", capabilities: DRAFTS, accounts: ["account1", "account3"] },
        { name: "revoked", profile: "read-only", capabilities: READ_ONLY },
      ],
    });
    await tb.waitForMessages(`${ALICE}/Inbox`, 1);
    await tb.waitForMessages(`${BOB}/Inbox`, 1);
    fixtureDir = makeAllowedTempDir("tbmcp-stage4-");
  });
  after(async () => {
    await tb?.stop();
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("publishes no secret in the discovery file", () => {
    const data = JSON.parse(fs.readFileSync(tb.connection.file, "utf8"));
    assert.deepEqual(Object.keys(data).sort(), ["pid", "port"]);
  });

  it("refuses unknown, malformed and missing tokens", async () => {
    for (const header of [`Bearer ${"0".repeat(64)}`, "Bearer nope", null]) {
      const r = await tb.rpc("tools/list", {}, { header });
      assert.equal(r.status, 403, String(header));
    }
  });

  it("lists only the tools a client can use", async () => {
    const reader = (await tb.rpc("tools/list", {}, { client: "reader" })).json.result.tools.map((t) => t.name);
    const full = (await tb.rpc("tools/list", {}, { client: "harness" })).json.result.tools.map((t) => t.name);
    assert.ok(reader.includes("getMessage"));
    for (const name of ["sendMail", "saveDraft", "deleteMessages", "createFilter", "emptyTrash"]) {
      assert.equal(reader.includes(name), false, name);
      assert.ok(full.includes(name), name);
    }
  });

  it("refuses ungranted effects without side effects", async () => {
    const sent = tb.smtp.messages.length;
    const send = await tb.call("sendMail", { to: "x@sink.test", subject: "s", body: "b", skipReview: true }, { client: "drafter" });
    assert.match(send.rpcError.message, /requires compose\.send/);
    const [msg] = await tb.waitForMessages(`${ALICE}/Inbox`, 1);
    const exp = await tb.call("getMessage", { messageId: msg.id, folderPath: `${ALICE}/Inbox`, saveAttachments: true }, { client: "reader" });
    assert.match(exp.rpcError.message, /requires attachments\.export/);
    assert.equal(tb.smtp.messages.length, sent);
  });

  it("limits each client to its own accounts, calendars and address books", async () => {
    const own = await tb.call("searchMessages", { query: "", folderPath: `${ALICE}/Inbox` }, { client: "reader" });
    assert.ok(Array.isArray(own.result) && own.result.length >= 1, JSON.stringify(own));
    const other = await tb.call("searchMessages", { query: "", folderPath: `${BOB}/Inbox` }, { client: "reader" });
    assert.ok(other.result?.error || other.rpcError, JSON.stringify(other));
    const full = await tb.call("searchMessages", { query: "", folderPath: `${BOB}/Inbox` }, { client: "harness" });
    assert.ok(Array.isArray(full.result) && full.result.length >= 1, JSON.stringify(full));
    const access = await tb.call("getAccountAccess", {}, { client: "reader" });
    assert.equal(access.result.mode, "restricted");
    assert.deepEqual(access.result.accounts.map((a) => a.id), ["account1"]);
    assert.equal((await tb.call("getAccountAccess", {}, { client: "harness" })).result.mode, "all");
    const cal = await tb.call("listCalendars", {}, { client: "reader" });
    assert.match(cal.result.error, /no access to calendars/);
    const contacts = await tb.call("searchContacts", { query: "a" }, { client: "reader" });
    assert.match(contacts.result.error, /no access to address books/);
  });

  it("the bridge marks local files: drafts client may not attach them, a granted client may", async () => {
    const file = path.join(fixtureDir, "notes.txt");
    fs.writeFileSync(file, "local file content");
    const message = (id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "saveDraft", arguments: {
      to: "x@sink.test", subject: `bridge ${id}`, body: "b", from: f.ALLOWED_EMAIL, attachments: [file],
    } } });
    const before = await folderCount(`${ALICE}/Drafts`).catch(() => 0);
    const refused = await viaBridge(tb.connection.file, tb.clientTokens.drafter, message(1));
    assert.match(refused.error?.message || "", /requires files\.attach/, JSON.stringify(refused));
    const allowed = await viaBridge(tb.connection.file, tb.clientTokens.harness, message(2));
    const result = JSON.parse(allowed.result.content[0].text);
    assert.equal(result.success, true, JSON.stringify(result));
    await h.waitFor(async () => (await folderCount(`${ALICE}/Drafts`)) === before + 1, { label: "one bridge draft" });
  });

  it("revocation applies to the next request", async () => {
    assert.equal((await tb.rpc("tools/list", {}, { client: "revoked" })).status, 200);
    const registry = JSON.parse(await registryPref());
    registry.clients = registry.clients.filter((c) => c.name !== "revoked");
    await setRegistryPref(JSON.stringify(registry));
    assert.equal((await tb.rpc("tools/list", {}, { client: "revoked" })).status, 403);
    assert.equal((await tb.rpc("tools/list", {}, { client: "harness" })).status, 200);
  });

  it("a corrupt registry admits no client and is not repaired silently", async () => {
    const original = await registryPref();
    await setRegistryPref(original.replace('"version":1', '"version":7'));
    try {
      assert.equal((await tb.rpc("tools/list", {}, { client: "harness" })).status, 403);
      assert.equal(JSON.parse(await registryPref()).version, 7);
    } finally {
      await setRegistryPref(original);
    }
    assert.equal((await tb.rpc("tools/list", {}, { client: "harness" })).status, 200);
  });
});

// The options page is the only place to pair clients. Extension pages run in
// the parent process here so Marionette can drive the real UI.
describe("pairing in the options page (native)", { skip: !h.thunderbirdBinary() && "THUNDERBIRD_BIN not set" }, () => {
  let tb;
  before(async () => {
    tb = await h.startThunderbird({ extraPrefs: { "extensions.webextensions.remote": false } });
  });
  after(async () => { await tb?.stop(); });

  const ui = (script, args = {}) => tb.marionette.run(`
    const doc = Services.wm.getMostRecentWindow("mail:3pane").__tbmcpOptionsDoc;
    const until = async (fn, label) => {
      for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 50)); }
      throw new Error("timeout: " + label);
    };
    ${script}
  `, { ...args, id: h.addonId() }, { timeoutMs: 60000 });

  it("opens the options page", async () => {
    const ok = await tb.marionette.run(`
      const url = WebExtensionPolicy.getByID(args.id).getURL("options.html");
      const win = Services.wm.getMostRecentWindow("mail:3pane");
      const tabmail = win.document.getElementById("tabmail");
      const tab = tabmail.openTab("contentTab", { url, background: false });
      for (let i = 0; i < 200; i++) {
        const doc = tab.browser?.contentDocument;
        if (doc?.readyState === "complete" && doc.getElementById("clientProfile")?.options.length) {
          win.__tbmcpOptionsDoc = doc;
          return doc.getElementById("clientList").textContent;
        }
        await new Promise(r => setTimeout(r, 50));
      }
      return null;
    `, { id: h.addonId() }, { timeoutMs: 60000 });
    assert.ok(ok, "options page did not load");
    assert.match(ok, /harness/);
  });

  it("pairs a read-only client, shows its token once and lists it without the token", async () => {
    const { token, list, stored } = await ui(`
      doc.getElementById("clientName").value = "UI reader";
      const profile = doc.getElementById("clientProfile");
      profile.value = "read-only";
      profile.dispatchEvent(new doc.defaultView.Event("change"));
      for (const box of doc.querySelectorAll("#clientAccountList input")) box.checked = box.value === "account1";
      doc.getElementById("createClientBtn").click();
      await until(() => !doc.getElementById("clientTokenBox").hidden && doc.getElementById("clientToken").value, "token");
      await until(() => doc.getElementById("clientList").textContent.includes("UI reader"), "list");
      return {
        token: doc.getElementById("clientToken").value,
        list: doc.getElementById("clientList").textContent,
        stored: Services.prefs.getStringPref(args.pref),
      };
    `, { pref: `${NS}clients` });
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(list.includes(token), false);
    assert.equal(stored.includes(token), false);
    const entry = JSON.parse(stored).clients.find((c) => c.name === "UI reader");
    assert.deepEqual(entry.accounts, ["account1"]);
    assert.equal(entry.profile, "read-only");

    const tools = await tb.rpc("tools/list", {}, { token });
    assert.equal(tools.status, 200);
    const names = tools.json.result.tools.map((t) => t.name);
    assert.ok(names.includes("getMessage"));
    assert.equal(names.includes("sendMail"), false);

    await ui(`
      const item = [...doc.querySelectorAll("#clientList li")].find(li => li.textContent.includes("UI reader"));
      [...item.querySelectorAll("button")].find(b => b.textContent === "Revoke").click();
      await until(() => !doc.getElementById("clientList").textContent.includes("UI reader"), "revoked");
      return true;
    `);
    assert.equal((await tb.rpc("tools/list", {}, { token })).status, 403);
  });

  it("refuses invalid input in the page without writing", async () => {
    const { status, stored } = await ui(`
      const before = Services.prefs.getStringPref(args.pref);
      doc.getElementById("clientName").value = "";
      doc.getElementById("createClientBtn").click();
      await until(() => doc.getElementById("clientStatus").textContent.includes("Client name"), "status");
      return { status: doc.getElementById("clientStatus").textContent, stored: Services.prefs.getStringPref(args.pref) === before };
    `, { pref: `${NS}clients` });
    assert.match(status, /Client name/);
    assert.equal(stored, true);
  });
});