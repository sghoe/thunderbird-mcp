"use strict";

// Stage 5 core: register of filter rules created or changed through MCP.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { Core } = require("./helpers/core-modules.cjs");

const R = () => Core.filterRegistry;
const plain = (value) => JSON.parse(JSON.stringify(value));
const entry = (overrides = {}) => ({
  clientId: "a".repeat(32), accountKey: "account1", name: "Rule", fingerprint: "f".repeat(64), createdAt: 1, ...overrides,
});

describe("filter register rules", () => {
  it("starts empty and round-trips", () => {
    assert.deepEqual(plain(R().parseFilterRegistry("")), { entries: [], corrupt: false });
    const text = R().serializeFilterRegistry([entry()]);
    assert.deepEqual(plain(R().parseFilterRegistry(text).entries), [entry()]);
  });

  for (const [label, text] of [
    ["malformed JSON", "{"],
    ["wrong version", JSON.stringify({ version: 2, entries: [] })],
    ["extra key", JSON.stringify({ version: 1, entries: [], x: 1 })],
    ["bad client id", JSON.stringify({ version: 1, entries: [entry({ clientId: "nope" })] })],
    ["bad fingerprint", JSON.stringify({ version: 1, entries: [entry({ fingerprint: "x" })] })],
    ["extra entry field", JSON.stringify({ version: 1, entries: [{ ...entry(), index: 3 }] })],
  ]) {
    it(`treats ${label} as corrupt`, () => {
      assert.equal(R().parseFilterRegistry(text).corrupt, true);
    });
  }

  it("canonicalises key order so equal rules have equal text", () => {
    const a = R().canonicalFilter({ type: 1, terms: [{ op: "contains", attrib: "subject" }], actions: [{ value: "x", type: "forward" }] });
    const b = R().canonicalFilter({ actions: [{ type: "forward", value: "x" }], terms: [{ attrib: "subject", op: "contains" }], type: 1 });
    assert.equal(a, b);
  });

  it("replaces the previous content of a changed rule and keeps other clients' entries", () => {
    const other = entry({ clientId: "b".repeat(32), fingerprint: "e".repeat(64) });
    let entries = R().recordFilter([entry(), other], { clientId: "a".repeat(32), accountKey: "account1", name: "Rule", fingerprint: "d".repeat(64), oldFingerprint: "f".repeat(64), oldLiveMatches: 1, now: 2 });
    assert.deepEqual(entries.map((e) => e.fingerprint).sort(), ["d".repeat(64), "e".repeat(64)]);
    assert.equal(R().isRegistered(entries, "account1", "d".repeat(64), 1), true);
    entries = R().forgetFilter(entries, "account1", "d".repeat(64), { clientId: "a".repeat(32), liveMatchesBefore: 1 });
    assert.deepEqual(plain(R().entriesForClient(entries, "b".repeat(32))), [other]);
    assert.deepEqual(plain(R().withoutClient(entries, "b".repeat(32))), []);
  });
});

