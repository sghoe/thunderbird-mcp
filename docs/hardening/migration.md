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
