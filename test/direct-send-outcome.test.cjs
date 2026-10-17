"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Core } = require("./helpers/core-modules.cjs");

const source = fs.readFileSync(path.resolve(__dirname, "../extension/mcp_server/api.js"), "utf8");
const modes = { Now: 0, Later: 1, SaveAsDraft: 4 };
const failure = 0x80004005;

// Searched test/ for DIRECT SEND HELPER, listener mocks and disposition tests.
// save-draft-replace supplies the marker+VM pattern; no shared send harness exists.
function snippet(name) {
  const start = source.indexOf(`// BEGIN ${name}`);
  const end = source.indexOf(`// END ${name}`, start);
  assert.ok(start >= 0 && end > start, `Missing production marker: ${name}`);
  return source.slice(start, end);
}

function loadSend(options = {}) {
  const state = { calls: [], dispositions: [], result: undefined };
  const identity = { key: "sender", email: "sender@example.test", fccReplyFollowsParent: !!options.followsParent };
  const timer = {
    cancelled: false,
    initWithCallback(callback, delay) { this.callback = callback; this.delay = delay; },
    cancel() { this.cancelled = true; },
  };
  const creation = new Promise((resolve, reject) => {
    state.deliveryStarted = resolve;
    state.creationFailed = reject;
  });
  const folder = {
    server: {}, getUriForMsg: () => "message-uri",
    addMessageDispositionState(hdr, disposition) { state.dispositions.push({ hdr, disposition }); },
  };
  const hdr = { folder, messageId: "original", author: "author@example.test", subject: "Original", date: 0 };
  const sandbox = {
    Core,
    Cr: { NS_ERROR_FAILURE: 0x80004005, NS_ERROR_CONNECTION_REFUSED: 0x804b000d, NS_ERROR_UNKNOWN_HOST: 0x804b001e, NS_ERROR_UNKNOWN_PROXY_HOST: 0x804b002a, NS_ERROR_PROXY_CONNECTION_REFUSED: 0x804b0048 },
    Ci: {
      nsIMsgCompDeliverMode: modes, nsITimer: { TYPE_ONE_SHOT: 0 },
      nsIMsgCompType: { New: 0, Reply: 1, ReplyAll: 2, ForwardInline: 3 },
      nsIMsgFolder: { nsMsgDispositionState_Replied: 10, nsMsgDispositionState_Forwarded: 11 },
    },
    Cc: {
      "@mozilla.org/timer;1": { createInstance: () => timer },
      "@mozilla.org/messengercompose/composeparams;1": { createInstance: () => ({}) },
      "@mozilla.org/messengercompose/composefields;1": { createInstance: () => {
        state.fields = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, addAttachment() {} };
        return state.fields;
      } },
      "@mozilla.org/messengercompose/send;1": { createInstance: () => ({
        createAndSendMessage(...args) {
          state.calls.push(args);
          if (options.legacy && args.length === 16) {
            throw Object.assign(new Error("Not enough arguments"), { result: 0x80570001 });
          }
          if (options.createError) throw options.createError;
          state.listener = args[args.length === 16 ? 12 : 14];
          return options.legacy ? undefined : creation;
        },
      }) },
    },
    ChromeUtils: {
      generateQI: () => () => {},
      importESModule: () => ({ MsgHdrToMimeMessage: (msg, _listener, callback) => callback(msg, {}) }),
    },
    Components: { isSuccessCode: status => status === 0 },
    MailServices: {
      accounts: { accounts: [{ key: "account", identities: [identity] }] },
      messageServiceFromURI: () => ({ messageURIToMsgHdr: () => hdr }),
    },
    _pinnedAttachFiles: state.pinned = new Set(),
    _uncertainAttachFiles: state.uncertain = new Set(),
    activeClient: { id: "client" },
    queuedSaveRestriction(client) {
      state.queuedChecks = [...(state.queuedChecks || []), client];
      return options.queuedRefusal ? { error: options.queuedRefusal, operationState: "failed" } : null;
    },
    releaseOutgoingAttachments(descs) { state.released = [...(state.released || []), descs]; },
    // Whether a saved message is found in its folder (STORED MESSAGE CONFIRMATION).
    folderMessageKeys: (folderURI) => new Set([`known:${folderURI}`]),
    async confirmMessageStored(folderURI, messageIds, knownKeys) {
      state.confirmations = [...(state.confirmations || []), { folderURI, messageIds: [...messageIds], knownKeys: [...(knownKeys || [])] }];
      return options.stored !== false;
    },
    UNCONFIRMED_SAVE_ERROR: "Thunderbird finished the save, but the message could not be found in the intended folder. Check Drafts before retrying.",
    descsToMsgAttachments(descs) {
      if (options.attachmentError) throw options.attachmentError;
      return descs;
    },
    // Sent-copy (FCC) authorization of the identity.
    identitySentCopyAllowed: () => !options.sentCopyDenied,
    periodicFolderRestriction: () => options.periodic || null,
    parseRecipientsForCollection: (...headers) => headers.filter(Boolean).map(email => ({ email, name: "" })),
    addressCollectionRestriction(recipients) {
      state.collectionRecipients = recipients;
      return options.collection || null;
    },
    postOutgoingFilterRestriction(_identity, context = {}) {
      state.postOutgoingContexts = [...(state.postOutgoingContexts || []), context];
      return options.postOutgoing || null;
    },
    isSkipReviewBlocked: () => !!options.blocked,
    findMessage: () => ({ msgHdr: hdr, folder }),
    filePathsToAttachDescs: () => ({ descs: [] }),
    setComposeIdentity(params) { params.identity = identity; },
    resolveComposeFormat: () => ({ useHtml: false, format: 0 }),
    PREF_ALLOW_ENCRYPTED_MESSAGES: "encrypted",
    isPrivacyOptInEnabled: () => false,
    getDirectQuoteContent: () => ({ body: "Original body" }),
  };
  const dispositionStart = source.indexOf("function markMessageDispositionState(");
  const dispositionEnd = source.indexOf("// BEGIN DIRECT SEND HELPER", dispositionStart);
  assert.ok(dispositionStart >= 0 && dispositionEnd > dispositionStart, "Missing disposition helper boundaries");
  vm.createContext(sandbox);
  vm.runInContext([
    source.slice(dispositionStart, dispositionEnd), snippet("DIRECT SEND HELPER"),
    snippet("REPLY TOOL"), snippet("FORWARD TOOL"),
  ].join("\n"), sandbox);
  return {
    state, timer, hdr,
    start(tool = "direct", mode) {
      let result;
      if (tool === "reply") {
        result = sandbox.replyToMessage(options.messageId || "original", "folder", "Reply", false, false,
          undefined, undefined, undefined, undefined, undefined, true);
      } else if (tool === "forward") {
        result = sandbox.forwardMessage("original", "folder", "recipient@example.test", "Forward", false,
          undefined, undefined, undefined, undefined, true);
      } else {
        result = sandbox.sendMessageDirectly({ body: "Body", addAttachment() {} },
          options.noIdentity ? null : identity, options.attachDescs || [], "message-uri", 0, mode, "text/plain");
      }
      state.promise = result.then(value => { state.result = value; return value; });
      return state.promise;
    },
  };
}

