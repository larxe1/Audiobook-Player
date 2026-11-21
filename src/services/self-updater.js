export const LOCAL_VERSION = '1.0.19';
export const LOCAL_BUILD = 20;
const LOCAL_BUILD_VERSION = '1.0.19';

/**
 * Detect the runtime platform for update delivery.
 * Distinguishes Tauri Windows desktop ('windows-tauri'), Capacitor Android APK ('android-apk'),
 * and Web/PWA including Android Chrome PWA ('web').
 * @param {any} [win]
 * @param {any} [nav]
 * @returns {'windows-tauri' | 'android-apk' | 'web'}
 */
export function detectPlatform(
  win = typeof globalThis.window !== 'undefined' ? globalThis.window : null,
  nav = typeof globalThis.navigator !== 'undefined' ? globalThis.navigator : null
) {
  const origin = win?.location?.origin || '';
  const protocol = win?.location?.protocol || '';
  const ua = nav?.userAgent || '';

  if (win?.__TAURI__ || win?.__TAURI_INTERNALS__ || /tauri\.localhost/i.test(origin)) {
    return 'windows-tauri';
  }

  const isCapacitorNative =
    Boolean(win?.AudiobookUpdaterNative) ||
    Boolean(win?.AudiobookUpdaterBridge) ||
    Boolean(win?.AudiobookOAuthNative) ||
    (typeof win?.Capacitor?.isNativePlatform === 'function' && win.Capacitor.isNativePlatform()) ||
    Boolean(win?.Capacitor?.isNative) ||
    protocol === 'capacitor:' ||
    /^capacitor:\/\//i.test(origin) ||
    (/Android/i.test(ua) && /^https?:\/\/localhost(?::\d+)?$/i.test(origin));

  if (isCapacitorNative) {
    return 'android-apk';
  }

  return 'web';
}

export const DEFAULT_MANIFEST_URL =
  'https://raw.githubusercontent.com/larxe1/Audiobook-Player/main/version.json';
export const DEFAULT_APK_DOWNLOAD_URL =
  'https://github.com/larxe1/Audiobook-Player/releases/latest/download/Audiobook-Player.apk';
export const DEFAULT_EXE_DOWNLOAD_URL =
  'https://github.com/larxe1/Audiobook-Player/releases/latest/download/Audiobook-Player.exe';
export const DEFAULT_WEB_BUNDLE_URL =
  'https://github.com/larxe1/Audiobook-Player/releases/latest/download/web-bundle.zip';
export const DEFAULT_OTA_BUNDLE_URL = 'https://larxe1.github.io/Audiobook-Player/';
export const GITHUB_PAGES_APK_URL = 'https://larxe1.github.io/Audiobook-Player/Audiobook-Player.apk';
export const GITHUB_RELEASES_TAG_API_PREFIX =
  'https://api.github.com/repos/larxe1/Audiobook-Player/releases/tags/';
export const GITHUB_RELEASES_TAG_DOWNLOAD_PREFIX =
  'https://github.com/larxe1/Audiobook-Player/releases/download/';

const STORAGE_UPDATE_URL_KEY = 'audiobook_remote_version_url';
const SESSION_UPDATED_BUILD_KEY = 'audiobook_updated_to_build';
const MANDATORY_GATE_ID = 'mandatory-update-gate';
const DEFAULT_CI_POLL_INTERVAL_MS = 8000;
const DEFAULT_MONITOR_INTERVAL_MS = 300000;
const FOCUS_RECHECK_COOLDOWN_MS = 30000;

let sharedGateState = {
  key: '',
  inFlight: null
};

/**
 * Parse a semver string (e.g. "v1.2.3-beta.1") into numeric core parts and prerelease tag.
 * @param {string} version
 * @returns {{ core: number[], prerelease: string }}
 */
function parseSemver(version) {
  const cleaned = String(version ?? '0.0.0').trim().replace(/^v/i, '');
  const [corePart, prerelease = ''] = cleaned.split('-', 2);
  const parts = corePart.split('.').map((n) => {
    const parsed = Number.parseInt(n, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  });
  while (parts.length < 3) parts.push(0);
  return { core: parts.slice(0, 3), prerelease };
}

/**
 * Compare two semantic version strings.
 * @param {string} vA
 * @param {string} vB
 * @returns {-1 | 0 | 1}
 */
export function compareSemver(vA, vB) {
  const a = parseSemver(vA);
  const b = parseSemver(vB);

  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] < b.core[i]) return -1;
    if (a.core[i] > b.core[i]) return 1;
  }

  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/**
 * Determine whether a remote version/build is newer than the currently running version/build.
 * @param {string} remoteVersion
 * @param {number | null | undefined} remoteBuild
 * @param {string} currentVersion
 * @param {number | null | undefined} currentBuild
 * @returns {boolean}
 */
export function isNewerUpdate(remoteVersion, remoteBuild, currentVersion, currentBuild = null) {
  const cmp = compareSemver(remoteVersion, currentVersion);
  if (cmp > 0) return true;
  if (cmp < 0) return false;
  const rBuild = Number(remoteBuild);
  const cBuild = Number(currentBuild);
  if (Number.isFinite(rBuild) && Number.isFinite(cBuild) && cBuild > 0 && rBuild > cBuild) {
    return true;
  }
  return false;
}

/**
 * Append a cache-busting `?v=<version>-<build>` parameter to an asset or page URL.
 * @param {string} rawUrl
 * @param {string} version
 * @param {number | string} build
 * @returns {string}
 */
