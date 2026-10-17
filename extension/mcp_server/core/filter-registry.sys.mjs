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
    FINGERPRINT_PATTERN.test(entry.fingerprint) && typeof entry.name === "string" && Array.from(entry.name).length <= MAX_NAME_LENGTH &&
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

export const MAX_NAME_LENGTH = 200;
// Gecko refuses string preferences over 1 MiB; stay well below it.
export const MAX_SERIALIZED_BYTES = 512 * 1024;

export function utf8Length(text) {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function sameRule(entry, accountKey, fingerprint) {
  return entry.accountKey === accountKey && entry.fingerprint === fingerprint;
}

export function entryCount(entries, accountKey, fingerprint) {
  return entries.filter((entry) => sameRule(entry, accountKey, fingerprint)).length;
}

// Identical rules cannot be told apart. They count as created through MCP
// only while the register holds at least one entry per live rule; an
// identical rule of the user's makes all of them foreign (fail closed).
export function isRegistered(entries, accountKey, fingerprint, liveMatches) {
  return liveMatches >= 1 && liveMatches <= entryCount(entries, accountKey, fingerprint);
}

// Removes one entry for a rule that is going away (deleted or replaced),
// but only if the register then still has no more entries than live rules
// with that effect: a deleted foreign twin must not take another client's
// registration with it. The current client's entry goes first.
function releaseOne(entries, accountKey, fingerprint, clientId, liveMatchesBefore) {
  if (entryCount(entries, accountKey, fingerprint) <= liveMatchesBefore - 1) return entries;
  let index = entries.findIndex((entry) => sameRule(entry, accountKey, fingerprint) && entry.clientId === clientId);
  if (index < 0) index = entries.findLastIndex((entry) => sameRule(entry, accountKey, fingerprint));
  return index < 0 ? entries : entries.filter((_, i) => i !== index);
}

// Records that clientId created a rule, or changed one whose previous
// effect was oldFingerprint (oldLiveMatches: live rules with that effect
// before the change). Entries are never evicted: a full register throws and
// the caller must refuse the change before saving it.
export function recordFilter(entries, { clientId, accountKey, name, fingerprint, oldFingerprint = null, oldLiveMatches = 0, now }) {
  const base = oldFingerprint ? releaseOne(entries, accountKey, oldFingerprint, clientId, oldLiveMatches) : entries;
  const full = () => new Error(`The filter register is full (${MAX_ENTRIES} rules or ${MAX_SERIALIZED_BYTES / 1024} KiB of rules created or changed through MCP); delete such rules or remove clients first`);
  if (base.length >= MAX_ENTRIES) throw full();
  // Truncate by code points so no lone surrogate is stored.
  const next = [...base, { clientId, accountKey, name: Array.from(String(name)).slice(0, MAX_NAME_LENGTH).join(""), fingerprint, createdAt: now }];
  if (utf8Length(serializeFilterRegistry(next)) > MAX_SERIALIZED_BYTES) throw full();
  return next;
}

export function forgetFilter(entries, accountKey, fingerprint, { clientId = null, liveMatchesBefore = 1 } = {}) {
  return releaseOne(entries, accountKey, fingerprint, clientId, liveMatchesBefore);
}

// Groups of identical registered rules that concern the revoked clients.
export function revocationGroups(entries, clientIds) {
  const groups = new Map();
  for (const entry of entries) {
    const key = `${entry.accountKey}\n${entry.fingerprint}`;
    if (!groups.has(key)) groups.set(key, { accountKey: entry.accountKey, fingerprint: entry.fingerprint, names: [], revoked: 0, others: 0 });
    const group = groups.get(key);
    if (clientIds.includes(entry.clientId)) {
      group.revoked++;
      if (!group.names.includes(entry.name)) group.names.push(entry.name);
    } else {
      group.others++;
    }
  }
  return [...groups.values()].filter((group) => group.revoked > 0);
}

// What revocation may do with the live rules of a group: disable them only
// if every one of them is accounted for by the revoked clients' entries.
// live < revoked: the remaining identical rules are disabled, and the
// missing ones (changed or removed since) are reported as well.
export function revocationDecision({ live, revoked, others }) {
  if (live === 0) return { conflict: "the rule was changed or removed after it was registered" };
  if (others > 0) return { conflict: "an identical rule is also registered for another client; check it manually" };
  if (live > revoked) return { conflict: "identical rules exist that were not created through MCP; check them manually" };
  if (live < revoked) {
    return { disable: true, conflict: `${revoked - live} of ${revoked} identical registered rules were changed or removed after they were registered; check them manually` };
  }
  return { disable: true };
}

export function entriesForClient(entries, clientId) {
  return entries.filter((entry) => entry.clientId === clientId);
}

export function withoutClient(entries, clientId) {
  return entries.filter((entry) => entry.clientId !== clientId);
}
