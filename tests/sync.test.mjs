import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OfflineSyncQueue,
  resolveProgressConflict
} from '../src/services/offline-queue.js';
import {
  DEFAULT_GOOGLE_CLIENT_ID,
  DEFAULT_GOOGLE_SCOPES,
  SUPABASE_CONFIG,
  SupabaseSyncService,
  deduplicateDevicesList,
  detectDeviceName,
  handleRemoteEvent,
  mergeCloudBook,
  mergeEpisodeProgressMaps,
  normalizeCloudBook
} from '../src/services/supabase-sync.js';
import { createPodcastBookItem } from '../src/services/podcast-service.js';
import { deduplicateLibraryItems } from '../src/services/library-scanner.js';
import { AudioEngine } from '../src/player/audio-engine.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear()
  };
}

function createFakeWindow() {
  const listeners = new Map();
  return {
    location: {
      origin: 'https://audiobook.local',
      hash: '',
      search: '',
      assignedUrl: null,
      assign(url) {
        this.assignedUrl = url;
      }
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(type, extra = {}) {
      for (const fn of listeners.get(type) || []) {
        fn({ type, ...extra });
      }
    }
  };
}

test('SUPABASE_CONFIG points to isolated project configuration', () => {
  assert.equal(SUPABASE_CONFIG.url, 'https://ycokzejqpenvlamvzhrm.supabase.co');
  assert.equal(
    SUPABASE_CONFIG.publishableKey,
    'sb_publishable_YzLKM2MCjKhqrc91vgmsFA_8RZlzyOZ'
  );
});

test('resolveProgressConflict picks newer clientUpdatedAt across ISO and epoch ms', () => {
  const localNewer = {
    bookKey: 'project-hail-mary::andy-weir',
    chapterIndex: 4,
    positionSec: 1240,
    clientUpdatedAt: '2026-11-18T10:15:00.000Z'
  };
  const remoteOlder = {
    bookKey: 'project-hail-mary::andy-weir',
    chapterIndex: 3,
    positionSec: 980,
    clientUpdatedAt: Date.parse('2026-11-18T10:10:00.000Z')
  };

  assert.deepEqual(resolveProgressConflict(localNewer, remoteOlder), localNewer);

  const remoteNewer = {
    ...remoteOlder,
    positionSec: 1500,
    clientUpdatedAt: '2026-11-18T10:20:00.000Z'
  };
  assert.deepEqual(resolveProgressConflict(localNewer, remoteNewer), remoteNewer);
});

test('resolveProgressConflict tie-breaks equal timestamps by higher positionSec and handles nulls', () => {
  const recA = {
    bookKey: 'dune::frank-herbert',
    positionSec: 420,
    clientUpdatedAt: '2026-11-18T12:00:00.000Z'
  };
  const recB = {
    bookKey: 'dune::frank-herbert',
    positionSec: 615,
    clientUpdatedAt: Date.parse('2026-11-18T12:00:00.000Z')
  };

  assert.deepEqual(resolveProgressConflict(recA, recB), recB);
  assert.deepEqual(resolveProgressConflict(recB, recA), recB);
  assert.deepEqual(resolveProgressConflict(recA, null), recA);
  assert.deepEqual(resolveProgressConflict(null, recB), recB);
  assert.equal(resolveProgressConflict(null, null), null);
});

test('OfflineSyncQueue deduplicates by bookKey, sorts pending queue, and respects upToTimestamp on clearFlushed', () => {
  const storage = createMemoryStorage();
  const queue = new OfflineSyncQueue({ storage });

  queue.enqueueProgress({
    bookKey: 'book-a',
    chapterIndex: 1,
    positionSec: 100,
    clientUpdatedAt: '2026-11-18T08:00:00.000Z'
  });
  queue.enqueueProgress({
    bookKey: 'book-a',
    chapterIndex: 2,
    positionSec: 250,
    clientUpdatedAt: '2026-11-18T08:05:00.000Z'
  });
  // Stale timestamp must not overwrite newer queued checkpoint
  queue.enqueueProgress({
    bookKey: 'book-a',
    chapterIndex: 0,
    positionSec: 50,
    clientUpdatedAt: '2026-11-18T07:55:00.000Z'
  });
  queue.enqueueProgress({
    bookKey: 'book-b',
    chapterIndex: 0,
    positionSec: 45,
    clientUpdatedAt: '2026-11-18T08:02:00.000Z'
  });

  const pending = queue.getPendingQueue();
  assert.equal(pending.length, 2);
  assert.equal(pending[0].bookKey, 'book-b');
  assert.equal(pending[1].bookKey, 'book-a');
  assert.equal(pending[1].positionSec, 250);

  // If a newer update arrived at 08:05, clearing up to 08:03 must keep book-a
  assert.equal(queue.clearFlushed('book-a', '2026-11-18T08:03:00.000Z'), 0);
  assert.equal(queue.getPendingQueue().length, 2);

  // Clearing up to 08:05 removes book-a
  assert.equal(queue.clearFlushed('book-a', '2026-11-18T08:05:00.000Z'), 1);
  assert.equal(queue.getPendingQueue().length, 1);
  assert.equal(queue.getPendingQueue()[0].bookKey, 'book-b');

  // Verify localStorage persistence across reload
  const reloaded = new OfflineSyncQueue({ storage });
  assert.equal(reloaded.getLocalProgress('book-a').positionSec, 250);
  assert.equal(reloaded.getAllLocalProgress()['book-b'].positionSec, 45);
  assert.equal(reloaded.getPendingQueue().length, 1);

  // Single-argument clearFlushed(upToTimestamp) clears remaining older items
  reloaded.clearFlushed('2026-11-18T08:10:00.000Z');
  assert.equal(reloaded.getPendingQueue().length, 0);
});

test('OfflineSyncQueue stamps clientUpdatedAt automatically when omitted', () => {
  const queue = new OfflineSyncQueue({ storage: createMemoryStorage() });
  const first = queue.enqueueProgress({ bookKey: 'auto-stamp', positionSec: 12 });
  const second = queue.enqueueProgress({ bookKey: 'auto-stamp', positionSec: 28 });

  assert.ok(first.clientUpdatedAt);
  assert.ok(second.clientUpdatedAt);
  assert.equal(queue.getPendingQueue().length, 1);
  assert.equal(queue.getPendingQueue()[0].positionSec, 28);
});

test('SupabaseSyncService queues offline progress and auto-flushes on online reconnection', async () => {
  const storage = createMemoryStorage();
  const fakeWindow = createFakeWindow();
  const navigatorObj = { onLine: false, userAgent: 'Mozilla/5.0 (Windows NT 10.0)' };
  const requests = [];

  const mockFetch = async (url, init) => {
    requests.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : null
    });
    return {
      ok: true,
      status: 201,
      async text() {
        return JSON.stringify([init.body ? JSON.parse(init.body) : {}]);
      }
    };
  };

  const sync = new SupabaseSyncService({
    storage,
    windowObj: fakeWindow,
    navigatorObj,
    fetchImpl: mockFetch,
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    deviceId: 'win-pc-1',
    deviceName: 'Windows PC'
  });

  sync.setSession({
    access_token: 'jwt-token-123',
    provider_token: 'google-drive-token-xyz',
    user: {
      id: 'user-uuid-1',
      email: 'listener@gmail.com',
      user_metadata: {
        full_name: 'Alex Listener',
        picture: 'https://lh3.googleusercontent.com/a/avatar.png'
      }
    }
  });

  const profile = sync.getUserProfile();
  assert.deepEqual(profile, {
    id: 'user-uuid-1',
    email: 'listener@gmail.com',
    name: 'Alex Listener',
    avatarUrl: 'https://lh3.googleusercontent.com/a/avatar.png'
  });

  // Offline listening ticks for the same book should be queued & deduplicated
  const r1 = await sync.pushProgress({
    bookKey: 'project-hail-mary::andy-weir',
    chapterIndex: 2,
    positionSec: 120,
    durationSec: 3600,
    clientUpdatedAt: '2026-11-18T09:00:00.000Z'
  });
  const r2 = await sync.pushProgress({
    bookKey: 'project-hail-mary::andy-weir',
    chapterIndex: 2,
    positionSec: 345,
    durationSec: 3600,
    clientUpdatedAt: '2026-11-18T09:04:00.000Z'
  });
  await sync.saveBookmark('project-hail-mary::andy-weir', {
    id: 'bm-1',
    chapterIndex: 2,
    positionSec: 345,
    label: 'Important discovery'
  });

  assert.equal(r1.queued, true);
  assert.equal(r2.queued, true);
  assert.equal(requests.length, 0);
  assert.equal(sync.offlineQueue.getPendingQueue().length, 1);
  assert.equal(sync.offlineQueue.getPendingQueue()[0].positionSec, 345);
  assert.equal(sync.offlineQueue.getPendingBookmarks().length, 1);

  // Simulate device coming back online and firing window 'online'
  navigatorObj.onLine = true;
  const flushedPromise = new Promise((resolve) => {
    sync.onQueueFlushed(resolve);
  });
  fakeWindow.dispatchEvent('online');
  const flushResult = await flushedPromise;

  assert.equal(flushResult.flushedProgress, 1);
  assert.equal(flushResult.flushedBookmarks, 1);
  assert.equal(flushResult.remaining, 0);
  assert.equal(sync.offlineQueue.getPendingQueue().length, 0);
  assert.equal(sync.offlineQueue.getPendingBookmarks().length, 0);

  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/rest\/v1\/audiobook_progress/);
  assert.equal(requests[0].body.position_sec, 345);
  assert.match(requests[1].url, /\/rest\/v1\/audiobook_bookmarks/);
  assert.equal(requests[1].body.label, 'Important discovery');

  sync.destroy();
});

test('SupabaseSyncService fetchAllProgress reconciles cloud records against newer local offline record', async () => {
  const storage = createMemoryStorage();
  const queue = new OfflineSyncQueue({ storage });
  queue.saveLocalProgress('book-1', {
    bookKey: 'book-1',
    chapterIndex: 5,
    positionSec: 2100,
    clientUpdatedAt: '2026-11-18T11:30:00.000Z'
  });

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify([
        {
          book_key: 'book-1',
          chapter_index: 4,
          position_sec: 1800,
          client_updated_at: '2026-11-18T11:00:00.000Z'
        },
        {
          book_key: 'book-2',
          chapter_index: 1,
          position_sec: 95,
          client_updated_at: '2026-11-18T11:25:00.000Z'
        }
      ]);
    }
  });

  const sync = new SupabaseSyncService({
    storage,
    offlineQueue: queue,
    fetchImpl: mockFetch,
    navigatorObj: { onLine: true },
    windowObj: null,
    BroadcastChannelImpl: null,
    WebSocketImpl: null
  });
  sync.setSession({ access_token: 'jwt', user: { id: 'u1', email: 'a@gmail.com' } });

  const merged = await sync.fetchAllProgress();
  assert.equal(merged['book-1'].positionSec, 2100);
  assert.equal(merged['book-2'].positionSec, 95);
  sync.destroy();
});

