"use strict";

// Ambiguous Message-IDs are refused; the per-folder count index that makes
// this affordable must never report a stale "unique".

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
const START = "// BEGIN MESSAGE-ID INDEX";
const snippet = source.slice(source.indexOf(START), source.indexOf("// END MESSAGE-ID INDEX"));

function load() {
  const clock = { now: 1000 };
  const sandbox = { Date: { now: () => clock.now } };
  vm.createContext(sandbox);
  vm.runInContext(`${snippet}\nthis.lookupUniqueMessage = lookupUniqueMessage;`, sandbox);
  return { lookup: sandbox.lookupUniqueMessage, clock };
}

function makeDb(ids, { stamp = true } = {}) {
  const db = {
    headers: ids.map((messageId, key) => ({ messageId, key })),
    enumerations: 0,
    enumerateMessages() { this.enumerations++; return this.headers.slice(); },
    getMsgHdrForMessageID(id) { return this.headers.find((h) => h.messageId === id) || null; },
  };
  if (stamp) {
    Object.defineProperty(db, "dBFolderInfo", {
      get: () => ({ numMessages: db.headers.length, highWater: Math.max(-1, ...db.headers.map((h) => h.key)) }),
    });
  }
  return db;
}

const folder = { URI: "mailbox://alice@127.0.0.1/Inbox" };

describe("Message-ID index", () => {
  it("finds unique messages and refuses ambiguous ones", () => {
    const { lookup } = load();
    const db = makeDb(["a@x", "b@x", "b@x"]);
    assert.equal(lookup(folder, db, "a@x").hdr.messageId, "a@x");
    assert.equal(lookup(folder, db, "b@x").ambiguous, true);
    assert.equal(lookup(folder, db, "c@x").hdr, undefined);
  });

  it("reuses the counts while the folder is unchanged", () => {
    const { lookup } = load();
    const db = makeDb(["a@x", "b@x"]);
    lookup(folder, db, "a@x");
    lookup(folder, db, "b@x");
    lookup(folder, db, "a@x");
    assert.equal(db.enumerations, 1);
  });

  it("recounts after a duplicate arrives, so a stale 'unique' is never returned", () => {
    const { lookup } = load();
    const db = makeDb(["a@x", "b@x"]);
    assert.equal(lookup(folder, db, "a@x").hdr.messageId, "a@x");
    db.headers.push({ messageId: "a@x", key: 7 });
    assert.equal(lookup(folder, db, "a@x").ambiguous, true);
  });

  it("recounts after a delete-and-add that keeps the message count", () => {
    const { lookup } = load();
    const db = makeDb(["a@x", "b@x"]);
    lookup(folder, db, "b@x");
    db.headers.shift();
    db.headers.push({ messageId: "b@x", key: 9 });
    assert.equal(lookup(folder, db, "b@x").ambiguous, true);
  });

  it("does not cache without a change stamp", () => {
    const { lookup } = load();
    const db = makeDb(["a@x"], { stamp: false });
    lookup(folder, db, "a@x");
    lookup(folder, db, "a@x");
    assert.equal(db.enumerations >= 2, true);
  });

  it("expires cached counts", () => {
    const { lookup, clock } = load();
    const db = makeDb(["a@x"]);
    lookup(folder, db, "a@x");
    clock.now += 61000;
    lookup(folder, db, "a@x");
    assert.equal(db.enumerations, 2);
  });

  it("does not reuse counts for a reopened database", () => {
    const { lookup } = load();
    lookup(folder, makeDb(["a@x"]), "a@x");
    const reopened = makeDb(["a@x", "a@x"]);
    assert.equal(lookup(folder, reopened, "a@x").ambiguous, true);
  });
});