async function assertPending(harness) {
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.state.result, undefined, "SMTP outcome must still be pending");
  assert.equal(harness.timer.cancelled, false, "delivery timer must stay active");
  assert.equal(harness.state.dispositions.length, 0);
}

const errors = [
  ["SMTP failure", h => h.state.listener.onStopSending("id", failure), /Send failed.*80004005/],
  ["send not performed", h => h.state.listener.onSendNotPerformed("id", failure), /Send was not performed/],
  ["transport security failure", h => h.state.listener.onTransportSecurityError("id", failure, {}, "smtp.example.test"), /Transport security error: smtp\.example\.test/],
  ["promise rejection", h => h.state.creationFailed(new Error("create rejected")), /create rejected/],
  ["timeout", h => h.timer.callback.notify(), /outcome is unknown; check Sent and the Outbox before retrying/],
];

describe("direct send SMTP completion", () => {
  for (const legacy of [false, true]) {
    for (const copyStatus of [0, failure]) {
      it(`waits through creation and Sent copy until SMTP succeeds, legacy=${legacy}, copy=${copyStatus}`, async () => {
        const h = loadSend({ legacy });
        const result = h.start(); // omitted mode also means Now
        h.state.deliveryStarted();
        h.state.listener.onStopCopy(copyStatus);
        h.state.listener.onStartSending();
        h.state.listener.onProgress();
        h.state.listener.onSendProgress();
        h.state.listener.onStatus();
        h.state.listener.onStartCopy();
        h.state.listener.setMessageKey();
        h.state.listener.onGetDraftFolderURI();
        await assertPending(h);
        assert.equal(h.timer.delay, 120000);
        assert.equal(h.state.calls.at(-1).length, legacy ? 18 : 16);
        h.state.listener.onStopSending("id", 0);
        assert.equal((await result).success, true);
        assert.equal(h.state.result.message, "Message sent");
        assert.equal(h.timer.cancelled, true);
      });
    }
  }

  for (const [label, trigger, pattern] of errors) {
    it(`reports ${label} after an early Sent copy, ignoring later success`, async () => {
      const h = loadSend();
      const result = h.start("direct", modes.Now);
      h.state.listener.onStopCopy(0);
      if (label !== "promise rejection") h.state.deliveryStarted();
      await assertPending(h);
      trigger(h);
      assert.match((await result).error, pattern);
      assert.equal(h.state.result.success, undefined);
      const original = h.state.result;
      h.state.listener.onStopSending("id", 0);
      h.state.listener.onStopCopy(0);
      h.state.deliveryStarted();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.state.result, original);
    });
  }

  it("retains confirmed SMTP success when copy or promise fails afterward", async () => {
    const h = loadSend();
    const result = h.start();
    h.state.listener.onStopSending("id", 0);
    h.state.listener.onStopCopy(failure);
    h.state.creationFailed(new Error("late rejection"));
    h.state.listener.onSendNotPerformed("id", failure);
    assert.equal((await result).success, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state.result.error, undefined);
  });

  for (const [label, options, pattern] of [
    ["missing identity", { noIdentity: true }, /No identity/],
    ["synchronous creation failure", { createError: new Error("create threw") }, /create threw/],
    ["attachment failure", { attachmentError: new Error("attachments invalid") }, /attachments invalid/],
    ["Sent copy into a restricted account", { sentCopyDenied: true }, /files sent copies into an account this client may not use/],
    ["address collection beyond the client's rights", { collection: "Thunderbird would add or change contacts" }, /Not sent: Thunderbird would add or change contacts/],
    ["Post-outgoing filter beyond the client's rights", { postOutgoing: "the Post-outgoing filter \"x\" would run" }, /Not sent: the Post-outgoing filter/],
  ]) {
    it(`reports ${label} without success`, async () => {
      const h = loadSend(options);
      const result = await h.start();
      assert.match(result.error, pattern);
      assert.equal(result.success, undefined);
      if (!options.createError) assert.equal(h.state.calls.length, 0);
    });
  }
});

