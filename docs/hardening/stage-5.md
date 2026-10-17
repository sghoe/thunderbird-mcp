# Hardened fork: Stage 5 – resource and action model

Scope: complete the resource and action model on top of Stage 4: unique
message references, a register of MCP-created filter rules with
revocation, honest operation states, and content-bound attachments. The
Stage 2 hotfixes stay in force throughout.

## 5a – Unique message references

* An RFC Message-ID stays the normal input. If several messages in the
  folder share it, the call is refused (as since Stage 2) and the error
  now lists `candidates`: one `msgref:<messageKey>:<token>:<Message-ID>` reference
  per message, with date and author (no subjects – they can be protected
  for encrypted messages). Up to 20 candidates.
* Every tool that takes a `messageId` accepts such a reference. It is
  resolved by key in the given folder and the Message-ID is checked again;
  a reference made stale by a move, deletion or compaction fails ("stale")
  instead of selecting another message. Malformed references are refused.
* Native: `test/native/stage5-model.native.cjs` – two messages with the
  same Message-ID; references read and flag exactly the chosen message;
  stale and malformed references refused.

## 5b – Filter register and revocation

* Thunderbird filter rules have no stable identity (index and name can
  change). Rules created or changed through MCP are recorded in a
  versioned register (`extensions.thunderbird-mcp-hardened.filterRegistry`,
  `core/filter-registry.sys.mjs`) with the client and a SHA-256
  fingerprint of their effect (type, conditions, actions; not the enabled
  state). A corrupt register counts as "nothing registered" and is never
  overwritten silently.
* Revoking a client (and "Remove all clients") disables its registered
  Forward/Reply rules that are still unchanged and enabled. Rules that no
  longer match their fingerprint (changed by the user, or their Move/Copy
  target folder was renamed, moved or deleted – Thunderbird rewrites the
  target in every rule), are missing or
  ambiguous are reported in the options page as conflicts for the user to
  decide; nothing is disabled by name or index. If Thunderbird cannot save
  the disabled rule (e.g. the rules file is locked on Windows), the rule
  stays disabled for the running session and is reported as a conflict. Rules without sending
  actions stay as they are.
* Identical rules (same fingerprint) cannot be told apart. MCP never
  creates a rule identical to one not created through MCP, and refuses
  changes to groups of identical rules that are not all registered for
  one client. Residual: if the user copies a rule created through MCP
  exactly in Thunderbird and then edits one of the two, the register may
  attribute the untouched one to the client.
* Rules not created or changed through MCP belong to the user: changing,
  reordering or deleting them needs the new capability `filters.foreign`
  (part of the `automation` profile; clients paired earlier with an
  explicit capability list do not get it automatically).
* Uninstalling the add-on leaves all rules – including registered sending
  rules – active in Thunderbird; the register is kept so a later
  reinstall can still revoke them. Revoke clients before uninstalling, or
  check Forward/Reply rules manually.
* Native: a rule-maker client creates two Forward rules, the user changes
  one in Thunderbird, revoking the client in the options page disables the
  unchanged rule and reports the changed one.

## 5c – Honest operation states

* `sendMail`, `replyToMessage`, `forwardMessage`, `saveDraft`,
  `createEvent`, `updateEvent`, `deleteEvent`, `createTask` and
  `updateTask` results carry an additive `operationState`
  (`core/operation-state.sys.mjs`); existing fields and messages stay.

  | State | Meaning |
  |---|---|
  | `opened-for-review` | compose window or calendar dialog opened; the user decides there |
  | `submitted` | the calendar provider accepted the change; its synchronisation and any invitations it generates are not observed |
  | `queued` | stored in the Outbox (not produced today: the add-on never queues) |
  | `completed` | the SMTP server confirmed the message, or the draft was stored |
  | `failed` | not performed; nothing was sent, saved or written |
  | `unknown` | may or may not have happened – check Sent/Drafts/the calendar before trying again |

