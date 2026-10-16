# Feature and contract matrix (baseline: upstream v0.9.2)

Machine-checked sources:

* **Input contract:** `test/baseline/tools-v0.9.2.json`, generated from
  upstream `buildTools()` at commit `1ab1018`. `test/tool-contract.test.cjs`
  enforces: exactly these 40 tools; unchanged group/CRUD class; every baseline
  property keeps its type, enum values, nested structure and limits; no new
  required property and no undocumented new property. Deliberate changes must
  be listed with a reason in `test/baseline/contract-changes.json` and
  described in `docs/hardening/migration.md`.
* **Native functional baseline:** `test/baseline/native-parity-v0.9.2.json`,
  produced by `node test/native/run-parity.cjs --upstream` on Windows 11 with
  Thunderbird 153.5.0esr: 64 calls, 40 tools, 0 failures, 4 SMTP deliveries to
  the local sink. The same scenarios run against the working tree and are
  compared by outcome and result shape
  (`node test/native/run-parity.cjs --compare a.json b.json`).

"Effect" is the capability class the call actually exercises. It is the
basis for the positive permissions introduced in Stage 4. Native column:
scenario labels in the parity run.

## Accounts and access

| Tool | Relevant arguments | Effect | Native |
|---|---|---|---|
| `listAccounts` | – | account/identity metadata | ✔ |
| `listFolders` | `accountId`, `folderPath`, `format` (objects/table), `favoritesOnly` | folder metadata, counts | ✔ all, table |
| `getAccountAccess` | – | policy view | ✔ |

## Mail

| Tool | Relevant arguments | Effect | Native |
|---|---|---|---|
| `searchMessages` | `query` (`from:`/`subject:`/`to:`/`cc:`), dates, `tag`, `unreadOnly`, `flaggedOnly`, `includeSubfolders`, `offset`/`maxResults`, `countOnly`, `searchBody`, `dedupByMessageId` | metadata + body preview; `searchBody` = body search | ✔ query, from:, paginated, countOnly |
| `getMessage` | `bodyFormat` markdown/text/html, `rawSource`, `saveAttachments`, `includeInlineImages` | body; html = unsanitised HTML; raw = full source; attachment **export** (writes files); inline images | ✔ all variants |
| `getMessages` | `messages[]` (batch limit 10, max 20), same options | as `getMessage` | ✔ batch |
| `getRecentMessages` | `daysBack`, pagination, filters | metadata + preview | ✔ |
| `displayMessage` | `displayMode` 3pane/tab/window | **GUI side effects**: opens UI, Thunderbird may mark the message read | ✔ 3pane, tab |
| `updateMessage` | `messageId(s)`, `read`, `flagged`, `addTags`/`removeTags`, `moveTo`, `copyTo`, `trash` | flags/tags; move/copy (source + destination); delete to Trash | ✔ flags/tags, copyTo, moveTo |
| `deleteMessages` | `messageIds`, `folderPath` | delete (Trash; drafts moved to Trash) | ✔ |

## Folders

| Tool | Relevant arguments | Effect | Native |
|---|---|---|---|
| `createFolder` | `parentFolderPath`, `name` | folder write | ✔ |
| `renameFolder` | `folderPath`, `newName` | folder write | ✔ |
| `moveFolder` | `folderPath`, `newParentPath` (same account) | folder write | ✔ |
| `deleteFolder` | `folderPath` | delete (Trash; **permanent** if already in Trash) | ✔ |
| `emptyTrash` | `accountId` | **permanent delete** | ✔ |
| `emptyJunk` | `accountId` | **permanent delete** | ✔ |

## Compose

| Tool | Relevant arguments | Effect | Native |
|---|---|---|---|
| `sendMail` | recipients incl. `cc`/`bcc`, `isHtml`, `from`, `attachments` (paths / base64), `skipReview`, `includeSignature` | review window, or **unattended send**; local file use; Sent/FCC copy | ✔ review, direct, direct with re-attached export |
| `saveDraft` | threading (`inReplyTo`, `references`), `replaceMessageId`/`replaceFolderPath`, `attachments`, `includeSignature` | draft write into the identity's Drafts folder | ✔ new, replace |
| `replyToMessage` | `replyAll`, recipients, `attachments`, `skipReview`, `saveAsDraft` | review window, unattended send, or draft | ✔ review, direct, saveAsDraft |
| `forwardMessage` | recipients, `attachments`, `skipReview` | review window (native ForwardInline) or unattended send incl. original attachments | ✔ review, direct |

## Filters

| Tool | Relevant arguments | Effect | Native |
|---|---|---|---|
| `listFilters` | `accountId` | filter metadata | ✔ |
| `createFilter` | conditions, actions (move/copy/tag/…/**forward/reply**), `type`, `insertAtIndex` | filter management; forward/reply = **persistent automatic sending** | ✔ |
| `updateFilter` | `filterIndex`, any field | filter management | ✔ |
| `deleteFilter` | `filterIndex` | filter management | ✔ |
| `reorderFilters` | `fromIndex`, `toIndex` | filter management (changes which rules run) | ✔ |
| `applyFilters` | `accountId`, `folderPath` | filter **execution** on existing mail | ✔ |

## Contacts

| Tool | Relevant arguments | Effect | Native |
|---|---|---|---|
| `searchContacts` | `query`, `maxResults` | contact read | ✔ |
| `getContact` | `contactId` | contact read | ✔ |
| `createContact` | names, email, phones, addresses, organisation, title, note, birthday, `addressBookId` | contact write | ✔ |
| `updateContact` | as above | contact write | ✔ |
| `deleteContact` | `contactId` | contact delete | ✔ |

## Calendar and tasks

| Tool | Relevant arguments | Effect | Native |
|---|---|---|---|
| `listCalendars` | – | calendar metadata | ✔ |
| `listEvents` | range, `maxResults` | calendar read (incl. attendees) | ✔ |
| `createEvent` | dates, `recurrence`, `attendees`, `status`, `showAs`, `categories`, `onlineMeeting`, `skipReview` | review dialog or direct write; attendees = **scheduling** (provider may send invitations) | ✔ direct (recurring), review |
| `updateEvent` | fields, `recurrence`, `recurrenceId`, `attendees` | calendar write; attendee-bearing meetings = scheduling | ✔ series, occurrence |
| `deleteEvent` | `recurrenceId` | calendar delete; meetings = scheduling (cancellations) | ✔ occurrence, series |
| `listCategories` | – | metadata | ✔ |
| `createTask` | `dueDate`, `priority`, `categories`, `skipReview` | review dialog or direct write | ✔ direct, review |
| `listTasks` | `completed`, `dueBefore`, `maxResults` | task read | ✔ |
| `updateTask` | title, due date, description, completion, priority | task write | ✔ |

## Not covered natively yet

`searchBody` (Gloda full-text), `favoritesOnly`, `displayMessage` window
mode, `getMessage` on IMAP/online-only messages, encrypted messages,
attendee writes, filter forward/reply actions (covered by Stage 2
regressions), contacts with postal addresses, multi-account restrictions
(covered by Stage 2/4 negative tests). IMAP, Exchange and CalDAV provider
behaviour cannot be tested with the local synthetic profile.
