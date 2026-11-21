import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deduplicateLibraryItems,
  diffDriveLibrarySync,
  buildDriveStreamUrl,
} from '../src/services/library-scanner.js';
import { AudioEngine } from '../src/player/audio-engine.js';
import { SupabaseSyncService } from '../src/services/supabase-sync.js';
import { MediaSessionBridge } from '../src/player/media-session-bridge.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

test('deduplicateLibraryItems matches renamed local/Drive books by driveFileId and chapter driveFileId', () => {
  const renamedExisting = {
    bookKey: 'custom-renamed-book::my-tag',
    title: 'Custom Renamed Book',
    author: 'My Tag',
    coverUrl: 'https://example.com/custom-cover.jpg',
    sources: ['drive'],
    driveFileId: 'drv-file-100',
    positionSec: 2400,
    completed: false,
    offlineCached: true,
    bookmarks: [{ id: 'bm-1', positionSec: 1200, label: 'Good part' }],
    chapters: [
      { index: 0, title: 'Part 1', fileName: '01.mp3', driveFileId: 'drv-file-100' },
    ],
  };

  const rescannedDrive = {
    bookKey: 'original-filename::unknown-author',
    title: 'Original Filename',
    author: '',
    coverUrl: 'https://lh3.googleusercontent.com/stale-thumb',
    sources: ['drive'],
    driveFileId: 'drv-file-100',
    positionSec: 0,
    chapters: [
      { index: 0, title: '01', fileName: '01.mp3', driveFileId: 'drv-file-100', driveStreamUrl: buildDriveStreamUrl('drv-file-100') },
      { index: 1, title: '02', fileName: '02.mp3', driveFileId: 'drv-file-101', driveStreamUrl: buildDriveStreamUrl('drv-file-101') },
    ],
  };

  const merged = deduplicateLibraryItems([renamedExisting, rescannedDrive]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].bookKey, 'custom-renamed-book::my-tag');
  assert.equal(merged[0].title, 'Custom Renamed Book');
  assert.equal(merged[0].author, 'My Tag');
  assert.equal(merged[0].coverUrl, 'https://example.com/custom-cover.jpg');
  assert.equal(merged[0].positionSec, 2400);
  assert.equal(merged[0].offlineCached, true);
  assert.equal(merged[0].bookmarks.length, 1);
  assert.equal(merged[0].chapters.length, 2);
  assert.equal(merged[0].chapters[1].driveFileId, 'drv-file-101');
});