describe("Post-outgoing filters of the reply's copy folder", () => {
  for (const followsParent of [false, true]) {
    it(`checks the original's folder too when replies follow the parent: ${followsParent}`, async () => {
      const h = loadSend({ followsParent });
      const result = h.start("reply");
      await new Promise(resolve => setImmediate(resolve));
      const contexts = h.state.postOutgoingContexts || [];
      assert.equal(contexts.length, 1);
      const extra = contexts[0].extraTargets || [];
      assert.equal(extra.length, followsParent ? 1 : 0);
      if (followsParent) {
        assert.equal(extra[0].server, h.hdr.folder.server);
        assert.equal(extra[0].folder, h.hdr.folder, "the actual folder (e.g. Trash) is passed on");
      }
      h.state.deliveryStarted();
      h.state.listener.onStopSending("id", 0);
      assert.equal((await result).success, true);
    });
  }
});

describe("draft and queued completion", () => {
  for (const mode of [modes.SaveAsDraft, modes.Later]) {
    for (const completion of ["promise", "copy"]) {
      it(`completes ${mode} only when the copy is confirmed (${completion} first)`, async () => {
        const h = loadSend();
        const result = h.start("direct", mode);
        if (completion === "promise") {
          // The promise fulfills once the copy has merely started.
          h.state.deliveryStarted();
          await new Promise(resolve => setImmediate(resolve));
          assert.equal(h.state.result, undefined, "not completed before onStopCopy");
          assert.equal(h.timer.cancelled, false);
        }
        h.state.listener.onStopCopy(0);
        assert.equal((await result).success, true);
        assert.equal(h.timer.cancelled, true);
      });
    }
    it(`reports a copy failure for ${mode} as unknown (Thunderbird may retry), even if creation later fulfills`, async () => {
      const h = loadSend();
      const result = h.start("direct", mode);
      h.state.listener.onStopCopy(failure);
      h.state.deliveryStarted();
      const value = await result;
      assert.match(value.error, /Save failed.*80004005.*check Drafts before retrying/);
      assert.equal(value.operationState, "unknown");
    });
  }
});