* Direct sending: Thunderbird reports the start of the SMTP transaction
  (`onStartSending`). Errors before it, a server refusal (TB 153 reports
  every SMTP error reply and authentication failure as `NS_ERROR_FAILURE`;
  socket errors keep their own code – `SmtpClient.sys.mjs` `_onNsError`
  vs. `_onError`), a refused connection or an unknown host are `failed`.
  A reset, interruption, network timeout or abort after the start, the
  120 s timeout, or a rejected send promise after the start are `unknown`:
  the server may already have accepted the message. The error then says
  so. A failed Sent copy after a confirmed delivery does not change
  `completed` (TB calls `onStopSending` before filing the copy).
* Review: a compose window that timed out or could only be partly filled
  is `unknown`; one closed because of a foreign sender identity is
  `failed`. Calendar: an error from the provider call itself (e.g. a
  CalDAV timeout) is `unknown`, errors before it are `failed`.
* Nothing is retried automatically – neither before nor after this change.
  Protocol-level refusals (invalid arguments, missing capability) remain
  JSON-RPC errors without a result and never have an effect.
* Thunderbird still shows its own alert for a failed direct send
  (upstream behaviour).
* Native parity treats `operationState` as a documented additive key
  (`run-parity.cjs` `ADDITIVE_KEYS`): it may be added, never removed.
* Native: the SMTP sink confirms (→ `completed`), refuses the recipient
  with 550 (→ `failed`, nothing received) or receives the message and then
  resets the connection (→ `unknown`; the sink holds the message, no
  second delivery within 3 s). Review window, saved draft, refused
  forward, direct calendar write and calendar dialog are checked too.

## 5d – Content-bound path attachments

* Before: a path attachment was checked and then attached as a `file:`
  URL; Thunderbird read it only when sending – for a review window when
  the user clicked Send. Replacing the file (or a path component)
  afterwards changed what was sent. Natively demonstrated: with the copy
  disabled, a file replaced while the review window was open was sent
  with the new content.
* Now the file is read once, right after all path checks, into a private
  copy in `<TmpD>/thunderbird-mcp-hardened/outgoing/` (exclusive creation,
  0600; that directory is never an attachment source). The read must
  return exactly the checked size with nothing left over, and a fresh stat
  afterwards must show the same size and modification time; otherwise the
  attachment is refused ("the file changed while it was being attached").
  The review window and the sent message use the copy under the original
  file name.
* Copies (and decoded inline base64 attachments) are removed after a
  direct send or draft with outcome `completed` or `failed`. They stay
  until Thunderbird shuts down for review windows (the user may still
  send) and after `unknown` (Thunderbird may still read them). Disabling
  or updating the add-on keeps the files that open compose windows still
  attach (all of them if a window is still loading or its compose state
  cannot be inspected) and hands them to the next instance through the
  preferences `extensions.thunderbird-mcp-hardened.retainedAttachments.<n>` (bounded chunks)
  (the re-enabled add-on gets a fresh script scope); the next instance
  adopts only files of the private outgoing directory; files of open
  windows are checked again at its own add-on shutdown, files of
  running or `unknown` direct operations stay until application
  shutdown. Uninstalling while such a window is open, or after an
  `unknown` direct send, leaves those files in the private temp
  directory.
* Inline base64 attachments and files inlined by the bridge were already
  bound to their content (bytes travel in the request).
* Residual: between the path checks and the single read, a process of the
  same Windows user could swap a path component (e.g. to a junction). Such
  a process can read the file itself anyway; the checks protect against
  clients that only control the path string. On Windows the 0600 mode is
  not applied; the copy inherits the user's temp directory ACL (Stage 0,
  spike 4).
* Tests: `test/attachment-copy.test.cjs` (exact bytes, growth, shrinking,
  later modification, empty file, failed write, release only of tracked
  copies), `direct-send-outcome` (release per outcome); native:
  review window + replaced file → reviewed content sent; private copy
  removed after a completed direct send.

## Review round 1 (Sol, Opus)