test('diffDriveLibrarySync preserves locally edited books, detects addedBooks, and surfaces removedDriveBooks non-destructively', () => {
  const existingBooks = [
    {
      bookKey: 'renamed-hail-mary::weir',
      title: 'Hail Mary (My Edit)',
      author: 'Andy Weir',
      coverUrl: 'https://example.com/custom.jpg',
      sources: ['drive'],
      driveFolderId: 'fld-main',
      driveFileId: 'drv-phm-1',
      positionSec: 4500,
      completed: true,
      offlineCached: true,
      bookmarks: [{ id: 'b1', positionSec: 900, label: 'Ch 2' }],
      chapters: [
        { index: 0, title: 'Track 1', fileName: '01.mp3', driveFileId: 'drv-phm-1', driveStreamUrl: buildDriveStreamUrl('drv-phm-1') },
      ],
    },
    {
      bookKey: 'deleted-from-drive::author',
      title: 'Deleted From Drive',
      author: 'Author',
      sources: ['drive'],
      driveFolderId: 'fld-main',
      driveFileId: 'drv-missing-9',
      chapters: [
        { index: 0, title: 'Ch 1', driveFileId: 'drv-missing-9' },
      ],
    },
    {
      bookKey: 'other-folder-book::author',
      title: 'Other Folder Book',
      author: 'Author',
      sources: ['drive'],
      driveFolderId: 'fld-other',
      driveFileId: 'drv-other-folder-1',
    },
    {
      bookKey: 'local-only::author',
      title: 'Local Only Book',
      author: 'Author',
      sources: ['local'],
      localUrl: 'blob:local/1',
    },
  ];

  const scannedDriveBooks = [
    {
      bookKey: 'project-hail-mary::unknown',
      title: 'Project Hail Mary',
      author: 'Unknown',
      coverUrl: 'https://drive.thumb/ignored.jpg',
      sources: ['drive'],
      driveFileId: 'drv-phm-1',
      chapters: [
        { index: 0, title: 'Track 1', fileName: '01.mp3', driveFileId: 'drv-phm-1', driveStreamUrl: buildDriveStreamUrl('drv-phm-1') },
        { index: 1, title: 'Track 2', fileName: '02.mp3', driveFileId: 'drv-phm-2', driveStreamUrl: buildDriveStreamUrl('drv-phm-2') },
      ],
    },
    {
      bookKey: 'new-arrival::brandon-sanderson',
      title: 'New Arrival',
      author: 'Brandon Sanderson',
      sources: ['drive'],
      driveFileId: 'drv-new-55',
      driveStreamUrl: buildDriveStreamUrl('drv-new-55'),
      chapters: [
        { index: 0, title: 'Ch 1', driveFileId: 'drv-new-55', driveStreamUrl: buildDriveStreamUrl('drv-new-55') },
      ],
    },
  ];

  const diff = diffDriveLibrarySync(existingBooks, scannedDriveBooks, 'fld-main');

  assert.equal(diff.addedBooks.length, 1);
  assert.equal(diff.addedBooks[0].bookKey, 'new-arrival::brandon-sanderson');
  assert.equal(diff.addedBooks[0].driveFolderId, 'fld-main');

  assert.equal(diff.removedDriveBooks.length, 1);
  assert.equal(diff.removedDriveBooks[0].bookKey, 'deleted-from-drive::author');

  assert.equal(diff.mergedNonRemovedBooks.length, 4);
  const keptEdited = diff.mergedNonRemovedBooks.find((b) => b.bookKey === 'renamed-hail-mary::weir');
  assert.ok(keptEdited);
  assert.equal(keptEdited.title, 'Hail Mary (My Edit)');
  assert.equal(keptEdited.coverUrl, 'https://example.com/custom.jpg');
  assert.equal(keptEdited.positionSec, 4500);
  assert.equal(keptEdited.completed, true);
  assert.equal(keptEdited.offlineCached, true);
  assert.equal(keptEdited.bookmarks.length, 1);
  assert.equal(keptEdited.chapters.length, 2);
  assert.equal(keptEdited.chapters[1].driveFileId, 'drv-phm-2');

  assert.ok(diff.mergedNonRemovedBooks.some((b) => b.bookKey === 'other-folder-book::author'));
  assert.ok(diff.mergedNonRemovedBooks.some((b) => b.bookKey === 'local-only::author'));
  assert.ok(diff.mergedNonRemovedBooks.some((b) => b.bookKey === 'new-arrival::brandon-sanderson'));
});

