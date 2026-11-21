import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_BUILD,
  LOCAL_VERSION,
  SelfUpdaterService,
  appendCacheBustParam,
  isNewerUpdate
} from '../src/services/self-updater.js';

function createMockDom() {
  const elementsById = new Map();

  function makeElement(tagName) {
    const el = {
      tagName: String(tagName).toUpperCase(),
      _id: '',
      get id() {
        return this._id;
      },
      set id(val) {
        this._id = String(val || '');
        if (this._id) elementsById.set(this._id, this);
      },
      children: [],
      attributes: {},
      style: {},
      textContent: '',
      type: '',
      disabled: false,
      onclick: null,
      paused: false,
      pauseCalls: 0,
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      pause() {
        this.paused = true;
        this.pauseCalls += 1;
      }
    };
    return el;
  }

  const audioA = makeElement('audio');
  const audioB = makeElement('audio');
  const body = makeElement('body');
  const docListeners = new Map();

  const documentObj = {
    body,
    hidden: false,
    visibilityState: 'visible',
    createElement(tag) {
      return makeElement(tag);
    },
    getElementById(id) {
      return elementsById.get(id) || null;
    },
    querySelectorAll(selector) {
      if (selector === 'audio') return [audioA, audioB];
      return [];
    },
    addEventListener(evt, fn) {
      if (!docListeners.has(evt)) docListeners.set(evt, new Set());
      docListeners.get(evt).add(fn);
    },
    removeEventListener(evt, fn) {
      docListeners.get(evt)?.delete(fn);
    },
    dispatchEvent(evt) {
      for (const fn of docListeners.get(evt) || []) {
        fn({ type: evt });
      }
    }
  };

  const winListeners = new Map();
  const windowObj = {
    document: documentObj,
    location: {
      origin: 'https://larxe1.github.io',
      protocol: 'https:',
      href: 'https://larxe1.github.io/Audiobook-Player/',
      replacedWith: null,
      replace(url) {
        this.replacedWith = url;
        this.href = url;
      }
    },
    addEventListener(evt, fn) {
      if (!winListeners.has(evt)) winListeners.set(evt, new Set());
      winListeners.get(evt).add(fn);
    },
    removeEventListener(evt, fn) {
      winListeners.get(evt)?.delete(fn);
    },
    dispatchEvent(evt) {
      for (const fn of winListeners.get(evt) || []) {
        fn({ type: evt });
      }
    },
    __audiobookApp: {
      audioEngine: {
        pauseCalls: 0,
        pause() {
          this.pauseCalls += 1;
        }
      }
    }
  };

  return { documentObj, windowObj, elementsById, audioA, audioB, docListeners, winListeners };
}

test('isNewerUpdate and checkForUpdate detect both semver bumps and same-version build bumps', async () => {
  assert.equal(isNewerUpdate('1.0.13', 14, '1.0.12', 13), true);
  assert.equal(isNewerUpdate('1.0.12', 14, '1.0.12', 13), true);
  assert.equal(isNewerUpdate('1.0.12', 13, '1.0.12', 13), false);
  assert.equal(isNewerUpdate('1.0.11', 99, '1.0.12', 13), false);

  const service = new SelfUpdaterService({
    currentVersion: LOCAL_VERSION,
    currentBuild: LOCAL_BUILD,
    remoteVersionUrl: 'https://example.com/version.json',
    storage: null
  });

  const result = await service.checkForUpdate(async () => ({
    ok: true,
    json: async () => ({
      version: LOCAL_VERSION,
      build: LOCAL_BUILD + 1,
      apkDownloadUrl: 'https://example.com/app.apk',
      exeDownloadUrl: 'https://example.com/app.exe'
    })
  }));

  assert.equal(result.updateAvailable, true);
  assert.equal(result.currentBuild, LOCAL_BUILD);
  assert.equal(result.latestBuild, LOCAL_BUILD + 1);
});

test('appendCacheBustParam appends or replaces v=<version>-<build> cleanly', () => {
  assert.equal(
    appendCacheBustParam('https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.13/Audiobook-Player.apk', '1.0.13', 14),
    'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.13/Audiobook-Player.apk?v=1.0.13-14'
  );
  assert.equal(
    appendCacheBustParam('https://larxe1.github.io/Audiobook-Player/?v=1.0.12-13', '1.0.13', 14),
    'https://larxe1.github.io/Audiobook-Player/?v=1.0.13-14'
  );
});

