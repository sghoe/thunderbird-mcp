"use strict";

// Finding A: attachment bytes may only come from the authorized message's
// own part URLs; external/detached references are reported, never fetched.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Core } = require("./helpers/core-modules.cjs");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
const START = "// BEGIN RAW MIME PARSING HELPERS";
const MID_END = "// END RAW MIME PARSING HELPERS";
const ATT_START = "// BEGIN RAW MIME ATTACHMENT HELPERS";
const ATT_END = "// END RAW MIME ATTACHMENT HELPERS";

const BASE = "mailbox:///C:/profile/Mail/alice/Inbox?number=42";

function load() {
  const sandbox = {
    Uint8Array, TextDecoder, atob: globalThis.atob, Core,
    MailServices: { messageServiceFromURI: () => ({ getUrlForUri: () => ({ spec: BASE }) }) },
  };
  vm.createContext(sandbox);
  vm.runInContext([
    source.slice(source.indexOf(START), source.indexOf(MID_END)),
    source.slice(source.indexOf(ATT_START), source.indexOf(ATT_END)),
    "Object.assign(this, { isExternalAttachmentRecord, getOwnMessagePartUrl, isOwnMessagePartUrl, parseAttachmentPartsFromRawMime });",
  ].join("\n"), sandbox);
  return sandbox;
}

const h = load();
const msgHdr = { folder: { getUriForMsg: () => "mailbox-message://alice@127.0.0.1/Inbox#42" } };

describe("external attachment classification", () => {
  for (const url of [
    "http://attacker.test/x.pdf?part=1.2",
    "https://attacker.test/x.pdf",
    "file:///C:/Users/victim/secret.txt?part=1.2",
    "file://server/share/secret.txt",
    "FILE:///etc/passwd",
    "smb://server/share/x",
    "data:text/plain,hello",
  ]) {
    it(`treats ${url} as external`, () => {
      assert.equal(h.isExternalAttachmentRecord({ url, partName: "1.2" }), true);
    });
  }

  it("honours Gloda's isExternal flag regardless of URL", () => {
    assert.equal(h.isExternalAttachmentRecord({ url: `${BASE}&part=1.2`, isExternal: true }), true);
  });

  for (const url of [`${BASE}&part=1.2&filename=notes.txt`, "imap://alice@host/fetch>UID>/INBOX>7?part=1.2", "", undefined]) {
    it(`does not classify message-service URL ${url} as external`, () => {
      assert.equal(h.isExternalAttachmentRecord({ url, partName: "1.2" }), false);
    });
  }
});

describe("own message part URLs", () => {
  it("builds the part URL from the message service, not from the reported URL", () => {
    assert.equal(h.getOwnMessagePartUrl(msgHdr, "1.2"), `${BASE}&part=1.2`);
    assert.equal(h.getOwnMessagePartUrl(msgHdr, "1.2.10"), `${BASE}&part=1.2.10`);
  });

  for (const partName of ["", "1.", ".1", "1.2&x=y", "1;2", "../1", undefined, 3]) {
    it(`rejects malformed part name ${JSON.stringify(partName)}`, () => {
      assert.equal(h.getOwnMessagePartUrl(msgHdr, partName), "");
    });
  }

  it("accepts exactly this message's URL plus one numeric part selector", () => {
    assert.equal(h.isOwnMessagePartUrl(msgHdr, `${BASE}&part=1.2`), true);
    for (const url of [
      `${BASE}&part=1.2&filename=x`,
      `${BASE}&part=1.2/../x`,
      `${BASE.replace("42", "43")}&part=1.2`,
      `http://attacker.test/?part=1.2`,
      BASE,
      "",
    ]) {
      assert.equal(h.isOwnMessagePartUrl(msgHdr, url), false, url);
    }
  });
});

describe("raw MIME external part flag", () => {
  it("marks parts carrying X-Mozilla-External-Attachment-URL", () => {
    const raw = [
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "body",
      "--b",
      'Content-Type: application/pdf; name="ext.pdf"',
      'Content-Disposition: attachment; filename="ext.pdf"',
      "X-Mozilla-External-Attachment-URL: file:///C:/secret.txt",
      "",
      "You deleted an attachment from this message.",
      "--b",
      'Content-Type: text/plain; name="local.txt"',
      'Content-Disposition: attachment; filename="local.txt"',
      "",
      "local",
      "--b--",
      "",
    ].join("\r\n");
    const parts = h.parseAttachmentPartsFromRawMime(raw);
    assert.equal(JSON.stringify(parts.map((p) => [p.filename, p.external])), JSON.stringify([["ext.pdf", true], ["local.txt", false]]));
  });
});
