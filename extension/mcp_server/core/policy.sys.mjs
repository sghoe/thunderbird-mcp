// Pure core module: positive capabilities and per-call requirements
// (hardening Stage 4). No XPCOM, no imports; see attachment-source.sys.mjs.
//
// A call is allowed only if the calling client holds every capability the
// call's actual effect needs. Requirements are derived from the tool AND its
// effective arguments. Unknown tools and unknown arguments require a
// capability no client can hold, so tools or arguments added by an update
// never gain access automatically.

export const POLICY_VERSION = 1;

// Capability ids grouped by effect. Descriptions are shown in the options UI.
export const CAPABILITIES = Object.freeze({
  "accounts.read": "List accounts, identities and folders",
  "mail.metadata": "Search and list messages (headers, flags, tags)",
  "mail.body": "Read message text (Markdown/plain text and previews)",
  "mail.html": "Read unmodified HTML bodies",
  "mail.raw": "Read raw message source",
  "attachments.read": "Read inline images",
  "attachments.export": "Save attachments to local files",
  "files.attach": "Attach local files to outgoing mail",
  "mail.flag": "Mark read/unread, flag, tag",
  "mail.move": "Move and copy messages",
  "mail.delete": "Delete messages or folders (to Trash)",
  "mail.deletePermanent": "Permanently delete (empty Trash/Junk, delete from Trash)",
  "folders.write": "Create, rename and move folders",
  "gui.display": "Open messages in Thunderbird's window",
  "compose.draft": "Save drafts",
  "compose.review": "Open compose windows and dialogs for review",
  "compose.send": "Send mail without review",
  "contacts.read": "Read contacts",
  "contacts.write": "Create, change and delete contacts",
  "calendar.read": "Read calendars, events and tasks",
  "calendar.write": "Create, change and delete events and tasks",
  "calendar.schedule": "Changes that can notify attendees (invitations, updates, cancellations)",
  "filters.read": "List filters",
  "filters.manage": "Create, change, reorder and delete filters",
  "filters.run": "Run filters on existing mail",
  "filters.autosend": "Filters that automatically forward or reply",
  "filters.foreign": "Change, reorder or delete filter rules not created through MCP",
});

// Never granted; required for anything the policy does not know.
export const UNCLASSIFIED = "unclassified";

const READ_ONLY = [
  "accounts.read", "mail.metadata", "mail.body", "attachments.read",
  "contacts.read", "calendar.read", "filters.read",
];
const DRAFTS = [...READ_ONLY, "mail.flag", "compose.draft", "compose.review"];

export const PROFILES = Object.freeze({
  none: Object.freeze([]),
  "read-only": Object.freeze(READ_ONLY),
  drafts: Object.freeze(DRAFTS),
  automation: Object.freeze(Object.keys(CAPABILITIES)),
});

// Requirements are meant to be evaluated on coerced and validated arguments.
// For raw or unexpected values they fail closed: a value that is not clearly
// the harmless variant counts as the risky one, and a non-array where an
// array is expected is UNCLASSIFIED.
const nonEmpty = (v) => v !== undefined && v !== null;
// Adds requirements: anything but an explicit false/absent value.
const notFalse = (v) => nonEmpty(v) && v !== false && v !== "false";
// Mutations: the handler acts on any supplied value (null included).
const present = (v) => v !== undefined;
// Removes requirements: only an explicit true.
const isTrue = (v) => v === true || v === "true";
const arrayRule = (fn) => (v, all, ctx) => {
  if (!nonEmpty(v)) return [];
  if (!Array.isArray(v)) return [UNCLASSIFIED];
  return fn(v, all, ctx);
};
const htmlFormat = (v) => (!nonEmpty(v) || v === "markdown" || v === "text" ? [] : ["mail.html"]);

// The bridge reads local file paths itself and forwards their content
// inline, so the extension cannot tell its inline objects from client data.
// The caller passes { inlinedLocalFiles: true } for such requests.
const attachmentRule = arrayRule((v, _all, ctx) => {
  if (v.some((x) => typeof x === "string")) return ["files.attach"];
  if (v.some((x) => !x || typeof x !== "object")) return [UNCLASSIFIED];
  return ctx.inlinedLocalFiles && v.length ? ["files.attach"] : [];
});