describe("reply and forward dispositions follow the SMTP result", () => {
  for (const tool of ["reply", "forward"]) {
    it(`marks ${tool} only after SMTP success`, async () => {
      const h = loadSend();
      const result = h.start(tool);
      h.state.deliveryStarted();
      h.state.listener.onStopCopy(0);
      await assertPending(h);
      h.state.listener.onStopSending("id", 0);
      assert.equal((await result).success, true);
      assert.deepEqual(h.state.dispositions, [{ hdr: h.hdr, disposition: tool === "reply" ? 10 : 11 }]);
      h.state.listener.onStopSending("id", 0);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(h.state.dispositions.length, 1);
    });
    for (const [label, trigger, pattern] of errors) {
      it(`does not mark ${tool} on ${label}, including late SMTP completion`, async () => {
        const h = loadSend();
        const result = h.start(tool);
        h.state.listener.onStopCopy(0);
        trigger(h);
        assert.match((await result).error, pattern);
        h.state.listener.onStopSending("id", 0);
        h.state.deliveryStarted();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.state.dispositions.length, 0);
        assert.equal(h.state.result.success, undefined);
      });
    }
    it(`keeps the skipReview block ahead of ${tool} delivery`, async () => {
      const h = loadSend({ blocked: true });
      assert.match((await h.start(tool)).error, /blocks skipReview/);
      assert.equal(h.state.calls.length, 0);
      assert.equal(h.state.dispositions.length, 0);
    });
  }
});

describe("operation states of direct delivery (Stage 5)", () => {
  const NET_RESET = 0x804b0014;
  const CONNECTION_REFUSED = 0x804b000d;

  it("reports completed after SMTP success", async () => {
    const h = loadSend();
    const result = h.start("direct", modes.Now);
    h.state.listener.onStartSending();
    h.state.listener.onStopSending("id", 0);
    assert.equal((await result).operationState, "completed");
  });

  for (const [label, started, status, expected] of [
    ["server rejection after the start", true, failure, "failed"],
    ["refused connection", true, CONNECTION_REFUSED, "failed"],
    ["reset before the start", false, NET_RESET, "failed"],
    ["reset after the start", true, NET_RESET, "unknown"],
  ]) {
    it(`reports ${expected} for a ${label}`, async () => {
      const h = loadSend();
      const result = h.start("direct", modes.Now);
      if (started) h.state.listener.onStartSending();
      h.state.listener.onStopSending("id", status);
      const value = await result;
      assert.equal(value.operationState, expected);
      assert.equal(value.success, undefined);
      if (expected === "unknown") assert.match(value.error, /may have accepted the message; check Sent before retrying/);
      else assert.doesNotMatch(value.error, /may have accepted/);
    });
  }

  it("reports unknown on timeout and on a rejection after the start", async () => {
    const timedOut = loadSend();
    const first = timedOut.start("direct", modes.Now);
    timedOut.timer.callback.notify();
    assert.equal((await first).operationState, "unknown");

    const rejected = loadSend();
    const second = rejected.start("direct", modes.Now);
    rejected.state.listener.onStartSending();
    rejected.state.creationFailed(new Error("late"));
    assert.equal((await second).operationState, "unknown");

    const early = loadSend();
    const third = early.start("direct", modes.Now);
    early.state.creationFailed(new Error("early"));
    assert.equal((await third).operationState, "failed");
  });

  it("reports failed when nothing was attempted", async () => {
    for (const listenerCall of ["onSendNotPerformed", "onTransportSecurityError"]) {
      const h = loadSend();
      const result = h.start("direct", modes.Now);
      h.state.listener[listenerCall]("id", failure, {}, "smtp.example.test");
      assert.equal((await result).operationState, "failed", listenerCall);
    }
    const thrown = await loadSend({ createError: new Error("create threw") }).start();
    assert.equal(thrown.operationState, "failed");
  });

  for (const [mode, expected] of [[modes.SaveAsDraft, "completed"], [modes.Later, "queued"]]) {
    for (const completion of ["promise", "copy"]) {
      it(`reports ${expected} for mode ${mode} after the confirmed copy (${completion} first)`, async () => {
        const h = loadSend();
        const result = h.start("direct", mode);
        if (completion === "promise") h.state.deliveryStarted();
        h.state.listener.onStopCopy(0);
        assert.equal((await result).operationState, expected);
      });
    }
    it(`reports unknown when only the promise fulfilled and the copy never confirmed (mode ${mode})`, async () => {
      const h = loadSend();
      const result = h.start("direct", mode);
      h.state.deliveryStarted();
      await new Promise(resolve => setImmediate(resolve));
      h.timer.callback.notify();
      assert.equal((await result).operationState, "unknown");
    });
    it(`reports failed when the message could not be created (mode ${mode})`, async () => {
      const h = loadSend();
      const result = h.start("direct", mode);
      h.state.creationFailed(new Error("message file could not be created"));
      assert.equal((await result).operationState, "failed");
    });
  }

  for (const tool of ["reply", "forward"]) {
    it(`keeps the state through ${tool}`, async () => {
      const h = loadSend();
      const result = h.start(tool);
      await new Promise(resolve => setImmediate(resolve));
      h.state.listener.onStartSending();
      h.state.listener.onStopSending("id", NET_RESET);
      assert.equal((await result).operationState, "unknown");
      assert.equal(h.state.dispositions.length, 0);
    });
  }
});

