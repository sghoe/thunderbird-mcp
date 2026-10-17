#!/usr/bin/env node
/**
 * Reproducible build of the Thunderbird MCP extension XPI (no external deps).
 *
 * The XPI bytes depend only on the source contents:
 * - text files are packed with LF line endings (as stored in git), so a
 *   Windows checkout (CRLF) and a Linux checkout give the same package;
 * - entries are sorted, all timestamps fixed (1980-01-01), no extra fields;
 * - entries are stored uncompressed: deflate output is not guaranteed to be
 *   identical across zlib versions/CPUs;
 * - buildinfo.json holds the package version and a SHA-256 digest of the
 *   sources, no time or machine data.
 *
 * Usage:
 *   node scripts/build-xpi.cjs              build from the working tree into dist/
 *   node scripts/build-xpi.cjs --verify     rebuild in memory, compare with dist/
 *   node scripts/build-xpi.cjs --from REV   rebuild from commit REV and compare
 *                                           with the XPI and SHA256SUMS of REV
 *   ... --check FILE                        also compare FILE (e.g. a downloaded
 *                                           XPI) with the rebuild
 *
 * In a git checkout the working-tree build packs exactly the tracked files
 * under extension/ (as a build from the commit would) and refuses untracked
 * ones; outside git, editor/OS debris is skipped.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const PROJECT_DIR = path.resolve(__dirname, "..");
const DIST_DIR = path.join(PROJECT_DIR, "dist");
const XPI_NAME = "thunderbird-mcp.xpi";
const OUT_FILE = path.join(DIST_DIR, XPI_NAME);
const SUMS_FILE = path.join(DIST_DIR, "SHA256SUMS");
const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".json", ".html", ".css", ".md", ".txt", ".svg", ""]);
// Generated into the package; a stale copy in extension/ is ignored.
const GENERATED = new Set(["buildinfo.json"]);

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function normalizeText(name, data) {
  if (!TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())) return data;
  return Buffer.from(data.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
}

// files: [{ name, data }] -> ZIP buffer (stored entries, sorted, fixed time).
function zipStored(files) {
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  const sorted = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of sorted) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    const entry = Buffer.alloc(46 + nameBuf.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(10, 4); // made by (MS-DOS, 1.0)
    entry.writeUInt16LE(10, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    nameBuf.copy(entry, 46);
    parts.push(local, data);
    central.push(entry);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((sum, e) => sum + e.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

// Editor and OS files never belong in the package (used without git).
const DEBRIS = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\.git[^/]*)$|\.(swp|swo|orig|rej)$|~$/i;

// Tracked files under extension/ (relative), or null outside a git checkout.
function trackedExtensionFiles(extDir) {
  const git = (args) => execFileSync("git", args, { cwd: PROJECT_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let tracked;
  try {
    const top = git(["rev-parse", "--show-toplevel"]).trim();
    const here = PROJECT_DIR.replace(/\\/g, "/");
    if (process.platform === "win32" ? top.toLowerCase() !== here.toLowerCase() : top !== here) return null;
    tracked = git(["ls-files", "-z", "--", "extension"]);
  } catch {
    return null;
  }
  const untracked = git(["ls-files", "-o", "--exclude-standard", "-z", "--", "extension"]).split("\0").filter(Boolean);
  if (untracked.length) {
    throw new Error(`untracked files under extension/ would not be packaged: ${untracked.join(", ")} (add them to git or remove them)`);
  }
  return tracked.split("\0").filter(Boolean)
    .map((file) => file.slice("extension/".length))
    .filter((rel) => fs.existsSync(path.join(extDir, ...rel.split("/"))));
}

// Source readers: { list(): [relative paths under extension/], read(rel), readRoot(name) }
function workingTreeSource() {
  const extDir = path.join(PROJECT_DIR, "extension");
  const walk = (dir, prefix) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (DEBRIS.test(rel)) return [];
    return entry.isDirectory() ? walk(path.join(dir, entry.name), rel) : [rel];
  });
  return {
    label: "working tree",
    list: () => trackedExtensionFiles(extDir) ?? walk(extDir, ""),
    read: (rel) => fs.readFileSync(path.join(extDir, ...rel.split("/"))),
    readRoot: (name) => fs.readFileSync(path.join(PROJECT_DIR, name)),
  };
}

function gitSource(rev) {
  const git = (args, options = {}) => execFileSync("git", args, { cwd: PROJECT_DIR, maxBuffer: 64 * 1024 * 1024, ...options });
  const commit = git(["rev-parse", "--verify", `${rev}^{commit}`], { encoding: "utf8" }).trim();
  return {
    label: `commit ${commit}`,
    commit,
    list: () => git(["ls-tree", "-r", "--name-only", "-z", commit, "extension/"], { encoding: "utf8" })
      .split("\0").filter(Boolean).map((file) => file.slice("extension/".length)),
    read: (rel) => git(["cat-file", "blob", `${commit}:extension/${rel}`]),
    readRoot: (name) => git(["cat-file", "blob", `${commit}:${name}`]),
  };
}

function expectedManifestVersion(packageVersion) {
  // Fork versions are "X.Y.Z-hardened.N"; Gecko needs numeric "X.Y.Z.N".
  const fork = /^(\d+\.\d+\.\d+)-hardened\.(\d+)$/.exec(packageVersion);
  return fork ? `${fork[1]}.${fork[2]}` : packageVersion;
}

// Returns { xpi, sha256, sourceDigest, version, files }.
function buildXpi(source) {
  const pkg = JSON.parse(source.readRoot("package.json").toString("utf8"));
  if (typeof pkg.version !== "string" || !pkg.version) throw new Error('package.json has no string "version"');
  const files = source.list()
    .filter((rel) => !GENERATED.has(rel))
    .map((rel) => ({ name: rel, data: normalizeText(rel, source.read(rel)) }));
  files.push({ name: "LICENSE", data: normalizeText("LICENSE", source.readRoot("LICENSE")) });

  const manifest = JSON.parse(files.find((file) => file.name === "manifest.json").data.toString("utf8"));
  const manifestVersion = expectedManifestVersion(pkg.version);
  if (manifest.version !== manifestVersion) {
    throw new Error(`extension/manifest.json version ${manifest.version} does not match package.json ${pkg.version} (expected ${manifestVersion})`);
  }

  const digestInput = [...files]
    .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))
    .map((file) => `${file.name}\0${sha256(file.data)}\n`).join("");
  const sourceDigest = sha256(digestInput);
  files.push({
    name: "buildinfo.json",
    data: Buffer.from(`${JSON.stringify({ version: pkg.version, sourceDigest })}\n`, "utf8"),
  });
  const xpi = zipStored(files);
  return { xpi, sha256: sha256(xpi), sourceDigest, version: pkg.version, files: files.map((file) => file.name).sort() };
}

const sumsText = (hash) => `${hash}  ${XPI_NAME}\n`;

function checkFile(argv, built) {
  const index = argv.indexOf("--check");
  if (index < 0) return true;
  const file = argv[index + 1];
  if (!file) throw new Error("--check needs a file");
  const hash = sha256(fs.readFileSync(file));
  const ok = hash === built.sha256;
  console.log(`${ok ? "OK" : "MISMATCH"}: ${file} ${hash}`);
  return ok;
}

function main(argv) {
  const fromIndex = argv.indexOf("--from");
  if (fromIndex >= 0) {
    const source = gitSource(argv[fromIndex + 1] || "HEAD");
    const built = buildXpi(source);
    const committed = execFileSync("git", ["cat-file", "blob", `${source.commit}:dist/${XPI_NAME}`], { cwd: PROJECT_DIR, maxBuffer: 64 * 1024 * 1024 });
    let sums = null;
    try {
      sums = execFileSync("git", ["cat-file", "blob", `${source.commit}:dist/SHA256SUMS`], { cwd: PROJECT_DIR, encoding: "utf8" });
    } catch { /* not present in that commit */ }
    console.log(`${source.label}: version ${built.version}, sources ${built.sourceDigest}`);
    console.log(`rebuilt   ${built.sha256}`);
    console.log(`committed ${sha256(committed)}`);
    const ok = committed.equals(built.xpi) && (!sums || sums.replace(/\r\n/g, "\n") === sumsText(built.sha256));
    console.log(ok ? "OK: the committed XPI is reproducible from this commit" : "MISMATCH");
    const fileOk = checkFile(argv, built);
    return ok && fileOk ? 0 : 1;
  }

  const built = buildXpi(workingTreeSource());
  if (argv.includes("--check")) return checkFile(argv, built) ? 0 : 1;
  if (argv.includes("--verify")) {
    const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE) : Buffer.alloc(0);
    const sums = fs.existsSync(SUMS_FILE) ? fs.readFileSync(SUMS_FILE, "utf8").replace(/\r\n/g, "\n") : "";
    const ok = current.equals(built.xpi) && sums === sumsText(built.sha256);
    console.log(ok ? `OK: dist/${XPI_NAME} ${built.sha256}` : `MISMATCH: run node scripts/build-xpi.cjs (expected ${built.sha256})`);
    return ok ? 0 : 1;
  }
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, built.xpi);
  fs.writeFileSync(SUMS_FILE, sumsText(built.sha256));
  console.log(`Built: ${OUT_FILE} (${(built.xpi.length / 1024).toFixed(0)} KB)`);
  console.log(`SHA-256 ${built.sha256}  version ${built.version}  sources ${built.sourceDigest}`);
  return 0;
}

module.exports = { buildXpi, workingTreeSource, gitSource, zipStored, normalizeText, expectedManifestVersion, DEBRIS };

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exitCode = 1;
  }
}