// Capabilities matching the effect of each filter action when the filter
// runs (on new mail or via applyFilters).
const FILTER_ACTION_CAPABILITIES = Object.freeze({
  moveToFolder: ["mail.move"],
  copyToFolder: ["mail.move"],
  delete: ["mail.delete"],
  deleteFromServer: ["mail.deletePermanent"],
  forward: ["filters.autosend"],
  reply: ["filters.autosend"],
  markRead: ["mail.flag"],
  markUnread: ["mail.flag"],
  markFlagged: ["mail.flag"],
  addTag: ["mail.flag"],
  changePriority: ["mail.flag"],
  junkScore: ["mail.flag"],
  label: ["mail.flag"],
  killThread: ["mail.flag"],
  killSubthread: ["mail.flag"],
  watchThread: ["mail.flag"],
  stopExecution: [],
  leaveOnServer: [],
  fetchBody: [],
});

// Capabilities needed for filters with these actions ({type} objects or
// action names). Unknown actions are UNCLASSIFIED.
export function filterActionCapabilities(actions) {
  if (!Array.isArray(actions)) return [UNCLASSIFIED];
  const needed = new Set();
  for (const action of actions) {
    const type = typeof action === "string" ? action : action && typeof action === "object" ? action.type : undefined;
    const caps = typeof type === "string" && Object.hasOwn(FILTER_ACTION_CAPABILITIES, type)
      ? FILTER_ACTION_CAPABILITIES[type] : [UNCLASSIFIED];
    for (const cap of caps) needed.add(cap);
  }
  return [...needed].sort();
}

// Per tool: a fixed base requirement plus requirements for each argument.
// Every input property of every tool must appear here (enforced by
// test/policy.test.cjs against the tool schemas); `null` marks an argument
// that does not change the effect.
const COMPOSE_ARGS = {
  to: null, cc: null, bcc: null, body: null, isHtml: null, from: null,
  attachments: attachmentRule,
};

