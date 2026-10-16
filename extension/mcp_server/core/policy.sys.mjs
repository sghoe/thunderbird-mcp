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

const nonEmpty = (v) => v !== undefined && v !== null;
const truthy = (v) => v === true || v === "true";
const attachmentsUseFiles = (a) => Array.isArray(a) && a.some((x) => typeof x === "string");

// Per tool: a fixed base requirement plus requirements for each argument.
// Every input property of every tool must appear here (enforced by
// test/policy.test.cjs against the tool schemas); `null` marks an argument
// that does not change the effect.
const COMPOSE_ARGS = {
  to: null, cc: null, bcc: null, body: null, isHtml: null, from: null,
  attachments: (v) => (attachmentsUseFiles(v) ? ["files.attach"] : []),
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
      bodyFormat: (v) => (v === "html" ? ["mail.html"] : []),
      rawSource: (v) => (truthy(v) ? ["mail.raw"] : []),
      saveAttachments: (v) => (truthy(v) ? ["attachments.export"] : []),
      includeInlineImages: (v) => (truthy(v) ? ["attachments.read"] : []),
    },
  },
  getMessages: {
    base: ["mail.metadata", "mail.body"],
    args: {
      messages: null,
      bodyFormat: (v) => (v === "html" ? ["mail.html"] : []),
      rawSource: (v) => (truthy(v) ? ["mail.raw"] : []),
      saveAttachments: (v) => (truthy(v) ? ["attachments.export"] : []),
    },
  },
  displayMessage: { base: ["gui.display"], args: { messageId: null, folderPath: null, displayMode: null } },
  updateMessage: {
    // Even a no-op call reveals whether a message exists.
    base: ["mail.metadata"],
    args: {
      messageId: null, messageIds: null, folderPath: null,
      read: (v) => (nonEmpty(v) ? ["mail.flag"] : []),
      flagged: (v) => (nonEmpty(v) ? ["mail.flag"] : []),
      addTags: (v) => (nonEmpty(v) ? ["mail.flag"] : []),
      removeTags: (v) => (nonEmpty(v) ? ["mail.flag"] : []),
      moveTo: (v) => (nonEmpty(v) ? ["mail.move"] : []),
      copyTo: (v) => (nonEmpty(v) ? ["mail.move"] : []),
      trash: (v) => (truthy(v) ? ["mail.delete"] : []),
    },
  },
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
    args: { ...COMPOSE_ARGS, subject: null, includeSignature: null, skipReview: (v) => (truthy(v) ? ["compose.send"] : ["compose.review"]) },
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
      skipReview: (v, all) => (truthy(v) ? ["compose.send"] : truthy(all.saveAsDraft) ? [] : ["compose.review"]),
      saveAsDraft: (v) => (truthy(v) ? ["compose.draft"] : []),
    },
    defaults: { skipReview: false },
  },
  forwardMessage: {
    base: ["mail.metadata", "mail.body"],
    args: {
      ...COMPOSE_ARGS, messageId: null, folderPath: null,
      skipReview: (v) => (truthy(v) ? ["compose.send"] : ["compose.review"]),
    },
    defaults: { skipReview: false },
  },

  listFilters: { base: ["filters.read"], args: { accountId: null } },
  createFilter: {
    base: ["filters.manage"],
    args: {
      accountId: null, name: null, enabled: null, type: null, conditions: null, insertAtIndex: null,
      actions: (v) => (sendsAutomatically(v) ? ["filters.autosend"] : []),
    },
  },
  updateFilter: {
    base: ["filters.manage"],
    args: {
      accountId: null, filterIndex: null, name: null, enabled: null, type: null, conditions: null,
      actions: (v) => (sendsAutomatically(v) ? ["filters.autosend"] : []),
    },
  },
  deleteFilter: { base: ["filters.manage"], args: { accountId: null, filterIndex: null } },
  reorderFilters: { base: ["filters.manage"], args: { accountId: null, fromIndex: null, toIndex: null } },
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
      attendees: (v) => (Array.isArray(v) && v.length ? ["calendar.schedule"] : []),
      skipReview: (v) => (truthy(v) ? ["calendar.write"] : ["compose.review"]),
    },
    defaults: { skipReview: false },
  },
  // Updates and deletions of meetings may notify attendees; the handler's
  // attendee guard still applies on top (Block skipReview).
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
      skipReview: (v) => (truthy(v) ? ["calendar.write"] : ["compose.review"]),
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

function sendsAutomatically(actions) {
  return Array.isArray(actions) && actions.some((a) => a && (a.type === "forward" || a.type === "reply"));
}

export function knownTools() {
  return Object.keys(TOOL_RULES);
}

// Argument names the policy classifies for a tool (for coverage tests).
export function knownArguments(tool) {
  return Object.hasOwn(TOOL_RULES, tool) ? Object.keys(TOOL_RULES[tool].args) : [];
}

// Capabilities a call needs, derived from the tool and its effective
// arguments. Unknown tools/arguments yield UNCLASSIFIED.
export function requiredCapabilities(tool, args = {}) {
  if (typeof tool !== "string" || !Object.hasOwn(TOOL_RULES, tool)) return [UNCLASSIFIED];
  const rule = TOOL_RULES[tool];
  const input = { ...(rule.defaults || {}), ...(args && typeof args === "object" ? args : {}) };
  const needed = new Set(rule.base);
  for (const [name, value] of Object.entries(input)) {
    if (!Object.hasOwn(rule.args, name)) { needed.add(UNCLASSIFIED); continue; }
    const effect = rule.args[name];
    if (typeof effect === "function") for (const cap of effect(value, input)) needed.add(cap);
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
export function decide(tool, args, granted) {
  const have = new Set(normalizeCapabilities(granted));
  const missing = requiredCapabilities(tool, args).filter((c) => !have.has(c));
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
