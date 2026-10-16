"use strict";

// Since Stage 4 every tool call runs as a paired client (runAsClient), and
// handlers fail closed without one. Snippet tests use this client: every
// capability, every account, calendars and address books, unless a test
// overrides fields. Global preferences still apply on top.
function makeTestClient(Core, overrides = {}) {
  return {
    id: "0".repeat(32),
    name: "test client",
    profile: "automation",
    capabilities: Object.keys(Core.policy.CAPABILITIES),
    accounts: { includes: () => true },
    calendars: true,
    addressBooks: true,
    ...overrides,
  };
}

module.exports = { makeTestClient };
