export const LOCAL_VERSION = '1.0.23';
export const LOCAL_BUILD = 24;

export const DEFAULT_MANIFEST_URL =
  'https://api.github.com/repos/larxe1/Audiobook-Player/releases/latest';
export const DEFAULT_APK_DOWNLOAD_URL =
  'https://github.com/larxe1/Audiobook-Player/releases/latest/download/Audiobook-Player.apk';
export const DEFAULT_EXE_DOWNLOAD_URL =
  'https://github.com/larxe1/Audiobook-Player/releases/latest/download/Audiobook-Player.exe';
export const DEFAULT_OTA_BUNDLE_URL = 'https://larxe1.github.io/Audiobook-Player/';
export const GITHUB_RELEASES_PAGE_URL =
  'https://github.com/larxe1/Audiobook-Player/releases/latest';

const STORAGE_UPDATE_URL_KEY = 'audiobook_remote_version_url';

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
    Boolean(win?.AudiobookOAuthNative) ||
    Boolean(win?.AudiobookInsetsNative) ||
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
  if (remoteBuild === null || remoteBuild === undefined) return false;
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

function matchReleaseAsset(assets, ext) {
  const lowerExt = ext.toLowerCase();
  return (
    assets.find((a) => new RegExp(`^multiplayer.*\\${lowerExt}$`, 'i').test(String(a?.name || ''))) ||
    assets.find((a) => new RegExp(`^audiobook-player.*\\${lowerExt}$`, 'i').test(String(a?.name || ''))) ||
    assets.find((a) => String(a?.name || '').toLowerCase().endsWith(lowerExt))
  );
}

/**
 * Normalize either a GitHub Releases API payload or a custom version.json manifest.
 * @param {Record<string, any>} payload
 * @param {{ manifestUrl?: string, apkDownloadUrl?: string, exeDownloadUrl?: string, otaBundleUrl?: string }} [defaults]
 */
function normalizeManifest(payload, defaults = {}) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const defaultManifestUrl = defaults.manifestUrl || DEFAULT_MANIFEST_URL;
  const defaultApkUrl = defaults.apkDownloadUrl || DEFAULT_APK_DOWNLOAD_URL;
  const defaultExeUrl = defaults.exeDownloadUrl || DEFAULT_EXE_DOWNLOAD_URL;
  const defaultOtaUrl = defaults.otaBundleUrl || DEFAULT_OTA_BUNDLE_URL;
  const parsedMinNativeBuild = Number(payload.minNativeBuild);
  const minNativeBuild =
    Number.isFinite(parsedMinNativeBuild) && parsedMinNativeBuild > 0 ? parsedMinNativeBuild : 0;

  if (typeof payload.tag_name === 'string') {
    const assets = Array.isArray(payload.assets) ? payload.assets : [];
    const apkAsset = matchReleaseAsset(assets, '.apk');
    const exeAsset = matchReleaseAsset(assets, '.exe');

    return {
      version: payload.tag_name.replace(/^v/i, ''),
      build: null,
      minNativeBuild,
      channel: payload.prerelease ? 'beta' : 'stable',
      publishedAt: payload.published_at || '',
      manifestUrl: defaultManifestUrl,
      apkDownloadUrl: apkAsset?.browser_download_url || '',
      exeDownloadUrl: exeAsset?.browser_download_url || '',
      otaBundleUrl: defaultOtaUrl,
      releasePageUrl: payload.html_url || GITHUB_RELEASES_PAGE_URL,
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
      otaBundleUrl: payload.otaBundleUrl ?? defaultOtaUrl,
      releasePageUrl: payload.releasePageUrl || GITHUB_RELEASES_PAGE_URL,
      releaseNotes: payload.releaseNotes || ''
    };
  }

  return null;
}