test('AudioEngine emits currentBook immediately on paused switch, aborts stale Drive fetch on rapid switch, and uses direct access_token streaming with blob fallback', async () => {
  const prevWindow = globalThis.window;
  const prevAudio = globalThis.Audio;

  class FakeAudio {
    constructor() {
      this.listeners = new Map();
      this.src = '';
      this.playbackRate = 1;
      this.currentTime = 0;
      this.preload = 'metadata';
    }
    addEventListener(evt, fn) {
      if (!this.listeners.has(evt)) this.listeners.set(evt, []);
      this.listeners.get(evt).push(fn);
    }
    dispatch(evt) {
      for (const fn of this.listeners.get(evt) || []) fn({ type: evt });
    }
    pause() {}
    removeAttribute(attr) {
      if (attr === 'src') this.src = '';
    }
    async play() {
      if (this.src.includes('access_token=')) {
        throw new Error('direct stream blocked');
      }
      this.playCalls = (this.playCalls || 0) + 1;
    }
  }

  try {
    globalThis.Audio = FakeAudio;
    globalThis.window = {};

    // 1. Direct access_token streaming when no custom fetchFn is injected + automatic fallback on audio error
    const fallbackAuths = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      fallbackAuths.push({ url, auth: init?.headers?.Authorization, hasSignal: Boolean(init?.signal) });
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(['fallback-audio'], { type: 'audio/mpeg' }),
      };
    };

    try {
      const states = [];
      const engine = new AudioEngine({
        onStateChange: (snap) => states.push(snap.bookKey),
      });
      assert.equal(engine._hasCustomFetchFn, false);
      engine.setDriveAccessToken('ya29.direct_tok');

      const bookA = {
        bookKey: 'book-a::author',
        title: 'Book A',
        totalDurationSec: 600,
        driveStreamUrl: 'https://www.googleapis.com/drive/v3/files/file-a?alt=media',
        chapters: [{ index: 0, title: 'Ch 1', startSec: 0, driveStreamUrl: 'https://www.googleapis.com/drive/v3/files/file-a?alt=media' }],
      };
      const bookB = {
        bookKey: 'book-b::author',
        title: 'Book B',
        totalDurationSec: 900,
        driveStreamUrl: 'https://www.googleapis.com/drive/v3/files/file-b?alt=media',
        chapters: [{ index: 0, title: 'Ch 1', startSec: 0, driveStreamUrl: 'https://www.googleapis.com/drive/v3/files/file-b?alt=media' }],
      };

      await engine.loadBook(bookA);
      assert.equal(
        engine.audio.src,
        'https://www.googleapis.com/drive/v3/files/file-a?alt=media&access_token=ya29.direct_tok'
      );

      // Simulate <audio> error on direct URL -> triggers single automatic _fetchDriveBlobUrl fallback
      engine.audio.dispatch('error');
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(fallbackAuths.length, 1);
      assert.equal(fallbackAuths[0].auth, 'Bearer ya29.direct_tok');
      assert.equal(fallbackAuths[0].hasSignal, true);
      assert.ok(engine.audio.src.startsWith('blob:'));

      // Switching while paused immediately emits book-b before async resolution
      states.length = 0;
      await engine.loadBook(bookB);
      assert.equal(states[0], 'book-b::author');
      assert.equal(engine.currentBook.bookKey, 'book-b::author');

      // Pressing play() while direct-stream blob fallback is already in flight must NOT trigger synth
      let resolveInFlightFallback = null;
      globalThis.fetch = async () =>
        new Promise((resolve) => {
          resolveInFlightFallback = () =>
            resolve({
              ok: true,
              status: 200,
              blob: async () => new Blob(['delayed-fallback'], { type: 'audio/mpeg' }),
            });
        });
      engine.audio.dispatch('error');
      assert.equal(engine._pendingDirectDriveFallback.inFlight, true);
      await engine.play();
      assert.equal(engine.usingSynth, false, 'must suppress synth while blob fallback is in flight');
      resolveInFlightFallback?.();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(engine.usingSynth, false);
      assert.ok(engine.audio.src.startsWith('blob:'));
      assert.equal(engine.audio.playCalls, 1, 'must resume audio.play() once in-flight fallback resolves');

      engine.destroy();
    } finally {
      globalThis.fetch = origFetch;
    }

    // 2. Rapid switch with custom fetchFn aborts superseded Drive fetch cleanly
    const abortedSignals = [];
    let resolveFirstFetch = null;
    const raceEngine = new AudioEngine({
      fetchFn: (url, init = {}) => {
        if (url.includes('slow-file')) {
          init.signal?.addEventListener('abort', () => abortedSignals.push('slow-aborted'));
          return new Promise((resolve) => {
            resolveFirstFetch = () =>
              resolve({
                ok: true,
                status: 200,
                blob: async () => new Blob(['slow'], { type: 'audio/mpeg' }),
              });
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          blob: async () => new Blob(['fast'], { type: 'audio/mpeg' }),
        });
      },
    });
    assert.equal(raceEngine._hasCustomFetchFn, true);
    raceEngine.setDriveAccessToken('ya29.race_tok');

    const slowBook = {
      bookKey: 'slow-book::a',
      totalDurationSec: 300,
      driveStreamUrl: 'https://www.googleapis.com/drive/v3/files/slow-file?alt=media',
    };
    const fastBook = {
      bookKey: 'fast-book::b',
      totalDurationSec: 300,
      driveStreamUrl: 'https://www.googleapis.com/drive/v3/files/fast-file?alt=media',
    };

    const p1 = raceEngine.loadBook(slowBook);
    // Let p1 advance past offline IDB check into fetchFn so we exercise in-flight AbortSignal cancellation
    await new Promise((r) => setTimeout(r, 5));
    const p2 = raceEngine.loadBook(fastBook);
    assert.deepEqual(abortedSignals, ['slow-aborted']);
    await p2;
    const winningSrc = raceEngine.audio.src;
    assert.ok(winningSrc.startsWith('blob:'));
    assert.equal(raceEngine.activeObjectUrl, winningSrc);
    resolveFirstFetch?.();
    await p1;
    assert.equal(raceEngine.currentBook.bookKey, 'fast-book::b');
    assert.equal(raceEngine.audio.src, winningSrc);
    assert.equal(raceEngine.activeObjectUrl, winningSrc, 'stale load must not clobber activeObjectUrl');
    raceEngine.destroy();
  } finally {
    globalThis.window = prevWindow;
    globalThis.Audio = prevAudio;
  }
});

