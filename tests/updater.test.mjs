import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_MANIFEST_URL,
  GITHUB_RELEASES_PAGE_URL,
  LOCAL_BUILD,
  LOCAL_VERSION,
  SelfUpdaterService,
  compareSemver,
  detectPlatform,
  isNewerUpdate
} from '../src/services/self-updater.js';

test('version.json matches LOCAL_VERSION, LOCAL_BUILD, GitHub Releases manifestUrl, and has no webBundleUrl', async () => {
  const raw = await readFile(new URL('../version.json', import.meta.url), 'utf8');
  assert.equal(raw.charCodeAt(0) === 0xfeff, false, 'version.json must not have UTF-8 BOM');
  const data = JSON.parse(raw);
  assert.equal(LOCAL_VERSION, '1.0.23');
  assert.equal(LOCAL_BUILD, 24);
  assert.equal(data.version, LOCAL_VERSION);
  assert.equal(data.build, LOCAL_BUILD);
  assert.equal(data.channel, 'stable');
  assert.equal(data.manifestUrl, 'https://api.github.com/repos/larxe1/Audiobook-Player/releases/latest');
  assert.equal(DEFAULT_MANIFEST_URL, 'https://api.github.com/repos/larxe1/Audiobook-Player/releases/latest');
  assert.equal('webBundleUrl' in data, false, 'version.json must not contain webBundleUrl');
  assert.equal(typeof data.apkDownloadUrl, 'string');
  assert.equal(typeof data.exeDownloadUrl, 'string');
  assert.equal(typeof data.otaBundleUrl, 'string');
  assert.equal(typeof data.releaseNotes, 'string');
});

test('compareSemver and isNewerUpdate compare versions and build numbers accurately', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('v1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('1.2.0', '1.10.0'), -1);
  assert.equal(compareSemver('1.10.0', '1.2.0'), 1);
  assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
  assert.equal(compareSemver('1.0.0-beta.1', '1.0.0'), -1);
  assert.equal(compareSemver('1.0.0', '1.0.0-beta.1'), 1);

  assert.equal(isNewerUpdate('1.0.24', null, '1.0.23', 24), true);
  assert.equal(isNewerUpdate('1.0.23', null, '1.0.23', 24), false);
  assert.equal(isNewerUpdate('1.0.23', 25, '1.0.23', 24), true);
  assert.equal(isNewerUpdate('1.0.23', 24, '1.0.23', 24), false);
  assert.equal(isNewerUpdate('1.0.22', 999, '1.0.23', 24), false);
});

test('detectPlatform distinguishes windows-tauri, android-apk (Capacitor/OAuth/Insets), and web/PWA', () => {
  const service = new SelfUpdaterService({ storage: null });

  assert.equal(
    detectPlatform({ location: { origin: 'https://tauri.localhost' }, __TAURI_INTERNALS__: {} }, { userAgent: 'Windows NT 10.0' }),
    'windows-tauri'
  );
  assert.equal(
    service.detectPlatform(
      { location: { origin: 'https://localhost', protocol: 'https:' }, Capacitor: { isNativePlatform: () => true } },
      { userAgent: 'Mozilla/5.0 (Linux; Android 14)' }
    ),
    'android-apk'
  );
  assert.equal(
    detectPlatform(
      { location: { origin: 'https://localhost', protocol: 'https:' }, AudiobookOAuthNative: {} },
      { userAgent: 'Mozilla/5.0 (Linux; Android 14)' }
    ),
    'android-apk'
  );
  assert.equal(
    detectPlatform(
      { location: { origin: 'https://localhost', protocol: 'https:' }, AudiobookInsetsNative: {} },
      { userAgent: 'Mozilla/5.0 (Linux; Android 14)' }
    ),
    'android-apk'
  );
  assert.equal(
    detectPlatform(
      { location: { origin: 'capacitor://localhost', protocol: 'capacitor:' } },
      { userAgent: 'Mozilla/5.0 (Linux; Android 14)' }
    ),
    'android-apk'
  );
  // Legacy AudiobookUpdaterNative alone is removed and no longer used to identify android-apk
  assert.equal(
    detectPlatform(
      { location: { origin: 'https://larxe1.github.io', protocol: 'https:' }, AudiobookUpdaterNative: {} },
      { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 9) Chrome/130.0.0.0 Mobile Safari/537.36' }
    ),
    'web'
  );
  assert.equal(
    detectPlatform(
      { location: { origin: 'https://larxe1.github.io', protocol: 'https:' } },
      { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 9) Chrome/130.0.0.0 Mobile Safari/537.36' }
    ),
    'web'
  );
});

