# Hardened fork: Stage 6 – release hardening and acceptance

Scope: a reproducible package with an unambiguous mapping to its source
commit and hash, controlled updates, documented migration, and the final
native feature and security regression.

## Reproducible package

* `scripts/build-xpi.cjs` builds `dist/thunderbird-mcp.xpi` whose bytes
  depend only on the source contents:
  * text files are packed with LF line endings (as git stores them), so a
    Windows checkout (CRLF) and a Linux checkout build the same bytes –
    verified: the build from the Windows working tree and the build from
    the git objects of the same commit are identical;
  * entries are sorted, timestamps fixed (1980-01-01), no extra fields;
  * entries are stored uncompressed (≈ 1.1 MB): deflate output is not
    guaranteed to be identical across zlib versions or CPUs;
  * `buildinfo.json` holds only the package version and `sourceDigest`
    (SHA-256 over the packaged file names and contents); no build time,
    git state or machine data. The options page shows both.
* The build no longer modifies `extension/`: a `manifest.json` version
  that is not the numeric form of the `package.json` version
  (`X.Y.Z-hardened.N` → `X.Y.Z.N`) fails the build instead of being
  rewritten.
* `dist/SHA256SUMS` holds the package hash. Both are committed together
  with the sources they were built from (`.gitattributes` keeps them out of
  line-ending conversion).
* In a git checkout the working-tree build packs exactly the tracked files
  under `extension/` (the same set a build from the commit uses) and
  refuses untracked ones; outside git, editor/OS debris (`.DS_Store`,
  swap files, …) is skipped.
* `scripts/build.sh` now calls the same Node build (one package format).

### Commit ↔ package ↔ hash

