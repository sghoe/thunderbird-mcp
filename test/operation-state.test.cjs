"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { Core } = require("./helpers/core-modules.cjs");

const S = () => Core.operationState.OPERATION_STATES;

describe("operation states (Stage 5)", () => {
  it("defines exactly the documented states", () => {
    assert.deepEqual(Object.values(S()).sort(),
      ["completed", "failed", "opened-for-review", "queued", "submitted", "unknown"]);
  });

  it("marks errors of sending, draft and calendar tools without a state as failed", () => {
    for (const tool of Core.operationState.OPERATION_STATE_TOOLS) {
      assert.deepEqual(Core.operationState.finalizeOperationState(tool, { error: "refused" }),
        { error: "refused", operationState: "failed" }, tool);
    }
  });

  it("keeps explicit states and leaves other tools unchanged", () => {
    const unknown = { error: "timeout", operationState: "unknown" };
    assert.equal(Core.operationState.finalizeOperationState("sendMail", unknown), unknown);
    const listed = { error: "not found" };
    assert.equal(Core.operationState.finalizeOperationState("getMessage", listed), listed);
    assert.equal(listed.operationState, undefined);
    const success = { success: true, operationState: "completed" };
    assert.equal(Core.operationState.finalizeOperationState("sendMail", success), success);
    assert.equal(Core.operationState.finalizeOperationState("sendMail", null), null);
  });

  it("refuses unknown state names", () => {
    assert.throws(() => Core.operationState.withOperationState({}, "sent"), /Unknown operation state/);
  });

  it("treats only interrupted deliveries after the start as unknown", () => {
    const state = Core.operationState.deliveryFailureState;
    assert.equal(state({ started: false, definitive: false }), "failed");
    assert.equal(state({ started: false, definitive: true }), "failed");
    assert.equal(state({ started: true, definitive: true }), "failed");
    assert.equal(state({ started: true, definitive: false }), "unknown");
  });
});
