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

## Review round 1 (Sol 6.1, Opus 5.5) – fixes

* Boundary: constructor-based dynamic code (`(() => {}).constructor("...")`)
  passed both checks. ESLint and the boundary test now refuse `.constructor`,
  the string `"constructor"` and `Reflect`; violating probes are part of
  the test for both mechanisms.
* Policy (only effective once Stage 4 wires it):
  * Raw values fail closed: a non-array where an array is expected is
    unclassified; any value other than an explicit false counts as the risky
    variant; only an explicit `true` may drop the review requirement.
    Stage 4 evaluates the policy after coercion and validation.
  * Filter actions require the capabilities of their effect
    (`filterActionCapabilities`: move/copy → `mail.move`, delete →
    `mail.delete`, delete from POP server → `mail.deletePermanent`,
    forward/reply → `filters.autosend`, flags/tags → `mail.flag`; unknown →
    unclassified).
  * Request context `{ inlinedLocalFiles }`: inline attachments that the
    bridge read from local paths require `files.attach` like paths do.
  * Effects that depend on stored state (permanent deletion from Trash or by
    the IMAP delete model, the actions of stored filters for `applyFilters`
    and `updateFilter`, meetings and assigned tasks with attendees) are
    checked by the handlers against the calling client in Stage 4.

## Verification

* Unit: all tests pass except the 2 pre-existing Windows-only Flatpak tests.
* Lint: no errors (6 pre-existing warnings in upstream code).
* Native (Windows 11, Thunderbird 153.5.0esr): all 24 native tests pass,
  including `core-modules.native.cjs` (modules serve requests; a changed
  module is used after disable/enable).
* Native parity: 64 calls / 40 tools identical to upstream v0.9.2.
