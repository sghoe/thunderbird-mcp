// Pure core module: calendar item kinds (hardening finding C).
// No XPCOM, no imports; see attachment-source.sys.mjs for the module rules.

// calIItemBase.isEvent()/isTodo(); `itemUtils` (cal.item) as a fallback.
// Unknown kinds are "unknown" so callers fail closed: a lookup by ID can
// return any item type.
export function getCalendarItemKind(item, itemUtils = null) {
  try {
    if (typeof item?.isTodo === "function" && item.isTodo()) return "task";
    if (typeof item?.isEvent === "function" && item.isEvent()) return "event";
  } catch { /* fall through */ }
  try {
    if (itemUtils?.isToDo?.(item)) return "task";
    if (itemUtils?.isEvent?.(item)) return "event";
  } catch { /* unknown */ }
  return "unknown";
}
