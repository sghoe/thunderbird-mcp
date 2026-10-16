// Pure core module: attachment source rules (hardening finding A).
//
// Core modules contain no XPCOM, file or network access and import nothing;
// api.js passes them plain values. Enforced by eslint.config.mjs and
// test/core-boundary.test.cjs; loaded with a per-load version query so an
// add-on reload never mixes old and new module code.

// Thunderbird stores detached/external attachments as a local notice plus
// X-Mozilla-External-Attachment-URL; Gloda then reports that foreign
// location (http:, file:, UNC, ...) as the attachment URL. Attachment bytes
// must only ever come from the authorized message itself. The scheme list
// only classifies; fetching is gated by isPartUrlOf.
export const EXTERNAL_ATTACHMENT_NOT_FETCHED =
  "External or detached attachment: the message only stores a reference to another location, which is not fetched";

const FOREIGN_ATTACHMENT_URL_SCHEMES = new Set([
  "http", "https", "file", "ftp", "smb", "data", "blob", "jar",
  "resource", "chrome", "moz-extension", "about", "javascript",
]);

const PART_NAME = /^\d+(?:\.\d+)*$/;

export function isExternalAttachmentRecord(att) {
  if (att?.isExternal === true) return true;
  const url = typeof att?.url === "string" ? att.url : "";
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  return !!scheme && FOREIGN_ATTACHMENT_URL_SCHEMES.has(scheme);
}

// Part URL from the message's own service URL and a validated MIME part
// number; "" when either is unusable.
export function buildPartUrl(baseUrl, partName) {
  if (typeof baseUrl !== "string" || !baseUrl) return "";
  if (typeof partName !== "string" || !PART_NAME.test(partName)) return "";
  return `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}part=${partName}`;
}

// True only for exactly baseUrl plus one numeric part selector.
export function isPartUrlOf(baseUrl, url) {
  if (typeof baseUrl !== "string" || !baseUrl) return false;
  if (typeof url !== "string" || !url.startsWith(baseUrl)) return false;
  return /^[?&]part=\d+(?:\.\d+)*$/.test(url.slice(baseUrl.length));
}