test('checkForUpdate handles GitHub Releases tag_name (build: null), partial APK-only releases, and offline errors', async () => {
  // 1. Same version v1.0.23 with huge GitHub Release numeric id must NOT trigger false-positive update
  const sameService = new SelfUpdaterService({
    currentVersion: '1.0.23',
    currentBuild: 24,
    remoteVersionUrl: 'https://api.github.com/repos/larxe1/Audiobook-Player/releases/latest',
    storage: null
  });

  const sameResult = await sameService.checkForUpdate(async () => ({
    ok: true,
    json: async () => ({
      id: 987654321,
      tag_name: 'v1.0.23',
      html_url: 'https://github.com/larxe1/Audiobook-Player/releases/tag/v1.0.23',
      body: 'Current release',
      assets: [
        { name: 'Audiobook-Player.apk', browser_download_url: 'https://github.com/r/Audiobook-Player.apk' },
        { name: 'Audiobook-Player.exe', browser_download_url: 'https://github.com/r/Audiobook-Player.exe' }
      ]
    })
  }));

  assert.equal(sameResult.updateAvailable, false);
  assert.equal(sameResult.latestVersion, '1.0.23');
  assert.equal(sameResult.latestBuild, null);
  assert.equal(sameResult.apkDownloadUrl, 'https://github.com/r/Audiobook-Player.apk');
  assert.equal(sameResult.exeDownloadUrl, 'https://github.com/r/Audiobook-Player.exe');

  // 2. Partial release with .apk only leaves exeDownloadUrl as empty string (no synthetic URL)
  const partialResult = await sameService.checkForUpdate(async () => ({
    ok: true,
    json: async () => ({
      id: 999999999,
      tag_name: 'v1.0.24',
      html_url: 'https://github.com/larxe1/Audiobook-Player/releases/tag/v1.0.24',
      body: 'Android ready first',
      assets: [
        { name: 'Audiobook-Player.apk', browser_download_url: 'https://github.com/r/v1.0.24/Audiobook-Player.apk' }
      ]
    })
  }));

  assert.equal(partialResult.updateAvailable, true);
  assert.equal(partialResult.latestVersion, '1.0.24');
  assert.equal(partialResult.latestBuild, null);
  assert.equal(partialResult.apkDownloadUrl, 'https://github.com/r/v1.0.24/Audiobook-Player.apk');
  assert.equal(partialResult.exeDownloadUrl, '');
  assert.equal(partialResult.releasePageUrl, 'https://github.com/larxe1/Audiobook-Player/releases/tag/v1.0.24');

  // 3. Offline / network error returns updateAvailable: false and empty asset URLs
  const offlineResult = await sameService.checkForUpdate(async () => {
    throw new Error('Network unreachable');
  });
  assert.equal(offlineResult.updateAvailable, false);
  assert.equal(offlineResult.currentVersion, '1.0.23');
  assert.equal(offlineResult.latestVersion, '1.0.23');
  assert.equal(offlineResult.apkDownloadUrl, '');
  assert.equal(offlineResult.exeDownloadUrl, '');
  assert.equal(offlineResult.otaBundleUrl, '');
  assert.equal(offlineResult.source, 'offline');
});

test('stageWindowsUpdate, applyStagedWindowsUpdate, stageWebUpdate, applyOtaUpdate, and openAndroidReleasePage work cleanly', async () => {
  const tauriCalls = [];
  const tauriWin = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd, args) => {
        tauriCalls.push({ cmd, args });
        if (cmd === 'desktop_stage_update') {
          return { ok: true, staged: true, version: args.version, path: 'C:\\Temp\\Audiobook-Player-update.exe' };
        }
        return { ok: true, restarting: true };
      }
    }
  };
  const service = new SelfUpdaterService({ windowObj: tauriWin, storage: null });

  const stageMissing = await service.stageWindowsUpdate({ version: '1.0.24', exeDownloadUrl: '' });
  assert.deepEqual(stageMissing, { ok: false, staged: false, reason: 'asset-not-ready' });

  const stageOk = await service.stageWindowsUpdate({
    version: '1.0.24',
    exeDownloadUrl: 'https://github.com/larxe1/Audiobook-Player/releases/download/v1.0.24/Audiobook-Player.exe'
  });
  assert.equal(stageOk.ok, true);
  assert.equal(stageOk.staged, true);
  assert.equal(stageOk.readyToRestart, true);
  assert.equal(stageOk.version, '1.0.24');

  const applyOk = await service.applyStagedWindowsUpdate();
  assert.equal(applyOk.ok, true);
  assert.equal(applyOk.restarting, true);
  assert.equal(applyOk.platform, 'windows-tauri');
  assert.deepEqual(tauriCalls, [
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

  // Web stage vs apply
  const posted = [];
  let updated = false;
  let reloaded = false;
  const swEnv = {
    serviceWorker: {
      async getRegistration() {
        return {
          async update() {
            updated = true;
          },
          waiting: {
            postMessage(msg) {
              posted.push(msg);
            }
          }
        };
      }
    },
    reload() {
      reloaded = true;
    }
  };

  const webStaged = await service.stageWebUpdate(swEnv);
  assert.equal(webStaged.ok, true);
  assert.equal(webStaged.staged, true);
  assert.equal(webStaged.readyToRestart, true);
  assert.equal(updated, true);
  assert.deepEqual(posted, []);
  assert.equal(reloaded, false);

  const webApplied = await service.applyOtaUpdate(swEnv);
  assert.equal(webApplied.applied, true);
  assert.equal(reloaded, true);
  assert.deepEqual(posted, [{ type: 'SKIP_WAITING' }]);

  // Android open release page
  const openedUrls = [];
  const androidRes = service.openAndroidReleasePage(
    { releasePageUrl: 'https://github.com/larxe1/Audiobook-Player/releases/tag/v1.0.24' },
    { openUrl: (url) => openedUrls.push(url) }
  );
  assert.deepEqual(androidRes, {
    ok: true,
    opened: true,
    platform: 'android-apk',
    url: 'https://github.com/larxe1/Audiobook-Player/releases/tag/v1.0.24'
  });
  assert.deepEqual(openedUrls, ['https://github.com/larxe1/Audiobook-Player/releases/tag/v1.0.24']);
});

