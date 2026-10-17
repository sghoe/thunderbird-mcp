// `browser` is declared as a global in eslint.config.mjs for the
// extension/ file group. Per-file /* global browser */ triggered
// no-redeclare.
"use strict";

const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const serverPort = document.getElementById("serverPort");
const connFile = document.getElementById("connFile");
const buildInfo = document.getElementById("buildInfo");
const accountList = document.getElementById("accountList");
const saveBtn = document.getElementById("saveBtn");
const saveStatus = document.getElementById("saveStatus");

const toolList = document.getElementById("toolList");
const saveToolsBtn = document.getElementById("saveToolsBtn");
const saveToolsStatus = document.getElementById("saveToolsStatus");

// BEGIN OPTIONS CLIENT ELEMENTS
const clientList = document.getElementById("clientList");
const clientRegistryError = document.getElementById("clientRegistryError");
const removeAllClientsBtn = document.getElementById("removeAllClientsBtn");
const clientNameInput = document.getElementById("clientName");
const clientProfileSelect = document.getElementById("clientProfile");
const clientCapabilityList = document.getElementById("clientCapabilityList");
const clientAccountList = document.getElementById("clientAccountList");
const clientCalendarsCheckbox = document.getElementById("clientCalendars");
const clientAddressBooksCheckbox = document.getElementById("clientAddressBooks");
const createClientBtn = document.getElementById("createClientBtn");
const clientStatus = document.getElementById("clientStatus");
const clientTokenBox = document.getElementById("clientTokenBox");
const clientTokenInput = document.getElementById("clientToken");
const copyClientTokenBtn = document.getElementById("copyClientTokenBtn");
// END OPTIONS CLIENT ELEMENTS

// BEGIN OPTIONS ACCESS STATE
let currentAccounts = [];
let currentTools = [];
let getMessagesLimitInput = null;
let getMessagesLimitStatus = null;
let currentAccountError = "";
let accountAccessChanged = false;
let currentToolError = "";
let currentGetMessagesLimit = "";
let toolAccessChanged = false;
let toolSettingsChanged = false;

// CRUD labels for sub-group headers
const CRUD_LABELS = { read: "Read", create: "Create", update: "Update", delete: "Delete" };

function validateGetMessagesLimitInput() {
  if (!getMessagesLimitInput) return undefined;
  const min = Number(getMessagesLimitInput.dataset.min || "1");
  const max = Number(getMessagesLimitInput.dataset.max || "20");
  const rawValue = getMessagesLimitInput.value.trim();
  const value = Number(rawValue);
  const valid = /^\d+$/.test(rawValue) && Number.isInteger(value) && value >= min && value <= max;
  if (!valid) {
    getMessagesLimitInput.setAttribute("aria-invalid", "true");
    if (getMessagesLimitStatus) {
      getMessagesLimitStatus.textContent = `Enter an integer from ${min} to ${max}.`;
    }
    return null;
  }
  getMessagesLimitInput.removeAttribute("aria-invalid");
  if (getMessagesLimitStatus) {
    getMessagesLimitStatus.textContent = "";
  }
  return value;
}
// END OPTIONS ACCESS STATE

// BEGIN OPTIONS SERVER STATUS
const retryServerBtn = document.getElementById("retryServerBtn");

async function loadServerInfo() {
  try {
    const info = await browser.mcpServer.getServerInfo();
    retryServerBtn.hidden = info.running || !info.lastError;
    if (info.running) {
      statusDot.className = "status-dot running";
      statusText.textContent = "Running";
      serverPort.textContent = info.port || "--";
      connFile.textContent = info.connectionFile || "--";
    } else {
      statusDot.className = "status-dot stopped";
      statusText.textContent = info.lastError ? "Failed to start: " + info.lastError : "Not running";
      serverPort.textContent = "--";
      connFile.textContent = "--";
    }
    if (info.buildVersion) {
      // Parse git describe: "v0.2.0-7-g1461f1a+dirty" → tag, commits, hash, dirty
      const m = info.buildVersion.match(/^(v[\d.]+)(?:-(\d+)-g([0-9a-f]+))?(\+dirty)?$/);
      let display;
      if (m) {
        const [, tag, commits, hash, dirty] = m;
        display = tag;
        if (commits && commits !== "0") display += ` +${commits}`;
        display += ` (${hash || tag})`;
        if (dirty) {
          display += " +dirty";
          if (info.buildDate) {
            display += " " + info.buildDate.replace("T", " ").replace(/\.\d+Z$/, " UTC");
          }
        }
      } else {
        display = info.buildVersion;
      }
      buildInfo.textContent = display;
    } else {
      buildInfo.textContent = "--";
    }
  } catch (e) {
    statusDot.className = "status-dot stopped";
    statusText.textContent = "Error: " + e.message;
    serverPort.textContent = "--";
    connFile.textContent = "--";
  }
}