test('handleRemoteEvent pauses local playback on remote PLAYBACK_STARTED and ignores self-echo', () => {
  const localState = {
    deviceId: 'android-phone-1',
    deviceName: 'Pixel 9',
    bookKey: 'project-hail-mary::andy-weir',
    chapterIndex: 3,
    positionSec: 540,
    isPlaying: true,
    clientUpdatedAt: '2026-11-18T10:00:00.000Z'
  };

  // Remote device starts playing
  const handoff = handleRemoteEvent(localState, {
    event: 'PLAYBACK_STARTED',
    deviceId: 'windows-pc-2',
    deviceName: 'Windows Desktop',
    bookKey: 'project-hail-mary::andy-weir',
    chapterIndex: 4,
    positionSec: 1025,
    clientUpdatedAt: '2026-11-18T10:05:00.000Z'
  });

  assert.deepEqual(handoff, {
    shouldPauseLocal: true,
    updatedBookKey: 'project-hail-mary::andy-weir',
    updatedChapterIndex: 4,
    updatedPositionSec: 1025,
    activeDeviceName: 'Windows Desktop'
  });

  // Same-device echo must NOT pause local playback
  const selfEcho = handleRemoteEvent(localState, {
    event: 'PLAYBACK_STARTED',
    deviceId: 'android-phone-1',
    deviceName: 'Pixel 9',
    bookKey: 'project-hail-mary::andy-weir',
    chapterIndex: 3,
    positionSec: 545
  });
  assert.equal(selfEcho.shouldPauseLocal, false);
  assert.equal(selfEcho.updatedPositionSec, 540);

  // Remote pause/position sync updates position without forcing pause state flag
  const remotePause = handleRemoteEvent(localState, {
    event: 'PLAYBACK_PAUSED',
    deviceId: 'windows-pc-2',
    deviceName: 'Windows Desktop',
    bookKey: 'project-hail-mary::andy-weir',
    chapterIndex: 4,
    positionSec: 1110,
    clientUpdatedAt: '2026-11-18T10:08:00.000Z'
  });
  assert.equal(remotePause.shouldPauseLocal, false);
  assert.equal(remotePause.updatedChapterIndex, 4);
  assert.equal(remotePause.updatedPositionSec, 1110);
});

test('SupabaseSyncService BroadcastChannel cross-tab handoff delivers remote events and filters self-echo', () => {
  const channels = [];
  class MockBroadcastChannel {
    constructor(name) {
      this.name = name;
      this.onmessage = null;
      channels.push(this);
    }
    postMessage(data) {
      for (const ch of channels) {
        if (ch !== this && ch.name === this.name && typeof ch.onmessage === 'function') {
          ch.onmessage({ data });
        }
      }
    }
    close() {}
  }

  const phoneSync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: null,
    BroadcastChannelImpl: MockBroadcastChannel,
    WebSocketImpl: null,
    deviceId: 'phone-1',
    deviceName: 'Galaxy Phone'
  });

  const pcSync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: null,
    BroadcastChannelImpl: MockBroadcastChannel,
    WebSocketImpl: null,
    deviceId: 'pc-1',
    deviceName: 'Windows PC'
  });

  const receivedByPhone = [];
  const receivedByPc = [];
  phoneSync.onRemotePlaybackEvent((evt) => receivedByPhone.push(evt));
  pcSync.onRemotePlaybackEvent((evt) => receivedByPc.push(evt));

  pcSync.broadcastPlaybackState({
    isPlaying: true,
    bookKey: 'fellowship-of-the-ring::jrr-tolkien',
    chapterIndex: 2,
    positionSec: 780
  });

  assert.equal(receivedByPc.length, 0);
  assert.equal(receivedByPhone.length, 1);

  const decision = handleRemoteEvent(
    { deviceId: phoneSync.deviceId, bookKey: 'fellowship-of-the-ring::jrr-tolkien', positionSec: 100 },
    receivedByPhone[0]
  );
  assert.equal(decision.shouldPauseLocal, true);
  assert.equal(decision.updatedPositionSec, 780);
  assert.equal(decision.activeDeviceName, 'Windows PC');

  phoneSync.destroy();
  pcSync.destroy();
});

test('SupabaseSyncService builds Google OAuth URL and handles signOut', async () => {
  const fakeWindow = createFakeWindow();
  const fetchCalls = [];
  const sync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: fakeWindow,
    navigatorObj: { onLine: true },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init });
      return { ok: true, status: 204, async text() { return ''; } };
    }
  });

  const { url } = await sync.signInWithGoogle({ autoRedirect: false });
  assert.match(url, /^https:\/\/ycokzejqpenvlamvzhrm\.supabase\.co\/auth\/v1\/authorize\?/);
  assert.match(url, /provider=google/);
  assert.match(url, /drive\.readonly/);

  sync.setSession({ access_token: 'tok', user: { id: 'u1', email: 'test@gmail.com' } });
  assert.equal(sync.isAuthenticated(), true);

  await sync.signOut();
  assert.equal(sync.isAuthenticated(), false);
  assert.equal(sync.getUserProfile(), null);
  assert.match(fetchCalls[0].url, /\/auth\/v1\/logout$/);
  sync.destroy();
});

test('SupabaseSyncService signInWithGoogle checks /auth/v1/settings and never navigates when google provider is disabled', async () => {
  const fakeWindow = createFakeWindow();
  const openedUrls = [];
  fakeWindow.open = (url) => {
    openedUrls.push(url);
    return null;
  };

  const sync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: fakeWindow,
    navigatorObj: { onLine: true },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async (url) => {
      if (url.endsWith('/auth/v1/settings')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { external: { google: false, email: true } };
          }
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  const result = await sync.signInWithGoogle({ autoRedirect: true });
  assert.equal(result.supported, false);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'provider_not_enabled');
  assert.equal(fakeWindow.location.assignedUrl, null);
  assert.equal(openedUrls.length, 0);
  sync.destroy();
});

test('SupabaseSyncService signInWithGoogle uses popup instead of replacing Tauri window when google provider is enabled', async () => {
  const fakeWindow = createFakeWindow();
  fakeWindow.location.origin = 'https://tauri.localhost';
  const openedUrls = [];
  fakeWindow.open = (url) => {
    openedUrls.push(url);
    return { closed: false, close() {} };
  };

  const sync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: fakeWindow,
    navigatorObj: { onLine: true },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async (url) => {
      if (url.endsWith('/auth/v1/settings')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { external: { google: true, email: true } };
          }
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  const result = await sync.signInWithGoogle({ autoRedirect: true });
  assert.equal(result.supported, true);
  assert.equal(result.mode, 'popup');
  assert.equal(fakeWindow.location.assignedUrl, null);
  assert.equal(openedUrls.length, 1);
  assert.match(openedUrls[0], /provider=google/);
  sync.destroy();
});

test('SupabaseSyncService signInWithEmail signs in existing user and auto-creates new account on invalid_credentials', async () => {
  const storage = createMemoryStorage();
  const requests = [];

  const sync = new SupabaseSyncService({
    storage,
    windowObj: null,
    navigatorObj: { onLine: true },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      requests.push({ url, body });

      if (url.includes('/auth/v1/token?grant_type=password') && body.email === 'existing@gmail.com') {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              access_token: 'jwt-existing',
              refresh_token: 'ref-1',
              user: { id: 'u-existing', email: 'existing@gmail.com', user_metadata: {} }
            });
          }
        };
      }

      if (url.includes('/auth/v1/token?grant_type=password') && body.email === 'newuser@gmail.com') {
        return {
          ok: false,
          status: 400,
          async text() {
            return JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials' });
          }
        };
      }

      if (url.includes('/auth/v1/signup')) {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              access_token: 'jwt-new',
              user: {
                id: 'u-new',
                email: 'newuser@gmail.com',
                user_metadata: body.data
              }
            });
          }
        };
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  const res1 = await sync.signInWithEmail('existing@gmail.com', 'secret123');
  assert.equal(res1.ok, true);
  assert.equal(res1.created, false);
  assert.equal(sync.isAuthenticated(), true);
  assert.equal(sync.getUserProfile().email, 'existing@gmail.com');
  assert.match(sync.getUserProfile().avatarUrl, /^https:\/\/www\.gravatar\.com\/avatar\/[a-f0-9]{64}/);

  const res2 = await sync.signInWithEmail('newuser@gmail.com', 'secret123');
  assert.equal(res2.ok, true);
  assert.equal(res2.created, true);
  assert.equal(sync.getUserProfile().email, 'newuser@gmail.com');
  assert.equal(sync.getUserProfile().name, 'Newuser');
  sync.destroy();
});

test('SupabaseSyncService completeGoogleOAuthToken hydrates Google userinfo and Drive token', async () => {
  const sync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: null,
    navigatorObj: { onLine: true },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async (url) => {
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              sub: '123456',
              email: 'reader@gmail.com',
              name: 'Reader One',
              picture: 'https://lh3.googleusercontent.com/a/photo.jpg'
            };
          }
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  const res = await sync.completeGoogleOAuthToken('ya29.test-google-token');
  assert.equal(res.ok, true);
  assert.equal(sync.getGoogleAccessToken(), 'ya29.test-google-token');
  assert.deepEqual(sync.getUserProfile(), {
    id: 'google_123456',
    email: 'reader@gmail.com',
    name: 'Reader One',
    avatarUrl: 'https://lh3.googleusercontent.com/a/photo.jpg'
  });
  sync.destroy();
});

test('SupabaseSyncService Android Capacitor and Mobile Chrome PWA never redirect to disabled Google provider and handle blocked popups cleanly', async () => {
  for (const env of [
    { origin: 'https://localhost', protocol: 'https:', ua: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36', capacitor: { isNativePlatform: () => true } },
    { origin: 'capacitor://localhost', protocol: 'capacitor:', ua: 'Mozilla/5.0 (Linux; Android 14)', capacitor: null },
    { origin: 'https://larxe1.github.io', protocol: 'https:', ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 9) Chrome/130.0', capacitor: null }
  ]) {
    const fakeWindow = createFakeWindow();
    fakeWindow.location.origin = env.origin;
    fakeWindow.location.protocol = env.protocol;
    fakeWindow.location.pathname = '/Audiobook-Player/';
    if (env.capacitor) fakeWindow.Capacitor = env.capacitor;
    fakeWindow.open = () => null; // Simulate WebView / mobile popup blocked

    const sync = new SupabaseSyncService({
      storage: createMemoryStorage(),
      windowObj: fakeWindow,
      navigatorObj: { onLine: true, userAgent: env.ua },
      BroadcastChannelImpl: null,
      WebSocketImpl: null,
      fetchImpl: async (url) => {
        if (url.endsWith('/auth/v1/settings')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return { external: { google: false, email: true } };
            }
          };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }
    });

    const res = await sync.signInWithGoogle({
      autoRedirect: true,
      fallbackToDirectGoogleOAuth: true,
      forcePopup: true
    });
    assert.equal(res.supported, false);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'popup_blocked');
    assert.equal(fakeWindow.location.assignedUrl, null);
    sync.destroy();
  }
});

