// Pure core module: entries of the optional diagnostic log. No XPCOM, no
// imports; see attachment-source.sys.mjs.
//
// The log is for finding problems, not for auditing content. Every value it
// writes is either a constant of this add-on or a number: event, known tool
// name, an opaque client ID, outcome, operation state, permission decision,
// and for failures a fixed error category, the JavaScript error class and
// the XPCOM result name. Error texts themselves are never written – they
// carry names, paths, addresses and identifiers that no pattern can reliably
// remove.

export const MAX_FILE_BYTES = 1024 * 1024;
// Only this much of an error text is examined; matching is linear in it.
const MAX_SCAN = 512;

// Static leading text of the error literals in api.js. Generated – run
// `node scripts/diagnostic-categories.cjs --write` after changing errors.
// BEGIN ERROR CATEGORIES
export const ERROR_CATEGORIES = Object.freeze([
  "Account access preference is corrupt or unreadable. All accounts are blocked. Select accounts explicitly to repair it",
  "Account does not support filters",
  "Account has no server",
  "Account not accessible",
  "Account not accessible for folder",
  "Account not found",
  "Account restrictions block this tool. Enable",
  "Action",
  "Add-on shut down during startup",
  "Address book not found",
  "All calendars are disabled. Enable a calendar in Thunderbird",
  "All tool names must be strings",
  "Attachment count",
  "Attachment refused",
  "Attachment too large",
  "Attachments must be an array",
  "Attachments refused",
  "Attendee email must be a single email address",
  "Attendee email must be an email address without control characters",
  "Attendee name must be a string without control characters",
  "Attendee role must be required or optional",
  "Calendar",
  "Calendar is read-only",
  "Calendar module not available",
  "Calendar not available",
  "Calendar not found",
  "Cannot",
  "Cannot add attachments to the compose window",
  "Cannot build filter actions",
  "Cannot build filter conditions",
  "Cannot combine moveTo, copyTo, or trash",
  "Cannot combine recurrence and recurrenceId",
  "Cannot delete a root folder",
  "Cannot disable infrastructure tools",
  "Cannot manage attendees",
  "Cannot manage attendees without a calendar identity",
  "Cannot replace draft",
  "Cannot replace draft outside the selected identity",
  "Cannot save reply draft",
  "Cannot update",
  "Cannot validate filter actions",
  "Compose window does not support SaveAsDraft",
  "Condition",
  "Condition attrib",
  "Condition with attrib",
  "Contact not found",
  "Could not access filter list",
  "Could not access folder database",
  "Could not access tabmail interface",
  "Could not bind to any port in range",
  "Could not parse message",
  "Custom filter actions are unsupported",
  "Direct forward of this signed message cannot include its attachments while encrypted message access is off. Use skipReview",
  "Direct forward refused",
  "Direct reply or automatic drafting of encrypted messages is blocked. Use skipReview",
  "Direct reply/forward of encrypted messages is blocked. Use skipReview",
  "Empty recurrence rule",
  "Event not found",
  "Failed to display message",
  "Failed to get message",
  "Failed to include inline images",
  "Failed to read raw source",
  "Filter name must be a non-empty string",
  "Filter service not available in this Thunderbird version",
  "Filter target folder not accessible",
  "Folder",
  "Folder is already under this parent",
  "Folder not found",
  "Forward/Reply filter actions are disabled. Enable",
  "Gloda full-text index is not available",
  "Image exceeds per-image base64 limit",
  "Inline image fetch failed",
  "Inline image fetch returned no data",
  "Inline image has no fetchable message-part URL",
  "Inline image read failed",
  "Invalid displayMode",
  "Invalid dueBefore",
  "Invalid dueDate",
  "Invalid endDate",
  "Invalid filter index",
  "Invalid format",
  "Invalid header name",
  "Invalid message reference",
  "Invalid or duplicate recurrence rule part",
  "Invalid parameters for",
  "Invalid recurrence FREQ",
  "Invalid recurrence rule",
  "Invalid recurrenceId",
  "Invalid showAs",
  "Invalid source index",
  "Invalid startDate",
  "Invalid status",
  "Invalid target index",
  "Invalid tool name",
  "Manual filters are unavailable in this Thunderbird version",
  "Message has zero size - cannot read raw source",
  "Message not found",
  "Message reference is stale",
  "Message reference must be an object with messageId and folderPath",
  "Message-ID is ambiguous",
  "Missing exception",
  "Missing tool name",
  "No Thunderbird mail window found",
  "No Thunderbird window found",
  "No accessible identity found",
  "No changes specified",
  "No identity available for direct send",
  "No matching messages found",
  "No occurrence found at recurrenceId",
  "No writable address book found",
  "No writable calendar found",
  "No writable task-capable calendar found",
  "Not permitted",
  "Not permitted for client",
  "Not permitted for this client",
  "Not sent",
  "Privacy settings must be booleans",
  "Recurrence rule cannot combine COUNT and UNTIL",
  "Recurrence rule must be a string without control characters",
  "Recurrence rule must contain a FREQ part",
  "Reply template not accessible",
  "Save failed",
  "Saving reply draft failed",
  "Send failed",
  "Send was not performed",
  "Signature file exceeds the 1 MiB limit or has an invalid size",
  "Specify either",
  "Specify messageId or messageIds, not both",
  "Task not found",
  "The change could not be recorded in the register of filter rules created through MCP, so it was not applied",
  "The client registry is corrupt. Remove all clients to repair it",
  "The register of filter rules created through MCP is unreadable, so new rules could not be revoked",
  "The rule could not be recorded in the register of filter rules created through MCP, so it was not created",
  "This Thunderbird",
  "This client has no access to",
  "Thunderbird could not parse the recurrence rule",
  "Too many clients",
  "Tool is disabled",
  "Transport security error",
  "Trash folder not found",
  "Unknown account IDs",
  "Unknown action type",
  "Unknown attribute",
  "Unknown client",
  "Unknown operator",
  "Unknown tool",
  "Unreadable attendees",
  "Unsupported filter action type",
  "User preference blocks skipReview. Retry with skipReview",
  "actions must be a non-empty array",
  "actions must be a valid JSON array",
  "addTags must be an array of tag keyword strings",
  "allowFilterSendActions must be a boolean",
  "allowedAccountIds must be an array",
  "attachment body not recoverable from raw MIME",
  "attachment body recovered from raw MIME but size mismatch",
  "attachment raw MIME recovery size check failed",
  "attachment raw MIME recovery write failed",
  "attendees must be an array",
  "blockSkipReview must be a boolean",
  "calendarId is required",
  "compose window not ready",
  "conditions must be a non-empty array",
  "conditions must be a valid JSON array",
  "contactId must be a non-empty string",
  "copyTo must be a non-empty string",
  "disabledTools must be an array",
  "enabled must be a boolean",
  "endDate must be after startDate",
  "endDate must not be before startDate",
  "eventId is required",
  "export directory has group/world permissions",
  "export directory is a symlink",
  "filterIndex must be an integer",
  "folderPath must be a non-empty string",
  "fromIndex must be an integer",
  "getMessages accepts at most",
  "getMessagesLimit must be an integer",
  "getMessagesLimit must be between 1 and",
  "identity",
  "inReplyTo must be one bracketed Message-ID",
  "invalid base64 body",
  "listenAll must be a boolean",
  "message stream has zero size",
  "message stream read made no progress",
  "message too large",
  "messageId must be a non-empty string",
  "messageId or messageIds is required",
  "messageIds must be a non-empty array of strings",
  "moveTo must be a non-empty string",
  "name must be a non-empty string",
  "newName must be a non-empty string",
  "newParentPath must be a non-empty string",
  "no Drafts folder",
  "parentFolderPath must be a non-empty string",
  "path resolution failed",
  "priority must be an integer between 0 and 9",
  "references must be up to 100 bracketed Message-IDs separated by single spaces, at most 998 characters per ID and 16384 total, without control characters",
  "refusing to store an invalid filter register",
  "removeTags must be an array of tag keyword strings",
  "replaceMessageId must be a non-empty message ID",
  "replaceMessageId must name a message in an accessible folder with the Drafts flag",
  "replaceMessageId requires replaceFolderPath",
  "saveAsDraft cannot be combined with skipReview",
  "saveAsDraft requires the saveDraft tool to be enabled",
  "searchBody requires a non-empty query",
  "symlinked or junction path blocked",
  "taskId is required",
  "the file changed while it was being attached",
  "thunderbird-mcp tmp directory has group/world permissions",
  "thunderbird-mcp tmp directory is a symlink",
  "toIndex must be an integer",
  "type contains unknown or unavailable nsMsgFilterType bits",
  "unknown identity",
  "window still loading",
]);
// END ERROR CATEGORIES