test('resolveReadyPackageUrl detects CI build-in-progress (404) and resolves ready GitHub Release asset URL', async () => {
  const service = new SelfUpdaterService({ storage: null });
  const manifest = {
    version: '1.0.13',
    build: 14,
    apkDownloadUrl: 'https://github.com/larxe1/Audiobook-Player/releases/latest/download/Audiobook-Player.apk'
  };

  const pendingRes = await service.resolveReadyPackageUrl('android-apk', manifest, async (url) => {
    assert.match(url, /\/releases\/tags\/v1\.0\.13$/);
    return { ok: false, status: 404 };
  });
  assert.equal(pendingRes.ready, false);
  assert.equal(pendingRes.reason, 'ci-building');

  const readyRes = await service.resolveReadyPackageUrl('android-apk', manifest, async (url) => {
    assert.match(url, /\/releases\/tags\/v1\.0\.13$/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        assets: [
          {
            name: 'Audiobook-Player.apk',
            browser_download_url: 'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.13/Audiobook-Player.apk'
          }
        ]
      })
    };
  });
  assert.equal(readyRes.ready, true);
  assert.equal(
    readyRes.url,
    'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.13/Audiobook-Player.apk?v=1.0.13-14'
  );
});

test('enforceMandatoryUpdate mounts blocking gate on Windows Tauri, pauses audio, handles error + Retry Update', async () => {
  const { documentObj, windowObj, elementsById, audioA, audioB } = createMockDom();
  let failFirstCall = true;
  const invokeCalls = [];

  windowObj.location.origin = 'https://tauri.localhost';
  windowObj.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      invokeCalls.push({ cmd, args });
      if (failFirstCall) {
        failFirstCall = false;
        throw new Error('Download timeout');
      }
      return { ok: true, restarting: true };
    }
  };

  const service = new SelfUpdaterService({
    currentVersion: '1.0.12',
    currentBuild: 13,
    windowObj,
    documentObj,
    storage: null,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        assets: [
          {
            name: 'Audiobook-Player.exe',
            browser_download_url: 'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.13/Audiobook-Player.exe'
          }
        ]
      })
    })
  });

  const res = await service.enforceMandatoryUpdate({
    latestVersion: '1.0.13',
    latestBuild: 14,
    exeDownloadUrl: 'https://github.com/larxe1/Audiobook-Player/releases/latest/download/Audiobook-Player.exe'
  });

  assert.equal(res.enforced, true);
  assert.equal(res.platform, 'windows-tauri');
  assert.equal(audioA.paused, true);
  assert.equal(audioB.paused, true);
  assert.equal(windowObj.__audiobookApp.audioEngine.pauseCalls, 1);

  const gate = elementsById.get('mandatory-update-gate');
  assert.ok(gate, '#mandatory-update-gate must be mounted on document.body');
  assert.equal(documentObj.body.children.includes(gate), true);
  assert.equal(documentObj.body.style.overflow, 'hidden');
  assert.match(gate.style.cssText, /z-index:\s*2147483647/);
  assert.match(gate.style.cssText, /pointer-events:\s*all/);

  assert.equal(
    elementsById.get('mandatory-update-title').textContent,
    'Update Required — Preparing v1.0.13 (Build 14)'
  );
  assert.match(elementsById.get('mandatory-update-subtitle').textContent, /MultiPlayer/);
  assert.equal(elementsById.get('mandatory-update-status').textContent, 'Download timeout');

  const retryBtn = elementsById.get('mandatory-update-action-btn');
  assert.equal(retryBtn.style.display, 'block');
  assert.equal(retryBtn.textContent, 'Retry Update');

  // Clicking Retry Update should succeed on the second attempt
  await retryBtn.onclick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(invokeCalls.length, 2);
  assert.equal(
    invokeCalls[1].args.url,
    'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.13/Audiobook-Player.exe?v=1.0.13-14'
  );
  assert.match(elementsById.get('mandatory-update-status').textContent, /Installing update and restarting/i);
  service.destroy();
});

