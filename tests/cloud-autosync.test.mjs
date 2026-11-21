import test from 'node:test';
import assert from 'node:assert/strict';

import { SupabaseSyncService } from '../src/services/supabase-sync.js';

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear()
  };
}

function createSharedCloudMock({
  initialUsers = {},
  initialLibrary = [],
  initialProgress = [],
  initialDevices = [],
  initialSettings = []
} = {}) {
  const supaUsers = new Map(Object.entries(initialUsers)); // email -> { id, password, user_metadata }
  const tokens = new Map(); // access_token -> email
  const tables = {
    audiobook_library_items: [...initialLibrary],
    audiobook_progress: [...initialProgress],
    audiobook_devices: [...initialDevices],
    audiobook_user_settings: [...initialSettings]
  };
  const driveCloud = {
    fileId: null,
    modifiedTime: null,
    payload: null,
    writes: 0
  };
  let seq = 1;

  const makeAuthResponse = (email, rec) => {
    const token = `supa-jwt-${rec.id}-${seq++}`;
    const refresh = `supa-ref-${rec.id}-${seq++}`;
    tokens.set(token, email);
    return {
      access_token: token,
      refresh_token: refresh,
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user: {
        id: rec.id,
        email,
        user_metadata: rec.user_metadata || {}
      }
    };
  };

  return {
    supaUsers,
    tables,
    driveCloud,
    createFetch({ driveStatus = 200, supaRestStatus = 200, failFirstRest401 = false } = {}) {
      let rest401Fired = false;
      return async (url, init = {}) => {
        const method = String(init.method || 'GET').toUpperCase();
        const body = init.body && typeof init.body === 'string' && !init.body.startsWith('--')
          ? (() => { try { return JSON.parse(init.body); } catch { return null; } })()
          : null;

        if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                sub: 'google-sub-99',
                email: 'Reader.One@Gmail.com',
                name: 'Reader One',
                picture: 'https://lh3.googleusercontent.com/a/avatar.png'
              };
            }
          };
        }

        if (url.includes('/auth/v1/token?grant_type=password')) {
          const email = String(body?.email || '').trim().toLowerCase();
          const rec = supaUsers.get(email);
          if (!rec || rec.password !== body?.password) {
            return {
              ok: false,
              status: 400,
              async text() {
                return JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials' });
              }
            };
          }
          const payload = makeAuthResponse(email, rec);
          return {
            ok: true,
            status: 200,
            async text() { return JSON.stringify(payload); },
            async json() { return payload; }
          };
        }

        if (url.includes('/auth/v1/token?grant_type=refresh_token')) {
          const firstEntry = Array.from(supaUsers.entries())[0];
          if (!firstEntry) {
            return { ok: false, status: 400, async text() { return '{}'; } };
          }
          const [email, rec] = firstEntry;
          const payload = makeAuthResponse(email, rec);
          return {
            ok: true,
            status: 200,
            async text() { return JSON.stringify(payload); },
            async json() { return payload; }
          };
        }

        if (url.includes('/auth/v1/signup')) {
          const email = String(body?.email || '').trim().toLowerCase();
          if (supaUsers.has(email)) {
            return {
              ok: false,
              status: 422,
              async text() {
                return JSON.stringify({ message: 'User already registered', error: 'user_already_exists' });
              }
            };
          }
          const rec = {
            id: `supa-uuid-${seq++}`,
            password: body?.password,
            user_metadata: body?.data || {}
          };
          supaUsers.set(email, rec);
          const payload = makeAuthResponse(email, rec);
          return {
            ok: true,
            status: 200,
            async text() { return JSON.stringify(payload); },
            async json() { return payload; }
          };
        }

        if (url.includes('/auth/v1/user')) {
          const auth = String(init.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
          const email = tokens.get(auth);
          if (!email || !supaUsers.has(email)) {
            return { ok: false, status: 401, async text() { return '{"message":"JWT expired"}'; } };
          }
          const rec = supaUsers.get(email);
          return {
            ok: true,
            status: 200,
            async json() {
              return { id: rec.id, email, user_metadata: rec.user_metadata || {} };
            }
          };
        }

        if (url.includes('/rest/v1/')) {
          if (failFirstRest401 && !rest401Fired) {
            rest401Fired = true;
            return {
              ok: false,
              status: 401,
              async text() { return 'JWT expired'; }
            };
          }
          if (supaRestStatus >= 400) {
            return {
              ok: false,
              status: supaRestStatus,
              async text() { return `Forced Supabase error ${supaRestStatus}`; }
            };
          }
          const tableMatch = url.match(/\/rest\/v1\/([^?]+)/);
          const table = tableMatch?.[1];
          if (!table || !tables[table]) {
            return { ok: false, status: 404, async text() { return 'Table not found'; } };
          }
          if (method === 'GET') {
            return {
              ok: true,
              status: 200,
              async text() { return JSON.stringify(tables[table]); }
            };
          }
          if (method === 'POST') {
            const incoming = Array.isArray(body) ? body : [body];
            for (const row of incoming) {
              if (table === 'audiobook_library_items') {
                const idx = tables[table].findIndex((r) => r.book_key === row.book_key);
                if (idx >= 0) tables[table][idx] = row;
                else tables[table].push(row);
              } else if (table === 'audiobook_devices') {
                const idx = tables[table].findIndex((r) => r.device_id === row.device_id);
                if (idx >= 0) tables[table][idx] = row;
                else tables[table].push(row);
              } else if (table === 'audiobook_progress') {
                const idx = tables[table].findIndex((r) => r.book_key === row.book_key);
                if (idx >= 0) tables[table][idx] = row;
                else tables[table].push(row);
              } else {
                tables[table] = [row];
              }
            }
            return {
              ok: true,
              status: 200,
              async text() { return JSON.stringify(incoming); }
            };
          }
        }

        if (url.includes('googleapis.com/drive/v3') || url.includes('googleapis.com/upload/drive/v3')) {
          if (driveStatus >= 400) {
            return {
              ok: false,
              status: driveStatus,
              async text() { return JSON.stringify({ error: { code: driveStatus, message: 'Drive auth error' } }); }
            };
          }
          if (url.includes('spaces=appDataFolder')) {
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  files: driveCloud.fileId
                    ? [{ id: driveCloud.fileId, name: 'audiobook-player-sync-v1.json', modifiedTime: driveCloud.modifiedTime }]
                    : []
                };
              }
            };
          }
          if (url.includes('alt=media')) {
            return {
              ok: true,
              status: 200,
              async text() { return JSON.stringify(driveCloud.payload); }
            };
          }
          if (url.includes('upload/drive/v3/files')) {
            const raw = String(init.body || '');
            const parts = raw.split(/\r?\n\r?\n/);
            const jsonPart = parts[parts.length - 1].split(/\r?\n--/)[0];
            driveCloud.payload = JSON.parse(jsonPart);
            driveCloud.fileId = driveCloud.fileId || 'drv-appdata-1';
            driveCloud.modifiedTime = new Date(Date.now() + driveCloud.writes * 1000).toISOString();
            driveCloud.writes += 1;
            return {
              ok: true,
              status: 200,
              async json() { return { id: driveCloud.fileId, modifiedTime: driveCloud.modifiedTime }; }
            };
          }
          if (url.includes('fields=id,name,modifiedTime')) {
            return {
              ok: true,
              status: 200,
              async json() {
                return { id: driveCloud.fileId, name: 'audiobook-player-sync-v1.json', modifiedTime: driveCloud.modifiedTime };
              }
            };
          }
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      };
    }
  };
}

