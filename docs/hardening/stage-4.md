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

## Review round 2 – fixes

All points verified against comm-central source before fixing.

* `applyFilters` evaluated the delete model of the filter list's account;
  the rule deletes through the target folder's own server. Now
  `filterDeleteIsPermanent(folder.server, folder)` (Opus, Sol).
* IMAP move-to-Trash without a Trash-*flagged* folder deletes permanently
  (`nsImapMailFolder::DeleteMessages`: `GetFolderWithFlags(Trash)`, else
  `deleteImmediatelyNoTrash`). Filters and `deleteMessages` now require
  `mail.deletePermanent` then; a folder found only by name does not count
  (Opus, Sol). Full-access clients keep upstream behaviour.
* Inline forwarding (`mail.forward_message_mode != 0`, Thunderbird's default
  2) runs through libmime, which lets the original's `X-Identity-Key` pick
  any identity (`mimedrft.cpp`). Forward rules in inline mode are allowed
  only while every identity belongs to an account the client may use;
  forwarding as attachment uses the account's default identity (Sol).
* Incoming rules also run for POP accounts that defer delivery into the
  account and then send with *their* server (`nsParseMailbox.cpp`). Forward
  and Reply rules require those accounts to be accessible (and to have an
  identity for Forward) (Sol).
* Review compose windows: Thunderbird may choose another identity than
  requested (`X-Identity-Key`, `X-Account-Key`, reply to own message). The
  window's actual identity must belong to an accessible account; otherwise
  it is closed before any customisation and the call fails (Sol). The
  reply-draft save already checked the actual identity's Drafts folder.
* Native: identity override (review forward closed, positive control
  opens with `id1`), inline Forward rule refused; the new tests fail on
  b67de11.
* Not natively testable here (no IMAP/POP server in the harness): the IMAP
  delete-model and deferred-POP paths are covered by unit tests only.

## Review round 3 – fixes

* Chained POP deferral (Sol): `Pop3IncomingServer.rootMsgFolder` resolves
  deferral recursively. Sending rules now check every POP account whose
  resolved delivery root is this account's root; unreadable state counts as
  deferring.
* Sent copies (Sol): direct sends (`sendMail`/`replyToMessage`/
  `forwardMessage` with `skipReview`) and sending filter rules file a copy
  into the identity's Sent folder (`fccFolderURI`; `fccFolder` is null in
  TB 153), which may belong to another account. Its owning account must be
  accessible; otherwise nothing is sent. An enabled copy without a folder
  counts as not allowed.
* Identity-less accounts (Sol): Forward rules on Local Folders use
  Thunderbird's fallback (default account's default identity,
  `nsMsgComposeService::GetDefaultIdentity`) and are allowed when that
  account is accessible – full-access clients keep upstream behaviour.
* Exchange and unknown server types (Opus): only local folders, POP3,
  feeds and IMAP move-to-Trash with a Trash-flagged folder count as moving
  to Trash. Anything else (EWS/Graph "delete immediately", unknown types)
  needs `mail.deletePermanent` in `deleteMessages` and Delete rules.
  Full-access clients keep upstream behaviour.
* Native: Local Folders Forward with full access allowed; direct send with
  Sent copy into an excluded account refused (no SMTP, no copy). Both fail
  on 665c33a. Exchange and deferred POP remain unit-tested only.
* `test/native/live-sandbox.cjs`: visible portable Thunderbird with the
  synthetic profile, SMTP sink and two paired clients for manual tests.

## Review round 4 – fixes

* Sent copies and drafts follow Thunderbird's folder resolution
  (`nsMsgIdentity::getOrCreateFolderAsync`): the configured folder if it
  exists, otherwise the first usable of the configured server, the
  identity's servers (through POP deferral) and Local Folders. Since the
  winner cannot be predicted without side effects, every fallback candidate
  must be accessible. An empty setting (new Exchange accounts) goes through
  the same candidates, so full-access clients send as upstream (Opus).
* Inline Forward rules check the Sent copies of every identity, since
  `X-Identity-Key` may pick any (Sol, Opus).
* Post-outgoing filters (Sol): after a direct send Thunderbird runs the
  Post-outgoing filters of the Sent copy's account
  (`MessageSend._filterSentMessage`). Their actions, targets, sender
  accounts and conditions must stay within the client's rights; otherwise
  nothing is sent.
* Autosave (Sol): `MsgComposeCommands.js` autosaves modified review windows
  into Drafts without a user decision. Review windows whose identity would
  autosave into a restricted account are closed before customisation
  (only while `mail.compose.autosave` is on).
* Native: Post-outgoing copy into an excluded account refused (positive
  control copies), autosave into restricted Drafts refused, missing Sent
  folder with Local Folders fallback refused for a client without Local
  Folders. All three fail on 061327d.

## Review round 5 – fixes

* Post-outgoing filters of filter-triggered sends (Opus, Sol): Forward and
  Reply actions send through `MessageSend`, which also runs the
  Post-outgoing filters of the copy's account. Sending rules now check
  them for every identity that can send; nested Post-outgoing filters that
  send again are refused (no recursion).