test('enforceMandatoryUpdate handles Android APK CI polling, native bridge install, and permission_required recovery', async () => {
  const { documentObj, windowObj, elementsById } = createMockDom();
  const apkCalls = [];
  let releaseReady = false;

  windowObj.location.origin = 'https://localhost';
  windowObj.location.protocol = 'https:';
  windowObj.Capacitor = { isNativePlatform: () => true };
  windowObj.AudiobookUpdaterNative = {
    startApkUpdate(url) {
      apkCalls.push(url);
    }
  };

  const service = new SelfUpdaterService({
    currentVersion: '1.0.12',
    currentBuild: 13,
    windowObj,
    documentObj,
    navigatorObj: { userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
    pollIntervalMs: 25,
    storage: null,
    fetchImpl: async () => {
      if (!releaseReady) {
        return { ok: false, status: 404 };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          assets: [
            {
              name: 'Audiobook-Player.apk',
              browser_download_url: 'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.13/Audiobook-Player.apk'
            }
          ]
        })
      };
    }
  });

  const pending = await service.enforceMandatoryUpdate({
    latestVersion: '1.0.13',
    latestBuild: 14,
    apkDownloadUrl: 'https://github.com/larxe1/Audiobook-Player/releases/latest/download/Audiobook-Player.apk'
  });

  assert.equal(pending.enforced, true);
  assert.equal(pending.platform, 'android-apk');
  assert.equal(pending.waitingForCi, true);
  assert.equal(apkCalls.length, 0);
  assert.match(
    elementsById.get('mandatory-update-status').textContent,
    /Server is finalizing the Android APK package/i
  );

  const installBtn = elementsById.get('mandatory-update-action-btn');
  assert.equal(installBtn.style.display, 'block');
  assert.equal(installBtn.textContent, 'Install Update Now');

  // Flip CI release to ready and let poll interval auto-download
  releaseReady = true;
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(apkCalls.length, 1);
  assert.equal(
    apkCalls[0],
    'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.13/Audiobook-Player.apk?v=1.0.13-14'
  );

  // Simulate permission_required followed by returning to app (focus)
  windowObj.__onAndroidUpdateProgress({
    status: 'permission_required',
    message: 'Allow Install unknown apps for MultiPlayer.'
  });
  assert.match(elementsById.get('mandatory-update-status').textContent, /Allow Install unknown apps/i);
  windowObj.dispatchEvent('focus');
  assert.equal(apkCalls.length, 2);

  // Simulate installer launched
  windowObj.__onAndroidUpdateProgress({ status: 'installing', progress: 100 });
  assert.match(
    elementsById.get('mandatory-update-status').textContent,
    /Android installer ready — tap 'Update' when prompted by Android/i
  );
  assert.equal(installBtn.disabled, false);

  service.destroy();
});

test('enforceMandatoryUpdate clears SW caches on Web PWA and prevents infinite reload loops', async () => {
  const { documentObj, windowObj, elementsById } = createMockDom();
  const deletedCaches = [];
  let unregisteredCount = 0;
  const sessionMap = new Map();
  const sessionStorageObj = {
    getItem: (k) => (sessionMap.has(k) ? sessionMap.get(k) : null),
    setItem: (k, v) => sessionMap.set(k, String(v))
  };

  const service = new SelfUpdaterService({
    currentVersion: '1.0.12',
    currentBuild: 13,
    windowObj,
    documentObj,
    navigatorObj: {
      userAgent: 'Mozilla/5.0 Chrome/130.0',
      serviceWorker: {
        async getRegistrations() {
          return [
            {
              async unregister() {
                unregisteredCount += 1;
                return true;
              }
            }
          ];
        }
      }
    },
    sessionStorageObj,
    cachesObj: {
      async keys() {
        return ['audiobook-player-v2', 'stale-cache'];
      },
      async delete(key) {
        deletedCaches.push(key);
        return true;
      }
    },
    storage: null
  });

  const first = await service.enforceMandatoryUpdate({
    latestVersion: '1.0.13',
    latestBuild: 14
  });

  assert.equal(first.enforced, true);
  assert.equal(first.platform, 'web');
  assert.deepEqual(deletedCaches, ['audiobook-player-v2', 'stale-cache']);
  assert.equal(unregisteredCount, 1);
  assert.equal(sessionMap.get('audiobook_updated_to_build'), '14');
  assert.equal(
    windowObj.location.replacedWith,
    'https://larxe1.github.io/Audiobook-Player/?v=1.0.13-14'
  );
  assert.ok(elementsById.get('mandatory-update-gate'));

  // Second check in same session for build 14 must NOT reload loop
  const second = await service.enforceMandatoryUpdate({
    latestVersion: '1.0.13',
    latestBuild: 14
  });
  assert.equal(second.enforced, false);
  assert.equal(second.reason, 'already-updated-session');
  service.destroy();
});