test('Google OAuth bridges PC and Android to the exact same Supabase Auth account and survives Drive 401 expiry', async () => {
  const cloud = createSharedCloudMock();

  const pcSync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: null,
    navigatorObj: { onLine: true, userAgent: 'Windows NT 10.0' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: cloud.createFetch(),
    deviceId: 'pc-win-1',
    deviceName: 'Windows PC'
  });

  const pcAuth = await pcSync.completeGoogleOAuthToken('ya29.pc-token');
  assert.equal(pcAuth.ok, true);
  assert.equal(pcSync.isAuthenticated(), true);
  assert.equal(pcSync.session.auth_mode, 'google_oauth');
  assert.equal(pcSync.getGoogleAccessToken(), 'ya29.pc-token');
  assert.equal(pcSync.googleAccessToken, 'ya29.pc-token');
  assert.equal(pcSync.session.user.user_metadata.avatar_url, 'https://lh3.googleusercontent.com/a/avatar.png');
  assert.equal(pcSync.session.user.user_metadata.full_name, 'Reader One');
  const pcUserId = pcSync.session.user.id;
  assert.ok(!pcUserId.startsWith('google_'), 'Expected real Supabase UUID after bridge');

  await pcSync.syncLibraryItems([
    {
      bookKey: 'lincoln-in-the-bardo::george-saunders',
      title: 'Lincoln in the Bardo',
      author: 'George Saunders',
      series: 'Standalone',
      seriesOrder: 1,
      durationSec: 26000,
      source: 'drive',
      driveFileId: 'drv-lincoln-1',
      driveFolderId: 'fld-audiobooks',
      coverUrl: 'https://example.com/lincoln.jpg',
      chapters: [{ index: 0, title: 'Chapter 1', startSec: 0, driveFileId: 'drv-lincoln-1' }],
      tracks: [
        {
          index: 0,
          name: 'Lincoln_01.m4b',
          title: 'Part 1',
          duration: 13000,
          mimeType: 'audio/mp4',
          driveFileId: 'drv-lincoln-1'
        }
      ]
    }
  ]);

  await pcSync.registerDevice({
    activeBookKey: 'lincoln-in-the-bardo::george-saunders',
    activeBookTitle: 'Lincoln in the Bardo',
    chapterIndex: 0,
    positionSec: 319,
    isPlaying: true,
    lastSeenAt: '2026-11-18T16:40:00.000Z'
  });

  // Android signs in with Google OAuth using an EXPIRED Drive token (401 on Drive API)
  const androidSync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: null,
    navigatorObj: { onLine: true, userAgent: 'Mozilla/5.0 (Linux; Android 14)' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: cloud.createFetch({ driveStatus: 401 }),
    deviceId: 'android-pixel-1',
    deviceName: 'Pixel 9'
  });

  const androidAuth = await androidSync.completeGoogleOAuthToken('ya29.expired-android-token');
  assert.equal(androidAuth.ok, true);
  assert.equal(androidSync.isAuthenticated(), true);
  assert.equal(androidSync.session.user.id, pcUserId, 'PC and Android must bridge to the same Supabase user ID');

  // pullCloudSnapshot handles 401 from _driveFetch without throwing, clears expired Drive token without prompting reauth (Supabase is authenticated), and returns Supabase catalog + active playback
  const snap = await androidSync.pullCloudSnapshot({ force: false });
  assert.equal(androidSync.needsDriveSyncReauth, false);
  assert.equal(androidSync.getGoogleAccessToken(), null);
  assert.equal(snap.changed, true);
  assert.equal(snap.library.length, 1);
  assert.equal(snap.library[0].bookKey, 'lincoln-in-the-bardo::george-saunders');
  assert.equal(snap.library[0].tracks[0].driveFileId, 'drv-lincoln-1');
  assert.equal(snap.library[0].tracks[0].mimeType, 'audio/mp4');
  assert.equal(snap.library[0].tracks[0].duration, 13000);
  assert.deepEqual(snap.latestActivePlayback, {
    bookKey: 'lincoln-in-the-bardo::george-saunders',
    bookTitle: 'Lincoln in the Bardo',
    chapterIndex: 0,
    positionSec: 319,
    isPlaying: true,
    updatedAt: '2026-11-18T16:40:00.000Z',
    deviceId: 'pc-win-1',
    deviceName: 'Windows PC'
  });

  pcSync.destroy();
  androidSync.destroy();
});