test('SupabaseSyncService Capacitor Android uses popup rather than replacing WebView when Supabase Google provider is enabled', async () => {
  const fakeWindow = createFakeWindow();
  fakeWindow.location.origin = 'https://localhost';
  fakeWindow.location.protocol = 'https:';
  fakeWindow.Capacitor = { isNativePlatform: () => true };
  fakeWindow.open = () => null;

  const sync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: fakeWindow,
    navigatorObj: { onLine: true, userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async (url) => {
      if (url.endsWith('/auth/v1/settings')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { external: { google: true, email: true } };
          }
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  const res = await sync.signInWithGoogle({ autoRedirect: true });
  assert.equal(res.supported, true);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'popup_unavailable');
  assert.equal(fakeWindow.location.assignedUrl, null);
  sync.destroy();
});

test('SupabaseSyncService Tauri native OAuth popup invokes desktop commands and hydrates Gmail profile', async () => {
  const fakeWindow = createFakeWindow();
  fakeWindow.location.origin = 'https://tauri.localhost';
  const invokeCalls = [];
  let pollCount = 0;
  fakeWindow.__TAURI_INTERNALS__ = {
    invoke: async (cmd) => {
      invokeCalls.push(cmd);
      if (cmd === 'desktop_start_google_oauth') {
        return { status: 'pending', accessToken: null };
      }
      if (cmd === 'desktop_poll_google_oauth') {
        pollCount++;
        if (pollCount >= 1) {
          return { status: 'success', accessToken: 'ya29.tauri_native_popup_token' };
        }
        return { status: 'pending', accessToken: null };
      }
      return true;
    }
  };

  const sync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: fakeWindow,
    navigatorObj: { onLine: true, userAgent: 'Windows NT 10.0' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async (url) => {
      if (url.endsWith('/auth/v1/settings')) {
        return { ok: true, status: 200, async json() { return { external: { google: false } }; } };
      }
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              sub: '9988',
              email: 'reader@gmail.com',
              name: 'Reader User',
              picture: 'https://lh3.googleusercontent.com/avatar.jpg'
            };
          }
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  const res = await sync.signInWithGoogle({ autoRedirect: true, fallbackToDirectGoogleOAuth: true });
  assert.equal(res.ok, true);
  assert.ok(invokeCalls.includes('desktop_start_google_oauth'));
  assert.ok(invokeCalls.includes('desktop_poll_google_oauth'));
  assert.equal(sync.getUserProfile().email, 'reader@gmail.com');
  assert.equal(sync.getGoogleAccessToken(), 'ya29.tauri_native_popup_token');
  sync.destroy();
});

test('SupabaseSyncService Android native OAuth bridge hydrates Gmail profile on Capacitor', async () => {
  const fakeWindow = createFakeWindow();
  fakeWindow.location.origin = 'https://localhost';
  fakeWindow.Capacitor = { isNativePlatform: () => true };
  fakeWindow.__ANDROID_GOOGLE_OAUTH__ = async () => ({
    access_token: 'ya29.android_native_popup_token'
  });

  const sync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: fakeWindow,
    navigatorObj: { onLine: true, userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async (url) => {
      if (url.endsWith('/auth/v1/settings')) {
        return { ok: true, status: 200, async json() { return { external: { google: false } }; } };
      }
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              sub: '7766',
              email: 'driver@gmail.com',
              name: 'Driver User',
              picture: 'https://lh3.googleusercontent.com/driver.jpg'
            };
          }
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  const res = await sync.signInWithGoogle({ autoRedirect: true, fallbackToDirectGoogleOAuth: true });
  assert.equal(res.ok, true);
  assert.equal(sync.getUserProfile().email, 'driver@gmail.com');
  assert.equal(sync.getGoogleAccessToken(), 'ya29.android_native_popup_token');
  sync.destroy();
});

test('DEFAULT_GOOGLE_CLIENT_ID matches updated OAuth client ID', () => {
  assert.equal(
    DEFAULT_GOOGLE_CLIENT_ID,
    '22283534025-av56s1jjavk740hd5n4i7r10jkjajd1f.apps.googleusercontent.com'
  );
});

test('SupabaseSyncService AudiobookOAuthNative Chrome Custom Tabs flow verifies state and completes OAuth', async () => {
  const fakeWindow = createFakeWindow();
  fakeWindow.location.origin = 'https://localhost';
  fakeWindow.Capacitor = { isNativePlatform: () => true };

  let capturedArgs = null;
  let consumeCalls = 0;
  fakeWindow.AudiobookOAuthNative = {
    consumePendingResult() {
      consumeCalls += 1;
      return null;
    },
    startGoogleOAuth(clientId, scope, loginHint, state, redirectUri) {
      capturedArgs = { clientId, scope, loginHint, state, redirectUri };
      queueMicrotask(() => {
        fakeWindow.__onAndroidGoogleOAuthResult({
          access_token: 'ya29.custom_tabs_android_token',
          state
        });
      });
    }
  };

  const sync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: fakeWindow,
    navigatorObj: { onLine: true, userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async (url) => {
      if (url.endsWith('/auth/v1/settings')) {
        return { ok: true, status: 200, async json() { return { external: { google: false } }; } };
      }
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              sub: '5544',
              email: 'customtabs@gmail.com',
              name: 'Custom Tabs User',
              picture: 'https://lh3.googleusercontent.com/ct.jpg'
            };
          }
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  const res = await sync.signInWithGoogle({
    autoRedirect: true,
    fallbackToDirectGoogleOAuth: true,
    hint: 'customtabs@gmail.com'
  });

  assert.equal(res.ok, true);
  assert.ok(consumeCalls >= 1);
  assert.equal(capturedArgs.clientId, DEFAULT_GOOGLE_CLIENT_ID);
  assert.equal(capturedArgs.loginHint, 'customtabs@gmail.com');
  assert.match(capturedArgs.state, /^android_/);
  assert.equal(
    capturedArgs.redirectUri,
    'https://larxe1.github.io/Audiobook-Player/oauth-callback.html'
  );
  assert.equal(sync.getUserProfile().email, 'customtabs@gmail.com');
  assert.equal(sync.getGoogleAccessToken(), 'ya29.custom_tabs_android_token');
  assert.equal(fakeWindow.__onAndroidGoogleOAuthResult, undefined);
  sync.destroy();
});

test('SupabaseSyncService AudiobookOAuthNative rejects mismatched state and handles cancellation on focus/visibilitychange', async () => {
  const fakeWindow = createFakeWindow();
  fakeWindow.location.origin = 'https://localhost';
  fakeWindow.Capacitor = { isNativePlatform: () => true };

  // 1. Mismatched state must be rejected cleanly
  fakeWindow.AudiobookOAuthNative = {
    consumePendingResult: () => null,
    startGoogleOAuth() {
      queueMicrotask(() => {
        fakeWindow.__onAndroidGoogleOAuthResult({
          access_token: 'ya29.forged_token',
          state: 'android_wrong_state'
        });
      });
    }
  };

  const sync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: fakeWindow,
    navigatorObj: { onLine: true, userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async (url) => {
      if (url.endsWith('/auth/v1/settings')) {
        return { ok: true, status: 200, async json() { return { external: { google: false } }; } };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  const mismatchRes = await sync.signInWithGooglePopup();
  assert.equal(mismatchRes.ok, false);
  assert.equal(mismatchRes.reason, 'oauth_state_mismatch');
  assert.equal(sync.getGoogleAccessToken(), null);

  // 2. Returning to app (focus/visibilitychange) without OAuth completion cancels cleanly
  fakeWindow.AudiobookOAuthNative = {
    consumePendingResult: () => null,
    startGoogleOAuth() {
      setTimeout(() => {
        fakeWindow.dispatchEvent('focus');
      }, 5);
    }
  };

  const cancelRes = await sync.signInWithGooglePopup({ androidCancelDelayMs: 25 });
  assert.equal(cancelRes.ok, false);
  assert.equal(cancelRes.reason, 'popup_closed');
  assert.equal(fakeWindow.__onAndroidGoogleOAuthResult, undefined);
  sync.destroy();
});

test('SupabaseSyncService openBrowserOAuthPopup completes OAuth via postMessage from oauth-callback.html', async () => {
  const fakeWindow = createFakeWindow();
  fakeWindow.location.origin = 'https://larxe1.github.io';
  fakeWindow.location.pathname = '/Audiobook-Player/';
  let popupClosed = false;
  fakeWindow.open = () => ({
    closed: false,
    location: {},
    close() {
      popupClosed = true;
      this.closed = true;
    }
  });

  const sync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: fakeWindow,
    navigatorObj: { onLine: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0)' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async (url) => {
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { sub: '321', email: 'pwa@gmail.com', name: 'PWA Reader' };
          }
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  const pending = sync.signInWithGooglePopup({ forcePopup: true });
  setTimeout(() => {
    fakeWindow.dispatchEvent('message', {
      origin: 'https://larxe1.github.io',
      data: {
        type: 'audiobook_google_oauth',
        access_token: 'ya29.postmessage_token'
      }
    });
  }, 15);

  const res = await pending;
  assert.equal(res.ok, true);
  assert.equal(popupClosed, true);
  assert.equal(sync.getGoogleAccessToken(), 'ya29.postmessage_token');
  assert.equal(sync.getUserProfile().email, 'pwa@gmail.com');
  sync.destroy();
});


test('DEFAULT_GOOGLE_SCOPES includes drive.appdata and signInWithGoogle/Popup pass forceConsent and forceRefresh', async () => {
  assert.match(DEFAULT_GOOGLE_SCOPES, /drive\.appdata/);
  assert.match(DEFAULT_GOOGLE_SCOPES, /drive\.readonly/);

  const fakeWindow = createFakeWindow();
  fakeWindow.location.origin = 'https://tauri.localhost';
  const invokeCalls = [];
  fakeWindow.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      invokeCalls.push({ cmd, args });
      if (cmd === 'desktop_start_google_oauth') {
        return { status: 'success', accessToken: 'ya29.tauri_reauth_token' };
      }
      return null;
    }
  };

  const sync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: fakeWindow,
    navigatorObj: { onLine: true, userAgent: 'Windows NT 10.0' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async (url) => {
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return { ok: true, status: 200, async json() { return { sub: '1', email: 'u@gmail.com' }; } };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  const { url } = await sync.signInWithGoogle({ autoRedirect: false, forceConsent: true });
  assert.match(url, /drive\.appdata/);
  assert.match(url, /prompt=select_account\+consent|prompt=select_account%20consent/);

  const res = await sync.signInWithGooglePopup({ forceConsent: true, forceRefresh: true });
  assert.equal(res.ok, true);
  assert.equal(invokeCalls[0].cmd, 'desktop_start_google_oauth');
  assert.equal(invokeCalls[0].args.forceConsent, true);
  assert.equal(invokeCalls[0].args.forceRefresh, true);
  sync.destroy();
});

test('SupabaseSyncService Google appDataFolder sync shares library, tracks, driveFolder, progress, and active device across PC and Android even when access_token is null', async () => {
  // Simulated shared Google Drive appDataFolder backend
  const driveCloud = {
    fileId: 'app-sync-file-1',
    exists: false,
    modifiedTime: '2026-11-18T12:00:00.000Z',
    content: null,
    mediaFetches: 0
  };

  const createDriveMockFetch = () => async (url, init = {}) => {
    // Metadata by ID
    if (url.startsWith(`https://www.googleapis.com/drive/v3/files/${driveCloud.fileId}?fields=`)) {
      if (!driveCloud.exists) return { ok: false, status: 404, async text() { return 'Not Found'; } };
      return {
        ok: true,
        status: 200,
        async json() {
          return { id: driveCloud.fileId, name: 'audiobook-player-sync-v1.json', modifiedTime: driveCloud.modifiedTime };
        }
      };
    }

    // List spaces=appDataFolder
    if (url.startsWith('https://www.googleapis.com/drive/v3/files?spaces=appDataFolder')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            files: driveCloud.exists
              ? [{ id: driveCloud.fileId, name: 'audiobook-player-sync-v1.json', modifiedTime: driveCloud.modifiedTime }]
              : []
          };
        }
      };
    }

    // Download alt=media
    if (url.startsWith(`https://www.googleapis.com/drive/v3/files/${driveCloud.fileId}?alt=media`)) {
      driveCloud.mediaFetches += 1;
      const bodyStr = JSON.stringify(driveCloud.content);
      return {
        ok: true,
        status: 200,
        async text() { return bodyStr; },
        async json() { return driveCloud.content; }
      };
    }

    // Multipart upload (POST create or PATCH update)
    if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
      const rawBody = String(init.body || '');
      const parts = rawBody.split(/\r?\n\r?\n/);
      // Last JSON part before closing boundary
      const payloadPart = parts[parts.length - 1].split(/\r?\n--/)[0];
      driveCloud.content = JSON.parse(payloadPart);
      driveCloud.exists = true;
      driveCloud.modifiedTime = new Date(Date.parse(driveCloud.modifiedTime) + 1000).toISOString();
      return {
        ok: true,
        status: 200,
        async json() {
          return { id: driveCloud.fileId, modifiedTime: driveCloud.modifiedTime };
        }
      };
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  // Device 1: Windows PC signed in with Google OAuth only (access_token: null)
  const pcSync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: null,
    navigatorObj: { onLine: true, userAgent: 'Windows NT 10.0' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: createDriveMockFetch(),
    deviceId: 'win-pc-sync',
    deviceName: 'Windows PC'
  });
  pcSync.setSession({
    access_token: null,
    auth_mode: 'google_oauth',
    provider_token: 'ya29.pc_google_token',
    user: { id: 'google_42', email: 'listener@gmail.com' }
  });

  assert.equal(pcSync.isAuthenticated(), false);
  assert.equal(pcSync.hasCloudSyncAuth(), true);

  await pcSync.syncDriveFolderConfig({ folderId: 'folder-abc', folderName: 'Audiobooks' });
  await pcSync.syncLibraryItems([
    {
      bookKey: 'first-law::joe-abercrombie',
      title: 'The Blade Itself',
      author: 'Joe Abercrombie',
      series: 'The First Law',
      seriesOrder: 1,
      sources: ['drive', 'local'],
      driveFileId: 'drive-file-1',
      coverDriveFileId: 'cover-file-1',
      driveFolderId: 'folder-abc',
      totalDurationSec: 7200,
      tracks: [
        { index: 0, title: 'Part 1', driveFileId: 'drive-file-1', localUrl: 'blob:http://tauri.localhost/123', localFile: { name: 'p1.mp3' } },
        { index: 1, title: 'Part 2', driveFileId: 'drive-file-2' }
      ],
      chapters: [
        { index: 0, title: 'Chapter 1', startSec: 0, driveFileId: 'drive-file-1' }
      ]
    }
  ]);
  await pcSync.pushProgress({
    bookKey: 'first-law::joe-abercrombie',
    chapterIndex: 1,
    positionSec: 456,
    playbackRate: 1.25,
    completed: false,
    clientUpdatedAt: '2026-11-18T12:05:00.000Z'
  });
  await pcSync.registerDevice({
    activeBookKey: 'first-law::joe-abercrombie',
    activeBookTitle: 'The Blade Itself',
    chapterIndex: 1,
    positionSec: 456,
    durationSec: 7200,
    isPlaying: true,
    isActivePlayer: true
  });

  // Device 2: Android APK signed in with Google OAuth only (access_token: null)
  const androidSync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: null,
    navigatorObj: { onLine: true, userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: createDriveMockFetch(),
    deviceId: 'android-pixel-9',
    deviceName: 'Android Device'
  });
  androidSync.setSession({
    access_token: null,
    auth_mode: 'google_oauth',
    provider_token: 'ya29.android_google_token',
    user: { id: 'google_42', email: 'listener@gmail.com' }
  });

  const snap1 = await androidSync.pullCloudSnapshot();
  assert.equal(snap1.changed, true);
  assert.equal(snap1.driveFolder.folderId, 'folder-abc');
  assert.equal(snap1.driveFolder.folderName, 'Audiobooks');
  assert.equal(snap1.library.length, 1);
  assert.equal(snap1.library[0].bookKey, 'first-law::joe-abercrombie');
  assert.equal(snap1.library[0].tracks.length, 2);
  assert.equal(snap1.library[0].tracks[0].driveFileId, 'drive-file-1');
  assert.equal(snap1.library[0].tracks[0].localFile, undefined);
  assert.equal(snap1.library[0].coverDriveFileId, 'cover-file-1');
  assert.equal(snap1.library[0].originDeviceId, 'win-pc-sync');
  assert.equal(snap1.progress['first-law::joe-abercrombie'].positionSec, 456);
  assert.equal(snap1.devices.length, 1);
  assert.equal(snap1.devices[0].deviceId, 'win-pc-sync');
  assert.equal(snap1.devices[0].currentBookKey, 'first-law::joe-abercrombie');
  assert.equal(snap1.devices[0].isPlaying, true);

  // Second lightweight poll with unchanged modifiedTime must skip alt=media download
  const fetchesBefore = driveCloud.mediaFetches;
  const snap2 = await androidSync.pullCloudSnapshot();
  assert.equal(snap2.changed, false);
  assert.equal(driveCloud.mediaFetches, fetchesBefore);

  // Android registers itself and must NOT clobber PC device or PC library
  await androidSync.registerDevice({
    activeBookKey: 'first-law::joe-abercrombie',
    activeBookTitle: 'The Blade Itself',
    chapterIndex: 1,
    positionSec: 500,
    isPlaying: false,
    isActivePlayer: true
  });
  const devicesOnPc = await pcSync.fetchDevices();
  assert.equal(devicesOnPc.length, 2);
  const libOnPc = await pcSync.fetchLibraryItems();
  assert.equal(libOnPc.length, 1);

  pcSync.destroy();
  androidSync.destroy();
});

