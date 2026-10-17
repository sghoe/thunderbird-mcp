"use strict";

// Ambiguous Message-IDs are refused; the per-folder count index that makes
// this affordable must never report a stale "unique" and must not keep
// folder databases alive.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
const START = "// BEGIN MESSAGE-ID INDEX";
const snippet = source.slice(source.indexOf(START), source.indexOf("// END MESSAGE-ID INDEX"));

// Each load() is one server instance; `shared` plays the process global.
function load(shared = {}) {
  const clock = { now: 1000 };
  const timers = [];
  const sandbox = Object.assign(shared, {
    Date: { now: () => clock.now },
    Ci: { nsITimer: { TYPE_ONE_SHOT: 0 } },
    Cc: { "@mozilla.org/timer;1": { createInstance: () => {
      const timer = { cancelled: false, initWithCallback(cb) { this.cb = cb; }, cancel() { this.cancelled = true; } };
      timers.push(timer);
      return timer;
    } } },
  });
  if (!vm.isContext(sandbox)) vm.createContext(sandbox);
  // A fresh function scope per instance, like each server start().
  const instance = vm.runInContext(`(() => { ${snippet}\nreturn { lookupUniqueMessage, _messageIdIndexes }; })()`, sandbox);
  return { lookup: instance.lookupUniqueMessage, clock, indexes: instance._messageIdIndexes, timers, sandbox };
}

// Mimics nsIMsgDatabase: headers, change listeners, Message-ID lookup.
function makeDb(ids, { listeners = true } = {}) {
  const db = {
    headers: ids.map((messageId, key) => ({ messageId, key })),
    enumerations: 0,
    listeners: new Set(),
    enumerateMessages() { this.enumerations++; return this.headers.slice(); },
    getMsgHdrForMessageID(id) { return this.headers.find((h) => h.messageId === id) || null; },
    notify(event) { for (const l of this.listeners) l[event](); },
    add(messageId) { this.headers.push({ messageId, key: 0xffffff80 }); this.notify("onHdrAdded"); },
    remove(index) { this.headers.splice(index, 1); this.notify("onHdrDeleted"); },
  };
  if (listeners) {
    db.addListener = (l) => db.listeners.add(l);
    db.removeListener = (l) => db.listeners.delete(l);
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

  it("reuses the counts while the database reports no change", () => {
    const { lookup } = load();
    const db = makeDb(["a@x", "b@x"]);
    lookup(folder, db, "a@x");
    lookup(folder, db, "b@x");
    lookup(folder, db, "a@x");
    assert.equal(db.enumerations, 1);
  });

  it("recounts after a duplicate arrives, even with an unchanged count and key watermark", () => {
    const { lookup } = load();
    const db = makeDb(["a@x", "b@x", "c@x"]);
    assert.equal(lookup(folder, db, "a@x").hdr.messageId, "a@x");
    // Net-zero change with a reused IMAP fake offline key.
    db.remove(2);
    db.add("a@x");
    assert.equal(lookup(folder, db, "a@x").ambiguous, true);
  });

  for (const event of ["onHdrPropertyChanged", "onAnnouncerGoingAway"]) {
    it(`invalidates on ${event}`, () => {
      const { lookup } = load();
      const db = makeDb(["a@x"]);
      lookup(folder, db, "a@x");
      db.notify(event);
      lookup(folder, db, "a@x");
      assert.equal(db.enumerations, 2);
    });
  }

  it("does not cache where no change listener can be attached", () => {
    const { lookup, indexes } = load();
    const db = makeDb(["a@x"], { listeners: false });
    lookup(folder, db, "a@x");
    lookup(folder, db, "a@x");
    assert.equal(db.enumerations, 2);
    assert.equal(indexes.size, 0);
  });

  it("expires entries and detaches their listener on any later call", () => {
    const { lookup, clock, indexes } = load();
    const db = makeDb(["a@x"]);
    lookup(folder, db, "a@x");
    assert.equal(db.listeners.size, 1);
    clock.now += 61000;
    lookup({ URI: "mailbox://alice@127.0.0.1/Other" }, makeDb(["z@x"], { listeners: false }), "z@x");
    assert.equal(db.listeners.size, 0);
    assert.equal(indexes.has(folder.URI), false);
  });

  it("releases the database and its listener when the expiry timer fires", () => {
    const { lookup, indexes, timers } = load();
    const db = makeDb(["a@x"]);
    lookup(folder, db, "a@x");
    const entry = indexes.get(folder.URI);
    assert.equal(db.listeners.size, 1);
    timers[0].cb.notify();
    assert.equal(db.listeners.size, 0);
    assert.equal(indexes.size, 0);
    assert.equal(entry.db, null);
    assert.equal(entry.counts, null);
  });

  it("a new server instance detaches the previous instance's listeners", () => {
    const shared = {};
    const db = makeDb(["a@x"]);
    for (let i = 0; i < 10; i++) load(shared).lookup(folder, db, "a@x");
    assert.equal(db.listeners.size, 1);
    shared.__tbMcpHardenedClearMessageIdIndexes();
    assert.equal(db.listeners.size, 0);
  });

  it("does not reuse counts for a reopened database", () => {
    const { lookup } = load();
    lookup(folder, makeDb(["a@x"]), "a@x");
    const reopened = makeDb(["a@x", "a@x"]);
    assert.equal(lookup(folder, reopened, "a@x").ambiguous, true);
  });

  it("keeps at most eight folders and detaches evicted listeners", () => {
    const { lookup, indexes } = load();
    const dbs = [];
    for (let i = 0; i < 10; i++) {
      const db = makeDb([`m${i}@x`]);
      dbs.push(db);
      lookup({ URI: `mailbox://alice@127.0.0.1/F${i}` }, db, `m${i}@x`);
    }
    assert.equal(indexes.size, 8);
    assert.equal(dbs[0].listeners.size, 0);
    assert.equal(dbs[9].listeners.size, 1);
  });
});

describe("ambiguity candidates follow mail.metadata (Stage 5 review round 6)", () => {
  function candidatesFor(granted) {
    const sandbox = { Date, Ci: { nsITimer: { TYPE_ONE_SHOT: 0 } }, Cc: {}, clientHasCapability: (cap) => granted.includes(cap) };
    vm.createContext(sandbox);
    const make = vm.runInContext(`(() => { ${snippet}\nreturn ambiguousMessageError; })()`, sandbox);
    const db = { enumerateMessages: () => [
      { messageId: "d@x", messageKey: 1, date: 1e15, author: "Boss <boss@corp.test>" },
      { messageId: "d@x", messageKey: 2, date: 2e15, author: "Mallory <m@attacker.test>" },
    ] };
    return JSON.parse(JSON.stringify(make(db, ["d@x"]).candidates));
  }
  it("lists date and author for clients that may read metadata", () => {
    const candidates = candidatesFor(["mail.metadata"]);
    assert.deepEqual(candidates.map((c) => c.author), ["Boss <boss@corp.test>", "Mallory <m@attacker.test>"]);
    assert.ok(candidates.every((c) => c.date && /^msgref:\d+:d@x$/.test(c.messageId)));
  });
  it("lists only references for a client that may only delete", () => {
    assert.deepEqual(candidatesFor(["mail.delete"]), [{ messageId: "msgref:1:d@x" }, { messageId: "msgref:2:d@x" }]);
  });
});