retryServerBtn.addEventListener("click", async () => {
  retryServerBtn.disabled = true;
  statusText.textContent = "Starting...";
  try {
    const result = await browser.mcpServer.start();
    await loadServerInfo();
    if (result.success) await loadAuthenticationConfig();
  } catch (e) {
    statusDot.className = "status-dot stopped";
    statusText.textContent = "Failed to start: " + e.message;
  } finally {
    retryServerBtn.disabled = false;
  }
});
// END OPTIONS SERVER STATUS

// BEGIN OPTIONS CLIENTS
// Pairing happens only here, in the trusted options page. Names come from
// the user and account names from Thunderbird; both are inserted as text.
let clientCatalogue = { capabilities: [], profiles: {}, accounts: [] };

// Result of revoking clients: registered Forward/Reply rules that were
// disabled, and rules that need the user's decision.
function describeFilterRevocation(filters) {
  if (!filters) return "";
  const parts = [];
  if (filters.disabled?.length) {
    parts.push(`Disabled automatic sending rules: ${filters.disabled.map(r => `"${r.name}" (${r.account})`).join(", ")}.`);
  }
  if (filters.conflicts?.length) {
    parts.push(`Please check these rules yourself: ${filters.conflicts.map(r => r.name ? `"${r.name}" (${r.account}): ${r.reason}` : r.reason).join("; ")}.`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function setClientStatus(message, error = false) {
  clientStatus.textContent = message;
  clientStatus.className = error ? "save-status error" : "save-status";
}

function checkboxItem(list, value, label, checked = false) {
  const li = document.createElement("li");
  const lab = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.value = value;
  box.checked = checked;
  const span = document.createElement("span");
  span.textContent = label;
  lab.append(box, " ", span);
  li.append(lab);
  list.append(li);
  return box;
}

function checkedValues(list) {
  return [...list.querySelectorAll("input[type=checkbox]")].filter(b => b.checked).map(b => b.value);
}

function applyProfileSelection() {
  const granted = new Set(clientCatalogue.profiles[clientProfileSelect.value] || []);
  const custom = clientProfileSelect.value === "custom";
  for (const box of clientCapabilityList.querySelectorAll("input[type=checkbox]")) {
    if (!custom) box.checked = granted.has(box.value);
    box.disabled = !custom;
  }
}

function showClientToken(token) {
  clientTokenInput.value = token;
  clientTokenBox.hidden = false;
}

function renderClients(clients) {
  clientList.replaceChildren();
  if (!clients.length) {
    const li = document.createElement("li");
    li.textContent = "No clients paired. MCP requests are refused until you pair one.";
    clientList.append(li);
    return;
  }
  for (const client of clients) {
    const li = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = client.name;
    const details = document.createElement("span");
    const accounts = client.accounts.length ? client.accounts.join(", ") : "none";
    details.textContent = ` — ${client.profile}; ${client.capabilities.length} capabilities; accounts: ${accounts}` +
      `${client.calendars ? "; calendars" : ""}${client.addressBooks ? "; address books" : ""}`;
    const rotate = document.createElement("button");
    rotate.textContent = "New token";
    rotate.addEventListener("click", async () => {
      const result = await browser.mcpServer.rotateClientToken(client.id);
      if (result.error) return setClientStatus(result.error, true);
      showClientToken(result.token);
      setClientStatus(`New token for "${client.name}"; the old one no longer works.`);
    });
    const revoke = document.createElement("button");
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", async () => {
      const result = await browser.mcpServer.deleteClient(client.id);
      if (result.error) return setClientStatus(result.error, true);
      setClientStatus(`Revoked "${client.name}".${describeFilterRevocation(result.filters)}`, !!result.filters?.conflicts?.length);
      await loadAuthenticationConfig();
    });
    li.append(title, details, " ", rotate, " ", revoke);
    clientList.append(li);
  }
}

// Kept under this name: the server status Retry button refreshes it.
async function loadAuthenticationConfig() {
  try {
    const data = await browser.mcpServer.listClients();
    clientCatalogue = data;
    clientRegistryError.hidden = !data.corrupt;
    renderClients(data.clients || []);
    clientProfileSelect.replaceChildren();
    for (const name of [...Object.keys(data.profiles), "custom"]) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      clientProfileSelect.append(option);
    }
    clientProfileSelect.value = "none";
    clientCapabilityList.replaceChildren();
    for (const cap of data.capabilities) checkboxItem(clientCapabilityList, cap.id, `${cap.description} (${cap.id})`);
    clientAccountList.replaceChildren();
    for (const account of data.accounts) checkboxItem(clientAccountList, account.id, account.name);
    applyProfileSelection();
  } catch (e) {
    setClientStatus("Error loading clients: " + e.message, true);
  }
}

