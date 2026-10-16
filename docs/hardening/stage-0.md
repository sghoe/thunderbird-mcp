# Hardened fork: Stage 0 – inventory, plan and fork identity

Status: implemented and natively verified on Windows 11, Thunderbird
153.5.0esr (portable, isolated profile), Node.js 22.23.

## 1. Inventory (starting point)

| Item | Finding |
|---|---|
| Upstream | `TKasperczyk/thunderbird-mcp`, tag `v0.9.2`, commit `1ab1018` |
| Working tree at start | identical to `upstream/main` (fetched 2026-10-16); no newer upstream fixes to reconcile |
| Tools | 40, verified via native `tools/list` |
| Core | `extension/mcp_server/api.js` (~12,100 lines: transport, auth, policy, all tools), `mcp-bridge.cjs` (stdio bridge, discovery, path attachments) |
| Tests | 185 suites / 2146 tests (`node --test test/*.cjs`); most load marker-delimited **source snippets** of `api.js` into `vm` sandboxes with mocked XPCOM, i.e. they test copies of production code, not modules |
| Baseline result | 2129 pass, 15 skipped, **2 fail** – both pre-existing Flatpak path tests that fail only on Windows (`mcp-bridge.test.cjs`: "reattaches exports from flatpak-cache", "refuses symlinks into and out of an export directory") |
| Native tests | none in the repo; CI only checks that the XPI installs (`tb-compat-test.yml`) |

### Findings A–D (static analysis) re-checked at this commit

All four reference locations still match the analysed code:

* **A** `getMessage`/`getMessages` export fetches `att.url` with
  `NetUtil.newChannel({ loadUsingSystemPrincipal: true })`; inline images may
  fall back to it; the direct forward passes `att.url` to `nsIMsgSend`.
* **B** `reply` filter actions store `strValue` as free text; only Move/Copy
  targets go through `checkTargetFolder`.
* **C** `updateTask` uses `calendar.getItem(id)` without checking the item
  type and without the attendee guard (`updateEvent`/`deleteEvent` also lack a
  type check).
* **D** `saveDraft` checks the identity's Drafts folder only when replacing a
  draft.

### Finding A – dynamic evidence on the unmodified v0.9.2 code

`test/native/spike-external-attachments.cjs` (synthetic messages with
`X-Mozilla-External-Attachment-URL`, local HTTP probe, local "secret" file):

| Path | Observed |
|---|---|
| `getMessage(saveAttachments)` with `http://127.0.0.1:<probe>/ext-http` | privileged GET `/ext-http?part=1.2`; remote bytes written to the export directory |
| same with `file:///…/secret.txt` | the local file was read (20 bytes); the export was discarded only by the size-mismatch heuristic |
| `includeInlineImages` with external URL | no external request (constructed message-part URL used); `att.url` remains a fallback |
| `forwardMessage(skipReview)` (blockSkipReview off) | remote HTTP content **and the local secret file** were attached and delivered to the SMTP sink |
| native review forward (`skipReview: false`) | no external request on opening; the compose window attached only the local detach notice (temp file `nsmail.pdf`) |

## 2. Implementation plan

| Stage | Content | Verification |
|---|---|---|
| 0 | Fork identity, spikes (this document) | unit + native spikes |
| 1 | Feature/contract matrix for 40 tools, native harness, baseline snapshot | snapshot test, native smoke |
| 2 | Fix A (all paths), B, C, D; check Message-ID duplicates, UNC | unit + native regressions |
| 3 | Extract pure modules (contracts, policy) with mechanical import rule; versioned module loading | lint rule, module tests, native reload |
| 4 | Per-client credentials, positive capabilities, migration | unit + native |
| 5 | Unified attachment pipeline, references, filter register, operation states | unit + native |
| 6 | Reproducible package, hashes, final parity/security regression | native |

Each stage is reviewed by two independent reviewers (GPT "Sol 6.1" and
Claude Opus 5.5) until no verified finding remains.

## 3. Decisions

