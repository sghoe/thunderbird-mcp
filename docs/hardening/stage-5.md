# Hardened fork: Stage 5 – resource and action model

Scope: complete the resource and action model on top of Stage 4: unique
message references, a register of MCP-created filter rules with
revocation, honest operation states, and content-bound attachments. The
Stage 2 hotfixes stay in force throughout.

## 5a – Unique message references

* An RFC Message-ID stays the normal input. If several messages in the
  folder share it, the call is refused (as since Stage 2) and the error
  now lists `candidates`: one `msgref:<messageKey>:<Message-ID>` reference
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
  longer match their fingerprint (changed by the user), are missing or
  ambiguous are reported in the options page as conflicts for the user to
  decide; nothing is disabled by name or index. If Thunderbird cannot save
  the disabled rule (e.g. the rules file is locked on Windows), the rule
  stays disabled for the running session and is reported as a conflict. Rules without sending
  actions stay as they are.
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