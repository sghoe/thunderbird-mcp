"use strict";

// Legitimate workflows for all 40 tools against the synthetic profile.
// Used for the native functional baseline (upstream v0.9.2 vs. this fork)
// and as a native regression run after every stage. Records the outcome and
// the result *shape* of each call; content is synthetic and deterministic.

const f = require("./fixtures.cjs");
const h = require("./harness.cjs");

const INBOX = "mailbox://alice@127.0.0.1/Inbox";
const DRAFTS = "mailbox://alice@127.0.0.1/Drafts";
const TRASH = "mailbox://alice@127.0.0.1/Trash";
const LOCAL_ROOT = "mailbox://nobody@Local%20Folders";

function mailboxes() {
  return {
    alice: {
      Inbox:
        f.plainWithAttachment() +
        f.inlineImage() +
        f.simple({ id: "thread-1@allowed.test", from: "Carol <carol@sender.test>", to: f.ALLOWED_EMAIL, subject: "Project kickoff", text: "Kickoff on Monday." }) +
        f.simple({ id: "thread-2@allowed.test", from: "Dave <dave@sender.test>", to: f.ALLOWED_EMAIL, subject: "Re: Project kickoff", text: "Sounds good." }) +
        f.simple({ id: "delete-me@allowed.test", from: "Erin <erin@sender.test>", to: f.ALLOWED_EMAIL, subject: "Disposable", text: "Delete me." }) +
        f.simple({ id: "move-me@allowed.test", from: "Erin <erin@sender.test>", to: f.ALLOWED_EMAIL, subject: "Movable", text: "Move me." }),
      Junk: f.simple({ id: "junk-1@allowed.test", from: "Spam <spam@sender.test>", to: f.ALLOWED_EMAIL, subject: "Junk", text: "Junk." }),
    },
  };
}

// Type/keys summary that is stable across runs.
function shape(value, depth = 0) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return value.length ? [shape(value[0], depth + 1)] : [];
  if (typeof value === "object") {
    if (depth > 2) return "object";
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shape(value[k], depth + 1)]));
  }
  return typeof value;
}

async function closeComposeWindows(tb) {
  await tb.marionette.run(`
    let n = 0;
    for (const win of [...Services.wm.getEnumerator("msgcompose")]) { win.close(); n++; }
    return n;
  `);
}

