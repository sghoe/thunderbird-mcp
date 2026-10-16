"use strict";

// Native regression for finding A: X-Mozilla-External-Attachment-URL must
// never cause a privileged fetch (HTTP, local file, UNC) from export, inline
// images, direct forward or the native review forward.
// Run: THUNDERBIRD_BIN=... node --test test/native/external-attachments.native.cjs

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const h = require("./harness.cjs");
const f = require("./fixtures.cjs");

const INBOX = "mailbox://alice@127.0.0.1/Inbox";
const SECRET = "LOCAL-SECRET-CONTENT";

function mentions(data, text) {
  return data.includes(text) || data.includes(Buffer.from(text).toString("base64").slice(0, 16));
}

describe("external attachment references (native)", { skip: !h.thunderbirdBinary() && "THUNDERBIRD_BIN not set" }, () => {
  let tb;
  before(async () => {
    tb = await h.startThunderbird({
      mailboxes: ({ probe, root }) => {
        const secretFile = path.join(root, "secret.txt");
        fs.writeFileSync(secretFile, SECRET);
        const fileUrl = `file:///${secretFile.replace(/\\/g, "/")}`;
        return {
          alice: {
            Inbox:
              f.plainWithAttachment() +
              f.externalAttachment({ id: "ext-http@attacker.test", url: probe.url("/ext-http") }) +
              f.externalAttachment({ id: "ext-file@attacker.test", url: fileUrl, filename: "secret.txt", contentType: "text/plain" }) +
              f.externalAttachment({ id: "ext-unc@attacker.test", url: "file://127.0.0.1/c$/secret.txt", filename: "unc.txt", contentType: "text/plain" }) +
              f.externalInlineImage({ id: "ext-inline@attacker.test", url: probe.url("/ext-inline") }) +
              f.externalAttachment({ id: "ext-review-http@attacker.test", url: probe.url("/ext-review") }) +
              f.externalAttachment({ id: "ext-review-file@attacker.test", url: fileUrl, filename: "secret.txt", contentType: "text/plain" }),
          },
        };
      },
    });
    await tb.waitForMessages(INBOX, 7);
  });
  after(async () => { await tb?.stop(); });

  it("still exports ordinary attachments from the message itself", async () => {
    const r = await tb.call("getMessage", { messageId: "plain-attach@allowed.test", folderPath: INBOX, saveAttachments: true });
    const [att] = r.result.attachments;
    assert.equal(att.error, undefined);
    assert.equal(fs.readFileSync(att.filePath, "utf8"), "synthetic attachment body\n");
    assert.equal(att.external, undefined);
  });

  for (const id of ["ext-http@attacker.test", "ext-file@attacker.test", "ext-unc@attacker.test"]) {
    it(`reports but never fetches the external attachment of ${id}`, async () => {
      const before = tb.probe.requests.length;
      const r = await tb.call("getMessage", { messageId: id, folderPath: INBOX, saveAttachments: true });
      const att = r.result.attachments.find((a) => a.name !== "");
      assert.equal(att.external, true);
      assert.equal(att.filePath, undefined);
      assert.match(att.error, /External or detached attachment/);
      assert.equal(tb.probe.requests.length, before);
    });
  }

  it("does not fetch or include a detached inline image", async () => {
    const before = tb.probe.requests.length;
    const r = await tb.call("getMessage", { messageId: "ext-inline@attacker.test", folderPath: INBOX, includeInlineImages: true, saveAttachments: true });
    const img = r.result.attachments.find((a) => a.isInline);
    assert.equal(img.external, true);
    assert.equal(img.mcpImage.status, "skipped");
    assert.equal(r.result.inlineImageContent.included, 0);
    assert.equal(tb.probe.requests.length, before);
  });

  for (const id of ["ext-http@attacker.test", "ext-file@attacker.test"]) {
    it(`refuses a direct forward of ${id} without fetching or sending`, async () => {
      const before = { probe: tb.probe.requests.length, smtp: tb.smtp.messages.length };
      const r = await tb.call("forwardMessage", { messageId: id, folderPath: INBOX, to: "dest@sink.test", skipReview: true });
      assert.match(r.result.error, /external or detached attachments/);
      await h.sleep(1500);
      assert.equal(tb.probe.requests.length, before.probe);
      assert.equal(tb.smtp.messages.length, before.smtp);
    });
  }

  it("direct forward of ordinary attachments still sends them from the message", async () => {
    const before = tb.smtp.messages.length;
    const r = await tb.call("forwardMessage", { messageId: "plain-attach@allowed.test", folderPath: INBOX, to: "dest@sink.test", skipReview: true });
    assert.equal(r.result.success, true);
    await h.waitFor(() => tb.smtp.messages.length > before, { label: "forward delivery" });
    const sent = tb.smtp.messages.at(-1).data;
    assert.ok(mentions(sent, "synthetic attachment body"));
  });

  for (const id of ["ext-review-http@attacker.test", "ext-review-file@attacker.test"]) {
    it(`native review forward of ${id} attaches only the local notice`, async () => {
      const before = tb.probe.requests.length;
      const r = await tb.call("forwardMessage", { messageId: id, folderPath: INBOX, to: "dest@sink.test" });
      assert.equal(r.result.success, true);
      await h.sleep(4000);
      const attachments = await tb.marionette.run(`
        const out = [];
        for (const win of Services.wm.getEnumerator("msgcompose")) {
          const bucket = win.document.getElementById("attachmentBucket");
          for (const item of bucket?.itemChildren || []) out.push({ url: item.attachment.url, name: item.attachment.name });
        }
        const contents = [];
        for (const a of out) {
          if (!a.url.startsWith("file:")) { contents.push({ ...a, content: null }); continue; }
          const file = Services.io.newURI(a.url).QueryInterface(Ci.nsIFileURL).file;
          const stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
          stream.init(file, 1, 0, 0);
          const sis = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
          sis.init(stream);
          contents.push({ ...a, content: sis.read(sis.available()) });
          sis.close();
        }
        for (const win of [...Services.wm.getEnumerator("msgcompose")]) win.close();
        return contents;
      `);
      assert.equal(tb.probe.requests.length, before);
      assert.equal(attachments.length, 1);
      // Thunderbird copies the stored part (the detach notice) to a temp file;
      // the referenced location is neither the attachment URL nor its content.
      assert.doesNotMatch(attachments[0].url, /secret\.txt|ext-review/);
      assert.ok(attachments[0].content === null || !attachments[0].content.includes(SECRET));
    });
  }
});