const TOOL_RULES = {
  listAccounts: { base: ["accounts.read"], args: {} },
  listFolders: { base: ["accounts.read"], args: { accountId: null, folderPath: null, format: null, favoritesOnly: null } },
  getAccountAccess: { base: ["accounts.read"], args: {} },

  searchMessages: {
    base: ["mail.metadata", "mail.body"],
    args: {
      query: null, folderPath: null, startDate: null, endDate: null, maxResults: null, offset: null,
      sortOrder: null, unreadOnly: null, flaggedOnly: null, tag: null, includeSubfolders: null,
      countOnly: null, searchBody: null, dedupByMessageId: null,
    },
  },
  getRecentMessages: {
    base: ["mail.metadata", "mail.body"],
    args: { folderPath: null, daysBack: null, maxResults: null, offset: null, unreadOnly: null, flaggedOnly: null, includeSubfolders: null },
  },
  getMessage: {
    base: ["mail.metadata", "mail.body"],
    args: {
      messageId: null, folderPath: null,
      bodyFormat: htmlFormat,
      rawSource: (v) => (notFalse(v) ? ["mail.raw"] : []),
      saveAttachments: (v) => (notFalse(v) ? ["attachments.export"] : []),
      includeInlineImages: (v) => (notFalse(v) ? ["attachments.read"] : []),
    },
  },
  getMessages: {
    base: ["mail.metadata", "mail.body"],
    args: {
      messages: null,
      bodyFormat: htmlFormat,
      rawSource: (v) => (notFalse(v) ? ["mail.raw"] : []),
      saveAttachments: (v) => (notFalse(v) ? ["attachments.export"] : []),
    },
  },
  displayMessage: { base: ["gui.display"], args: { messageId: null, folderPath: null, displayMode: null } },
  updateMessage: {
    // Even a no-op call reveals whether a message exists.
    base: ["mail.metadata"],
    args: {
      messageId: null, messageIds: null, folderPath: null,
      // read: null / flagged: null mean false (mark unread, unflag).
      read: (v) => (present(v) ? ["mail.flag"] : []),
      flagged: (v) => (present(v) ? ["mail.flag"] : []),
      addTags: (v) => (present(v) ? ["mail.flag"] : []),
      removeTags: (v) => (present(v) ? ["mail.flag"] : []),
      moveTo: (v) => (present(v) ? ["mail.move"] : []),
      copyTo: (v) => (present(v) ? ["mail.move"] : []),
      trash: (v) => (notFalse(v) ? ["mail.delete"] : []),
    },
  },
  // Deleting from Trash (or without a Trash folder / IMAP without move-to-trash)
  // is permanent; the handler requires mail.deletePermanent at runtime then.
  deleteMessages: { base: ["mail.delete"], args: { messageIds: null, folderPath: null } },

  createFolder: { base: ["folders.write"], args: { parentFolderPath: null, name: null } },
  renameFolder: { base: ["folders.write"], args: { folderPath: null, newName: null } },
  moveFolder: { base: ["folders.write"], args: { folderPath: null, newParentPath: null } },
  // Deleting a folder that is already in Trash is permanent.
  deleteFolder: { base: ["mail.delete", "mail.deletePermanent"], args: { folderPath: null } },
  emptyTrash: { base: ["mail.deletePermanent"], args: { accountId: null } },
  emptyJunk: { base: ["mail.deletePermanent"], args: { accountId: null } },

  sendMail: {
    base: [],
    args: { ...COMPOSE_ARGS, subject: null, includeSignature: null, skipReview: (v) => (notFalse(v) ? ["compose.send"] : ["compose.review"]) },
    // skipReview omitted still opens a review window.
    defaults: { skipReview: false },
  },
  saveDraft: {
    base: ["compose.draft"],
    args: {
      ...COMPOSE_ARGS, subject: null, includeSignature: null, inReplyTo: null, references: null,
      replaceMessageId: (v) => (nonEmpty(v) ? ["mail.metadata"] : []),
      replaceFolderPath: null,
    },
  },
  replyToMessage: {
    base: ["mail.metadata", "mail.body"],
    args: {
      ...COMPOSE_ARGS, messageId: null, folderPath: null, replyAll: null,
      skipReview: (v, all) => (notFalse(v) ? ["compose.send"] : isTrue(all.saveAsDraft) ? [] : ["compose.review"]),
      saveAsDraft: (v) => (notFalse(v) ? ["compose.draft"] : []),
    },
    defaults: { skipReview: false },
  },
  forwardMessage: {
    base: ["mail.metadata", "mail.body"],
    args: {
      ...COMPOSE_ARGS, messageId: null, folderPath: null,
      skipReview: (v) => (notFalse(v) ? ["compose.send"] : ["compose.review"]),
    },
    defaults: { skipReview: false },
  },

  listFilters: { base: ["filters.read"], args: { accountId: null } },
  createFilter: {
    base: ["filters.manage"],
    args: {
      accountId: null, name: null, enabled: null, type: null, conditions: null, insertAtIndex: null,
      actions: (v) => (nonEmpty(v) ? filterActionCapabilities(v) : []),
    },
  },
  updateFilter: {
    base: ["filters.manage"],
    args: {
      accountId: null, filterIndex: null, name: null, enabled: null, type: null, conditions: null,
      actions: (v) => (nonEmpty(v) ? filterActionCapabilities(v) : []),
    },
  },
  deleteFilter: { base: ["filters.manage"], args: { accountId: null, filterIndex: null } },
  reorderFilters: { base: ["filters.manage"], args: { accountId: null, fromIndex: null, toIndex: null } },
  // The stored filters' actions are checked by the handler at runtime
  // (filterActionCapabilities), as they are not part of the arguments.
  applyFilters: { base: ["filters.run"], args: { accountId: null, folderPath: null } },

  searchContacts: { base: ["contacts.read"], args: { query: null, maxResults: null } },
  getContact: { base: ["contacts.read"], args: { contactId: null } },
  createContact: {
    base: ["contacts.write"],
    args: {
      email: null, displayName: null, firstName: null, lastName: null, phones: null, addresses: null,
      organization: null, title: null, note: null, birthday: null, addressBookId: null,
    },
  },
  updateContact: {
    base: ["contacts.read", "contacts.write"],
    args: {
      contactId: null, email: null, displayName: null, firstName: null, lastName: null, phones: null,
      addresses: null, organization: null, title: null, note: null, birthday: null,
    },
  },
  deleteContact: { base: ["contacts.write"], args: { contactId: null } },

  listCalendars: { base: ["calendar.read"], args: {} },
  listCategories: { base: ["calendar.read"], args: {} },
  listEvents: { base: ["calendar.read"], args: { calendarId: null, startDate: null, endDate: null, maxResults: null } },
  listTasks: { base: ["calendar.read"], args: { calendarId: null, completed: null, dueBefore: null, maxResults: null } },
  createEvent: {
    base: [],
    args: {
      title: null, startDate: null, endDate: null, location: null, description: null, calendarId: null,
      allDay: null, status: null, showAs: null, categories: null, onlineMeeting: null, recurrence: null,
      attendees: arrayRule((v) => (v.length ? ["calendar.schedule"] : [])),
      skipReview: (v) => (notFalse(v) ? ["calendar.write"] : ["compose.review"]),
    },
    defaults: { skipReview: false },
  },
  // Updates and deletions of meetings may notify attendees: the handlers
  // require calendar.schedule at runtime when the stored item has attendees,
  // and the attendee guard (Block skipReview) still applies on top.
  updateEvent: {
    base: ["calendar.read", "calendar.write"],
    args: {
      eventId: null, calendarId: null, title: null, startDate: null, endDate: null, location: null,
      description: null, status: null, showAs: null, categories: null, onlineMeeting: null,
      recurrence: null, recurrenceId: null,
      attendees: (v) => (nonEmpty(v) ? ["calendar.schedule"] : []),
    },
  },
  deleteEvent: { base: ["calendar.read", "calendar.write"], args: { eventId: null, calendarId: null, recurrenceId: null } },
  createTask: {
    base: [],
    args: {
      title: null, dueDate: null, calendarId: null, description: null, priority: null, categories: null,
      skipReview: (v) => (notFalse(v) ? ["calendar.write"] : ["compose.review"]),
    },
    defaults: { skipReview: false },
  },
  updateTask: {
    base: ["calendar.read", "calendar.write"],
    args: {
      taskId: null, calendarId: null, title: null, dueDate: null, description: null,
      completed: null, percentComplete: null, priority: null,
    },
  },
};

