// Pure core module: honest operation states (hardening Stage 5). No XPCOM,
// no imports; see attachment-source.sys.mjs.
//
// Tools that send mail, save drafts or write calendar items report what is
// actually known about their effect in an additive `operationState` field.
// Nothing is ever retried automatically; "unknown" means the effect may or
// may not have happened and must be checked before trying again.

export const OPERATION_STATES = Object.freeze({
  // A compose window or calendar dialog was opened; the user decides there.
  OPENED_FOR_REVIEW: "opened-for-review",
  // Handed to a calendar provider, which accepted the change; synchronisation
  // and any invitations it generates are outside the add-on's view.
  SUBMITTED: "submitted",
  // Stored in the Outbox for later sending.
  QUEUED: "queued",
  // Thunderbird reported completion (SMTP server accepted the message, or
  // the draft was stored).
  COMPLETED: "completed",
  // Not performed; nothing was sent, saved or written.
  FAILED: "failed",
  // May or may not have happened (timeout, interrupted connection, provider
  // error after the request was made).
  UNKNOWN: "unknown",
});

const STATES = new Set(Object.values(OPERATION_STATES));

export const OPERATION_STATE_TOOLS = Object.freeze([
  "sendMail", "replyToMessage", "forwardMessage", "saveDraft",
  "createEvent", "updateEvent", "deleteEvent", "createTask", "updateTask",
]);

function isResultObject(result) {
  return !!result && typeof result === "object" && !Array.isArray(result);
}

// Sets the state unless the result already carries one.
export function withOperationState(result, state) {
  if (!STATES.has(state)) throw new Error(`Unknown operation state: ${state}`);
  if (!isResultObject(result) || result.operationState !== undefined) return result;
  return { ...result, operationState: state };
}

// Final step of a tool call: an error without an explicit state was raised
// before any effect, so it is "failed". Successes must set their state where
// the effect is known.
export function finalizeOperationState(tool, result) {
  if (!OPERATION_STATE_TOOLS.includes(tool) || !isResultObject(result)) return result;
  if (result.error !== undefined) return withOperationState(result, OPERATION_STATES.FAILED);
  return result;
}

// A delivery error before the SMTP transaction started, or one that is a
// definitive refusal (server reply, connection refused, unknown host), means
// nothing was accepted. Anything else after the start (reset, interrupt,
// timeout, abort) can follow an accepted message.
export function deliveryFailureState({ started, definitive }) {
  return started && !definitive ? OPERATION_STATES.UNKNOWN : OPERATION_STATES.FAILED;
}