test('restoreSession bridges persisted unbridged google_oauth session and recovers from 401 Supabase JWT', async () => {
  const cloud = createSharedCloudMock();
  const storage = createMemoryStorage();

  // Seed a legacy google_oauth session with access_token: null (before bridge existed)
  storage.setItem(
    'audiobook_player_supabase_session_v1',
    JSON.stringify({
      access_token: null,
      provider_token: null,
      auth_mode: 'google_oauth',
      user: {
        id: 'google_sub_legacy',
        email: 'reader.one@gmail.com',
        user_metadata: {
          full_name: 'Reader One',
          avatar_url: 'https://example.com/pic.png'
        }
      }
    })
  );

  const sync = new SupabaseSyncService({
    storage,
    windowObj: null,
    navigatorObj: { onLine: true },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: cloud.createFetch()
  });

  assert.equal(sync.isAuthenticated(), false);
  const restored = await sync.restoreSession();
  assert.ok(restored);
  assert.equal(sync.isAuthenticated(), true);
  assert.equal(restored.auth_mode, 'google_oauth');
  assert.equal(restored.user.user_metadata.avatar_url, 'https://example.com/pic.png');

  // Simulate expired Supabase JWT -> restoreSession refreshes cleanly instead of logging user out
  sync.setSession({
    ...sync.session,
    access_token: 'expired-jwt-token'
  });
  const recovered = await sync.restoreSession();
  assert.ok(recovered);
  assert.equal(sync.isAuthenticated(), true);
  assert.notEqual(recovered.access_token, 'expired-jwt-token');

  sync.destroy();
});

