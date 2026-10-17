"use strict";

// Stage 5: a checked path attachment is bound to its content by a private
// copy made right after the checks.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
function snippet(name) {
  const start = source.indexOf(`// BEGIN ${name}`);
  const end = source.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `Missing production marker: ${name}`);
  return source.slice(start, end);
}

function load({ content = Buffer.from("contract v1"), growBy = 0, shrinkBy = 0, laterStat, writeError } = {}) {
  const state = { written: new Map(), flags: [], perms: [], removed: [], dirs: [] };
  const original = { path: "/home/user/contract.pdf", leafName: "contract.pdf", lastModifiedTime: 1000, fileSize: content.length };
  const files = new Map();
  function tempDir(p) {
    return {
      path: p,
      append(name) { this.path += `/${name}`; },
      exists: () => state.dirs.includes(p),
      create(_type, perm) { state.dirs.push(this.path); state.dirPerm = perm; },
    };
  }
  const sandbox = {
    _tempAttachFiles: new Set(["/unrelated"]),
    _pinnedAttachFiles: new Set(),
    _uncertainAttachFiles: new Set(),
    _callAttachFiles: null,
    _tempFileCounter: 0,
    console: { warn() {} },
    Ci: { nsIFile: { DIRECTORY_TYPE: 1 } },
    Services: { dirsvc: { get: () => tempDir("/tmp") } },
    createLocalFile(p) {
      if (p === original.path) {
        const stat = laterStat || {};
        return { path: p, fileSize: stat.fileSize ?? content.length, lastModifiedTime: stat.lastModifiedTime ?? 1000 };
      }
      return files.get(p) || { path: p, exists: () => false, remove() {} };
    },
    Cc: {
      "@mozilla.org/network/file-input-stream;1": { createInstance: () => ({
        init(file, flags) { assert.equal(file, original); assert.equal(flags, 0x01); },
        close() {},
      }) },
      "@mozilla.org/binaryinputstream;1": { createInstance: () => {
        const data = Buffer.concat([content.subarray(0, content.length - shrinkBy), Buffer.alloc(growBy, 0x41)]);
        let offset = 0;
        return {
          setInputStream() {},
          readArrayBuffer(length, buffer) {
            const n = Math.min(length, data.length - offset);
            new Uint8Array(buffer).set(data.subarray(offset, offset + n));
            offset += n;
            return n;
          },
          close() { state.inputClosed = true; },
        };
      } },
      "@mozilla.org/network/file-output-stream;1": { createInstance: () => ({
        init(file, flags, perm) {
          state.flags.push(flags);
          state.perms.push(perm);
          state.target = file.path;
          files.set(file.path, { path: file.path, exists: () => true, remove() { state.removed.push(file.path); } });
        },
        close() { state.outputClosed = true; },
      }) },
      "@mozilla.org/binaryoutputstream;1": { createInstance: () => ({
        setOutputStream() {},
        writeByteArray(bytes, length) {
          if (writeError) throw new Error("disk full");
          state.written.set(state.target, Buffer.from(bytes).subarray(0, length));
        },
        close() {},
      }) },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext([snippet("PRIVATE ATTACHMENT NAMES"), snippet("OUTGOING ATTACHMENT FILES")].join("\n"), sandbox);
  return { sandbox, state, original };
}

describe("content-bound path attachments (Stage 5)", () => {
  it("copies exactly the checked bytes into a new private file", () => {
    const { sandbox, state, original } = load();
    const created = [];
    const copy = sandbox.copyCheckedAttachmentFile(original, original.fileSize, created);
    assert.match(copy.path, /^\/tmp\/thunderbird-mcp-hardened\/outgoing\/\d+_1_contract\.pdf$/);
    assert.equal(state.written.get(copy.path).toString(), "contract v1");
    assert.ok(state.flags[0] & 0x80, "exclusive creation");
    assert.equal(state.perms[0], 0o600);
    assert.equal(state.dirPerm, 0o700);
    assert.deepEqual(created, [copy]);
    assert.ok(sandbox._tempAttachFiles.has(copy.path));
    assert.ok(sandbox._pinnedAttachFiles.has(copy.path), "pinned from creation: the call may still be preparing its message");
    assert.equal(state.inputClosed, true);
    assert.equal(state.outputClosed, true);
  });

  for (const [label, options] of [
    ["grew", { growBy: 1 }],
    ["shrank", { shrinkBy: 1 }],
    ["was modified", { laterStat: { lastModifiedTime: 2000 } }],
    ["changed size afterwards", { laterStat: { fileSize: 3 } }],
  ]) {
    it(`refuses a file that ${label} while it was attached, before any copy exists`, () => {
      const { sandbox, state, original } = load(options);
      const created = [];
      assert.throws(() => sandbox.copyCheckedAttachmentFile(original, original.fileSize, created), /changed while it was being attached/);
      assert.equal(created.length, 0);
      assert.equal(state.written.size, 0);
      assert.equal(state.inputClosed, true);
    });
  }

  it("copies an empty file", () => {
    const { sandbox, state, original } = load({ content: Buffer.alloc(0) });
    const copy = sandbox.copyCheckedAttachmentFile(original, 0, []);
    assert.equal(state.written.get(copy.path).length, 0);
  });

  it("registers a failed copy for cleanup by the caller", () => {
    const { sandbox, original } = load({ writeError: true });
    const created = [];
    assert.throws(() => sandbox.copyCheckedAttachmentFile(original, original.fileSize, created), /disk full/);
    assert.equal(created.length, 1, "the caller removes it with the call's other temporary files");
  });

  it("releases only this call's tracked copies", () => {
    const { sandbox, state, original } = load();
    const copy = sandbox.copyCheckedAttachmentFile(original, original.fileSize, []);
    sandbox.releaseOutgoingAttachments([
      { tempPath: copy.path }, { tempPath: "/untracked" }, { url: "mailbox-message://part" }, null,
    ]);
    assert.deepEqual(state.removed, [copy.path]);
    assert.equal(sandbox._tempAttachFiles.has(copy.path), false);
    assert.equal(sandbox._pinnedAttachFiles.has(copy.path), false, "unpinned once released");
    assert.ok(sandbox._tempAttachFiles.has("/unrelated"));
  });
});

describe("private attachment names (Stage 5 review round 5)", () => {
  function nameFor(name) {
    const sandbox = { _tempFileCounter: 0 };
    vm.createContext(sandbox);
    vm.runInContext(snippet("PRIVATE ATTACHMENT NAMES"), sandbox);
    return sandbox.privateAttachmentName(name);
  }
  it("stays short for a long original name and keeps the extension", () => {
    const name = nameFor(`${"a".repeat(240)}.pdf`);
    assert.ok(name.length < 100, `${name.length} characters`);
    assert.match(name, /^\d+_1_a{40}\.pdf$/);
  });
  it("sanitizes and handles names without a usable stem", () => {
    assert.match(nameFor("Vertrag (final).docx"), /^\d+_1_Vertrag__final_\.docx$/);
    assert.match(nameFor(".."), /^\d+_1_attachment$/);
    assert.match(nameFor(".bashrc"), /^\d+_1_attachment\.bashrc$/);
    assert.match(nameFor(""), /^\d+_1_attachment$/);
  });
});