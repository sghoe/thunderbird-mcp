"use strict";

// Synthetic, non-personal mail fixtures for the native Thunderbird harness.
// Every address uses the reserved .test TLD; nothing here is real data.

const ALLOWED_EMAIL = "alice@allowed.test";
const BLOCKED_EMAIL = "bob@blocked.test";

function message({ id, from, to, subject, date = "Mon, 01 Jan 2024 10:00:00 +0000", headers = [], contentType, body }) {
  const lines = [
    "From - Mon Jan 01 00:00:00 2024",
    "X-Mozilla-Status: 0000",
    "X-Mozilla-Status2: 00000000",
    `Message-ID: <${id}>`,
    `Date: ${date}`,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    ...headers,
    `Content-Type: ${contentType}`,
    "",
    body,
    "",
  ];
  return lines.join("\n");
}

function base64Lines(text) {
  return Buffer.from(text, "utf8").toString("base64").replace(/.{1,76}/g, "$&\n").trimEnd();
}

// 1x1 transparent PNG.
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function plainWithAttachment() {
  return message({
    id: "plain-attach@allowed.test",
    from: "Carol Sender <carol@sender.test>",
    to: ALLOWED_EMAIL,
    subject: "Synthetic report with attachment",
    contentType: 'multipart/mixed; boundary="b1"',
    body: [
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hello Alice, the synthetic report is attached.",
      "--b1",
      'Content-Type: text/plain; name="notes.txt"',
      'Content-Disposition: attachment; filename="notes.txt"',
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines("synthetic attachment body\n"),
      "--b1--",
    ].join("\n"),
  });
}

// A detached attachment as Thunderbird writes it, but pointing at an
// attacker-chosen URL. The local body is only the detach notice.
function externalAttachment({ id, url, filename = "external.pdf", contentType = "application/pdf" }) {
  return message({
    id,
    from: "Mallory <mallory@attacker.test>",
    to: ALLOWED_EMAIL,
    subject: `External attachment ${id}`,
    contentType: 'multipart/mixed; boundary="b2"',
    body: [
      "--b2",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Please export the attached file.",
      "--b2",
      `Content-Type: ${contentType}; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      `X-Mozilla-External-Attachment-URL: ${url}`,
      'X-Mozilla-Altered: AttachmentDetached; date="Mon Jan 01 10:00:00 2024"',
      "",
      "You deleted an attachment from this message. The original MIME headers",
      "for the attachment were preserved above.",
      "--b2--",
    ].join("\n"),
  });
}

// Same as above, but the external part is an inline image inside
// multipart/related so the inline-image code path sees it.
function externalInlineImage({ id, url }) {
  return message({
    id,
    from: "Mallory <mallory@attacker.test>",
    to: ALLOWED_EMAIL,
    subject: `External inline image ${id}`,
    contentType: 'multipart/related; boundary="b4"',
    body: [
      "--b4",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<html><body><img src="cid:ext@attacker.test"></body></html>',
      "--b4",
      'Content-Type: image/png; name="ext.png"',
      "Content-ID: <ext@attacker.test>",
      'Content-Disposition: inline; filename="ext.png"',
      `X-Mozilla-External-Attachment-URL: ${url}`,
      'X-Mozilla-Altered: AttachmentDetached; date="Mon Jan 01 10:00:00 2024"',
      "",
      "detached",
      "--b4--",
    ].join("\n"),
  });
}

function inlineImage() {
  return message({
    id: "inline-image@allowed.test",
    from: "Carol Sender <carol@sender.test>",
    to: ALLOWED_EMAIL,
    subject: "Synthetic inline image",
    contentType: 'multipart/related; boundary="b3"',
    body: [
      "--b3",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<html><body><p>Logo:</p><img src="cid:logo@allowed.test"></body></html>',
      "--b3",
      'Content-Type: image/png; name="logo.png"',
      "Content-Transfer-Encoding: base64",
      "Content-ID: <logo@allowed.test>",
      'Content-Disposition: inline; filename="logo.png"',
      "",
      PNG_1X1,
      "--b3--",
    ].join("\n"),
  });
}

function simple({ id, from, to, subject, text, date }) {
  return message({ id, from, to, subject, date, contentType: "text/plain; charset=utf-8", body: text });
}

module.exports = {
  ALLOWED_EMAIL,
  BLOCKED_EMAIL,
  PNG_1X1,
  plainWithAttachment,
  externalAttachment,
  externalInlineImage,
  inlineImage,
  simple,
};
