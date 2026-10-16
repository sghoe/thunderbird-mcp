"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadConnectionInfoRefreshHelpers() {
  const apiPath = path.resolve(__dirname, "../extension/mcp_server/api.js");
  const source = fs.readFileSync(apiPath, "utf8");
  const startMarker = "// BEGIN CONNECTION INFO REFRESH HELPERS";
  const endMarker = "// END CONNECTION INFO REFRESH HELPERS";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  assert.ok(start >= 0, "connection info refresh helper start marker missing");
  assert.ok(end > start, "connection info refresh helper end marker missing");

  const snippet = source.slice(start, end);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    `${snippet}
this.ensureFreshConnectionInfo = ensureFreshConnectionInfo;`,
    sandbox
  );
  return {
    ensureFreshConnectionInfo: sandbox.ensureFreshConnectionInfo,
  };
}

const { ensureFreshConnectionInfo } = loadConnectionInfoRefreshHelpers();

function makeOptions(overrides) {
  return {
    port: 8765,
    expectedPid: 1234,
    onCheckError() {},
    ...overrides,
  };
}

describe("connection info refresh decision", () => {
  it("does not rewrite when connection.json already matches the running server", () => {
    const result = ensureFreshConnectionInfo(makeOptions({
      readConnectionInfo: () => ({
        path: "/tmp/thunderbird-mcp-hardened/connection.json",
        data: { port: 8765, pid: 1234 },
      }),
      writeConnectionInfo() {
        throw new Error("writeConnectionInfo should not be called");
      },
    }));

    assert.equal(result, "/tmp/thunderbird-mcp-hardened/connection.json");
  });

  it("rewrites when connection.json is missing", () => {
    const writes = [];
    const result = ensureFreshConnectionInfo(makeOptions({
      readConnectionInfo: () => ({
        path: "/tmp/thunderbird-mcp-hardened/connection.json",
        data: null,
      }),
      writeConnectionInfo(...args) {
        writes.push(args);
        return "/tmp/thunderbird-mcp-hardened/connection.json";
      },
    }));

    assert.equal(result, "/tmp/thunderbird-mcp-hardened/connection.json");
    assert.deepEqual(writes, [[8765]]);
  });

  for (const staleCase of [
    {
      name: "port changed",
      data: { port: 8766, pid: 1234 },
    },
    {
      // Files written before Stage 4 contain the old master token; it must
      // not linger on disk.
      name: "pre-Stage-4 token still present",
      data: { port: 8765, token: "old-token", pid: 1234 },
    },
    {
      name: "pid changed",
      data: { port: 8765, pid: 4321 },
    },
  ]) {
    it(`rewrites when connection.json is stale: ${staleCase.name}`, () => {
      let writeCount = 0;
      const result = ensureFreshConnectionInfo(makeOptions({
        readConnectionInfo: () => ({
          path: "/tmp/thunderbird-mcp-hardened/connection.json",
          data: staleCase.data,
        }),
        writeConnectionInfo(...args) {
          writeCount++;
          assert.deepEqual(args, [8765]);
          return "/tmp/thunderbird-mcp-hardened/connection.json";
        },
      }));

      assert.equal(result, "/tmp/thunderbird-mcp-hardened/connection.json");
      assert.equal(writeCount, 1);
    });
  }

  it("rewrites when reading or parsing connection.json fails", () => {
    const errors = [];
    let writeCount = 0;
    const parseError = new SyntaxError("Unexpected token");

    const result = ensureFreshConnectionInfo(makeOptions({
      readConnectionInfo() {
        throw parseError;
      },
      writeConnectionInfo() {
        writeCount++;
        return "/tmp/thunderbird-mcp-hardened/connection.json";
      },
      onCheckError(error) {
        errors.push(error);
      },
    }));

    assert.equal(result, "/tmp/thunderbird-mcp-hardened/connection.json");
    assert.deepEqual(errors, [parseError]);
    assert.equal(writeCount, 1);
  });

  it("propagates write failures", () => {
    const writeError = new Error("disk full");

    assert.throws(
      () => ensureFreshConnectionInfo(makeOptions({
        readConnectionInfo: () => ({
          path: "/tmp/thunderbird-mcp-hardened/connection.json",
          data: null,
        }),
        writeConnectionInfo() {
          throw writeError;
        },
      })),
      (error) => error === writeError
    );
  });
});
