"use strict";

// The tracked dist/thunderbird-mcp.xpi must contain exactly the committed
// extension sources, so a stale or partially rebuilt package (for example one
// missing a security fix) cannot be committed. Rebuild with
// `node scripts/build-xpi.cjs` after changing anything under extension/.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const root = path.resolve(__dirname, "..");
const xpiPath = path.join(root, "dist", "thunderbird-mcp.xpi");

// Minimal ZIP reader (central directory, stored/deflated entries).
function readZip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "ZIP end of central directory not found");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "bad central directory entry");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    if (!name.endsWith("/")) entries.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function listFiles(dir, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(path.join(dir, entry.name), rel) : [rel];
  });
}

// Git may check text files out with CRLF; compare content, not line endings.
const normalize = (buf) => buf.toString("latin1").replace(/\r\n/g, "\n");

describe("committed XPI", () => {
  it("contains exactly the current extension sources", () => {
    const entries = readZip(fs.readFileSync(xpiPath));
    const sources = listFiles(path.join(root, "extension")).filter((file) => file !== "buildinfo.json");
    const packaged = [...entries.keys()].filter((file) => !["buildinfo.json", "LICENSE"].includes(file));
    assert.deepEqual(packaged.sort(), sources.sort(), "XPI file list differs from extension/");
    for (const file of sources) {
      assert.equal(normalize(entries.get(file)), normalize(fs.readFileSync(path.join(root, "extension", file))),
        `dist XPI is stale: ${file} differs; run node scripts/build-xpi.cjs`);
    }
  });
});

describe("reproducible XPI (Stage 6)", () => {
  const build = require("../scripts/build-xpi.cjs");
  const crypto = require("node:crypto");
  const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
  // In-memory source for the build: { "manifest.json": "...", ... }.
  function memorySource(files, { pkg = { version: "0.9.2-hardened.1" }, license = "MIT\n" } = {}) {
    return {
      label: "memory",
      list: () => Object.keys(files),
      read: (rel) => Buffer.from(files[rel], "latin1"),
      readRoot: (name) => Buffer.from(name === "package.json" ? JSON.stringify(pkg) : license, "latin1"),
    };
  }
  const manifest = JSON.stringify({ version: "0.9.2.1" }, null, 2);

  it("is byte-identical to the committed XPI and its SHA256SUMS", () => {
    const built = build.buildXpi(build.workingTreeSource());
    assert.ok(fs.readFileSync(xpiPath).equals(built.xpi), "dist XPI is not the reproducible build; run node scripts/build-xpi.cjs");
    const sums = fs.readFileSync(path.join(root, "dist", "SHA256SUMS"), "utf8").replace(/\r\n/g, "\n");
    assert.equal(sums, `${built.sha256}  thunderbird-mcp.xpi\n`);
  });

  it("does not depend on line endings, file order or time", () => {
    const lf = build.buildXpi(memorySource({ "manifest.json": manifest, "a.js": "x\ny\n", "icons/i.png": "\x89PNG\r\n" }));
    const crlf = build.buildXpi(memorySource({ "icons/i.png": "\x89PNG\r\n", "a.js": "x\r\ny\r\n", "manifest.json": manifest.replace(/\n/g, "\r\n") }));
    assert.equal(lf.sha256, crlf.sha256);
    assert.equal(sha(lf.xpi), lf.sha256);
    const entries = readZip(lf.xpi);
    assert.equal(entries.get("icons/i.png").toString("latin1"), "\x89PNG\r\n", "binary files are not normalized");
    const info = JSON.parse(entries.get("buildinfo.json").toString("utf8"));
    assert.deepEqual(Object.keys(info).sort(), ["sourceDigest", "version"], "no build time or machine data");
    assert.deepEqual([...entries.keys()], [...entries.keys()].sort(), "sorted entries");
  });

  it("changes the digest and hash with any source change", () => {
    const a = build.buildXpi(memorySource({ "manifest.json": manifest, "a.js": "x\n" }));
    const b = build.buildXpi(memorySource({ "manifest.json": manifest, "a.js": "y\n" }));
    assert.notEqual(a.sourceDigest, b.sourceDigest);
    assert.notEqual(a.sha256, b.sha256);
  });

  it("refuses a manifest version that does not match package.json", () => {
    assert.throws(() => build.buildXpi(memorySource({ "manifest.json": JSON.stringify({ version: "0.9.2.2" }) })), /does not match package\.json/);
    assert.equal(build.expectedManifestVersion("0.9.2-hardened.7"), "0.9.2.7");
  });

  it("ignores a stale generated buildinfo.json in the sources", () => {
    const clean = build.buildXpi(memorySource({ "manifest.json": manifest }));
    const stale = build.buildXpi(memorySource({ "manifest.json": manifest, "buildinfo.json": "{\"builtAt\":\"2020\"}" }));
    assert.equal(clean.sha256, stale.sha256);
  });
});