clientProfileSelect.addEventListener("change", applyProfileSelection);

createClientBtn.addEventListener("click", async () => {
  createClientBtn.disabled = true;
  try {
    const result = await browser.mcpServer.createClient({
      name: clientNameInput.value.trim(),
      profile: clientProfileSelect.value,
      capabilities: checkedValues(clientCapabilityList),
      accounts: checkedValues(clientAccountList),
      calendars: clientCalendarsCheckbox.checked,
      addressBooks: clientAddressBooksCheckbox.checked,
    });
    if (result.error) {
      setClientStatus(result.error, true);
    } else {
      showClientToken(result.token);
      setClientStatus(`Paired "${result.client.name}".`);
      clientNameInput.value = "";
      await loadAuthenticationConfig();
    }
  } catch (e) {
    setClientStatus("Error: " + e.message, true);
  }
  createClientBtn.disabled = false;
});

copyClientTokenBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(clientTokenInput.value);
    setClientStatus("Token copied.");
  } catch (e) {
    setClientStatus("Error: " + e.message, true);
  }
});

removeAllClientsBtn.addEventListener("click", async () => {
  const result = await browser.mcpServer.removeAllClients();
  if (result.error) return setClientStatus(result.error, true);
  setClientStatus(`All clients removed.${describeFilterRevocation(result.filters)}`, !!result.filters?.conflicts?.length);
  await loadAuthenticationConfig();
});
// END OPTIONS CLIENTS
// BEGIN OPTIONS ACCOUNT ACCESS
async function loadAccountAccess() {
  saveBtn.disabled = true;
  accountAccessChanged = false;
  try {
    const data = await browser.mcpServer.getAccountAccessConfig();
    currentAccounts = data.accounts || [];
    currentAccountError = data.mode === "error"
      ? (data.error || "Invalid account access configuration.") + " Access is blocked. Select allowed accounts and save to replace this setting."
      : "";
    saveStatus.textContent = currentAccountError;
    saveStatus.className = currentAccountError ? "save-status error" : "save-status";

    if (currentAccounts.length === 0) {
      accountList.innerHTML = "<li>No accounts found.</li>";
      return;
    }

    accountList.innerHTML = "";
    for (const acct of currentAccounts) {
      const li = document.createElement("li");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = "acct-" + acct.id;
      checkbox.value = acct.id;
      checkbox.checked = acct.allowed;
      checkbox.addEventListener("change", onAccountChange);

      const label = document.createElement("label");
      label.htmlFor = checkbox.id;
      label.textContent = acct.name;

      const typeSpan = document.createElement("span");
      typeSpan.className = "account-type";
      typeSpan.textContent = acct.type;
      label.appendChild(typeSpan);

      li.appendChild(checkbox);
      li.appendChild(label);
      accountList.appendChild(li);
    }
  } catch (e) {
    accountList.innerHTML = "";
    const li = document.createElement("li");
    li.textContent = "Error loading accounts: " + e.message;
    accountList.appendChild(li);
  }
}

