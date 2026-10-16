"use strict";

// Stage 4 policy core: positive capabilities derived from tool AND arguments.

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { loadBuildTools } = require("./helpers/tool-contract.cjs");

const root = path.resolve(__dirname, "..");
const tools = loadBuildTools(fs.readFileSync(path.join(root, "extension/mcp_server/api.js"), "utf8"))();
let P;

before(async () => {
  P = await import(pathToFileURL(path.join(root, "extension/mcp_server/core/policy.sys.mjs")).href);
});

const plain = (v) => JSON.parse(JSON.stringify(v));

describe("policy coverage", () => {
  it("classifies exactly the tools the server exposes", () => {
    assert.deepEqual(plain(P.knownTools()).sort(), plain(tools.map((t) => t.name)).sort());
  });

  it("classifies every input property of every tool", () => {
    for (const tool of tools) {
      const schemaProps = plain(Object.keys(tool.inputSchema.properties || {})).sort();
      assert.deepEqual(plain(P.knownArguments(tool.name)).sort(), schemaProps, tool.name);
    }
  });

  it("requires an unobtainable capability for unknown tools and arguments", () => {
    assert.deepEqual(plain(P.requiredCapabilities("newTool", {})), [P.UNCLASSIFIED]);
    assert.ok(P.requiredCapabilities("getMessage", { messageId: "x", folderPath: "f", futureFlag: true }).includes(P.UNCLASSIFIED));
    for (const profile of Object.keys(P.PROFILES)) {
      assert.equal(P.decide("newTool", {}, P.capabilitiesForProfile(profile)).allowed, false, profile);
    }
    assert.equal(P.normalizeCapabilities([P.UNCLASSIFIED, "mail.body", 7, "bogus"]).join(), "mail.body");
  });
});

describe("requirements follow the effective arguments", () => {
  const cases = [
    ["getMessage", {}, ["mail.body", "mail.metadata"]],
    ["getMessage", { bodyFormat: "html" }, ["mail.body", "mail.html", "mail.metadata"]],
    ["getMessage", { rawSource: true }, ["mail.body", "mail.metadata", "mail.raw"]],
    ["getMessage", { saveAttachments: true }, ["attachments.export", "mail.body", "mail.metadata"]],
    ["getMessage", { includeInlineImages: true }, ["attachments.read", "mail.body", "mail.metadata"]],
    ["sendMail", {}, ["compose.review"]],
    ["sendMail", { skipReview: true }, ["compose.send"]],
    ["sendMail", { skipReview: false, attachments: ["C:/doc.pdf"] }, ["compose.review", "files.attach"]],
    ["sendMail", { attachments: [{ name: "a", base64: "eA==" }] }, ["compose.review"]],
    ["replyToMessage", { saveAsDraft: true }, ["compose.draft", "mail.body", "mail.metadata"]],
    ["updateMessage", { read: true }, ["mail.flag", "mail.metadata"]],
    ["updateMessage", { moveTo: "x" }, ["mail.metadata", "mail.move"]],
    ["updateMessage", { trash: true }, ["mail.delete", "mail.metadata"]],
    ["emptyTrash", {}, ["mail.deletePermanent"]],
    ["createFilter", { actions: [{ type: "markRead" }] }, ["filters.manage", "mail.flag"]],
    ["createFilter", { actions: [{ type: "stopExecution" }] }, ["filters.manage"]],
    ["createFilter", { actions: [{ type: "moveToFolder", value: "x" }, { type: "delete" }] }, ["filters.manage", "mail.delete", "mail.move"]],
    ["updateFilter", { actions: [{ type: "deleteFromServer" }] }, ["filters.manage", "mail.deletePermanent"]],
    ["createFilter", { actions: [{ type: "customAction" }] }, ["filters.manage", "unclassified"]],
    ["createFilter", { actions: [{ type: "reply", value: "x" }] }, ["filters.autosend", "filters.manage"]],
    ["createEvent", {}, ["compose.review"]],
    ["createEvent", { skipReview: true, attendees: [{ email: "a@b.c" }] }, ["calendar.schedule", "calendar.write"]],
    ["updateEvent", { attendees: [] }, ["calendar.read", "calendar.schedule", "calendar.write"]],
  ];
  for (const [tool, args, expected] of cases) {
    it(`${tool} ${JSON.stringify(args)}`, () => {
      assert.deepEqual(plain(P.requiredCapabilities(tool, args)), expected);
    });
  }
});

describe("unexpected raw values fail closed", () => {
  const cases = [
    // JSON-encoded arrays (coerceToolArgs would decode them) are unclassified.
    ["sendMail", { attachments: '["C:/secret"]' }, ["compose.review", "unclassified"]],
    ["createFilter", { actions: '[{"type":"forward","value":"x@y.z"}]' }, ["filters.manage", "unclassified"]],
    ["createEvent", { attendees: '[{"email":"a@b.c"}]' }, ["compose.review", "unclassified"]],
    ["sendMail", { attachments: [7] }, ["compose.review", "unclassified"]],
    // Values that are not clearly the harmless variant count as the risky one.
    ["sendMail", { skipReview: "yes" }, ["compose.send"]],
    ["getMessage", { bodyFormat: "HTML" }, ["mail.body", "mail.html", "mail.metadata"]],
    ["getMessage", { rawSource: 1 }, ["mail.body", "mail.metadata", "mail.raw"]],
    ["getMessage", { saveAttachments: "1" }, ["attachments.export", "mail.body", "mail.metadata"]],
    ["updateMessage", { trash: "on" }, ["mail.delete", "mail.metadata"]],
    // The handler turns read/flagged null into false (a mutation).
    ["updateMessage", { read: null }, ["mail.flag", "mail.metadata"]],
    ["updateMessage", { flagged: null }, ["mail.flag", "mail.metadata"]],
    ["updateMessage", { addTags: null, moveTo: null }, ["mail.flag", "mail.metadata", "mail.move"]],
    // Only an explicit true may drop the review requirement.
    ["replyToMessage", { saveAsDraft: "yes" }, ["compose.draft", "compose.review", "mail.body", "mail.metadata"]],
    ["getMessage", { rawSource: false, bodyFormat: "text" }, ["mail.body", "mail.metadata"]],
  ];
  for (const [tool, args, expected] of cases) {
    it(`${tool} ${JSON.stringify(args)}`, () => {
      assert.deepEqual(plain(P.requiredCapabilities(tool, args)), expected);
    });
  }
});