export class SelfUpdaterService {
  /**
   * @param {Object} [options]
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
    this.otaBundleUrl = options.otaBundleUrl || DEFAULT_OTA_BUNDLE_URL;
    this.localVersionUrl = options.localVersionUrl || './version.json';
    this.lastManifest = null;

    this._windowObj = options.windowObj;
    this._documentObj = options.documentObj;
    this._navigatorObj = options.navigatorObj;
    this._cachesObj = options.cachesObj;
    this._fetchImpl = options.fetchImpl;
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

    return { win, doc, nav, cachesApi, fetchFn };
  }

  /**
   * Persist or change the remote manifest / GitHub Releases endpoint URL.
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

  async _fetchManifest(url, fetchImpl) {
    if (!url || typeof fetchImpl !== 'function') return null;
    try {
      const response = await fetchImpl(url, {
        cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json, application/json' }
      });
      if (!response || !response.ok) return null;
      const data = await response.json();
      return normalizeManifest(data, {
        manifestUrl: this.manifestUrl,
        apkDownloadUrl: this.apkDownloadUrl,
        exeDownloadUrl: this.exeDownloadUrl,
        otaBundleUrl: this.otaBundleUrl
      });
    } catch {
      return null;
    }
  }

  /**
   * Resolve the local bundled build number when running inside Tauri or Capacitor APK,
   * or fall back to LOCAL_BUILD when currentVersion matches LOCAL_VERSION.
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

    if (this.currentVersion === LOCAL_VERSION && Number.isFinite(LOCAL_BUILD) && LOCAL_BUILD > 0) {
      return LOCAL_BUILD;
    }

    return null;
  }

  /**
   * Check the remote manifest / GitHub Releases endpoint for an available update.
   * Never returns a false-positive update when offline or when remote fetch fails.
   * @param {typeof fetch} [fetchImpl]
   */
  async checkForUpdate(fetchImpl = this._fetchImpl ?? globalThis.fetch) {
    const resolvedBuild = await this.resolveLocalBuild(fetchImpl);
    const manifest = this.remoteVersionUrl
      ? await this._fetchManifest(this.remoteVersionUrl, fetchImpl)
      : null;

    if (!manifest) {
      return {
        updateAvailable: false,
        currentVersion: this.currentVersion,
        currentBuild: resolvedBuild,
        latestVersion: this.currentVersion,
        latestBuild: resolvedBuild,
        apkDownloadUrl: '',
        exeDownloadUrl: '',
        otaBundleUrl: '',
        releasePageUrl: GITHUB_RELEASES_PAGE_URL,
        releaseNotes: '',
        source: 'offline'
      };
    }

    this.lastManifest = manifest;
    const updateAvailable = isNewerUpdate(
      manifest.version,
      manifest.build,
      this.currentVersion,
      resolvedBuild
    );

    return {
      updateAvailable,
      currentVersion: this.currentVersion,
      currentBuild: resolvedBuild,
      latestVersion: manifest.version,
      latestBuild: manifest.build,
      apkDownloadUrl: manifest.apkDownloadUrl || '',
      exeDownloadUrl: manifest.exeDownloadUrl || '',
      otaBundleUrl: manifest.otaBundleUrl || '',
      releasePageUrl: manifest.releasePageUrl || GITHUB_RELEASES_PAGE_URL,
      releaseNotes: manifest.releaseNotes || '',
      source: 'remote'
    };
  }

  /**
   * Download and validate a Windows update installer in the background without exiting the app.
   * @param {Record<string, any> | null} [manifest]
   * @param {Object} [options]
   */
  async stageWindowsUpdate(manifest = this.lastManifest, options = {}) {
    const activeManifest = manifest ?? this.lastManifest ?? null;
    const exeUrl = activeManifest?.exeDownloadUrl || '';
    if (!exeUrl) {
      return { ok: false, staged: false, reason: 'asset-not-ready' };
    }

    const { win } = this._getEnv(options);
    const tauriInvoke =
      options.invoke || win?.__TAURI_INTERNALS__?.invoke || win?.__TAURI__?.core?.invoke;
    if (typeof tauriInvoke !== 'function') {
      return {
        ok: false,
        staged: false,
        reason: 'tauri-unavailable',
        error: 'Tauri desktop updater is unavailable.'
      };
    }

    const manifestVersion =
      String(activeManifest?.version || activeManifest?.latestVersion || '')
        .trim()
        .replace(/^v/i, '') || null;

    try {
      const res = await tauriInvoke('desktop_stage_update', {
        url: exeUrl,
        version: manifestVersion
      });
      return {
        ok: true,
        staged: true,
        readyToRestart: true,
        version: res?.version || manifestVersion || '',
        path: res?.path || '',
        alreadyStaged: Boolean(res?.alreadyStaged)
      };
    } catch (error) {
      return {
        ok: false,
        staged: false,
        error: error instanceof Error ? error.message : String(error || 'Failed to stage update.')
      };
    }
  }

  /**
   * Apply a previously staged Windows installer and restart the desktop app.
   * @param {Object} [options]
   */
  async applyStagedWindowsUpdate(options = {}) {
    const { win } = this._getEnv(options);
    const tauriInvoke =
      options.invoke || win?.__TAURI_INTERNALS__?.invoke || win?.__TAURI__?.core?.invoke;
    if (typeof tauriInvoke !== 'function') {
      return {
        ok: false,
        restarting: false,
        platform: 'windows-tauri',
        error: 'Tauri desktop updater is unavailable.'
      };
    }

    try {
      const result = await tauriInvoke('desktop_apply_staged_update', {});
      return {
        ok: true,
        restarting: true,
        platform: 'windows-tauri',
        result
      };
    } catch (error) {
      return {
        ok: false,
        restarting: false,
        platform: 'windows-tauri',
        error: error instanceof Error ? error.message : String(error || 'Failed to apply update.')
      };
    }
  }