export function knownTools() {
  return Object.keys(TOOL_RULES);
}

// Argument names the policy classifies for a tool (for coverage tests).
export function knownArguments(tool) {
  return Object.hasOwn(TOOL_RULES, tool) ? Object.keys(TOOL_RULES[tool].args) : [];
}

// Capabilities a call needs, derived from the tool and its effective
// arguments. Unknown tools/arguments yield UNCLASSIFIED. context carries
// facts about the request that are not in the arguments
// ({ inlinedLocalFiles }).
export function requiredCapabilities(tool, args = {}, context = {}) {
  if (typeof tool !== "string" || !Object.hasOwn(TOOL_RULES, tool)) return [UNCLASSIFIED];
  const rule = TOOL_RULES[tool];
  const input = { ...(rule.defaults || {}), ...(args && typeof args === "object" ? args : {}) };
  const ctx = context && typeof context === "object" ? context : {};
  const needed = new Set(rule.base);
  for (const [name, value] of Object.entries(input)) {
    if (!Object.hasOwn(rule.args, name)) { needed.add(UNCLASSIFIED); continue; }
    const effect = rule.args[name];
    if (typeof effect === "function") for (const cap of effect(value, input, ctx)) needed.add(cap);
  }
  return [...needed].sort();
}

// Normalises a stored capability list: unknown entries are dropped, so a
// corrupted or future value can never grant anything unexpected.
export function normalizeCapabilities(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((c) => typeof c === "string" && Object.hasOwn(CAPABILITIES, c)))].sort();
}

export function capabilitiesForProfile(profile) {
  return Object.hasOwn(PROFILES, profile) ? [...PROFILES[profile]] : [];
}

// Decision for one call. `granted` is the client's normalised capability
// list; returns { allowed, missing }.
export function decide(tool, args, granted, context = {}) {
  const have = new Set(normalizeCapabilities(granted));
  const missing = requiredCapabilities(tool, args, context).filter((c) => !have.has(c));
  return { allowed: missing.length === 0, missing };
}

// A tool is listed for a client if a legitimate call variant is allowed
// (arguments can still be refused per call).
export function isToolVisible(tool, granted) {
  if (!Object.hasOwn(TOOL_RULES, tool)) return false;
  const variants = [{}];
  const args = TOOL_RULES[tool].args;
  if (Object.hasOwn(args, "skipReview")) variants.push({ skipReview: true });
  if (Object.hasOwn(args, "saveAsDraft")) variants.push({ saveAsDraft: true });
  return variants.some((variant) => decide(tool, variant, granted).allowed);
}
