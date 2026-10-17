"use strict";

// Native Stage 6 check: the packaged dist/thunderbird-mcp.xpi itself (not the
// source directory) installs in Thunderbird and serves all 40 tools, and it
// is the reproducible build of the current sources.
// Run: THUNDERBIRD_BIN=... node --test test/native/stage6-package.native.cjs

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const h = require("./harness.cjs");
const build = require("../../scripts/build-xpi.cjs");

const XPI = path.join(h.REPO_ROOT, "dist", "thunderbird-mcp.xpi");

describe("packaged XPI (native)", { skip: !h.thunderbirdBinary() && "THUNDERBIRD_BIN not set" }, () => {
  let tb;
  before(async () => { tb = await h.startThunderbird({ xpi: XPI }); });
  after(async () => { await tb?.stop(); });

  it("is the reproducible build of the current sources", () => {
    const built = build.buildXpi(build.workingTreeSource());
    const committed = fs.readFileSync(XPI);
    assert.equal(crypto.createHash("sha256").update(committed).digest("hex"), built.sha256);
  });

  it("installs from the XPI with its build info and serves all 40 tools", async () => {
    const info = await tb.marionette.run(`
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const addon = await AddonManager.getAddonByID(args.id);
      return { version: addon?.version, active: addon?.isActive, root: addon?.getResourceURI("").spec };
    `, { id: h.addonId() });
    assert.equal(info.active, true, JSON.stringify(info));
    assert.equal(info.version, JSON.parse(fs.readFileSync(path.join(h.EXTENSION_DIR, "manifest.json"), "utf8")).version);
    assert.match(info.root, /^jar:file:.*\.xpi!\/$/, "loaded from the XPI, not the source directory");
    const list = await tb.rpc("tools/list", {});
    assert.equal(list.json?.result?.tools?.length, 40, list.text.slice(0, 300));
    const accounts = await tb.call("listAccounts", {});
    assert.ok(Array.isArray(accounts.result) && accounts.result.length >= 1, JSON.stringify(accounts.result));
    const status = await tb.marionette.run(`
      const uri = Services.io.newURI("resource://thunderbird-mcp-hardened/buildinfo.json");
      const channel = Services.io.newChannelFromURI(uri, null, Services.scriptSecurityManager.getSystemPrincipal(), null,
        Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL, Ci.nsIContentPolicy.TYPE_OTHER);
      const sis = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
      sis.init(channel.open());
      const text = sis.read(sis.available());
      sis.close();
      return JSON.parse(text);
    `);
    const built = build.buildXpi(build.workingTreeSource());
    assert.deepEqual(status, { version: built.version, sourceDigest: built.sourceDigest });
  });
});

// Every tool is refused at the permission check for a client without rights,
// with schema-valid arguments (so validation is not what stops it).
describe("every tool is refused without rights (native, Stage 6 acceptance)", { skip: !h.thunderbirdBinary() && "THUNDERBIRD_BIN not set" }, () => {
  let tb;
  before(async () => { tb = await h.startThunderbird({ clients: [{ name: "harness" }, { name: "nobody", profile: "none", capabilities: [] }] }); });
  after(async () => { await tb?.stop(); });

  function sample(schema) {
    if (!schema) return "x";
    if (schema.enum) return schema.enum[0];
    if (Array.isArray(schema.oneOf || schema.anyOf)) return sample((schema.oneOf || schema.anyOf)[0]);
    switch (Array.isArray(schema.type) ? schema.type[0] : schema.type) {
      case "integer": case "number": return Math.max(schema.minimum ?? 1, 1);
      case "boolean": return false;
      case "array": return Array.from({ length: schema.minItems || 0 }, () => sample(schema.items));
      case "object": return Object.fromEntries((schema.required || []).map((k) => [k, sample(schema.properties?.[k])]));
      default: return "x".repeat(Math.max(schema.minLength || 1, 5)) + (schema.format === "email" ? "@sink.test" : "");
    }
  }

  it("lists no tool and refuses all 40", async () => {
    const all = (await tb.rpc("tools/list", {})).json.result.tools;
    assert.equal(all.length, 40);
    assert.deepEqual((await tb.rpc("tools/list", {}, { client: "nobody" })).json.result.tools, []);
    for (const tool of all) {
      const args = Object.fromEntries((tool.inputSchema.required || []).map((k) => [k, sample(tool.inputSchema.properties[k])]));
      const r = await tb.call(tool.name, args, { client: "nobody" });
      assert.match(r.rpcError?.message || JSON.stringify(r), /Not permitted for client "nobody": requires /, tool.name);
    }
  });
});