const CATEGORIES_BY_LENGTH = [...ERROR_CATEGORIES].sort((a, b) => b.length - a.length);
const WORD_CHAR = /[A-Za-z0-9]/;

// The longest category the text starts with (as a whole word), or
// "<unclassified>". The result is always one of the constants above.
export function categorize(text) {
  let value = String(text ?? "").slice(0, MAX_SCAN);
  const prefix = /^[A-Za-z]{0,40}Error: /.exec(value);
  if (prefix) value = value.slice(prefix[0].length);
  for (const category of CATEGORIES_BY_LENGTH) {
    if (value.startsWith(category) && !WORD_CHAR.test(value.charAt(category.length))) return category;
  }
  return "<unclassified>";
}

const EVENTS = new Set(["server", "request", "tool", "error"]);
const OUTCOMES = new Set(["ok", "error", "refused", "started", "failed", "log-enabled", "log-disabled"]);
const OPERATION_STATES = new Set(["opened-for-review", "submitted", "queued", "completed", "failed", "unknown"]);
const DETAILS = new Set(["auth", "parse-error", "dispatch", "listen-all", "loopback",
  "initialize", "resources/list", "prompts/list", "tools/list", "tools/call", "other-method"]);
const ERROR_CLASSES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError",
  "URIError", "EvalError", "AggregateError", "InternalError"]);
