"use strict";

// Native Thunderbird test harness. Starts a portable Thunderbird with an
// isolated, synthetic profile, a local SMTP sink and an HTTP probe server.
// Nothing here talks to real mail servers or uses real credentials.
//
// Requires THUNDERBIRD_BIN (path to thunderbird.exe / thunderbird). Tests
// using this harness skip when it is not set.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { Marionette } = require("./marionette.cjs");

const REPO_ROOT = path.resolve(__dirname, "../..");
// TBMCP_EXTENSION_DIR runs the suite against another build (e.g. a negative control).
const EXTENSION_DIR = process.env.TBMCP_EXTENSION_DIR || path.join(REPO_ROOT, "extension");

function thunderbirdBinary() {
  const bin = process.env.THUNDERBIRD_BIN;
  return bin && fs.existsSync(bin) ? bin : null;
}

function addonId(extensionDir = EXTENSION_DIR) {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
  return manifest.browser_specific_settings.gecko.id;
}

function prefNamespace(extensionDir = EXTENSION_DIR) {
  // Read from source so the harness follows a namespace change.
  const source = fs.readFileSync(path.join(extensionDir, "mcp_server", "api.js"), "utf8");
  return source.match(/const PREF_ALLOWED_ACCOUNTS = "(.+)allowedAccounts"/)[1];
}

function runtimeSubdir(extensionDir = EXTENSION_DIR) {
  const source = fs.readFileSync(path.join(extensionDir, "mcp_server", "api.js"), "utf8");
  const writer = source.slice(source.indexOf("function writeConnectionInfo("));
  return writer.match(/tmpDir\.append\("([^"]+)"\)/)[1];
}

// ── Paired clients (Stage 4) ─────────────────────────────────────────────
// Builds with a client registry authenticate per client; older builds
// (upstream, negative controls) still publish one token in connection.json.
function hasClientRegistry(extensionDir = EXTENSION_DIR) {
  return fs.existsSync(path.join(extensionDir, "mcp_server", "core", "client-registry.sys.mjs"));
}

async function allCapabilities(extensionDir = EXTENSION_DIR) {
  const policy = await import(pathToFileURL(path.join(extensionDir, "mcp_server", "core", "policy.sys.mjs")).href);
  return Object.keys(policy.CAPABILITIES);
}

// clients: [{ name, capabilities?, profile?, accounts?, calendars?, addressBooks? }]
// Missing fields mean full access. Returns { pref, tokens: { name: token } }.
async function pairClients(clients, extensionDir = EXTENSION_DIR) {
  const all = await allCapabilities(extensionDir);
  const tokens = {};
  const stored = clients.map((client, index) => {
    const token = crypto.randomBytes(32).toString("hex");
    tokens[client.name] = token;
    return {
      id: crypto.randomBytes(16).toString("hex"),
      name: client.name,
      verifier: crypto.createHash("sha256").update(token).digest("hex"),
      createdAt: Date.now() + index,
      profile: client.profile || "automation",
      capabilities: client.capabilities || all,
      accounts: client.accounts || ["account1", "account2", "account3"],
      calendars: client.calendars ?? true,
      addressBooks: client.addressBooks ?? true,
    };
  });
  return { pref: JSON.stringify({ version: 1, clients: stored }), tokens };
}

// ── Local SMTP sink ──────────────────────────────────────────────────────

function startSmtpSink() {
  const messages = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
    socket.setEncoding("latin1");
    let buffer = "";
    let inData = false;
    let current = { from: "", to: [], data: "" };
    const reply = (line) => socket.write(`${line}\r\n`);
    reply("220 sink.test ESMTP synthetic");
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          current.data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          messages.push({ ...current, receivedAt: Date.now() });
          current = { from: "", to: [], data: "" };
          reply("250 OK queued");
          continue;
        }
        const nl = buffer.indexOf("\r\n");
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO") { reply("250-sink.test"); reply("250 8BITMIME"); }
        else if (verb === "HELO") reply("250 sink.test");
        else if (verb === "MAIL") { current.from = line; reply("250 OK"); }
        else if (verb === "RCPT") { current.to.push(line); reply("250 OK"); }
        else if (verb === "DATA") { inData = true; reply("354 End data with <CR><LF>.<CR><LF>"); }
        else if (verb === "QUIT") { reply("221 Bye"); socket.end(); }
        else if (verb === "RSET") { current = { from: "", to: [], data: "" }; reply("250 OK"); }
        else reply("250 OK");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        messages,
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
      });
    });
  });
}

// ── HTTP probe: records every request it receives ────────────────────────

function startProbeServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers, at: Date.now() });
    res.writeHead(200, { "Content-Type": "application/pdf" });
    res.end("PROBE-REMOTE-CONTENT");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        url: (p) => `http://127.0.0.1:${server.address().port}${p}`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ── Profile builder ─────────────────────────────────────────────────────

function userPref(name, value) {
  return `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`;
}

/**
 * Builds an isolated profile with:
 *  - account1 (POP3, alice@allowed.test) -- local mbox, never contacts a server
 *  - account2 (POP3, bob@blocked.test)
 *  - Local Folders
 *  - one SMTP server pointing at the sink
 *  - one enabled storage calendar bound to identity id1
 */
function buildProfile({ root, smtpPort, mailboxes = {}, extraPrefs = {}, extensionDir = EXTENSION_DIR, extraAddons = [] }) {
  const profileDir = path.join(root, "profile");
  fs.mkdirSync(path.join(profileDir, "extensions"), { recursive: true });

  // Unpacked extension via a proxy file pointing at the working tree.
  fs.writeFileSync(path.join(profileDir, "extensions", addonId(extensionDir)), extensionDir);
  for (const { id, xpi } of extraAddons) {
    fs.copyFileSync(xpi, path.join(profileDir, "extensions", `${id}.xpi`));
  }

  for (const [account, folders] of Object.entries(mailboxes)) {
    const dir = path.join(profileDir, "Mail", account);
    fs.mkdirSync(dir, { recursive: true });
    for (const [folder, content] of Object.entries(folders)) {
      fs.writeFileSync(path.join(dir, folder), content, "latin1");
    }
  }
  for (const account of ["alice", "bob", "Local Folders"]) {
    const dir = path.join(profileDir, "Mail", account);
    fs.mkdirSync(dir, { recursive: true });
    for (const folder of ["Inbox", "Drafts", "Sent", "Templates", "Trash"]) {
      const file = path.join(dir, folder);
      if (!fs.existsSync(file)) fs.writeFileSync(file, "");
    }
  }

  const ns = prefNamespace(extensionDir);
  const prefs = {
    // Unattended, offline-safe startup.
    "extensions.autoDisableScopes": 0,
    "extensions.enabledScopes": 15,
    "xpinstall.signatures.required": false,
    "extensions.update.enabled": false,
    "extensions.update.autoUpdateDefault": false,
    "app.update.enabled": false,
    "app.update.auto": false,
    "mail.shell.checkDefaultClient": false,
    "mail.provider.suppress_dialog_on_startup": true,
    "mail.rights.version": 1,
    "mail.spotlight.firstRunDone": true,
    "mail.winsearch.firstRunDone": true,
    "mail.startup.enabledMailCheckOnce": true,
    "mailnews.start_page.enabled": false,
    "mailnews.start_page_override.mstone": "ignore",
    "datareporting.policy.dataSubmissionEnabled": false,
    "datareporting.healthreport.uploadEnabled": false,
    "toolkit.telemetry.enabled": false,
    "browser.dom.window.dump.enabled": true,
    "devtools.console.stdout.chrome": true,
    "mailnews.database.global.indexer.enabled": true,
    "network.proxy.type": 0,
    "app.donation.eoy.version.viewed": 999,
    "mail.inappnotifications.enabled": false,

    "mail.accountmanager.accounts": "account1,account2,account3",
    "mail.accountmanager.defaultaccount": "account1",
    "mail.accountmanager.localfoldersserver": "server3",

    "mail.account.account1.server": "server1",
    "mail.account.account1.identities": "id1",
    "mail.server.server1.type": "pop3",
    "mail.server.server1.hostname": "127.0.0.1",
    "mail.server.server1.port": 1,
    "mail.server.server1.userName": "alice",
    "mail.server.server1.name": "Alice Allowed",
    "mail.server.server1.directory-rel": "[ProfD]Mail/alice",
    "mail.server.server1.login_at_startup": false,
    "mail.server.server1.check_new_mail": false,
    "mail.identity.id1.useremail": "alice@allowed.test",
    "mail.identity.id1.fullName": "Alice Test",
    "mail.identity.id1.valid": true,
    "mail.identity.id1.smtpServer": "smtp1",
    "mail.identity.id1.draft_folder": "mailbox://alice@127.0.0.1/Drafts",
    "mail.identity.id1.fcc_folder": "mailbox://alice@127.0.0.1/Sent",
    "mail.identity.id1.stationery_folder": "mailbox://alice@127.0.0.1/Templates",

    "mail.account.account2.server": "server2",
    "mail.account.account2.identities": "id2",
    "mail.server.server2.type": "pop3",
    "mail.server.server2.hostname": "127.0.0.1",
    "mail.server.server2.port": 1,
    "mail.server.server2.userName": "bob",
    "mail.server.server2.name": "Bob Blocked",
    "mail.server.server2.directory-rel": "[ProfD]Mail/bob",
    "mail.server.server2.login_at_startup": false,
    "mail.server.server2.check_new_mail": false,
    "mail.identity.id2.useremail": "bob@blocked.test",
    "mail.identity.id2.fullName": "Bob Test",
    "mail.identity.id2.valid": true,
    "mail.identity.id2.smtpServer": "smtp1",
    "mail.identity.id2.draft_folder": "mailbox://bob@127.0.0.1/Drafts",
    "mail.identity.id2.fcc_folder": "mailbox://bob@127.0.0.1/Sent",
    "mail.identity.id2.stationery_folder": "mailbox://bob@127.0.0.1/Templates",

    "mail.account.account3.server": "server3",
    "mail.server.server3.type": "none",
    "mail.server.server3.hostname": "Local Folders",
    "mail.server.server3.userName": "nobody",
    "mail.server.server3.name": "Local Folders",
    "mail.server.server3.directory-rel": "[ProfD]Mail/Local Folders",

    "mail.smtpservers": "smtp1",
    "mail.smtp.defaultserver": "smtp1",
    "mail.smtpserver.smtp1.hostname": "127.0.0.1",
    "mail.smtpserver.smtp1.port": smtpPort,
    "mail.smtpserver.smtp1.authMethod": 1,
    "mail.smtpserver.smtp1.try_ssl": 0,
    "mail.smtpserver.smtp1.username": "",

    "calendar.registry.testcal.type": "storage",
    "calendar.registry.testcal.uri": "moz-storage-calendar://",
    "calendar.registry.testcal.name": "Synthetic Calendar",
    "calendar.registry.testcal.disabled": false,
    "calendar.registry.testcal.calendar-main-in-composite": true,
    "calendar.registry.testcal.imip.identity.key": "id1",
    "calendar.timezone.local": "UTC",
    "calendar.timezone.useSystemTimezone": false,

    [`${ns}blockSkipReview`]: false,
    ...extraPrefs,
  };
  const lines = Object.entries(prefs).map(([k, v]) => userPref(k, v));
  fs.writeFileSync(path.join(profileDir, "user.js"), `${lines.join("\n")}\n`);
  return profileDir;
}

