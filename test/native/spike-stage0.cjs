"use strict";

// Stage 0 spikes, run against an isolated synthetic profile:
//  1. Fork identity at runtime (runtime dir, export dir, preferences).
//  2. The resource alias is not loadable by web content.
//  3. Coexistence with the upstream v0.9.2 XPI in the same profile.
//  4. Effective Windows ACLs of the runtime and export files (icacls).
//  5. ESM module caching: same URL stays cached; a versioned URL reloads.
//  6. Disabling/enabling the add-on reloads the experiment code.
// Usage: THUNDERBIRD_BIN=... node test/native/spike-stage0.cjs

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const h = require("./harness.cjs");
const f = require("./fixtures.cjs");

const INBOX = "mailbox://alice@127.0.0.1/Inbox";

function icacls(target) {
  try {
    return execFileSync("icacls", [target], { encoding: "utf8" }).trim();
  } catch (e) {
    return `icacls failed: ${e.message}`;
  }
}

(async () => {
  const report = {};
  // The committed upstream v0.9.2 XPI, extracted from git so the working tree
  // build output does not matter.
  const upstreamXpi = path.join(os.tmpdir(), `tbmcp-upstream-${Date.now()}.xpi`);
  fs.writeFileSync(upstreamXpi, execFileSync("git", ["show", "1ab1018:dist/thunderbird-mcp.xpi"], { cwd: h.REPO_ROOT, maxBuffer: 64 * 1024 * 1024 }));

  // Copy of the extension so spike 6 can modify it without touching the tree.
  const extCopy = fs.mkdtempSync(path.join(os.tmpdir(), "tbmcp-extcopy-"));
  fs.cpSync(h.EXTENSION_DIR, extCopy, { recursive: true });

  const tb = await h.startThunderbird({
    extensionDir: extCopy,
    extraAddons: [{ id: "thunderbird-mcp@tkasperczyk.dev", xpi: upstreamXpi }],
    extraPrefs: { "extensions.thunderbird-mcp.blockSkipReview": true },
    mailboxes: { alice: { Inbox: f.plainWithAttachment() } },
  });
  try {
    await tb.waitForMessages(INBOX, 1);

    // 1. Runtime identity
    report.forkConnectionFile = tb.connection.file;
    report.forkPort = tb.connection.port;
    const msg = await tb.call("getMessage", { messageId: "plain-attach@allowed.test", folderPath: INBOX, saveAttachments: true });
    report.exportPath = msg.result.attachments?.[0]?.filePath;
    report.forkPrefs = await tb.marionette.run(`
      return Services.prefs.getChildList("extensions.thunderbird-mcp-hardened.").length + " fork prefs; " +
        Services.prefs.getChildList("extensions.thunderbird-mcp.").length + " upstream prefs";
    `);

    // 2. Content access to the resource alias
    report.contentAccess = await tb.marionette.run(`
      const res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
      const out = {};
      for (const spec of ["resource://thunderbird-mcp-hardened/manifest.json", "resource://thunderbird-mcp/manifest.json"]) {
        out[spec] = res.allowContentToAccess(Services.io.newURI(spec)) ? "content may load" : "content blocked";
      }
      return out;
    `);

    // 3. Coexistence
    const upstreamConn = path.join(tb.tmpDir, "thunderbird-mcp", "connection.json");
    report.upstreamConnectionPresent = fs.existsSync(upstreamConn);
    if (report.upstreamConnectionPresent) {
      const up = JSON.parse(fs.readFileSync(upstreamConn, "utf8"));
      report.upstreamPort = up.port;
      const res = await fetch(`http://127.0.0.1:${up.port}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${up.token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      report.upstreamToolCount = (await res.json()).result?.tools?.length;
      // Upstream's token must not authenticate against the fork.
      const cross = await tb.rpc("tools/list", {}, { token: up.token });
      report.upstreamTokenOnFork = cross.status;
    }
    report.addons = await tb.marionette.run(`
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const addons = await AddonManager.getAddonsByTypes(["extension"]);
      return addons.filter(a => /mcp/i.test(a.name)).map(a => ({ id: a.id, version: a.version, active: a.isActive, updateURL: a.updateURL || null }));
    `);

    // 4. Windows ACLs
    if (process.platform === "win32") {
      report.aclRuntimeDir = icacls(path.dirname(tb.connection.file));
      report.aclConnectionFile = icacls(tb.connection.file);
      if (report.exportPath) report.aclExportFile = icacls(report.exportPath);
      report.aclRealTemp = icacls(os.tmpdir());
    }

    // 5. ESM module caching
    const modDir = fs.mkdtempSync(path.join(tb.root, "esm-"));
    fs.writeFileSync(path.join(modDir, "probe.sys.mjs"), "export const VERSION = 1;\n");
    const first = await tb.marionette.run(`
      const resProto = Cc["@mozilla.org/network/protocol;1?name=resource"].getService(Ci.nsISubstitutingProtocolHandler);
      const dir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      dir.initWithPath(args.dir);
      resProto.setSubstitution("tbmcp-esm-spike", Services.io.newFileURI(dir));
      return ChromeUtils.importESModule("resource://tbmcp-esm-spike/probe.sys.mjs").VERSION;
    `, { dir: modDir });
    fs.writeFileSync(path.join(modDir, "probe.sys.mjs"), "export const VERSION = 2;\n");
    const again = await tb.marionette.run(`
      return {
        sameUrl: ChromeUtils.importESModule("resource://tbmcp-esm-spike/probe.sys.mjs").VERSION,
        versionedUrl: ChromeUtils.importESModule("resource://tbmcp-esm-spike/probe.sys.mjs?v=2").VERSION,
      };
    `);
    report.esmCaching = { first, ...again };

    // 6. Disable/enable reloads the experiment's api.js
    const before = (await tb.rpc("initialize", { protocolVersion: "2025-11-25" })).json?.result?.serverInfo?.version;
    const manifestPath = path.join(extCopy, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.version = "0.9.2.999";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    await tb.marionette.run(`
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const addon = await AddonManager.getAddonByID(args.id);
      await addon.disable();
      await addon.enable();
      return true;
    `, { id: h.addonId() });
    const conn = await h.waitFor(() => {
      const file = path.join(tb.tmpDir, h.runtimeSubdir(), "connection.json");
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    }, { label: "fork connection after re-enable" });
    const res = await fetch(`http://127.0.0.1:${conn.port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${conn.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }),
    });
    report.reload = { before, after: (await res.json()).result?.serverInfo?.version };
  } finally {
    await tb.stop();
    fs.rmSync(upstreamXpi, { force: true });
    fs.rmSync(extCopy, { recursive: true, force: true });
  }
  console.log(JSON.stringify(report, null, 2));
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