test('SupabaseSyncService sets needsDriveSyncReauth = true without throwing when appDataFolder returns 403 insufficientPermissions', async () => {
  const sync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: null,
    navigatorObj: { onLine: true },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async (url) => {
      if (url.includes('spaces=appDataFolder')) {
        return {
          ok: false,
          status: 403,
          async text() {
            return JSON.stringify({
              error: {
                code: 403,
                errors: [{ reason: 'insufficientPermissions' }],
                message: 'Insufficient Permission'
              }
            });
          }
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });
  sync.setSession({
    access_token: null,
    auth_mode: 'google_oauth',
    provider_token: 'ya29.old_scope_token',
    user: { id: 'google_1', email: 'old@gmail.com' }
  });

  const snap = await sync.pullCloudSnapshot();
  assert.equal(sync.needsDriveSyncReauth, true);
  assert.deepEqual(snap.library, []);

  // Writing also returns cleanly without throwing
  const writeRes = await sync.syncDriveFolderConfig({ folderId: 'f1', folderName: 'Books' });
  assert.equal(writeRes, null);
  assert.equal(sync.needsDriveSyncReauth, true);

  sync.destroy();
});

test('SupabaseSyncService sends live Postgres schema columns and refreshes expired Supabase session', async () => {
  const calls = [];
  const sync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: null,
    navigatorObj: { onLine: true },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url, method: init.method || 'GET', body });
      if (url.includes('/auth/v1/token?grant_type=refresh_token')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              access_token: 'jwt-refreshed-2',
              refresh_token: 'refresh-2',
              expires_in: 3600
            };
          }
        };
      }
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify([]); }
      };
    }
  });

  sync.setSession({
    access_token: 'jwt-old-1',
    refresh_token: 'refresh-1',
    expires_at: Math.floor(Date.now() / 1000) - 10,
    user: { id: 'uuid-user-1', email: 'supa@gmail.com' }
  });

  const refreshed = await sync.refreshSupabaseSessionIfNeeded();
  assert.equal(refreshed.refreshed, true);
  assert.equal(sync.session.access_token, 'jwt-refreshed-2');

  await sync.syncLibraryItems([
    {
      bookKey: 'dune::herbert',
      title: 'Dune',
      author: 'Frank Herbert',
      description: 'Arrakis',
      driveFileId: 'df-1',
      driveFolderId: 'fld-1',
      coverDriveFileId: 'cov-1',
      tracks: [{ index: 0, title: 'Ch 1', driveFileId: 'df-1' }],
      chapters: [{ index: 0, title: 'Ch 1', startSec: 0, driveFileId: 'df-1' }]
    }
  ]);
  await sync.pushProgress({
    bookKey: 'dune::herbert',
    chapterIndex: 2,
    positionSec: 321,
    playbackRate: 1.5,
    completed: true
  });
  await sync.registerDevice({
    activeBookKey: 'dune::herbert',
    chapterIndex: 2,
    positionSec: 321,
    isPlaying: true,
    isActivePlayer: true
  });
  await sync.syncDriveFolderConfig({ folderId: 'fld-1', folderName: 'Books', lastActiveBookKey: 'dune::herbert' });

  const libCall = calls.find((c) => c.url.includes('/rest/v1/audiobook_library_items'));
  assert.equal(libCall.body[0].description, 'Arrakis');
  assert.equal(libCall.body[0].drive_folder_id, 'fld-1');
  assert.equal(libCall.body[0].chapters_json.length, 1);
  assert.equal(libCall.body[0].metadata_json.tracks.length, 1);
  assert.equal(libCall.body[0].metadata_json.coverDriveFileId, 'cov-1');

  const progCall = calls.find((c) => c.url.includes('/rest/v1/audiobook_progress'));
  assert.equal(progCall.body.is_finished, true);
  assert.equal(progCall.body.playback_rate, 1.5);
  assert.equal(progCall.body.completed, undefined);

  const devCall = calls.find((c) => c.url.includes('/rest/v1/audiobook_devices'));
  assert.equal(devCall.body.current_book_key, 'dune::herbert');
  assert.equal(devCall.body.current_chapter_index, 2);
  assert.equal(devCall.body.current_position_sec, 321);
  assert.equal(devCall.body.is_active_player, true);

  const settingsCall = calls.find((c) => c.url.includes('/rest/v1/audiobook_user_settings'));
  assert.equal(settingsCall.body.drive_folder_id, 'fld-1');
  assert.equal(settingsCall.body.drive_folder_name, 'Books');
  assert.equal(settingsCall.body.last_active_book_key, 'dune::herbert');

  sync.destroy();
});