function onAccountChange() {
  const checkboxes = accountList.querySelectorAll('input[type="checkbox"]');
  accountAccessChanged = [...checkboxes].some(cb =>
    cb.checked !== !!currentAccounts.find(acct => acct.id === cb.value)?.allowed
  );
  saveBtn.disabled = !accountAccessChanged;
  saveStatus.textContent = currentAccountError;
  saveStatus.className = currentAccountError ? "save-status error" : "save-status";
}

saveBtn.addEventListener("click", async () => {
  if (!accountAccessChanged) return;
  saveBtn.disabled = true;
  saveStatus.textContent = "";
  saveStatus.className = "save-status";

  const checkboxes = accountList.querySelectorAll('input[type="checkbox"]');
  const checked = [];
  let allChecked = true;
  for (const cb of checkboxes) {
    if (cb.checked) {
      checked.push(cb.value);
    } else {
      allChecked = false;
    }
  }

  if (checked.length === 0) {
    saveStatus.textContent = "Select at least one account. The existing access setting has not changed.";
    saveStatus.className = "save-status error";
    saveBtn.disabled = false;
    return;
  }

  // If all are checked, send empty array (= allow all)
  const allowedIds = allChecked ? [] : checked;

  try {
    const result = await browser.mcpServer.setAccountAccess(allowedIds);
    if (result.error) {
      saveStatus.textContent = result.error;
      saveStatus.className = "save-status error";
    } else {
      saveStatus.textContent = "Saved.";
      // Reload to reflect updated state
      await loadAccountAccess();
    }
  } catch (e) {
    saveStatus.textContent = "Error: " + e.message;
    saveStatus.className = "save-status error";
  }
  saveBtn.disabled = !accountAccessChanged;
});
// END OPTIONS ACCOUNT ACCESS

// BEGIN OPTIONS TOOL ACCESS
async function loadToolAccess() {
  saveToolsBtn.disabled = true;
  toolAccessChanged = false;
  toolSettingsChanged = false;
  try {
    const data = await browser.mcpServer.getToolAccessConfig();
    currentTools = data.tools || [];
    const groupLabels = data.groups || {};
    currentToolError = data.mode === "error"
      ? (data.error || "Invalid tool access configuration.") + " Optional tools are blocked. Change tool access and save to replace this setting."
      : "";
    saveToolsStatus.textContent = currentToolError;
    saveToolsStatus.className = currentToolError ? "save-status error" : "save-status";

    if (currentTools.length === 0) {
      toolList.innerHTML = "<li>No tools found.</li>";
      return;
    }

    toolList.innerHTML = "";
    getMessagesLimitInput = null;
    getMessagesLimitStatus = null;

    // Tools arrive pre-sorted by group then CRUD order from the server.
    // Build grouped structure from tool metadata.
    let currentGroup = null;
    let currentCrud = null;

    for (const tool of currentTools) {
      const group = tool.group || "other";
      const crud = tool.crud || "other";

      // New group header
      if (group !== currentGroup) {
        currentGroup = group;
        currentCrud = null;
        const header = document.createElement("li");
        header.className = "tool-group-header";
        header.textContent = groupLabels[group] || group.charAt(0).toUpperCase() + group.slice(1);
        toolList.appendChild(header);
      }

      // New CRUD sub-header within group
      if (crud !== currentCrud) {
        currentCrud = crud;
        const subHeader = document.createElement("li");
        subHeader.className = "tool-crud-header";
        subHeader.textContent = CRUD_LABELS[crud] || crud.charAt(0).toUpperCase() + crud.slice(1);
        toolList.appendChild(subHeader);
      }

      const li = document.createElement("li");
      if (tool.name === "getMessages") {
        li.className = "tool-with-option";
      }
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = "tool-" + tool.name;
      checkbox.value = tool.name;
      checkbox.checked = tool.enabled;
      if (tool.undisableable) {
        checkbox.disabled = true;
      }
      checkbox.addEventListener("change", () => {
        if (tool.name === "getMessages" && getMessagesLimitInput) {
          getMessagesLimitInput.disabled = !checkbox.checked;
          if (checkbox.checked) {
            validateGetMessagesLimitInput();
          } else {
            getMessagesLimitInput.removeAttribute("aria-invalid");
            if (getMessagesLimitStatus) getMessagesLimitStatus.textContent = "";
          }
        }
        onToolChange();
      });

      const label = document.createElement("label");
      label.htmlFor = checkbox.id;
      label.textContent = tool.name;
      if (tool.undisableable) {
        const lockSpan = document.createElement("span");
        lockSpan.className = "account-type";
        lockSpan.textContent = "required";
        label.appendChild(lockSpan);
      }

      li.appendChild(checkbox);
      li.appendChild(label);
      if (tool.name === "getMessages") {
        const option = document.createElement("div");
        option.className = "tool-option";

        const limitLabel = document.createElement("label");
        limitLabel.htmlFor = "getMessagesLimit";
        limitLabel.textContent = "Max messages per call";

        getMessagesLimitInput = document.createElement("input");
        getMessagesLimitInput.type = "text";
        getMessagesLimitInput.inputMode = "numeric";
        getMessagesLimitInput.id = "getMessagesLimit";
        getMessagesLimitInput.dataset.min = String(tool.getMessagesLimitMin || data.getMessagesLimitMin || 1);
        getMessagesLimitInput.dataset.max = String(tool.getMessagesLimitMax || data.getMessagesLimitMax || 20);
        getMessagesLimitInput.value = String(tool.getMessagesLimit || data.getMessagesLimit || 10);
        currentGetMessagesLimit = getMessagesLimitInput.value;
        getMessagesLimitInput.disabled = !checkbox.checked;
        getMessagesLimitInput.addEventListener("input", () => {
          validateGetMessagesLimitInput();
          onToolChange();
        });

        const rangeNote = document.createElement("span");
        rangeNote.className = "range-note";
        rangeNote.textContent = `1-${getMessagesLimitInput.dataset.max}`;

        getMessagesLimitStatus = document.createElement("div");
        getMessagesLimitStatus.className = "tool-limit-error";

        option.appendChild(limitLabel);
        option.appendChild(getMessagesLimitInput);
        option.appendChild(rangeNote);
        li.appendChild(option);
        li.appendChild(getMessagesLimitStatus);
      }
      toolList.appendChild(li);
    }
  } catch (e) {
    toolList.innerHTML = "";
    const li = document.createElement("li");
    li.textContent = "Error loading tools: " + e.message;
    toolList.appendChild(li);
  }
}

