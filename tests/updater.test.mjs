import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LOCAL_VERSION, SelfUpdaterService, compareSemver } from '../src/services/self-updater.js';

test('version.json matches LOCAL_VERSION and valid schema', async () => {
  const raw = await readFile(new URL('../version.json', import.meta.url), 'utf8');
  assert.equal(raw.charCodeAt(0) === 0xfeff, false, 'version.json must not have UTF-8 BOM');
  const data = JSON.parse(raw);
  assert.equal(data.version, LOCAL_VERSION);
  assert.equal(data.channel, 'stable');
  assert.equal(typeof data.apkDownloadUrl, 'string');
  assert.equal(typeof data.exeDownloadUrl, 'string');
  assert.equal(typeof data.otaBundleUrl, 'string');
  assert.equal(typeof data.releaseNotes, 'string');
});

test('compareSemver compares versions accurately including v-prefix and numeric segments', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('v1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('1.2.0', '1.10.0'), -1);
  assert.equal(compareSemver('1.10.0', '1.2.0'), 1);
  assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
  assert.equal(compareSemver('1.0.0-beta.1', '1.0.0'), -1);
  assert.equal(compareSemver('1.0.0', '1.0.0-beta.1'), 1);
});

test('checkForUpdate detects newer remote version.json manifest', async () => {
  const service = new SelfUpdaterService({
    currentVersion: '1.0.0',
    remoteVersionUrl: 'https://example.com/version.json',
    storage: null
  });

  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      version: '1.2.0',
      apkDownloadUrl: 'https://example.com/audiobook-1.2.0.apk',
      exeDownloadUrl: 'https://example.com/audiobook-1.2.0.exe',
      releaseNotes: 'Added offline chapters'
    })
  });

  const result = await service.checkForUpdate(mockFetch);
  assert.equal(result.updateAvailable, true);
  assert.equal(result.currentVersion, '1.0.0');
  assert.equal(result.latestVersion, '1.2.0');
  assert.equal(result.apkDownloadUrl, 'https://example.com/audiobook-1.2.0.apk');
  assert.equal(result.exeDownloadUrl, 'https://example.com/audiobook-1.2.0.exe');
  assert.equal(result.releaseNotes, 'Added offline chapters');
});

test('checkForUpdate parses GitHub Releases payload and reports no update when equal', async () => {
  const service = new SelfUpdaterService({
    currentVersion: '1.3.0',
    remoteVersionUrl: 'https://api.github.com/repos/user/audiobook/releases/latest',
    storage: null
  });

  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      tag_name: 'v1.3.0',
      body: 'Current release',
      assets: [
        { name: 'AudiobookPlayer.apk', browser_download_url: 'https://github.com/r/AudiobookPlayer.apk' },
        { name: 'AudiobookPlayer.exe', browser_download_url: 'https://github.com/r/AudiobookPlayer.exe' }
      ]
    })
  });

  const result = await service.checkForUpdate(mockFetch);
  assert.equal(result.updateAvailable, false);
  assert.equal(result.latestVersion, '1.3.0');
  assert.equal(result.apkDownloadUrl, 'https://github.com/r/AudiobookPlayer.apk');
  assert.equal(result.exeDownloadUrl, 'https://github.com/r/AudiobookPlayer.exe');
});

test('checkForUpdate handles offline/network errors gracefully without throwing', async () => {
  const service = new SelfUpdaterService({
    currentVersion: '1.0.0',
    remoteVersionUrl: 'https://example.com/version.json',
    storage: null
  });

  const failingFetch = async () => {
    throw new Error('Network unreachable');
  };

  const result = await service.checkForUpdate(failingFetch);
  assert.equal(result.updateAvailable, false);
  assert.equal(result.currentVersion, '1.0.0');
  assert.equal(result.latestVersion, '1.0.0');
  assert.equal(result.apkDownloadUrl, '');
  assert.equal(result.exeDownloadUrl, '');
});

test('downloadNativeUpdate resolves platform-specific URLs and invokes handler', () => {
  const service = new SelfUpdaterService({ storage: null });
  const manifest = {
    version: '1.2.0',
    apkDownloadUrl: 'https://example.com/app.apk',
    exeDownloadUrl: 'https://example.com/app.exe'
  };

  const opened = [];
  const androidRes = service.downloadNativeUpdate('android', manifest, (url) => opened.push(url));
  assert.deepEqual(androidRes, {
    triggered: true,
    platform: 'android',
    url: 'https://example.com/app.apk'
  });

  const winRes = service.downloadNativeUpdate('windows', manifest, (url) => opened.push(url));
  assert.deepEqual(winRes, {
    triggered: true,
    platform: 'windows',
    url: 'https://example.com/app.exe'
  });

  assert.deepEqual(opened, ['https://example.com/app.apk', 'https://example.com/app.exe']);

  const emptyRes = service.downloadNativeUpdate('android', { apkDownloadUrl: '' });
  assert.deepEqual(emptyRes, { triggered: false, platform: 'android', url: '' });
});

test('applyOtaUpdate posts SKIP_WAITING to service worker and reloads', async () => {
  const service = new SelfUpdaterService({ storage: null });
  const posted = [];
  let updated = false;
  let reloaded = false;

  const res = await service.applyOtaUpdate({
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
  });

  assert.equal(res.applied, true);
  assert.equal(updated, true);
  assert.equal(reloaded, true);
  assert.deepEqual(posted, [{ type: 'SKIP_WAITING' }]);
});