  /**
   * Trigger a background Service Worker check without calling SKIP_WAITING or reloading the page.
   * @param {{ serviceWorker?: ServiceWorkerContainer }} [env]
   */
  async stageWebUpdate(env = {}) {
    const { nav } = this._getEnv();
    const swContainer = env.serviceWorker ?? nav?.serviceWorker ?? null;
    if (!swContainer || typeof swContainer.getRegistration !== 'function') {
      return {
        ok: true,
        staged: false,
        readyToRestart: true,
        reason: 'service-worker-unavailable',
        platform: 'web'
      };
    }

    try {
      const registration = await swContainer.getRegistration();
      if (!registration) {
        return {
          ok: true,
          staged: false,
          readyToRestart: true,
          reason: 'no-registration',
          platform: 'web'
        };
      }
      if (typeof registration.update === 'function') {
        await registration.update();
      }
      return {
        ok: true,
        staged: true,
        readyToRestart: true,
        platform: 'web'
      };
    } catch (error) {
      return {
        ok: false,
        staged: false,
        readyToRestart: false,
        platform: 'web',
        error: error instanceof Error ? error.message : String(error || 'Web update check failed.')
      };
    }
  }

  /**
   * Trigger Service Worker SKIP_WAITING, clear caches, and reload cleanly.
   * @param {{ serviceWorker?: ServiceWorkerContainer, caches?: CacheStorage, reload?: () => void }} [env]
   */
  async applyOtaUpdate(env = {}) {
    const { nav, cachesApi } = this._getEnv();
    const swContainer = env.serviceWorker ?? nav?.serviceWorker ?? null;
    const cacheStorage = env.caches ?? cachesApi ?? null;
    const reloadFn =
      env.reload ??
      (typeof globalThis.location !== 'undefined' && typeof globalThis.location.reload === 'function'
        ? () => globalThis.location.reload()
        : null);

    try {
      if (cacheStorage && typeof cacheStorage.keys === 'function') {
        const keys = await cacheStorage.keys();
        await Promise.all(keys.map((key) => cacheStorage.delete(key)));
      }
    } catch {}

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
   * Open the GitHub Releases page externally so Obtainium or the browser handles Android APK updates.
   * @param {Record<string, any> | null} [manifest]
   * @param {Object} [options]
   */
  openAndroidReleasePage(manifest = this.lastManifest, options = {}) {
    const url =
      manifest?.releasePageUrl ||
      this.lastManifest?.releasePageUrl ||
      GITHUB_RELEASES_PAGE_URL;
    const { win } = this._getEnv(options);
    let opened = false;

    if (typeof options.openUrl === 'function') {
      options.openUrl(url);
      opened = true;
    } else if (typeof win?.open === 'function') {
      win.open(url, '_blank', 'noopener,noreferrer');
      opened = true;
    } else if (typeof globalThis.open === 'function') {
      globalThis.open(url, '_blank', 'noopener,noreferrer');
      opened = true;
    }

    return {
      ok: opened,
      opened,
      platform: 'android-apk',
      url
    };
  }

  /**
   * Resolve and optionally trigger a direct .apk / .exe installer download.
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
      return { triggered: false, platform: targetPlatform, url: '' };
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
   * Dispatch platform update actions cleanly across Windows Tauri, Android APK, and Web PWA.
   * @param {'windows-tauri' | 'android-apk' | 'web' | string} [platform]
   * @param {Record<string, any> | null} [manifest=this.lastManifest]
   * @param {Object} [callbacks={}]
   */
  async installNativeUpdate(platform, manifest = this.lastManifest, callbacks = {}) {
    const { win, nav } = this._getEnv(callbacks);
    const targetPlatform = platform || this.detectPlatform(win, nav);
    const activeManifest = manifest || this.lastManifest || {};

    if (targetPlatform === 'windows-tauri') {
      if (callbacks.applyStagedOnly) {
        return await this.applyStagedWindowsUpdate(callbacks);
      }
      if (callbacks.stageOnly) {
        return await this.stageWindowsUpdate(activeManifest, callbacks);
      }
      if (callbacks.alreadyStaged) {
        return await this.applyStagedWindowsUpdate(callbacks);
      }

      const url = activeManifest.exeDownloadUrl || this.exeDownloadUrl || '';
      const tauriInvoke =
        callbacks.invoke || win?.__TAURI_INTERNALS__?.invoke || win?.__TAURI__?.core?.invoke;
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
        const message =
          error instanceof Error ? error.message : String(error || 'Windows update failed.');
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
      return this.openAndroidReleasePage(activeManifest, callbacks);
    }

    const otaResult = await this.applyOtaUpdate(callbacks.env || {});
    return {
      ok: Boolean(otaResult?.applied),
      applied: Boolean(otaResult?.applied),
      platform: 'web',
      ...otaResult
    };
  }

  destroy() {
    // No background timers or blocking overlays to clean up.
  }
}
