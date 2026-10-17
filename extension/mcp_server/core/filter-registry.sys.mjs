// Pure core module: register of filter rules created or changed through MCP
// (hardening Stage 5). No XPCOM, no imports; see attachment-source.sys.mjs.
//
// Thunderbird filter rules have no stable identity (index and name can
// change), so an entry identifies a rule by a fingerprint of its effective
// content (type, conditions, actions; not the enabled state). The register
// is versioned and strictly validated; anything unreadable is "corrupt" and
// never treated as "no registered rules".

export const FILTER_REGISTRY_VERSION = 1;
export const MAX_ENTRIES = 1000;
const CLIENT_ID_PATTERN = /^[0-9a-f]{32}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const ACCOUNT_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

function validEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (Object.keys(entry).sort().join() !== "accountKey,clientId,createdAt,fingerprint,name") return false;
  return CLIENT_ID_PATTERN.test(entry.clientId) && ACCOUNT_KEY_PATTERN.test(entry.accountKey) &&
    FINGERPRINT_PATTERN.test(entry.fingerprint) && typeof entry.name === "string" && entry.name.length <= 500 &&
    Number.isSafeInteger(entry.createdAt) && entry.createdAt >= 0;
}

export function parseFilterRegistry(text) {
  if (text === "" || text === undefined || text === null) return { entries: [], corrupt: false };
  let data;
  try { data = JSON.parse(text); } catch { return { entries: [], corrupt: true }; }
  if (!data || typeof data !== "object" || data.version !== FILTER_REGISTRY_VERSION ||
      Object.keys(data).sort().join() !== "entries,version" || !Array.isArray(data.entries) ||
      data.entries.length > MAX_ENTRIES || !data.entries.every(validEntry)) {
    return { entries: [], corrupt: true };
  }
  return { entries: data.entries.map((entry) => ({ ...entry })), corrupt: false };
}

export function serializeFilterRegistry(entries) {
  return JSON.stringify({ version: FILTER_REGISTRY_VERSION, entries });
}

// Canonical text of a rule's effect, to be hashed by the adapter.
// description: { type, terms: [...], actions: [...] } as serialized by api.js.
export function canonicalFilter(description) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
  };
  return JSON.stringify(canonical({ type: description.type, terms: description.terms, actions: description.actions }));
}

export function isRegistered(entries, accountKey, fingerprint) {
  return entries.some((entry) => entry.accountKey === accountKey && entry.fingerprint === fingerprint);
}

// Records that clientId created or changed a rule. An entry for the
// previous content (oldFingerprint) of the same rule is replaced.
export function recordFilter(entries, { clientId, accountKey, name, fingerprint, oldFingerprint = null, now }) {
  const kept = entries.filter((entry) =>
    !(entry.accountKey === accountKey && (entry.fingerprint === fingerprint || (oldFingerprint && entry.fingerprint === oldFingerprint))));
  const next = [...kept, { clientId, accountKey, name, fingerprint, createdAt: now }];
  return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
}

export function forgetFilter(entries, accountKey, fingerprint) {
  return entries.filter((entry) => !(entry.accountKey === accountKey && entry.fingerprint === fingerprint));
}

export function entriesForClient(entries, clientId) {
  return entries.filter((entry) => entry.clientId === clientId);
}

export function withoutClient(entries, clientId) {
  return entries.filter((entry) => entry.clientId !== clientId);
}