test('SupabaseSyncService AudiobookOAuthNative passes promptValue as 6th arg for forceConsent and falls back cleanly for 5-arg bridges', async () => {
  const fakeWindow = createFakeWindow();
  fakeWindow.location.origin = 'https://localhost';
  fakeWindow.Capacitor = { isNativePlatform: () => true };

  const calls = [];
  fakeWindow.AudiobookOAuthNative = {
    consumePendingResult: () => null,
    startGoogleOAuth(clientId, scope, loginHint, state, redirectUri, prompt) {
      calls.push(Array.from(arguments));
      queueMicrotask(() => {
        fakeWindow.__onAndroidGoogleOAuthResult({
          access_token: 'ya29.consent_android_token',
          state
        });
      });
    }
  };

  const sync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: fakeWindow,
    navigatorObj: { onLine: true, userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async (url) => {
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { sub: '6677', email: 'consent@gmail.com', name: 'Consent User' };
          }
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  const consentRes = await sync.signInWithGooglePopup({ forceConsent: true });
  assert.equal(consentRes.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 6);
  assert.equal(calls[0][5], 'select_account consent');

  const defaultRes = await sync.signInWithGooglePopup();
  assert.equal(defaultRes.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][5], 'select_account');

  // Legacy 5-arg bridge throwing arity error falls back to 5-arg invocation
  const fallbackCalls = [];
  fakeWindow.AudiobookOAuthNative = {
    consumePendingResult: () => null,
    startGoogleOAuth() {
      fallbackCalls.push(Array.from(arguments));
      if (arguments.length === 6) {
        throw new Error('Wrong number of arguments for startGoogleOAuth');
      }
      const state = arguments[3];
      queueMicrotask(() => {
        fakeWindow.__onAndroidGoogleOAuthResult({
          access_token: 'ya29.legacy_5arg_token',
          state
        });
      });
    }
  };

  const legacyRes = await sync.signInWithGooglePopup({ forceConsent: true });
  assert.equal(legacyRes.ok, true);
  assert.equal(fallbackCalls.length, 2);
  assert.equal(fallbackCalls[0].length, 6);
  assert.equal(fallbackCalls[1].length, 5);
  assert.equal(sync.getGoogleAccessToken(), 'ya29.legacy_5arg_token');

  sync.destroy();
});

function createFakeIndexedDB() {
  const databases = new Map();
  const makeRequest = (executor) => {
    const req = { result: undefined, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      try {
        executor(req);
      } catch (err) {
        req.error = err;
        req.onerror?.({ target: req });
      }
    });
    return req;
  };

  return {
    open(name, version) {
      return makeRequest((req) => {
        let entry = databases.get(name);
        const isUpgrade = !entry || entry.version < version;
        if (!entry) {
          entry = { version, stores: new Map() };
          databases.set(name, entry);
        }
        const db = {
          objectStoreNames: {
            contains: (storeName) => entry.stores.has(storeName)
          },
          createObjectStore(storeName, { keyPath } = {}) {
            if (!entry.stores.has(storeName)) {
              entry.stores.set(storeName, { keyPath, rows: new Map() });
            }
          },
          transaction(storeName) {
            const storeData = entry.stores.get(storeName);
            if (!storeData) throw new Error(`Missing store ${storeName}`);
            return {
              objectStore() {
                return {
                  getAll() {
                    return makeRequest((r) => {
                      r.result = Array.from(storeData.rows.values()).map((v) => structuredClone(v));
                      r.onsuccess?.({ target: r });
                    });
                  },
                  put(val) {
                    const key = val[storeData.keyPath];
                    storeData.rows.set(key, structuredClone(val));
                  },
                  delete(key) {
                    storeData.rows.delete(key);
                  }
                };
              }
            };
          }
        };
        req.result = db;
        if (isUpgrade) {
          entry.version = version;
          req.onupgradeneeded?.({ target: req });
        }
        req.onsuccess?.({ target: req });
      });
    }
  };
}

