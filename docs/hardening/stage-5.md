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