* Replies filed next to the original (Opus, Sol): with
  `fccReplyFollowsParent` Thunderbird files a reply in the original's
  folder (`MimeMessageUtils.getFcc`); direct replies and Reply rules also
  check that folder's Post-outgoing filters.
* Address collection (Sol): every send passes its recipients to
  `AddressCollector.collectSingleAddress`, which creates contacts while
  `mail.collect_email_address_outgoing` is on and names existing unnamed
  contacts. Clients without `contacts.write` and address-book access may
  only send when collection changes nothing; Reply rules (unknown future
  recipients) need both. Full-access clients are unaffected.
* Native: filter-triggered Post-outgoing copy and contact collection
  refused (positive controls pass); both fail on 23a9d3a. The Stage 2
  native profile now allows address books, as its Reply rule collects.

## Review round 6 – fixes

Both reviewers reported the same three points:

* Inline Forward rules: every selectable identity (`X-Identity-Key`) is a
  possible sender, so their Sent copies, Post-outgoing filters and
  automatic Cc/Bcc are all checked, not only the default identity's.
* Post-outgoing chains: a direct send now also checks the Post-outgoing
  filters reached by sends that its own Post-outgoing filters trigger
  (nesting is passed through; a third level that sends again is refused).
* Address collection for rules: Forward targets are parsed like
  Thunderbird does (`Name <addr>`, lists), the sending identities'
  automatic Cc/Bcc are included, and unknown Reply recipients are refused
  without `contacts.write` + address-book access even with collection off
  (existing unnamed contacts are still named).
* Native: all three scenarios refused (positive control reaches the
  chain); all fail on 63befea.

## Review round 7 – fixes

* Post-outgoing traversal (Opus, Sol): the round-6 blanket refusal of
  Post-outgoing filters that send again blocked every direct send from an
  account with one ordinary Post-outgoing Forward rule – also for
  full-access clients. Sends triggered by Post-outgoing filters are now
  followed transitively with a set of already checked filters (each filter
  checked once, terminates); only effects beyond the client's rights are
  refused. Native: one Post-outgoing Forward rule no longer blocks a
  full-access send or rule; the restricted chain test still refuses.
* External invitations (Sol): an event whose only attendee is the calendar
  user but whose organizer is someone else is an invitation; changing or
  deleting it can send a reply to the organizer (RFC 6638 server-side
  scheduling). It now needs `calendar.schedule`. The Block `skipReview`
  semantics are unchanged (upstream behaviour).
* Note: one full native run (all files in parallel) failed 3 subtests of the
  send-chain block once; the file alone and two further full runs passed.
  Treated as load-related flakiness of the timing-based chain test.

## Review round 8 – fixes

Opus: no substantive findings. Sol:

* Address-book filter conditions (`isInAB`/`isntInAB`) reveal contact
  membership through the rule's effect; they now need `contacts.read` in
  addition to address-book access (create, update, `applyFilters`,
  Post-outgoing checks).
* The Post-outgoing check keeps the actual folder of each possible copy
  target (configured Sent folder if it exists, reply-parent folder with
  `fccReplyFollowsParent`), so a Delete rule on a reply copy filed in Trash
  is recognised as permanent. The folder is part of the visited key.
* Native: both refused for restricted clients, allowed for full access;
  both fail on 562726c.

## Review round 9 – fixes

Opus: no substantive findings. Sol:

* Rule order is part of the effect: Stop, Move and Delete rules keep later
  rules from acting. Reordering rules when a flow-controlling rule is in
  the moved range, deleting a flow-controlling rule, or changing (also
  disabling) one now requires that the client may run every enabled rule
  whose reach can grow (same checks as `applyFilters`: actions,
  capabilities, sender accounts, destinations, conditions). Full-access
  clients are unaffected.
* Native: reorder/delete of a Stop rule in front of a Forward rule refused
  for a client without `filters.autosend`, allowed with full access. The
  actual delivery path (POP) is not available in the harness; covered by
  unit tests and the reviewer's native reproduction.

## Review round 10 – fixes

Both reviewers: limiting the round-9 check to Stop/Move/Delete was not
enough, and it blocked full-access clients:

* Rules run in order on the same message and earlier rules change what
  later rules see (tags, priority, flags change what conditions match;
  Stop/Move/Delete end processing). Now every list change other than
  appending a rule – inserting (`insertAtIndex`), reordering, deleting,
  and effect-changing updates (enabled, type, conditions, actions) –
  requires that the client may run every affected rule.
* POP accounts that deliver into another account also feed its incoming
  rules with every message their own rules did not move
  (`nsParseNewMailState::ApplyFilters`); changes to such a list also
  require the deferred-to account's incoming rules to be runnable.
* Clients holding all capabilities with unrestricted account and
  address-book scope are exempt (upstream behaviour, e.g. maintaining a
  list next to a custom-action or stale rule).
* Native: inserting a priority rule before a Forward rule refused for a
  client without `filters.autosend`.

## Review round 11 – fix