test('SupabaseSyncService google_oauth session survives restoreSession() on 401 userinfo without logging user out and separates needsDriveConsent', async () => {
  const storage = createMemoryStorage();
  const sync = new SupabaseSyncService({
    storage,
    windowObj: null,
    navigatorObj: { onLine: true, userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async (url) => {
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return { ok: false, status: 401, async text() { return 'Invalid Credentials'; } };
      }
      if (url.includes('/auth/v1/token') || url.includes('/auth/v1/signup')) {
        return { ok: false, status: 500, async text() { return 'Bridge unavailable'; } };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  sync.setSession({
    access_token: null,
    auth_mode: 'google_oauth',
    provider_token: 'ya29.expired_after_1h',
    user: {
      id: 'google_1001',
      email: 'phone.user@gmail.com',
      user_metadata: {
        email: 'phone.user@gmail.com',
        name: 'Phone Listener',
        full_name: 'Phone Listener',
        avatar_url: 'https://lh3.googleusercontent.com/a/phone.jpg',
        picture: 'https://lh3.googleusercontent.com/a/phone.jpg'
      }
    }
  });

  const restored = await sync.restoreSession();
  assert.ok(restored, 'restoreSession must NOT return null when user profile exists');
  assert.deepEqual(sync.getUserProfile(), {
    id: 'google_1001',
    email: 'phone.user@gmail.com',
    name: 'Phone Listener',
    avatarUrl: 'https://lh3.googleusercontent.com/a/phone.jpg'
  });
  assert.equal(sync.needsDriveSyncReauth, true);
  assert.equal(sync.needsDriveConsent, false, '401 expired token must NOT force full consent screen');
  assert.equal(sync.getGoogleAccessToken(), null);

  const persisted = JSON.parse(storage.getItem('audiobook_player_supabase_session_v1'));
  assert.equal(persisted.user.email, 'phone.user@gmail.com');
  assert.equal(persisted.auth_mode, 'google_oauth');

  // 403 insufficientPermissions sets needsDriveConsent = true, and setGoogleAccessToken clears both
  sync.setGoogleAccessToken('ya29.lacking_scope');
  assert.equal(sync.needsDriveSyncReauth, false);
  assert.equal(sync.needsDriveConsent, false);

  const sync403 = new SupabaseSyncService({
    storage,
    windowObj: null,
    navigatorObj: { onLine: true },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async (url) => {
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return { ok: false, status: 403, async text() { return 'insufficientPermissions'; } };
      }
      return { ok: false, status: 500, async text() { return 'unavailable'; } };
    }
  });
  await sync403.restoreSession();
  assert.equal(sync403.needsDriveSyncReauth, true);
  assert.equal(sync403.needsDriveConsent, true);

  sync403.setGoogleAccessToken('ya29.fresh_token');
  assert.equal(sync403.needsDriveSyncReauth, false);
  assert.equal(sync403.needsDriveConsent, false);

  sync.destroy();
  sync403.destroy();
});

test('SupabaseSyncService restoreSession recovers evicted localStorage session from OfflineSyncQueue IndexedDB backup and never wipes user on /auth/v1/user 401', async () => {
  const fakeIDB = createFakeIndexedDB();
  const storage1 = createMemoryStorage();
  const queue1 = new OfflineSyncQueue({ storage: storage1, indexedDB: fakeIDB });
  await queue1.ready();

  const sync1 = new SupabaseSyncService({
    storage: storage1,
    indexedDB: fakeIDB,
    offlineQueue: queue1,
    windowObj: null,
    navigatorObj: { onLine: true },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async () => ({ ok: false, status: 500, async text() { return 'offline'; } })
  });

  sync1.setSession({
    access_token: 'expired-jwt',
    refresh_token: 'expired-refresh',
    provider_token: null,
    user: {
      id: 'supa-u-99',
      email: 'persist@gmail.com',
      user_metadata: {
        email: 'persist@gmail.com',
        full_name: 'Persist User',
        avatar_url: 'https://example.com/avatar.png'
      }
    }
  });

  // Allow microtask IDB put to settle, then simulate Android WebView clearing ALL localStorage
  await new Promise((r) => setTimeout(r, 10));
  const emptyStorage = createMemoryStorage();
  assert.equal(emptyStorage.getItem('audiobook_player_supabase_session_v1'), null);

  const queue2 = new OfflineSyncQueue({ storage: emptyStorage, indexedDB: fakeIDB });
  const sync2 = new SupabaseSyncService({
    storage: emptyStorage,
    indexedDB: fakeIDB,
    offlineQueue: queue2,
    windowObj: null,
    navigatorObj: { onLine: true },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async (url) => {
      if (url.includes('/auth/v1/user')) {
        return { ok: false, status: 401, async text() { return 'JWT expired'; } };
      }
      if (url.includes('/auth/v1/token')) {
        return { ok: false, status: 400, async text() { return 'invalid_grant'; } };
      }
      if (url.includes('/auth/v1/signup')) {
        return { ok: false, status: 500, async text() { return 'error'; } };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  const recovered = await sync2.restoreSession();
  assert.ok(recovered, 'restoreSession must recover session from IndexedDB even after localStorage eviction and 401');
  assert.equal(recovered.auth_mode, 'google_oauth');
  assert.equal(sync2.getUserProfile().email, 'persist@gmail.com');
  assert.equal(sync2.getUserProfile().name, 'Persist User');

  const rePersisted = JSON.parse(emptyStorage.getItem('audiobook_player_supabase_session_v1'));
  assert.equal(rePersisted.user.email, 'persist@gmail.com');
  assert.equal(rePersisted.access_token, null);

  // Explicit signOut clears both localStorage and IndexedDB backup
  await sync2.signOut();
  assert.equal(emptyStorage.getItem('audiobook_player_supabase_session_v1'), null);
  assert.equal(queue2.getAuthSession(), null);

  sync1.destroy();
  sync2.destroy();
});

test('Windows Tauri restoreSession runs _trySilentGoogleRefresh when bridged Supabase session is valid and googleAccessToken expired (401 userinfo)', async () => {
  const fakeWindow = createFakeWindow();
  fakeWindow.location.origin = 'https://tauri.localhost';
  let oauthMode = 'success';
  const invokeCalls = [];
  fakeWindow.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      invokeCalls.push({ cmd, args });
      if (cmd === 'desktop_start_google_oauth') {
        if (oauthMode === 'success') {
          return { status: 'success', accessToken: 'ya29.tauri_silent_fresh' };
        }
        return { status: 'needs_interactive', accessToken: null };
      }
      return null;
    }
  };

  const storage = createMemoryStorage();
  const sync = new SupabaseSyncService({
    storage,
    windowObj: fakeWindow,
    navigatorObj: { onLine: true, userAgent: 'Windows NT 10.0' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async (url, init = {}) => {
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        const auth = init.headers?.Authorization || '';
        if (auth === 'Bearer ya29.tauri_silent_fresh') {
          return {
            ok: true,
            status: 200,
            async json() {
              return { sub: 'win-1', email: 'win.user@gmail.com', name: 'Win User' };
            }
          };
        }
        return { ok: false, status: 401, async text() { return 'Invalid Credentials'; } };
      }
      if (url.endsWith('/auth/v1/user')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              id: 'supa-win-1',
              email: 'win.user@gmail.com',
              user_metadata: { full_name: 'Win User' }
            };
          }
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  });

  // Case 1: Bridged Supabase session (/auth/v1/user 200) + expired ya29 -> silently refreshes on Tauri
  sync.setSession({
    access_token: 'valid-supa-jwt',
    refresh_token: 'valid-supa-refresh',
    auth_mode: 'google_oauth',
    provider_token: 'ya29.expired_1h',
    user: {
      id: 'supa-win-1',
      email: 'win.user@gmail.com',
      user_metadata: { full_name: 'Win User' }
    }
  });

  const restored = await sync.restoreSession();
  assert.ok(restored);
  assert.equal(sync.isAuthenticated(), true);
  assert.equal(sync.getGoogleAccessToken(), 'ya29.tauri_silent_fresh');
  assert.equal(sync.needsDriveSyncReauth, false);
  assert.equal(sync.needsDriveConsent, false);
  const startCalls = invokeCalls.filter((c) => c.cmd === 'desktop_start_google_oauth');
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0].args.silent, true);

  // Case 2: When silent refresh returns needs_interactive while Supabase session is valid, keep user signed in and keep needsDriveSyncReauth = false, needsDriveConsent = false
  oauthMode = 'needs_interactive';
  sync.setSession({
    ...sync.session,
    provider_token: 'ya29.expired_again',
    googleAccessToken: 'ya29.expired_again'
  });

  const restoredNeedsInteractive = await sync.restoreSession();
  assert.ok(restoredNeedsInteractive);
  assert.equal(sync.isAuthenticated(), true);
  assert.equal(sync.getGoogleAccessToken(), null);
  assert.equal(sync.needsDriveSyncReauth, false);
  assert.equal(sync.needsDriveConsent, false);

  sync.destroy();
});

test('Windows Tauri native auth session persistence recovers across wiped localStorage + IndexedDB and clears on signOut', async () => {
  let nativeDiskSession = null;
  const invokeLog = [];

  const makeTauriWindow = () => {
    const win = createFakeWindow();
    win.location.origin = 'https://tauri.localhost';
    win.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        invokeLog.push({ cmd, args });
        if (cmd === 'desktop_save_auth_session') {
          nativeDiskSession = args?.sessionJson || null;
          return true;
        }
        if (cmd === 'desktop_load_auth_session') {
          return nativeDiskSession;
        }
        if (cmd === 'desktop_clear_auth_session') {
          nativeDiskSession = null;
          return true;
        }
        if (cmd === 'desktop_clear_google_oauth') {
          return true;
        }
        return null;
      }
    };
    return win;
  };

  // Session saved on Run 1 writes to localStorage, IDB, AND native disk backup
  const sync1 = new SupabaseSyncService({
    storage: createMemoryStorage(),
    indexedDB: createFakeIndexedDB(),
    windowObj: makeTauriWindow(),
    navigatorObj: { onLine: true, userAgent: 'Windows NT 10.0' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async () => {
      throw new Error('hydratePersistedSession must perform ZERO network calls');
    }
  });

  sync1.setSession({
    access_token: 'supa-jwt-win',
    refresh_token: 'supa-ref-win',
    provider_token: 'ya29.win_native_backup',
    auth_mode: 'google_oauth',
    user: {
      id: 'supa-win-99',
      email: 'desktop.backup@gmail.com',
      user_metadata: { full_name: 'Desktop Listener' }
    }
  });
  assert.ok(nativeDiskSession, 'desktop_save_auth_session should store serialized session');
  assert.equal(JSON.parse(nativeDiskSession).user.email, 'desktop.backup@gmail.com');

  // Run 2: BOTH localStorage AND IndexedDB are completely wiped (simulating WebView2 profile fallback)
  const freshStorage = createMemoryStorage();
  const freshIDB = createFakeIndexedDB();
  const sync2 = new SupabaseSyncService({
    storage: freshStorage,
    indexedDB: freshIDB,
    windowObj: makeTauriWindow(),
    navigatorObj: { onLine: true, userAgent: 'Windows NT 10.0' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async () => {
      throw new Error('hydratePersistedSession must perform ZERO network calls');
    }
  });

  assert.equal(sync2.getUserProfile(), null);
  const hydrated = await sync2.hydratePersistedSession();
  assert.ok(hydrated, 'hydratePersistedSession must recover session from desktop_load_auth_session');
  assert.equal(sync2.getUserProfile().email, 'desktop.backup@gmail.com');
  assert.equal(sync2.getGoogleAccessToken(), 'ya29.win_native_backup');

  // Re-persisted into localStorage and OfflineSyncQueue
  const rePersisted = JSON.parse(freshStorage.getItem('audiobook_player_supabase_session_v1'));
  assert.equal(rePersisted.user.email, 'desktop.backup@gmail.com');
  assert.equal(sync2.offlineQueue.getAuthSession()?.user?.email, 'desktop.backup@gmail.com');

  // Explicit signOut clears native disk backup + OAuth cache + localStorage + IDB
  sync2.fetchImpl = async () => ({ ok: true, status: 204, async text() { return ''; } });
  await sync2.signOut();
  assert.equal(nativeDiskSession, null);
  assert.equal(freshStorage.getItem('audiobook_player_supabase_session_v1'), null);
  assert.equal(sync2.offlineQueue.getAuthSession(), null);
  assert.ok(invokeLog.some((c) => c.cmd === 'desktop_clear_auth_session'));
  assert.ok(invokeLog.some((c) => c.cmd === 'desktop_clear_google_oauth'));

  sync1.destroy();
  sync2.destroy();
});

test('Android Capacitor native AudiobookOAuthNative auth session persists across wiped localStorage + IDB and stays compatible with legacy APK', async () => {
  let androidPrefsSession = null;
  let clearCalls = 0;

  const makeAndroidWindow = (withSessionMethods = true) => {
    const win = createFakeWindow();
    win.location.origin = 'https://localhost';
    win.location.protocol = 'https:';
    win.Capacitor = { isNativePlatform: () => true };
    win.AudiobookOAuthNative = withSessionMethods
      ? {
          saveAuthSession(json) {
            androidPrefsSession = json;
            return true;
          },
          loadAuthSession() {
            return androidPrefsSession;
          },
          clearAuthSession() {
            clearCalls += 1;
            androidPrefsSession = null;
            return true;
          }
        }
      : {
          // Legacy APK without session persistence methods
          consumePendingResult: () => null
        };
    return win;
  };

  const sync1 = new SupabaseSyncService({
    storage: createMemoryStorage(),
    indexedDB: createFakeIndexedDB(),
    windowObj: makeAndroidWindow(true),
    navigatorObj: { onLine: true, userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null
  });

  sync1.setSession({
    access_token: 'supa-android-jwt',
    provider_token: 'ya29.android_backup_tok',
    auth_mode: 'google_oauth',
    user: {
      id: 'supa-android-1',
      email: 'mobile.backup@gmail.com',
      user_metadata: { full_name: 'Mobile Listener' }
    }
  });
  assert.ok(androidPrefsSession);
  assert.equal(JSON.parse(androidPrefsSession).user.email, 'mobile.backup@gmail.com');

  // Run 2: localStorage and IDB are wiped; synchronous constructor + hydratePersistedSession recover from SharedPreferences
  const wipedStorage = createMemoryStorage();
  const sync2 = new SupabaseSyncService({
    storage: wipedStorage,
    indexedDB: createFakeIndexedDB(),
    windowObj: makeAndroidWindow(true),
    navigatorObj: { onLine: true, userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async () => {
      throw new Error('hydratePersistedSession must perform ZERO network calls');
    }
  });

  // Constructor eagerly loads from synchronous AudiobookOAuthNative.loadAuthSession()
  assert.equal(sync2.getUserProfile()?.email, 'mobile.backup@gmail.com');

  const hydrated = await sync2.hydratePersistedSession();
  assert.ok(hydrated);
  assert.equal(sync2.getGoogleAccessToken(), 'ya29.android_backup_tok');
  assert.equal(
    JSON.parse(wipedStorage.getItem('audiobook_player_supabase_session_v1')).user.email,
    'mobile.backup@gmail.com'
  );

  // Explicit signOut clears SharedPreferences backup
  sync2.fetchImpl = async () => ({ ok: true, status: 204, async text() { return ''; } });
  await sync2.signOut();
  assert.equal(clearCalls, 1);
  assert.equal(androidPrefsSession, null);

  // Legacy APK without saveAuthSession/loadAuthSession/clearAuthSession works cleanly with zero throws
  const legacySync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    indexedDB: createFakeIndexedDB(),
    windowObj: makeAndroidWindow(false),
    navigatorObj: { onLine: true, userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async () => ({ ok: true, status: 204, async text() { return ''; } })
  });
  legacySync.setSession({
    access_token: 'legacy-jwt',
    user: { id: 'legacy-1', email: 'legacy@gmail.com' }
  });
  const legacyHydrated = await legacySync.hydratePersistedSession();
  assert.equal(legacyHydrated?.user?.email, 'legacy@gmail.com');
  await legacySync.signOut();
  assert.equal(legacySync.getUserProfile(), null);

  sync1.destroy();
  sync2.destroy();
  legacySync.destroy();
});

test('Tauri desktop_poll_google_oauth attemptId + superseded, proactive ensureFreshGoogleToken (45m+), and onGoogleTokenChange', async () => {
  const fakeWindow = createFakeWindow();
  fakeWindow.location.origin = 'https://tauri.localhost';
  const invokeCalls = [];
  let nextMode = 'superseded';

  fakeWindow.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      invokeCalls.push({ cmd, args });
      if (cmd === 'desktop_start_google_oauth') {
        if (nextMode === 'superseded') {
          return { status: 'pending', accessToken: null, attemptId: 42 };
        }
        return { status: 'success', accessToken: 'ya29.proactive_fresh_token', attemptId: 43 };
      }
      if (cmd === 'desktop_poll_google_oauth') {
        return { status: 'superseded', accessToken: null, attemptId: 43 };
      }
      return true;
    }
  };

  const sync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: fakeWindow,
    navigatorObj: { onLine: true, userAgent: 'Windows NT 10.0' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async (url) => {
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { sub: 'sub-9', email: 'proactive@gmail.com', name: 'Proactive User' };
          }
        };
      }
      return { ok: false, status: 500, async text() { return 'skip'; } };
    }
  });

  // 1. desktop_poll_google_oauth passes attemptId and handles status === 'superseded'
  const supersededRes = await sync.signInWithGooglePopup({ silent: true, autoInteractiveOnSilentFail: false });
  assert.equal(supersededRes.ok, false);
  assert.equal(supersededRes.reason, 'superseded');
  const pollCall = invokeCalls.find((c) => c.cmd === 'desktop_poll_google_oauth');
  assert.deepEqual(pollCall?.args, { attemptId: 42 });

  // 2. onGoogleTokenChange fires on token updates and unsubscribes cleanly
  const observedTokens = [];
  const unsub = sync.onGoogleTokenChange((tok) => observedTokens.push(tok));

  // 3. Proactive ensureFreshGoogleToken skips refresh when token is fresh (<45m), refreshes when >=45m old
  nextMode = 'fresh';
  sync.setSession({
    access_token: 'supa-jwt-pro',
    auth_mode: 'google_oauth',
    provider_token: 'ya29.recent_token',
    googleAccessToken: 'ya29.recent_token',
    googleTokenObtainedAt: Date.now() - 10 * 60 * 1000,
    user: { id: 'supa-pro', email: 'proactive@gmail.com' }
  });

  const startsBefore = invokeCalls.filter((c) => c.cmd === 'desktop_start_google_oauth').length;
  const freshOk = await sync.ensureFreshGoogleToken();
  assert.equal(freshOk, true);
  assert.equal(
    invokeCalls.filter((c) => c.cmd === 'desktop_start_google_oauth').length,
    startsBefore,
    'fresh token (<45m) must NOT trigger silent refresh'
  );

  // Age token past 45 minutes -> ensureFreshGoogleToken proactively refreshes & notifies listener
  sync.setSession({
    ...sync.session,
    googleTokenObtainedAt: Date.now() - 50 * 60 * 1000
  });
  const refreshedOk = await sync.ensureFreshGoogleToken();
  assert.equal(refreshedOk, true);
  assert.equal(sync.getGoogleAccessToken(), 'ya29.proactive_fresh_token');
  assert.ok(Number(sync.session.googleTokenObtainedAt) > Date.now() - 5000);
  assert.deepEqual(observedTokens, ['ya29.proactive_fresh_token']);

  // Unsubscribe stops further notifications
  unsub();
  sync.setGoogleAccessToken('ya29.after_unsub');
  assert.deepEqual(observedTokens, ['ya29.proactive_fresh_token']);

  sync.destroy();
});

