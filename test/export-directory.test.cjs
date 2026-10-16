"use strict";

// The export directory lives next to, not inside, the runtime directory, so
// it needs its own fail-closed checks against pre-created directories and
// symlinks on a shared POSIX /tmp.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
const START = "// BEGIN ATTACHMENT EXPORT DIRECTORY";
const END = "// END ATTACHMENT EXPORT DIRECTORY";
const snippet = source.slice(source.indexOf(START), source.indexOf(END));

function load({ os = "Linux", entries = {} } = {}) {
  const created = [];
  function file(p) {
    return {
      path: p,
      append(name) { this.path += `/${name}`; },
      clone() { return file(this.path); },
      create() {
        const entry = entries[this.path];
        if (entry) throw new Error("NS_ERROR_FILE_ALREADY_EXISTS");
        entries[this.path] = { mode: 0o700 };
        created.push(this.path);
      },
      exists() { return !!entries[this.path]; },
      isDirectory() { return !!entries[this.path]; },
      isSymlink() { return !!entries[this.path]?.symlink; },
      get permissions() { return entries[this.path].mode; },
      set permissions(mode) {
        if (entries[this.path].foreign) throw new Error("NS_ERROR_FILE_ACCESS_DENIED");
        entries[this.path].mode = mode;
      },
    };
  }
  const sandbox = {
    Services: { appinfo: { OS: os }, dirsvc: { get: () => file("/tmp") } },
    Ci: { nsIFile: { DIRECTORY_TYPE: 1 } },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${snippet}\nthis.ensureAttachmentDir = ensureAttachmentDir;`, sandbox);
  return { ensureAttachmentDir: sandbox.ensureAttachmentDir, entries, created };
}

const ROOT = "/tmp/thunderbird-mcp-hardened-exports";

describe("attachment export directory", () => {
  it("creates a private root and message directory", () => {
    const { ensureAttachmentDir, created } = load();
    assert.equal(ensureAttachmentDir("message_1").path, `${ROOT}/message_1`);
    assert.deepEqual(created, [ROOT, `${ROOT}/message_1`]);
  });

  it("refuses a root pre-created by another user with open permissions", () => {
    const { ensureAttachmentDir } = load({ entries: { [ROOT]: { mode: 0o777, foreign: true } } });
    assert.throws(() => ensureAttachmentDir("message_1"), /group\/world permissions/);
  });

  it("tightens an own root that has open permissions", () => {
    const { ensureAttachmentDir, entries } = load({ entries: { [ROOT]: { mode: 0o755 } } });
    ensureAttachmentDir("message_1");
    assert.equal(entries[ROOT].mode, 0o700);
  });

  for (const target of [ROOT, `${ROOT}/message_1`]) {
    it(`refuses a symlink at ${target}`, () => {
      const entries = { [ROOT]: { mode: 0o700 } };
      entries[target] = { mode: 0o700, symlink: true };
      const { ensureAttachmentDir } = load({ entries });
      assert.throws(() => ensureAttachmentDir("message_1"), /symlink/);
    });
  }

  it("does not apply POSIX modes on Windows but still refuses symlinks", () => {
    const { ensureAttachmentDir } = load({ os: "WINNT", entries: { [ROOT]: { mode: 0o777, foreign: true } } });
    assert.equal(ensureAttachmentDir("message_1").path, `${ROOT}/message_1`);
    const symlinked = load({ os: "WINNT", entries: { [ROOT]: { mode: 0o700, symlink: true } } });
    assert.throws(() => symlinked.ensureAttachmentDir("message_1"), /symlink/);
  });
});