describe("private attachment copies after direct delivery (Stage 5)", () => {
  for (const [label, finish, released] of [
    ["completed", h => { h.state.listener.onStartSending(); h.state.listener.onStopSending("id", 0); }, true],
    ["failed", h => h.state.listener.onStopSending("id", failure), true],
    ["unknown (timeout)", h => h.timer.callback.notify(), false],
    ["unknown (reset after the start)", h => { h.state.listener.onStartSending(); h.state.listener.onStopSending("id", 0x804b0014); }, false],
  ]) {
    it(`${released ? "releases" : "keeps"} them when the outcome is ${label}`, async () => {
      const h = loadSend();
      const result = h.start("direct", modes.Now);
      finish(h);
      await result;
      assert.equal((h.state.released || []).length, released ? 1 : 0);
    });
  }

  it("releases them after a refusal before sending", async () => {
    const h = loadSend({ sentCopyDenied: true });
    await h.start();
    assert.equal(h.state.released.length, 1);
  });
});

describe("threading headers of a direct reply (Stage 5 review)", () => {
  it("uses the original's Message-ID, not a msgref: lookup reference", async () => {
    const h = loadSend({ messageId: "msgref:42:original" });
    const result = h.start("reply");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state.fields.references, "<original>");
    assert.equal(h.state.fields.headers["In-Reply-To"], "<original>");
    h.state.listener.onStopSending("id", 0);
    assert.equal((await result).success, true);
  });
});

describe("saved drafts must be found in their folder (Stage 5 review round 2)", () => {
  it("checks the intended folder, not Thunderbird's Local Folders fallback", async () => {
    const h = loadSend();
    const result = h.start("direct", modes.SaveAsDraft);
    h.state.listener.onGetDraftFolderURI("<d1@example.test>", "imap://user@example.test/Drafts");
    h.state.listener.onGetDraftFolderURI("<d1@example.test>", "mailbox://nobody@Local%20Folders/Drafts-user");
    h.state.listener.onStopCopy(0);
    const value = await result;
    assert.equal(value.operationState, "completed");
    assert.deepEqual({ ...h.state.confirmations[0] }, {
      folderURI: "imap://user@example.test/Drafts",
      messageIds: ["<d1@example.test>", undefined],
      knownKeys: ["known:imap://user@example.test/Drafts"],
    }, "keys of the intended folder, taken before the copy");
  });

  it("reports unknown when Thunderbird ends with status 0 but the draft is not there (failed copy, Don't Save)", async () => {
    const h = loadSend({ stored: false });
    const result = h.start("direct", modes.SaveAsDraft);
    h.state.listener.onGetDraftFolderURI("<d2@example.test>", "imap://user@example.test/Drafts");
    h.state.listener.onStopCopy(0);
    const value = await result;
    assert.equal(value.success, undefined);
    assert.equal(value.operationState, "unknown");
    assert.match(value.error, /could not be found in the intended folder/);
    assert.equal((h.state.released || []).length, 0, "copies stay after an unknown outcome");
  });
});

