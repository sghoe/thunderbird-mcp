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

// Filters run with the authority of the client that creates or runs them.
describe("filters respect the client's sender account and permanent deletion (native)", { skip: !h.thunderbirdBinary() && "THUNDERBIRD_BIN not set" }, () => {
  let tb;
  const LOCAL = "mailbox://nobody@Local%20Folders";
  const subjectIs = (value) => [{ attrib: "subject", op: "contains", value }];
  const folderCount = (uri) => tb.marionette.run(`
    const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
    return [...MailServices.folderLookup.getFolderForURL(args.uri).msgDatabase.enumerateMessages()].length;
  `, { uri });

  before(async () => {
    tb = await h.startThunderbird({
      mailboxes: {
        alice: {
          Inbox: f.simple({ id: "fwd@sender.test", from: "Carol <carol@sender.test>", to: f.ALLOWED_EMAIL, subject: "Forward me", text: "x" }),
          Trash: f.simple({ id: "trash@sender.test", from: "Carol <carol@sender.test>", to: f.ALLOWED_EMAIL, subject: "Trashed", text: "x" }),
        },
        "Local Folders": { Inbox: f.simple({ id: "local@sender.test", from: "Eve <eve@sender.test>", to: "nobody@local", subject: "Local forward", text: "x" }) },
      },
      // Forward as attachment: tests the sender-account rule on its own.
      extraPrefs: { [`${NS}allowFilterSendActions`]: true, "mail.forward_message_mode": 0 },
      clients: [
        { name: "harness" },
        { name: "local-filters", capabilities: ["accounts.read", "mail.metadata", "filters.read", "filters.manage", "filters.run", "filters.autosend"], accounts: ["account3"] },
        { name: "trash-filters", capabilities: ["accounts.read", "mail.metadata", "filters.read", "filters.manage", "filters.run", "mail.delete"], accounts: ["account1"] },
      ],
    });
    await tb.waitForMessages(`${ALICE}/Inbox`, 1);
    await tb.waitForMessages(`${ALICE}/Trash`, 1);
    await tb.waitForMessages(`${LOCAL}/Inbox`, 1);
  });
  after(async () => { await tb?.stop(); });

  it("refuses Forward rules where Thunderbird would send from another account", async () => {
    const sent = tb.smtp.messages.length;
    const r = await tb.call("createFilter", {
      accountId: "account3", name: "Local forward", type: 16, conditions: subjectIs("Local forward"),
      actions: [{ type: "forward", value: "target@sink.test" }],
    }, { client: "local-filters" });
    assert.match(r.result.error, /may only send through accessible accounts/, JSON.stringify(r));
    await h.sleep(1000);
    assert.equal(tb.smtp.messages.length, sent);
  });

  it("allows Local Folders Forward rules for a client that may use the default account (Thunderbird's fallback)", async () => {
    const r = await tb.call("createFilter", {
      accountId: "account3", name: "Local forward (full access)", type: 16, conditions: subjectIs("never matches 42"),
      actions: [{ type: "forward", value: "target@sink.test" }],
    });
    assert.equal(r.result.success, true, JSON.stringify(r));
  });
  it("still forwards through the account's own identity (positive control)", async () => {
    const sent = tb.smtp.messages.length;
    const created = await tb.call("createFilter", {
      accountId: "account1", name: "Alice forward", type: 16, conditions: subjectIs("Forward me"),
      actions: [{ type: "forward", value: "target@sink.test" }],
    });
    assert.equal(created.result.success, true, JSON.stringify(created));
    const applied = await tb.call("applyFilters", { accountId: "account1", folderPath: `${ALICE}/Inbox` });
    assert.deepEqual(applied.result.submitted, ["Alice forward"], JSON.stringify(applied));
    await h.waitFor(() => tb.smtp.messages.length > sent, { label: "forwarded message" });
    assert.match(tb.smtp.messages.at(-1).from || JSON.stringify(tb.smtp.messages.at(-1)), /alice/i);
  });

  it("does not let a Delete rule purge Trash without mail.deletePermanent", async () => {
    const created = await tb.call("createFilter", {
      accountId: "account1", name: "Purge", type: 16, conditions: subjectIs("Trashed"), actions: [{ type: "delete" }],
    }, { client: "trash-filters" });
    assert.equal(created.result.success, true, JSON.stringify(created));
    const applied = await tb.call("applyFilters", { accountId: "account1", folderPath: `${ALICE}/Trash` }, { client: "trash-filters" });
    assert.ok(applied.result.skipped.some((s) => s.name === "Purge" && s.reason === "missing-capability"), JSON.stringify(applied));
    await h.sleep(1500);
    assert.equal(await folderCount(`${ALICE}/Trash`), 1);
  });
});