async function runScenarios(tb) {
  const results = [];
  const ctx = {};
  async function step(label, tool, args, after) {
    const r = await tb.call(tool, args);
    const result = r.rpcError ? { rpcError: r.rpcError.message } : r.result;
    const ok = !r.rpcError && !(result && typeof result === "object" && !Array.isArray(result) && result.error);
    results.push({ label, tool, ok, error: ok ? undefined : (r.rpcError?.message || result?.error), shape: shape(result) });
    if (after) await after(result);
    return result;
  }

  await tb.waitForMessages(INBOX, 6);

  // Accounts and folders
  await step("listAccounts", "listAccounts", {});
  await step("getAccountAccess", "getAccountAccess", {});
  await step("listFolders all", "listFolders", {});
  await step("listFolders table", "listFolders", { accountId: "account1", format: "table" });

  // Reading
  await step("searchMessages query", "searchMessages", { query: "kickoff", folderPath: INBOX });
  await step("searchMessages from:", "searchMessages", { query: "from:carol", folderPath: INBOX });
  await step("searchMessages paginated", "searchMessages", { query: "", folderPath: INBOX, offset: 0, maxResults: 2 });
  await step("searchMessages countOnly", "searchMessages", { query: "", folderPath: INBOX, countOnly: true });
  await step("getRecentMessages", "getRecentMessages", { folderPath: INBOX, daysBack: 100000, maxResults: 10 });
  for (const bodyFormat of ["markdown", "text", "html"]) {
    await step(`getMessage ${bodyFormat}`, "getMessage", { messageId: "inline-image@allowed.test", folderPath: INBOX, bodyFormat });
  }
  await step("getMessage rawSource", "getMessage", { messageId: "thread-1@allowed.test", folderPath: INBOX, rawSource: true });
  await step("getMessage saveAttachments", "getMessage", { messageId: "plain-attach@allowed.test", folderPath: INBOX, saveAttachments: true },
    (r) => { ctx.exportedFile = r?.attachments?.[0]?.filePath; });
  await step("getMessage includeInlineImages", "getMessage", { messageId: "inline-image@allowed.test", folderPath: INBOX, includeInlineImages: true });
  await step("getMessages batch", "getMessages", { messages: [
    { messageId: "thread-1@allowed.test", folderPath: INBOX },
    { messageId: "thread-2@allowed.test", folderPath: INBOX },
  ] });
  await step("displayMessage 3pane", "displayMessage", { messageId: "thread-1@allowed.test", folderPath: INBOX });
  await step("displayMessage tab", "displayMessage", { messageId: "thread-1@allowed.test", folderPath: INBOX, displayMode: "tab" });

  // Message changes
  await step("updateMessage read/flag/tag", "updateMessage", { messageId: "thread-1@allowed.test", folderPath: INBOX, read: true, flagged: true, addTags: ["$label1"] });

  // Folders
  await step("createFolder", "createFolder", { parentFolderPath: LOCAL_ROOT, name: "ParityFolder" });
  await step("createFolder target", "createFolder", { parentFolderPath: LOCAL_ROOT, name: "ParityParent" });
  await step("renameFolder", "renameFolder", { folderPath: `${LOCAL_ROOT}/ParityFolder`, newName: "ParityRenamed" });
  await h.sleep(500);
  await step("moveFolder", "moveFolder", { folderPath: `${LOCAL_ROOT}/ParityRenamed`, newParentPath: `${LOCAL_ROOT}/ParityParent` });
  await h.sleep(500);
  await step("updateMessage copyTo", "updateMessage", { messageId: "thread-2@allowed.test", folderPath: INBOX, copyTo: `${LOCAL_ROOT}/ParityParent` });
  await step("updateMessage moveTo", "updateMessage", { messageId: "move-me@allowed.test", folderPath: INBOX, moveTo: `${LOCAL_ROOT}/ParityParent` });
  await step("deleteMessages", "deleteMessages", { messageIds: ["delete-me@allowed.test"], folderPath: INBOX });
  await step("deleteFolder", "deleteFolder", { folderPath: `${LOCAL_ROOT}/ParityParent` });
  await h.sleep(500);
  await step("emptyTrash", "emptyTrash", { accountId: "account1" });
  await step("emptyJunk", "emptyJunk", { accountId: "account1" });

  // Compose
  await step("sendMail review", "sendMail", { to: "dest@sink.test", subject: "Review", body: "Hello" });
  await step("sendMail direct", "sendMail", { to: "dest@sink.test", subject: "Direct", body: "Hello", attachments: [{ name: "a.txt", base64: Buffer.from("x").toString("base64") }], skipReview: true });
  if (ctx.exportedFile) {
    await step("sendMail direct with exported file", "sendMail", { to: "dest@sink.test", subject: "Reattach", body: "Hello", attachments: [ctx.exportedFile], skipReview: true });
  }
  await step("saveDraft new", "saveDraft", { to: "dest@sink.test", subject: "Parity draft", body: "Draft body" });
  await h.sleep(1000);
  const drafts = await tb.waitForMessages(DRAFTS, 1).catch(() => []);
  if (drafts[0]) {
    await step("saveDraft replace", "saveDraft", { to: "dest@sink.test", subject: "Parity draft v2", body: "Draft body 2", replaceMessageId: drafts[0].id, replaceFolderPath: DRAFTS, from: f.ALLOWED_EMAIL });
  }
  await step("replyToMessage review", "replyToMessage", { messageId: "thread-1@allowed.test", folderPath: INBOX, body: "Thanks" });
  await step("replyToMessage direct", "replyToMessage", { messageId: "thread-1@allowed.test", folderPath: INBOX, body: "Thanks", skipReview: true });
  await step("replyToMessage saveAsDraft", "replyToMessage", { messageId: "thread-2@allowed.test", folderPath: INBOX, body: "Draft reply", saveAsDraft: true });
  await step("forwardMessage review", "forwardMessage", { messageId: "plain-attach@allowed.test", folderPath: INBOX, to: "dest@sink.test" });
  await step("forwardMessage direct", "forwardMessage", { messageId: "plain-attach@allowed.test", folderPath: INBOX, to: "dest@sink.test", skipReview: true });
  await closeComposeWindows(tb);

  // Filters
  await step("listFilters", "listFilters", { accountId: "account1" });
  await step("createFilter", "createFilter", { accountId: "account1", name: "Parity filter", conditions: [{ attrib: "subject", op: "contains", value: "kickoff" }], actions: [{ type: "markRead" }] });
  await step("createFilter second", "createFilter", { accountId: "account1", name: "Parity filter 2", type: 16, conditions: [{ attrib: "from", op: "contains", value: "carol" }], actions: [{ type: "markFlagged" }] });
  await step("updateFilter", "updateFilter", { accountId: "account1", filterIndex: 0, enabled: false });
  await step("reorderFilters", "reorderFilters", { accountId: "account1", fromIndex: 1, toIndex: 0 });
  await step("applyFilters", "applyFilters", { accountId: "account1", folderPath: INBOX });
  await step("deleteFilter", "deleteFilter", { accountId: "account1", filterIndex: 0 });

  // Contacts
  await step("createContact", "createContact", { email: "frank@contact.test", displayName: "Frank Contact", phones: [{ type: "work", number: "+49 30 1234" }] },
    (r) => { ctx.contactId = r?.contactId || r?.contact?.id || r?.id; });
  await step("searchContacts", "searchContacts", { query: "frank" });
  if (ctx.contactId) {
    await step("getContact", "getContact", { contactId: ctx.contactId });
    await step("updateContact", "updateContact", { contactId: ctx.contactId, title: "Engineer" });
    await step("deleteContact", "deleteContact", { contactId: ctx.contactId });
  }

  // Calendar and tasks
  await step("listCalendars", "listCalendars", {});
  await step("listCategories", "listCategories", {});
  await step("createEvent direct", "createEvent", { title: "Parity event", startDate: "2030-01-07T10:00:00Z", endDate: "2030-01-07T11:00:00Z", calendarId: "testcal", recurrence: "FREQ=WEEKLY;COUNT=3", skipReview: true },
    (r) => { ctx.eventId = r?.eventId || r?.event?.id || r?.id; });
  await step("createEvent review", "createEvent", { title: "Parity review event", startDate: "2030-01-08T10:00:00Z", calendarId: "testcal" });
  await step("listEvents", "listEvents", { calendarId: "testcal", startDate: "2030-01-01", endDate: "2030-02-01" },
    (r) => { if (!ctx.eventId && Array.isArray(r)) ctx.eventId = r[0]?.id; });
  if (ctx.eventId) {
    await step("updateEvent series", "updateEvent", { eventId: ctx.eventId, calendarId: "testcal", location: "Room 1" });
    await step("updateEvent occurrence", "updateEvent", { eventId: ctx.eventId, calendarId: "testcal", recurrenceId: "2030-01-14T10:00:00Z", title: "Moved" });
    await step("deleteEvent occurrence", "deleteEvent", { eventId: ctx.eventId, calendarId: "testcal", recurrenceId: "2030-01-21T10:00:00Z" });
    await step("deleteEvent series", "deleteEvent", { eventId: ctx.eventId, calendarId: "testcal" });
  }
  await step("createTask direct", "createTask", { title: "Parity task", dueDate: "2030-02-01", calendarId: "testcal", skipReview: true },
    (r) => { ctx.taskId = r?.taskId || r?.task?.id || r?.id; });
  await step("createTask review", "createTask", { title: "Parity review task", calendarId: "testcal" });
  await step("listTasks", "listTasks", { calendarId: "testcal" },
    (r) => { if (!ctx.taskId && Array.isArray(r)) ctx.taskId = r[0]?.id; });
  if (ctx.taskId) {
    await step("updateTask", "updateTask", { taskId: ctx.taskId, calendarId: "testcal", percentComplete: 50 });
  }
  await closeComposeWindows(tb).catch(() => {});

  await h.sleep(2000);
  return { results, smtpMessages: tb.smtp.messages.length, tools: [...new Set(results.map((r) => r.tool))].sort() };
}

module.exports = { mailboxes, runScenarios, shape, INBOX, DRAFTS, TRASH, LOCAL_ROOT };