// ── Thunderbird process ─────────────────────────────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(fn, { timeoutMs = 60000, intervalMs = 250, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) { lastError = e; }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

function readConnection(tmpDir, extensionDir = EXTENSION_DIR) {
  const file = path.join(tmpDir, runtimeSubdir(extensionDir), "connection.json");
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return data && data.port ? { ...data, file } : null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Chrome-context script: parse every local mbox so seeded messages are indexed.
const REPARSE_SCRIPT = `
  const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
  const out = [];
  for (const account of MailServices.accounts.accounts) {
    const root = account.incomingServer.rootFolder;
    for (const folder of root.descendants) {
      await new Promise((done) => {
        const listener = {
          QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]),
          OnStartRunningUrl() {},
          OnStopRunningUrl() { done(); },
        };
        try {
          folder.QueryInterface(Ci.nsIMsgLocalMailFolder).getDatabaseWithReparse(listener, null);
          // Already-valid databases do not call the listener.
          try { if (folder.msgDatabase) done(); } catch {}
        } catch (e) { done(); }
      });
      let count = -1;
      try { count = folder.msgDatabase.dBFolderInfo.numMessages; } catch {}
      out.push(folder.URI + "=" + count);
    }
  }
  return out;
`;

/**
 * Starts a fully isolated Thunderbird. Returns an object with
 * call(tool, args), rpc(method, params), stop(), and the probe/sink.
 */
async function startThunderbird({ mailboxes, extraPrefs, headless = true, authHeader, extensionDir = EXTENSION_DIR, extraAddons, clients } = {}) {
  const bin = thunderbirdBinary();
  if (!bin) throw new Error("THUNDERBIRD_BIN is not set");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tbmcp-native-"));
  const tmpDir = path.join(root, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const smtp = await startSmtpSink();
  const probe = await startProbeServer();
  const marionettePort = await freePort();
  const resolvedMailboxes = typeof mailboxes === "function" ? mailboxes({ probe, root }) : (mailboxes || {});
  // The first client is the harness's default identity for call()/rpc().
  const registry = hasClientRegistry(extensionDir)
    ? await pairClients(clients || [{ name: "harness" }], extensionDir) : null;
  const clientTokens = registry ? registry.tokens : {};
  const defaultToken = registry ? Object.values(registry.tokens)[0] : null;
  const profileDir = buildProfile({
    root,
    smtpPort: smtp.port,
    mailboxes: resolvedMailboxes,
    extensionDir,
    extraAddons,
    extraPrefs: {
      "marionette.port": marionettePort,
      ...(registry ? { [`${prefNamespace(extensionDir)}clients`]: registry.pref } : {}),
      ...extraPrefs,
    },
  });

  const env = { ...process.env, TMP: tmpDir, TEMP: tmpDir, TMPDIR: tmpDir, MOZ_CRASHREPORTER_DISABLE: "1", MOZ_DISABLE_AUTO_SAFE_MODE: "1" };
  const args = ["-profile", profileDir, "-no-remote", "-purgecaches", "--marionette", "-remote-allow-system-access"];
  if (headless) args.push("--headless");
  const log = [];
  const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  let exited = false;
  child.on("exit", () => { exited = true; });

  let connection;
  try {
    connection = await waitFor(() => {
      if (exited) throw new Error(`Thunderbird exited early:\n${log.join("").slice(-4000)}`);
      return readConnection(tmpDir, extensionDir);
    }, { timeoutMs: 90000, label: "connection.json" });
  } catch (e) {
    try { child.kill(); } catch {}
    throw e;
  }

  let rpcId = 0;
  const currentToken = () => connection.token || defaultToken;
  async function rpc(method, params, { token = currentToken(), client, header } = {}) {
    if (client !== undefined) token = clientTokens[client];
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params });
    const res = await fetch(`http://127.0.0.1:${connection.port}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(header !== undefined ? (header ? { Authorization: header } : {}) :
          authHeader ? { Authorization: authHeader } : token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  }

  async function call(tool, args = {}, options) {
    const { json, status, text } = await rpc("tools/call", { name: tool, arguments: args }, options);
    if (!json) throw new Error(`HTTP ${status}: ${text}`);
    if (json.error) return { rpcError: json.error };
    const content = json.result?.content || [];
    const textBlock = content.find((c) => c.type === "text");
    let parsed;
    try { parsed = textBlock ? JSON.parse(textBlock.text) : null; } catch { parsed = textBlock?.text; }
    return { result: parsed, content };
  }

  // Local mbox databases are (re)built asynchronously on first access.
  async function waitForMessages(folderPath, count, { timeoutMs = 60000 } = {}) {
    return waitFor(async () => {
      const r = await call("searchMessages", { query: "", folderPath, maxResults: 200, includeSubfolders: false });
      const list = Array.isArray(r.result) ? r.result : null;
      return list && list.length >= count ? list : null;
    }, { timeoutMs, intervalMs: 500, label: `${count} message(s) in ${folderPath}` });
  }

  const marionette = new Marionette(marionettePort);
  let folderCounts;
  try {
    await waitFor(async () => {
      const r = await call("listFolders", {});
      return Array.isArray(r.result) && r.result.length > 0;
    }, { timeoutMs: 60000, intervalMs: 500, label: "folder discovery" });
    await marionette.connect();
    await marionette.start();
    folderCounts = await marionette.run(REPARSE_SCRIPT, [], { timeoutMs: 120000 });
  } catch (e) {
    marionette.close();
    try { child.kill(); } catch {}
    await smtp.close();
    await probe.close();
    throw e;
  }

  // After an add-on reload the server may come back on another port.
  async function reconnect({ timeoutMs = 60000 } = {}) {
    const previousPid = connection.pid;
    const next = await waitFor(async () => {
      const info = readConnection(tmpDir, extensionDir);
      if (!info) return null;
      try {
        const res = await fetch(`http://127.0.0.1:${info.port}/`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${info.token || defaultToken}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }),
        });
        return res.status === 200 ? info : null;
      } catch { return null; }
    }, { timeoutMs, intervalMs: 500, label: `server after reload (pid ${previousPid})` });
    connection = next;
    return next;
  }

  async function stop() {
    marionette.close();
    if (!exited) {
      child.kill();
      await waitFor(() => exited, { timeoutMs: 20000, label: "Thunderbird exit" }).catch(() => {});
    }
    await smtp.close();
    await probe.close();
    if (!process.env.TBMCP_KEEP_PROFILE) {
      for (let i = 0; i < 10; i++) {
        try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { await sleep(500); }
      }
    }
  }

  return { root, tmpDir, profileDir, clientTokens, get connection() { return connection; }, smtp, probe, rpc, call, waitForMessages, reconnect, marionette, folderCounts, stop, log, child };
}

function randomId(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}

module.exports = {
  REPO_ROOT,
  EXTENSION_DIR,
  thunderbirdBinary,
  addonId,
  prefNamespace,
  runtimeSubdir,
  startSmtpSink,
  startProbeServer,
  buildProfile,
  startThunderbird,
  waitFor,
  sleep,
  randomId,
};
