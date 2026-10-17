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
* `scripts/build.sh` now calls the same Node build (one package format).

### Commit ↔ package ↔ hash

| Check | Command |
|---|---|
| package matches this checkout | `node scripts/build-xpi.cjs --verify` (CI job `version-sync`) |
| package of a commit is reproducible from that commit | `node scripts/build-xpi.cjs --from <commit>` – rebuilds from the commit's git objects and compares with its committed XPI and `SHA256SUMS` |
| installed add-on | options page: version and source digest; `sha256sum` of the XPI against `SHA256SUMS` |

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
| Positive and negative permission tests per tool | `test/policy.test.cjs` (every tool allowed with exactly its required capabilities, refused without any single one), native refusal of all 40 tools for a client without rights | – |
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

* Tested dynamically: Windows 11, Thunderbird 153.5.0esr (portable,
  isolated profile), Node.js 22.23.2; local mbox accounts, Local Folders,
  a storage calendar, a local SMTP sink.
* Not tested natively: Thunderbird 140 ESR (the manifest still allows
  140 – owner decision 3 of Stage 0), Linux and macOS (unit tests and CI
  run there; the discovery and path rules for Snap/Flatpak/macOS are
  unit-tested only), IMAP, POP3 servers, EWS and CalDAV providers (their
  code paths follow Thunderbird's interfaces but were not exercised
  against real servers), IMAP Drafts confirmation (may report `unknown`).
* Owner decisions still open (nothing has been published): public name
  and repository, a signed update channel, Thunderbird 140 support.