const CLIENT_ID = /^[0-9a-f]{8}$/;
const CAPABILITY = /^[a-z]+(?:\.[a-z]+)*$/;
const RESULT_NAME = /^NS_[A-Z0-9_]{1,80}$/;

const known = (set, value) => (set.has(value) ? value : "<invalid>");

// fields: { event, tool?, client?, outcome?, operationState?, detail?, status?,
// ms?, missing?, error?, code? }. options.toolNames: the add-on's tool names;
// any other tool name is written as "<unknown>". Returns one JSON line
// (without newline).
export function formatEntry(now, fields, options = {}) {
  if (!EVENTS.has(fields.event)) throw new Error(`Unknown diagnostic event: ${fields.event}`);
  const entry = { t: new Date(now).toISOString(), event: fields.event };
  if (fields.tool !== undefined) entry.tool = options.toolNames?.has(fields.tool) ? fields.tool : "<unknown>";
  // An opaque client ID (start of the registry ID, shown in the options
  // page), never the user-chosen client name.
  if (fields.client !== undefined) entry.client = CLIENT_ID.test(fields.client) ? fields.client : "<invalid>";
  if (fields.outcome !== undefined) entry.outcome = known(OUTCOMES, fields.outcome);
  if (fields.operationState !== undefined) entry.operationState = known(OPERATION_STATES, fields.operationState);
  if (fields.detail !== undefined) entry.detail = known(DETAILS, fields.detail);
  if (Number.isSafeInteger(fields.status)) entry.status = fields.status;
  if (Number.isFinite(fields.ms)) entry.ms = Math.round(fields.ms);
  if (Array.isArray(fields.missing)) {
    entry.missing = fields.missing.filter((cap) => typeof cap === "string" && cap.length <= 64 && CAPABILITY.test(cap));
  }
  if (fields.error !== undefined) {
    const error = fields.error;
    const isObject = error !== null && typeof error === "object";
    entry.error = categorize(isObject && typeof error.message === "string" ? error.message : String(error));
    if (isObject && ERROR_CLASSES.has(error.name)) entry.errorClass = error.name;
  }
  if (typeof fields.code === "string" && RESULT_NAME.test(fields.code)) entry.code = fields.code;
  return JSON.stringify(entry);
}

// Outcome of a tool result as returned by the handlers.
export function summarizeToolResult(result) {
  const summary = { outcome: "ok" };
  if (result && typeof result === "object" && !Array.isArray(result)) {
    if (result.error !== undefined) {
      summary.outcome = "error";
      summary.error = result.error;
    }
    if (typeof result.operationState === "string") summary.operationState = result.operationState;
  }
  return summary;
}
