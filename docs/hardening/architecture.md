# Architecture and security boundaries of the hardened fork

## Request path

```text
MCP client
  -> mcp-bridge.cjs (stdio)  or  direct local HTTP
  -> MCP transport adapter (extension/mcp_server/api.js: HTTP handler, limits)
  -> client authentication: Bearer token -> paired client (core/client-registry.sys.mjs)
  -> coercion and schema validation
  -> authoritative policy on the effective arguments (core/policy.sys.mjs)
  -> use case (tool handler in api.js), run as that client (runAsClient):
     account/calendar/address-book scope and state-dependent capabilities
  -> narrow Thunderbird and file adapters (XPCOM calls in api.js)
```

The **extension is the authoritative boundary**. The bridge may check
additionally (it reads path attachments on the host and applies the same path
policy), but every rule that decides access runs inside the extension, so a
direct HTTP client is held to the same rules.

### Clients and capabilities (Stage 4)

* Each MCP client is paired in the options page and has its own token; the
  registry (`extensions.thunderbird-mcp-hardened.clients`) stores a SHA-256
  verifier, the capability list, explicit account keys and the calendar and
  address-book grants. A corrupt registry admits nobody. The management API
  is reachable only from the options page, never through MCP tools.
* Global preferences stay upper limits: account list, disabled tools, Block
  `skipReview`, encrypted mail, filter send actions, all calendars/address
  books.
* `runAsClient` sets the calling client for the handler; calls of different
  clients never overlap (fair queue), because access checks run deep inside
  asynchronous handlers. Without a client nothing is accessible.
* The bridge marks requests whose inline attachments it read from local
  paths (`X-Thunderbird-MCP-Local-Files: 1`); the policy then requires
  `files.attach`. The marker only adds requirements, so a direct HTTP client
  gains nothing by omitting it: it can only send content it already has.

## Module layout

| Layer | Where | XPCOM | Tested |
|---|---|---|---|
| Contracts (tool names, input schemas) | `api.js` `buildTools()`; baseline `test/baseline/tools-v0.9.2.json` | constants only | `test/tool-contract.test.cjs` |
| Policy (capabilities, per-call requirements) | `core/policy.sys.mjs` | **none** | `test/policy.test.cjs` (plain Node) |
| Client registry (parse, validate, verify) | `core/client-registry.sys.mjs`; adapter and management API in `api.js` | **none** (hashing/randomness in the adapter) | `test/client-registry.test.cjs`, native `stage4-clients.native.cjs` |
| Decisions extracted in Stage 3 | `core/attachment-source.sys.mjs`, `core/reply-template.sys.mjs`, `core/calendar-kind.sys.mjs` | **none** | direct imports + snippet tests of the api.js callers |
| Use cases and Thunderbird adapters | `api.js` | yes | vm snippet tests + native tests |
| Transport | `api.js` HTTP handler, `httpd.sys.mjs`, `mcp-bridge.cjs` | yes | unit + native |
| Trusted UI (pairing, rights) | `options.html` / `options.js` | WebExtension | unit + native UI test |

### Core module rules (mechanically enforced)

* Files in `extension/mcp_server/core/` must not use XPCOM, file, network,
  host or browser globals (`Cc`, `Ci`, `Services`, `ChromeUtils`, `IOUtils`,
  `MailServices`, `NetUtil`, `fetch`, `globalThis`, `process`, …), must not
  import or re-export anything and must not compile code (`eval`,
  `Function`, `Reflect`, or any `.constructor` / `"constructor"` access such
  as `(() => {}).constructor("...")`).
* Enforced twice: an ESLint block without those globals plus
  `no-restricted-globals`/`no-restricted-syntax` (`npm run lint`), and the
  zero-dependency `test/core-boundary.test.cjs` (lexical check, and each
  module is imported in plain Node). Both mechanisms are exercised with
  violating probes in the same test (ESLint via its Node API).
* api.js passes plain values or narrow callbacks in (for example
  `checkReplyTemplate(value, resolveFolder)`).

This is a **dependency rule, not privilege separation**: core modules run in
the same privileged Gecko process. Security comes from controlled data flow
and consistent adapter contracts, not from the module split.

### Versioned loading

`ChromeUtils.importESModule` caches a module URL for the whole process; a
native spike showed that an unchanged URL keeps returning old code after the
file changed. `getAPI()` therefore imports every core module as
`resource://thunderbird-mcp-hardened/mcp_server/core/<name>.sys.mjs?v=<version>-<load time>`.
Because core modules are leaf modules, no unversioned module can be pulled in
transitively, so one load never mixes old and new code.
`test/native/core-modules.native.cjs` changes a core module in an installed
copy, disables and re-enables the add-on, and verifies the new code is used.
Updates still require Thunderbird's normal add-on update/reload; the resource
alias has no content access and holds no secrets or runtime configuration.

## Security boundaries and limits

* Mail content, headers, MIME structure, attachments, contacts and calendar
  entries are untrusted data. Rules that decide access never depend on them
  (e.g. external attachment references are never followed, ambiguous
  Message-IDs are refused).
* The extension uses Experiment APIs and XPCOM; it is **not** a sandboxed
  WebExtension. `SystemPrincipal` means privileged Gecko context, not
  Windows administrator or `SYSTEM`.
* A process running as the same Windows user can read the profile, the
  runtime files and client secrets; the plugin cannot isolate itself from it.
* The model provider and other agent tools are outside the plugin's control.
  No claim is made of complete prompt-injection protection, nor of purely
  local processing when a cloud model reads mail.

## Remaining extraction plan

Larger pure parts still live in `api.js` and are tested through vm snippets:
the attachment path policy (duplicated in `mcp-bridge.cjs`, kept identical by
`test/validation.test.cjs`), raw MIME parsing, HTML-to-Markdown conversion,
filter vocabulary, schema validation. They move to `core/` one at a time, each
with its tests switched to direct imports, without behaviour changes.