test('startAutoUpdateMonitor checks on startup and visibilitychange and mounts gate automatically', async () => {
  const { documentObj, windowObj, elementsById } = createMockDom();
  let checkCount = 0;
  let updateAvailable = false;

  const service = new SelfUpdaterService({
    currentVersion: '1.0.12',
    currentBuild: 13,
    remoteVersionUrl: 'https://example.com/version.json',
    windowObj,
    documentObj,
    navigatorObj: { userAgent: 'Mozilla/5.0' },
    sessionStorageObj: { getItem: () => null, setItem: () => {} },
    storage: null,
    checkIntervalMs: 600000,
    fetchImpl: async () => {
      checkCount += 1;
      return {
        ok: true,
        json: async () => ({
          version: updateAvailable ? '1.0.13' : '1.0.12',
          build: updateAvailable ? 14 : 13
        })
      };
    }
  });

  service.startAutoUpdateMonitor({ immediate: true });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(checkCount, 1);
  assert.equal(elementsById.get('mandatory-update-gate'), undefined);

  updateAvailable = true;
  documentObj.visibilityState = 'visible';
  documentObj.hidden = false;
  documentObj.dispatchEvent('visibilitychange');
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(checkCount, 2);
  assert.ok(elementsById.get('mandatory-update-gate'));
  service.destroy();
});

test('resolveReadyPackageUrl selects web-bundle.zip when minNativeBuild <= getNativeBuild() and falls back to APK when minNativeBuild > getNativeBuild()', async () => {
  let nativeBuild = 15;
  const webOtaCalls = [];
  const apkCalls = [];

  const windowObj = {
    location: { origin: 'https://localhost', protocol: 'https:' },
    Capacitor: { isNativePlatform: () => true },
    AudiobookUpdaterNative: {
      getNativeBuild: () => nativeBuild,
      startWebOtaUpdate: (url) => webOtaCalls.push(url),
      startApkUpdate: (url) => apkCalls.push(url)
    }
  };

  const service = new SelfUpdaterService({
    windowObj,
    navigatorObj: { userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
    storage: null
  });

  const releaseFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      assets: [
        {
          name: 'Audiobook-Player.apk',
          browser_download_url: 'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.14/Audiobook-Player.apk'
        },
        {
          name: 'web-bundle.zip',
          browser_download_url: 'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.14/web-bundle.zip'
        }
      ]
    })
  });

  // 1. minNativeBuild <= getNativeBuild() -> selects web-bundle.zip (web-ota)
  const webOtaPkg = await service.resolveReadyPackageUrl(
    'android-apk',
    {
      version: '1.0.14',
      build: 16,
      minNativeBuild: 15,
      webBundleUrl: 'https://github.com/larxe1/Audiobook-Player/releases/latest/download/web-bundle.zip',
      apkDownloadUrl: 'https://github.com/larxe1/Audiobook-Player/releases/latest/download/Audiobook-Player.apk'
    },
    releaseFetch
  );
  assert.equal(webOtaPkg.ready, true);
  assert.equal(webOtaPkg.deliveryMode, 'web-ota');
  assert.equal(
    webOtaPkg.url,
    'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.14/web-bundle.zip?v=1.0.14-16'
  );

  // 2. minNativeBuild > getNativeBuild() -> falls back to Audiobook-Player.apk (apk)
  nativeBuild = 14;
  const apkPkg = await service.resolveReadyPackageUrl(
    'android-apk',
    {
      version: '1.0.14',
      build: 16,
      minNativeBuild: 15,
      webBundleUrl: 'https://github.com/larxe1/Audiobook-Player/releases/latest/download/web-bundle.zip',
      apkDownloadUrl: 'https://github.com/larxe1/Audiobook-Player/releases/latest/download/Audiobook-Player.apk'
    },
    releaseFetch
  );
  assert.equal(apkPkg.ready, true);
  assert.equal(apkPkg.deliveryMode, 'apk');
  assert.equal(
    apkPkg.url,
    'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.14/Audiobook-Player.apk?v=1.0.14-16'
  );
  assert.equal(webOtaCalls.length, 0);
  assert.equal(apkCalls.length, 0);
});