| Topic | Decision | Reason |
|---|---|---|
| Add-on ID | `{97229bb5-ab92-4724-adf0-85fbea3bf56e}` | random GUID; no invented domain or e-mail |
| Update channel | `update_url` = `https://update-channel-disabled.invalid/updates.json` | `.invalid` is reserved (RFC 2606/6761) and never resolves. Leaving `update_url` empty would make Thunderbird ask addons.thunderbird.net, where anyone could register this public GUID. No silent switch back to upstream is possible because the ID differs |
| Releases | `build-and-release.yml` runs only in `TKasperczyk/thunderbird-mcp` | no automatic public releases or update manifests from the fork |
| Preferences | `extensions.thunderbird-mcp-hardened.*` | upstream settings (including permissive defaults and stable tokens) are never inherited silently; Stage 4 defines an explicit migration |
| Resource alias | `resource://thunderbird-mcp-hardened/`, **without** `ALLOW_CONTENT_ACCESS` | only privileged code loads it; natively verified: `allowContentToAccess` is false for the fork, true for upstream |
| Process globals | `globalThis.__tbMcpHardened*` | no shared state with upstream |
| Runtime directory | `<TmpD>/thunderbird-mcp-hardened/` (`connection.json`, `outgoing/`) | fully refused as an attachment source |
| Export directory | `<TmpD>/thunderbird-mcp-hardened-exports/<message>/<file>` | exports and tokens are in separate directories |
| Port range | 8775–8784 (upstream: 8765–8774) plus a probe before binding | see spike 3 |
| Versions | manifest `0.9.2.N`, package `0.9.2-hardened.N` (upstream base + fork build) | unambiguous mapping to the upstream base |
| Thunderbird | `strict_min_version` 140.0, `strict_max_version` 153.*; tested: 153.5.0esr on Windows | only claim tested versions; 140 ESR is upstream-verified, not yet by this fork |
| Node.js | `>=18` unchanged; tested: 22.23 | |
| Coexistence | technically possible (separate ID/prefs/alias/dirs/ports, verified natively), **but not recommended**: uninstall upstream so its unhardened surface and token are gone | |
| Rollback | keep the previous fork XPI; uninstalling the fork leaves upstream prefs untouched; a downgrade to vulnerable upstream versions is not a supported "safe rollback" | |
| Installation | install `dist/*.xpi` via *Add-ons → Install from File* (or `scripts/install.sh`); restart | |

## 4. Spikes (native, `test/native/spike-stage0.cjs`)

1. **Runtime identity:** discovery file `…\thunderbird-mcp-hardened\connection.json`,
   port 8775, export `…\thunderbird-mcp-hardened-exports\plain_attach_allowed_test\notes.txt`.
2. **Content access:** fork alias blocked for web content; upstream alias loadable.
3. **Coexistence / port sharing:** with upstream v0.9.2 installed alongside an
   earlier fork build, *both* bound `127.0.0.1:8765` (Gecko server sockets
   allow address reuse; Windows then lets a same-user listener share the
   port) and requests reached only one of them. After the fix: fork on 8775,
   upstream on 8765, both serve 40 tools, upstream's token is rejected by the
   fork (HTTP 403). Residual: two fork instances starting at the same instant
   can still race; the probe covers the normal case.
4. **Windows ACLs (`icacls`)** of the runtime directory, `connection.json` and
   an export file: `SYSTEM`, `BUILTIN\Administrators`, the current user –
   inherited from `%LOCALAPPDATA%\Temp`, no `Users`/`Everyone` entries. The
   effective protection therefore depends on the user profile's default
   DACL; nothing is created with an explicit DACL. Same-user processes can
   always read these files (accepted limit). Stage 4 removes the shared
   secret from the discovery file so its confidentiality matters less;
   integrity (no foreign writes) still relies on the user-private temp
   directory. No administrator rights are needed.
5. **ESM caching:** `ChromeUtils.importESModule` of an unchanged URL returned
   the stale module after the file changed; a versioned URL (`?v=2`) loaded
   the new one. Stage 3 must import split modules with a build-specific query.
6. **Add-on reload:** disabling and re-enabling the add-on re-evaluates
   `api.js` (manifest version change visible in `serverInfo`).

## 5. Open decisions for the owner

These need a human decision before any public release; nothing has been
published:

1. Public name and repository of the fork (`sghoe/thunderbird-mcp` is the
   current `origin`; no release has been created).
2. Whether a signed update channel should exist at all, and who controls it.
3. Whether Thunderbird 140 ESR must be supported (requires a native test run
   on 140).
