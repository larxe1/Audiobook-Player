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
    message: 'Allow Install unknown apps for Audiobook Player.'
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
