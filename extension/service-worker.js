// Remove temporary OPFS files left by interrupted tasks.
async function sweepOrphanedOpfs() {
    try {
        const root = await navigator.storage.getDirectory();
        let deleted = 0;
        for await (const [name, handle] of root.entries()) {
            if (name.startsWith('fs_zip_') || name.startsWith('fs_dl_') || name.startsWith('fs_turbo_')) {
                await root.removeEntry(name, { recursive: true }).catch(()=>{});
                deleted++;
            }
        }
    } catch(e) {
        console.error('[FetchStream GC] OPFS sweep failed:', e);
    }
}

chrome.runtime.onStartup.addListener(() => {
    sweepOrphanedOpfs();
});

chrome.runtime.onInstalled.addListener(() => {
    sweepOrphanedOpfs();
});
importScripts("./js/options.js");
importScripts("./js/vault.js");

let isScanningPaused = false;
chrome.storage.local.get(["isScanningPaused"]).then(res => {
    isScanningPaused = res.isScanningPaused === true;
});
chrome.runtime.onStartup.addListener(() => {
    chrome.storage.session.remove(['fs_vault_unlocked']);
});

chrome.windows.onRemoved.addListener(async (closedWindowId) => {
    try {
        const windows = await chrome.windows.getAll({ windowTypes: ['normal', 'popup'] });
        const remaining = windows.filter(w => w.id !== closedWindowId);
        if (remaining.length === 0) {
            await chrome.storage.session.remove(['fs_vault_unlocked']);
        }
    } catch (e) {
        console.error(e);
    }
});

chrome.storage.local.get(['fs_vault']).then(({ fs_vault }) => {
    if (fs_vault) {
        chrome.storage.session.get('fs_vault_unlocked').then(({ fs_vault_unlocked }) => {
            if (!fs_vault_unlocked) {
                chrome.action.setBadgeText({ text: '🔒' });
                try {
                    chrome.action.setBadgeBackgroundColor({ color: '#FFFFFF' });
                    chrome.action.setBadgeTextColor({ color: '#000000' });
                } catch(e) {}
            }
        });
    }
});

const storageCache = {};
const activeDownloads = {};
const activeUploads = {};
const activeServerUploads = {};
const tabUrls = {};

const storageWriteQueue = new Map();
const debouncedStorageSet = (storageKey, data) => {
  if (storageWriteQueue.has(storageKey)) {
    clearTimeout(storageWriteQueue.get(storageKey).timer);
  }
  storageWriteQueue.set(storageKey, {
    data: data,
    timer: setTimeout(() => {
      chrome.storage.local.set({ [storageKey]: storageWriteQueue.get(storageKey).data });
      storageWriteQueue.delete(storageKey);
    }, 750)
  });
};

chrome.storage.local.get(["active_downloads", "active_uploads", "active_server_uploads"]).then((res) => {
  if (res?.active_downloads) Object.assign(activeDownloads, res.active_downloads);
  if (res?.active_uploads) Object.assign(activeUploads, res.active_uploads);
  if (res?.active_server_uploads) {
    for (const k in res.active_server_uploads) {
      const j = res.active_server_uploads[k];
      if (j && j.status !== "CANCELLED" && j.status !== "COMPLETED" && j.status !== "FAILED") {
        activeServerUploads[k] = j;
      }
    }
    chrome.storage.local.set({ active_server_uploads: activeServerUploads });
  }
  updateDownloadBadgeAnimation();
}).catch(() => {});

try {
  chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
  chrome.action.setBadgeBackgroundColor({ color: "#0284c7" });
} catch (error) {}

const cleanupStorageAndCache = async () => {
  try {
    const data = await chrome.storage.local.get();
    const tabs = await chrome.tabs.query({});
    const activeTabIds = new Set(tabs.map((tab) => `storage${tab.id}`));

    const keysToRemove = [];
    for (const key in data) {
      if (key.startsWith("storage") && !activeTabIds.has(key)) {
        keysToRemove.push(key);
      }
    }
    
    // Remove stale task records left by older versions.
    if (!data.has_cleaned_zombies_v2) {
      for (const key in data) {
        if (key.startsWith("job_")) {
          keysToRemove.push(key);
        }
      }
      chrome.storage.local.set({ has_cleaned_zombies_v2: true, active_server_uploads: {} });
    }

    if (data.tasks) keysToRemove.push("tasks");
    if (data.queue) keysToRemove.push("queue");
    if (data.rec_queue) keysToRemove.push("rec_queue");
    if (data.dl_queue) keysToRemove.push("dl_queue");

    if (keysToRemove.length) {
      await chrome.storage.local.remove(keysToRemove);
    }
  } catch (error) {}
};

const syncOptions = () => {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(["options"]).then((result) => {
        const loaded = result?.options || {};
        for (const key in OPTION) {
          if (loaded[key] !== undefined) {
            OPTION[key] = JSON.parse(JSON.stringify(loaded[key]));
          }
        }
        const minKb = parseInt(loaded.size?.min, 10) || 0;
        const maxKb = parseInt(loaded.size?.max, 10) || 0;
        OPTION.size = {
          min: Math.max(0, minKb) * 1024,
          max: Math.max(0, maxKb) * 1024
        };
        if (!OPTION.concurrency || OPTION.concurrency < 2) OPTION.concurrency = 6;
        if (OPTION.concurrency > 16) OPTION.concurrency = 16;
        if (!OPTION.retries || OPTION.retries < 1) OPTION.retries = 3;
        if (OPTION.retries > 5) OPTION.retries = 5;
        resolve();
      }).catch(() => resolve());
    } catch (error) {
      resolve();
    }
  });
};

const updateBadge = async (cacheItem, tabId) => {
  if (Object.keys(activeDownloads).length > 0) return;
  const count = Object.keys(cacheItem || {}).length;
  
  let isLocked = false;
  try {
      const { fs_vault } = await chrome.storage.local.get('fs_vault');
      if (fs_vault) {
          const { fs_vault_unlocked } = await chrome.storage.session.get('fs_vault_unlocked');
          if (!fs_vault_unlocked) isLocked = true;
      }
  } catch {}

  let text = count > 0 ? count.toString() : "";
  if (isLocked) {
      text = text ? `🔒${text}` : "🔒";
  }
  
  chrome.action.setBadgeText({ text, tabId });
  try {
      chrome.action.setBadgeBackgroundColor({ color: "#FFFFFF", tabId });
      chrome.action.setBadgeTextColor({ color: "#000000", tabId });
  } catch(e) {}
};

let downloadBadgeTimer = null;
let downloadBadgeFrame = 0;

const updateDownloadBadgeAnimation = () => {
  const activeCount = Object.keys(activeDownloads).length + Object.keys(activeUploads).length + Object.keys(activeServerUploads).length;

  if (activeCount > 0) {
      chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
      chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
      const hasUploads = Object.keys(activeUploads).length > 0 || Object.keys(activeServerUploads).length > 0;
      const hasDownloads = Object.keys(activeDownloads).length > 0;
      
      let badgeText = "DL";
      if (hasUploads && hasDownloads) badgeText = "SYNC";
      else if (hasUploads) badgeText = "UP";
      
      chrome.action.setBadgeText({ text: badgeText });
  } else {
    chrome.action.setBadgeBackgroundColor({ color: "#0284c7" });
    chrome.action.setBadgeTextColor({ color: "#FFFFFF" });

    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab) {
        const key = `storage${tab.id}`;
        const cacheItem = storageCache[key] || {};
        updateBadge(cacheItem, tab.id);
      }
    }).catch(() => {});
  }
};

let dynamicConfig = { blocked_domains: [] };

const CONFIG_MAX_BYTES = 100 * 1024;
const CONFIG_MAX_DOMAINS = 5000;
const CONFIG_MAX_LINKS = 32;

function isValidBlockedDomain(value) {
  if (typeof value !== "string") return false;
  const domain = value.trim().toLowerCase().replace(/^\*\./, "").replace(/^\.+/, "");
  if (domain.length === 0 || domain.length > 253 || domain.includes("/")) return false;
  return domain.split(".").every(label =>
    label.length > 0 && label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  );
}

