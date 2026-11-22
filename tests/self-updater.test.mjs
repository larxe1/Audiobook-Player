import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_RELEASES_PAGE_URL,
  LOCAL_BUILD,
  LOCAL_VERSION,
  SelfUpdaterService,
  appendCacheBustParam,
  isNewerUpdate
} from '../src/services/self-updater.js';

function createMockDom() {
  const elementsById = new Map();

  function makeElement(tagName) {
    return {
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
  }

  const audioEl = makeElement('audio');
  const body = makeElement('body');
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
      if (selector === 'audio') return [audioEl];
      return [];
    },
    addEventListener() {},
    removeEventListener() {}
  };

  const openCalls = [];
  const windowObj = {
    document: documentObj,
    location: {
      origin: 'https://larxe1.github.io',
      protocol: 'https:',
      href: 'https://larxe1.github.io/Audiobook-Player/'
    },
    open(url, target, features) {
      openCalls.push({ url, target, features });
      return {};
    },
    addEventListener() {},
    removeEventListener() {}
  };

  return { documentObj, windowObj, elementsById, audioEl, openCalls };
}

test('SelfUpdaterService removes all lockout, mandatory gate, and native APK updater methods', () => {
  const removedMethods = [
    'mountMandatoryUpdateGate',
    'enforceMandatoryUpdate',
    'pauseAllAudio',
    'resolveReadyPackageUrl',
    '_canUseAndroidWebOta',
    'getWebOtaBundleUrl',
    '_resolveWebOtaFallbackPackage',
    'startAutoUpdateMonitor'
  ];

  for (const methodName of removedMethods) {
    assert.equal(
      methodName in SelfUpdaterService.prototype,
      false,
      `SelfUpdaterService.prototype.${methodName} must be removed`
    );
  }
});

test('importing self-updater.js in a browser/DOM env does not auto-start a blocking gate or touch <audio>', async () => {
  const { documentObj, windowObj, elementsById, audioEl } = createMockDom();
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevFetch = globalThis.fetch;

  let fetchCalls = 0;
  globalThis.window = windowObj;
  globalThis.document = documentObj;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('Unexpected auto-fetch on module import');
  };

  try {
    await import(`../src/services/self-updater.js?domcheck=${Date.now()}`);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fetchCalls, 0);
    assert.equal(elementsById.get('mandatory-update-gate'), undefined);
    assert.equal(documentObj.body.children.length, 0);
    assert.equal(audioEl.paused, false);
    assert.equal(audioEl.pauseCalls, 0);
  } finally {
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
    globalThis.fetch = prevFetch;
  }
});

test('isNewerUpdate and appendCacheBustParam handle GitHub Releases null builds and custom builds', () => {
  assert.equal(LOCAL_VERSION, '1.0.23');
  assert.equal(LOCAL_BUILD, 24);
  assert.equal(isNewerUpdate('1.0.24', null, '1.0.23', 24), true);
  assert.equal(isNewerUpdate('1.0.23', null, '1.0.23', 24), false);
  assert.equal(isNewerUpdate('1.0.23', 25, '1.0.23', 24), true);
  assert.equal(
    appendCacheBustParam('https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.24/Audiobook-Player.exe', '1.0.24', 25),
    'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.24/Audiobook-Player.exe?v=1.0.24-25'
  );
});

