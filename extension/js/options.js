/**
 * Restricted domains list.
 */
const RESTRICTED_DOMAINS = [
  // Hardcoded list of restrcited domains from scanning.
  "example1.com",
  "example2.com",
  "example3.com"
];

/**
 * Default configuration options for FetchStream.
 */
const OPTION = {
  /**
   * File size filtering thresholds in KB (0 represents no limit).
   */
  size: {
    min: 0,
    max: 0,
  },

  /**
   * Granular media scanning filters.
   */
  scanFilters: {
    categories: {
      videos: true,
      audio: true,
      files: false
    },
    subCategories: {
      video: true,
      audio: true,
      images: false,
      pdf: false,
      docs: false,
      sheets: false,
      slides: false,
      archives: false,
      disks: false
    },
    formats: {
      // Video
      m3u8: true,
      m3u: true,
      mp4: true,
      webm: true,
      mkv: true,
      flv: true,
      mov: true,
      avi: true,
      wmv: true,
      ts: true,
      // Audio
      mp3: true,
      m4a: true,
      aac: true,
      wav: true,
      ogg: true,
      flac: true,
      wma: true,
      opus: true,
      // Images
      png: false,
      jpg: false,
      jpeg: false,
      webp: false,
      gif: false,
      svg: false,
      bmp: false,
      ico: false,
      tiff: false,
      avif: false,
      // Documents & PDFs
      pdf: false,
      doc: false,
      docx: false,
      txt: false,
      rtf: false,
      odt: false,
      epub: false,
      pages: false,
      // Spreadsheets
      xls: false,
      xlsx: false,
      csv: false,
      ods: false,
      numbers: false,
      // Presentations
      ppt: false,
      pptx: false,
      odp: false,
      key: false,
      // Archives
      zip: false,
      "7z": false,
      rar: false,
      tar: false,
      gz: false,
      bz2: false,
      xz: false,
      // Disk Images
      iso: false,
      img: false,
      bin: false,
      dmg: false
    }
  },

  /**
   * Parallel download worker count (2 to 16).
   */
  concurrency: 6,

  /**
   * Segment download retry attempts on network failure.
   */
  retries: 3,

  /**
   * Retain captured media items in session storage across navigations.
   */
  keepHistory: true,

  /**
   * Opt-in to receive beta updates.
   */
  betaUpdates: false,

  /**
   * Restrict popup view to media originating from the active tab.
   */
  currentTabOnly: false,

  /**
   * Maximum number of permanent history records to retain.
   * Set to 0 for unlimited (not recommended). Max allowed: 1000.
   */
  historyLimit: 500,

  /**
   * Domain blacklist for filtering out unwanted resources.
   */
  domain: [],



  /**
   * Service documentation and update endpoint.
   */
  site: "https://fetchstream.in",

  /**
   * Packaged fallback links. Remote configuration may replace these values,
   * but only after its URLs pass the validation below.
   */
  links: {
    website: "https://fetchstream.in/",
    apiDocs: "https://fetchstream.in/documentation.html",
    faq: "https://fetchstream.in/#faq",
    privacy: "https://fetchstream.in/#privacy",
    blocking: "https://fetchstream.in/",
    download_stable: "https://github.com/Abhishek-banal/fetchstream/releases/latest/download/fetchstream-extension.zip",
    download_beta: "https://github.com/Abhishek-banal/fetchstream/releases"
  },

  /**
   * Browser-based upload configuration.
   */
  upload: {
    service: "local",
    credentials: {},
    customList: ["gofile.io", "buzzheavier.com"]
  },

  /**
   * Cloud runner configuration for remote uploads.
   */
  serverUpload: {
    relayUrl: "",
    apiKey: "",
    service: "gofile.io",
    customList: ["gofile.io", "buzzheavier.com"],
    useFallbackProxy: true
  }
};

