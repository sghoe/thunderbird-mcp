# Hardened fork: Stage 2 – targeted security fixes

Tested natively on Windows 11 with Thunderbird 153.5.0esr (portable,
isolated synthetic profile, local SMTP sink and HTTP probe). Each native
security test was also run as a **negative control** against the pre-fix
build (commit `e61d9d5`): every security assertion failed there, every
legitimate-workflow assertion passed.

## A – External attachment URLs

**Root cause.** Gloda reports a detached part's
`X-Mozilla-External-Attachment-URL` (http, file, UNC, …) as `att.url`; the
export, the inline-image fallback and the direct forward used that URL.

**Fix.** `isExternalAttachmentRecord` (Gloda `isExternal` flag or a clearly
foreign scheme), a raw-MIME cross-check (`external` flag from
`parseAttachmentPartsFromRawMime`, needed because Gloda keeps only
`Content-Type` on MIME leaves), `getOwnMessagePartUrl` (message service URL of
the authorized message + validated part number) and `isOwnMessagePartUrl` as
a final guard before every privileged channel. External parts are reported,
never fetched. A direct forward with such parts is refused.

**Native evidence** (`test/native/external-attachments.native.cjs`, 10 tests):

| Path | Before (v0.9.2 / e61d9d5) | After |
|---|---|---|
| export, `http://` reference | probe request, remote bytes exported | reported `external`, no request |
| export, `file:///` reference | local file read | reported, no read |
| export, `file://127.0.0.1/c$/…` (UNC) | fetch attempted | reported, no access |
| detached inline image | local notice returned as an "image" | skipped as external |
| direct forward, http / file | remote content and **local secret file mailed** | refused, nothing sent |
| ordinary attachment export / direct forward | works | works (bytes from the message) |
| native review forward, http / file | attaches only the local notice | unchanged (Thunderbird's own path does not fetch) |

Limits: verified for local mbox messages. IMAP/EWS part URLs are built the
same way (message service + part number) but were not tested natively. If
the raw message cannot be read (online-only IMAP), detection relies on Gloda;
even then only the message's own part URL is fetched.

## B – Filter reply templates

**Root cause.** Thunderbird resolves a Reply action's
`<folder URI>?messageId=<id>&subject=<s>` in any account
(`nsMsgComposeService::ReplyWithTemplate`, `GetExistingFolder`) and takes the
first header with that Message-ID. The tools treated the value as free text.

**Fix.** `checkReplyTemplate`: exact native format, accessible folder (same
policy as Move/Copy targets), Templates flag, exactly one message with the
Message-ID; the stored value is rebuilt from the canonical folder URI.
Checked on create, update (including retained actions; disabling stays
possible) and in `applyFilters` (skip reason `inaccessible-template`).

**Native evidence** (`test/native/stage2-policy.native.cjs`): restricted
template refused; non-Templates folder refused; a rule altered outside MCP to
point at a restricted template is skipped by `applyFilters` and cannot be
updated; no mail is sent.

## C – Calendar item types

**Fix.** `getCalendarItemKind` (`calIItemBase.isTodo()/isEvent()`, fallback
`cal.item`, unknown → refused) after every lookup in `updateTask`,
`updateEvent`, `deleteEvent`; `updateTask` applies `assertEventWriteAllowed`
to tasks, so assigned tasks with other attendees follow Block `skipReview`.

**Native evidence:** `updateTask` with a meeting's ID is refused and the
meeting is unchanged (before: modified); `deleteEvent` with a task ID is
refused.

## D – Draft destination

**Fix.** `saveDraft` checks, before every save, that the selected identity's
configured Drafts folder exists, is accessible and has the Drafts flag;
errors never include the folder URI.

**Native evidence:** with identity `id1`'s Drafts pointed at the restricted
account, a new draft is refused and the restricted Drafts folder is
unchanged (before: the draft was stored there).

## Additional check targets

* **Message-ID duplicates – confirmed.** With two messages sharing one
  Message-ID in a folder, v0.9.2's `getMessage` silently returned the
  attacker's "Spoofed copy" and `deleteMessages` deleted one of them.
  `findMessage`, `deleteMessages` and `updateMessage` now refuse ambiguous IDs
  atomically (native tests for `getMessage`, `deleteMessages`,
  `updateMessage`, `replyToMessage`). Disambiguation through unique
  references follows in Stage 5.
* **UNC/SMB/NTLM.** Plugin-triggered access to `file://host/share` references
  in attachments is no longer possible (covered above). Path attachments with
  UNC/device prefixes were already refused before any filesystem access
  (existing tests). Not verified: whether Thunderbird itself resolves UNC
  references when a user opens such an attachment in the GUI – outside the
  plugin's control.

## Regression status

* Unit: `node --test test/*.cjs` – all pass except the 2 pre-existing
  Windows-only Flatpak tests.
* Contract: unchanged against v0.9.2 (`test/tool-contract.test.cjs`).
* Native parity: 64 calls / 40 tools, outcome and shape identical to
  upstream v0.9.2, 4 SMTP deliveries.