test('SupabaseSyncService syncs fresh Google Drive token cross-device via drive_folder_name envelope and handles PGRST204 gracefully', async () => {
  const settingsTable = [];
  let simulatePgrst204 = false;

  const mockFetch = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.includes('/rest/v1/audiobook_user_settings')) {
      if (method === 'POST') {
        if (simulatePgrst204 && 'drive_folder_name' in (body || {})) {
          return {
            ok: false,
            status: 400,
            text: async () => JSON.stringify({ code: 'PGRST204', message: "Could not find the 'drive_folder_name' column" }),
          };
        }
        settingsTable[0] = { ...(settingsTable[0] || {}), ...body };
        return { ok: true, status: 200, text: async () => JSON.stringify([settingsTable[0]]) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(settingsTable) };
    }
    return { ok: true, status: 200, text: async () => '[]' };
  };

  const now = Date.now();
  const pcSync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: null,
    navigatorObj: { onLine: true },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: mockFetch,
  });
  pcSync.setSession({
    access_token: 'supa-jwt-1',
    user: { id: 'user-1', email: 'test@example.com' },
  });
  pcSync.setGoogleAccessToken('ya29.fresh_pc_tok', { obtainedAt: now });

  const saved = await pcSync.syncDriveFolderConfig({ folderId: 'fld-9', folderName: 'My Audiobooks' });
  assert.equal(saved.folderName, 'My Audiobooks');
  const envelope = JSON.parse(settingsTable[0].drive_folder_name);
  assert.equal(envelope.folderName, 'My Audiobooks');
  assert.equal(envelope.googleAccessToken, 'ya29.fresh_pc_tok');
  assert.equal(envelope.googleTokenObtainedAt, now);

  // Second device with older/no token adopts fresher token automatically
  const androidSync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: null,
    navigatorObj: { onLine: true },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: mockFetch,
  });
  androidSync.setSession({
    access_token: 'supa-jwt-2',
    user: { id: 'user-1', email: 'test@example.com' },
  });
  androidSync.setGoogleAccessToken('ya29.stale_android_tok', { obtainedAt: now - 30 * 60 * 1000 });
  assert.equal(androidSync._lastGoogleTokenFromRemote, false);

  const remoteEvents = [];
  const unsub = androidSync.onGoogleTokenChange((tok, meta) => {
    remoteEvents.push({ tok, fromRemote: Boolean(meta?.fromRemote) });
  });

  const fetched = await androidSync.fetchDriveFolderConfig();
  unsub();
  assert.equal(fetched.folderId, 'fld-9');
  assert.equal(fetched.folderName, 'My Audiobooks');
  assert.equal(androidSync.getGoogleAccessToken(), 'ya29.fresh_pc_tok');
  assert.equal(androidSync.googleTokenObtainedAt, now);
  assert.equal(androidSync._lastGoogleTokenFromRemote, true);
  assert.deepEqual(remoteEvents, [{ tok: 'ya29.fresh_pc_tok', fromRemote: true }]);

  // Stale (>= 50 min) remote token must NOT overwrite a newer local token
  settingsTable[0].drive_folder_name = JSON.stringify({
    folderName: 'My Audiobooks',
    googleAccessToken: 'ya29.too_old_tok',
    googleTokenObtainedAt: now - 55 * 60 * 1000,
  });
  await androidSync.fetchDriveFolderConfig();
  assert.equal(androidSync.getGoogleAccessToken(), 'ya29.fresh_pc_tok');

  // Graceful PGRST204 fallback never throws
  simulatePgrst204 = true;
  const fallbackSaved = await pcSync.syncDriveFolderConfig({ folderId: 'fld-10', folderName: 'Fallback' });
  assert.equal(fallbackSaved.folderId, 'fld-10');

  pcSync.destroy();
  androidSync.destroy();
});

test('MediaSessionBridge uses MultiPlayer fallback title and album labels', () => {
  const prevNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const prevMediaMetadata = globalThis.MediaMetadata;
  try {
    let assignedMeta = null;
    globalThis.MediaMetadata = class MockMediaMetadata {
      constructor(data) {
        Object.assign(this, data);
      }
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: {
        mediaSession: {
          setActionHandler() {},
          set metadata(val) {
            assignedMeta = val;
          },
          get metadata() {
            return assignedMeta;
          },
        },
      },
    });
    const bridge = new MediaSessionBridge();
    bridge.updateMetadata({ title: '', author: 'Author', series: '' }, '');
    assert.equal(assignedMeta.title, 'MultiPlayer');
    assert.equal(assignedMeta.album, 'MultiPlayer');
    bridge.destroy();
  } finally {
    if (prevNavDesc) {
      Object.defineProperty(globalThis, 'navigator', prevNavDesc);
    }
    globalThis.MediaMetadata = prevMediaMetadata;
  }
});