// Thunderbird may choose the sender identity itself: inline forwarding honours
// the original's X-Identity-Key header (libmime), reply/forward windows may
// switch identities. A client must not end up preparing or sending mail from
// an account it may not use.
describe("native identity selection stays within the client's accounts (native)", { skip: !h.thunderbirdBinary() && "THUNDERBIRD_BIN not set" }, () => {
  let tb;
  const composeWindows = () => tb.marionette.run(`
    return [...Services.wm.getEnumerator("msgcompose")].map(w => w.gCurrentIdentity?.key || null);
  `);
  const closeComposeWindows = () => tb.marionette.run(`
    for (const w of [...Services.wm.getEnumerator("msgcompose")]) w.close();
    return true;
  `);

  before(async () => {
    tb = await h.startThunderbird({
      headless: true,
      mailboxes: {
        alice: {
          Inbox: f.message({ id: "idkey@sender.test", from: "Carol <carol@sender.test>", to: f.ALLOWED_EMAIL, subject: "Identity override",
            headers: ["X-Identity-Key: id2"], contentType: "text/plain; charset=utf-8", body: "pick bob" }) +
            f.simple({ id: "plain@sender.test", from: "Carol <carol@sender.test>", to: f.ALLOWED_EMAIL, subject: "Plain", text: "x" }),
        },
      },
      extraPrefs: { [`${NS}allowFilterSendActions`]: true, "mail.forward_message_mode": 2 },
      clients: [
        { name: "harness" },
        { name: "alice-only", accounts: ["account1", "account3"] },
      ],
    });
    await tb.waitForMessages(`${ALICE}/Inbox`, 2);
  });
  after(async () => { await tb?.stop(); });

  it("closes a review window Thunderbird opened with an identity of a restricted account", async () => {
    const r = await tb.call("forwardMessage", {
      messageId: "idkey@sender.test", folderPath: `${ALICE}/Inbox`, to: "target@sink.test", from: "id1",
    }, { client: "alice-only" });
    assert.match(r.result?.error || "", /sender identity of an account this client may not use/, JSON.stringify(r));
    await h.waitFor(async () => (await composeWindows()).length === 0, { label: "compose window closed" });
  });

  it("still opens review windows with an allowed identity (positive control)", async () => {
    await closeComposeWindows();
    const r = await tb.call("forwardMessage", {
      messageId: "plain@sender.test", folderPath: `${ALICE}/Inbox`, to: "target@sink.test", from: "id1",
    }, { client: "alice-only" });
    assert.equal(r.result?.success, true, JSON.stringify(r));
    assert.deepEqual(await composeWindows(), ["id1"]);
    await closeComposeWindows();
  });

  it("refuses inline Forward filter rules while identities of restricted accounts exist", async () => {
    const sent = tb.smtp.messages.length;
    const created = await tb.call("createFilter", {
      accountId: "account1", name: "Inline forward", type: 16,
      conditions: [{ attrib: "subject", op: "contains", value: "Identity override" }],
      actions: [{ type: "forward", value: "target@sink.test" }],
    }, { client: "alice-only" });
    assert.match(created.result?.error || "", /forwards inline/, JSON.stringify(created));
    await h.sleep(1000);
    assert.equal(tb.smtp.messages.length, sent);
  });
});

// Sending files a copy into the identity's Sent folder, which may belong to
// another account.
describe("sent copies stay within the client's accounts (native)", { skip: !h.thunderbirdBinary() && "THUNDERBIRD_BIN not set" }, () => {
  let tb;
  const BOB = "mailbox://bob@127.0.0.1";
  const folderCount = (uri) => tb.marionette.run(`
    const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
    return [...MailServices.folderLookup.getFolderForURL(args.uri).msgDatabase.enumerateMessages()].length;
  `, { uri });
  before(async () => {
    tb = await h.startThunderbird({
      extraPrefs: {
        "mail.identity.id1.fcc": true,
        "mail.identity.id1.fcc_folder_picker_mode": "1",
        "mail.identity.id1.fcc_folder": `${BOB}/Sent`,
      },
      clients: [{ name: "harness" }, { name: "alice-only", accounts: ["account1", "account3"] }],
    });
  });
  after(async () => { await tb?.stop(); });

  it("refuses a direct send whose Sent copy would land in a restricted account", async () => {
    const sent = tb.smtp.messages.length;
    const before = await folderCount(`${BOB}/Sent`);
    const r = await tb.call("sendMail", { to: "x@sink.test", subject: "fcc", body: "b", from: "id1", skipReview: true }, { client: "alice-only" });
    assert.match(r.result?.error || "", /sent copies into an account this client may not use/, JSON.stringify(r));
    await h.sleep(1000);
    assert.equal(tb.smtp.messages.length, sent);
    assert.equal(await folderCount(`${BOB}/Sent`), before);
  });

  it("still sends for a client that may use that account (positive control)", async () => {
    const sent = tb.smtp.messages.length;
    const r = await tb.call("sendMail", { to: "x@sink.test", subject: "fcc ok", body: "b", from: "id1", skipReview: true });
    assert.equal(r.result?.success, true, JSON.stringify(r));
    await h.waitFor(() => tb.smtp.messages.length > sent, { label: "sent" });
  });
});

