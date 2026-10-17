// Pure core module: entries of the optional diagnostic log. No XPCOM, no
// imports; see attachment-source.sys.mjs.
//
// The log is for finding problems, not for auditing content: it records the
// operation, client, outcome, operation state, permission decision and a
// redacted error text – never message bodies, subjects, recipients, file
// paths, folder URIs, tokens or attachment contents.

export const MAX_ERROR_LENGTH = 300;
export const MAX_FILE_BYTES = 1024 * 1024;

const REDACTIONS = [
  // URIs of any scheme (folders, messages, http, file).
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>),]*/gi, "<uri>"],
  // Message references and anything that looks like an address or Message-ID.
  [/\bmsgref:[^\s"',)]*/gi, "<msgref>"],
  [/<?[^\s<>"'(),;:]+@[^\s<>"'(),;:]+>?/g, "<addr>"],
  // Windows, UNC and POSIX paths.
  [/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]*/g, "<path>"],
  [/(^|[\s(=])\/(?:[^\s/"']+\/)+[^\s"']*/g, "$1<path>"],
  // Quoted names: subjects, titles, filter and folder names.
  [/"[^"\n]*"/g, '"…"'],
];

export function redact(text) {
  let value = String(text ?? "");
  for (const [pattern, replacement] of REDACTIONS) value = value.replace(pattern, replacement);
  if (value.length > MAX_ERROR_LENGTH) value = `${value.slice(0, MAX_ERROR_LENGTH)}…`;
  return value;
}

const EVENTS = new Set(["server", "request", "tool", "error"]);
const SAFE_NAME = /^[A-Za-z0-9_./-]{1,64}$/;

// fields: { event, tool?, client?, outcome?, operationState?, status?, ms?, missing?, error? }
// Returns one JSON line (without newline).
export function formatEntry(now, fields) {
  if (!EVENTS.has(fields.event)) throw new Error(`Unknown diagnostic event: ${fields.event}`);
  const entry = { t: new Date(now).toISOString(), event: fields.event };
  if (fields.tool !== undefined) entry.tool = SAFE_NAME.test(String(fields.tool)) ? String(fields.tool) : "<invalid>";
  // Client names are labels the user chose in the options page.
  if (fields.client !== undefined) entry.client = String(fields.client).slice(0, 64);
  for (const key of ["outcome", "operationState", "detail"]) {
    if (fields[key] !== undefined) entry[key] = SAFE_NAME.test(String(fields[key])) ? String(fields[key]) : "<invalid>";
  }
  if (Number.isSafeInteger(fields.status)) entry.status = fields.status;
  if (Number.isFinite(fields.ms)) entry.ms = Math.round(fields.ms);
  if (Array.isArray(fields.missing)) entry.missing = fields.missing.filter((cap) => SAFE_NAME.test(String(cap))).map(String);
  if (fields.error !== undefined) entry.error = redact(fields.error);
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