describe("filter register: identical rules, capacity and names (Stage 5 review)", () => {
  const A = "a".repeat(32);
  const B = "b".repeat(32);
  const F = "f".repeat(64);
  const record = (entries, overrides = {}) => R().recordFilter(entries, { clientId: A, accountKey: "account1", name: "Rule", fingerprint: F, now: 1, ...overrides });

  it("treats identical rules as foreign while the user has one of them", () => {
    // A client copies a user rule: one entry, two live rules -> neither is registered.
    const entries = record([]);
    assert.equal(R().isRegistered(entries, "account1", F, 2), false);
    assert.equal(R().isRegistered(entries, "account1", F, 1), true);
    assert.equal(R().isRegistered(entries, "account1", F, 0), false);
    // Two rules created through MCP stay registered.
    assert.equal(R().isRegistered(record(entries), "account1", F, 2), true);
  });

  it("keeps another client's entry when an identical rule goes away", () => {
    let entries = record([], { clientId: A });
    entries = record(entries, { clientId: B });
    const forgotten = R().forgetFilter(entries, "account1", F, { clientId: B, liveMatchesBefore: 2 });
    assert.deepEqual(forgotten.map((e) => e.clientId), [A]);
  });

  it("does not drop a registration when a foreign twin is deleted or changed", () => {
    const entries = record([]);
    // Two live rules (the client's and the user's twin), one entry.
    assert.equal(R().forgetFilter(entries, "account1", F, { clientId: B, liveMatchesBefore: 2 }).length, 1);
    const changed = record(entries, { clientId: B, fingerprint: "d".repeat(64), oldFingerprint: F, oldLiveMatches: 2 });
    assert.deepEqual(changed.map((e) => [e.clientId, e.fingerprint[0]]), [[A, "f"], [B, "d"]]);
  });

  it("refuses to grow beyond the limit instead of evicting entries", () => {
    const full = Array.from({ length: R().MAX_ENTRIES }, (_, i) => entry({ fingerprint: i.toString(16).padStart(64, "0") }));
    assert.throws(() => record(full), /register is full/);
    // Replacing a registered rule's content does not grow the register.
    const replaced = record(full, { fingerprint: "e".repeat(64), oldFingerprint: full[0].fingerprint, oldLiveMatches: 1 });
    assert.equal(replaced.length, R().MAX_ENTRIES);
  });

  it("stores over-long names truncated so the register stays readable", () => {
    const entries = record([], { name: "x".repeat(5000) });
    assert.equal(entries[0].name.length, R().MAX_NAME_LENGTH);
    assert.equal(R().parseFilterRegistry(R().serializeFilterRegistry(entries)).corrupt, false);
  });

  it("groups identical rules for revocation and decides per group", () => {
    let entries = record([], { clientId: A });
    entries = record(entries, { clientId: A });
    entries = record(entries, { clientId: B, fingerprint: "d".repeat(64) });
    const groups = R().revocationGroups(entries, [A]);
    assert.equal(groups.length, 1);
    assert.deepEqual({ ...groups[0], names: [...groups[0].names] }, { accountKey: "account1", fingerprint: F, names: ["Rule"], revoked: 2, others: 0 });
    const decide = R().revocationDecision;
    assert.deepEqual({ ...decide({ live: 2, revoked: 2, others: 0 }) }, { disable: true });
    assert.match(decide({ live: 0, revoked: 1, others: 0 }).conflict, /changed or removed/);
    assert.match(decide({ live: 3, revoked: 2, others: 0 }).conflict, /not created through MCP/);
    assert.match(decide({ live: 2, revoked: 1, others: 1 }).conflict, /another client/);
  });
});

describe("filter register: stored size and partial groups (Stage 5 review round 2)", () => {
  const A = "a".repeat(32);
  const record = (entries, overrides = {}) => R().recordFilter(entries, { clientId: A, accountKey: "account1", name: "Rule", fingerprint: "f".repeat(64), now: 1, ...overrides });

  it("stays below the preference size limit even with multibyte names", () => {
    let entries = [];
    let refused = null;
    for (let i = 0; i < R().MAX_ENTRIES; i++) {
      try {
        entries = record(entries, { name: "日本語".repeat(100), fingerprint: i.toString(16).padStart(64, "0") });
      } catch (e) { refused = e; break; }
    }
    assert.match(String(refused), /register is full/);
    const bytes = Buffer.byteLength(R().serializeFilterRegistry(entries), "utf8");
    assert.ok(bytes <= R().MAX_SERIALIZED_BYTES && bytes < 1024 * 1024, `${bytes} bytes`);
    assert.equal(R().parseFilterRegistry(R().serializeFilterRegistry(entries)).corrupt, false);
  });

  it("measures UTF-8 like the platform", () => {
    for (const text of ["abc", "äöü", "日本", "😀x", "\"quoted\""]) {
      assert.equal(R().utf8Length(text), Buffer.byteLength(text, "utf8"), text);
    }
  });

  it("truncates names by code points (no lone surrogates)", () => {
    const [stored] = record([], { name: "😀".repeat(500) });
    assert.equal(Array.from(stored.name).length, R().MAX_NAME_LENGTH);
    assert.equal(R().parseFilterRegistry(R().serializeFilterRegistry([stored])).corrupt, false);
  });

  it("disables the remaining identical rules of a partly changed group and reports the missing ones", () => {
    const decision = R().revocationDecision({ live: 1, revoked: 2, others: 0 });
    assert.equal(decision.disable, true);
    assert.match(decision.conflict, /1 of 2 identical registered rules were changed or removed/);
  });
});