| Check | Command |
|---|---|
| package matches this checkout | `node scripts/build-xpi.cjs --verify` (CI job `version-sync`) |
| package of a commit is reproducible from that commit | `node scripts/build-xpi.cjs --from <commit>` – rebuilds from the commit's git objects and compares with its committed XPI and `SHA256SUMS` |
| an XPI file to be installed (e.g. downloaded) | `node scripts/build-xpi.cjs --from <commit> --check <file>` – compares the file with the rebuild of that commit (or `sha256sum` against that commit's `SHA256SUMS`) |
| installed add-on | options page: version and source digest |

The previous CI job `version-sync` compared `package.json` and
`manifest.json` literally and would always have failed on the fork's
version scheme; it now runs `--verify`.

## Updates and rollback

Unchanged from Stage 0 and deliberately so: `update_url` points at the
reserved `https://update-channel-disabled.invalid/updates.json`, so
Thunderbird never updates the fork automatically and never falls back to
addons.thunderbird.net; `build-and-release.yml` only runs in the upstream
repository. New versions are installed by hand from a verified XPI; the
previous XPI is the rollback target (a downgrade to upstream is not a safe
rollback). A signed update channel remains an owner decision.

## Migration

All behaviour changes and the user actions they need are collected in
[migration.md](migration.md) (Stages 0–5). The most visible ones: settings
are not inherited from upstream; every MCP client must be paired in the
options page (Stage 4); clients paired before Stage 5 lack `filters.foreign`
(needed to change or retarget rules not created through MCP); message
references and `operationState` are additive.

## Final regression (Windows 11, Thunderbird 153.5.0esr, Node.js 22.23.2)

| Run | Result |
|---|---|
| `node --test test/*.cjs` | all pass except the two Windows-only Flatpak path tests of `mcp-bridge.test.cjs` (pre-existing, Stage 0) |
| `npm run lint` | no errors (6 pre-existing upstream warnings) |
| `npm run test:native` (portable Thunderbird, synthetic profile, SMTP sink, HTTP probe) | all pass, including `stage6-package.native.cjs`: the committed XPI itself is installed (loaded from `jar:`), serves all 40 tools and reports its source digest; a client without rights sees no tool and is refused for all 40 with schema-valid arguments |
| `node test/native/run-parity.cjs` vs. `test/baseline/native-parity-v0.9.2.json` | 64 calls / 40 tools, outcomes and result shapes identical to upstream v0.9.2; 4 SMTP deliveries each; `operationState` added to 19 results (documented additive key) |
| `node scripts/build-xpi.cjs --verify` | the committed XPI is the reproducible build |

Negative controls were run per stage (documented in stage-2.md to
stage-5.md): the security tests fail against the build before the
respective fix.

## Acceptance criteria (spec section 11)

| Criterion | Evidence | Open |
|---|---|---|
| All 40 tools work with the intended grants | native parity (full-access client), stage-4/5 native tests | – |
| Tool names, schemas and result shapes compared with the baseline | `test/baseline/`, native parity, tool-contract tests | – |
| Positive and negative permission tests per tool | `test/policy.test.cjs`: an independently written expectation per tool (base capabilities, 40 entries) – the policy must require exactly these, allow the tool with them and refuse it without any single one or with all other capabilities; argument-dependent effects in separate cases; a mutated mapping fails the test. Native: a client without rights sees no tool and is refused for all 40 with schema-valid arguments | – |
| Both transports enforce the same policy | the stdio bridge only forwards to the HTTP handler, which authenticates and decides every call; the bridge marks inlined local files (`files.attach`) – stage-4.md | – |
| New tools, new effective arguments and broken settings grant nothing | policy classifies every tool and input property, unknown ones need `unclassified` (never granted); corrupt registries/registers fail closed – stage-3/4/5 | – |
| Manipulated attachments cause no foreign HTTP/file/UNC access | stage-2.md A (native, negative control) | IMAP/EWS part URLs not tested natively |
| Export, inline images, direct and review forward covered | stage-2.md A | – |
| Type, account and target limits for calendar, drafts, filters, sending | stage-2/4/5 | – |
| Running and lasting effects on revocation handled traceably | stage-4 (next request; waiting calls refused), stage-5 filter register and revocation report | user-made exact copies of MCP rules (5b) |
| Windows file permissions and native provider paths checked in practice | stage-0 spike 4 (`icacls`), native suites | permissions inherit the user's temp ACL (no explicit DACL) |
| Timeouts cause no double sending | stage-5c native: connection reset after the message → `unknown`, no resend | – |
| Package, commit, update information and migration traceable | this document, migration.md | – |

## Tested combinations and open points

* Tested dynamically: Windows 11, Thunderbird 153.5.0esr, 158.0 and 159.0
  (isolated profile), Node.js 22.23.2; local mbox accounts,
  Local Folders, a storage calendar, a local SMTP sink. The manifest
  accepts 140–159.*; 140 and 154–157 are not tested.
* Not tested natively: Thunderbird 140 ESR (the manifest still allows
  140 – owner decision 3 of Stage 0), Linux and macOS (unit tests and CI
  run there; the discovery and path rules for Snap/Flatpak/macOS are
  unit-tested only), IMAP, POP3 servers, EWS and CalDAV providers (their
  code paths follow Thunderbird's interfaces but were not exercised
  against real servers), IMAP Drafts confirmation (may report `unknown`).
* Owner decisions still open (nothing has been published): public name
  and repository, a signed update channel, Thunderbird 140 support.

## Thunderbird 158

`strict_max_version` was `153.*`, so Thunderbird 158 refused to load the
add-on (control run: the server never started). With `158.*` and the
official Thunderbird 158.0 (win64, signed by Mozilla, extracted
portably), all 77 native tests pass and native parity with upstream
v0.9.2 shows no differences (64 calls, 40 tools, 4 SMTP deliveries;
`operationState` as additive key). The same runs on 153.5.0esr remain
green. The native harness now sends `Connection: close`: an idle
keep-alive socket hitting the server restart during the add-on reload
test made Node's HTTP client fail once (test process only; the add-on
was not involved).

## Thunderbird 159

With `strict_max_version` `158.*`, Thunderbird 159.0 marked the add-on
`appDisabled` and the server never started. With `159.*` and the
installed official Thunderbird 159.0 (win64, isolated test profile), all
81 native tests pass and native parity with upstream v0.9.2 shows no
differences (64 calls, 40 tools, 4 SMTP deliveries; `operationState` as
additive key). Thunderbird 159 grants Marionette chrome access only when
`MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` is set (the `-remote-allow-system-access`
flag alone is no longer enough), so the native harness sets it; without
it every native suite fails in its setup hook. 153.5.0esr and 158.0 were
not re-run for this change.
## Diagnostic log (added after acceptance)

