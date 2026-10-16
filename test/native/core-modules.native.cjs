"use strict";

// Stage 3: core modules load in Thunderbird under a per-load version query,
// and re-enabling the add-on after an update uses the new module code
// (an unchanged module URL would stay cached for the whole process).
// Run: THUNDERBIRD_BIN=... node --test test/native/core-modules.native.cjs

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const h = require("./harness.cjs");
const f = require("./fixtures.cjs");

const INBOX = "mailbox://alice@127.0.0.1/Inbox";
const MARKER = "MODULE-RELOAD-MARKER";

describe("core module loading (native)", { skip: !h.thunderbirdBinary() && "THUNDERBIRD_BIN not set" }, () => {
  let tb;
  let extCopy;
  before(async () => {
    extCopy = fs.mkdtempSync(path.join(os.tmpdir(), "tbmcp-core-ext-"));
    fs.cpSync(h.EXTENSION_DIR, extCopy, { recursive: true });
    tb = await h.startThunderbird({
      extensionDir: extCopy,
      mailboxes: ({ probe }) => ({ alice: { Inbox: f.externalAttachment({ id: "ext@attacker.test", url: probe.url("/x") }) } }),
    });
    await tb.waitForMessages(INBOX, 1);
  });
  after(async () => {
    await tb?.stop();
    if (extCopy) fs.rmSync(extCopy, { recursive: true, force: true });
  });

  async function externalError() {
    const r = await tb.call("getMessage", { messageId: "ext@attacker.test", folderPath: INBOX, saveAttachments: true });
    return r.result.attachments.find((a) => a.external)?.error;
  }

  it("serves requests through the core modules", async () => {
    assert.match(await externalError(), /External or detached attachment/);
  });

  it("uses updated core module code after the add-on is re-enabled", async () => {
    const file = path.join(extCopy, "mcp_server", "core", "attachment-source.sys.mjs");
    const source = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, source.replace("External or detached attachment:", `${MARKER} External or detached attachment:`));
    await tb.marionette.run(`
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const addon = await AddonManager.getAddonByID(args.id);
      await addon.disable();
      await addon.enable();
      return true;
    `, { id: h.addonId(extCopy) });
    // The server restarts, possibly on another port.
    await tb.reconnect();
    assert.match(await externalError(), new RegExp(MARKER));
  });
});