test('enforceMandatoryUpdate executes fast Web OTA update via startWebOtaUpdate without APK installer when native build satisfies minNativeBuild', async () => {
  const { documentObj, windowObj, elementsById } = createMockDom();
  const webOtaCalls = [];
  const apkCalls = [];

  windowObj.location.origin = 'https://localhost';
  windowObj.location.protocol = 'https:';
  windowObj.Capacitor = { isNativePlatform: () => true };
  windowObj.AudiobookUpdaterNative = {
    getNativeBuild: () => 15,
    startWebOtaUpdate: (url) => webOtaCalls.push(url),
    startApkUpdate: (url) => apkCalls.push(url)
  };

  const service = new SelfUpdaterService({
    currentVersion: '1.0.14',
    currentBuild: 15,
    remoteVersionUrl: 'https://example.com/version.json',
    windowObj,
    documentObj,
    navigatorObj: { userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
    storage: null,
    fetchImpl: async (url) => {
      if (url.includes('version.json')) {
        return {
          ok: true,
          json: async () => ({
            version: '1.0.14',
            build: 16,
            minNativeBuild: 15,
            webBundleUrl: 'https://github.com/larxe1/Audiobook-Player/releases/latest/download/web-bundle.zip',
            apkDownloadUrl: 'https://github.com/larxe1/Audiobook-Player/releases/latest/download/Audiobook-Player.apk'
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          assets: [
            {
              name: 'web-bundle.zip',
              browser_download_url: 'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.14/web-bundle.zip'
            },
            {
              name: 'Audiobook-Player.apk',
              browser_download_url: 'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.14/Audiobook-Player.apk'
            }
          ]
        })
      };
    }
  });

  const checkRes = await service.checkForUpdate();
  assert.equal(checkRes.updateAvailable, true);
  assert.equal(checkRes.minNativeBuild, 15);
  assert.equal(
    checkRes.webBundleUrl,
    'https://github.com/larxe1/Audiobook-Player/releases/latest/download/web-bundle.zip'
  );

  const enforced = await service.enforceMandatoryUpdate(checkRes);
  assert.equal(enforced.enforced, true);
  assert.equal(enforced.platform, 'android-apk');
  assert.equal(enforced.deliveryMode, 'web-ota');
  assert.deepEqual(webOtaCalls, [
    'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.14/web-bundle.zip?v=1.0.14-16'
  ]);
  assert.equal(apkCalls.length, 0);
  assert.match(elementsById.get('mandatory-update-status').textContent, /Downloading fast in-app update/i);

  windowObj.__onAndroidUpdateProgress({ status: 'reloading', progress: 100 });
  assert.match(elementsById.get('mandatory-update-status').textContent, /Applying update and reloading/i);
  assert.equal(elementsById.get('mandatory-update-action-btn').style.display, 'none');

  service.destroy();
});

test('resolveReadyPackageUrl matches both MultiPlayer and Audiobook-Player release assets and uses MultiPlayer copy', async () => {
  const { documentObj, windowObj, elementsById } = createMockDom();
  const service = new SelfUpdaterService({ windowObj, documentObj, storage: null });

  const multiPkg = await service.resolveReadyPackageUrl(
    'windows-tauri',
    {
      version: '1.0.19',
      build: 20,
      exeDownloadUrl: 'https://github.com/larxe1/Audiobook-Player/releases/latest/download/MultiPlayer.exe'
    },
    async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        assets: [
          {
            name: 'Audiobook-Player.exe',
            browser_download_url: 'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.19/Audiobook-Player.exe'
          },
          {
            name: 'MultiPlayer.exe',
            browser_download_url: 'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.19/MultiPlayer.exe'
          }
        ]
      })
    })
  );
  assert.equal(multiPkg.ready, true);
  assert.equal(
    multiPkg.url,
    'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.19/MultiPlayer.exe?v=1.0.19-20'
  );

  const legacyPkg = await service.resolveReadyPackageUrl(
    'android-apk',
    {
      version: '1.0.19',
      build: 20,
      apkDownloadUrl: 'https://github.com/larxe1/Audiobook-Player/releases/latest/download/Audiobook-Player.apk'
    },
    async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        assets: [
          {
            name: 'Audiobook-Player.apk',
            browser_download_url: 'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.19/Audiobook-Player.apk'
          }
        ]
      })
    })
  );
  assert.equal(legacyPkg.ready, true);
  assert.equal(
    legacyPkg.url,
    'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.19/Audiobook-Player.apk?v=1.0.19-20'
  );

  service.mountMandatoryUpdateGate({ latestVersion: '1.0.19', latestBuild: 20 });
  assert.match(elementsById.get('mandatory-update-subtitle').textContent, /MultiPlayer/);
  assert.doesNotMatch(elementsById.get('mandatory-update-subtitle').textContent, /Audiobook Player/);
  service.destroy();
});