* Optional, off by default (`extensions.thunderbird-mcp-hardened.diagnosticLog`,
  switch in the options page, which also shows the last 200 entries and
  deletes the log). File: `<profile>/thunderbird-mcp-hardened/diagnostic.log`,
  owner-only, rotated at 1 MiB to `diagnostic.log.1`; the directory is
  refused as an attachment source like every `thunderbird-mcp-hardened`
  directory.
* Entries (`core/diagnostic-log.sys.mjs`) contain only constants and
  numbers: time, event (`server`, `request`, `tool`, `error`), a known
  tool name (otherwise `<unknown>`), the client's log ID (first 8 hex
  digits of its random registry ID, shown in the options page client
  list – never the user-chosen name), outcome, `operationState`, MCP
  method, duration, HTTP status, missing capabilities of a refusal, and for
  failures an error category, the JavaScript error class and the XPCOM
  result name (looked up in `Components.results`). Every enumerated field
  is checked against a fixed list.
* Error texts are never written. The category is the longest entry of
  `ERROR_CATEGORIES` the text starts with, otherwise `<unclassified>`.
  `ERROR_CATEGORIES` is generated by `scripts/diagnostic-categories.cjs`
  from the static start of every error literal in api.js (up to the first
  interpolation, quote, colon, parenthesis or escape), so a category never
  contains a runtime value; a unit test fails when it is out of date. Only
  the first 512 characters are examined, by prefix comparison (linear).
* Tests: `test/diagnostic-log.test.cjs` (catalog in sync and static, real
  error texts of the tools reduced to their category, bounded linear
  matching for 128 000-character inputs, field allowlists, error class and
  result name, results without content); native
  `test/native/diagnostic-log.native.cjs` on Thunderbird 158.0 and
  153.5.0esr – successful, failing and refused calls, a missing folder with
  a confidential name, an attachment path with spaces, an unknown 64-digit
  tool name and a direct send are logged without the synthetic addresses,
  names, paths, subjects, bodies, Message-IDs, host, client names or
  tokens; a 403 is logged without the presented token; with the default
  setting no file exists; the options page switches it on, shows and
  deletes it.

### Review round 1 (Sol, Opus)

| Finding | Fix |
|---|---|
| Paths with spaces, relative paths, bare file names and `data:` strings in `Attachments refused` survived redaction (Opus, Sol) | error texts are no longer written; fixed categories from a generated catalog |
| Unquoted calendar, filter, folder and attachment names, display names and SMTP host survived redaction (Opus, Sol) | same |
| The address pattern scanned long inputs in quadratic time before truncation; a paired client could stall Thunderbird with a 128 000-character argument name (Sol) | at most 512 characters are examined, only by prefix comparison; regression test with 128 000 characters |
| `tool` accepted any safe-looking string (a 64-digit token as unknown tool name was logged), `client` copied the user-chosen name (Sol) | only known tool names; opaque client log ID; outcome, operation state and method checked against fixed lists |

Review round 2 (`d5a0926`): both reviewers without findings.
## Final review round 1 (Sol, Opus)

| Finding | Fix |
|---|---|
| The Linux-only packaging test still expected `builtAt` (CI on Ubuntu would fail) (Sol) | asserts the new metadata contract (only `version` and `sourceDigest`); new case: debris outside git is skipped |
| README said `--from` checks a downloaded XPI; it only checks the committed one (Sol, Opus) | `--check <file>` compares a given XPI with the rebuild; README and this document corrected |
| The per-tool matrix derived its expectations from the policy under test (Sol) | independent expectation per tool; a mutation (`createFolder` requiring `accounts.read`) now fails the test |
| Working-tree builds packed untracked and git-ignored files (editor/OS debris) (Opus) | tracked files only in a git checkout, untracked ones refuse the build; debris filter outside git |

## Result

Final review round 2: both reviewers without findings. At HEAD the
committed XPI (SHA-256 `a5ebf796555df8884a9e2da2dfabedb2bed545ac2c0684101643bad54b550847`,
source digest `56ca5ed236b4c44e3e97793b49d3544633a74823c4b5b3900165af7279327191`)
is reproducible from its commit (`--from HEAD --check dist/thunderbird-mcp.xpi`).