test('syncLibraryItems is fault-tolerant across Supabase errors, retries 401 once, and sanitizes oversized data URLs', async () => {
  // Case 1: Supabase REST returns 500 -> Drive appDataFolder write STILL executes and succeeds
  const cloud500 = createSharedCloudMock();
  const sync500 = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: null,
    navigatorObj: { onLine: true },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: cloud500.createFetch({ supaRestStatus: 500 })
  });
  sync500.setSession({
    access_token: 'jwt-1',
    provider_token: 'ya29.valid',
    auth_mode: 'google_oauth',
    user: { id: 'supa-u1', email: 'u1@gmail.com' }
  });

  const oversizedCover = `data:image/png;base64,${'A'.repeat(40 * 1024)}`;
  const smallCover = 'data:image/png;base64,iVBORw0KGgo=';
  const res500 = await sync500.syncLibraryItems([
    {
      bookKey: 'sandman::neil-gaiman',
      title: 'The Sandman',
      author: 'Neil Gaiman',
      series: 'The Sandman',
      seriesOrder: 1,
      durationSec: 39000,
      source: 'drive',
      driveFileId: 'drv-sandman',
      driveFolderId: 'fld-1',
      coverUrl: oversizedCover,
      chapters: [{ index: 0, title: 'Sleep of the Just', startSec: 0, driveFileId: 'drv-sandman' }],
      tracks: [{ index: 0, name: 'sandman.mp3', title: 'Track 1', duration: 39000, mimeType: 'audio/mpeg', driveFileId: 'drv-sandman' }]
    },
    {
      bookKey: 'small-cover::author',
      title: 'Small Cover Book',
      coverUrl: smallCover,
      source: 'drive',
      driveFileId: 'drv-small'
    }
  ]);

  assert.ok(res500, 'Drive fallback must succeed even when Supabase REST returns 500');
  assert.equal(cloud500.driveCloud.writes, 1);
  assert.equal(cloud500.driveCloud.payload.library['sandman::neil-gaiman'].coverUrl, '');
  assert.equal(cloud500.driveCloud.payload.library['small-cover::author'].coverUrl, smallCover);
  assert.equal(cloud500.driveCloud.payload.library['sandman::neil-gaiman'].tracks[0].mimeType, 'audio/mpeg');
  assert.equal(cloud500.driveCloud.payload.library['sandman::neil-gaiman'].tracks[0].duration, 39000);
  sync500.destroy();

  // Case 2: Supabase REST returns 401 on first attempt -> refreshes token and retries once
  const cloud401 = createSharedCloudMock({
    initialUsers: {
      'u2@gmail.com': { id: 'supa-u2', password: 'pw', user_metadata: {} }
    }
  });
  const sync401 = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: null,
    navigatorObj: { onLine: true },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: cloud401.createFetch({ failFirstRest401: true })
  });
  sync401.setSession({
    access_token: 'stale-jwt',
    refresh_token: 'ref-1',
    user: { id: 'supa-u2', email: 'u2@gmail.com' }
  });

  const res401 = await sync401.syncLibraryItems([
    { bookKey: 'expanse-1::corey', title: 'Leviathan Wakes', driveFileId: 'drv-lw', source: 'drive' }
  ]);
  assert.ok(res401);
  assert.equal(cloud401.tables.audiobook_library_items.length, 1);
  assert.notEqual(sync401.session.access_token, 'stale-jwt');
  sync401.destroy();
});