function onToolChange() {
  const checkboxes = toolList.querySelectorAll('input[type="checkbox"]');
  toolAccessChanged = [...checkboxes].some(cb =>
    !cb.disabled && cb.checked !== !!currentTools.find(tool => tool.name === cb.value)?.enabled
  );
  const limitChanged = getMessagesLimitInput && getMessagesLimitInput.value !== currentGetMessagesLimit;
  toolSettingsChanged = toolAccessChanged || (!currentToolError && !!limitChanged);
  saveToolsBtn.disabled = !toolSettingsChanged;
  saveToolsStatus.textContent = currentToolError;
  saveToolsStatus.className = currentToolError ? "save-status error" : "save-status";
}

saveToolsBtn.addEventListener("click", async () => {
  if (!toolSettingsChanged || (currentToolError && !toolAccessChanged)) return;
  saveToolsBtn.disabled = true;
  saveToolsStatus.textContent = "";
  saveToolsStatus.className = "save-status";

  const checkboxes = toolList.querySelectorAll('input[type="checkbox"]');
  const disabled = [];
  for (const cb of checkboxes) {
    if (!cb.checked && !cb.disabled) {
      disabled.push(cb.value);
    }
  }
  let getMessagesLimit;
  if (getMessagesLimitInput) {
    getMessagesLimit = validateGetMessagesLimitInput();
    if (getMessagesLimit === null) {
      saveToolsStatus.textContent = "Fix the highlighted getMessages limit before saving.";
      saveToolsStatus.className = "save-status error";
      saveToolsBtn.disabled = false;
      return;
    }
  }

  try {
    const result = await browser.mcpServer.setToolAccess(disabled, getMessagesLimit);
    if (result.error) {
      saveToolsStatus.textContent = result.error;
      saveToolsStatus.className = "save-status error";
    } else {
      saveToolsStatus.textContent = "Saved.";
      await loadToolAccess();
    }
  } catch (e) {
    saveToolsStatus.textContent = "Error: " + e.message;
    saveToolsStatus.className = "save-status error";
  }
  saveToolsBtn.disabled = !toolSettingsChanged;
});
// END OPTIONS TOOL ACCESS