test('AudioEngine retries Google Drive stream fetch once on 401 via onDriveTokenExpired', async () => {
  const seenAuthHeaders = [];
  let refreshCalls = 0;

  const mockFetch = async (url, init = {}) => {
    const auth = init?.headers?.Authorization || '';
    seenAuthHeaders.push({ url, auth });
    if (auth === 'Bearer ya29.expired_stream_tok') {
      return { ok: false, status: 401 };
    }
    if (auth === 'Bearer ya29.refreshed_stream_tok') {
      return {
        ok: true,
        status: 200,
        async blob() {
          return new Blob(['fake-audio-bytes'], { type: 'audio/mpeg' });
        }
      };
    }
    return { ok: false, status: 403 };
  };

  const engine = new AudioEngine({
    fetchImpl: mockFetch,
    onDriveTokenExpired: async () => {
      refreshCalls += 1;
      return 'ya29.refreshed_stream_tok';
    }
  });
  engine.setDriveAccessToken('ya29.expired_stream_tok');

  const book = {
    bookKey: 'drive-book::author',
    title: 'Drive Book',
    driveStreamUrl: 'https://www.googleapis.com/drive/v3/files/file-123?alt=media',
    chapters: [{ index: 0, title: 'Ch 1', startSec: 0, driveStreamUrl: 'https://www.googleapis.com/drive/v3/files/file-123?alt=media' }]
  };

  const resolvedUrl = await engine._resolveChapterMediaUrl(book, 0);
  assert.ok(resolvedUrl && resolvedUrl.startsWith('blob:'), 'expected blob URL after 401 token refresh retry');
  assert.equal(refreshCalls, 1);
  assert.equal(engine.driveAccessToken, 'ya29.refreshed_stream_tok');
  assert.deepEqual(
    seenAuthHeaders.map((h) => h.auth),
    ['Bearer ya29.expired_stream_tok', 'Bearer ya29.refreshed_stream_tok']
  );

  // If refresh returns null or the same expired token on 401, returns null cleanly without duplicate fetch
  let sameTokenFetches = 0;
  const engineFail = new AudioEngine({
    fetchImpl: async () => {
      sameTokenFetches += 1;
      return { ok: false, status: 401 };
    },
    onDriveTokenExpired: async () => 'ya29.dead_tok'
  });
  engineFail.setDriveAccessToken('ya29.dead_tok');
  const failedUrl = await engineFail._resolveChapterMediaUrl(book, 0);
  assert.equal(failedUrl, null);
  assert.equal(sameTokenFetches, 1, 'must NOT issue a duplicate 401 fetch with the same expired token');

  engine.destroy();
  engineFail.destroy();
});

