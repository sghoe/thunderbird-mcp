"use strict";

// The hardened fork must never share identifiers with the upstream add-on.
// Names are literals at each use site (snippet tests cannot see shared
// constants), so this test keeps every use consistent.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const api = fs.readFileSync(path.join(root, "extension/mcp_server/api.js"), "utf8");
const bridge = fs.readFileSync(path.join(root, "mcp-bridge.cjs"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const PREF_PREFIX = "extensions.thunderbird-mcp-hardened.";
const RUNTIME = "thunderbird-mcp-hardened";
const EXPORTS = "thunderbird-mcp-hardened-exports";

describe("fork identity", () => {
  it("uses its own add-on ID and a deliberately unresolvable update channel", () => {
    const gecko = manifest.browser_specific_settings.gecko;
    assert.match(gecko.id, /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/);
    assert.notEqual(gecko.id, "thunderbird-mcp@tkasperczyk.dev");
    // RFC 6761 reserves .invalid; it never resolves, so no update can be
    // fetched and Thunderbird does not fall back to addons.thunderbird.net.
    assert.equal(new URL(gecko.update_url).hostname.endsWith(".invalid"), true);
    assert.doesNotMatch(JSON.stringify(manifest), /tomaszkasperczyk|tkasperczyk\.dev/);
  });

  it("keeps the manifest and package versions on the fork scheme", () => {
    assert.match(manifest.version, /^\d+\.\d+\.\d+\.\d+$/);
    const [maj, min, patch, fork] = manifest.version.split(".");
    assert.equal(pkg.version, `${maj}.${min}.${patch}-hardened.${fork}`);
  });

  it("namespaces every preference", () => {
    const prefs = [...api.matchAll(/^const (PREF_\w+) = "([^"]+)";$/gm)].map((m) => m[2]);
    assert.ok(prefs.length >= 10);
    for (const pref of prefs) assert.ok(pref.startsWith(PREF_PREFIX), pref);
    assert.doesNotMatch(api, /extensions\.thunderbird-mcp\./);
  });

  it("uses its own resource alias without content access", () => {
    const aliases = [...api.matchAll(/resource:\/\/([\w-]+)\//g)].map((m) => m[1])
      .filter((name) => !["gre"].includes(name));
    assert.ok(aliases.length >= 3);
    for (const alias of aliases) assert.equal(alias, RUNTIME);
    assert.match(api, /const resourceName = "thunderbird-mcp-hardened";/);
    assert.match(api, /resProto\.setSubstitution\("thunderbird-mcp-hardened", null\)/);
    assert.doesNotMatch(api, /resProto\.ALLOW_CONTENT_ACCESS/);
  });

  it("separates runtime files from exports", () => {
    const appends = [...api.matchAll(/\.append\("(thunderbird-mcp[\w-]*)"\)/g)].map((m) => m[1]);
    assert.ok(appends.includes(RUNTIME));
    assert.ok(appends.includes(EXPORTS));
    for (const name of appends) assert.ok(name === RUNTIME || name === EXPORTS, name);
    assert.match(bridge, /const THUNDERBIRD_MCP_SUBDIR = 'thunderbird-mcp-hardened';/);
    assert.match(bridge, /const THUNDERBIRD_MCP_EXPORT_SUBDIR = 'thunderbird-mcp-hardened-exports';/);
    for (const source of [api, bridge]) {
      assert.ok(source.includes("/^(.*\\/thunderbird-mcp-hardened-exports)\\/([a-zA-Z0-9_]+)\\/([^/]+)$/"));
      assert.ok(source.includes("/\\/thunderbird-mcp-hardened(\\/|$)/,"));
    }
  });

  it("uses fork-specific process globals", () => {
    const globals = [...api.matchAll(/globalThis\.(__\w+)/g)].map((m) => m[1]);
    assert.ok(globals.length > 0);
    for (const name of globals) assert.match(name, /^__tbMcpHardened/);
  });

  it("listens outside upstream's port range and probes before binding", () => {
    const port = Number(api.match(/^const MCP_DEFAULT_PORT = (\d+);$/m)[1]);
    const attempts = Number(api.match(/^const MCP_MAX_PORT_ATTEMPTS = (\d+);$/m)[1]);
    // Upstream uses 8765-8774.
    assert.ok(port > 8774 || port + attempts - 1 < 8765, `${port}-${port + attempts - 1}`);
    assert.match(api, /if \(await isLoopbackPortInUse\(tryPort\)\)/);
  });
});
