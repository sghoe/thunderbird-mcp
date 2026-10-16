"use strict";

// Native functional baseline: runs the parity scenarios against
//   --upstream   the extension of upstream v0.9.2 (commit 1ab1018, from git)
//   (default)    the working tree
// and writes a JSON report. compare: node run-parity.cjs --compare a.json b.json
// Usage: THUNDERBIRD_BIN=... node test/native/run-parity.cjs [--upstream] [--out file]

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const h = require("./harness.cjs");
const { mailboxes, runScenarios } = require("./parity-scenarios.cjs");

const UPSTREAM_COMMIT = "1ab10183a7ce914f3964d6c98fcc6265f3dc01d3";

function extractUpstreamExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbmcp-upstream-ext-"));
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", UPSTREAM_COMMIT, "extension"], { cwd: h.REPO_ROOT, encoding: "utf8" })
    .split("\n").filter(Boolean);
  for (const file of files) {
    const target = path.join(dir, path.relative("extension", file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, execFileSync("git", ["show", `${UPSTREAM_COMMIT}:${file}`], { cwd: h.REPO_ROOT, maxBuffer: 64 * 1024 * 1024 }));
  }
  return dir;
}

function compare(aFile, bFile) {
  const a = JSON.parse(fs.readFileSync(aFile, "utf8"));
  const b = JSON.parse(fs.readFileSync(bFile, "utf8"));
  const bByLabel = new Map(b.results.map((r) => [r.label, r]));
  const diffs = [];
  for (const ra of a.results) {
    const rb = bByLabel.get(ra.label);
    if (!rb) { diffs.push({ label: ra.label, issue: "missing" }); continue; }
    if (ra.ok !== rb.ok) diffs.push({ label: ra.label, issue: "outcome", a: ra.ok ? "ok" : ra.error, b: rb.ok ? "ok" : rb.error });
    else if (JSON.stringify(ra.shape) !== JSON.stringify(rb.shape)) diffs.push({ label: ra.label, issue: "shape", a: ra.shape, b: rb.shape });
  }
  for (const rb of b.results) if (!a.results.some((ra) => ra.label === rb.label)) diffs.push({ label: rb.label, issue: "added" });
  if (a.smtpMessages !== b.smtpMessages) diffs.push({ label: "SMTP deliveries", issue: "count", a: a.smtpMessages, b: b.smtpMessages });
  return { a: a.target, b: b.target, toolsA: a.tools.length, toolsB: b.tools.length, smtp: [a.smtpMessages, b.smtpMessages], diffs };
}

(async () => {
  const args = process.argv.slice(2);
  if (args[0] === "--compare") {
    const result = compare(args[1], args[2]);
    console.log(JSON.stringify(result, null, 2));
    if (result.diffs.length) process.exitCode = 1;
    return;
  }
  const upstream = args.includes("--upstream");
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args[outIndex + 1] : null;
  const extensionDir = upstream ? extractUpstreamExtension() : h.EXTENSION_DIR;
  const tb = await h.startThunderbird({ extensionDir, mailboxes: mailboxes() });
  let report;
  try {
    report = await runScenarios(tb);
  } finally {
    await tb.stop();
    if (upstream) fs.rmSync(extensionDir, { recursive: true, force: true });
  }
  report.target = upstream ? `upstream ${UPSTREAM_COMMIT}` : "working tree";
  report.thunderbird = execFileSync(process.env.THUNDERBIRD_BIN, ["--version"], { encoding: "utf8" }).trim();
  const text = JSON.stringify(report, null, 2);
  if (out) fs.writeFileSync(out, `${text}\n`);
  const failed = report.results.filter((r) => !r.ok);
  console.log(`${report.target}: ${report.results.length} calls, ${report.tools.length} tools, ${failed.length} failed, ${report.smtpMessages} SMTP messages`);
  for (const r of failed) console.log(`  FAIL ${r.label}: ${r.error}`);
  if (failed.length) process.exitCode = 1;
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
