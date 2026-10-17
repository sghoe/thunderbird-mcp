# Migration notes (upstream v0.9.2 → hardened fork)

Every deliberate behaviour or contract change is listed here. Tool names,
input schemas and result shapes otherwise stay compatible with upstream
v0.9.2 (enforced by `test/tool-contract.test.cjs` and the native parity run).

## Stage 0 – fork identity

| Change | Effect for users | Migration |
|---|---|---|
| New add-on ID, name "Thunderbird MCP (hardened fork)" | installs as a separate add-on | uninstall upstream (recommended) and install the fork XPI |
| No automatic updates | Thunderbird never updates the fork by itself | install new builds manually; keep the previous XPI for rollback |
| Preferences moved to `extensions.thunderbird-mcp-hardened.*` | upstream settings are **not** inherited: account/tool restrictions, `blockSkipReview`, encrypted-mail, calendar/address-book opt-ins, filter-send opt-in, stable token, listen-all all start at the fork's defaults | re-apply the desired settings on the fork's options page |
| Port range 8775–8784 (was 8765–8774); ports already served by another listener are skipped | direct HTTP clients configured for `127.0.0.1:8765` stop reaching the fork | update the URL (the bridge discovers the port automatically) |
| Discovery file `<TmpD>/thunderbird-mcp-hardened/connection.json` | bridges/scripts pinned via `THUNDERBIRD_MCP_CONNECTION_FILE` to the old path fail | point the variable at the new path or remove it |
| Attachment exports in `<TmpD>/thunderbird-mcp-hardened-exports/<message>/<file>` | exported paths change; re-attaching exports keeps working | none |
| Runtime directory refused as an attachment source; `connection.json` refused in any `thunderbird-mcp*` directory | attaching discovery/staging files fails | none (these were never legitimate attachments) |
| `resource://` alias no longer readable by web content | none for legitimate use | none |

## Stage 2 – targeted security fixes

| Change | Effect for users | Migration |
|---|---|---|
| External/detached attachments (`X-Mozilla-External-Attachment-URL`) are never fetched; bytes come only from the message's own part URLs | such attachments are reported with `external: true` and an `error` (additive fields) instead of being exported or shown as images; previously the referenced HTTP/file/UNC location was fetched with system privileges | export the real file from its original location yourself if needed |
| Direct forward (`skipReview: true`) refuses originals with external/detached attachments, and originals whose attachment cannot be read from the message | previously the external location was fetched and mailed; unreadable attachments were dropped silently | use `skipReview: false` (native review forward) |
| Filter Reply templates must be a unique message in an accessible Templates folder (create, update incl. retained actions, `applyFilters`) | rules with other templates are refused; `applyFilters` skips them with reason `inaccessible-template`; disabling and deleting stay possible | pick a template from an allowed account's Templates folder |
| `updateTask` only changes tasks; `updateEvent`/`deleteEvent` only events; unknown item kinds are refused | an event ID passed to `updateTask` (or a task ID to the event tools) now fails | use the matching tool |
| Tasks with attendees other than the calendar user follow Block `skipReview` like meetings | such tasks are read-only via MCP while the block is on | disable the block deliberately if needed |
| `saveDraft` authorizes the identity's real Drafts destination before every save (exists, accessible, Drafts flag) | new drafts are refused when the identity saves into a restricted account, a missing folder or a folder without the Drafts flag; previously only replacements were checked | configure the identity's Drafts folder in an allowed account |
| An ambiguous Message-ID (several messages in the folder) is refused by all message tools | previously an arbitrary match was read/changed/deleted | pass one of the `candidates` references from the error (Stage 5) |

## Stage 4 – paired clients and positive permissions

