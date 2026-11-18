export const LOCAL_VERSION = '1.0.11';

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
export const DEFAULT_OTA_BUNDLE_URL = 'https://larxe1.github.io/Audiobook-Player/';

const STORAGE_UPDATE_URL_KEY = 'audiobook_remote_version_url';

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
 * Normalize either a direct version.json manifest or a GitHub Releases API payload.
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

  // GitHub Releases API shape
  if (typeof payload.tag_name === 'string') {
    const assets = Array.isArray(payload.assets) ? payload.assets : [];
    const apkAsset = assets.find((a) => String(a?.name || '').toLowerCase().endsWith('.apk'));
    const exeAsset = assets.find((a) => String(a?.name || '').toLowerCase().endsWith('.exe'));
    const otaAsset = assets.find((a) => {
      const name = String(a?.name || '').toLowerCase();
      return name.endsWith('.zip') || name.endsWith('.tar.gz');
    });

    return {
      version: payload.tag_name.replace(/^v/i, ''),
      build: Number(payload.id) || 1,
      channel: payload.prerelease ? 'beta' : 'stable',
      publishedAt: payload.published_at || '',
      manifestUrl: defaultManifestUrl,
      apkDownloadUrl: apkAsset?.browser_download_url || defaultApkUrl,
      exeDownloadUrl: exeAsset?.browser_download_url || defaultExeUrl,
      otaBundleUrl: otaAsset?.browser_download_url || defaultOtaUrl,
      releaseNotes: payload.body || payload.name || ''
    };
  }

  if (typeof payload.version === 'string') {
    return {
      version: payload.version.replace(/^v/i, ''),
      build: Number(payload.build) || 1,
      channel: payload.channel || 'stable',
      publishedAt: payload.publishedAt || '',
      manifestUrl: payload.manifestUrl || defaultManifestUrl,
      apkDownloadUrl: payload.apkDownloadUrl ?? defaultApkUrl,
      exeDownloadUrl: payload.exeDownloadUrl ?? defaultExeUrl,
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
   * @param {string} [options.manifestUrl]
   * @param {string} [options.remoteVersionUrl]
   * @param {string} [options.apkDownloadUrl]
   * @param {string} [options.exeDownloadUrl]
   * @param {string} [options.otaBundleUrl]
   * @param {string} [options.localVersionUrl]
   * @param {Storage} [options.storage]
   */
  constructor(options = {}) {
    this.currentVersion = options.currentVersion || LOCAL_VERSION;
    this.storage = options.storage ?? (typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null);
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
        otaBundleUrl: this.otaBundleUrl
      });
    } catch {
      return null;
    }
  }

  /**
   * Check remote endpoint (or local version.json fallback) for an available update.
   * @param {typeof fetch} [fetchImpl]
   */
  async checkForUpdate(fetchImpl = globalThis.fetch) {
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

    if (!manifest) {
      return {
        updateAvailable: false,
        currentVersion: this.currentVersion,
        latestVersion: this.currentVersion,
        apkDownloadUrl: '',
        exeDownloadUrl: '',
        otaBundleUrl: '',
        releaseNotes: '',
        source: 'offline'
      };
    }

    this.lastManifest = manifest;
    const updateAvailable = compareSemver(manifest.version, this.currentVersion) > 0;

    return {
      updateAvailable,
      currentVersion: this.currentVersion,
      latestVersion: manifest.version,
      apkDownloadUrl: manifest.apkDownloadUrl || '',
      exeDownloadUrl: manifest.exeDownloadUrl || '',
      otaBundleUrl: manifest.otaBundleUrl || '',
      releaseNotes: manifest.releaseNotes || '',
      source
    };
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
        : typeof globalThis.window !== 'undefined'
          ? globalThis.window
          : null;
    const nav =
      callbacks.navigatorObj !== undefined
        ? callbacks.navigatorObj
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
      const url = activeManifest.apkDownloadUrl || this.apkDownloadUrl || '';
      if (!url) {
        return {
          ok: false,
          started: false,
          platform: 'android-apk',
          url: '',
          error: 'No Android APK URL available.'
        };
      }

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

      const updaterNative = win?.AudiobookUpdaterNative;
      if (typeof updaterNative?.startApkUpdate === 'function') {
        try {
          updaterNative.startApkUpdate(url);
          return {
            ok: true,
            started: true,
            platform: 'android-apk',
            url
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error || 'APK update failed.');
          callbacks.onProgress?.({ status: 'error', message });
          return {
            ok: false,
            started: false,
            platform: 'android-apk',
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
