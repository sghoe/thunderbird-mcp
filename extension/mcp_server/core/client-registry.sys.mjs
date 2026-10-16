// Pure core module: paired MCP clients (hardening Stage 4).
// No XPCOM, no imports; see attachment-source.sys.mjs for the module rules.
//
// Each client has its own random token. Only a SHA-256 verifier of the
// token is stored; the token itself is shown once in the options page. The
// registry is versioned and strictly validated: anything unreadable yields
// "corrupt", which the server treats as "no client may connect" (it never
// falls back to permissive defaults). MCP calls cannot change the registry.

export const REGISTRY_VERSION = 1;
export const MAX_CLIENTS = 32;
export const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const VERIFIER_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[0-9a-f]{32}$/;
const NAME_MAX = 64;

function hasControlCharacter(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function validName(name) {
  return typeof name === "string" && name.trim() === name && name.length > 0 &&
    name.length <= NAME_MAX && !hasControlCharacter(name);
}

function validAccountKeys(list) {
  return Array.isArray(list) && list.length <= 256 &&
    list.every((key) => typeof key === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(key)) &&
    new Set(list).size === list.length;
}

// Checks one stored client. `knownCapabilities` comes from the policy module
// so a stored capability that no longer exists invalidates the registry.
function validClient(client, knownCapabilities) {
  if (!client || typeof client !== "object" || Array.isArray(client)) return false;
  const keys = Object.keys(client).sort().join();
  if (keys !== "accounts,addressBooks,calendars,capabilities,createdAt,id,name,profile,verifier") return false;
  if (!ID_PATTERN.test(client.id) || !VERIFIER_PATTERN.test(client.verifier)) return false;
  if (!validName(client.name)) return false;
  if (typeof client.profile !== "string" || client.profile.length > 32) return false;
  if (!Number.isSafeInteger(client.createdAt) || client.createdAt < 0) return false;
  if (!Array.isArray(client.capabilities) ||
      !client.capabilities.every((c) => typeof c === "string" && knownCapabilities.has(c)) ||
      new Set(client.capabilities).size !== client.capabilities.length) return false;
  if (!validAccountKeys(client.accounts)) return false;
  return typeof client.calendars === "boolean" && typeof client.addressBooks === "boolean";
}

// Parses the stored preference text. Empty means "no clients yet".
export function parseRegistry(text, knownCapabilities) {
  const known = new Set(knownCapabilities);
  if (text === "" || text === undefined || text === null) return { clients: [], corrupt: false };
  let data;
  try { data = JSON.parse(text); } catch { return { clients: [], corrupt: true }; }
  if (!data || typeof data !== "object" || data.version !== REGISTRY_VERSION || !Array.isArray(data.clients) ||
      data.clients.length > MAX_CLIENTS || Object.keys(data).sort().join() !== "clients,version") {
    return { clients: [], corrupt: true };
  }
  if (!data.clients.every((c) => validClient(c, known))) return { clients: [], corrupt: true };
  const ids = new Set(data.clients.map((c) => c.id));
  const verifiers = new Set(data.clients.map((c) => c.verifier));
  if (ids.size !== data.clients.length || verifiers.size !== data.clients.length) return { clients: [], corrupt: true };
  return { clients: data.clients.map((c) => ({ ...c, capabilities: [...c.capabilities], accounts: [...c.accounts] })), corrupt: false };
}

export function serializeRegistry(clients) {
  return JSON.stringify({ version: REGISTRY_VERSION, clients });
}

// Settings a user may choose for a client in the options page.
export function validateClientSettings(settings, { knownCapabilities, knownAccounts }) {
  const known = new Set(knownCapabilities);
  if (!settings || typeof settings !== "object") return { error: "Client settings are required" };
  const { name, profile, capabilities, accounts, calendars, addressBooks } = settings;
  if (!validName(name)) return { error: `Client name must be 1-${NAME_MAX} characters without control characters or surrounding spaces` };
  if (typeof profile !== "string" || !profile || profile.length > 32) return { error: "Invalid profile" };
  if (!Array.isArray(capabilities) || !capabilities.every((c) => typeof c === "string" && known.has(c))) {
    return { error: "Unknown capability" };
  }
  if (!validAccountKeys(accounts) || !accounts.every((a) => knownAccounts.includes(a))) {
    return { error: "Unknown account" };
  }
  if (typeof calendars !== "boolean" || typeof addressBooks !== "boolean") {
    return { error: "calendars and addressBooks must be true or false" };
  }
  return {
    settings: {
      name, profile,
      capabilities: [...new Set(capabilities)].sort(),
      accounts: [...new Set(accounts)],
      calendars, addressBooks,
    },
  };
}

// The entry stored for a new client; `id` and `verifier` come from the
// adapter (random id, SHA-256 of a random token).
export function newClient({ id, verifier, createdAt, settings }) {
  return { id, name: settings.name, verifier, createdAt, profile: settings.profile,
    capabilities: settings.capabilities, accounts: settings.accounts,
    calendars: settings.calendars, addressBooks: settings.addressBooks };
}

// Finds the client for a presented token's verifier. `equals` must compare
// in constant time; every stored verifier is compared.
export function findClientByVerifier(clients, verifier, equals) {
  let match = null;
  for (const client of clients) {
    if (equals(client.verifier, verifier) && !match) match = client;
  }
  return match;
}

// What the options page may show: never the verifier.
export function publicView(client) {
  const { verifier: _verifier, ...rest } = client;
  return { ...rest, capabilities: [...client.capabilities], accounts: [...client.accounts] };
}