test('pullCloudSnapshot computes latestActivePlayback prioritizing recent isPlaying device over newer idle device and falling back to progress/driveFolder', async () => {
  const cloud = createSharedCloudMock({
    initialLibrary: [
      {
        book_key: 'expanse-1::corey',
        title: 'Leviathan Wakes',
        author: 'James S. A. Corey',
        sources: ['drive'],
        drive_file_id: 'drv-lw',
        total_duration_sec: 12000,
        chapters_json: [],
        metadata_json: { tracks: [{ index: 0, driveFileId: 'drv-lw', name: 'lw.m4b' }] }
      }
    ],
    initialDevices: [
      {
        device_id: 'pc-1',
        device_name: 'Windows PC',
        platform: 'windows',
        is_playing: true,
        is_active_player: true,
        current_book_key: 'expanse-1::corey',
        current_chapter_index: 3,
        current_position_sec: 742,
        last_seen_at: '2026-11-18T16:40:00.000Z'
      },
      {
        device_id: 'phone-1',
        device_name: 'Android Device',
        platform: 'android',
        is_playing: false,
        is_active_player: false,
        current_book_key: null,
        current_chapter_index: 0,
        current_position_sec: 0,
        last_seen_at: '2026-11-18T16:40:10.000Z'
      }
    ],
    initialProgress: [
      {
        book_key: 'expanse-1::corey',
        chapter_index: 3,
        position_sec: 755,
        device_id: 'pc-1',
        device_name: 'Windows PC',
        client_updated_at: '2026-11-18T16:40:05.000Z'
      }
    ]
  });

  const sync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: null,
    navigatorObj: { onLine: true },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl: cloud.createFetch(),
    deviceId: 'phone-1',
    deviceName: 'Android Device'
  });
  sync.setSession({
    access_token: 'valid-jwt',
    user: { id: 'supa-u1', email: 'u1@gmail.com' }
  });

  const snap = await sync.pullCloudSnapshot({ force: false });
  assert.equal(snap.library.length, 1);
  assert.deepEqual(snap.latestActivePlayback, {
    bookKey: 'expanse-1::corey',
    bookTitle: 'Leviathan Wakes',
    chapterIndex: 3,
    positionSec: 755,
    isPlaying: true,
    updatedAt: '2026-11-18T16:40:05.000Z',
    deviceId: 'pc-1',
    deviceName: 'Windows PC'
  });

  sync.destroy();
});