test('Android persistent hardware deviceId, native/UA model name detection, and 6-row Android device deduplication + cloud pruning', async () => {
  // 1. Native bridge getDeviceId() & getDeviceName()
  const nativeWin = createFakeWindow();
  nativeWin.AudiobookOAuthNative = {
    getDeviceId: () => 'a1b2c3d4e5f6',
    getDeviceName: () => 'Samsung SM-S918B'
  };
  const nativeStorage = createMemoryStorage();
  const androidNativeSync = new SupabaseSyncService({
    storage: nativeStorage,
    windowObj: nativeWin,
    navigatorObj: { onLine: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv)' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null
  });
  assert.equal(androidNativeSync.deviceId, 'dev_android_a1b2c3d4e5f6');
  assert.equal(androidNativeSync.deviceName, 'Samsung SM-S918B');
  assert.equal(nativeStorage.getItem('audiobook_player_device_id_v1'), 'dev_android_a1b2c3d4e5f6');
  androidNativeSync.destroy();

  // 2. UA model name parsing when native bridge is unavailable
  assert.equal(
    detectDeviceName({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro Build/UQ1A.240205.004) AppleWebKit/537.36' }),
    'Android (Pixel 8 Pro)'
  );
  assert.equal(
    detectDeviceName({ userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36' }),
    'Android Phone'
  );

  // 3. deduplicateDevicesList collapses 6 generic Android Device rows into 1 while keeping distinct Android models
  const sixGenericAndPc = [
    { deviceId: 'win-1', deviceName: 'Windows PC', platform: 'windows', lastSeenAt: '2026-11-22T01:00:00Z' },
    { deviceId: 'dev_old_1', deviceName: 'Android Device', platform: 'android', lastSeenAt: '2026-11-10T01:00:00Z' },
    { deviceId: 'dev_old_2', deviceName: 'Android Device', platform: 'android', lastSeenAt: '2026-11-11T01:00:00Z' },
    { deviceId: 'dev_old_3', deviceName: 'Android Device', platform: 'android', lastSeenAt: '2026-11-12T01:00:00Z' },
    { deviceId: 'dev_old_4', deviceName: 'Android Device', platform: 'android', lastSeenAt: '2026-11-13T01:00:00Z' },
    { deviceId: 'dev_old_5', deviceName: 'Android Device', platform: 'android', lastSeenAt: '2026-11-14T01:00:00Z' },
    { deviceId: 'dev_old_6', deviceName: 'Android Device', platform: 'android', lastSeenAt: '2026-11-15T01:00:00Z' }
  ];
  const collapsedFromPc = deduplicateDevicesList(sixGenericAndPc, 'win-1');
  assert.equal(collapsedFromPc.length, 2);
  assert.equal(collapsedFromPc.find((d) => d.platform === 'android')?.deviceId, 'dev_old_6');

  // When upgraded phone registers with real model name, all 6 legacy generic rows collapse into it
  const withNamedPhone = [
    ...sixGenericAndPc,
    { deviceId: 'dev_android_a1b2c3d4e5f6', deviceName: 'Samsung SM-S918B', platform: 'android', lastSeenAt: '2026-11-22T00:30:00Z' }
  ];
  const collapsedNamed = deduplicateDevicesList(withNamedPhone, 'dev_android_a1b2c3d4e5f6');
  assert.equal(collapsedNamed.length, 2);
  assert.equal(collapsedNamed.find((d) => d.platform === 'android')?.deviceId, 'dev_android_a1b2c3d4e5f6');
  assert.equal(collapsedNamed.find((d) => d.platform === 'android')?.deviceName, 'Samsung SM-S918B');

  // Two genuinely distinct Android phones must both be preserved
  const twoDistinctPhones = deduplicateDevicesList(
    [
      { deviceId: 'dev_android_1', deviceName: 'Google Pixel 8', platform: 'android', lastSeenAt: '2026-11-22T01:00:00Z' },
      { deviceId: 'dev_android_2', deviceName: 'Samsung SM-S918B', platform: 'android', lastSeenAt: '2026-11-22T00:50:00Z' },
      { deviceId: 'dev_legacy_1', deviceName: 'Android Device', platform: 'android', lastSeenAt: '2026-11-10T00:00:00Z' }
    ],
    'win-1'
  );
  assert.equal(twoDistinctPhones.length, 2);
  assert.deepEqual(
    twoDistinctPhones.map((d) => d.deviceName).sort(),
    ['Google Pixel 8', 'Samsung SM-S918B']
  );

  // 4. fetchDevices() actively prunes stale duplicate Android rows from Supabase audiobook_devices
  const supaRows = [
    { device_id: 'win-1', device_name: 'Windows PC', platform: 'windows', last_seen_at: '2026-11-22T01:00:00Z' },
    { device_id: 'dev_android_real', device_name: 'Samsung SM-S918B', platform: 'android', last_seen_at: '2026-11-22T00:40:00Z' },
    { device_id: 'dev_old_1', device_name: 'Android Device', platform: 'android', last_seen_at: '2026-11-10T01:00:00Z' },
    { device_id: 'dev_old_2', device_name: 'Android Device', platform: 'android', last_seen_at: '2026-11-11T01:00:00Z' }
  ];
  const deleteUrls = [];
  const pruneSync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: null,
    navigatorObj: { onLine: true, userAgent: 'Windows NT 10.0' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    deviceId: 'win-1',
    deviceName: 'Windows PC',
    fetchImpl: async (url, init = {}) => {
      if (init.method === 'DELETE') {
        deleteUrls.push(url);
        return { ok: true, status: 204, async text() { return ''; } };
      }
      if (url.includes('audiobook_devices?select=*')) {
        return { ok: true, status: 200, async text() { return JSON.stringify(supaRows); } };
      }
      return { ok: true, status: 200, async text() { return '[]'; } };
    }
  });
  pruneSync.setSession({
    access_token: 'supa-jwt-prune',
    user: { id: 'user-prune-1', email: 'prune@gmail.com' }
  });

  const mergedDevices = await pruneSync.fetchDevices();
  assert.equal(mergedDevices.length, 2);
  assert.equal(deleteUrls.length, 1);
  assert.match(deleteUrls[0], /audiobook_devices\?user_id=eq\.user-prune-1/);
  assert.match(deleteUrls[0], /dev_old_1/);
  assert.match(deleteUrls[0], /dev_old_2/);
  pruneSync.destroy();
});

test('Podcast totalListeningSec and progressResetAt survive sync, feed refresh, and deduplication without resurrecting reset progress', async () => {
  const tBeforeReset = '2026-11-20T10:00:00.000Z';
  const resetMs = Date.parse('2026-11-21T12:00:00.000Z');
  const tAfterReset = '2026-11-22T08:00:00.000Z';

  // 1. mergeEpisodeProgressMaps filters out pre-reset entries and keeps post-reset entries
  const mergedEpMap = mergeEpisodeProgressMaps(
    {
      'ep-1': { positionSec: 900, durationSec: 1800, completed: false, updatedAt: tBeforeReset },
      'ep-2': { positionSec: 1800, durationSec: 1800, completed: true, updatedAt: new Date(resetMs).toISOString() }
    },
    {
      'ep-3': { positionSec: 120, durationSec: 1800, completed: false, updatedAt: tAfterReset }
    },
    resetMs
  );
  assert.equal(mergedEpMap['ep-1'], undefined, 'pre-reset episodeProgress must be filtered out');
  assert.equal(mergedEpMap['ep-2'], undefined, 'episodeProgress at exact reset timestamp must be filtered out');
  assert.equal(mergedEpMap['ep-3']?.positionSec, 120, 'post-reset episodeProgress must be preserved');

  // 2. mergeCloudBook preserves totalListeningSec via Math.max and never resurrects pre-reset progress
  const oldCloud = normalizeCloudBook({
    bookKey: 'podcast:abc123',
    title: 'Tech Show',
    isPodcast: true,
    mediaType: 'podcast',
    feedUrl: 'https://example.com/feed.xml',
    chapterIndex: 12,
    positionSec: 1450,
    completed: false,
    lastPlayedAt: tBeforeReset,
    totalListeningSec: 7200,
    episodeProgress: {
      'ep-12': { positionSec: 1450, durationSec: 2000, completed: false, updatedAt: tBeforeReset }
    },
    updatedAt: tBeforeReset
  });
  const resetLocal = normalizeCloudBook({
    bookKey: 'podcast:abc123',
    title: 'Tech Show',
    isPodcast: true,
    mediaType: 'podcast',
    feedUrl: 'https://example.com/feed.xml',
    chapterIndex: 0,
    positionSec: 0,
    completed: false,
    progressResetAt: resetMs,
    totalListeningSec: 9400,
    episodeProgress: {},
    updatedAt: new Date(resetMs).toISOString()
  });

  const mergedReset = mergeCloudBook(oldCloud, resetLocal);
  assert.equal(mergedReset.totalListeningSec, 9400);
  assert.equal(mergedReset.progressResetAt, resetMs);
  assert.equal(mergedReset.chapterIndex, 0);
  assert.equal(mergedReset.positionSec, 0);
  assert.equal(mergedReset.completed, false);
  assert.deepEqual(mergedReset.episodeProgress, {});

  // Even if stale cloud payload arrives AFTER reset with a later metadata updatedAt, progressResetAt still wins
  const staleMetaLater = normalizeCloudBook({
    ...oldCloud,
    totalListeningSec: 10800,
    updatedAt: tAfterReset
  });
  const mergedWithStaleLater = mergeCloudBook(resetLocal, staleMetaLater);
  assert.equal(mergedWithStaleLater.totalListeningSec, 10800, 'totalListeningSec must take Math.max');
  assert.equal(mergedWithStaleLater.progressResetAt, resetMs);
  assert.equal(mergedWithStaleLater.chapterIndex, 0);
  assert.equal(mergedWithStaleLater.positionSec, 0);
  assert.equal(mergedWithStaleLater.completed, false);
  assert.deepEqual(mergedWithStaleLater.episodeProgress, {});

  // 3. createPodcastBookItem preserves totalListeningSec & progressResetAt on RSS refresh
  const refreshed = createPodcastBookItem(
    {
      feedUrl: 'https://example.com/feed.xml',
      title: 'Tech Show',
      episodes: [
        { episodeId: 'ep-new', title: 'Episode New', audioUrl: 'https://example.com/new.mp3', durationSec: 1800 },
        { episodeId: 'ep-12', title: 'Episode 12', audioUrl: 'https://example.com/12.mp3', durationSec: 2000 }
      ]
    },
    {
      bookKey: 'podcast:abc123',
      title: 'Tech Show',
      chapterIndex: 1,
      positionSec: 500,
      lastPlayedAt: tBeforeReset,
      progressResetAt: resetMs,
      totalListeningSec: 9400,
      episodeProgress: {
        'ep-12': { positionSec: 500, durationSec: 2000, completed: false, updatedAt: tBeforeReset }
      },
      chapters: [{ index: 0, episodeId: 'ep-12', title: 'Episode 12', audioUrl: 'https://example.com/12.mp3', durationSec: 2000 }]
    }
  );
  assert.equal(refreshed.totalListeningSec, 9400);
  assert.equal(refreshed.progressResetAt, resetMs);
  assert.equal(refreshed.chapterIndex, 0);
  assert.equal(refreshed.positionSec, 0);
  assert.deepEqual(refreshed.episodeProgress, {});

  // 4. deduplicateLibraryItems preserves totalListeningSec & progressResetAt via Math.max
  const dedupedLib = deduplicateLibraryItems([oldCloud, resetLocal]);
  assert.equal(dedupedLib.length, 1);
  assert.equal(dedupedLib[0].totalListeningSec, 9400);
  assert.equal(dedupedLib[0].progressResetAt, resetMs);
  assert.equal(dedupedLib[0].chapterIndex, 0);
  assert.equal(dedupedLib[0].positionSec, 0);
  assert.equal(dedupedLib[0].completed, false);
  assert.deepEqual(dedupedLib[0].episodeProgress, {});

  // 5. syncLibraryItems persists totalListeningSec and progressResetAt into Supabase metadata_json
  const sentBodies = [];
  const syncSvc = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: null,
    navigatorObj: { onLine: true, userAgent: 'Windows NT 10.0' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: async (_url, init = {}) => {
      sentBodies.push(init.body ? JSON.parse(init.body) : null);
      return { ok: true, status: 200, async text() { return '[]'; } };
    }
  });
  syncSvc.setSession({
    access_token: 'supa-jwt-pod',
    user: { id: 'user-pod-1', email: 'pod@gmail.com' }
  });
  await syncSvc.syncLibraryItems([resetLocal]);
  assert.equal(sentBodies[0][0].metadata_json.totalListeningSec, 9400);
  assert.equal(sentBodies[0][0].metadata_json.progressResetAt, resetMs);
  assert.deepEqual(sentBodies[0][0].metadata_json.episodeProgress, {});
  syncSvc.destroy();

  // 6. Post-reset playback (both with lastPlayedAt > progressResetAt AND with missing lastPlayedAt + post-reset episodeProgress.updatedAt)
  // must NEVER be wiped back to chapter 0 / 0s across normalizeCloudBook, mergeCloudBook, createPodcastBookItem, and deduplicateLibraryItems
  const postResetNoLastPlayed = {
    bookKey: 'podcast:abc123',
    title: 'Tech Show',
    isPodcast: true,
    mediaType: 'podcast',
    feedUrl: 'https://example.com/feed.xml',
    chapterIndex: 4,
    positionSec: 300,
    completed: false,
    progressResetAt: resetMs,
    totalListeningSec: 9700,
    episodeProgress: {
      'ep-4': { positionSec: 300, durationSec: 1800, completed: false, updatedAt: tAfterReset }
    },
    chapters: [
      { index: 0, episodeId: 'ep-0', title: 'Ep 0', audioUrl: 'https://example.com/0.mp3', durationSec: 1800 },
      { index: 1, episodeId: 'ep-1', title: 'Ep 1', audioUrl: 'https://example.com/1.mp3', durationSec: 1800 },
      { index: 2, episodeId: 'ep-2', title: 'Ep 2', audioUrl: 'https://example.com/2.mp3', durationSec: 1800 },
      { index: 3, episodeId: 'ep-3', title: 'Ep 3', audioUrl: 'https://example.com/3.mp3', durationSec: 1800 },
      { index: 4, episodeId: 'ep-4', title: 'Ep 4', audioUrl: 'https://example.com/4.mp3', durationSec: 1800 }
    ],
    updatedAt: tAfterReset
  };

  const normPostNoLast = normalizeCloudBook(postResetNoLastPlayed);
  assert.equal(normPostNoLast.chapterIndex, 4);
  assert.equal(normPostNoLast.positionSec, 300);
  assert.equal(normPostNoLast.episodeProgress['ep-4']?.positionSec, 300);

  const mergedPostNoLast = mergeCloudBook(oldCloud, normPostNoLast);
  assert.equal(mergedPostNoLast.chapterIndex, 4);
  assert.equal(mergedPostNoLast.positionSec, 300);
  assert.equal(mergedPostNoLast.episodeProgress['ep-12'], undefined);
  assert.equal(mergedPostNoLast.episodeProgress['ep-4']?.positionSec, 300);
  assert.equal(mergedPostNoLast.totalListeningSec, 9700);

  const refreshedPostNoLast = createPodcastBookItem(
    {
      feedUrl: 'https://example.com/feed.xml',
      title: 'Tech Show',
      episodes: [
        { episodeId: 'ep-new', title: 'Ep New', audioUrl: 'https://example.com/new.mp3', durationSec: 1800 },
        ...postResetNoLastPlayed.chapters
      ]
    },
    postResetNoLastPlayed
  );
  assert.equal(refreshedPostNoLast.chapterIndex, 5, 'active ep-4 shifts from index 4 to 5 when 1 new episode prepends');
  assert.equal(refreshedPostNoLast.positionSec, 300);
  assert.equal(refreshedPostNoLast.totalListeningSec, 9700);

  const dedupedPostNoLast = deduplicateLibraryItems([oldCloud, postResetNoLastPlayed]);
  assert.equal(dedupedPostNoLast.length, 1);
  assert.equal(dedupedPostNoLast[0].chapterIndex, 4);
  assert.equal(dedupedPostNoLast[0].positionSec, 300);
  assert.equal(dedupedPostNoLast[0].episodeProgress['ep-4']?.positionSec, 300);
  assert.equal(dedupedPostNoLast[0].episodeProgress['ep-12'], undefined);

  // Also verify with explicit lastPlayedAt > progressResetAt
  const postResetWithLastPlayed = {
    ...postResetNoLastPlayed,
    lastPlayedAt: tAfterReset,
    chapterIndex: 2,
    positionSec: 450,
    episodeProgress: {}
  };
  const normPostWithLast = normalizeCloudBook(postResetWithLastPlayed);
  assert.equal(normPostWithLast.chapterIndex, 2);
  assert.equal(normPostWithLast.positionSec, 450);

  const mergedPostWithLast = mergeCloudBook(oldCloud, normPostWithLast);
  assert.equal(mergedPostWithLast.chapterIndex, 2);
  assert.equal(mergedPostWithLast.positionSec, 450);

  const dedupedPostWithLast = deduplicateLibraryItems([oldCloud, postResetWithLastPlayed]);
  assert.equal(dedupedPostWithLast[0].chapterIndex, 2);
  assert.equal(dedupedPostWithLast[0].positionSec, 450);
});
