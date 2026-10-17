"use strict";

// The real core modules, in the registry shape api.js builds (`Core`).
// Snippet sandboxes receive this object; it is filled before any test of the
// requiring file runs, so production code always calls the shipped modules.

const { before } = require("node:test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const CORE_DIR = path.resolve(__dirname, "../../extension/mcp_server/core");
const MODULES = {
  attachmentSource: "attachment-source",
  replyTemplate: "reply-template",
  calendarKind: "calendar-kind",
  policy: "policy",
  clientRegistry: "client-registry",
  filterRegistry: "filter-registry",
};

const Core = {};
const coreReady = (async () => {
  for (const [key, file] of Object.entries(MODULES)) {
    Core[key] = await import(pathToFileURL(path.join(CORE_DIR, `${file}.sys.mjs`)).href);
  }
  Object.freeze(Core);
  return Core;
})();

before(() => coreReady);

module.exports = { Core, coreReady, CORE_MODULES: MODULES };