test('installNativeUpdate routes cleanly across windows-tauri, android-apk, and web', async () => {
  const service = new SelfUpdaterService({ storage: null });
  const manifest = {
    version: '1.0.24',
    exeDownloadUrl: 'https://github.com/larxe1/Audiobook-Player/releases/latest/download/Audiobook-Player.exe',
    apkDownloadUrl: 'https://github.com/larxe1/Audiobook-Player/releases/latest/download/Audiobook-Player.apk',
    releasePageUrl: 'https://github.com/larxe1/Audiobook-Player/releases/tag/v1.0.24'
  };

  // 1. Windows Tauri (stageOnly, applyStagedOnly, and legacy fallback)
  const tauriCalls = [];
  const tauriWin = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd, args) => {
        tauriCalls.push({ cmd, args });
        return { ok: true, staged: true, restarting: cmd !== 'desktop_stage_update' };
      }
    }
  };
  const stagedRes = await service.installNativeUpdate('windows-tauri', manifest, {
    windowObj: tauriWin,
    stageOnly: true
  });
  assert.equal(stagedRes.ok, true);
  assert.equal(stagedRes.staged, true);

  const appliedRes = await service.installNativeUpdate('windows-tauri', manifest, {
    windowObj: tauriWin,
    applyStagedOnly: true
  });
  assert.equal(appliedRes.ok, true);
  assert.equal(appliedRes.restarting, true);

  const directRes = await service.installNativeUpdate('windows-tauri', manifest, {
    windowObj: tauriWin
  });
  assert.equal(directRes.ok, true);
  assert.equal(directRes.platform, 'windows-tauri');
  assert.deepEqual(tauriCalls, [
    { cmd: 'desktop_stage_update', args: { url: manifest.exeDownloadUrl, version: '1.0.24' } },
    { cmd: 'desktop_apply_staged_update', args: {} },
    { cmd: 'desktop_install_update', args: { url: manifest.exeDownloadUrl } }
  ]);

  // 2. Android APK routes to external GitHub Releases page (no native bridge)
  const opened = [];
  const androidRes = await service.installNativeUpdate('android-apk', manifest, {
    openUrl: (u) => opened.push(u)
  });
  assert.equal(androidRes.ok, true);
  assert.equal(androidRes.opened, true);
  assert.equal(androidRes.platform, 'android-apk');
  assert.deepEqual(opened, [manifest.releasePageUrl]);

  const fallbackOpened = [];
  const androidFallbackRes = await service.installNativeUpdate('android-apk', {}, {
    openUrl: (u) => fallbackOpened.push(u)
  });
  assert.equal(androidFallbackRes.url, GITHUB_RELEASES_PAGE_URL);
  assert.deepEqual(fallbackOpened, [GITHUB_RELEASES_PAGE_URL]);

  // 3. Web / Android Chrome PWA
  const posted = [];
  const webRes = await service.installNativeUpdate('web', manifest, {
    env: {
      serviceWorker: {
        async getRegistration() {
          return {
            async update() {},
            waiting: { postMessage: (m) => posted.push(m) }
          };
        }
      },
      reload() {}
    }
  });
  assert.equal(webRes.ok, true);
  assert.equal(webRes.applied, true);
  assert.equal(webRes.platform, 'web');
  assert.deepEqual(posted, [{ type: 'SKIP_WAITING' }]);
});
