// Pure core module: filter Reply template rules (hardening finding B).
// No XPCOM, no imports; see attachment-source.sys.mjs for the module rules.

// nsMsgFolderFlags.Templates.
export const TEMPLATES_FOLDER_FLAG = 0x00400000;
export const REPLY_TEMPLATE_FORMAT_HINT = "<Templates folder URI>?messageId=<Message-ID>&subject=<subject>";

// Mirrors nsMsgComposeService::ReplyWithTemplate, which searches both
// delimiters from the start of the whole value (PL_strstr). A "&subject="
// before the Message-ID would make the native code take a reversed
// substring and abort, so such values are rejected. Returns null when the
// native code would not find a template.
export function parseReplyTemplate(value) {
  const text = typeof value === "string" ? value : "";
  const query = text.indexOf("?messageId=");
  const subjectAt = text.indexOf("&subject=");
  if (query <= 0 || subjectAt < query + 11) return null;
  const messageId = text.slice(query + 11, subjectAt);
  if (!messageId) return null;
  return { folderUri: text.slice(0, query), messageId, query: text.slice(query) };
}

// A Reply action's template is mailed automatically, so its folder must pass
// the same account check as a Move/Copy target, carry the Templates flag,
// and hold exactly one message with that Message-ID. `resolveFolder(uri)`
// returns { folder } or { error } (Thunderbird adapter). Returns the value
// rebuilt from the canonical folder URI; throws on any violation and never
// echoes a possibly restricted URI.
export function checkReplyTemplate(value, resolveFolder) {
  const parsed = parseReplyTemplate(value);
  if (!parsed) throw new Error(`Reply template must be ${REPLY_TEMPLATE_FORMAT_HINT}`);
  let folder = null;
  try {
    const target = resolveFolder(parsed.folderUri);
    if (!target?.error) folder = target?.folder || null;
  } catch { /* fail closed below */ }
  if (!folder || typeof folder.URI !== "string" || !folder.URI) {
    throw new Error("Reply template folder not accessible");
  }
  let isTemplates = false;
  try { isTemplates = typeof folder.getFlag === "function" && folder.getFlag(TEMPLATES_FOLDER_FLAG); } catch { /* fail closed */ }
  if (!isTemplates) throw new Error("Reply template must be stored in a folder with the Templates flag");
  let matches = 0;
  try {
    for (const hdr of folder.msgDatabase.enumerateMessages()) {
      if (hdr.messageId === parsed.messageId && ++matches > 1) break;
    }
  } catch {
    throw new Error("Reply template folder could not be read");
  }
  if (matches === 0) throw new Error("Reply template message not found in the Templates folder");
  if (matches > 1) throw new Error("Reply template Message-ID is ambiguous: several messages in the Templates folder share it");
  // The canonical folder URI must not change how the native code parses it.
  const canonical = `${folder.URI}${parsed.query}`;
  const reparsed = parseReplyTemplate(canonical);
  if (!reparsed || reparsed.folderUri !== folder.URI || reparsed.messageId !== parsed.messageId) {
    throw new Error("Reply template folder URI cannot be used in a reply template");
  }
  return canonical;
}