test('Android Web OTA clears WebView caches & SW registrations and never falls back to mismatched older release tags', async () => {
  const deletedCaches = [];
  let swUpdated = 0;
  let swUnregistered = 0;
  const webOtaCalls = [];

  const windowObj = {
    location: { origin: 'https://localhost', protocol: 'https:' },
    Capacitor: { isNativePlatform: () => true },
    AudiobookUpdaterNative: {
      getNativeBuild: () => 21,
      startWebOtaUpdate: (url) => webOtaCalls.push(url),
      startApkUpdate: () => {}
    }
  };

  const service = new SelfUpdaterService({
    currentVersion: '1.0.20',
    currentBuild: 21,
    windowObj,
    navigatorObj: {
      userAgent: 'Mozilla/5.0 (Linux; Android 14)',
      serviceWorker: {
        async getRegistrations() {
          return [
            {
              async update() {
                swUpdated += 1;
              },
              async unregister() {
                swUnregistered += 1;
                return true;
              }
            }
          ];
        }
      }
    },
    cachesObj: {
      async keys() {
        return ['multiplayer-v3', 'multiplayer-v4'];
      },
      async delete(key) {
        deletedCaches.push(key);
        return true;
      }
    },
    storage: null
  });

  // 1. Mismatched older tag_name while new release v1.0.21 is still building must return ready: false
  const mismatchedRes = await service.resolveReadyPackageUrl(
    'android-apk',
    {
      version: '1.0.21',
      build: 22,
      minNativeBuild: 21,
      webBundleUrl: 'https://github.com/larxe1/Audiobook-Player/releases/latest/download/web-bundle.zip'
    },
    async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v1.0.20',
        assets: [
          {
            name: 'web-bundle.zip',
            browser_download_url: 'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.20/web-bundle.zip'
          }
        ]
      })
    })
  );
  assert.equal(mismatchedRes.ready, false);
  assert.equal(mismatchedRes.reason, 'release-not-published-yet');
  assert.doesNotMatch(mismatchedRes.url, /\/releases\/latest\/download\//);

  // 2. GitHub API 403 + blocked HEAD must return ready: false (not github-release-fallback ready: true)
  const rateLimitedRes = await service.resolveReadyPackageUrl(
    'android-apk',
    {
      version: '1.0.21',
      build: 22,
      minNativeBuild: 21,
      webBundleUrl: 'https://github.com/larxe1/Audiobook-Player/releases/latest/download/web-bundle.zip'
    },
    async (_url, init) => {
      if (init?.method === 'HEAD') {
        throw new TypeError('CORS blocked');
      }
      return { ok: false, status: 403 };
    }
  );
  assert.equal(rateLimitedRes.ready, false);
  assert.equal(rateLimitedRes.reason, 'release-not-published-yet');

  // 3. installNativeUpdate on Android Web OTA clears caches & SW registrations before calling startWebOtaUpdate
  const installRes = await service.installNativeUpdate('android-apk', {
    version: '1.0.21',
    build: 22,
    minNativeBuild: 21,
    webBundleUrl: 'https://github.com/larxe1/Audiobook-Player/releases/latest/download/web-bundle.zip'
  });
  assert.equal(installRes.ok, true);
  assert.equal(installRes.deliveryMode, 'web-ota');
  assert.deepEqual(deletedCaches, ['multiplayer-v3', 'multiplayer-v4']);
  assert.equal(swUpdated, 1);
  assert.equal(swUnregistered, 1);
  assert.deepEqual(webOtaCalls, [
    'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.21/web-bundle.zip'
  ]);
});