function normalizeDynamicConfig(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  const blockedDomains = Array.isArray(data.blocked_domains)
    ? data.blocked_domains.filter(isValidBlockedDomain)
      .map(domain => domain.trim().toLowerCase().replace(/^\*\./, "").replace(/^\.+/, ""))
      .slice(0, CONFIG_MAX_DOMAINS)
    : [];

  const links = {};
  if (data.links && typeof data.links === "object" && !Array.isArray(data.links)) {
    for (const [key, rawUrl] of Object.entries(data.links).slice(0, CONFIG_MAX_LINKS)) {
      if (/^[a-zA-Z0-9_-]{1,64}$/.test(key)) {
        const valid = sanitizeExternalUrl(rawUrl, null);
        if (valid) links[key] = valid;
      }
    }
  }

  const _meta = {};
  if (data._meta && typeof data._meta === "object" && !Array.isArray(data._meta)) {
    const v = data._meta.versions;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const versions = {};
      for (const channel of ["stable", "beta"]) {
        if (typeof v[channel] === "string" && v[channel].length <= 32 && /^\d+(\.\d+)*$/.test(v[channel])) {
          versions[channel] = v[channel];
        }
      }
      if (Object.keys(versions).length > 0) _meta.versions = versions;
    }
  }

  return { links, blocked_domains: blockedDomains, _meta };
}

async function readBoundedResponseBody(response) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (text.length > CONFIG_MAX_BYTES) throw new Error("Config payload too large");
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > CONFIG_MAX_BYTES) throw new Error("Config payload too large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchDynamicConfig() {
  try {
    const res = await fetch('https://fetchstream.in/config.json');
    if (!res.ok) throw new Error('Network response was not ok');
    
    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > CONFIG_MAX_BYTES) {
      throw new Error('Config payload too large');
    }

    const config = normalizeDynamicConfig(JSON.parse(await readBoundedResponseBody(res)));
    if (!config) throw new Error("Invalid config schema");
    dynamicConfig = config;
      await chrome.storage.local.set({ fs_dynamic_config: dynamicConfig });
  } catch (e) {
    console.warn('[FetchStream] Remote config rejected or failed:', e);
    const stored = await chrome.storage.local.get('fs_dynamic_config');
    const cachedConfig = normalizeDynamicConfig(stored.fs_dynamic_config);
    if (cachedConfig) {
      dynamicConfig = cachedConfig;
    }
  }
}
fetchDynamicConfig();

const isDomainBlocked = (hostname) => {
  if (!hostname) return false;
  const host = hostname.toLowerCase().trim();
  
  const allBlocked = [
    ...(typeof RESTRICTED_DOMAINS !== "undefined" && Array.isArray(RESTRICTED_DOMAINS) ? RESTRICTED_DOMAINS : []),
    ...(OPTION.domain || []),
    ...(dynamicConfig.blocked_domains || [])
  ];

  if (allBlocked.length === 0) return false;

  return allBlocked.some((d) => {
    const blocked = d.toLowerCase().trim().replace(/^\*\./, "").replace(/^\.+/, "");
    return host === blocked || host.endsWith("." + blocked);
  });
};

const removeSessionRulesForTab = (tabId) => {
  chrome.declarativeNetRequest.getSessionRules((rules) => {
    const ruleIds = rules
      .filter((rule) => rule.condition?.tabIds?.includes(tabId))
      .map((rule) => rule.id);

    if (ruleIds.length > 0) {
      chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds });
    }
  });
};

const getAvailableRuleId = (requestedId) => new Promise((resolve) => {
  if (requestedId) {
    resolve(requestedId);
  } else {
    chrome.declarativeNetRequest.getSessionRules((rules) => {
      let maxId = 2;
      for (const rule of rules) {
        maxId = Math.max(maxId, rule.id);
      }
      maxId++;
      resolve(maxId);
    });
  }
});