function normalizeUploadDestinationOptions(options) {
  if (!options || typeof options !== "object") return options;
  if (!options.serverUpload || typeof options.serverUpload !== "object") {
    options.serverUpload = {};
  }

  const legacyService = options.upload?.service;
  const legacyList = options.upload?.customList;
  if (!options.serverUpload.service || options.serverUpload.service === "gofile.io") {
    if (legacyService && legacyService !== "local") {
      options.serverUpload.service = legacyService;
    }
  }
  if (!Array.isArray(options.serverUpload.customList) || options.serverUpload.customList.length === 0) {
    options.serverUpload.customList = Array.isArray(legacyList) && legacyList.length > 0
      ? [...legacyList]
      : ["gofile.io", "buzzheavier.com"];
  }
  if (!options.serverUpload.service || options.serverUpload.service === "local") {
    options.serverUpload.service = "gofile.io";
  }
  return options;
}

/**
 * Allowlist of trusted domains permitted for remote configuration URLs.
 * In no case should remote config direct users outside of these hosts.
 */
const TRUSTED_CONFIG_DOMAINS = [
  "fetchstream.in",
  "fetchstream.pages.dev",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "github.com"
];

/**
 * Check whether a hostname is strictly equal to or a subdomain of a trusted domain.
 */
function isTrustedConfigHostname(hostname) {
  if (typeof hostname !== "string") return false;
  const host = hostname.toLowerCase().trim();
  return TRUSTED_CONFIG_DOMAINS.some(
    (trusted) => host === trusted || host.endsWith("." + trusted)
  );
}

/**
 * Return an HTTPS URL if it belongs to an allowlisted domain, or fallback.
 * Prevents compromised server responses from redirecting users to arbitrary sites.
 */
function sanitizeExternalUrl(value, fallback = "#") {
  if (typeof value !== "string") return fallback;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return fallback;
    if (!isTrustedConfigHostname(url.hostname)) return fallback;
    return url.href;
  } catch (error) {
    return fallback;
  }
}

function isValidRunnerUrl(urlString) {
  if (typeof urlString !== "string" || urlString.length > 2048) return false;

  try {
    const url = new URL(urlString);
    const isLocalhost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return url.username === "" && url.password === "" &&
      (url.protocol === "https:" || (url.protocol === "http:" && isLocalhost));
  } catch (error) {
    return false;
  }
}

function isSafeHttpUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (error) {
    return false;
  }
}

/**
 * Remote configuration is preferred when it is a valid HTTPS URL. Packaged
 * defaults keep extension pages usable on first-run and while offline.
 */
function getSecureConfigLink(key, remoteLinks = {}) {
  const fallback = sanitizeExternalUrl(OPTION.links?.[key], "#");
  return sanitizeExternalUrl(remoteLinks?.[key], fallback);
}

/**
 * Bind shared website/documentation links across extension pages. Pages may
 * use either the popup's selector attribute or a conventional element id.
 */
async function bindSecureGlobalLinks() {
  if (typeof document === "undefined" || typeof chrome === "undefined") return;

  let remoteLinks = {};
  if (typeof navigator === "undefined" || navigator.onLine !== false) {
    try {
      const stored = await chrome.storage.local.get("fs_dynamic_config");
      remoteLinks = stored?.fs_dynamic_config?.links || {};
    } catch (error) {
      // The packaged links below are intentionally used when storage is absent.
    }
  }

  const linkTargets = [
    { key: "website", selector: '[selector="websiteBtn"], #websiteBtn' },
    { key: "apiDocs", selector: '[selector="apiDocsBtn"], #apiDocsBtn, #linkServerDocumentation' },
    { key: "faq", selector: '[selector="faqBtn"], #faqBtn' },
    { key: "privacy", selector: '[selector="privacyBtn"], #privacyBtn' },
    { key: "blocking", selector: '[selector="disableDetail"]' }
  ];

  for (const { key, selector } of linkTargets) {
    const url = getSecureConfigLink(key, remoteLinks);
    document.querySelectorAll(selector).forEach((element) => {
      element.href = url;
      element.rel = "noopener noreferrer";
    });
  }
}

if (typeof document !== "undefined") {
  const bindLinksWhenReady = () => {
    bindSecureGlobalLinks().catch((error) => {
      console.warn("[FetchStream] Could not bind global links:", error);
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindLinksWhenReady, { once: true });
  } else {
    bindLinksWhenReady();
  }

  window.addEventListener("online", bindLinksWhenReady);
  window.addEventListener("offline", bindLinksWhenReady);
  chrome.storage?.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.fs_dynamic_config) {
      bindLinksWhenReady();
    }
  });
}