| Change | Effect for users | Migration |
|---|---|---|
| No shared token any more: each MCP client is paired in Options > Clients and gets its own token (shown once, only a SHA-256 verifier is stored) | after the update every request gets HTTP 403 until a client is paired; the stable-token setting and the "current token" display are gone | pair each client and put its token into its configuration |
| `connection.json` holds only `{port, pid}`; a leftover `token` field from older versions is rewritten away | scripts that read the token from the file (`jq -r .token`) stop working | read the token from your own configuration instead |
| The bridge reads the token from `THUNDERBIRD_MCP_TOKEN` or `THUNDERBIRD_MCP_TOKEN_FILE` | the bridge refuses to forward without it (`No client token configured`) | add the variable to the MCP client configuration |
| Each call needs the capabilities of its effect (tool **and** arguments); `tools/list` shows only usable tools | a client without a capability gets `Not permitted for client "<name>": requires <capability>` | grant the capability or pick another profile |
| Per-client account list (explicit keys, no wildcard) and calendar/address-book grants, on top of the global settings | a client sees only its accounts; calendar and contact tools need the grant; `getAccountAccess` reports `restricted` when the client sees fewer than all accounts | tick the accounts and grants for the client |
| Attachments the bridge reads from local paths need `files.attach` (the bridge marks such requests) | the `drafts` profile cannot attach local files | use a `custom` profile with `files.attach` if needed |
| State-dependent checks: permanent deletion (from Trash, IMAP without move-to-Trash, Drafts without Trash) needs `mail.deletePermanent`; `applyFilters` skips rules whose actions the client may not perform (reason `missing-capability`); changing a stored rule other than disabling it needs its actions' capabilities; changing or deleting meetings and assigned tasks with attendees needs `calendar.schedule` | such calls are refused for clients without the capability, even with Block `skipReview` off | grant the capability to clients that need it |
| Calls of different clients never run concurrently (fair queue); calls of one client may | heavy parallel use by several clients is serialised | none |
| A corrupt client list admits no client; the settings page offers "Remove all clients" | all requests get 403 until repaired | remove all clients and pair again |
| Revocation and changed rights apply to the next request | calls already running finish; calls still waiting for another client's call are refused without effect if their client was removed or changed meanwhile | retry after re-pairing |
| Forward filter rules need an accessible account with its own identity (Thunderbird would otherwise send from the default account); Delete rules need `mail.deletePermanent` where they delete permanently (Trash, IMAP without move-to-Trash) | such rules are refused on create/update; `applyFilters` skips them (`unauthorized-sender` / `missing-capability`) | add an identity to the account or grant the capability |
| Inline Forward rules (Thunderbird default `mail.forward_message_mode = 2`) only while every identity belongs to an account the client may use; Forward/Reply rules also need POP accounts that deliver into the account; IMAP move-to-Trash without a Trash-flagged folder counts as permanent deletion; review windows whose actual identity belongs to a restricted account are closed with an error | restricted clients cannot create such rules or open such windows | forward as attachment, grant the accounts, or flag the Trash folder |
| Direct sends and sending filter rules require the identity's Sent folder to be in an accessible account; deletions on Exchange (EWS/Graph) and unknown server types need `mail.deletePermanent` | restricted clients are refused when a copy or deletion would leave their scope | adjust the identity's Sent folder or grant the capability/account |
| Direct sends also require every Sent-folder fallback and the Post-outgoing filters of the Sent copy's account to stay within the client's rights; review windows are closed when autosave would write into a restricted Drafts folder | restricted clients are refused in such configurations | fix the identity's folder settings, adjust the filter, or grant the account |
| Sends (direct and by Forward/Reply rules) by clients without `contacts.write` and address-book access are refused when Thunderbird's address collection would add or change contacts (default: on); sending rules also check the Post-outgoing filters their sends trigger | a restricted sending client may need the contacts grant | grant `contacts.write` and address books, or turn off `mail.collect_email_address_outgoing` |

## Stage 5 – resource and action model

| Change | Effect for users | Migration |
|---|---|---|
| Ambiguous Message-ID errors list `candidates` with `msgref:<key>:<token>:<Message-ID>` references (valid until Thunderbird or the add-on restarts); every `messageId` input accepts them | an ambiguous call can be repeated with the chosen reference | none (additive) |
| Rules created/changed through MCP are registered; revoking a client disables its unchanged registered Forward/Reply rules and reports changed ones | revocation can stop automatic forwarding set up by that client | review the conflicts shown in the options page |
| Changing, reordering or deleting rules not created through MCP needs `filters.foreign` | clients paired before Stage 5 with an explicit capability list cannot change the user's own rules | grant `filters.foreign` where wanted |
| Sending, draft and calendar-write results carry `operationState` (`opened-for-review`, `submitted`, `queued`, `completed`, `failed`, `unknown`) | additive; some error texts gain a hint when the outcome is unknown | treat `unknown` as "check before retrying", never as "failed" |
| Path attachments are copied when the call is made; the review window and the sent mail use that copy | changing the file after the call no longer changes the mail; a file that changes while it is read is refused | attach the final version of the file |
| Renaming, moving or deleting a folder that a filter rule not created through MCP moves or copies into (or a parent of such a folder) needs `filters.foreign` | Thunderbird rewrites those rules' targets; clients paired before Stage 5 lack the capability, and rules created through MCP before Stage 5 are not registered, so such folders are refused for them | grant `filters.foreign` where wanted |
