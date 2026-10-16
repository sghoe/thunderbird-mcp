# Hardened fork: Stage 4 – per-client credentials and positive permissions

Scope: replace the single shared token with paired clients, each with its
own token, capabilities and scope, and enforce the policy core from Stage 3
on every call. Migration effects: [migration.md](migration.md#stage-4--paired-clients-and-positive-permissions).

## Decisions

* Pairing happens only in the options page (trusted UI). There is no MCP
  tool for it, so a client cannot grant itself rights or create credentials.
* Token: 32 random bytes as 64 hex characters, shown once. Stored: SHA-256
  verifier (`nsICryptoHash`). Every request is hashed (also malformed ones)
  and compared with every stored verifier in constant time.
* Registry: one versioned preference `extensions.thunderbird-mcp-hardened.clients`,
  validated strictly (`core/client-registry.sys.mjs`). Anything unexpected
  (version, keys, unknown capability, wildcard account, duplicate id or
  verifier) makes it corrupt: no client is admitted and nothing is reset
  silently; the options page offers "Remove all clients".
* Accounts are explicit keys (no wildcard). Calendars and address books have
  their own grants. Global preferences remain upper limits.
* Profiles (`none`, `read-only`, `drafts`, `automation`) are presets; the
  stored capability list is what counts. `custom` allows single capabilities.
* Revocation and changed rights take effect for the next request; running
  calls finish.
* Encrypted content stays a global preference (no capability yet).
* Fresh install: no clients, every request gets HTTP 403 until pairing.

## Changes

* `core/client-registry.sys.mjs` (pure) and a client registry adapter plus
  client management API in `api.js`; `schema.json`, `options.html` and
  `options.js` expose the Clients section (list, create, new token, revoke,
  remove all).
* HTTP handler: `authenticateClient` replaces the shared token; `tools/list`
  is filtered with `isToolVisible`; `tools/call` evaluates
  `Core.policy.decide` on coerced and validated arguments and runs the
  handler with `runAsClient`.
* Access helpers: `isAccountAllowed` = global list AND client accounts;
  calendar/contact tools need the client grant; `clientHasCapability` for
  state-dependent checks; without a client nothing is accessible. Calls of
  different clients never overlap; once a client waits, the active client's
  new calls queue behind it.
* State-dependent checks (review findings of Stage 3): permanent deletion
  needs `mail.deletePermanent`; `applyFilters` skips rules whose actions the
  client lacks (`missing-capability`); `updateFilter` refuses changes other
  than disabling to rules whose stored actions the client lacks; changing or
  deleting meetings and assigned tasks with attendees needs
  `calendar.schedule`.
* Discovery: `connection.json` is `{port, pid}`; files with a leftover token
  are rewritten. The bridge takes the token from `THUNDERBIRD_MCP_TOKEN` or
  `THUNDERBIRD_MCP_TOKEN_FILE` and marks requests whose attachments it read
  from local paths (`X-Thunderbird-MCP-Local-Files: 1` → `files.attach`).
* `getAccountAccess` reports `restricted` when the client sees fewer than all
  accounts.

## Tests

* Unit: `test/client-registry.test.cjs` (rules, corrupt registry, token
  verification, pairing, rotation, revocation, unreadable preference),
  HTTP handler authorization in `test/validation.test.cjs` (403, refusal
  before the handler, coerced arguments, local-files marker, `tools/list`
  filter), client scope and `runAsClient` ordering in
  `test/privacy-access.test.cjs`, state-dependent checks in the filter,
  deletion and calendar tests, bridge token and marker tests. Snippet tests
  run as a full-access test client (`test/helpers/test-client.cjs`).
* Native: `test/native/stage4-clients.native.cjs` – discovery without
  secret, 403 for unknown/malformed/missing tokens, `tools/list` per client,
  refused effects without side effects, account/calendar/address-book scope,
  bridge end to end with a local file (refused for `drafts`, allowed for a
  granted client), revocation, corrupt registry, and pairing through the
  real options page (Marionette, extension pages in the parent process).
  Negative control: against the Stage 3 build 7 of 8 client tests fail.
* Native parity: the harness pairs a full-access client; 64 calls / 40 tools
  identical to upstream v0.9.2.

## Review round 1 (Sol 6.1, Opus 5.5) – fixes

* Permanent deletion by filters (both reviewers): a filter "Delete" runs as
  a permanent delete in Trash (and below) and on IMAP accounts whose delete
  model is not move-to-Trash (`nsMsgFilterAfterTheFact` → `DeleteMessages`
  without storage flag). `applyFilters` now requires `mail.deletePermanent`
  for such rules where they run (Trash target or IMAP model), and
  `createFilter`/`updateFilter` require it on IMAP accounts without
  move-to-Trash. Unreadable state counts as permanent.
* Forward filters and the sender account (Sol): `nsMsgComposeService::
  ForwardMessage` sends from the default identity of the account that owns
  the filtered folder and falls back to the global default identity when
  that account has none (Local Folders). A client limited to Local Folders
  could thus send from an excluded account. Forward rules now need an
  accessible account with its own identity: `createFilter`/`updateFilter`
  refuse them otherwise, `applyFilters` skips them (`unauthorized-sender`).
  Reply templates only use the account's own identities (verified in the
  same file) and are unaffected.
* Native regression (`stage4-clients.native.cjs`, filter block): both
  scenarios fail on 5a87531 and pass now; forwarding from an account with
  its own identity still sends (positive control).