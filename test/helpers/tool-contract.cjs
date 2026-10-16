"use strict";

// Loads production buildTools() from an api.js source text in a vm sandbox,
// using the same marker-delimited snippets as the existing schema tests.

const vm = require("node:vm");

function markedSnippet(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end <= start) throw new Error(`api.js marker missing: ${startMarker}`);
  return source.slice(start, end);
}

function loadBuildTools(source, { getMessagesLimit = 10 } = {}) {
  const sandbox = {
    getConfiguredGetMessagesLimit: () => getMessagesLimit,
    _tempAttachFiles: new Set(),
    _tempFileCounter: 0,
    Cc: { "@mozilla.org/messengercompose/attachment;1": { createInstance: () => ({}) } },
    Ci: {},
  };
  vm.createContext(sandbox);
  vm.runInContext([
    markedSnippet(source, "// BEGIN OUTBOUND ATTACHMENT LIMITS", "// END OUTBOUND ATTACHMENT LIMITS"),
    markedSnippet(source, "// BEGIN CONTACT FIELD CONSTANTS", "// END CONTACT FIELD CONSTANTS"),
    markedSnippet(source, "// BEGIN FILTER SEARCH TERM HELPERS", "// END FILTER SEARCH TERM HELPERS"),
    markedSnippet(source, "// BEGIN TOOL SCHEMA BUILDER", "// END TOOL SCHEMA BUILDER"),
    "this.buildTools = buildTools;",
  ].join("\n"), sandbox);
  return sandbox.buildTools;
}

// Stable, JSON-serialisable contract view of every tool.
function contractView(tools) {
  return JSON.parse(JSON.stringify(tools.map(({ name, group, crud, title, description, inputSchema }) => ({
    name, group, crud, title, description, inputSchema,
  })).sort((a, b) => a.name.localeCompare(b.name))));
}

module.exports = { loadBuildTools, contractView };