Both reviewers: `reorderFilters` checked only the moved range, but a new
order changes what every later rule sees (e.g. two priority rules swapped
before a "priority is highest → Forward" rule). The check now runs from
the lower position to the end of the list; regression test with the
Forward rule after the moved range.
* `npm run test:native` now runs the native files one after another
  (`--test-concurrency=1`): parallel Thunderbird instances made the
  timing-based chain tests flaky under load (observed twice; isolated and
  repeated runs passed).

## Review round 12 – fixes

* Periodic rules (Opus): `PeriodicFilterManager` runs all enabled Periodic
  rules over the Inbox every few minutes, so any changed state reaches
  them regardless of position. List changes (also appends) and
  `updateMessage` state changes (read, flag, tags) or moves/copies into an
  account require that the client may run every enabled Periodic rule of
  that account (and of the account a POP server delivers into). Clients
  with full rights are exempt.
* Address collection without read access (Sol): the check no longer looks
  up contacts when the client may not read address books; it refuses
  whenever collection could change anything (collection on, a recipient
  name, an unknown reply recipient), so responses do not reveal contact
  membership.
* Repository: test leftovers committed by mistake in 348e807 removed;
  `tb-mcp-*/` ignored.

## Review round 13 – fixes

* Opus: rules that copy or move into another account's Inbox, and rules
  run with `applyFilters`, produce the same effects that `updateMessage`
  now checks against Periodic rules. `createFilter`/`updateFilter` and
  `applyFilters` check the Periodic rules of the account a rule runs in
  and of every Move/Copy target (`rulePeriodicRestriction`; skipped rules
  report `periodic-filter`). Full-access clients are exempt.
* Sol: (1) direct replies/forwards mark the original as replied/forwarded,
  which periodic rules of its Inbox can react to; checked before sending.
  (2) Move/Copy targets are followed transitively through the target's
  periodic rules (each server once). (3) Only Inbox-flagged folders count
  (PeriodicFilterManager processes `getFoldersWithFlags(Inbox)`), so
  changes in Archive or project folders are not affected. (4) Switching
  off or deleting a periodic rule does not require that rule's own rights.
* Native: Inbox flag change and direct reply refused, Archive change and
  disabling the periodic rule allowed for a client without
  `filters.autosend`.

## Review round 14 – fixes

* Sent copies filed into an Inbox (identity's Sent folder set to an Inbox,
  reply next to the original) and Move/Copy targets of Post-outgoing rules
  are checked against that Inbox's periodic rules (Opus, Sol).
* Stored rules affected by list edits follow their Move/Copy targets'
  periodic rules transitively (Sol). The mutually recursive checks share a
  visited set and are bounded by a depth limit (fails closed).
* `displayMessage` marks unread messages read (`mark_message_read.auto`);
  it is refused when periodic rules of the Inbox the client may not run
  would react (Opus, Sol).
* Post-outgoing checks are skipped for clients with full rights, so a
  custom Post-outgoing action no longer blocks their direct sends (Sol).
* Native: display of an unread Inbox message and a send whose copy lands
  in the Inbox refused for a client without `filters.autosend`.

## Review round 15 – fixes

* Filter conditions (Sol): a rule's effect reveals whether its conditions
  matched, so conditions need the read rights for what they inspect:
  `mail.metadata` for any condition (not "match all"), `mail.body` for
  body conditions. Applies to create/update, `applyFilters` and the
  implicit checks of periodic, Post-outgoing and reachable rules.
* Drafts in an Inbox (Opus): a Drafts folder set to the Inbox is processed
  by periodic rules; `saveDraft`, reply drafts and review-window autosave
  check that Inbox's periodic rules.
* Native: body-probe rule refused without `mail.body`; draft into a
  Drafts-flagged Inbox refused for a drafts-only client.

## Review round 16 – fixes

* Unknown condition attributes (add-on custom conditions such as body
  regexes) need `mail.body` in addition to `mail.metadata` (Opus, Sol).
* Autosave of review windows (Sol): without `compose.draft`, or when the
  autosaved draft would land outside the client's rights (restricted
  account, Inbox with periodic rules), autosave is switched off for that
  window (`gAutoSaveInterval`/`gAutoSaveTimeout` of MsgComposeCommands.js)
  instead of closing it; the user can still save or send. Full-access
  clients keep Thunderbird's autosave.
* Replacing a periodic rule (Sol): the stored rule is excluded from the
  periodic check of its replacement, so a permitted new content is not
  refused because of the old one.
* Native: autosave off for a restricted target and without
  `compose.draft`, on for full access.
* One sequential native run failed one subtest of the Trash/periodic block
  once; the block alone and two further full runs passed (59/59). Kept as an
  observed timing flake.

## Review round 17 – fix

Sol: no substantive findings. Opus: the round-16 rule for unknown
condition attributes also caught header-only conditions (custom headers
such as `List-Id`, copy-only attributes, header properties). These now
count as known metadata attributes; add-on custom conditions and unmapped
values still need `mail.body`. Regression test for a metadata-only client
with a custom-header rule.