| Finding | Fix |
|---|---|
| Register evicted the oldest entries at 1,000 – a client could push its Forward rule out and escape revocation (Sol, Opus) | entries are never evicted; creating a rule or changing its effect is refused **before saving** if it could not be registered (full or unreadable register); renaming and enabling/disabling stay possible |
| Entries matched only on account + fingerprint: copying a user rule made the user rule "registered" (bypassing `filters.foreign`); deleting/changing one of several identical rules dropped another client's entry (Sol, Opus) | one entry per MCP-made rule; identical rules count as MCP-made only while the register has at least one entry per live identical rule – a user's twin makes all of them foreign (fail closed); a removed or changed rule releases an entry only if more entries than remaining identical rules exist, the current client's first; revocation works per group of identical rules and reports a conflict if a group also belongs to another client or has more live rules than entries |
| Filter names over 500 characters made the whole register read as corrupt (Opus) | stored names are truncated; every write is validated before it is stored; "Remove all clients" reports and resets an unreadable register (deleting a single client does not) |
| Fingerprint ignored condition grouping (parentheses) (Sol) | `beginsGrouping`/`endsGrouping` are part of the fingerprint |
| `filters.foreign` made existing full-access clients "restricted" (Opus) | ownership rights (`OWNERSHIP_CAPABILITIES` in `core/policy.sys.mjs`) do not decide whether a client is unrestricted |
| Drafts reported `completed` when the copy into Drafts had only started (TB 153 `_mimeDoFcc` does not await the copy) (Sol, Opus) | `completed` only after `onStopCopy(0)`; a copy error is `unknown` (Thunderbird offers retry / save to Local Folders); without confirmation the timeout reports `unknown` |
| Direct reply with a `msgref:` reference wrote it into `References`/`In-Reply-To` (Sol) | headers come from the resolved message |
| Disabling the add-on deleted copies still attached by open review windows (Sol) | see 5d; native test disables/re-enables the add-on with an open review window and sends the original content |

Negative controls: without the `OWNERSHIP_CAPABILITIES` exclusion the
unrestricted test fails; without the retention the native reload test
finds no copy. The previous `onShutdown` also deleted decoded inline
attachments of open review windows on add-on disable (upstream
behaviour); they are now kept the same way.
## Review round 2 (Sol, Opus)

