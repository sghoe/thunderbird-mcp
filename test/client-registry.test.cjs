"use strict";

// Stage 4: paired clients. Pure registry rules (core/client-registry.sys.mjs),
// the production adapter (token verification) and the options-only
// management API, run against an in-memory preference store.

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Core } = require("./helpers/core-modules.cjs");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
function block(name) {
  const start = source.indexOf(`// BEGIN ${name}`);
  const end = source.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `${name} markers missing`);
  return source.slice(start, end);
}
function constant(name) {
  const match = source.match(new RegExp(`^const ${name} = .*;$`, "m"));
  assert.ok(match, `${name} missing`);
  return match[0];
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const ALL = () => Object.keys(Core.policy.CAPABILITIES);
const sha = (text) => crypto.createHash("sha256").update(text, "latin1").digest("hex");

function storedClient(overrides = {}) {
  return {
    id: "1".repeat(32), name: "Claude Desktop", verifier: sha("a".repeat(64)), createdAt: 1,
    profile: "read-only", capabilities: ["mail.body", "mail.metadata"], accounts: ["account1"],
    calendars: false, addressBooks: false, ...overrides,
  };
}

describe("client registry rules", () => {
  const R = () => Core.clientRegistry;
  const serialized = (clients, extra = {}) => JSON.stringify({ version: 1, clients, ...extra });

  it("starts empty without being corrupt", () => {
    for (const text of ["", undefined, null]) {
      assert.deepEqual(plain(R().parseRegistry(text, ALL())), { clients: [], corrupt: false });
    }
  });

  it("accepts a valid registry", () => {
    const parsed = R().parseRegistry(serialized([storedClient()]), ALL());
    assert.equal(parsed.corrupt, false);
    assert.equal(parsed.clients[0].name, "Claude Desktop");
  });

  for (const [label, text] of [
    ["malformed JSON", "{"],
    ["wrong version", JSON.stringify({ version: 2, clients: [] })],
    ["unexpected top-level key", serialized([], { admin: true })],
    ["unknown capability", serialized([storedClient({ capabilities: ["mail.body", "root"] })])],
    ["unexpected client field", serialized([{ ...storedClient(), token: "a".repeat(64) }])],
    ["missing client field", serialized([(({ calendars: _c, ...rest }) => rest)(storedClient())])],
    ["wildcard account", serialized([storedClient({ accounts: ["*"] })])],
    ["non-boolean grant", serialized([storedClient({ calendars: "yes" })])],
    ["duplicate verifier", serialized([storedClient(), storedClient({ id: "2".repeat(32) })])],
    ["duplicate id", serialized([storedClient(), storedClient({ verifier: sha("b".repeat(64)) })])],
    ["control character in name", serialized([storedClient({ name: "a\u0007b" })])],
    ["too many clients", serialized(Array.from({ length: 33 }, (_, i) => storedClient({
      id: i.toString(16).padStart(32, "0"), verifier: sha(String(i)),
    })))],
  ]) {
    it(`treats ${label} as corrupt (no client admitted)`, () => {
      assert.deepEqual(plain(R().parseRegistry(text, ALL())), { clients: [], corrupt: true });
    });
  }

  it("validates settings chosen in the options page", () => {
    const context = { knownCapabilities: ALL(), knownAccounts: ["account1", "account2"] };
    const good = { name: "Codex", profile: "drafts", capabilities: ["mail.body", "mail.body"], accounts: ["account1"], calendars: true, addressBooks: false };
    assert.deepEqual(plain(R().validateClientSettings(good, context).settings.capabilities), ["mail.body"]);
    assert.match(R().validateClientSettings({ ...good, name: " padded" }, context).error, /Client name/);
    assert.match(R().validateClientSettings({ ...good, capabilities: ["unclassified"] }, context).error, /Unknown capability/);
    assert.match(R().validateClientSettings({ ...good, accounts: ["account9"] }, context).error, /Unknown account/);
    assert.match(R().validateClientSettings({ ...good, calendars: 1 }, context).error, /calendars and addressBooks/);
  });

  it("never exposes the verifier", () => {
    assert.equal(Object.hasOwn(R().publicView(storedClient()), "verifier"), false);
  });

  it("compares every stored verifier", () => {
    const compared = [];
    const clients = [storedClient(), storedClient({ id: "2".repeat(32), verifier: sha("b".repeat(64)) })];
    const found = R().findClientByVerifier(clients, clients[0].verifier, (a, b) => { compared.push(a); return a === b; });
    assert.equal(found.id, clients[0].id);
    assert.equal(compared.length, 2);
  });
});

function loadAdapter({ initial, unreadable = false } = {}) {
  const prefs = new Map();
  const filterList = {
    filters: [],
    saves: 0,
    get filterCount() { return this.filters.length; },
    getFilterAt(i) { return this.filters[i]; },
    saveToDefaultFile() { this.saves++; },
  };
  const makeRule = (name, actions) => ({
    filterName: name, enabled: true, filterType: 1, searchTerms: [{}],
    get actionCount() { return actions.length; },
    getActionAt: (i) => actions[i],
  });
  if (initial !== undefined) prefs.set("extensions.thunderbird-mcp-hardened.clients", initial);
  const hashes = [];
  const sandbox = {
    Core,
    Ci: {
      nsIPrefBranch: { PREF_INVALID: 0, PREF_STRING: 32 },
      nsICryptoHash: { SHA256: 4 },
      nsIRandomGenerator: {},
    },
    Cc: {
      "@mozilla.org/security/hash;1": { createInstance: () => {
        let data = Buffer.alloc(0);
        return {
          init(algorithm) { assert.equal(algorithm, 4); },
          update(bytes, length) { data = Buffer.concat([data, Buffer.from(bytes.slice(0, length))]); },
          finish(base64) {
            assert.equal(base64, false);
            hashes.push(data.toString("latin1"));
            return crypto.createHash("sha256").update(data).digest().toString("latin1");
          },
        };
      } },
      "@mozilla.org/security/random-generator;1": { createInstance: () => ({
        generateRandomBytes: (count) => Array.from(crypto.randomBytes(count)),
      }) },
    },
    Services: { prefs: {
      getPrefType: (name) => (prefs.has(name) ? 32 : 0),
      getStringPref(name, fallback) {
        if (unreadable) throw new Error("unreadable");
        return prefs.has(name) ? prefs.get(name) : fallback;
      },
      setStringPref: (name, value) => prefs.set(name, value),
      clearUserPref: (name) => prefs.delete(name),
    } },
    ChromeUtils: { importESModule: () => ({ MailServices: { accounts: {
      accounts: [
        { key: "account1", incomingServer: { prettyName: "Alice", getFilterList: () => filterList } },
        { key: "account2", incomingServer: { prettyName: "Bob" } },
      ],
      getAccount: (key) => (key === "account1" ? { key, incomingServer: { getFilterList: () => filterList } } : null),
    } } }) },
    // Rules are described by name/type/actions in this harness.
    resolveXpcomConstant: (iface, name) => ({ Forward: 2, Reply: 3 }[name]),
    serializeSearchTerm: () => ({ attrib: "subject", op: "contains", value: "x" }),
    serializeRuleAction: (action) => ({ type: action.type === 2 ? "forward" : "markRead", value: action.value }),
    console: { warn() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    constant("PREF_CLIENTS"),
    constant("PREF_FILTER_REGISTRY"),
    block("CLIENT REGISTRY ADAPTER"),
    block("FILTER REGISTRY ADAPTER"),
    "this.registry = { filterFingerprint, registerFilterChange, revokeRegisteredFilters, readFilterRegistry };",
    "this.authenticateClient = authenticateClient;",
    "this.api = {",
    block("CLIENT MANAGEMENT API"),
    "};",
  ].join("\n"), sandbox);
  return { sandbox, prefs, hashes, filterList, makeRule, pref: () => prefs.get("extensions.thunderbird-mcp-hardened.clients") };
}

const settings = { name: "Codex", profile: "drafts", capabilities: ["mail.body", "mail.metadata"], accounts: ["account1"], calendars: false, addressBooks: false };
const bearer = (token) => `Bearer ${token}`;

describe("client authentication and management", () => {
  let env;
  beforeEach(() => { env = loadAdapter(); });

  it("admits no request before a client is paired", () => {
    assert.equal(env.sandbox.authenticateClient(bearer("a".repeat(64))), null);
  });

  it("pairs a client, shows the token once and stores only its SHA-256 verifier", async () => {
    const { client, token } = await env.sandbox.api.createClient(settings);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(Object.hasOwn(client, "verifier"), false);
    assert.equal(env.pref().includes(token), false);
    assert.equal(JSON.parse(env.pref()).clients[0].verifier, sha(token));
    const listed = await env.sandbox.api.listClients();
    assert.equal(JSON.stringify(listed).includes(token), false);
    assert.equal(JSON.stringify(listed).includes(sha(token)), false);
    assert.equal(env.sandbox.authenticateClient(bearer(token)).id, client.id);
  });

  it("refuses wrong, malformed and missing tokens on the same hashing path", async () => {
    const { token } = await env.sandbox.api.createClient(settings);
    env.hashes.length = 0;
    for (const header of [bearer("b".repeat(64)), bearer(token.toUpperCase()), token, `Bearer ${token} `, "", undefined]) {
      assert.equal(env.sandbox.authenticateClient(header), null, String(header));
    }
    assert.equal(env.hashes.length, 6, "every request is hashed");
  });

  it("separates clients: each token maps to its own client", async () => {
    const a = await env.sandbox.api.createClient(settings);
    const b = await env.sandbox.api.createClient({ ...settings, name: "Other", capabilities: ["accounts.read"] });
    assert.equal(env.sandbox.authenticateClient(bearer(a.token)).name, "Codex");
    assert.deepEqual(plain(env.sandbox.authenticateClient(bearer(b.token)).capabilities), ["accounts.read"]);
  });

  it("rotation invalidates the old token; deletion revokes the client", async () => {
    const { client, token } = await env.sandbox.api.createClient(settings);
    const rotated = await env.sandbox.api.rotateClientToken(client.id);
    assert.equal(env.sandbox.authenticateClient(bearer(token)), null);
    assert.equal(env.sandbox.authenticateClient(bearer(rotated.token)).id, client.id);
    assert.equal((await env.sandbox.api.deleteClient(client.id)).success, true);
    assert.equal(env.sandbox.authenticateClient(bearer(rotated.token)), null);
  });

  it("applies changed rights to the next request", async () => {
    const { client, token } = await env.sandbox.api.createClient(settings);
    await env.sandbox.api.updateClient(client.id, { ...settings, capabilities: ["accounts.read"] });
    assert.deepEqual(plain(env.sandbox.authenticateClient(bearer(token)).capabilities), ["accounts.read"]);
  });

  it("rejects invalid settings without writing", async () => {
    assert.match((await env.sandbox.api.createClient({ ...settings, accounts: ["account3"] })).error, /Unknown account/);
    assert.equal(env.pref(), undefined);
  });

  it("fails closed on a corrupt registry until the user removes all clients", async () => {
    const { token } = await env.sandbox.api.createClient(settings);
    env.prefs.set("extensions.thunderbird-mcp-hardened.clients", env.pref().replace('"version":1', '"version":9'));
    assert.equal(env.sandbox.authenticateClient(bearer(token)), null);
    assert.equal((await env.sandbox.api.listClients()).corrupt, true);
    assert.match((await env.sandbox.api.createClient(settings)).error, /corrupt/);
    assert.equal((await env.sandbox.api.removeAllClients()).success, true);
    assert.equal((await env.sandbox.api.listClients()).corrupt, false);
    assert.equal(env.sandbox.authenticateClient(bearer(token)), null);
  });

  it("fails closed when the preference cannot be read", () => {
    const unreadable = loadAdapter({ initial: JSON.stringify({ version: 1, clients: [storedClient()] }), unreadable: true });
    assert.equal(unreadable.sandbox.authenticateClient(bearer("a".repeat(64))), null);
  });

  it("revocation disables the client's unchanged sending rules and reports changed ones", async () => {
    const { client } = await env.sandbox.api.createClient(settings);
    const forward = env.makeRule("Forward rule", [{ type: 2, value: "x@example.invalid" }]);
    const changed = env.makeRule("Changed rule", [{ type: 2, value: "y@example.invalid" }]);
    const flag = env.makeRule("Flag rule", [{ type: 1 }]);
    env.filterList.filters.push(forward, changed, flag);
    for (const rule of [forward, changed, flag]) env.sandbox.registry.registerFilterChange(client.id, "account1", rule);
    // The user changes one rule afterwards: its fingerprint no longer matches.
    changed.getActionAt = () => ({ type: 2, value: "other@example.invalid" });
    const result = await env.sandbox.api.deleteClient(client.id);
    assert.equal(result.success, true);
    assert.deepEqual(plain(result.filters.disabled), [{ account: "account1", name: "Forward rule" }]);
    assert.deepEqual(plain(result.filters.conflicts).map((c) => c.name), ["Changed rule"]);
    assert.equal(forward.enabled, false);
    assert.equal(changed.enabled, true, "changed user rules are not disabled silently");
    assert.equal(flag.enabled, true, "rules without sending actions stay");
    assert.deepEqual(plain(env.sandbox.registry.readFilterRegistry().entries), []);
  });

  it("reports a rule whose disabling could not be saved", async () => {
    const { client } = await env.sandbox.api.createClient(settings);
    const forward = env.makeRule("Forward rule", [{ type: 2, value: "x@example.invalid" }]);
    env.filterList.filters.push(forward);
    env.sandbox.registry.registerFilterChange(client.id, "account1", forward);
    env.filterList.saveToDefaultFile = () => { throw new Error("NS_ERROR_FILE_ACCESS_DENIED"); };
    const result = await env.sandbox.api.deleteClient(client.id);
    assert.deepEqual(plain(result.filters.disabled), []);
    assert.match(result.filters.conflicts[0].reason, /could not be saved.*disable the rule manually/);
    assert.equal(forward.enabled, false, "stays disabled for the running session");
  });
  it("is not reachable through MCP tools", () => {
    const tools = Core.policy.knownTools();
    for (const name of ["listClients", "createClient", "updateClient", "rotateClientToken", "deleteClient", "removeAllClients"]) {
      assert.equal(tools.includes(name), false, name);
    }
  });
});
