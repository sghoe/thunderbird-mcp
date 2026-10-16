"use strict";

// Live sandbox for manual testing: a visible portable Thunderbird with a
// synthetic profile (alice/bob POP accounts on 127.0.0.1, Local Folders,
// a storage calendar), a local SMTP sink that never relays, and two paired
// clients. Nothing touches real profiles or real mail servers.
//
// Run: THUNDERBIRD_BIN=... node test/native/live-sandbox.cjs
// Stop with Ctrl+C (removes the sandbox unless TBMCP_KEEP_PROFILE is set).

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const h = require("./harness.cjs");
const f = require("./fixtures.cjs");

const ALICE = "mailbox://alice@127.0.0.1";

(async () => {
  if (!h.thunderbirdBinary()) throw new Error("THUNDERBIRD_BIN is not set or does not exist");
  const policy = await import(pathToFileURL(path.join(h.EXTENSION_DIR, "mcp_server", "core", "policy.sys.mjs")).href);

  const tb = await h.startThunderbird({
    headless: false,
    mailboxes: {
      alice: {
        Inbox:
          f.simple({ id: "welcome@sandbox.test", from: "Carol Example <carol@sender.test>", to: f.ALLOWED_EMAIL, subject: "Willkommen in der Sandbox", text: "Synthetische Testnachricht fuer Alice." }) +
          f.simple({ id: "invoice@sandbox.test", from: "Billing <billing@sender.test>", to: f.ALLOWED_EMAIL, subject: "Rechnung 2026-10", text: "Betrag: 42,00 EUR (synthetisch)." }) +
          f.plainWithAttachment(),
      },
      bob: {
        Inbox: f.simple({ id: "bob-secret@sandbox.test", from: "Eve <eve@sender.test>", to: "bob@blocked.test", subject: "Nur fuer Bob", text: "Diese Nachricht gehoert zu Bob." }),
      },
    },
    clients: [
      { name: "live-automation" },
      {
        name: "live-readonly-alice",
        profile: "read-only",
        capabilities: policy.capabilitiesForProfile("read-only"),
        accounts: ["account1"],
        calendars: true,
        addressBooks: false,
      },
    ],
  });
  await tb.waitForMessages(`${ALICE}/Inbox`, 3).catch(() => {});

  const info = {
    connectionFile: tb.connection.file,
    port: tb.connection.port,
    smtpSinkPort: tb.smtp.port,
    profileDir: tb.profileDir,
    bridge: path.join(h.REPO_ROOT, "mcp-bridge.cjs"),
    clients: tb.clientTokens,
  };
  const infoFile = path.join(tb.root, "live-session.json");
  fs.writeFileSync(infoFile, JSON.stringify(info, null, 2), { mode: 0o600 });

  console.log("Live sandbox is running.");
  console.log(`Session info (incl. client tokens): ${infoFile}`);
  console.log(`Connection file: ${info.connectionFile} (port ${info.port})`);
  console.log(`SMTP sink on 127.0.0.1:${info.smtpSinkPort} (mail is captured, never relayed)`);
  console.log("Clients: live-automation (all capabilities, all accounts), live-readonly-alice (read-only, account1, calendars)");

  let seen = 0;
  const timer = setInterval(() => {
    while (seen < tb.smtp.messages.length) {
      const m = tb.smtp.messages[seen++];
      const subject = /^Subject: (.*)$/mi.exec(m.data || "")?.[1] || "";
      console.log(`[SMTP sink] from=${m.from} to=${(m.to || []).join(",")} subject=${subject}`);
    }
  }, 1000);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    await tb.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  tb.child.on("exit", stop);
})().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