// Effects Thunderbird adds on its own after a send or while a review window
// is open: Post-outgoing filters on the Sent copy, autosave into Drafts, and
// the Sent-folder fallback when the configured folder does not exist.
describe("native follow-up effects stay within the client's accounts (native)", { skip: !h.thunderbirdBinary() && "THUNDERBIRD_BIN not set" }, () => {
  let tb;
  const BOB = "mailbox://bob@127.0.0.1";
  const folderCount = (uri) => tb.marionette.run(`
    const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
    return [...MailServices.folderLookup.getFolderForURL(args.uri).msgDatabase.enumerateMessages()].length;
  `, { uri });
  const setCharPref = (name, value) => tb.marionette.run("Services.prefs.setCharPref(args.name, args.value); return true;", { name, value });
  const composeWindows = () => tb.marionette.run(`return [...Services.wm.getEnumerator("msgcompose")].length;`);
  const closeComposeWindows = () => tb.marionette.run(`for (const w of [...Services.wm.getEnumerator("msgcompose")]) w.close(); return true;`);

  before(async () => {
    tb = await h.startThunderbird({
      mailboxes: { alice: { Inbox: f.simple({ id: "orig@sender.test", from: "Carol <carol@sender.test>", to: f.ALLOWED_EMAIL, subject: "Original", text: "x" }) } },
      clients: [
        { name: "harness" },
        { name: "alice-local", accounts: ["account1", "account3"] },
        { name: "alice-only", accounts: ["account1"] },
      ],
    });
    await tb.waitForMessages(`${ALICE}/Inbox`, 1);
  });
  after(async () => { await tb?.stop(); });

  it("refuses a direct send whose Post-outgoing filter would copy into a restricted account", async () => {
    const created = await tb.call("createFilter", {
      accountId: "account1", name: "Copy sent to Bob", type: 64,
      conditions: [{ attrib: "subject", op: "contains", value: "post-outgoing" }],
      actions: [{ type: "copyToFolder", value: `${BOB}/Inbox` }],
    });
    assert.equal(created.result?.success, true, JSON.stringify(created));
    const before = await folderCount(`${BOB}/Inbox`);
    const sent = tb.smtp.messages.length;
    const refused = await tb.call("sendMail", { to: "x@sink.test", subject: "post-outgoing 1", body: "b", from: "id1", skipReview: true }, { client: "alice-local" });
    assert.match(refused.result?.error || "", /Post-outgoing filter "Copy sent to Bob"/, JSON.stringify(refused));
    await h.sleep(1000);
    assert.equal(tb.smtp.messages.length, sent);
    // Positive control: a client that may use Bob's account sends, and the
    // filter really copies the sent message.
    const ok = await tb.call("sendMail", { to: "x@sink.test", subject: "post-outgoing 2", body: "b", from: "id1", skipReview: true });
    assert.equal(ok.result?.success, true, JSON.stringify(ok));
    await h.waitFor(async () => (await folderCount(`${BOB}/Inbox`)) === before + 1, { label: "post-outgoing copy" });
    await tb.call("deleteFilter", { accountId: "account1", filterIndex: 0 });
  });

  it("refuses review windows that would autosave into a restricted Drafts folder", async () => {
    await setCharPref("mail.identity.id1.draft_folder", `${BOB}/Drafts`);
    try {
      const refused = await tb.call("replyToMessage", { messageId: "orig@sender.test", folderPath: `${ALICE}/Inbox`, body: "reply" }, { client: "alice-local" });
      assert.match(refused.result?.error || "", /autosave this review window/, JSON.stringify(refused));
      await h.waitFor(async () => (await composeWindows()) === 0, { label: "window closed" });
      const ok = await tb.call("replyToMessage", { messageId: "orig@sender.test", folderPath: `${ALICE}/Inbox`, body: "reply" });
      assert.equal(ok.result?.success, true, JSON.stringify(ok));
    } finally {
      await closeComposeWindows();
      await setCharPref("mail.identity.id1.draft_folder", `${ALICE}/Drafts`);
    }
  });

  it("treats a missing Sent folder like Thunderbird: every fallback (incl. Local Folders) must be accessible", async () => {
    await setCharPref("mail.identity.id1.fcc_folder", `${ALICE}/Missing Sent`);
    try {
      const refused = await tb.call("sendMail", { to: "x@sink.test", subject: "fallback", body: "b", from: "id1", skipReview: true }, { client: "alice-only" });
      assert.match(refused.result?.error || "", /sent copies into an account this client may not use/, JSON.stringify(refused));
      const ok = await tb.call("sendMail", { to: "x@sink.test", subject: "fallback ok", body: "b", from: "id1", skipReview: true }, { client: "alice-local" });
      assert.equal(ok.result?.success, true, JSON.stringify(ok));
    } finally {
      await setCharPref("mail.identity.id1.fcc_folder", `${ALICE}/Sent`);
    }
  });
});