describe("direct saves run one at a time; their files are pinned (Stage 5 review round 3)", () => {
  const tick = () => new Promise(resolve => setImmediate(resolve));

  it("starts a second Drafts save only after the first one has finished", async () => {
    const h = loadSend();
    const first = h.start("direct", modes.SaveAsDraft);
    const firstListener = h.state.listener;
    const second = h.start("direct", modes.SaveAsDraft);
    await tick();
    assert.equal(h.state.calls.length, 1, "the second save waits");
    firstListener.onStopCopy(0);
    assert.equal((await first).operationState, "completed");
    await tick();
    assert.equal(h.state.calls.length, 2);
    h.state.listener.onStopCopy(0);
    assert.equal((await second).operationState, "completed");
  });

  it("does not queue immediate sends behind a save", async () => {
    const h = loadSend();
    h.start("direct", modes.SaveAsDraft);
    h.start("direct", modes.Now);
    assert.equal(h.state.calls.length, 2);
  });

  it("pins the operation's private files while it runs", async () => {
    const h = loadSend({ attachDescs: [{ tempPath: "/outgoing/1_1_a.txt" }] });
    h.start("direct", modes.Now);
    assert.ok(h.state.pinned.has("/outgoing/1_1_a.txt"));
  });
});

describe("a queued save is checked again before it starts (Stage 5 review round 4)", () => {
  const tick = () => new Promise(resolve => setImmediate(resolve));
  it("refuses a waiting save without creating the message if the client or destination changed", async () => {
    const h = loadSend({ queuedRefusal: "This client was removed or its settings changed while the save was waiting; nothing was saved." });
    const first = h.start("direct", modes.SaveAsDraft);
    const firstListener = h.state.listener;
    const second = h.start("direct", modes.SaveAsDraft);
    firstListener.onStopCopy(0);
    await first;
    const value = await second;
    await tick();
    assert.equal(h.state.calls.length, 1, "no message created for the refused save");
    assert.equal(value.operationState, "failed");
    assert.match(value.error, /while the save was waiting/);
    assert.deepEqual({ ...h.state.queuedChecks[0] }, { id: "client" }, "checked for the client of the call");
  });

  it("does not re-check a save that starts immediately", async () => {
    const h = loadSend({ queuedRefusal: "x" });
    h.start("direct", modes.SaveAsDraft);
    assert.equal(h.state.calls.length, 1);
    assert.equal(h.state.queuedChecks, undefined);
  });
});

describe("queuedSaveRestriction (Stage 5 review round 4)", () => {
  const { Core } = require("./helpers/core-modules.cjs");
  function load({ current = true, access = { folder: { getFlag: () => true } }, periodic = null } = {}) {
    const sandbox = {
      Core,
      Ci: { nsIMsgCompDeliverMode: modes, nsMsgFolderFlags: { Drafts: 0x400 } },
      clientRecordCurrent: () => current,
      getIdentityDraftFolderURI: () => "imap://user@example.test/Drafts",
      getAccessibleFolder: () => access,
      draftFolderPeriodicRestriction: () => periodic,
    };
    vm.createContext(sandbox);
    vm.runInContext(snippet("QUEUED SAVE CHECK"), sandbox);
    return (mode = modes.SaveAsDraft) => sandbox.queuedSaveRestriction({ id: "c" }, {}, mode);
  }
  it("allows an unchanged client and destination", () => {
    assert.equal(load()(), null);
  });
  for (const [label, options, pattern] of [
    ["a removed or changed client", { current: false }, /while the save was waiting/],
    ["an inaccessible Drafts folder", { access: { error: "Account not accessible" } }, /no longer accessible/],
    ["a folder without the Drafts flag", { access: { folder: { getFlag: () => false } } }, /no longer accessible/],
    ["a periodic rule on the Drafts folder", { periodic: { error: "periodic rule" } }, /Not saved: periodic rule/],
  ]) {
    it(`refuses ${label}`, () => {
      const result = load(options)();
      assert.match(result.error, pattern);
      assert.equal(result.operationState, "failed");
    });
  }
});