chrome.declarativeNetRequest.getSessionRules(async (rules) => {
  if (!rules || rules.length === 0) return;
  const tabs = await chrome.tabs.query({});
  const activeIds = new Set(tabs.map((t) => t.id));
  const removeIds = [];

  for (const rule of rules) {
    if (!rule.condition?.tabIds) continue;
    const hasActiveTab = rule.condition.tabIds.some((id) => activeIds.has(id));
    if (!hasActiveTab) {
      removeIds.push(rule.id);
    }
  }

  if (removeIds.length > 0) {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: removeIds });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && !message.cmd && message.action) message.cmd = message.action;
  const { cmd, parameter } = message || {};

  const allowedCommands = new Set([
    "GET_TAB_ID", "SET_RULES", "REMOVE_RULES", "OPEN_INITIATOR", "OPEN_DOWNLOADS",
    "REGISTER_DOWNLOAD", "UPDATE_DOWNLOAD_PROGRESS", "GET_ACTIVE_DOWNLOADS",
    "PAUSE_DOWNLOAD", "RESUME_DOWNLOAD", "CANCEL_DOWNLOAD", "DOWNLOAD_FINISHED",
    "REGISTER_UPLOAD", "UPDATE_UPLOAD_PROGRESS", "GET_ACTIVE_UPLOADS", "UPLOAD_FINISHED",
    "REGISTER_SERVER_UPLOAD", "UPDATE_SERVER_UPLOAD_PROGRESS", "GET_ACTIVE_SERVER_UPLOADS",
    "SERVER_UPLOAD_FINISHED", "ACTION_CANCEL_SERVER_UPLOAD", "ACTION_SAVE_TASK_TO_PC",
    "PAUSE_UPLOAD", "RESUME_UPLOAD", "CANCEL_UPLOAD", "PAUSE_ALL_UPLOADS",
    "TOGGLE_SCANNING", "CANCEL_ALL_UPLOADS", "RECORD_HISTORY", "CLEAR_TAB_STORAGE",
    "RESET_OPTIONS", "CLEAR_BLOCKED_CACHE", "ACTION_START_SERVER_UPLOAD"
  ]);
  const hasValidId = value => (typeof value === "string" && value.length > 0 && value.length <= 128) ||
    (Number.isInteger(value) && value >= 0);
  const isBoundedValue = (value, depth = 0) => {
    if (depth > 6) return false;
    if (typeof value === "string") return value.length <= 8192;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "boolean" || value === null || value === undefined) return true;
    if (Array.isArray(value)) return value.length <= 100 && value.every(item => isBoundedValue(item, depth + 1));
    if (typeof value === "object") {
      const keys = Object.keys(value);
      return keys.length <= 64 && keys.every(key => key.length <= 128 && isBoundedValue(value[key], depth + 1));
    }
    return false;
  };
  const isObject = value => value && typeof value === "object" && !Array.isArray(value) && isBoundedValue(value);
  const parameterIdValid = value => isObject(value) && hasValidId(value.id);
  const validHttpLink = value => isObject(value) && isSafeHttpUrl(value.url) &&
    value.url.length <= 4096 && (value.service === undefined || (typeof value.service === "string" && value.service.length <= 128));
  const validLinks = value => value === undefined ||
    (Array.isArray(value) && value.length <= 100 && value.every(validHttpLink));
  const validProgress = value => parameterIdValid(value) &&
    (value.progress === undefined || (Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 100)) &&
    (value.speed === undefined || (typeof value.speed === "string" && value.speed.length <= 256)) &&
    (value.state === undefined || (typeof value.state === "string" && value.state.length <= 64)) &&
    (value.status === undefined || (typeof value.status === "string" && value.status.length <= 64)) &&
    validLinks(value.links);
  const validRule = value => isObject(value) &&
    Number.isInteger(value.priority) && value.priority > 0 && value.priority <= 100000 &&
    isObject(value.action) && ["block", "allow", "modifyHeaders", "redirect", "upgradeScheme"].includes(value.action.type) &&
    isObject(value.condition) &&
    (!value.condition.urlFilter || (typeof value.condition.urlFilter === "string" && value.condition.urlFilter.length <= 4096)) &&
    (!value.condition.regexFilter || (typeof value.condition.regexFilter === "string" && value.condition.regexFilter.length <= 4096));

  if (sender?.id !== chrome.runtime.id || !allowedCommands.has(cmd) || !isBoundedValue(message)) {
    sendResponse({ ok: false, error: "Unauthorized or unsupported message" });
    return false;
  }

  const validPayload = {
    SET_RULES: isObject(parameter) && validRule(parameter.ruleObject) &&
      (parameter.ruleId === undefined || parameter.ruleId === 0 || (Number.isInteger(parameter.ruleId) && parameter.ruleId > 0)),
    REMOVE_RULES: isObject(parameter) && Number.isInteger(parameter.ruleId) && parameter.ruleId > 0,
    OPEN_INITIATOR: isObject(parameter) && isSafeHttpUrl(parameter.initiator) && parameter.initiator.length <= 4096,
    REGISTER_DOWNLOAD: isObject(parameter) && hasValidId(parameter.id),
    UPDATE_DOWNLOAD_PROGRESS: validProgress(parameter),
    PAUSE_DOWNLOAD: parameterIdValid(parameter), RESUME_DOWNLOAD: parameterIdValid(parameter),
    CANCEL_DOWNLOAD: parameterIdValid(parameter), DOWNLOAD_FINISHED: parameterIdValid(parameter) && validLinks(parameter.links),
    REGISTER_UPLOAD: isObject(parameter) && hasValidId(parameter.id),
    UPDATE_UPLOAD_PROGRESS: validProgress(parameter), UPLOAD_FINISHED: parameterIdValid(parameter) && validLinks(parameter.links),
    REGISTER_SERVER_UPLOAD: isObject(parameter) && hasValidId(parameter.id),
    UPDATE_SERVER_UPLOAD_PROGRESS: validProgress(parameter), SERVER_UPLOAD_FINISHED: parameterIdValid(parameter) && validLinks(parameter.links),
    ACTION_CANCEL_SERVER_UPLOAD: parameterIdValid(parameter), ACTION_SAVE_TASK_TO_PC: parameterIdValid(parameter),
    PAUSE_UPLOAD: parameterIdValid(parameter), RESUME_UPLOAD: parameterIdValid(parameter),
    CANCEL_UPLOAD: parameterIdValid(parameter), TOGGLE_SCANNING: isObject(parameter) && typeof parameter.paused === "boolean",
    RECORD_HISTORY: isObject(parameter) && validLinks(parameter.links), CLEAR_TAB_STORAGE: isObject(parameter) && Number.isInteger(parameter.tabId),
    RESET_OPTIONS: parameter === undefined || isObject(parameter), CLEAR_BLOCKED_CACHE: parameter === undefined
  };
  validPayload.ACTION_START_SERVER_UPLOAD = isObject(message.payload) &&
    isSafeHttpUrl(message.payload.url) && message.payload.url.length <= 8192;
  const noParameterCommands = new Set([
    "OPEN_DOWNLOADS", "GET_ACTIVE_DOWNLOADS", "GET_ACTIVE_UPLOADS", "GET_ACTIVE_SERVER_UPLOADS",
    "PAUSE_ALL_UPLOADS", "CANCEL_ALL_UPLOADS", "CLEAR_BLOCKED_CACHE"
  ]);
  if (noParameterCommands.has(cmd) && parameter !== undefined) {
    sendResponse({ ok: false, error: "Unexpected message payload" });
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(validPayload, cmd) && !validPayload[cmd]) {
    sendResponse({ ok: false, error: "Malformed message payload" });
    return false;
  }

  if (cmd === "GET_TAB_ID") {
    chrome.tabs.query({}).then((tabs) => {
      const currentTabId = sender.tab ? sender.tab.id : null;
      const tabsCount = tabs.length;
      sendResponse({ currentTabId, tabsCount });
    });
    return true;
  }

  if (cmd === "SET_RULES") {
    const { ruleObject, ruleId } = parameter || {};
    getAvailableRuleId(ruleId).then((id) => {
      try {
        ruleObject.id = id;
        chrome.declarativeNetRequest.updateSessionRules(
          { removeRuleIds: [id], addRules: [ruleObject] },
          () => sendResponse(id)
        );
      } catch (error) {
        sendResponse(0);
      }
    });
    return true;
  }

  if (cmd === "REMOVE_RULES") {
    const { ruleId } = parameter || {};
    if (ruleId) {
      chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
    }
    sendResponse();
    return true;
  }

  if (cmd === "OPEN_INITIATOR") {
    const { initiator } = parameter || {};
    if (initiator) {
      chrome.tabs.create({ url: initiator, index: (sender.tab ? sender.tab.index : 0) + 1 });
    }
    sendResponse("");
    return true;
  }

  if (cmd === "OPEN_DOWNLOADS") {
    chrome.tabs.create({ url: "chrome://downloads/", index: (sender.tab ? sender.tab.index : 0) + 1 });
    sendResponse();
    return true;
  }

  if (cmd === "REGISTER_DOWNLOAD") {
    const downloadInfo = parameter;
    if (downloadInfo && downloadInfo.id) {
      activeDownloads[downloadInfo.id] = {
        ...downloadInfo,
        tabId: sender.tab ? sender.tab.id : null,
        state: "downloading",
        updatedAt: Date.now()
      };
      chrome.storage.local.set({ active_downloads: activeDownloads });
      updateDownloadBadgeAnimation();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (cmd === "UPDATE_DOWNLOAD_PROGRESS") {
    const { id, progress, speed, downloadedBytes, totalBytes, completedSegments, totalSegments, state } = parameter || {};
    if (id && activeDownloads[id]) {
      Object.assign(activeDownloads[id], {
        progress,
        speed,
        downloadedBytes,
        totalBytes,
        completedSegments,
        totalSegments,
        state: state || activeDownloads[id].state,
        service: parameter?.service || activeDownloads[id].service,
        updatedAt: Date.now()
      });
      chrome.storage.local.set({ active_downloads: activeDownloads });

      chrome.runtime.sendMessage({
        cmd: "DOWNLOAD_PROGRESS_TICK",
        parameter: activeDownloads[id]
      }, () => { if (chrome.runtime.lastError) {} });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (cmd === "GET_ACTIVE_DOWNLOADS") {
    sendResponse(activeDownloads);
    return true;
  }

  if (cmd === "PAUSE_DOWNLOAD") {
    const { id } = parameter || {};
    if (id && activeDownloads[id]) {
      activeDownloads[id].state = "paused";
      chrome.storage.local.set({ active_downloads: activeDownloads });
    }
    const downloaderUrl = chrome.runtime.getURL("downloader.html");
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(t => {
        if (t.url && t.url.startsWith(downloaderUrl)) {
          chrome.tabs.sendMessage(t.id, { cmd: "ACTION_PAUSE_DOWNLOAD", parameter: { id } }, () => {
            if (chrome.runtime.lastError) {}
          });
        }
      });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (cmd === "RESUME_DOWNLOAD") {
    const { id } = parameter || {};
    if (id && activeDownloads[id]) {
      activeDownloads[id].state = "downloading";
      chrome.storage.local.set({ active_downloads: activeDownloads });
    }
    const downloaderUrl = chrome.runtime.getURL("downloader.html");
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(t => {
        if (t.url && t.url.startsWith(downloaderUrl)) {
          chrome.tabs.sendMessage(t.id, { cmd: "ACTION_RESUME_DOWNLOAD", parameter: { id } }, () => {
            if (chrome.runtime.lastError) {}
          });
        }
      });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (cmd === "CANCEL_DOWNLOAD") {
    const { id } = parameter || {};
    if (id && activeDownloads[id]) {
      delete activeDownloads[id];
      chrome.storage.local.set({ active_downloads: activeDownloads });
      updateDownloadBadgeAnimation();
    }
    const downloaderUrl = chrome.runtime.getURL("downloader.html");
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(t => {
        if (t.url && t.url.startsWith(downloaderUrl)) {
          chrome.tabs.sendMessage(t.id, { cmd: "ACTION_CANCEL_DOWNLOAD", parameter: { id } }, () => {
            if (chrome.runtime.lastError) {}
          });
        }
      });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (cmd === "DOWNLOAD_FINISHED") {
    const { id, state, status, error } = parameter || {};
    const isFailed = state === "FAILED" || status === "FAILED" || Boolean(error);
    if (id && activeDownloads[id]) {
      if (isFailed) {
        activeDownloads[id].state = "failed";
        activeDownloads[id].status = "failed";
        activeDownloads[id].error = error || "Upload failed";
        chrome.storage.local.set({ active_downloads: activeDownloads });
      } else {
        delete activeDownloads[id];
        chrome.storage.local.set({ active_downloads: activeDownloads });
        updateDownloadBadgeAnimation();
      }
    }
    chrome.runtime.sendMessage({
      cmd: "DOWNLOAD_FINISHED",
      parameter
    }, () => { if (chrome.runtime.lastError) {} });
    sendResponse({ ok: true });
    return true;
  }

  if (cmd === "REGISTER_UPLOAD") {
    const uploadInfo = parameter;
    if (uploadInfo && uploadInfo.id) {
      activeUploads[uploadInfo.id] = {
        ...uploadInfo,
        tabId: sender.tab ? sender.tab.id : null,
        state: "uploading",
        progress: 0,
        updatedAt: Date.now()
      };
      chrome.storage.local.set({ active_uploads: activeUploads });
      updateDownloadBadgeAnimation();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (cmd === "UPDATE_UPLOAD_PROGRESS") {
    const { id, progress, speed, uploadedBytes, totalBytes } = parameter || {};
    if (id && activeUploads[id]) {
      Object.assign(activeUploads[id], {
        progress,
        speed,
        uploadedBytes,
        totalBytes,
        updatedAt: Date.now()
      });
      chrome.storage.local.set({ active_uploads: activeUploads });

      chrome.runtime.sendMessage({
        cmd: "UPLOAD_PROGRESS_TICK",
        parameter: activeUploads[id]
      }, () => { if (chrome.runtime.lastError) {} });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (cmd === "GET_ACTIVE_UPLOADS") {
    sendResponse(activeUploads);
    return true;
  }

  if (cmd === "UPLOAD_FINISHED") {
    const { id } = parameter || {};
    if (id && activeUploads[id]) {
      delete activeUploads[id];
      chrome.storage.local.set({ active_uploads: activeUploads });
      updateDownloadBadgeAnimation();
    }
    chrome.runtime.sendMessage({
      cmd: "UPLOAD_FINISHED_TICK",
      parameter
    }, () => { if (chrome.runtime.lastError) {} });
    sendResponse({ ok: true });
    return true;
  }

  if (cmd === "REGISTER_SERVER_UPLOAD") {
    const srvInfo = parameter;
    if (srvInfo && srvInfo.id) {
      activeServerUploads[srvInfo.id] = {
        ...srvInfo,
        mediaUrl: srvInfo.mediaUrl || srvInfo.url,
        url: (srvInfo.url && !srvInfo.url.includes('.m3u8')) ? srvInfo.url : "",
        state: srvInfo.state || "running",
        updatedAt: Date.now()
      };
      chrome.storage.local.set({ active_server_uploads: activeServerUploads });
      updateDownloadBadgeAnimation();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (cmd === "UPDATE_SERVER_UPLOAD_PROGRESS") {
    const { id, progress, stage, speed, status, url, links, mediaUrl } = parameter || {};
    if (id && activeServerUploads[id]) {
      Object.assign(activeServerUploads[id], {
        progress,
        stage,
        speed,
        status: status || activeServerUploads[id].status,
        updatedAt: Date.now()
      });
      if (mediaUrl) {
        activeServerUploads[id].mediaUrl = mediaUrl;
      }
      if (url && !url.includes('.m3u8')) {
        activeServerUploads[id].url = url;
      }
      if (Array.isArray(links) && links.length > 0) {
        activeServerUploads[id].links = links.filter(l => l.url && !l.url.includes('.m3u8'));
      }
      chrome.storage.local.set({ active_server_uploads: activeServerUploads });
    }
    const payload = (id && activeServerUploads[id]) ? { ...activeServerUploads[id] } : { ...parameter };
    if (url && !url.includes('.m3u8')) payload.url = url;
    if (Array.isArray(links) && links.length > 0) payload.links = links.filter(l => l.url && !l.url.includes('.m3u8'));
    chrome.runtime.sendMessage({
      cmd: "UPDATE_SERVER_UPLOAD_PROGRESS",
      parameter: payload,
      _fromServiceWorker: true
    }, () => { if (chrome.runtime.lastError) {} });
    sendResponse({ ok: true });
    return true;
  }

  if (cmd === "GET_ACTIVE_SERVER_UPLOADS") {
    sendResponse(activeServerUploads);
    return true;
  }

  if (cmd === "SERVER_UPLOAD_FINISHED") {
    const { id, url, links, status, mediaUrl } = parameter || {};
    if (id && activeServerUploads[id]) {
      if (status === "COMPLETED") {
        if (url && !url.includes('.m3u8')) activeServerUploads[id].url = url;
        if (Array.isArray(links) && links.length > 0) activeServerUploads[id].links = links.filter(l => l.url && !l.url.includes('.m3u8'));
        if (mediaUrl) activeServerUploads[id].mediaUrl = mediaUrl;
        activeServerUploads[id].status = "COMPLETED";
        activeServerUploads[id].progress = 100;
        setTimeout(() => {
          if (activeServerUploads[id]) {
            delete activeServerUploads[id];
            chrome.storage.local.set({ active_server_uploads: activeServerUploads });
            updateDownloadBadgeAnimation();
          }
        }, 10000);
      } else {
        delete activeServerUploads[id];
        chrome.storage.local.set({ active_server_uploads: activeServerUploads });
        updateDownloadBadgeAnimation();
      }
    }
    chrome.runtime.sendMessage({
      cmd: "SERVER_UPLOAD_FINISHED",
      parameter
    }, () => { if (chrome.runtime.lastError) {} });
    sendResponse({ ok: true });
    return true;
  }

  if (cmd === "ACTION_CANCEL_SERVER_UPLOAD") {
    const { id } = parameter || {};
    if (id) {
      chrome.storage.local.remove([id]);
      if (activeServerUploads[id]) {
        delete activeServerUploads[id];
        chrome.storage.local.set({ active_server_uploads: activeServerUploads });
        updateDownloadBadgeAnimation();
      }
    }
    const senderTabId = sender?.tab?.id;
    const downloaderUrl = chrome.runtime.getURL("downloader.html");
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((tab) => {
        if (tab.id !== senderTabId && tab.url && tab.url.startsWith(downloaderUrl)) {
          chrome.tabs.sendMessage(tab.id, {
            cmd: "ACTION_CANCEL_SERVER_UPLOAD",
            parameter
          }, () => { if (chrome.runtime.lastError) {} });
        }
      });
    });
    chrome.runtime.sendMessage({
      cmd: "ACTION_CANCEL_SERVER_UPLOAD",
      parameter,
      _fromServiceWorker: true
    }, () => { if (chrome.runtime.lastError) {} });
    sendResponse({ ok: true });
    return true;
  }

  if (cmd === "ACTION_SAVE_TASK_TO_PC") {
    const downloaderUrl = chrome.runtime.getURL("downloader.html");
    chrome.tabs.query({}, (tabs) => {
      const dTab = tabs.find(t => t.url && t.url.startsWith(downloaderUrl));
      if (dTab) {
        chrome.tabs.sendMessage(dTab.id, message, (response) => {
          sendResponse(response || { ok: true });
        });
      } else {
        sendResponse({ ok: false, error: "Downloader tab not found" });
      }
    });
    return true;
  }

  if (cmd === "PAUSE_UPLOAD") {
    const { id } = parameter || {};
    if (id && activeUploads[id]) {
      activeUploads[id].state = "paused";
      chrome.storage.local.set({ active_uploads: activeUploads });
      chrome.runtime.sendMessage({
        cmd: "UPLOAD_PROGRESS_TICK",
        parameter: activeUploads[id]
      }, () => { if (chrome.runtime.lastError) {} });
    }
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(t => {
        chrome.tabs.sendMessage(t.id, { cmd: "PAUSE_UPLOAD_REMOTE", parameter }, () => { if (chrome.runtime.lastError) {} });
      });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (cmd === "RESUME_UPLOAD") {
    const { id } = parameter || {};
    if (id && activeUploads[id]) {
      activeUploads[id].state = "uploading";
      chrome.storage.local.set({ active_uploads: activeUploads });
      chrome.runtime.sendMessage({
        cmd: "UPLOAD_PROGRESS_TICK",
        parameter: activeUploads[id]
      }, () => { if (chrome.runtime.lastError) {} });
    }
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(t => {
        chrome.tabs.sendMessage(t.id, { cmd: "RESUME_UPLOAD_REMOTE", parameter }, () => { if (chrome.runtime.lastError) {} });
      });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (cmd === "CANCEL_UPLOAD") {
    const { id } = parameter || {};
    if (id && activeUploads[id]) {
      delete activeUploads[id];
      chrome.storage.local.set({ active_uploads: activeUploads });
      updateDownloadBadgeAnimation();
    }
    chrome.runtime.sendMessage({
      cmd: "UPLOAD_FINISHED_TICK",
      parameter: parameter || { id }
    }, () => { if (chrome.runtime.lastError) {} });
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(t => {
        chrome.tabs.sendMessage(t.id, { cmd: "CANCEL_UPLOAD_REMOTE", parameter }, () => { if (chrome.runtime.lastError) {} });
      });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (cmd === "PAUSE_ALL_UPLOADS") {
    for (const id in activeUploads) {
      activeUploads[id].state = "paused";
    }
    chrome.storage.local.set({ active_uploads: activeUploads });
    for (const id in activeUploads) {
      chrome.runtime.sendMessage({
        cmd: "UPLOAD_PROGRESS_TICK",
        parameter: activeUploads[id]
      }, () => { if (chrome.runtime.lastError) {} });
    }
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(t => {
        chrome.tabs.sendMessage(t.id, { cmd: "PAUSE_ALL_UPLOADS_REMOTE" }, () => { if (chrome.runtime.lastError) {} });
      });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === "ACTION_START_SERVER_UPLOAD") {
      const payload = message.payload;
      
      // Validate the request before forwarding credentials or media data.
      if (!payload || !payload.url || typeof payload.url !== 'string') {
          sendResponse({ success: false, error: "Malformed URL payload" });
          return true;
      }

      (async () => {
          try {
              const vaultData = await chrome.storage.session.get('fs_vault_unlocked');
              const creds = vaultData?.fs_vault_unlocked || {};
              const relayUrl = creds.serverRelayUrl?.replace(/\/+$/, "");
              const apiKey = creds.serverApiKey;

              if (!relayUrl) {
                  sendResponse({ success: false, error: "Server Relay URL not configured in Vault" });
                  return;
              }
              
              if (!isValidRunnerUrl(relayUrl)) {
                  sendResponse({ success: false, error: "Insecure Runner URL: HTTPS is required for remote servers." });
                  return;
              }

              const jobId = "job_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);
              
              const reqHeaders = { 'Content-Type': 'application/json' };
              if (apiKey) {
                  reqHeaders['Authorization'] = "Bearer " + apiKey;
                  reqHeaders['X-API-Key'] = apiKey;
              }

              const res = await fetch(relayUrl + "/api/server-relay", {
                  method: 'POST',
                  headers: reqHeaders,
                  body: JSON.stringify({
                      jobId: jobId,
                      mediaUrl: payload.url,
                      headers: { ...(payload.headers || {}), 'X-FS-Variant-Url': payload.variantUrl || '' },
                      fileName: payload.fileName || 'file.mp4',
                      type: payload.type || 'direct',
                      format: payload.fileName ? payload.fileName.split('.').pop() : 'mp4',
                      service: payload.service || 'gofile.io',
                      threads: 8,
                      credentials: {
                          caption: payload.telegramCaption || "",
                          gofile: {
                              token: creds.gofileToken,
                              folderId: creds.gofileFolderId
                          },
                          s3_compatible: {
                              endpoint: creds.s3Endpoint,
                              bucket: creds.s3Bucket,
                              region: creds.s3Region,
                              accessKeyId: creds.s3AccessKey,
                              secretAccessKey: creds.s3SecretKey,
                              prefix: creds.s3Prefix
                          },
                          telegram: {
                              caption: payload.telegramCaption || "",
                              botToken: creds.telegramBotToken,
                              chatId: creds.telegramChatId
                          },
                          "pixeldrain.com": {
                              apiKey: creds.pixeldrainApiKey
                          }
                      },
                      useFallbackProxy: true,
                      proxyUrl: payload.credentials?.serverUpload?.fallbackProxyUrl || payload.credentials?.fallbackProxyUrl || undefined,
                      retries: payload.credentials?.serverUpload?.maxRetries !== undefined ? Number(payload.credentials.serverUpload.maxRetries) : undefined,
                      timeout: payload.credentials?.serverUpload?.timeout !== undefined ? Number(payload.credentials.serverUpload.timeout) : undefined
                  })
              });

              const resData = await res.json().catch(() => ({}));
              if (!res.ok || !resData.jobId) {
                  sendResponse({ success: false, error: resData.error || `Server runner rejected relay job (${res.status})` });
                  return;
              }

              const serverTaskData = {
                  id: jobId,
                  mediaUrl: payload.url,
                  url: "",
                  name: payload.fileName,
                  type: payload.type || 'direct',
                  format: payload.fileName ? payload.fileName.split('.').pop() : 'mp4',
                  resolution: null,
                  threads: 8,
                  headers: payload.headers || {},
                  service: payload.service || 'gofile.io',
                  credentials: {},
                  action: 'server_upload',
                  isDispatched: true
              };

              activeServerUploads[jobId] = serverTaskData;
              chrome.storage.local.set({ active_server_uploads: activeServerUploads });

              chrome.storage.local.set({ [jobId]: serverTaskData }, () => {
                  chrome.runtime.sendMessage({
                      cmd: "REGISTER_SERVER_UPLOAD",
                      parameter: {
                          id: jobId,
                          mediaUrl: payload.url,
                          url: "",
                          name: payload.fileName,
                          service: payload.service || 'gofile.io',
                          progress: 10,
                          stage: "DISPATCHED",
                          status: "RUNNING",
                          speed: "Runner processing in cloud...",
                          isDispatched: true
                      }
                  }, () => { if (chrome.runtime.lastError) {} });
                  chrome.runtime.sendMessage({
                      cmd: "ADD_SERVER_TASK",
                      parameter: serverTaskData
                  }, (response2) => {
                      if (chrome.runtime.lastError || !response2?.received) {
                          chrome.storage.local.set({ srv_queue: serverTaskData });
                      }
                  });
              });

              sendResponse({ success: true, jobId: jobId });
          } catch (e) {
              sendResponse({ success: false, error: e.message || 'Network error' });
          }
      })();
      return true;
  }

  if (cmd === "TOGGLE_SCANNING") {
    isScanningPaused = parameter.paused;
    chrome.storage.local.set({ isScanningPaused: isScanningPaused });
    sendResponse({ ok: true });
    return true;
  }

  if (cmd === "CANCEL_ALL_UPLOADS") {
    for (const id in activeUploads) {
      delete activeUploads[id];
    }
    chrome.storage.local.set({ active_uploads: activeUploads });
    updateDownloadBadgeAnimation();
    chrome.runtime.sendMessage({ cmd: "UPLOAD_CANCEL_ALL_TICK" }, () => { if (chrome.runtime.lastError) {} });
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(t => {
        chrome.tabs.sendMessage(t.id, { cmd: "CANCEL_ALL_UPLOADS_REMOTE" }, () => { if (chrome.runtime.lastError) {} });
      });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (cmd === "RECORD_HISTORY" && parameter) {
    const STORAGE_KEY = "fetchstream_permanent_history";
    chrome.storage.local.get([STORAGE_KEY], (res) => {
      const list = Array.isArray(res?.[STORAGE_KEY]) ? res[STORAGE_KEY] : [];
      const now = Date.now();
      const url = typeof parameter.url === "string" ? parameter.url : (parameter.url?.url || parameter.resultUrl || "");
      const links = Array.isArray(parameter.links) ? parameter.links : [];
      const name = parameter.name || "Unknown File";
      const service = parameter.service || "local";
      const hasLinks = Boolean(url.trim()) || links.length > 0;

      const targetJobId = parameter.jobId || parameter.id || null;

      const duplicateIdx = list.findIndex(r => {
        if (targetJobId && (r.id === targetJobId || r.jobId === targetJobId)) return true;
        if (url && r.url === url && r.type === (parameter.type || "upload") && Math.abs(now - (r.timestamp || 0)) < 15000) return true;
        return false;
      });

      if (duplicateIdx !== -1) {
        const existing = list[duplicateIdx];
        const mergedLinks = Array.isArray(existing.links) ? [...existing.links] : [];
        for (const lnk of links) {
          if (lnk && lnk.url && !mergedLinks.some(m => m.url === lnk.url)) {
            mergedLinks.push(lnk);
          }
        }
        existing.links = mergedLinks;
        if (url && !existing.url) existing.url = url;
        if (parameter.size && (!existing.size || existing.size === 0)) existing.size = parameter.size;
        if (parameter.status) existing.status = parameter.status;
        if (targetJobId && !existing.jobId) existing.jobId = targetJobId;

        if (mergedLinks.length > 1) {
          const svcNames = Array.from(new Set(mergedLinks.map(l => l.service || "Mirror"))).join(", ");
          existing.service = `Multi-Host (${svcNames})`;
        }

        chrome.storage.local.set({ [STORAGE_KEY]: list }, () => {
          sendResponse({ ok: true, record: existing });
        });
        return;
      }

      if (parameter.type === "upload" && !hasLinks && !parameter.size) {
        sendResponse({ ok: true, skipped: true });
        return;
      }

      const record = {
        id: targetJobId || ("hist_" + now + "_" + Math.random().toString(36).substr(2, 5)),
        jobId: targetJobId,
        timestamp: now,
        type: parameter.type || "download",
        name: name,
        size: parameter.size || 0,
        service: service,
        url: url,
        links: links,
        status: parameter.status || "completed",
        details: parameter.details || ""
      };
      list.unshift(record);
      chrome.storage.local.set({ [STORAGE_KEY]: list }, () => {
        sendResponse({ ok: true, record });
      });
    });
    return true;
  }

  if (cmd === "CLEAR_TAB_STORAGE") {
    const { tabId } = parameter || {};
    if (tabId) {
      const key = `storage${tabId}`;
      if (storageCache[key]) delete storageCache[key];
      chrome.storage.local.remove([key], () => {
        updateBadge({}, tabId);
        sendResponse({ ok: true });
      });
    } else {
      sendResponse({ ok: false });
    }
    return true;
  }

  if (cmd === "RESET_OPTIONS") {
    syncOptions().then(() => {
      let changedAny = false;
      for (const storageKey of Object.keys(storageCache)) {
        const cacheItem = storageCache[storageKey];
        if (!cacheItem) continue;
        const toDelete = [];
        for (const key in cacheItem) {
          try {
            const it = cacheItem[key];
            const host = new URL(it.url).hostname;
            if (host && isDomainBlocked(host)) {
              toDelete.push(key);
              continue;
            }
            if (!isEligible(it.url, it.type, it.format, it.size || 0)) {
              toDelete.push(key);
              continue;
            }
          } catch {}
        }
        if (toDelete.length > 0) {
          for (const k of toDelete) {
            delete cacheItem[k];
          }
          chrome.storage.local.set({ [storageKey]: cacheItem });
          changedAny = true;
        }
      }
      sendResponse({ changed: changedAny });
    });
    return true;
  }

  sendResponse();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabUrls[tabId];
  removeSessionRulesForTab(tabId);
  const key = `storage${tabId}`;
  
  if (storageWriteQueue.has(key)) {
    clearTimeout(storageWriteQueue.get(key).timer);
    chrome.storage.local.set({ [key]: storageWriteQueue.get(key).data });
    storageWriteQueue.delete(key);
  }

  chrome.storage.local.remove([key]);
  if (storageCache[key]) {
    delete storageCache[key];
  }

  let dlRemoved = false;
  for (const id in activeDownloads) {
    if (activeDownloads[id].tabId === tabId) {
      delete activeDownloads[id];
      dlRemoved = true;
    }
  }
  if (dlRemoved) {
    chrome.storage.local.set({ active_downloads: activeDownloads });
    updateDownloadBadgeAnimation();
  }

  let ulRemoved = false;
  for (const id in activeUploads) {
    if (activeUploads[id].tabId === tabId) {
      delete activeUploads[id];
      ulRemoved = true;
    }
  }
  if (ulRemoved) {
    chrome.storage.local.set({ active_uploads: activeUploads });
    updateDownloadBadgeAnimation();
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    tabUrls[tabId] = changeInfo.url;
  }

  if (changeInfo.status === "loading" && changeInfo.url) {
    try {
      const navHost = new URL(changeInfo.url).hostname;
      if (isDomainBlocked(navHost)) {
        const key = `storage${tabId}`;
        delete storageCache[key];
        chrome.storage.local.remove([key]);
        chrome.action.setBadgeText({ text: "", tabId });
        return;
      }
    } catch {}

    if (OPTION.keepHistory) return;

    const key = `storage${tabId}`;
    if (storageCache[key]) {
      delete storageCache[key];
    }
    chrome.storage.local.remove([key], () => {
      updateBadge({}, tabId);
    });
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (Object.keys(activeDownloads).length > 0) return;
  try {
    const t = await chrome.tabs.get(tabId);
    if (t && t.url) tabUrls[tabId] = t.url;
  } catch(e) {}
  
  const key = `storage${tabId}`;
  if (!storageCache[key]) {
    try {
      const res = await chrome.storage.local.get([key]);
      if (res && res[key]) {
        storageCache[key] = res[key];
      }
    } catch {}
  }
  const cacheItem = storageCache[key] || {};
  updateBadge(cacheItem, tabId);
});

const getHeaderValue = (headerName, headersList) => {
  if (!headersList || !Array.isArray(headersList)) return null;
  const target = headerName.toLowerCase();
  for (let i = 0; i < headersList.length; i++) {
    if (headersList[i].name && headersList[i].name.toLowerCase() === target) {
      return headersList[i].value ? headersList[i].value.toLowerCase() : "";
    }
  }
  return null;
};

const getContentType = (format, defaultContentType) => {
  const mimeTypes = {
    m3u8: "video/mp4",
    m3u: "video/mp4",
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    flv: "video/x-flv",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    wmv: "video/x-ms-wmv",
    ts: "video/mp2t",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    wma: "audio/x-ms-wma",
    opus: "audio/opus",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",
    tiff: "image/tiff",
    avif: "image/avif",
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    txt: "text/plain",
    rtf: "application/rtf",
    odt: "application/vnd.oasis.opendocument.text",
    epub: "application/epub+zip",
    pages: "application/x-iwork-pages-sffpages",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    csv: "text/csv",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    numbers: "application/x-iwork-numbers-sffnumbers",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    odp: "application/vnd.oasis.opendocument.presentation",
    key: "application/x-iwork-keynote-sffkey",
    zip: "application/zip",
    "7z": "application/x-7z-compressed",
    rar: "application/vnd.rar",
    tar: "application/x-tar",
    gz: "application/gzip",
    bz2: "application/x-bzip2",
    xz: "application/x-xz",
    iso: { cat: "files", sub: "disks" }, img: { cat: "files", sub: "disks" },
    bin: { cat: "files", sub: "disks" }, dmg: { cat: "files", sub: "disks" }
  };
  return mimeTypes[format] || defaultContentType;
};

const CATEGORY_MAP = {
  m3u8: { cat: "videos", sub: "video" }, m3u: { cat: "videos", sub: "video" },
  mp4: { cat: "videos", sub: "video" }, webm: { cat: "videos", sub: "video" },
  mkv: { cat: "videos", sub: "video" }, flv: { cat: "videos", sub: "video" },
  mov: { cat: "videos", sub: "video" }, avi: { cat: "videos", sub: "video" },
  wmv: { cat: "videos", sub: "video" }, ts: { cat: "videos", sub: "video" },
  mp3: { cat: "audio", sub: "audio" }, m4a: { cat: "audio", sub: "audio" },
  aac: { cat: "audio", sub: "audio" }, wav: { cat: "audio", sub: "audio" },
  ogg: { cat: "audio", sub: "audio" }, flac: { cat: "audio", sub: "audio" },
  wma: { cat: "audio", sub: "audio" }, opus: { cat: "audio", sub: "audio" },
  png: { cat: "files", sub: "images" }, jpg: { cat: "files", sub: "images" },
  jpeg: { cat: "files", sub: "images" }, webp: { cat: "files", sub: "images" },
  gif: { cat: "files", sub: "images" }, svg: { cat: "files", sub: "images" },
  bmp: { cat: "files", sub: "images" }, ico: { cat: "files", sub: "images" },
  tiff: { cat: "files", sub: "images" }, avif: { cat: "files", sub: "images" },
  pdf: { cat: "files", sub: "pdf" },
  doc: { cat: "files", sub: "docs" }, docx: { cat: "files", sub: "docs" },
  txt: { cat: "files", sub: "docs" }, rtf: { cat: "files", sub: "docs" },
  odt: { cat: "files", sub: "docs" }, epub: { cat: "files", sub: "docs" },
  pages: { cat: "files", sub: "docs" },
  xls: { cat: "files", sub: "sheets" }, xlsx: { cat: "files", sub: "sheets" },
  csv: { cat: "files", sub: "sheets" }, ods: { cat: "files", sub: "sheets" },
  numbers: { cat: "files", sub: "sheets" },
  ppt: { cat: "files", sub: "slides" }, pptx: { cat: "files", sub: "slides" },
  odp: { cat: "files", sub: "slides" }, key: { cat: "files", sub: "slides" },
  zip: { cat: "files", sub: "archives" }, "7z": { cat: "files", sub: "archives" },
  rar: { cat: "files", sub: "archives" }, tar: { cat: "files", sub: "archives" },
  gz: { cat: "files", sub: "archives" }, bz2: { cat: "files", sub: "archives" },
  xz: { cat: "files", sub: "archives" },
  iso: { cat: "files", sub: "disks" }, img: { cat: "files", sub: "disks" },
  bin: { cat: "files", sub: "disks" }, dmg: { cat: "files", sub: "disks" }
};

const allowedFormats = Object.keys(CATEGORY_MAP);

const categorizeItem = (format, contentType) => {
  if (format && CATEGORY_MAP[format]) {
    return {
      category: CATEGORY_MAP[format].cat,
      subCategory: CATEGORY_MAP[format].sub
    };
  }
  const ct = (contentType || "").toLowerCase();
  if (ct.startsWith("video/")) return { category: "videos", sub: "video" };
  if (ct.startsWith("audio/")) return { category: "audio", sub: "audio" };
  if (ct.startsWith("image/")) return { category: "files", sub: "images" };
  if (ct.includes("pdf")) return { category: "files", sub: "pdf" };
  if (ct.includes("sheet") || ct.includes("excel") || ct.includes("csv")) return { category: "files", sub: "sheets" };
  if (ct.includes("presentation") || ct.includes("powerpoint")) return { category: "files", sub: "slides" };
  if (ct.includes("word") || ct.includes("document") || ct.includes("text/")) return { category: "files", sub: "docs" };
  if (ct.includes("zip") || ct.includes("compressed") || ct.includes("archive") || ct.includes("tar")) return { category: "files", sub: "archives" };
  return { category: "files", sub: "docs" };
};

const probeHlsResolution = async (url, headers) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const fetchHeaders = {};
    if (headers) {
      for (const k in headers) {
        if (!["range", "host", "connection", "origin", "referer", "accept-encoding"].includes(k.toLowerCase())) {
          fetchHeaders[k] = headers[k];
        }
      }
    }

    const res = await fetch(url, { signal: controller.signal, headers: fetchHeaders });
    clearTimeout(timeout);
    if (!res.ok) return null;

    const text = await res.text();
    if (!text.includes("#EXTM3U")) return null;

    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    const variants = [];
    let hasSeparateAudio = false;
    let audioUrl = null;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("#EXT-X-MEDIA") && lines[i].includes("TYPE=AUDIO") && lines[i].includes("URI=")) {
        hasSeparateAudio = true;
        if (!audioUrl) {
          const match = lines[i].match(/URI=["']?([^"']+)["']?/);
          if (match && match[1]) {
            let aUrl = match[1];
            if (!aUrl.startsWith("http://") && !aUrl.startsWith("https://")) {
              try { aUrl = new URL(aUrl, url).href; } catch(e) {}
            }
            audioUrl = aUrl;
          }
        }
      }
      if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
        const infLine = lines[i];
        const nextLine = lines[i + 1];
        if (nextLine && !nextLine.startsWith("#")) {
          const resMatch = infLine.match(/RESOLUTION=(\d+x\d+)/i);
          const bwMatch = infLine.match(/BANDWIDTH=(\d+)/i);
          const resolution = resMatch ? resMatch[1] : "";
          const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;

          let label = resolution;
          if (resolution) {
            const h = parseInt(resolution.split("x")[1], 10);
            label = h >= 2160 ? "4K UHD" : (h >= 1080 ? `${h}p FHD` : (h >= 720 ? `${h}p HD` : `${h}p`));
          } else {
            label = bandwidth ? `${Math.round(bandwidth / 1000)}k` : "Stream Track";
          }

          let variantUrl = nextLine;
          if (!variantUrl.startsWith("http://") && !variantUrl.startsWith("https://")) {
            try {
              variantUrl = new URL(variantUrl, url).href;
            } catch {}
          }

          variants.push({
            resolution,
            label,
            bandwidth,
            url: variantUrl
          });
          i++;
        }
      }
    }

    if (variants.length > 0) {
      variants.sort((a, b) => {
        if (a.resolution && b.resolution) {
          const [w1, h1] = a.resolution.split("x").map(Number);
          const [w2, h2] = b.resolution.split("x").map(Number);
          return (w2 * h2) - (w1 * h1);
        }
        return b.bandwidth - a.bandwidth;
      });

      return {
        quality: variants[0].label,
        resolution: variants[0].resolution,
        variants: variants,
        hasSeparateAudio: hasSeparateAudio,
        audioUrl: audioUrl
      };
    }
  } catch {}
  return null;
};

const requestHeadersCache = {};
const excludedHeadersForStorage = ["range", "content-length", "content-type", "accept-encoding", "accept", "accept-language", "authorization", "cookie", "x-auth-token"];

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    
    try {
      if (details.initiator && isDomainBlocked(new URL(details.initiator).hostname)) return;
      if (details.url && isDomainBlocked(new URL(details.url).hostname)) return;
    } catch(e) {}
    
    requestHeadersCache[details.requestId] = details.requestHeaders || [];
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "object", "image", "sub_frame", "other"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onCompleted.addListener(
  (details) => { delete requestHeadersCache[details.requestId]; },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => { delete requestHeadersCache[details.requestId]; },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onResponseStarted.addListener(
  async (details) => {
    let { requestId, initiator, url, tabId, method, responseHeaders, statusCode } = details;

    let reqHeaders = [];
    if (requestHeadersCache[requestId]) {
      reqHeaders = requestHeadersCache[requestId];
      delete requestHeadersCache[requestId];
    }

    if (isScanningPaused) return;

    if (!url || !url.startsWith("http")) return;
    if (initiator && initiator.startsWith(OPTION.site)) return;

    const urlLower = url.toLowerCase();
    let pathname = "";
    try {
      pathname = new URL(url).pathname.toLowerCase();
    } catch {}

    if (
      pathname.endsWith(".ts") ||
      pathname.endsWith(".m4s") ||
      pathname.endsWith(".vtt") ||
      pathname.endsWith(".srt") ||
      pathname.endsWith(".key") ||
      pathname.includes("/segment") ||
      pathname.includes("frag-") ||
      pathname.includes("chunk-") ||
      pathname === "/status" ||
      pathname === "/ping"
    ) {
      return;
    }

    if (tabId === -1) {
      if (!initiator) return;
      try {
        const tabs = await chrome.tabs.query({ url: initiator + "/*" });
        if (tabs && tabs.length > 0) {
          tabId = tabs[0].id;
        } else {
          return;
        }
      } catch (e) {
        return;
      }
    }
    
    if (tabId && tabId !== -1 && !tabUrls[tabId]) {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t && t.url) tabUrls[tabId] = t.url;
      } catch {}
    }

    if (!tabId || tabId === -1) return;
    if (!responseHeaders || responseHeaders.length < 1) return;
    if (statusCode < 200 || statusCode > 300) return;

    try {
      const hostname = new URL(url).hostname;
      if (isDomainBlocked(hostname)) return;

      // Drop requests initiated from or living inside restricted tabs
      if (initiator) {
        const initHost = new URL(initiator).hostname;
        if (isDomainBlocked(initHost)) return;
      }

      if (tabId && tabUrls[tabId]) {
        const tabHost = new URL(tabUrls[tabId]).hostname;
        if (isDomainBlocked(tabHost)) return;
      }
    } catch {}

    let size = 0;
    const contentRange = ((headers) => {
      const range = getHeaderValue("Content-Range", headers);
      if (range) {
        const parts = range.split(" ");
        if (parts.length === 2) {
          const totalPart = parts[1].split("/")[1];
          const parsed = parseInt(totalPart, 10);
          return isNaN(parsed) ? null : parsed;
        }
      }
      return null;
    })(responseHeaders);

    if (contentRange) {
      size = contentRange;
    } else {
      const lengthValue = getHeaderValue("Content-Length", responseHeaders);
      if (lengthValue) {
        const parsed = parseInt(lengthValue, 10);
        size = isNaN(parsed) || parsed < 0 ? 0 : parsed;
      }
    }

    let contentType = getHeaderValue("content-type", responseHeaders) || "";
    if (contentType.includes(";")) {
      contentType = contentType.split(";")[0].trim();
    }

    const isHls =
      urlLower.includes(".m3u8") ||
      urlLower.includes(".m3u") ||
      pathname.endsWith(".m3u8") ||
      contentType.includes("mpegurl");

    if (isHls) {
      contentType = "application/vnd.apple.mpegurl";
    }

    if (!contentType) {
      if (pathname.endsWith(".mp4") || urlLower.includes(".mp4")) contentType = "video/mp4";
      else if (pathname.endsWith(".webm") || urlLower.includes(".webm")) contentType = "video/webm";
      else if (pathname.endsWith(".mp3")) contentType = "audio/mpeg";
      else if (pathname.endsWith(".pdf") || urlLower.includes(".pdf")) contentType = "application/pdf";
      else if (pathname.endsWith(".zip")) contentType = "application/zip";
      else if (pathname.endsWith(".vtt")) contentType = "text/vtt";
      else if (pathname.endsWith(".srt")) contentType = "text/plain";
    }

    let filename = ((detailsObj) => {
      const { responseHeaders: headers, url: u } = detailsObj;
      let name = null;
      const contentDisposition = getHeaderValue("content-disposition", headers);
      if (contentDisposition && contentDisposition.includes("filename=")) {
        const match = contentDisposition.match(/filename=["']?([^"';]+)["']?/i);
        if (match && match[1]) {
          name = match[1].trim();
        }
      }
      if (!name) {
        try {
          const segments = new URL(u).pathname.split("/").filter(Boolean);
          if (segments.length > 0) {
            name = segments[segments.length - 1];
          }
        } catch {}
      }
      if (name) {
        try {
          name = decodeURIComponent(name);
        } catch {}
      }
      return name;
    })(details);

    if (!filename) {
      filename = isHls ? "stream.m3u8" : "media.mp4";
    }

    let format = null;
    if (isHls) {
      format = "m3u8";
    } else {
      let ext = null;
      if (filename && filename.includes(".")) {
        ext = filename.split(".").pop().toLowerCase();
      }
      if ((!ext || !allowedFormats.includes(ext)) && pathname.includes(".")) {
        const pathExt = pathname.split(".").pop().toLowerCase();
        if (allowedFormats.includes(pathExt)) ext = pathExt;
      }

      if (ext && allowedFormats.includes(ext)) {
        format = ext;
      } else if (contentType.includes("pdf")) {
        format = "pdf";
      } else if (contentType.includes("mp4") || urlLower.includes(".mp4")) {
        format = "mp4";
      } else if (contentType.includes("webm") || urlLower.includes(".webm")) {
        format = "webm";
      } else if (contentType.includes("mpeg") || contentType.includes("mp3")) {
        format = "mp3";
      } else if (contentType.includes("ogg")) {
        format = "ogg";
      } else if (contentType.includes("wav")) {
        format = "wav";
      } else if (contentType.startsWith("image/")) {
        const sub = contentType.split("/")[1]?.replace("+xml", "").trim();
        format = allowedFormats.includes(sub) ? sub : "png";
      } else if (contentType.startsWith("video/")) {
        format = "mp4";
      } else if (contentType.startsWith("audio/")) {
        format = "mp3";
      } else if (contentType.includes("spreadsheet") || contentType.includes("excel") || contentType.includes("csv")) {
        format = "xlsx";
      } else if (contentType.includes("presentation") || contentType.includes("powerpoint")) {
        format = "pptx";
      } else if (contentType.includes("word") || contentType.includes("document")) {
        format = "docx";
      } else if (contentType.includes("zip") || contentType.includes("compressed") || contentType.includes("archive")) {
        format = "zip";
      }
    }

    if (!format || !allowedFormats.includes(format)) return;

    if (filename) {
      const dotIdx = filename.lastIndexOf(".");
      if (dotIdx !== -1) {
        const curExt = filename.substring(dotIdx + 1).toLowerCase();
        if (format === "mp3" && (curExt === "mp4" || curExt === "m4a" || curExt === "octet-stream" || curExt === "bin")) {
          filename = filename.substring(0, dotIdx) + ".mp3";
        }
      } else {
        filename = `${filename}.${format === "m3u8" ? "m3u8" : format}`;
      }
    }

    const mediaType = format === "m3u8" || format === "m3u" ? "hls" : format;
    const categoryInfo = categorizeItem(format, contentType);

    const filters = OPTION.scanFilters || { categories: {}, subCategories: {}, formats: {} };

    if (filters.categories && filters.categories[categoryInfo.category] === false) return;
    if (filters.subCategories && filters.subCategories[categoryInfo.subCategory] === false) return;
    if (filters.formats && filters.formats[format] === false) return;

    if (mediaType !== "hls") {
      let minThreshold = 51200; 
      if (categoryInfo.category === "audio") {
        minThreshold = 10240; 
      } else if (categoryInfo.category === "files") {
        if (categoryInfo.subCategory === "images") {
          minThreshold = 2048; 
        } else {
          minThreshold = 512; 
        }
      }
      if (OPTION.size?.min > 0) {
        minThreshold = Math.max(minThreshold, OPTION.size.min);
      }
      if (size > 0 && size < minThreshold) return;
      if (OPTION.size?.max && size > OPTION.size.max) return;
    }

    const storageKey = `storage${tabId}`;
    let tabStorage = storageCache[storageKey];
    if (!tabStorage) {
      try {
        const stored = await chrome.storage.local.get([storageKey]);
        tabStorage = stored?.[storageKey] || {};
      } catch (e) {
        tabStorage = {};
      }
      storageCache[storageKey] = tabStorage;
    }

    const keys = Object.keys(tabStorage);
    if (keys.length >= 500) {
      const oldestKey = keys[0];
      delete tabStorage[oldestKey];
    }

    for (const key in tabStorage) {
      if (tabStorage[key].url === url) {
        updateBadge(tabStorage, tabId);
        return;
      }
    }

    const headersToSave = {};
    for (const h of reqHeaders) {
      if (h && h.name && !excludedHeadersForStorage.includes(h.name.toLowerCase())) {
        headersToSave[h.name] = h.value;
      }
    }

    tabStorage[requestId] = {
      storageKey,
      requestId,
      url,
      method: method === "POST" ? "POST" : "GET",
      format,
      contentType: getContentType(format, contentType),
      name: filename,
      size: size || 0,
      headers: headersToSave,
      type: mediaType,
      category: categoryInfo.category,
      subCategory: categoryInfo.subCategory,
      resolution: null,
      variants: null,
      pageUrl: tabUrls[tabId] || ""
    };

    debouncedStorageSet(storageKey, tabStorage);

    if (mediaType === "hls") {
      probeHlsResolution(url, headersToSave).then((resInfo) => {
        if (resInfo && tabStorage[requestId]) {
          tabStorage[requestId].resolution = resInfo.quality;
          tabStorage[requestId].variants = resInfo.variants;
          tabStorage[requestId].hasSeparateAudio = resInfo.hasSeparateAudio;
          tabStorage[requestId].audioUrl = resInfo.audioUrl;
          debouncedStorageSet(storageKey, tabStorage);

          chrome.runtime.sendMessage({
            cmd: "POPUP_UPDATE_ITEM",
            parameter: {
              tab: tabId,
              requestId,
              resolution: resInfo.quality,
              variants: resInfo.variants,
              hasSeparateAudio: resInfo.hasSeparateAudio,
              audioUrl: resInfo.audioUrl
            }
          }, () => { if (chrome.runtime.lastError) {} });
        }
      });
    }

    chrome.runtime.sendMessage({
      cmd: "POPUP_APPEND_ITEMS",
      parameter: { tab: tabId, item: { [requestId]: tabStorage[requestId] } }
    }, () => {
      if (chrome.runtime.lastError) {}
    });

    updateBadge(tabStorage, tabId);
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "object", "image", "sub_frame", "other"] },
  ["responseHeaders", "extraHeaders"]
);

syncOptions();
cleanupStorageAndCache();





