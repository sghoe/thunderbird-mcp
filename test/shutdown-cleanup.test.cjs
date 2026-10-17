"use strict";

// Stage 5: what happens to private attachment files when the add-on stops
// (onShutdown, SHUTDOWN ATTACHMENT CLEANUP block).

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
const start = source.indexOf("// BEGIN SHUTDOWN ATTACHMENT CLEANUP");
const end = source.indexOf("// END SHUTDOWN ATTACHMENT CLEANUP", start);
assert.ok(start >= 0 && end > start, "Missing production marker: SHUTDOWN ATTACHMENT CLEANUP");
const block = source.slice(start, end);

const A = "/tmp/thunderbird-mcp-hardened/outgoing/1_1_window.txt";
const B = "/tmp/thunderbird-mcp-hardened/outgoing/1_2_pinned.txt";
const C = "/tmp/thunderbird-mcp-hardened/outgoing/1_3_unused.txt";

function composeWindow({ bucket = [], fields = [], ready = true, loading = false } = {}) {
  return {
    document: {
      readyState: loading ? "loading" : "complete",
      documentElement: { getAttribute: () => "msgcompose" },
    },
    gMsgCompose: ready ? { compFields: { attachments: fields.map(url => ({ url })) } } : null,
    gAttachmentBucket: ready ? { itemChildren: bucket.map(url => ({ attachment: { url } })) } : null,
  };
}

function run(isAppShutdown, { windows = [], pinned = [] } = {}) {
  const removed = [];
  const prefs = new Map();
  const sandbox = {
    PREF_RETAINED_ATTACHMENTS: "retained",
    _tempAttachFiles: new Set([A, B, C]),
    _pinnedAttachFiles: new Set(pinned),
    Cc: { "@mozilla.org/file/local;1": { createInstance: () => ({
      initWithPath(p) { this.path = p; },
      exists: () => true,
      remove() { removed.push(this.path); },
    }) } },
    Ci: { nsIFile: {} },
    Services: {
      ww: { getWindowEnumerator: () => windows },
      io: { newFileURI: file => ({ spec: `file://${file.path}` }) },
      prefs: { setStringPref: (k, v) => prefs.set(k, v), clearUserPref: k => prefs.delete(k) },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`(function (isAppShutdown) {\n${block}\n})(${isAppShutdown});`, sandbox);
  return { removed, retained: prefs.has("retained") ? JSON.parse(prefs.get("retained")) : [], sandbox };
}

describe("attachment files at add-on shutdown (Stage 5)", () => {
  it("keeps files of open compose windows and of running or uncertain operations", () => {
    const { removed, retained, sandbox } = run(false, {
      windows: [composeWindow({ bucket: [`file://${A}`] })],
      pinned: [B],
    });
    assert.deepEqual(removed, [C]);
    assert.deepEqual(retained, [A, B]);
    assert.equal(sandbox._tempAttachFiles.size, 0);
    assert.equal(sandbox._pinnedAttachFiles.size, 0);
  });

  it("also finds attachments a compose window only holds in its compose fields", () => {
    const { removed } = run(false, { windows: [composeWindow({ fields: [`file://${C}`] })] });
    assert.deepEqual(removed.sort(), [A, B].sort());
  });

  for (const [label, win] of [
    ["a window that is still loading", composeWindow({ loading: true })],
    ["a compose window without compose state", composeWindow({ ready: false })],
  ]) {
    it(`keeps every file when ${label} cannot be inspected`, () => {
      const { removed, retained } = run(false, { windows: [win] });
      assert.deepEqual(removed, []);
      assert.deepEqual(retained, [A, B, C]);
    });
  }

  it("removes everything at application shutdown", () => {
    const { removed, retained } = run(true, { windows: [composeWindow({ bucket: [`file://${A}`] })], pinned: [B] });
    assert.deepEqual(removed, [A, B, C]);
    assert.deepEqual(retained, []);
  });
});