const blockSkipReviewCheckbox = document.getElementById("blockSkipReview");
const saveSkipReviewBtn = document.getElementById("saveSkipReviewBtn");
const saveSkipReviewStatus = document.getElementById("saveSkipReviewStatus");

async function loadSkipReviewPref() {
  try {
    const { blockSkipReview } = await browser.mcpServer.getBlockSkipReview();
    blockSkipReviewCheckbox.checked = !!blockSkipReview;
    saveSkipReviewBtn.disabled = false;
    saveSkipReviewStatus.textContent = "";
  } catch (e) {
    saveSkipReviewStatus.textContent = "Error loading setting: " + e.message;
    saveSkipReviewStatus.className = "save-status error";
  }
}

saveSkipReviewBtn.addEventListener("click", async () => {
  saveSkipReviewBtn.disabled = true;
  saveSkipReviewStatus.textContent = "Saving...";
  saveSkipReviewStatus.className = "save-status";
  try {
    const result = await browser.mcpServer.setBlockSkipReview(blockSkipReviewCheckbox.checked);
    if (result.error) {
      saveSkipReviewStatus.textContent = result.error;
      saveSkipReviewStatus.className = "save-status error";
    } else {
      saveSkipReviewStatus.textContent = "Saved.";
    }
  } catch (e) {
    saveSkipReviewStatus.textContent = "Error: " + e.message;
    saveSkipReviewStatus.className = "save-status error";
  }
  saveSkipReviewBtn.disabled = false;
});

const allowFilterSendActionsCheckbox = document.getElementById("allowFilterSendActions");
const saveFilterSendActionsBtn = document.getElementById("saveFilterSendActionsBtn");
const saveFilterSendActionsStatus = document.getElementById("saveFilterSendActionsStatus");

async function loadFilterSendActionsPref() {
  allowFilterSendActionsCheckbox.checked = false;
  allowFilterSendActionsCheckbox.disabled = true;
  saveFilterSendActionsBtn.disabled = true;
  try {
    const { allowFilterSendActions } = await browser.mcpServer.getAllowFilterSendActions();
    allowFilterSendActionsCheckbox.checked = allowFilterSendActions === true;
    allowFilterSendActionsCheckbox.disabled = false;
    saveFilterSendActionsBtn.disabled = false;
    saveFilterSendActionsStatus.textContent = "";
  } catch (e) {
    saveFilterSendActionsStatus.textContent = "Error loading setting: " + e.message;
    saveFilterSendActionsStatus.className = "save-status error";
  }
}

saveFilterSendActionsBtn.addEventListener("click", async () => {
  saveFilterSendActionsBtn.disabled = true;
  saveFilterSendActionsStatus.textContent = "Saving...";
  saveFilterSendActionsStatus.className = "save-status";
  try {
    const result = await browser.mcpServer.setAllowFilterSendActions(allowFilterSendActionsCheckbox.checked);
    if (result.error) {
      saveFilterSendActionsStatus.textContent = result.error;
      saveFilterSendActionsStatus.className = "save-status error";
    } else {
      saveFilterSendActionsStatus.textContent = "Saved.";
    }
  } catch (e) {
    saveFilterSendActionsStatus.textContent = "Error: " + e.message;
    saveFilterSendActionsStatus.className = "save-status error";
  }
  saveFilterSendActionsBtn.disabled = false;
});
// BEGIN OPTIONS PRIVACY SETTINGS
const allowEncryptedMessagesCheckbox = document.getElementById("allowEncryptedMessages");
const allowAllCalendarsCheckbox = document.getElementById("allowAllCalendars");
const allowAllAddressBooksCheckbox = document.getElementById("allowAllAddressBooks");
const savePrivacyBtn = document.getElementById("savePrivacyBtn");
const savePrivacyStatus = document.getElementById("savePrivacyStatus");

