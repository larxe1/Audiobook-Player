import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OfflineSyncQueue,
  resolveProgressConflict
} from '../src/services/offline-queue.js';
import {
  SUPABASE_CONFIG,
  SupabaseSyncService,
  handleRemoteEvent
} from '../src/services/supabase-sync.js';

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
    dispatchEvent(type) {
      for (const fn of listeners.get(type) || []) {
        fn({ type });
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
