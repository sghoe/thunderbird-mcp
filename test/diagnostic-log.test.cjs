"use strict";

// Optional diagnostic log: entries carry operation, client, outcome and a
// redacted error – never content, addresses, paths, URIs or names.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { Core } = require("./helpers/core-modules.cjs");

const D = () => Core.diagnosticLog;

describe("diagnostic log entries", () => {
  it("redacts addresses, Message-IDs, references, URIs, paths and quoted names", () => {
    const cases = [
      ["Message not found: <abc.123@corp.test>", "Message not found: <addr>"],
      ["Account not accessible: imap://alice@mail.corp.test/INBOX/Projects", "Account not accessible: <uri>"],
      ["Message reference is stale: msgref:5:0123456789abcdef:x@y.test.", "Message reference is stale: <msgref>"],
      ["Attachments refused: C:\\Users\\alice\\Documents\\salary.pdf (sensitive path blocked)", "Attachments refused: <path> (sensitive path blocked)"],
      ["Attachments refused: /home/alice/.ssh/id_rsa (sensitive path blocked)", "Attachments refused: <path> (sensitive path blocked)"],
      ["UNC \\\\server\\share\\secret.txt refused", "UNC <path> refused"],
      ['Event "Board meeting: layoffs" added to calendar "Private"', 'Event "…" added to calendar "…"'],
      ["Send failed (status: 0x80004005)", "Send failed (status: 0x80004005)"],
      ["Invalid parameters for 'sendMail': Missing required parameter: to", "Invalid parameters for 'sendMail': Missing required parameter: to"],
    ];
    for (const [input, expected] of cases) assert.equal(D().redact(input), expected, input);
  });

  it("truncates long error texts", () => {
    const long = D().redact("x".repeat(1000));
    assert.equal(long.length, D().MAX_ERROR_LENGTH + 1);
    assert.ok(long.endsWith("…"));
  });

  it("writes only known fields, with safe names", () => {
    const line = D().formatEntry(Date.UTC(2026, 9, 17, 7, 0, 0), {
      event: "tool", tool: "sendMail", client: "Claude Desktop", outcome: "error", operationState: "unknown",
      ms: 120.4, missing: ["compose.send", "bad value!"], error: "Send failed for bob@corp.test", body: "secret body", token: "a".repeat(64),
    });
    const entry = JSON.parse(line);
    assert.deepEqual(entry, {
      t: "2026-10-17T07:00:00.000Z", event: "tool", tool: "sendMail", client: "Claude Desktop", outcome: "error",
      operationState: "unknown", ms: 120, missing: ["compose.send"], error: "Send failed for <addr>",
    });
    assert.doesNotMatch(line, /secret body|aaaaaaaa/);
    assert.equal(JSON.parse(D().formatEntry(0, { event: "tool", tool: "../../etc" + " x" })).tool, "<invalid>");
    assert.throws(() => D().formatEntry(0, { event: "anything" }), /Unknown diagnostic event/);
  });

  it("summarizes tool results without their content", () => {
    assert.deepEqual({ ...D().summarizeToolResult([{ subject: "x" }]) }, { outcome: "ok" });
    assert.deepEqual({ ...D().summarizeToolResult({ success: true, operationState: "completed", body: "x" }) }, { outcome: "ok", operationState: "completed" });
    assert.deepEqual({ ...D().summarizeToolResult({ error: "Send failed", operationState: "failed" }) }, { outcome: "error", error: "Send failed", operationState: "failed" });
  });

  it("never throws for an error object whose conversion fails", () => {
    const evil = { toString() { throw new Error("boom"); } };
    assert.throws(() => D().formatEntry(0, { event: "error", error: evil }), /boom/, "the adapter catches this inside writeDiagnostic");
  });
});