test('Tauri _driveFetch 401 triggers _trySilentGoogleRefresh and retries appDataFolder without interactive popup', async () => {
  const oauthInvokes = [];
  let pollMode = 'success';
  const fakeTauriWindow = {
    location: { origin: 'https://tauri.localhost', protocol: 'https:' },
    __TAURI_INTERNALS__: {
      invoke: async (cmd, args) => {
        oauthInvokes.push({ cmd, args });
        if (cmd === 'desktop_start_google_oauth') {
          return { status: 'pending', accessToken: null };
        }
        if (cmd === 'desktop_poll_google_oauth') {
          if (pollMode === 'success') {
            return { status: 'success', accessToken: 'ya29.refreshed-tauri-token' };
          }
          return { status: 'needs_interactive', accessToken: null };
        }
        return null;
      }
    }
  };

  const driveAuthHeaders = [];
  const fetchImpl = async (url, init = {}) => {
    if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            sub: 'google-sub-99',
            email: 'reader.one@gmail.com',
            name: 'Reader One'
          };
        }
      };
    }
    if (url.includes('googleapis.com/drive/v3/files')) {
      const auth = init?.headers?.Authorization || '';
      driveAuthHeaders.push(auth);
      if (auth === 'Bearer ya29.expired-tauri-token') {
        return {
          ok: false,
          status: 401,
          async text() {
            return JSON.stringify({ error: { code: 401, message: 'Invalid Credentials' } });
          }
        };
      }
      if (auth === 'Bearer ya29.refreshed-tauri-token') {
        return {
          ok: true,
          status: 200,
          async json() {
            return { files: [{ id: 'drv-sync-1', name: 'audiobook-player-sync-v1.json', modifiedTime: '2026-11-18T17:00:00.000Z' }] };
          }
        };
      }
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const sync = new SupabaseSyncService({
    storage: createMemoryStorage(),
    windowObj: fakeTauriWindow,
    navigatorObj: { onLine: true, userAgent: 'Windows NT 10.0' },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
    fetchImpl
  });

  sync.setSession({
    access_token: null,
    auth_mode: 'google_oauth',
    provider_token: 'ya29.expired-tauri-token',
    user: { id: 'google_99', email: 'reader.one@gmail.com' }
  });

  // Case 1: 401 on Drive appDataFolder triggers silent Tauri OAuth refresh and retries seamlessly
  const firstRes = await sync._driveFetch('https://www.googleapis.com/drive/v3/files?spaces=appDataFolder');
  assert.equal(firstRes.unauthorized, false);
  assert.equal(firstRes.res?.ok, true);
  assert.equal(sync.getGoogleAccessToken(), 'ya29.refreshed-tauri-token');
  assert.equal(sync.needsDriveSyncReauth, false);
  assert.deepEqual(driveAuthHeaders, [
    'Bearer ya29.expired-tauri-token',
    'Bearer ya29.refreshed-tauri-token'
  ]);
  const startCalls = oauthInvokes.filter((c) => c.cmd === 'desktop_start_google_oauth');
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0].args.silent, true);
  assert.equal(startCalls[0].args.forceRefresh, true);
  assert.equal(startCalls[0].args.loginHint, 'reader.one@gmail.com');

  // Case 2: When silent refresh returns needs_interactive, NEVER escalate to interactive popup and apply 60s cooldown
  pollMode = 'needs_interactive';
  sync.setGoogleAccessToken('ya29.expired-tauri-token');
  const secondRes = await sync._driveFetch('https://www.googleapis.com/drive/v3/files?spaces=appDataFolder');
  assert.equal(secondRes.unauthorized, true);
  assert.equal(sync.needsDriveSyncReauth, true);
  const startCallsAfter = oauthInvokes.filter((c) => c.cmd === 'desktop_start_google_oauth');
  assert.equal(startCallsAfter.length, 2, 'Must NOT open a second interactive popup on needs_interactive');
  assert.equal(startCallsAfter[1].args.silent, true);

  // Cooldown prevents looping on immediate retry
  const cooledDown = await sync._trySilentGoogleRefresh();
  assert.equal(cooledDown, false);
  assert.equal(
    oauthInvokes.filter((c) => c.cmd === 'desktop_start_google_oauth').length,
    2,
    '60s cooldown must skip repeated silent refresh attempts'
  );

  sync.destroy();
});
