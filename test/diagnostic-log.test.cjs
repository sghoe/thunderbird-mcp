"use strict";

// Optional diagnostic log: entries carry only constants and numbers – a known
// tool name, an opaque client ID, outcome, operation state and, for failures,
// a fixed error category. Error texts, content, names, addresses, paths,
// URIs and tokens are never written.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { Core } = require("./helpers/core-modules.cjs");
const { expectedModule, extractCategories } = require("../scripts/diagnostic-categories.cjs");

const D = () => Core.diagnosticLog;
const TOOLS = new Set(["sendMail", "getMessage"]);

describe("diagnostic log entries", () => {
  it("keeps the error categories in sync with api.js", () => {
    const { current, expected } = expectedModule();
    assert.equal(current, expected, "run node scripts/diagnostic-categories.cjs --write");
    assert.ok(D().ERROR_CATEGORIES.length > 100);
    for (const category of D().ERROR_CATEGORIES) assert.match(category, /^[A-Za-z][A-Za-z0-9 ,./-]*$/);
  });

  it("takes categories only from static text before any interpolation, quote or colon", () => {
    const source = [
      "throw new Error(`Calendar is read-only: ${calendar.name}`);",
      "throw new Error(`identity ${from} belongs to a restricted account`);",
      "return { error: `Folder \"${name}\" already exists` };",
      "throw new Error(\"Message not found\");",
      "throw new Error(`Item ${id} is not a task`);",
    ].join("\n");
    assert.deepEqual(extractCategories(source), ["Calendar is read-only", "Folder", "Message not found", "identity"]);
  });

  it("logs real tool errors only as their category", () => {
    const cases = [
      ["Calendar is read-only: Confidential Acquisition Plan", "Calendar is read-only"],
      ["Attachments refused: C:\\Users\\Alice Smith\\Documents\\Gehalt 2026.pdf", "Attachments refused"],
      ["Error: Attachments refused: Kuendigung Mueller.pdf (invalid base64 data)", "Attachments refused"],
      ["Attachments refused: data:text/plain;base64,c2VjcmV0", "Attachments refused"],
      ["Folder not found: INBOX/Acme Merger", "Folder not found"],
      ["Message not found: <abc.123@corp.test>", "Message not found"],
      ["Custom filter actions are unsupported (filter: Boss \"urgent\" mails)", "Custom filter actions are unsupported"],
      ["Transport security error: smtp.corp.test:465", "Transport security error"],
      ["identity Alice Smith belongs to a restricted account", "identity"],
      ["Invalid parameters for 'sendMail': Missing required parameter: to", "Invalid parameters for"],
      ["Alice Smith is unknown", "<unclassified>"],
      ["Folderx secret", "<unclassified>"],
      ["Component returned failure code: 0x80520012 (NS_ERROR_FILE_NOT_FOUND) [nsIFile.append]", "<unclassified>"],
    ];
    for (const [input, expected] of cases) assert.equal(D().categorize(input), expected, input);
  });

  it("examines only a bounded prefix, in linear time", () => {
    for (const input of ["a".repeat(128000), "a@".repeat(64000), "Error: ".repeat(20000), `${"x".repeat(600)}Folder not found`]) {
      const started = process.hrtime.bigint();
      assert.equal(D().categorize(input), "<unclassified>");
      assert.ok(process.hrtime.bigint() - started < 50_000_000n, "under 50 ms");
    }
  });

  it("writes only known values", () => {
    const line = D().formatEntry(Date.UTC(2026, 9, 17, 7, 0, 0), {
      event: "tool", tool: "sendMail", client: "0123abcd", outcome: "error", operationState: "unknown",
      ms: 120.4, missing: ["compose.send", "bad value!", "alice@corp.test"], error: "Send failed for bob@corp.test",
      body: "secret body", token: "a".repeat(64),
    }, { toolNames: TOOLS });
    const entry = JSON.parse(line);
    assert.deepEqual(entry, {
      t: "2026-10-17T07:00:00.000Z", event: "tool", tool: "sendMail", client: "0123abcd", outcome: "error",
      operationState: "unknown", ms: 120, missing: ["compose.send"], error: "Send failed",
    });
    assert.doesNotMatch(line, /secret body|aaaaaaaa|bob|alice/);
    const odd = JSON.parse(D().formatEntry(0, {
      event: "error", tool: "f".repeat(64), client: "Alice <alice@corp.test>", outcome: "C:\\x", operationState: "x y",
      detail: "secret-method", code: "C:\\private\\file",
    }, { toolNames: TOOLS }));
    assert.deepEqual(odd, { t: odd.t, event: "error", tool: "<unknown>", client: "<invalid>", outcome: "<invalid>", operationState: "<invalid>", detail: "<invalid>" });
    assert.equal(JSON.parse(D().formatEntry(0, { event: "tool", tool: "sendMail" })).tool, "<unknown>", "no tool list, no tool name");
    assert.throws(() => D().formatEntry(0, { event: "anything" }), /Unknown diagnostic event/);
  });

  it("records the error class and XPCOM result name of error objects", () => {
    const type = JSON.parse(D().formatEntry(0, { event: "error", error: new TypeError("can't access property \"x\" of Alice") }));
    assert.deepEqual([type.error, type.errorClass], ["<unclassified>", "TypeError"]);
    const xpcom = JSON.parse(D().formatEntry(0, { event: "error", error: { name: "NS_ERROR_FILE_NOT_FOUND", message: "Component returned failure code" }, code: "NS_ERROR_FILE_NOT_FOUND" }));
    assert.deepEqual([xpcom.error, xpcom.errorClass, xpcom.code], ["<unclassified>", undefined, "NS_ERROR_FILE_NOT_FOUND"]);
    const named = JSON.parse(D().formatEntry(0, { event: "error", error: Object.assign(new Error("Folder not found: X"), { name: "Alice Smith" }) }));
    assert.deepEqual([named.error, named.errorClass], ["Folder not found", undefined]);
  });

  it("summarizes tool results without their content", () => {
    assert.deepEqual({ ...D().summarizeToolResult([{ subject: "x" }]) }, { outcome: "ok" });
    assert.deepEqual({ ...D().summarizeToolResult({ success: true, operationState: "completed", body: "x" }) }, { outcome: "ok", operationState: "completed" });
    assert.deepEqual({ ...D().summarizeToolResult({ error: "Send failed", operationState: "failed" }) }, { outcome: "error", error: "Send failed", operationState: "failed" });
  });

  it("throws for an error value whose conversion fails (the adapter catches it)", () => {
    const evil = { toString() { throw new Error("boom"); } };
    assert.throws(() => D().formatEntry(0, { event: "error", error: evil }), /boom/);
  });
});