export function appendCacheBustParam(rawUrl, version, build) {
  const base = String(rawUrl || '').trim();
  if (!base) return '';
  const tag = `${String(version || '').replace(/^v/i, '') || 'latest'}-${Number(build) || 1}`;
  try {
    const parsed = new URL(base);
    parsed.searchParams.set('v', tag);
    return parsed.toString();
  } catch {
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}v=${encodeURIComponent(tag)}`;
  }
}

function isRepoReleaseDownloadUrl(url) {
  return /^https:\/\/github\.com\/larxe1\/Audiobook-Player\/releases\/(?:latest\/download|download\/[^/]+)\//i.test(
    String(url || '').trim()
  );
}

/**
 * Normalize either a direct version.json manifest or a GitHub Releases API payload.
 * @param {Record<string, any>} payload
 * @param {{ manifestUrl?: string, apkDownloadUrl?: string, exeDownloadUrl?: string, otaBundleUrl?: string, webBundleUrl?: string }} [defaults]
 */
function normalizeManifest(payload, defaults = {}) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const defaultManifestUrl = defaults.manifestUrl || DEFAULT_MANIFEST_URL;
  const defaultApkUrl = defaults.apkDownloadUrl || DEFAULT_APK_DOWNLOAD_URL;
  const defaultExeUrl = defaults.exeDownloadUrl || DEFAULT_EXE_DOWNLOAD_URL;
  const defaultOtaUrl = defaults.otaBundleUrl || DEFAULT_OTA_BUNDLE_URL;
  const defaultWebBundleUrl = defaults.webBundleUrl || DEFAULT_WEB_BUNDLE_URL;
  const parsedMinNativeBuild = Number(payload.minNativeBuild);
  const minNativeBuild =
    Number.isFinite(parsedMinNativeBuild) && parsedMinNativeBuild > 0 ? parsedMinNativeBuild : 0;

  // GitHub Releases API shape
  if (typeof payload.tag_name === 'string') {
    const assets = Array.isArray(payload.assets) ? payload.assets : [];
    const apkAsset =
      assets.find((a) => /^multiplayer.*\.apk$/i.test(String(a?.name || ''))) ||
      assets.find((a) => /^audiobook-player.*\.apk$/i.test(String(a?.name || ''))) ||
      assets.find((a) => String(a?.name || '').toLowerCase().endsWith('.apk'));
    const exeAsset =
      assets.find((a) => /^multiplayer.*\.exe$/i.test(String(a?.name || ''))) ||
      assets.find((a) => /^audiobook-player.*\.exe$/i.test(String(a?.name || ''))) ||
      assets.find((a) => String(a?.name || '').toLowerCase().endsWith('.exe'));
    const webBundleAsset =
      assets.find((a) => String(a?.name || '').toLowerCase() === 'web-bundle.zip') ||
      assets.find((a) => {
        const name = String(a?.name || '').toLowerCase();
        return name.endsWith('.zip') && name.includes('web-bundle');
      });
    const otaAsset = assets.find((a) => {
      const name = String(a?.name || '').toLowerCase();
      return name.endsWith('.zip') || name.endsWith('.tar.gz');
    });

    return {
      version: payload.tag_name.replace(/^v/i, ''),
      build: Number(payload.id) || 1,
      minNativeBuild,
      channel: payload.prerelease ? 'beta' : 'stable',
      publishedAt: payload.published_at || '',
      manifestUrl: defaultManifestUrl,
      apkDownloadUrl: apkAsset?.browser_download_url || defaultApkUrl,
      exeDownloadUrl: exeAsset?.browser_download_url || defaultExeUrl,
      webBundleUrl: webBundleAsset?.browser_download_url || defaultWebBundleUrl,
      otaBundleUrl: otaAsset?.browser_download_url || defaultOtaUrl,
      releaseNotes: payload.body || payload.name || ''
    };
  }

  if (typeof payload.version === 'string') {
    return {
      version: payload.version.replace(/^v/i, ''),
      build: Number(payload.build) || 1,
      minNativeBuild,
      channel: payload.channel || 'stable',
      publishedAt: payload.publishedAt || '',
      manifestUrl: payload.manifestUrl || defaultManifestUrl,
      apkDownloadUrl: payload.apkDownloadUrl ?? defaultApkUrl,
      exeDownloadUrl: payload.exeDownloadUrl ?? defaultExeUrl,
      webBundleUrl: payload.webBundleUrl ?? defaultWebBundleUrl,
      otaBundleUrl: payload.otaBundleUrl ?? defaultOtaUrl,
      releaseNotes: payload.releaseNotes || ''
    };
  }

  return null;
}

export class SelfUpdaterService {
  /**
   * @param {Object} [options]
   * @param {string} [options.currentVersion]
   * @param {number | null} [options.currentBuild]
   * @param {string} [options.manifestUrl]
   * @param {string} [options.remoteVersionUrl]
   * @param {string} [options.apkDownloadUrl]
   * @param {string} [options.exeDownloadUrl]
   * @param {string} [options.webBundleUrl]
   * @param {string} [options.otaBundleUrl]
   * @param {string} [options.localVersionUrl]
   * @param {Storage | null} [options.storage]
   * @param {any} [options.windowObj]
   * @param {any} [options.documentObj]
   * @param {any} [options.navigatorObj]
   * @param {any} [options.sessionStorageObj]
   * @param {any} [options.cachesObj]
   * @param {typeof fetch} [options.fetchImpl]
   * @param {number} [options.pollIntervalMs]
   * @param {number} [options.checkIntervalMs]
   * @param {() => void} [options.onBeforeUpdate]
   */
  constructor(options = {}) {
    this.currentVersion = options.currentVersion || LOCAL_VERSION;
    this.currentBuild =
      options.currentBuild !== undefined && options.currentBuild !== null
        ? Number(options.currentBuild)
        : null;
    this._resolvedLocalBuild = null;
    this.storage =
      options.storage !== undefined
        ? options.storage
        : typeof globalThis.localStorage !== 'undefined'
          ? globalThis.localStorage
          : null;
    this.manifestUrl =
      options.manifestUrl ||
      options.remoteVersionUrl ||
      this.storage?.getItem?.(STORAGE_UPDATE_URL_KEY) ||
      DEFAULT_MANIFEST_URL;
    this.remoteVersionUrl = this.manifestUrl;
    this.apkDownloadUrl = options.apkDownloadUrl || DEFAULT_APK_DOWNLOAD_URL;
    this.exeDownloadUrl = options.exeDownloadUrl || DEFAULT_EXE_DOWNLOAD_URL;
    this.webBundleUrl = options.webBundleUrl || DEFAULT_WEB_BUNDLE_URL;
    this.otaBundleUrl = options.otaBundleUrl || DEFAULT_OTA_BUNDLE_URL;
    this.localVersionUrl = options.localVersionUrl || './version.json';
    this.lastManifest = null;

    this._windowObj = options.windowObj;
    this._documentObj = options.documentObj;
    this._navigatorObj = options.navigatorObj;
    this._sessionStorageObj = options.sessionStorageObj;
    this._cachesObj = options.cachesObj;
    this._fetchImpl = options.fetchImpl;
    this._pollIntervalMs =
      Number(options.pollIntervalMs) > 0 ? Number(options.pollIntervalMs) : DEFAULT_CI_POLL_INTERVAL_MS;
    this._checkIntervalMs =
      Number(options.checkIntervalMs) > 0 ? Number(options.checkIntervalMs) : DEFAULT_MONITOR_INTERVAL_MS;
    this._onBeforeUpdate = typeof options.onBeforeUpdate === 'function' ? options.onBeforeUpdate : null;
    this._monitorCleanup = null;
    this._pollTimer = null;
    this._gateController = null;
  }

  _getEnv(overrides = {}) {
    const win =
      overrides.windowObj !== undefined
        ? overrides.windowObj
        : this._windowObj !== undefined
          ? this._windowObj
          : typeof globalThis.window !== 'undefined'
            ? globalThis.window
            : null;
    const doc =
      overrides.documentObj !== undefined
        ? overrides.documentObj
        : this._documentObj !== undefined
          ? this._documentObj
          : win?.document ?? (typeof globalThis.document !== 'undefined' ? globalThis.document : null);
    const nav =
      overrides.navigatorObj !== undefined
        ? overrides.navigatorObj
        : this._navigatorObj !== undefined
          ? this._navigatorObj
          : win?.navigator ?? (typeof globalThis.navigator !== 'undefined' ? globalThis.navigator : null);
    const sessionStore =
      overrides.sessionStorageObj !== undefined
        ? overrides.sessionStorageObj
        : this._sessionStorageObj !== undefined
          ? this._sessionStorageObj
          : win?.sessionStorage ??
            (typeof globalThis.sessionStorage !== 'undefined' ? globalThis.sessionStorage : null);
    const cachesApi =
      overrides.cachesObj !== undefined
        ? overrides.cachesObj
        : this._cachesObj !== undefined
          ? this._cachesObj
          : win?.caches ?? (typeof globalThis.caches !== 'undefined' ? globalThis.caches : null);
    const fetchFn =
      overrides.fetchImpl !== undefined
        ? overrides.fetchImpl
        : this._fetchImpl !== undefined
          ? this._fetchImpl
          : typeof globalThis.fetch === 'function'
            ? globalThis.fetch.bind(globalThis)
            : null;

    return { win, doc, nav, sessionStore, cachesApi, fetchFn };
  }

  /**
   * Persist or change the remote version.json / GitHub Releases endpoint URL.
   * @param {string} url
   */
  setRemoteVersionUrl(url) {
    const cleaned = String(url || '').trim();
    this.manifestUrl = cleaned || DEFAULT_MANIFEST_URL;
    this.remoteVersionUrl = this.manifestUrl;
    if (this.storage?.setItem) {
      if (cleaned) {
        this.storage.setItem(STORAGE_UPDATE_URL_KEY, cleaned);
      } else {
        this.storage.removeItem?.(STORAGE_UPDATE_URL_KEY);
      }
    }
  }

  /**
   * Fetch and parse a manifest URL safely.
   * @param {string} url
   * @param {typeof fetch} fetchImpl
   */
  async _fetchManifest(url, fetchImpl) {
    if (!url || typeof fetchImpl !== 'function') return null;
    try {
      const response = await fetchImpl(url, { cache: 'no-store' });
      if (!response || !response.ok) return null;
      const data = await response.json();
      return normalizeManifest(data, {
        manifestUrl: this.manifestUrl,
        apkDownloadUrl: this.apkDownloadUrl,
        exeDownloadUrl: this.exeDownloadUrl,
        webBundleUrl: this.webBundleUrl,
        otaBundleUrl: this.otaBundleUrl
      });
    } catch {
      return null;
    }
  }

  /**
   * Resolve the local bundled build number when running inside Tauri or Capacitor APK,
   * or fall back to LOCAL_BUILD when currentVersion matches LOCAL_BUILD_VERSION.
   * @param {typeof fetch} [fetchImpl]
   * @returns {Promise<number | null>}
   */
  async resolveLocalBuild(fetchImpl) {
    if (Number.isFinite(this.currentBuild) && this.currentBuild > 0) {
      return this.currentBuild;
    }
    if (Number.isFinite(this._resolvedLocalBuild) && this._resolvedLocalBuild > 0) {
      return this._resolvedLocalBuild;
    }

    const { win, nav, fetchFn } = this._getEnv({ fetchImpl });
    const platform = this.detectPlatform(win, nav);
    // Only read bundled ./version.json on native apps (Tauri / Capacitor) when not using a caller-supplied mock fetch,
    // so unit tests passing mock fetchImpl are never surprised by extra ./version.json fetches.
    const isUsingCustomMockFetch =
      typeof fetchImpl === 'function' &&
      fetchImpl !== this._fetchImpl &&
      fetchImpl !== globalThis.fetch;

    if (
      (platform === 'windows-tauri' || platform === 'android-apk') &&
      !isUsingCustomMockFetch &&
      typeof fetchFn === 'function'
    ) {
      const localManifest = await this._fetchManifest(this.localVersionUrl, fetchFn);
      if (
        localManifest &&
        compareSemver(localManifest.version, this.currentVersion) === 0 &&
        Number.isFinite(localManifest.build) &&
        localManifest.build > 0
      ) {
        this._resolvedLocalBuild = localManifest.build;
        return this._resolvedLocalBuild;
      }
    }

    if (this.currentVersion === LOCAL_BUILD_VERSION && Number.isFinite(LOCAL_BUILD) && LOCAL_BUILD > 0) {
      return LOCAL_BUILD;
    }

    return null;
  }

  /**
   * Check remote endpoint (or local version.json fallback) for an available update.
   * @param {typeof fetch} [fetchImpl]
   */
  async checkForUpdate(fetchImpl = this._fetchImpl ?? globalThis.fetch) {
    let manifest = null;
    let source = 'fallback';

    if (this.remoteVersionUrl) {
      manifest = await this._fetchManifest(this.remoteVersionUrl, fetchImpl);
      if (manifest) source = 'remote';
    }

    if (!manifest) {
      manifest = await this._fetchManifest(this.localVersionUrl, fetchImpl);
      if (manifest) source = 'local';
    }

    const resolvedBuild = await this.resolveLocalBuild(fetchImpl);

    if (!manifest) {
      return {
        updateAvailable: false,
        currentVersion: this.currentVersion,
        currentBuild: resolvedBuild,
        latestVersion: this.currentVersion,
        latestBuild: resolvedBuild,
        minNativeBuild: 0,
        apkDownloadUrl: '',
        exeDownloadUrl: '',
        webBundleUrl: '',
        otaBundleUrl: '',
        releaseNotes: '',
        source: 'offline'
      };
    }

    this.lastManifest = manifest;
    const updateAvailable =
      source === 'local'
        ? false
        : isNewerUpdate(manifest.version, manifest.build, this.currentVersion, resolvedBuild);

    return {
      updateAvailable,
      currentVersion: this.currentVersion,
      currentBuild: resolvedBuild,
      latestVersion: manifest.version,
      latestBuild: manifest.build,
      minNativeBuild: Number(manifest.minNativeBuild) || 0,
      apkDownloadUrl: manifest.apkDownloadUrl || '',
      exeDownloadUrl: manifest.exeDownloadUrl || '',
      webBundleUrl: manifest.webBundleUrl || '',
      otaBundleUrl: manifest.otaBundleUrl || '',
      releaseNotes: manifest.releaseNotes || '',
      source
    };
  }

  /**
   * Determine whether live Android Web Bundle OTA (`web-bundle.zip`) can be used on this device.
   * @param {Record<string, any>} [activeManifest]
   * @param {any} [win]
   * @returns {boolean}
   */
  _canUseAndroidWebOta(activeManifest = {}, win = this._getEnv().win) {
    if (typeof win?.AudiobookUpdaterNative?.startWebOtaUpdate !== 'function') {
      return false;
    }
    if (typeof win?.AudiobookUpdaterNative?.getNativeBuild !== 'function') {
      return false;
    }
    const minNativeBuild = Number(activeManifest?.minNativeBuild) || 0;
    if (!minNativeBuild) {
      return true;
    }
    let nativeBuild = 0;
    try {
      nativeBuild = Number(win.AudiobookUpdaterNative.getNativeBuild()) || 0;
    } catch {
      nativeBuild = 0;
    }
    return nativeBuild >= minNativeBuild;
  }

  /**
   * Verify that the release package (.apk, web-bundle.zip, or .exe) for `manifest.version` is actually
   * built and published before starting download, preventing downloading an older `releases/latest` asset
   * while GitHub Actions CI is still compiling the new release.
   * @param {'windows-tauri' | 'android-apk' | string} platform
   * @param {Record<string, any>} [manifest]
   * @param {typeof fetch} [fetchImpl]
   * @returns {Promise<{ ready: boolean, url: string, deliveryMode?: 'exe' | 'web-ota' | 'apk', reason?: string, source?: string }>}
   */
  async resolveReadyPackageUrl(
    platform,
    manifest = this.lastManifest,
    fetchImpl = this._fetchImpl ?? globalThis.fetch
  ) {
    const activeManifest = manifest || this.lastManifest || {};
    const remoteVersion = String(activeManifest.version || activeManifest.latestVersion || '')
      .trim()
      .replace(/^v/i, '');
    const remoteBuild = Number(activeManifest.build ?? activeManifest.latestBuild) || 1;
    const isWindows = platform === 'windows-tauri';
    const { win } = this._getEnv();
    const useWebOta = !isWindows && this._canUseAndroidWebOta(activeManifest, win);
    const deliveryMode = isWindows ? 'exe' : useWebOta ? 'web-ota' : 'apk';
    const expectedExt = isWindows ? '.exe' : useWebOta ? '.zip' : '.apk';
    const rawUrl = isWindows
      ? activeManifest.exeDownloadUrl || this.exeDownloadUrl || ''
      : useWebOta
        ? activeManifest.webBundleUrl || this.webBundleUrl || DEFAULT_WEB_BUNDLE_URL
        : activeManifest.apkDownloadUrl || this.apkDownloadUrl || '';
    const rawFilenameMatch = String(rawUrl || '').match(/\/([^/?#]+(?:\.exe|\.apk|\.zip))(?:[?#]|$)/i);
    const expectedAssetFilename = useWebOta
      ? 'web-bundle.zip'
      : rawFilenameMatch?.[1] || (isWindows ? 'Audiobook-Player.exe' : 'Audiobook-Player.apk');

    if (!rawUrl) {
      return { ready: false, url: '', deliveryMode, reason: 'missing-url' };
    }

    if (!isRepoReleaseDownloadUrl(rawUrl) || !remoteVersion || typeof fetchImpl !== 'function') {
      return {
        ready: true,
        url: appendCacheBustParam(rawUrl, remoteVersion || this.currentVersion, remoteBuild),
        deliveryMode,
        source: 'manifest'
      };
    }

    const tagName = `v${remoteVersion}`;
    const tagApiUrl = `${GITHUB_RELEASES_TAG_API_PREFIX}${encodeURIComponent(tagName)}`;
    const versionedDownloadUrl = `${GITHUB_RELEASES_TAG_DOWNLOAD_PREFIX}${encodeURIComponent(tagName)}/${expectedAssetFilename}`;

    try {
      const res = await fetchImpl(tagApiUrl, {
        cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json' }
      });

      if (res && res.ok) {
        const releaseData = await res.json();
        const assets = Array.isArray(releaseData?.assets) ? releaseData.assets : [];
        const matchedAsset = useWebOta
          ? assets.find((a) => String(a?.name || '').toLowerCase() === 'web-bundle.zip') ||
            assets.find((a) => {
              const name = String(a?.name || '').toLowerCase();
              return name.endsWith('.zip') && name.includes('web-bundle');
            })
          : assets.find((a) => String(a?.name || '').toLowerCase() === expectedAssetFilename.toLowerCase()) ||
            assets.find((a) =>
              new RegExp(`^multiplayer.*\\${expectedExt}$`, 'i').test(String(a?.name || ''))
            ) ||
            assets.find((a) =>
              new RegExp(`^audiobook-player.*\\${expectedExt}$`, 'i').test(String(a?.name || ''))
            ) ||
            assets.find((a) =>
              String(a?.name || '')
                .toLowerCase()
                .endsWith(expectedExt)
            );
        if (matchedAsset?.browser_download_url) {
          return {
            ready: true,
            url: appendCacheBustParam(matchedAsset.browser_download_url, remoteVersion, remoteBuild),
            deliveryMode,
            source: 'github-release-api'
          };
        }
        return {
          ready: false,
          url: appendCacheBustParam(versionedDownloadUrl, remoteVersion, remoteBuild),
          deliveryMode,
          reason: 'ci-building'
        };
      }

      if (res && res.status === 404) {
        return {
          ready: false,
          url: appendCacheBustParam(versionedDownloadUrl, remoteVersion, remoteBuild),
          deliveryMode,
          reason: 'ci-building'
        };
      }
    } catch {
      // Fall through to HEAD probe on versioned release URL if GitHub API is unreachable/rate-limited.
    }

    try {
      const headRes = await fetchImpl(versionedDownloadUrl, { method: 'HEAD', cache: 'no-store' });
      if (headRes && (headRes.ok || headRes.status === 302 || headRes.type === 'opaqueredirect')) {
        return {
          ready: true,
          url: appendCacheBustParam(versionedDownloadUrl, remoteVersion, remoteBuild),
          deliveryMode,
          source: 'github-release-head'
        };
      }
      if (headRes && headRes.status === 404) {
        return {
          ready: false,
          url: appendCacheBustParam(versionedDownloadUrl, remoteVersion, remoteBuild),
          deliveryMode,
          reason: 'ci-building'
        };
      }
    } catch {
      // Cross-origin redirect HEAD can fail in WebView; fall back to versioned tag URL directly.
    }

    return {
      ready: true,
      url: appendCacheBustParam(versionedDownloadUrl, remoteVersion, remoteBuild),
      deliveryMode,
      source: 'github-release-fallback'
    };
  }

  /**
   * Pause any active <audio> elements and app AudioEngine before applying a blocking update.
   */
  pauseAllAudio() {
    const { win, doc } = this._getEnv();
    try {
      const audios = doc?.querySelectorAll?.('audio');
      if (audios && typeof audios.forEach === 'function') {
        audios.forEach((audioEl) => {
          try {
            audioEl.pause?.();
          } catch {}
        });
      }
    } catch {}
    try {
      win?.__audiobookApp?.audioEngine?.pause?.();
    } catch {}
    try {
      this._onBeforeUpdate?.();
    } catch {}
  }

  /**
   * Mount (or update) the full-screen blocking update gate directly onto document.body.
   * Prevents user interaction with outdated code until the update completes.
   * @param {Record<string, any>} manifest
   * @param {{ documentObj?: any, onActionClick?: () => void }} [options]
   */
  mountMandatoryUpdateGate(manifest, options = {}) {
    const { doc } = this._getEnv(options);
    if (!doc?.body || typeof doc.createElement !== 'function') {
      return null;
    }

    const remoteVersion = String(manifest?.latestVersion || manifest?.version || this.currentVersion).replace(
      /^v/i,
      ''
    );
    const remoteBuild = Number(manifest?.latestBuild ?? manifest?.build) || 1;

    let overlay = doc.getElementById?.(MANDATORY_GATE_ID) || null;
    if (!overlay) {
      overlay = doc.createElement('div');
      overlay.id = MANDATORY_GATE_ID;
      overlay.setAttribute?.('role', 'alertdialog');
      overlay.setAttribute?.('aria-modal', 'true');
      overlay.setAttribute?.('aria-labelledby', 'mandatory-update-title');
      overlay.style.cssText = [
        'position: fixed',
        'inset: 0',
        'z-index: 2147483647',
        'pointer-events: all',
        'display: flex',
        'align-items: center',
        'justify-content: center',
        'padding: 20px',
        'background: rgba(5, 6, 10, 0.94)',
        'backdrop-filter: blur(16px)',
        '-webkit-backdrop-filter: blur(16px)',
        'color: #f8fafc',
        'font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
      ].join(';');

      const card = doc.createElement('div');
      card.id = 'mandatory-update-card';
      card.style.cssText = [
        'width: 100%',
        'max-width: 440px',
        'background: #0f141e',
        'border: 1px solid rgba(255, 255, 255, 0.14)',
        'border-radius: 20px',
        'padding: 24px',
        'box-shadow: 0 24px 64px rgba(0, 0, 0, 0.65)',
        'display: flex',
        'flex-direction: column',
        'gap: 14px'
      ].join(';');

      const badge = doc.createElement('div');
      badge.style.cssText = [
        'display: inline-flex',
        'align-items: center',
        'gap: 8px',
        'align-self: flex-start',
        'padding: 4px 10px',
        'border-radius: 9999px',
        'background: rgba(30, 215, 96, 0.16)',
        'color: #1ed760',
        'font-size: 12px',
        'font-weight: 700',
        'letter-spacing: 0.02em'
      ].join(';');
      badge.textContent = 'MANDATORY UPDATE';

      const title = doc.createElement('h2');
      title.id = 'mandatory-update-title';
      title.style.cssText = 'margin: 0; font-size: 19px; font-weight: 700; line-height: 1.3; color: #ffffff;';

      const subtitle = doc.createElement('p');
      subtitle.id = 'mandatory-update-subtitle';
      subtitle.style.cssText = 'margin: 0; font-size: 13.5px; line-height: 1.5; color: #cbd5e1;';
      subtitle.textContent =
        'Please wait while MultiPlayer downloads and applies the latest update to keep your library and cloud sync bug-free.';

      const progressWrap = doc.createElement('div');
      progressWrap.id = 'mandatory-update-progress';
      progressWrap.style.cssText = [
        'width: 100%',
        'height: 8px',
        'border-radius: 9999px',
        'background: rgba(255, 255, 255, 0.1)',
        'overflow: hidden'
      ].join(';');

      const progressBar = doc.createElement('div');
      progressBar.id = 'mandatory-update-progress-bar';
      progressBar.style.cssText = [
        'width: 12%',
        'height: 100%',
        'border-radius: 9999px',
        'background: #1ed760',
        'transition: width 220ms ease'
      ].join(';');
      progressWrap.appendChild(progressBar);

      const statusEl = doc.createElement('div');
      statusEl.id = 'mandatory-update-status';
      statusEl.style.cssText = 'font-size: 13px; font-weight: 500; line-height: 1.45; color: #e2e8f0;';
      statusEl.textContent = 'Checking update package...';

      const actionBtn = doc.createElement('button');
      actionBtn.id = 'mandatory-update-action-btn';
      actionBtn.type = 'button';
      actionBtn.style.cssText = [
        'display: none',
        'width: 100%',
        'padding: 12px 16px',
        'border: 0',
        'border-radius: 12px',
        'background: #1ed760',
        'color: #050506',
        'font-size: 14px',
        'font-weight: 700',
        'cursor: pointer'
      ].join(';');

      card.appendChild(badge);
      card.appendChild(title);
      card.appendChild(subtitle);
      card.appendChild(progressWrap);
      card.appendChild(statusEl);
      card.appendChild(actionBtn);
      overlay.appendChild(card);

      try {
        doc.body.style.overflow = 'hidden';
      } catch {}
      doc.body.appendChild(overlay);
    }

    const titleEl = doc.getElementById?.('mandatory-update-title');
    if (titleEl) {
      titleEl.textContent = `Update Required — Preparing v${remoteVersion} (Build ${remoteBuild})`;
    }

    const statusEl = doc.getElementById?.('mandatory-update-status');
    const progressBarEl = doc.getElementById?.('mandatory-update-progress-bar');
    const actionBtnEl = doc.getElementById?.('mandatory-update-action-btn');

    const updateStatus = (text, progressPct = null, isError = false) => {
      if (statusEl) {
        statusEl.textContent = String(text || '');
        if (statusEl.style) {
          statusEl.style.color = isError ? '#fca5a5' : '#e2e8f0';
        }
      }
      if (progressBarEl && progressBarEl.style && progressPct !== null && progressPct !== undefined) {
        const clamped = Math.max(4, Math.min(100, Math.round(Number(progressPct) || 0)));
        progressBarEl.style.width = `${clamped}%`;
        progressBarEl.style.background = isError ? '#f87171' : '#1ed760';
      }
    };

    const setActionButton = ({ visible = false, label = 'Retry Update', disabled = false, onClick = null } = {}) => {
      if (!actionBtnEl) return;
      actionBtnEl.textContent = label;
      actionBtnEl.disabled = Boolean(disabled);
      if (actionBtnEl.style) {
        actionBtnEl.style.display = visible ? 'block' : 'none';
        actionBtnEl.style.opacity = disabled ? '0.6' : '1';
      }
      if (typeof onClick === 'function') {
        actionBtnEl.onclick = onClick;
      }
    };

    if (typeof options.onActionClick === 'function' && actionBtnEl) {
      actionBtnEl.onclick = options.onActionClick;
    }

    this._gateController = { overlay, updateStatus, setActionButton };
    return this._gateController;
  }

  /**
   * Enforce a mandatory blocking pre-update flow across Windows Tauri, Android APK, and Web PWA.
   * @param {Record<string, any>} updateInfo
   * @param {Object} [options]
   */
  async enforceMandatoryUpdate(updateInfo, options = {}) {
    if (!updateInfo) return { enforced: false, reason: 'no-update-info' };

    const env = this._getEnv(options);
    const { win, doc, nav, sessionStore, cachesApi, fetchFn } = env;
    const platform = options.platform || this.detectPlatform(win, nav);
    const remoteVersion = String(updateInfo.latestVersion || updateInfo.version || this.currentVersion).replace(
      /^v/i,
      ''
    );
    const remoteBuild = Number(updateInfo.latestBuild ?? updateInfo.build) || 1;
    const gateKey = `${platform}:${remoteVersion}:${remoteBuild}`;

    // Web/PWA reload loop prevention: if we already cleared caches & reloaded for this exact build, do not block/loop.
    if (platform === 'web') {
      const updatedBuild = sessionStore?.getItem?.(SESSION_UPDATED_BUILD_KEY);
      if (updatedBuild && String(updatedBuild) === String(remoteBuild)) {
        return { enforced: false, reason: 'already-updated-session', platform };
      }
    }

    if (sharedGateState.inFlight && sharedGateState.key === gateKey) {
      return sharedGateState.inFlight;
    }

    const runPromise = (async () => {
      this.pauseAllAudio();
      const gate = this.mountMandatoryUpdateGate(
        {
          latestVersion: remoteVersion,
          latestBuild: remoteBuild,
          ...updateInfo
        },
        options
      );

      const clearPollTimer = () => {
        if (this._pollTimer) {
          clearTimeout(this._pollTimer);
          this._pollTimer = null;
        }
      };

      const manifestBase = {
        ...(this.lastManifest || {}),
        ...updateInfo,
        version: remoteVersion,
        build: remoteBuild
      };

      if (platform === 'web') {
        gate?.updateStatus('Clearing cached app files and applying update...', 35);
        gate?.setActionButton({ visible: false });

        try {
          if (cachesApi && typeof cachesApi.keys === 'function') {
            const keys = await cachesApi.keys();
            await Promise.all(keys.map((k) => cachesApi.delete(k)));
          }
        } catch {}

        try {
          if (nav?.serviceWorker && typeof nav.serviceWorker.getRegistrations === 'function') {
            const regs = await nav.serviceWorker.getRegistrations();
            await Promise.all(regs.map((r) => r.unregister?.()));
          }
        } catch {}

        try {
          sessionStore?.setItem?.(SESSION_UPDATED_BUILD_KEY, String(remoteBuild));
        } catch {}

        gate?.updateStatus(`Launching v${remoteVersion}...`, 100);
        const currentHref = win?.location?.href || this.otaBundleUrl || './';
        const nextUrl = appendCacheBustParam(currentHref, remoteVersion, remoteBuild);
        if (typeof options.navigate === 'function') {
          options.navigate(nextUrl);
        } else if (typeof win?.location?.replace === 'function') {
          win.location.replace(nextUrl);
        } else if (win?.location) {
          win.location.href = nextUrl;
        }
        return { enforced: true, platform: 'web', redirectedUrl: nextUrl };
      }

      if (platform === 'windows-tauri') {
        const runWindowsUpdate = async () => {
          clearPollTimer();
          gate?.updateStatus('Checking update package...', 10);
          gate?.setActionButton({ visible: false });

          const pkg = await this.resolveReadyPackageUrl('windows-tauri', manifestBase, fetchFn);
          if (!pkg.ready) {
            gate?.updateStatus(
              'Server is finalizing the Windows installer package... Auto-downloading as soon as ready',
              15
            );
            gate?.setActionButton({
              visible: true,
              label: 'Retry Update',
              disabled: false,
              onClick: () => {
                void runWindowsUpdate();
              }
            });
            if (options.enablePolling !== false) {
              this._pollTimer = setTimeout(() => {
                void runWindowsUpdate();
              }, this._pollIntervalMs);
              this._pollTimer?.unref?.();
            }
            return { enforced: true, platform: 'windows-tauri', waitingForCi: true };
          }

          const readyManifest = { ...manifestBase, exeDownloadUrl: pkg.url };
          const res = await this.installNativeUpdate('windows-tauri', readyManifest, {
            windowObj: win,
            navigatorObj: nav,
            onProgress: (evt = {}) => {
              const pct = Number.isFinite(Number(evt.progress)) ? Number(evt.progress) : null;
              if (evt.status === 'error') {
                gate?.updateStatus(evt.message || 'Windows update failed.', 100, true);
                gate?.setActionButton({
                  visible: true,
                  label: 'Retry Update',
                  disabled: false,
                  onClick: () => {
                    void runWindowsUpdate();
                  }
                });
                return;
              }
              gate?.updateStatus(
                evt.message ||
                  (evt.status === 'restarting'
                    ? 'Launching installer / restarting...'
                    : 'Downloading update...'),
                pct ?? (evt.status === 'restarting' ? 100 : 45)
              );
            }
          });

          if (!res?.ok) {
            gate?.updateStatus(res?.error || 'Windows update failed. Please retry.', 100, true);
            gate?.setActionButton({
              visible: true,
              label: 'Retry Update',
              disabled: false,
              onClick: () => {
                void runWindowsUpdate();
              }
            });
          }
          return { enforced: true, platform: 'windows-tauri', result: res };
        };

        return await runWindowsUpdate();
      }

      // platform === 'android-apk'
      let autoRetriedAfterPermission = false;
      let latestDeliveryMode = this._canUseAndroidWebOta(manifestBase, win) ? 'web-ota' : 'apk';
      let latestPackageUrl = appendCacheBustParam(
        latestDeliveryMode === 'web-ota'
          ? manifestBase.webBundleUrl || this.webBundleUrl
          : manifestBase.apkDownloadUrl || this.apkDownloadUrl,
        remoteVersion,
        remoteBuild
      );
      let permissionCleanup = null;

      const cleanupPermissionListener = () => {
        if (typeof permissionCleanup === 'function') {
          permissionCleanup();
          permissionCleanup = null;
        }
      };

      const triggerAndroidInstall = async (packageUrl, deliveryMode = latestDeliveryMode) => {
        const isWebOta = deliveryMode === 'web-ota';
        gate?.updateStatus(
          isWebOta ? 'Downloading fast in-app update...' : 'Downloading Android APK update...',
          25
        );
        gate?.setActionButton({
          visible: !isWebOta,
          label: isWebOta ? 'Retry Update' : 'Install Update Now',
          disabled: true,
          onClick: () => {
            void triggerAndroidInstall(latestPackageUrl, latestDeliveryMode);
          }
        });

        const readyManifest = isWebOta
          ? { ...manifestBase, webBundleUrl: packageUrl, deliveryMode: 'web-ota' }
          : { ...manifestBase, apkDownloadUrl: packageUrl, deliveryMode: 'apk' };

        const res = await this.installNativeUpdate('android-apk', readyManifest, {
          windowObj: win,
          navigatorObj: nav,
          deliveryMode,
          openUrl: options.openUrl,
          onProgress: (evt = {}) => {
            const status = evt.status || '';
            const pct = Number.isFinite(Number(evt.progress)) ? Number(evt.progress) : null;
            if (isWebOta) {
              if (status === 'downloading') {
                gate?.updateStatus(
                  evt.message ||
                    (pct !== null
                      ? `Downloading fast in-app update... ${pct}%`
                      : 'Downloading fast in-app update...'),
                  pct ?? 35
                );
                gate?.setActionButton({ visible: false });
              } else if (status === 'reloading' || status === 'installing') {
                cleanupPermissionListener();
                gate?.updateStatus(evt.message || 'Applying update and reloading...', 100);
                gate?.setActionButton({ visible: false });
              } else if (status === 'error') {
                gate?.updateStatus(
                  evt.message || 'In-app update failed. Tap below to retry.',
                  100,
                  true
                );
                gate?.setActionButton({
                  visible: true,
                  label: 'Retry Update',
                  disabled: false,
                  onClick: () => {
                    void triggerAndroidInstall(latestPackageUrl, 'web-ota');
                  }
                });
              }
              return;
            }

            if (status === 'downloading') {
              gate?.updateStatus(
                evt.message || (pct !== null ? `Downloading update... ${pct}%` : 'Downloading update...'),
                pct ?? 35
              );
              gate?.setActionButton({
                visible: true,
                label: 'Install Update Now',
                disabled: true,
                onClick: () => {
                  void triggerAndroidInstall(latestPackageUrl, 'apk');
                }
              });
            } else if (status === 'installing') {
              cleanupPermissionListener();
              gate?.updateStatus(
                "Android installer ready — tap 'Update' when prompted by Android, or tap 'Install Update Now' below. If Android reports a package conflict, uninstall the older APK first and reinstall from GitHub Releases.",
                100
              );
              gate?.setActionButton({
                visible: true,
                label: 'Install Update Now',
                disabled: false,
                onClick: () => {
                  void triggerAndroidInstall(latestPackageUrl, 'apk');
                }
              });
            } else if (status === 'permission_required') {
              gate?.updateStatus(
                evt.message ||
                  "Allow 'Install unknown apps' for MultiPlayer, then return here or tap 'Install Update Now' below.",
                50,
                true
              );
              gate?.setActionButton({
                visible: true,
                label: 'Install Update Now',
                disabled: false,
                onClick: () => {
                  void triggerAndroidInstall(latestPackageUrl, 'apk');
                }
              });
              if (!autoRetriedAfterPermission && typeof win?.addEventListener === 'function') {
                cleanupPermissionListener();
                const onReturnFromSettings = () => {
                  if (doc?.hidden || doc?.visibilityState === 'hidden') return;
                  autoRetriedAfterPermission = true;
                  cleanupPermissionListener();
                  void triggerAndroidInstall(latestPackageUrl, 'apk');
                };
                win.addEventListener('focus', onReturnFromSettings);
                doc?.addEventListener?.('visibilitychange', onReturnFromSettings);
                permissionCleanup = () => {
                  win.removeEventListener('focus', onReturnFromSettings);
                  doc?.removeEventListener?.('visibilitychange', onReturnFromSettings);
                };
              }
            } else if (status === 'error') {
              gate?.updateStatus(evt.message || 'Android update failed. Tap below to retry.', 100, true);
              gate?.setActionButton({
                visible: true,
                label: 'Install Update Now',
                disabled: false,
                onClick: () => {
                  void triggerAndroidInstall(latestPackageUrl, 'apk');
                }
              });
            }
          }
        });

        if (res?.fallback) {
          gate?.updateStatus(
            "Opening APK download — install the downloaded package, or tap 'Install Update Now' below.",
            85
          );
          gate?.setActionButton({
            visible: true,
            label: 'Install Update Now',
            disabled: false,
            onClick: () => {
              void triggerAndroidInstall(latestPackageUrl, latestDeliveryMode);
            }
          });
        } else if (!res?.ok) {
          gate?.updateStatus(
            res?.error ||
              (isWebOta ? 'Unable to start fast in-app update.' : 'Unable to start Android APK update.'),
            100,
            true
          );
          gate?.setActionButton({
            visible: true,
            label: isWebOta ? 'Retry Update' : 'Install Update Now',
            disabled: false,
            onClick: () => {
              void triggerAndroidInstall(latestPackageUrl, latestDeliveryMode);
            }
          });
        }

        return res;
      };

      const checkAndInstallAndroid = async () => {
        clearPollTimer();
        gate?.updateStatus('Checking update package...', 10);

        const pkg = await this.resolveReadyPackageUrl('android-apk', manifestBase, fetchFn);
        if (pkg.deliveryMode) {
          latestDeliveryMode = pkg.deliveryMode;
        }
        if (pkg.url) {
          latestPackageUrl = pkg.url;
        }

        if (!pkg.ready) {
          const isWebOta = latestDeliveryMode === 'web-ota';
          gate?.updateStatus(
            isWebOta
              ? 'Server is finalizing the fast in-app update package... Auto-downloading as soon as ready'
              : 'Server is finalizing the Android APK package... Auto-downloading as soon as ready',
            15
          );
          gate?.setActionButton({
            visible: true,
            label: isWebOta ? 'Update Now' : 'Install Update Now',
            disabled: false,
            onClick: () => {
              clearPollTimer();
              void triggerAndroidInstall(latestPackageUrl, latestDeliveryMode);
            }
          });
          if (options.enablePolling !== false) {
            this._pollTimer = setTimeout(() => {
              void checkAndInstallAndroid();
            }, this._pollIntervalMs);
            this._pollTimer?.unref?.();
          }
          return {
            enforced: true,
            platform: 'android-apk',
            deliveryMode: latestDeliveryMode,
            waitingForCi: true,
            apkUrl: latestPackageUrl,
            packageUrl: latestPackageUrl
          };
        }

        const installResult = await triggerAndroidInstall(latestPackageUrl, latestDeliveryMode);
        return {
          enforced: true,
          platform: 'android-apk',
          deliveryMode: latestDeliveryMode,
          apkUrl: latestPackageUrl,
          packageUrl: latestPackageUrl,
          result: installResult
        };
      };

      return await checkAndInstallAndroid();
    })();

    sharedGateState = { key: gateKey, inFlight: runPromise };
    try {
      return await runPromise;
    } finally {
      if (sharedGateState.inFlight === runPromise) {
        sharedGateState = { key: '', inFlight: null };
      }
    }
  }

  /**
   * Start immediate, resume (visibilitychange/focus/online), and periodic update monitoring.
   * Automatically mounts the blocking update gate whenever an update is detected.
   * @param {Object} [options]
   */
  startAutoUpdateMonitor(options = {}) {
    if (this._monitorCleanup) {
      return this._monitorCleanup;
    }

    const { win, doc, fetchFn } = this._getEnv(options);
    let lastCheckedAt = 0;
    let checkInFlight = null;

    const runCheck = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastCheckedAt < FOCUS_RECHECK_COOLDOWN_MS) {
        return null;
      }
      if (checkInFlight) return checkInFlight;

      lastCheckedAt = now;
      checkInFlight = (async () => {
        try {
          const result = await this.checkForUpdate(fetchFn);
          if (result?.updateAvailable) {
            await this.enforceMandatoryUpdate(result, options);
          }
          return result;
        } catch {
          return null;
        } finally {
          checkInFlight = null;
        }
      })();
      return checkInFlight;
    };

    const onVisibilityChange = () => {
      if (!doc || doc.hidden || doc.visibilityState === 'hidden') return;
      void runCheck(true);
    };
    const onFocus = () => {
      void runCheck(false);
    };
    const onOnline = () => {
      void runCheck(true);
    };

    doc?.addEventListener?.('visibilitychange', onVisibilityChange);
    win?.addEventListener?.('focus', onFocus);
    win?.addEventListener?.('online', onOnline);

    const intervalId =
      typeof setInterval === 'function'
        ? setInterval(() => {
            void runCheck(true);
          }, this._checkIntervalMs)
        : null;
    intervalId?.unref?.();

    const cleanup = () => {
      doc?.removeEventListener?.('visibilitychange', onVisibilityChange);
      win?.removeEventListener?.('focus', onFocus);
      win?.removeEventListener?.('online', onOnline);
      if (intervalId) clearInterval(intervalId);
      if (this._pollTimer) {
        clearTimeout(this._pollTimer);
        this._pollTimer = null;
      }
      if (this._monitorCleanup === cleanup) {
        this._monitorCleanup = null;
      }
    };

    this._monitorCleanup = cleanup;

    if (options.immediate !== false) {
      void runCheck(true);
    }

    return cleanup;
  }

  stopAutoUpdateMonitor() {
    if (typeof this._monitorCleanup === 'function') {
      this._monitorCleanup();
    }
  }

  destroy() {
    this.stopAutoUpdateMonitor();
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Trigger Service Worker update + SKIP_WAITING and reload cleanly when ready.
   * @param {{ serviceWorker?: ServiceWorkerContainer, reload?: () => void }} [env]
   */
  async applyOtaUpdate(env = {}) {
    const swContainer =
      env.serviceWorker ??
      (typeof globalThis.navigator !== 'undefined' ? globalThis.navigator.serviceWorker : null);
    const reloadFn =
      env.reload ??
      (typeof globalThis.location !== 'undefined' && typeof globalThis.location.reload === 'function'
        ? () => globalThis.location.reload()
        : null);

    if (!swContainer || typeof swContainer.getRegistration !== 'function') {
      return { applied: false, reason: 'service-worker-unavailable' };
    }

    try {
      const registration = await swContainer.getRegistration();
      if (!registration) {
        return { applied: false, reason: 'no-registration' };
      }

      if (typeof registration.update === 'function') {
        await registration.update();
      }

      const targetWorker = registration.waiting || registration.installing || registration.active;
      if (targetWorker && typeof targetWorker.postMessage === 'function') {
        targetWorker.postMessage({ type: 'SKIP_WAITING' });
      }

      if (reloadFn) {
        reloadFn();
      }

      return { applied: true };
    } catch (error) {
      return {
        applied: false,
        reason: error instanceof Error ? error.message : 'ota-update-failed'
      };
    }
  }

  /**
   * Resolve and optionally trigger a direct .apk / .exe installer download outside Play Store.
   * @param {'android' | 'windows' | string} [platform='android']
   * @param {Record<string, any> | null} [manifest=this.lastManifest]
   * @param {(url: string) => void} [openUrl]
   */
  downloadNativeUpdate(platform = 'android', manifest = this.lastManifest, openUrl = null) {
    const normalizedPlatform = String(platform || 'android').toLowerCase();
    const isWindows = normalizedPlatform.startsWith('win') || normalizedPlatform === 'exe';
    const targetPlatform = isWindows ? 'windows' : 'android';

    const url = isWindows
      ? manifest
        ? manifest.exeDownloadUrl || manifest.otaBundleUrl || ''
        : this.exeDownloadUrl || this.otaBundleUrl || ''
      : manifest
        ? manifest.apkDownloadUrl || manifest.otaBundleUrl || ''
        : this.apkDownloadUrl || this.otaBundleUrl || '';

    if (!url) {
      return {
        triggered: false,
        platform: targetPlatform,
        url: ''
      };
    }

    if (typeof openUrl === 'function') {
      openUrl(url);
      return { triggered: true, platform: targetPlatform, url };
    }

    if (typeof globalThis.document !== 'undefined' && globalThis.document?.createElement) {
      const link = globalThis.document.createElement('a');
      link.href = url;
      link.rel = 'noopener noreferrer';
      link.download = '';
      globalThis.document.body?.appendChild?.(link);
      link.click?.();
      link.remove?.();
      return { triggered: true, platform: targetPlatform, url };
    }

    if (typeof globalThis.open === 'function') {
      globalThis.open(url, '_blank', 'noopener,noreferrer');
      return { triggered: true, platform: targetPlatform, url };
    }

    return { triggered: false, platform: targetPlatform, url };
  }

  /**
   * Detect the current runtime platform ('windows-tauri' | 'android-apk' | 'web').
   * @param {any} [win]
   * @param {any} [nav]
   * @returns {'windows-tauri' | 'android-apk' | 'web'}
   */
  detectPlatform(
    win = typeof globalThis.window !== 'undefined' ? globalThis.window : null,
    nav = typeof globalThis.navigator !== 'undefined' ? globalThis.navigator : null
  ) {
    return detectPlatform(win, nav);
  }

  /**
   * Install an available update natively on Windows Tauri, Android Capacitor APK, or Web PWA.
   * @param {'windows-tauri' | 'android-apk' | 'web' | string} [platform]
   * @param {Record<string, any> | null} [manifest=this.lastManifest]
   * @param {{ onProgress?: (progress: any) => void, windowObj?: any, navigatorObj?: any, env?: any }} [callbacks={}]
   */
  async installNativeUpdate(platform, manifest = this.lastManifest, callbacks = {}) {
    const win =
      callbacks.windowObj !== undefined
        ? callbacks.windowObj
        : this._windowObj !== undefined
          ? this._windowObj
          : typeof globalThis.window !== 'undefined'
            ? globalThis.window
            : null;
    const nav =
      callbacks.navigatorObj !== undefined
        ? callbacks.navigatorObj
        : this._navigatorObj !== undefined
          ? this._navigatorObj
          : typeof globalThis.navigator !== 'undefined'
            ? globalThis.navigator
            : null;
    const targetPlatform = platform || this.detectPlatform(win, nav);
    const activeManifest = manifest || this.lastManifest || {};

    if (targetPlatform === 'windows-tauri') {
      const url = activeManifest.exeDownloadUrl || this.exeDownloadUrl || '';
      const tauriInvoke = win?.__TAURI_INTERNALS__?.invoke || win?.__TAURI__?.core?.invoke;
      if (typeof tauriInvoke !== 'function') {
        return {
          ok: false,
          started: false,
          platform: 'windows-tauri',
          url,
          error: 'Tauri desktop updater is unavailable.'
        };
      }
      if (!url) {
        return {
          ok: false,
          started: false,
          platform: 'windows-tauri',
          url: '',
          error: 'No Windows installer URL available.'
        };
      }
      try {
        callbacks.onProgress?.({
          status: 'downloading',
          progress: 0,
          message: 'Downloading Windows update...'
        });
        const result = await tauriInvoke('desktop_install_update', { url });
        callbacks.onProgress?.({
          status: 'restarting',
          progress: 100,
          message: 'Installing update and restarting...'
        });
        return {
          ok: true,
          started: true,
          platform: 'windows-tauri',
          url,
          result
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || 'Windows update failed.');
        callbacks.onProgress?.({ status: 'error', message });
        return {
          ok: false,
          started: false,
          platform: 'windows-tauri',
          url,
          error: message
        };
      }
    }

    if (targetPlatform === 'android-apk') {
      const useWebOta =
        callbacks.deliveryMode === 'web-ota' ||
        activeManifest.deliveryMode === 'web-ota' ||
        (callbacks.deliveryMode !== 'apk' &&
          activeManifest.deliveryMode !== 'apk' &&
          this._canUseAndroidWebOta(activeManifest, win));

      if (win && typeof callbacks.onProgress === 'function') {
        win.__onAndroidUpdateProgress = (payload) => {
          let parsed = payload;
          if (typeof payload === 'string') {
            try {
              parsed = JSON.parse(payload);
            } catch {
              parsed = { status: 'downloading', message: payload };
            }
          }
          callbacks.onProgress(parsed);
        };
      }

      if (useWebOta && typeof win?.AudiobookUpdaterNative?.startWebOtaUpdate === 'function') {
        const webUrl = activeManifest.webBundleUrl || this.webBundleUrl || DEFAULT_WEB_BUNDLE_URL;
        if (!webUrl) {
          return {
            ok: false,
            started: false,
            platform: 'android-apk',
            deliveryMode: 'web-ota',
            url: '',
            error: 'No Android Web OTA bundle URL available.'
          };
        }
        try {
          win.AudiobookUpdaterNative.startWebOtaUpdate(webUrl);
          return {
            ok: true,
            started: true,
            platform: 'android-apk',
            deliveryMode: 'web-ota',
            url: webUrl
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error || 'Web OTA update failed.');
          callbacks.onProgress?.({ status: 'error', message });
          return {
            ok: false,
            started: false,
            platform: 'android-apk',
            deliveryMode: 'web-ota',
            url: webUrl,
            error: message
          };
        }
      }

      const url = activeManifest.apkDownloadUrl || this.apkDownloadUrl || '';
      if (!url) {
        return {
          ok: false,
          started: false,
          platform: 'android-apk',
          deliveryMode: 'apk',
          url: '',
          error: 'No Android APK URL available.'
        };
      }

      const bridgeInvoke =
        typeof win?.AudiobookUpdaterNative?.startApkUpdate === 'function'
          ? (apkUrl) => win.AudiobookUpdaterNative.startApkUpdate(apkUrl)
          : typeof win?.AudiobookUpdaterNative?.downloadAndInstallApk === 'function'
            ? (apkUrl) => win.AudiobookUpdaterNative.downloadAndInstallApk(apkUrl)
            : typeof win?.AudiobookUpdaterBridge?.downloadAndInstallApk === 'function'
              ? (apkUrl) => win.AudiobookUpdaterBridge.downloadAndInstallApk(apkUrl)
              : typeof win?.AudiobookUpdaterBridge?.startApkUpdate === 'function'
                ? (apkUrl) => win.AudiobookUpdaterBridge.startApkUpdate(apkUrl)
                : null;

      if (bridgeInvoke) {
        try {
          bridgeInvoke(url);
          return {
            ok: true,
            started: true,
            platform: 'android-apk',
            deliveryMode: 'apk',
            url
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error || 'APK update failed.');
          callbacks.onProgress?.({ status: 'error', message });
          return {
            ok: false,
            started: false,
            platform: 'android-apk',
            deliveryMode: 'apk',
            url,
            error: message
          };
        }
      }

      const fallback = this.downloadNativeUpdate('android', activeManifest, callbacks.openUrl || null);
      return {
        ok: fallback.triggered,
        started: fallback.triggered,
        fallback: true,
        platform: 'android-apk',
        deliveryMode: 'apk',
        url: fallback.url
      };
    }

    const otaResult = await this.applyOtaUpdate(callbacks.env || {});
    return {
      ok: Boolean(otaResult?.applied),
      applied: Boolean(otaResult?.applied),
      platform: 'web',
      ...otaResult
    };
  }
}

let sharedBrowserMonitorStarted = false;
if (
  typeof globalThis.window !== 'undefined' &&
  typeof globalThis.document !== 'undefined' &&
  typeof globalThis.document.createElement === 'function' &&
  !globalThis.__AUDIOBOOK_DISABLE_AUTO_UPDATER__ &&
  !sharedBrowserMonitorStarted
) {
  sharedBrowserMonitorStarted = true;
  const autoUpdater = new SelfUpdaterService();
  globalThis.__audiobookSelfUpdater = autoUpdater;
  autoUpdater.startAutoUpdateMonitor({ immediate: true });
}
