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