async function loadPrivacySettings() {
  try {
    const settings = await browser.mcpServer.getPrivacySettings();
    if (settings.error) throw new Error(settings.error);
    allowEncryptedMessagesCheckbox.checked = settings.allowEncryptedMessages === true;
    allowAllCalendarsCheckbox.checked = settings.allowAllCalendars === true;
    allowAllAddressBooksCheckbox.checked = settings.allowAllAddressBooks === true;
    savePrivacyBtn.disabled = false;
    savePrivacyStatus.textContent = "";
    savePrivacyStatus.className = "save-status";
  } catch (e) {
    savePrivacyStatus.textContent = "Error loading settings: " + e.message;
    savePrivacyStatus.className = "save-status error";
  }
}

savePrivacyBtn.addEventListener("click", async () => {
  savePrivacyBtn.disabled = true;
  savePrivacyStatus.textContent = "Saving...";
  savePrivacyStatus.className = "save-status";
  try {
    const result = await browser.mcpServer.setPrivacySettings(
      allowEncryptedMessagesCheckbox.checked,
      allowAllCalendarsCheckbox.checked,
      allowAllAddressBooksCheckbox.checked
    );
    if (result.error) {
      savePrivacyStatus.textContent = result.error;
      savePrivacyStatus.className = "save-status error";
    } else {
      savePrivacyStatus.textContent = "Saved.";
    }
  } catch (e) {
    savePrivacyStatus.textContent = "Error: " + e.message;
    savePrivacyStatus.className = "save-status error";
  }
  savePrivacyBtn.disabled = false;
});
// END OPTIONS PRIVACY SETTINGS

loadServerInfo().catch(e => console.error("thunderbird-mcp options:", "loadServerInfo failed:", e));
loadAuthenticationConfig().catch(e => console.error("thunderbird-mcp options:", "loadAuthenticationConfig failed:", e));
loadAccountAccess().catch(e => console.error("thunderbird-mcp options:", "loadAccountAccess failed:", e));
loadToolAccess().catch(e => console.error("thunderbird-mcp options:", "loadToolAccess failed:", e));
loadSkipReviewPref().catch(e => console.error("thunderbird-mcp options:", "loadSkipReviewPref failed:", e));
loadFilterSendActionsPref().catch(e => console.error("thunderbird-mcp options:", "loadFilterSendActionsPref failed:", e));
loadPrivacySettings().catch(e => console.error("thunderbird-mcp options:", "loadPrivacySettings failed:", e));

const listenAllCheckbox = document.getElementById("listenAll");
const listenAllWarning = document.getElementById("listenAllWarning");
const saveListenAllBtn = document.getElementById("saveListenAllBtn");
const saveListenAllStatus = document.getElementById("saveListenAllStatus");

async function loadListenAllPref() {
  try {
    const { listenAll } = await browser.mcpServer.getListenAll();
    listenAllCheckbox.checked = !!listenAll;
    listenAllWarning.style.display = listenAllCheckbox.checked ? "block" : "none";
    saveListenAllBtn.disabled = false;
    saveListenAllStatus.textContent = "";
  } catch (e) {
    saveListenAllStatus.textContent = "Error loading setting: " + e.message;
    saveListenAllStatus.className = "save-status error";
  }
}

listenAllCheckbox.addEventListener("change", () => {
  listenAllWarning.style.display = listenAllCheckbox.checked ? "block" : "none";
});

// BEGIN OPTIONS LISTEN ALL SAVE
saveListenAllBtn.addEventListener("click", async () => {
  saveListenAllBtn.disabled = true;
  saveListenAllStatus.textContent = "Saving...";
  saveListenAllStatus.className = "save-status";
  try {
    const result = await browser.mcpServer.setListenAll(listenAllCheckbox.checked);
    if (result.error) {
      saveListenAllStatus.textContent = result.error;
      saveListenAllStatus.className = "save-status error";
    } else {
      saveListenAllStatus.textContent = "Saved.";
    }
  } catch (e) {
    saveListenAllStatus.textContent = "Error: " + e.message;
    saveListenAllStatus.className = "save-status error";
  }
  await loadServerInfo();
  saveListenAllBtn.disabled = false;
});
// END OPTIONS LISTEN ALL SAVE

loadListenAllPref();
