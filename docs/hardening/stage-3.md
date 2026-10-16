# Hardened fork: Stage 3 – mechanically enforced modularisation

Scope: introduce pure core modules with an enforced dependency rule and a
verified versioned loading mechanism, extract the Stage 2 security decisions,
and add the pure policy core used by Stage 4. No behaviour change.

## Changes

* `extension/mcp_server/core/`:
  * `attachment-source.sys.mjs` – external-attachment classification, part
    URL construction and the own-part-URL guard (finding A).
  * `reply-template.sys.mjs` – native-exact Reply template parsing and
    authorisation (finding B).
  * `calendar-kind.sys.mjs` – fail-closed item kind (finding C).
  * `policy.sys.mjs` – capability catalogue, profiles and per-call
    requirements derived from tool **and** arguments (used in Stage 4).
* `api.js`: `Core` registry; `getAPI()` imports each core module under a
  per-load version query; the former helpers delegate to the modules and only
  add Thunderbird lookups (message base URL, folder resolution, `cal.item`).
* Enforcement: ESLint block for `core/` and `test/core-boundary.test.cjs`
  (see `architecture.md`). A deliberately violating module produced six lint
  errors (import, `Services`, `Cc`, `globalThis`).
* Tests: snippet sandboxes receive the **real** modules
  (`test/helpers/core-modules.cjs`); `test/policy.test.cjs` imports the
  policy module directly and checks that every input property of every tool
  is classified.

## Verification

* Unit: all tests pass except the 2 pre-existing Windows-only Flatpak tests.
* Lint: no errors (6 pre-existing warnings in upstream code).
* Native (Windows 11, Thunderbird 153.5.0esr): all 24 native tests pass,
  including `core-modules.native.cjs` (modules serve requests; a changed
  module is used after disable/enable).
* Native parity: 64 calls / 40 tools identical to upstream v0.9.2.
