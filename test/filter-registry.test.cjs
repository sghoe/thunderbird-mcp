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
    let entries = R().recordFilter([entry(), other], { clientId: "a".repeat(32), accountKey: "account1", name: "Rule", fingerprint: "d".repeat(64), oldFingerprint: "f".repeat(64), now: 2 });
    assert.deepEqual(entries.map((e) => e.fingerprint).sort(), ["d".repeat(64), "e".repeat(64)]);
    assert.equal(R().isRegistered(entries, "account1", "d".repeat(64)), true);
    entries = R().forgetFilter(entries, "account1", "d".repeat(64));
    assert.deepEqual(plain(R().entriesForClient(entries, "b".repeat(32))), [other]);
    assert.deepEqual(plain(R().withoutClient(entries, "b".repeat(32))), []);
  });
});
