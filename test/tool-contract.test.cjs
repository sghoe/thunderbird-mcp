"use strict";

// Contract parity against upstream v0.9.2 (test/baseline/tools-v0.9.2.json).
// Tool names, groups, input properties, their types/enums and required lists
// must stay compatible. Deliberate changes are listed, with a reason, in
// test/baseline/contract-changes.json and documented as a migration.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadBuildTools, contractView } = require("./helpers/tool-contract.cjs");

const root = path.resolve(__dirname, "..");
const baseline = JSON.parse(fs.readFileSync(path.join(root, "test/baseline/tools-v0.9.2.json"), "utf8"));
const changes = JSON.parse(fs.readFileSync(path.join(root, "test/baseline/contract-changes.json"), "utf8"));
const current = contractView(loadBuildTools(fs.readFileSync(path.join(root, "extension/mcp_server/api.js"), "utf8"))());

const EXPECTED_TOOLS = [
  "listAccounts", "listFolders", "getAccountAccess",
  "searchMessages", "getMessage", "getMessages", "getRecentMessages", "displayMessage", "updateMessage", "deleteMessages",
  "createFolder", "renameFolder", "deleteFolder", "moveFolder", "emptyTrash", "emptyJunk",
  "sendMail", "saveDraft", "replyToMessage", "forwardMessage",
  "listFilters", "createFilter", "updateFilter", "deleteFilter", "reorderFilters", "applyFilters",
  "searchContacts", "getContact", "createContact", "updateContact", "deleteContact",
  "listCalendars", "listEvents", "createEvent", "updateEvent", "deleteEvent", "listCategories", "createTask", "listTasks", "updateTask",
];

function byName(list) {
  return Object.fromEntries(list.map((tool) => [tool.name, tool]));
}

// Compares a baseline schema node with the current one. Descriptions may
// change; structure may only widen in documented places.
function assertCompatible(base, now, where) {
  assert.ok(now, `${where} was removed`);
  assert.deepEqual(now.type, base.type, `${where}: type changed`);
  if (base.enum) {
    for (const value of base.enum) assert.ok(now.enum?.includes(value), `${where}: enum value ${value} removed`);
  }
  if (base.items) assertCompatible(base.items, now.items, `${where}[]`);
  for (const key of ["oneOf", "anyOf"]) {
    if (base[key]) assert.equal(now[key]?.length, base[key].length, `${where}: ${key} changed`);
  }
  for (const [prop, schema] of Object.entries(base.properties || {})) {
    assertCompatible(schema, now.properties?.[prop], `${where}.${prop}`);
  }
  for (const [limit, value] of [["minItems", base.minItems], ["maxItems", base.maxItems], ["minimum", base.minimum], ["maximum", base.maximum]]) {
    if (value === undefined) continue;
    assert.equal(now[limit], value, `${where}: ${limit} changed`);
  }
}

describe("tool contract parity with upstream v0.9.2", () => {
  it("keeps exactly the 40 baseline tools", () => {
    assert.deepEqual(baseline.tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
    assert.deepEqual(current.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
  });

  const now = byName(current);
  for (const base of baseline.tools) {
    it(`${base.name}: group, CRUD class and input schema stay compatible`, () => {
      const tool = now[base.name];
      assert.equal(tool.group, base.group);
      assert.equal(tool.crud, base.crud);
      assert.equal(tool.inputSchema.type, "object");

      const removed = changes.removedProperties[base.name] || {};
      for (const [prop, schema] of Object.entries(base.inputSchema.properties || {})) {
        if (removed[prop]) continue;
        assertCompatible(schema, tool.inputSchema.properties[prop], `${base.name}.${prop}`);
      }

      const added = Object.keys(tool.inputSchema.properties || {})
        .filter((prop) => !Object.hasOwn(base.inputSchema.properties || {}, prop));
      const allowed = Object.keys(changes.addedProperties[base.name] || {});
      assert.deepEqual(added.sort(), allowed.sort(), `${base.name}: undocumented new input properties`);

      const baseRequired = new Set(base.inputSchema.required || []);
      const nowRequired = new Set(tool.inputSchema.required || []);
      const requiredChange = changes.changedRequired[base.name] || {};
      for (const prop of nowRequired) {
        assert.ok(baseRequired.has(prop) || requiredChange[prop], `${base.name}: ${prop} became required`);
      }
    });
  }

  it("documents every allowed change with a reason", () => {
    for (const section of ["addedProperties", "removedProperties", "changedRequired"]) {
      for (const [tool, props] of Object.entries(changes[section])) {
        assert.ok(EXPECTED_TOOLS.includes(tool), `${section}: unknown tool ${tool}`);
        for (const [prop, reason] of Object.entries(props)) {
          assert.ok(typeof reason === "string" && reason.length > 20, `${section}.${tool}.${prop} needs a reason`);
        }
      }
    }
  });
});