| Finding | Fix |
|---|---|
| Gecko refuses string preferences over 1 MiB; with long multibyte names the register write failed after the rule was saved, and the rule stayed unregistered (Sol, Opus) | names are truncated to 200 code points; the register's serialized UTF-8 size is limited to 512 KiB; the pre-check dry-runs the real change (with the real name); if recording still fails, a new rule or an effect change is taken back and the call fails |
| Revocation treated a group with fewer live identical rules than entries as complete; a changed member stayed enabled and unreported (Sol) | the unchanged members are disabled and the missing ones are reported |
| TB 153 ends a failed Drafts copy with `onStopCopy(0)` after "Don't Save" or a failed Local Folders fallback (`notifyListenerOnStopCopy` → `_doFcc2`), so status 0 is no proof (Sol, Opus) | both draft paths (direct `saveDraft`, compose-window `replyToMessage saveAsDraft`) report `completed` only once a message that was not in the intended folder before the copy (new message key; keys taken at the first `onGetDraftFolderURI` / before `SaveAsDraft`) appears there with the draft's Message-ID – or, when replacing a draft, the replaced one's (TB 153 gives a replaced local draft's new header the old Message-ID; native parity "saveDraft replace" caught this) – polling up to 5 s; otherwise `unknown`. Keys also exclude an earlier autosave with the same Message-ID. Natively confirmed for local Drafts; IMAP Drafts not natively tested (may report `unknown` if the server copy is not yet in the folder database) |
| A call waiting in `runAsClient` behind another client's call ran with the client record from before the wait; a client removed meanwhile could still create a rule under its old id (Opus) | after waiting, the stored client record must still be identical (not removed, rights or token unchanged), otherwise the call is refused without effect |
| Compose windows still loading were treated as having no attachments (Sol) | a loading window or a compose window without compose state makes all files kept; attachments are read from the bucket and from the compose fields |
| The hand-over through `globalThis` did not survive a re-enable (fresh script scope) (Sol) | hand-over through a preference; native test: review window open, add-on disabled and re-enabled, preference consumed, Thunderbird quit → file removed |

Negative controls: without adoption the native hand-over test fails
(file left behind); the unit tests cover the multibyte size limit,
partial groups, undo after a failed register write, the unconfirmed
draft and the refused waiting call.
## Review round 3 (Sol, Opus)

| Finding | Fix |
|---|---|
| Switching a disabled rule on does not change its fingerprint, so it skipped the register pre-check and the undo; with a full register a client could switch on a user's Forward rule that revocation never reaches (Sol, Opus) | switching a rule on counts as a change that must be recorded: pre-check before saving, undo if recording fails (renaming and disabling stay always possible) |
| Two concurrent saves replacing drafts with the same Message-ID could each find the other's new header (a failed one reporting `completed`) (Sol) | direct saves into Drafts/Outbox run one at a time (immediate sends are not queued), so the key snapshot of a save only sees its own copy. Residual: a save that timed out (`unknown`) may still finish while the next one runs; a draft the user re-saves by hand in the same moment is not distinguished |
| Add-on shutdown deleted files of running direct operations and of `unknown` outcomes (no compose window references them) (Sol) | such files are pinned from the start of the operation until a known outcome releases them; pinned files survive an add-on shutdown and are handed over like window files; adopted files stay pinned until application shutdown. The cleanup is a marked block with unit tests (`test/shutdown-cleanup.test.cjs`; negative control: without the pin check the test fails) |
## Review round 4 (Sol, Opus)

| Finding | Fix |
|---|---|
| A save that waited in the queue started without checking again; meanwhile the client could have been revoked or narrowed, or the identity's Drafts setting moved to an account the client may not use (Sol, Opus) | before a queued save starts, the client record must still be current and the identity's current Drafts folder accessible, Drafts-flagged and free of Periodic rules the client may not run; otherwise `failed` without creating the message (`QUEUED SAVE CHECK`) |
| Direct reply/forward create their private files before the asynchronous MIME read of the original; an add-on shutdown in that window deleted them (Sol) | files are pinned while the tool call that created them runs (superseded in round 5: no longer until application shutdown) |
| The hand-over adopted only the first 1,000 paths and lost the rest (Sol) | every valid entry is adopted; unit tests for > 1,000 entries and for paths outside the private directory |
## Review round 5 (Sol, Opus)

| Finding | Fix |
|---|---|
| Round 4 pinned every private file until application shutdown, so review-window files of the whole session survived disabling or uninstalling the add-on (Opus) | `callTool` collects the files a call creates (all four tools create them in the synchronous part of the call) and unpins them when the call ends; only files of a direct send/save with outcome `unknown` stay pinned. Review-window files are then protected only by the open-window check. Unit tests use the real `callTool` and tracking |
| The hand-over list could exceed Gecko's 1 MiB preference limit; the write failed after tracking was cleared (Sol) | the hand-over stores file names only (the directory is implicit) and the pinned ones as indexes (round 6: in chunks, without a cap) |
| Private names embedded the full original name and could exceed NTFS's 255-character limit (Sol) | short names `<time>_<counter>_<stem ≤ 40>.<ext ≤ 16>`; the original name stays in the attachment descriptor |
## Review round 6 (Opus: no substantive findings; Sol)

| Finding | Fix |
|---|---|
| The candidates of an ambiguous Message-ID listed date and author even for clients without `mail.metadata` (e.g. a client that may only delete) (Sol) | date and author only with `mail.metadata`; otherwise only the references (unit test with the real block) |
| The 5,000-file hand-over cap deleted files that were pinned or attached in open windows (Sol) | no cap: the hand-over is written in chunks of 2,000 names (each far below 1 MiB, unit test), stale chunks are cleared; files in use are never deleted |
## Review round 7 (Sol, Opus)

| Finding | Fix |
|---|---|
| Renaming one of identical rules, of which only one was registered, added an entry and made the user's identical rule "registered" (revocation disabled both) (Sol) | renaming and disabling leave the register untouched; changing the effect of, switching on or deleting a rule of a group of identical rules of which only some are registered is refused (the register cannot tell which one is meant); the user can do it in Thunderbird |
| A sender can choose a Message-ID that looks like a reference (`msgref:5:<other ID>`); it was resolved by key to another message (Opus) | if the input matches both a message's literal Message-ID and a valid reference, it is refused as ambiguous; otherwise the one matching reading is used (unit tests with the real block) |
## Review round 8 (Sol, Opus)

| Finding | Fix |
|---|---|
| Fingerprints contain Move/Copy target URIs, which Thunderbird rewrites in all rules when a folder is renamed, moved or deleted; two renames could make an untouched user rule look registered, one rename could take a client's own rule out of the disable step (Opus) | renaming, moving or deleting a folder (or a parent of one) that a rule not created through MCP targets needs `filters.foreign`; a client's own registered rules may still be affected – their fingerprint then no longer matches and revocation reports them as conflicts (5b wording corrected) |
| Identical rules of two clients: deleting one took the caller's registration away, regardless of whose rule was deleted, so revocation of the other client missed its rule silently (Sol) | groups of identical rules whose entries belong to more than one client count as ambiguous too: changing, switching on or deleting one of them is refused |
| A reference bound only key and Message-ID; Thunderbird can reuse a message key (provisional keys of IMAP offline copies) for another message with the same Message-ID (Sol) | references are `msgref:<key>:<date>:<Message-ID>`; a reused key with another date is stale. Residual: a message with the same key, Message-ID and date is treated as the same message |
## Review round 9 (Sol, Opus)

| Finding | Fix |
|---|---|
| A stale reference fell back to a message whose literal Message-ID equals the reference string (Sol) | a well-formed reference is never read as a literal Message-ID: if a message has it as its literal ID, the call is refused as ambiguous with candidate references; otherwise it resolves only to the referenced message or is stale. Only input that is not a well-formed reference is a literal Message-ID |
| The round-8 reference exposed the message date to clients without `mail.metadata` (Sol, Opus) | references are `msgref:<key>:<token>:<Message-ID>`; the token is SHA-256 over a secret of the server instance, key, date and Message-ID (16 hex characters). References are valid until Thunderbird or the add-on restarts |
| The folder guard named filter rules of accounts the client may not see, and to clients without `filters.read` (Sol, Opus) | the rule is named only with `filters.read` and access to its account |
| Migration notes did not mention that folder rename/move/delete may now need `filters.foreign` (Opus) | migration row and feature matrix; a test checks that all three handlers consult the guard first |
| The invalid-reference error still showed the old format (Opus) | corrected |
## Review round 10 (Sol, Opus)

| Finding | Fix |
|---|---|
| The folder guard checked who created an affected rule but not its account: a client could rewrite (through a folder rename/move/delete) rules of accounts it may not use (Sol) | a folder change that would rewrite a rule of an account the client may not use is refused, whoever created the rule and also with `filters.foreign` |
| The reference secret changed with every server start (e.g. after saving "Listen on all interfaces"), so references expired earlier than documented (Opus) | one secret per add-on load (module level); the stale-reference error names restarts as a cause; a unit test keeps a reference across a server restart and makes it stale after a reload |
## Review round 11 (Sol, Opus)

| Finding | Fix |
|---|---|
| A client could create an identical copy of a user rule; once the user edited the copy in Thunderbird, the untouched original counted as registered (revocation disabled it and lost the changed copy without a conflict) (Sol) | creating a rule, or changing one into an effect, identical to an existing rule not created through MCP is refused; residual (user-made exact copies) documented in 5b |
| The folder guard compared targets case-sensitively; Thunderbird rewrites local targets case-insensitively on rename (Opus, from comm-central source) | case-insensitive comparison (matching too much only refuses more) |
## Bound approvals – how each approval is tied to the concrete action

| Approval | Bound to | Where |
|---|---|---|
| Review sending (default) | the native compose window: the user sees and sends exactly the recipients (incl. CC/BCC), sender, text and attachments shown there; attachments are private copies made at call time | Stage 2, 5d |
| Unattended sending (`compose.send`, Block `skipReview` off) | a deliberate per-client grant; every call is checked against the fully resolved action: sender identity and account, Sent-copy target, Post-outgoing filters, address collection, Periodic rules, attachment paths and content; nothing between check and delivery is controlled by the client | Stage 4, 5d |
| Automatic sending filter rules (`filters.autosend`) | the rule's effect fingerprint; a changed rule is no longer "registered", revoking the client disables unchanged rules and reports changed ones | 5b |
| Calendar scheduling (`calendar.schedule`) | the triggering change (attendees, meetings, assigned tasks) is checked on every write | Stage 4 |

No second confirmation dialog is added: review mode already has the
native window, and unattended mode is by definition without one. A
client's statement or mail text is never accepted as consent; changes to
a client's grants happen only in the options page.