test('Windows background flow: stageWindowsUpdate and applyStagedWindowsUpdate', async () => {
  const invokeCalls = [];
  const windowObj = {
    location: { origin: 'https://tauri.localhost' },
    __TAURI_INTERNALS__: {
      invoke: async (cmd, args) => {
        invokeCalls.push({ cmd, args });
        if (cmd === 'desktop_stage_update') {
          return {
            ok: true,
            staged: true,
            alreadyStaged: false,
            version: args.version,
            path: 'C:\\Users\\test\\AppData\\Local\\Temp\\Audiobook-Player-update.exe'
          };
        }
        if (cmd === 'desktop_apply_staged_update') {
          return { ok: true, restarting: true };
        }
        throw new Error(`Unexpected command: ${cmd}`);
      }
    }
  };

  const service = new SelfUpdaterService({ windowObj, storage: null });

  // Missing exeDownloadUrl returns asset-not-ready without invoking Tauri
  const missingRes = await service.stageWindowsUpdate({ version: '1.0.24', exeDownloadUrl: '' });
  assert.deepEqual(missingRes, { ok: false, staged: false, reason: 'asset-not-ready' });
  assert.equal(invokeCalls.length, 0);

  // Valid exeDownloadUrl calls desktop_stage_update with { url, version } and returns readyToRestart: true
  const stageRes = await service.stageWindowsUpdate({
    version: 'v1.0.24',
    exeDownloadUrl: 'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.24/Audiobook-Player.exe'
  });
  assert.equal(stageRes.ok, true);
  assert.equal(stageRes.staged, true);
  assert.equal(stageRes.readyToRestart, true);
  assert.equal(stageRes.version, '1.0.24');
  assert.equal(stageRes.alreadyStaged, false);
  assert.match(stageRes.path, /Audiobook-Player-update\.exe$/);

  // applyStagedWindowsUpdate calls desktop_apply_staged_update
  const applyRes = await service.applyStagedWindowsUpdate();
  assert.equal(applyRes.ok, true);
  assert.equal(applyRes.restarting, true);
  assert.equal(applyRes.platform, 'windows-tauri');
  assert.deepEqual(invokeCalls, [
    {
      cmd: 'desktop_stage_update',
      args: {
        url: 'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.24/Audiobook-Player.exe',
        version: '1.0.24'
      }
    },
    {
      cmd: 'desktop_apply_staged_update',
      args: {}
    }
  ]);
});

test('Web background flow: stageWebUpdate checks registration without SKIP_WAITING/reload, applyOtaUpdate skips waiting and reloads', async () => {
  let updateCalls = 0;
  const posted = [];
  let reloadCalls = 0;
  const deletedCaches = [];

  const env = {
    serviceWorker: {
      async getRegistration() {
        return {
          async update() {
            updateCalls += 1;
          },
          waiting: {
            postMessage(msg) {
              posted.push(msg);
            }
          }
        };
      }
    },
    caches: {
      async keys() {
        return ['multiplayer-v4', 'multiplayer-v5'];
      },
      async delete(key) {
        deletedCaches.push(key);
        return true;
      }
    },
    reload() {
      reloadCalls += 1;
    }
  };

  const service = new SelfUpdaterService({ storage: null });

  const stageRes = await service.stageWebUpdate(env);
  assert.equal(stageRes.ok, true);
  assert.equal(stageRes.staged, true);
  assert.equal(stageRes.readyToRestart, true);
  assert.equal(stageRes.platform, 'web');
  assert.equal(updateCalls, 1);
  assert.deepEqual(posted, []);
  assert.equal(reloadCalls, 0);
  assert.deepEqual(deletedCaches, []);

  const applyRes = await service.applyOtaUpdate(env);
  assert.equal(applyRes.applied, true);
  assert.equal(updateCalls, 2);
  assert.deepEqual(posted, [{ type: 'SKIP_WAITING' }]);
  assert.equal(reloadCalls, 1);
  assert.deepEqual(deletedCaches, ['multiplayer-v4', 'multiplayer-v5']);
});

test('Android openAndroidReleasePage opens releasePageUrl or GITHUB_RELEASES_PAGE_URL without calling any native updater bridge', () => {
  const { windowObj, openCalls } = createMockDom();
  let bridgeCalled = false;
  windowObj.Capacitor = { isNativePlatform: () => true };
  windowObj.AudiobookUpdaterNative = {
    startApkUpdate() {
      bridgeCalled = true;
    },
    startWebOtaUpdate() {
      bridgeCalled = true;
    }
  };

  const service = new SelfUpdaterService({ windowObj, storage: null });

  const withManifest = service.openAndroidReleasePage({
    releasePageUrl: 'https://github.com/larxe1/Audiobook-Player/releases/tag/v1.0.24'
  });
  assert.deepEqual(withManifest, {
    ok: true,
    opened: true,
    platform: 'android-apk',
    url: 'https://github.com/larxe1/Audiobook-Player/releases/tag/v1.0.24'
  });

  const fallback = service.openAndroidReleasePage(null);
  assert.deepEqual(fallback, {
    ok: true,
    opened: true,
    platform: 'android-apk',
    url: GITHUB_RELEASES_PAGE_URL
  });

  assert.equal(bridgeCalled, false);
  assert.deepEqual(openCalls, [
    {
      url: 'https://github.com/larxe1/Audiobook-Player/releases/tag/v1.0.24',
      target: '_blank',
      features: 'noopener,noreferrer'
    },
    {
      url: GITHUB_RELEASES_PAGE_URL,
      target: '_blank',
      features: 'noopener,noreferrer'
    }
  ]);
});
