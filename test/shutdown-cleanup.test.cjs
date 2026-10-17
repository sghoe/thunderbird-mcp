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

function run(isAppShutdown, { windows = [], pinned = [], files = [A, B, C], chunk = 2000, stale = 0 } = {}) {
  const removed = [];
  const prefs = new Map();
  for (let i = 0; i < stale; i++) prefs.set(`retained.${i}`, "{}");
  const sandbox = {
    PREF_RETAINED_ATTACHMENTS: "retained",
    RETAINED_ATTACHMENT_CHUNK: chunk,
    retainedAttachmentPref: (index) => `retained.${index}`,
    _tempAttachFiles: new Set(files),
    _pinnedAttachFiles: new Set(pinned),
    _uncertainAttachFiles: new Set(pinned),
    Cc: { "@mozilla.org/file/local;1": { createInstance: () => ({
      initWithPath(p) { this.path = p; this.leafName = p.split("/").pop(); },
      exists: () => true,
      remove() { removed.push(this.path); },
    }) } },
    Ci: { nsIFile: {}, nsIPrefBranch: { PREF_INVALID: 0, PREF_STRING: 32 } },
    Services: {
      ww: { getWindowEnumerator: () => windows },
      io: { newFileURI: file => ({ spec: `file://${file.path}` }) },
      prefs: {
        getPrefType: k => (prefs.has(k) ? 32 : 0),
        setStringPref: (k, v) => prefs.set(k, v),
        clearUserPref: k => prefs.delete(k),
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`(function (isAppShutdown) {\n${block}\n})(${isAppShutdown});`, sandbox);
  const chunks = [...prefs.keys()].sort((a, b) => Number(a.split(".")[1]) - Number(b.split(".")[1])).map(k => JSON.parse(prefs.get(k)));
  const retained = chunks.flatMap(c => c.files);
  const retainedPinned = chunks.flatMap(c => c.pinned.map(i => c.files[i]));
  return { removed, retained, retainedPinned, chunks, prefs, sandbox };
}

describe("attachment files at add-on shutdown (Stage 5)", () => {
  it("keeps files of open compose windows and of running or uncertain operations", () => {
    const { removed, retained, retainedPinned, sandbox } = run(false, {
      windows: [composeWindow({ bucket: [`file://${A}`] })],
      pinned: [B],
    });
    assert.deepEqual(retainedPinned, ["1_2_pinned.txt"], "only the pinned file stays pinned in the next instance");
    assert.deepEqual(removed, [C]);
    assert.deepEqual([...retained].sort(), ["1_1_window.txt", "1_2_pinned.txt"]);
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
      assert.deepEqual(retained, ["1_1_window.txt", "1_2_pinned.txt", "1_3_unused.txt"]);
    });
  }

  it("hands over any number of files in bounded chunks and deletes none that are in use", () => {
    const files = Array.from({ length: 25 }, (_, i) => `/tmp/thunderbird-mcp-hardened/outgoing/1700000000000_${i}_attachment.pdf`);
    const { removed, retained, retainedPinned, chunks, prefs } = run(false, {
      files, pinned: [files[24]], chunk: 10, stale: 5,
      windows: [composeWindow({ bucket: files.slice(0, 24).map(p => `file://${p}`) })],
    });
    assert.deepEqual(removed, []);
    assert.equal(retained.length, 25);
    assert.deepEqual(chunks.map(c => c.files.length), [10, 10, 5]);
    assert.deepEqual(retainedPinned, ["1700000000000_24_attachment.pdf"]);
    assert.equal(prefs.has("retained.3") || prefs.has("retained.4"), false, "stale chunks removed");
  });

  it("keeps each chunk far below Gecko's 1 MiB preference limit", () => {
    const chunk = Number(/const RETAINED_ATTACHMENT_CHUNK = (\d+);/.exec(source)[1]);
    // Longest names privateAttachmentName produces: 13-digit time, long counter, 40-char stem, 16-char extension.
    const names = Array.from({ length: chunk }, (_, i) => `1700000000000_${100000 + i}_${"a".repeat(40)}.${"b".repeat(16)}`);
    const bytes = Buffer.byteLength(JSON.stringify({ files: names, pinned: names.map((_, i) => i) }), "utf8");
    assert.ok(bytes < 1024 * 1024, `${bytes} bytes`);
  });

  it("removes everything at application shutdown", () => {
    const { removed, retained } = run(true, { windows: [composeWindow({ bucket: [`file://${A}`] })], pinned: [B] });
    assert.deepEqual([...removed].sort(), [A, B, C].sort());
    assert.deepEqual(retained, []);
  });
});

describe("attachment hand-over to the next instance (Stage 5)", () => {
  const adoptStart = source.indexOf("const PREF_RETAINED_ATTACHMENTS");
  // Chunks as written by the shutdown block.
  const chunked = (list, pinned, size = 2000) => {
    const prefs = new Map();
    for (let i = 0; i * size < list.length; i++) {
      const files = list.slice(i * size, (i + 1) * size);
      prefs.set(`extensions.thunderbird-mcp-hardened.retainedAttachments.${i}`,
        JSON.stringify({ files, pinned: files.flatMap((name, index) => (pinned.includes(name) ? [index] : [])) }));
    }
    return prefs;
  };
  const adoptEnd = source.indexOf("const _adoptedAttachFiles", adoptStart);
  assert.ok(adoptStart >= 0 && adoptEnd > adoptStart, "adoption code not found");
  function adopt(list, pinned = [], size = 2000) {
    const prefs = chunked(list, pinned, size);
    const sandbox = {
      Services: {
        prefs: {
          getPrefType: k => (prefs.has(k) ? 32 : 0),
          getStringPref: (k, d) => (prefs.has(k) ? prefs.get(k) : d),
          clearUserPref: k => prefs.delete(k),
        },
        dirsvc: { get: () => {
          const dir = { path: "/tmp", append(n) { this.path += `/${n}`; }, clone() { return { ...this, append: dir.append }; } };
          return dir;
        } },
      },
      Ci: { nsIFile: {}, nsIPrefBranch: { PREF_INVALID: 0 } },
      Cc: { "@mozilla.org/file/local;1": { createInstance: () => ({
        initWithPath(p) { this.path = p; this.leafName = p.split("/").pop(); this.parent = { path: p.slice(0, p.lastIndexOf("/")) }; },
      }) } },
    };
    vm.createContext(sandbox);
    vm.runInContext(`${source.slice(adoptStart, adoptEnd)}\nthis.adopted = adoptRetainedAttachmentFiles();`, sandbox);
    return { adopted: sandbox.adopted, prefs };
  }

  it("adopts every valid retained file, also beyond 1,000", () => {
    const list = Array.from({ length: 4500 }, (_, i) => `1_${i}_f.txt`);
    const { adopted, prefs } = adopt(list, [list[4499]]);
    assert.equal(adopted.files.length, 4500);
    assert.deepEqual([...adopted.pinned], ["/tmp/thunderbird-mcp-hardened/outgoing/1_4499_f.txt"], "pinned index within its chunk");
    assert.equal(prefs.size, 0, "the hand-over is consumed");
  });

  it("keeps the pinned state of handed-over files", () => {
    const list = ["1_1_window.txt", "1_2_uncertain.txt"];
    const { adopted } = adopt(list, [list[1]]);
    assert.deepEqual([...adopted.pinned], ["/tmp/thunderbird-mcp-hardened/outgoing/1_2_uncertain.txt"]);
  });

  it("adopts nothing outside the private outgoing directory", () => {
    const { adopted } = adopt([
      "1_1_ok.txt",
      "/home/user/1_2_secret.txt",
      "../1_3_x.txt",
      "sub/1_4_x.txt",
      "notes.txt",
      42,
    ]);
    assert.deepEqual([...adopted.files], ["/tmp/thunderbird-mcp-hardened/outgoing/1_1_ok.txt"]);
  });
});

describe("files are pinned only while their tool call runs (Stage 5 review round 5)", () => {
  function block(name) {
    const a = source.indexOf(`// BEGIN ${name}`);
    const b = source.indexOf(`// END ${name}`, a);
    assert.ok(a >= 0 && b > a, `Missing production marker: ${name}`);
    return source.slice(a, b);
  }
  const { Core } = require("./helpers/core-modules.cjs");
  function load(toolResult) {
    const sandbox = {
      Core,
      _tempAttachFiles: new Set(), _pinnedAttachFiles: new Set(), _uncertainAttachFiles: new Set(), _callAttachFiles: null,
      buildTools: () => [{ name: "sendMail", group: "messages" }],
      clientScopeAllows: () => true,
      isPrivacyScopeRestricted: () => false,
      sanitizeToolResultText: value => value,
      // A tool creating a private file in its synchronous part, as filePathsToAttachDescs does.
      composeMail() {
        const file = `/outgoing/1_${sandbox._tempAttachFiles.size + 1}_a.txt`;
        sandbox._tempAttachFiles.add(file);
        sandbox._pinnedAttachFiles.add(file);
        sandbox._callAttachFiles?.add(file);
        sandbox.created = file;
        if (toolResult.operationState === "unknown") sandbox._uncertainAttachFiles.add(file);
        return new Promise(resolve => { sandbox.finish = () => resolve(toolResult); });
      },
    };
    vm.createContext(sandbox);
    vm.runInContext([block("OUTGOING ATTACHMENT FILES"), block("TOOL DISPATCH")].join("\n"), sandbox);
    return sandbox;
  }

  it("keeps a review window's file pinned while the call runs and unpins it afterwards", async () => {
    const sandbox = load({ success: true, operationState: "opened-for-review" });
    const call = sandbox.callTool("sendMail", {});
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(sandbox._pinnedAttachFiles.has(sandbox.created), "pinned during the call");
    sandbox.finish();
    await call;
    assert.equal(sandbox._pinnedAttachFiles.has(sandbox.created), false, "only the open window protects it now");
    assert.equal(sandbox._callAttachFiles, null);
  });

  it("keeps files of an unknown direct outcome pinned", async () => {
    const sandbox = load({ error: "timeout", operationState: "unknown" });
    const call = sandbox.callTool("sendMail", {});
    sandbox.finish();
    await call;
    assert.ok(sandbox._pinnedAttachFiles.has(sandbox.created));
  });
});