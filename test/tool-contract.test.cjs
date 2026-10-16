"use strict";

// Contract parity against upstream v0.9.2 (test/baseline/tools-v0.9.2.json).
// Tool names, groups, CRUD classes and input schemas must stay compatible:
// a schema may not narrow what valid upstream requests could send. Deliberate
// changes are listed, with a reason, in test/baseline/contract-changes.json
// and documented in docs/hardening/migration.md. Descriptions may change.

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

const LOWER_BOUNDS = ["minLength", "minItems", "minimum", "exclusiveMinimum", "minProperties"];
const UPPER_BOUNDS = ["maxLength", "maxItems", "maximum", "exclusiveMaximum", "maxProperties"];

// Throws when `now` accepts less than `base`. `allowed` holds dotted paths
// (tool.prop.sub) documented in contract-changes.json; it permits a listed
// property to be added, removed, or to become required.
function assertCompatible(base, now, where, allowed = {}) {
  assert.ok(now, `${where} was removed`);
  assert.deepEqual(now.type, base.type, `${where}: type changed`);
  if (base.enum) {
    for (const value of base.enum) assert.ok(now.enum?.includes(value), `${where}: enum value ${value} removed`);
  } else {
    assert.equal(now.enum, undefined, `${where}: enum added`);
  }
  assert.deepEqual(now.const, base.const, `${where}: const changed`);
  assert.equal(now.pattern, base.pattern, `${where}: pattern changed`);
  assert.equal(now.format, base.format, `${where}: format changed`);
  for (const key of LOWER_BOUNDS) {
    if (now[key] === undefined) continue;
    assert.ok(base[key] !== undefined && now[key] <= base[key], `${where}: ${key} narrowed (${base[key]} -> ${now[key]})`);
  }
  for (const key of UPPER_BOUNDS) {
    if (now[key] === undefined) continue;
    assert.ok(base[key] !== undefined && now[key] >= base[key], `${where}: ${key} narrowed (${base[key]} -> ${now[key]})`);
  }
  if (base.additionalProperties !== false) {
    assert.notEqual(now.additionalProperties, false, `${where}: additionalProperties became false`);
  }
  if (base.additionalProperties && typeof base.additionalProperties === "object") {
    assertCompatible(base.additionalProperties, now.additionalProperties, `${where}{*}`, allowed);
  }
  const baseRequired = new Set(base.required || []);
  for (const prop of now.required || []) {
    assert.ok(baseRequired.has(prop) || allowed.required?.[`${where}.${prop}`], `${where}.${prop} became required`);
  }
  if (base.items) assertCompatible(base.items, now.items, `${where}[]`, allowed);
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    if (!base[key] && !now[key]) continue;
    assert.equal(now[key]?.length, base[key]?.length, `${where}: ${key} changed`);
    base[key].forEach((branch, i) => assertCompatible(branch, now[key][i], `${where}<${key}${i}>`, allowed));
  }
  const baseProps = base.properties || {};
  for (const [prop, schema] of Object.entries(baseProps)) {
    if (allowed.removed?.[`${where}.${prop}`]) continue;
    assertCompatible(schema, now.properties?.[prop], `${where}.${prop}`, allowed);
  }
  for (const prop of Object.keys(now.properties || {})) {
    if (!Object.hasOwn(baseProps, prop)) {
      assert.ok(allowed.added?.[`${where}.${prop}`], `${where}.${prop}: undocumented new property`);
    }
  }
}

const allowedChanges = {
  added: changes.addedProperties,
  removed: changes.removedProperties,
  required: changes.changedRequired,
};

describe("tool contract parity with upstream v0.9.2", () => {
  it("keeps exactly the 40 baseline tools", () => {
    assert.deepEqual(baseline.tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
    assert.deepEqual(current.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
  });

  const now = Object.fromEntries(current.map((tool) => [tool.name, tool]));
  for (const base of baseline.tools) {
    it(`${base.name}: group, CRUD class and input schema stay compatible`, () => {
      const tool = now[base.name];
      assert.equal(tool.group, base.group);
      assert.equal(tool.crud, base.crud);
      assertCompatible(base.inputSchema, tool.inputSchema, base.name, allowedChanges);
    });
  }

  it("documents every allowed change with a reason", () => {
    for (const section of ["addedProperties", "removedProperties", "changedRequired"]) {
      for (const [where, reason] of Object.entries(changes[section])) {
        assert.ok(EXPECTED_TOOLS.includes(where.split(".")[0]), `${section}: unknown tool in ${where}`);
        assert.ok(typeof reason === "string" && reason.length > 20, `${section}.${where} needs a reason`);
      }
    }
  });
});

// The comparison itself must reject narrowing changes (mutation tests).
describe("contract comparison rejects narrowing changes", () => {
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const tool = (name) => clone(baseline.tools.find((t) => t.name === name).inputSchema);
  const mutations = [
    ["nested required grows", "createEvent", (s) => { const a = s.properties.attendees.items; a.required = [...(a.required || []), "name"]; }],
    ["address field becomes required", "createContact", (s) => { s.properties.addresses.items.required = [...(s.properties.addresses.items.required || []), "street"]; }],
    ["minLength rises", "createFilter", (s) => { s.properties.name.minLength = (s.properties.name.minLength || 0) + 100; }],
    ["nested minLength rises", "createEvent", (s) => { const e = s.properties.attendees.items.properties.email; e.minLength = (e.minLength || 0) + 100; }],
    ["maxItems added", "getMessages", (s) => { s.properties.messages.maxItems = 1; }],
    ["filter items all required", "createFilter", (s) => { s.properties.conditions.items.required = Object.keys(s.properties.conditions.items.properties); }],
    ["union branch type changes", "sendMail", (s) => {
      const items = s.properties.attachments.items;
      const branches = items.oneOf || items.anyOf;
      const obj = branches.find((b) => b.type === "object" && b.properties?.base64);
      obj.properties.base64.type = "number";
    }],
    ["additionalProperties becomes false", "updateMessage", (s) => { s.additionalProperties = false; }],
    ["pattern added", "searchMessages", (s) => { s.properties.query.pattern = "^x$"; }],
    ["enum value removed", "getMessage", (s) => { s.properties.bodyFormat.enum = ["markdown"]; }],
    ["new top-level property", "listAccounts", (s) => { s.properties = { ...(s.properties || {}), extra: { type: "string" } }; }],
  ];
  for (const [label, name, mutate] of mutations) {
    it(`rejects: ${label}`, () => {
      const base = tool(name);
      const mutated = tool(name);
      mutate(mutated);
      assert.throws(() => assertCompatible(base, mutated, name, {}), assert.AssertionError);
    });
  }

  it("accepts the unchanged baseline", () => {
    for (const t of baseline.tools) assertCompatible(t.inputSchema, clone(t.inputSchema), t.name, {});
  });
});