describe("request context", () => {
  it("requires files.attach when the bridge inlined local files", () => {
    const inline = { attachments: [{ name: "id_rsa", base64: "eA==" }] };
    for (const tool of ["sendMail", "saveDraft", "replyToMessage", "forwardMessage"]) {
      assert.ok(!P.requiredCapabilities(tool, inline).includes("files.attach"), tool);
      assert.ok(P.requiredCapabilities(tool, inline, { inlinedLocalFiles: true }).includes("files.attach"), tool);
    }
    const drafts = P.capabilitiesForProfile("drafts");
    assert.equal(P.decide("saveDraft", inline, drafts).allowed, true);
    assert.deepEqual(plain(P.decide("saveDraft", inline, drafts, { inlinedLocalFiles: true }).missing), ["files.attach"]);
    assert.ok(!P.requiredCapabilities("saveDraft", { attachments: [] }, { inlinedLocalFiles: true }).includes("files.attach"));
  });

  it("classifies every filter action api.js knows", () => {
    const source = fs.readFileSync(path.join(root, "extension/mcp_server/api.js"), "utf8");
    const defs = source.slice(source.indexOf("const FILTER_ACTION_DEFS = ["), source.indexOf("const FILTER_ACTIONS = "));
    const names = [...defs.matchAll(/\{ action: "([A-Za-z]+)"/g)].map((m) => m[1]);
    assert.ok(names.length >= 19, names.join());
    for (const name of names) assert.ok(!P.filterActionCapabilities([name]).includes(P.UNCLASSIFIED), name);
  });

  it("maps stored filter actions to the capabilities of their effect", () => {
    assert.deepEqual(plain(P.filterActionCapabilities(["forward", { type: "markRead" }])), ["filters.autosend", "mail.flag"]);
    assert.deepEqual(plain(P.filterActionCapabilities([])), []);
    assert.deepEqual(plain(P.filterActionCapabilities(["unknown"])), [P.UNCLASSIFIED]);
    assert.deepEqual(plain(P.filterActionCapabilities(null)), [P.UNCLASSIFIED]);
  });
});

describe("profiles", () => {
  it("grants nothing by default", () => {
    for (const tool of P.knownTools()) assert.equal(P.isToolVisible(tool, P.capabilitiesForProfile("none")), false, tool);
    assert.deepEqual(plain(P.capabilitiesForProfile("unknown-profile")), []);
  });

  it("read-only can read but never write, send, export or display", () => {
    const caps = P.capabilitiesForProfile("read-only");
    assert.equal(P.decide("getMessage", { messageId: "x", folderPath: "f" }, caps).allowed, true);
    for (const [tool, args] of [
      ["sendMail", {}], ["saveDraft", {}], ["deleteMessages", {}], ["updateMessage", { read: true }],
      ["getMessage", { saveAttachments: true }], ["getMessage", { rawSource: true }], ["displayMessage", {}],
      ["createFilter", {}], ["applyFilters", {}], ["createContact", {}], ["updateTask", {}],
    ]) assert.equal(P.decide(tool, args, caps).allowed, false, `${tool} ${JSON.stringify(args)}`);
  });

  it("drafts adds review windows and drafts, but no unattended send", () => {
    const caps = P.capabilitiesForProfile("drafts");
    assert.equal(P.decide("saveDraft", { to: "a@b.c" }, caps).allowed, true);
    assert.equal(P.decide("sendMail", { to: "a@b.c" }, caps).allowed, true);
    assert.equal(P.decide("sendMail", { to: "a@b.c", skipReview: true }, caps).allowed, false);
    assert.equal(P.decide("forwardMessage", { skipReview: true }, caps).allowed, false);
    assert.equal(P.decide("createFilter", { actions: [{ type: "forward" }] }, caps).allowed, false);
  });

  it("automation holds every capability and still cannot use unclassified input", () => {
    const caps = P.capabilitiesForProfile("automation");
    assert.deepEqual(plain(caps).sort(), Object.keys(P.CAPABILITIES).sort());
    assert.equal(P.decide("sendMail", { skipReview: true }, caps).allowed, true);
    assert.equal(P.decide("sendMail", { skipReview: true, newArg: 1 }, caps).allowed, false);
  });

  it("lists tools whose legitimate variants are allowed", () => {
    const sendOnly = ["compose.send"];
    assert.equal(P.isToolVisible("sendMail", sendOnly), true);
    assert.equal(P.isToolVisible("sendMail", []), false);
    assert.equal(P.isToolVisible("updateMessage", []), false);
  });
});
