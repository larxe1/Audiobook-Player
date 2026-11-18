import {
  OfflineSyncQueue,
  resolveProgressConflict,
  toEpochMs
} from './offline-queue.js';

export const SUPABASE_CONFIG = {
  url: 'https://ycokzejqpenvlamvzhrm.supabase.co',
  publishableKey: 'sb_publishable_YzLKM2MCjKhqrc91vgmsFA_8RZlzyOZ'
};

const SESSION_STORAGE_KEY = 'audiobook_player_supabase_session_v1';
const DEVICE_ID_STORAGE_KEY = 'audiobook_player_device_id_v1';
const BROADCAST_CHANNEL_NAME = 'audiobook-player-sync-channel';

function generateId(prefix = 'dev') {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `${prefix}_${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function detectDeviceName(navigatorObj) {
  const ua = navigatorObj?.userAgent || '';
  if (/Android/i.test(ua)) return 'Android Device';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS Device';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'Mac';
  if (/Linux/i.test(ua)) return 'Linux PC';
  return 'Web Player';
}

function detectPlatform(navigatorObj) {
  const ua = navigatorObj?.userAgent || '';
  if (/Android/i.test(ua)) return 'android';
  if (/Windows/i.test(ua)) return 'windows';
  return 'web';
}

/**
 * Processes an incoming cross-device playback event against the local player state.
 * When another device on the same account emits PLAYBACK_STARTED, instructs the local
 * player to pause immediately and sync its book/chapter/position to the remote device.
 *
 * @param {object} localState
 * @param {object} remoteEvent
 * @returns {object}
 */
export function handleRemoteEvent(localState = {}, remoteEvent = null) {
  const fallback = {
    shouldPauseLocal: false,
    updatedBookKey: localState?.bookKey ?? null,
    updatedChapterIndex: localState?.chapterIndex ?? 0,
    updatedPositionSec: localState?.positionSec ?? 0,
    activeDeviceName: localState?.deviceName ?? null
  };

  if (!remoteEvent || typeof remoteEvent !== 'object') {
    return fallback;
  }

  // Ignore events originating from this same device
  if (remoteEvent.deviceId && localState?.deviceId && remoteEvent.deviceId === localState.deviceId) {
    return fallback;
  }

  const eventType = remoteEvent.event || remoteEvent.type || '';
  const updatedBookKey = remoteEvent.bookKey ?? localState?.bookKey ?? null;
  const updatedChapterIndex =
    remoteEvent.chapterIndex !== undefined
      ? Number(remoteEvent.chapterIndex)
      : (localState?.chapterIndex ?? 0);
  const updatedPositionSec =
    remoteEvent.positionSec !== undefined
      ? Number(remoteEvent.positionSec)
      : (localState?.positionSec ?? 0);
  const activeDeviceName = remoteEvent.deviceName ?? null;

  if (eventType === 'PLAYBACK_STARTED') {
    return {
      shouldPauseLocal: true,
      updatedBookKey,
      updatedChapterIndex,
      updatedPositionSec,
      activeDeviceName
    };
  }

  if (eventType === 'PLAYBACK_PAUSED' || eventType === 'POSITION_SYNC') {
    const localTs = toEpochMs(localState?.clientUpdatedAt);
    const remoteTs = toEpochMs(remoteEvent.clientUpdatedAt);
    const shouldApplyRemotePos =
      remoteTs === 0 || localTs === 0 || remoteTs >= localTs;

    return {
      shouldPauseLocal: false,
      updatedBookKey: shouldApplyRemotePos ? updatedBookKey : (localState?.bookKey ?? null),
      updatedChapterIndex: shouldApplyRemotePos
        ? updatedChapterIndex
        : (localState?.chapterIndex ?? 0),
      updatedPositionSec: shouldApplyRemotePos
        ? updatedPositionSec
        : (localState?.positionSec ?? 0),
      activeDeviceName
    };
  }

  return {
    ...fallback,
    activeDeviceName
  };
}

function mapProgressRowToClient(row) {
  if (!row) return null;
  return {
    bookKey: row.book_key ?? row.bookKey,
    chapterIndex: Number(row.chapter_index ?? row.chapterIndex ?? 0),
    positionSec: Number(row.position_sec ?? row.positionSec ?? 0),
    durationSec: Number(row.duration_sec ?? row.durationSec ?? 0),
    completed: Boolean(row.completed),
    deviceId: row.device_id ?? row.deviceId ?? null,
    deviceName: row.device_name ?? row.deviceName ?? null,
    clientUpdatedAt: row.client_updated_at ?? row.clientUpdatedAt ?? row.updated_at ?? null
  };
}

function mapBookmarkRowToClient(row) {
  if (!row) return null;
  return {
    id: row.id,
    bookKey: row.book_key ?? row.bookKey,
    chapterIndex: Number(row.chapter_index ?? row.chapterIndex ?? 0),
    positionSec: Number(row.position_sec ?? row.positionSec ?? 0),
    label: row.label ?? '',
    note: row.note ?? '',
    clientUpdatedAt: row.client_updated_at ?? row.clientUpdatedAt ?? row.created_at ?? null
  };
}

/**
 * Coordinates Google OAuth authentication, Supabase REST persistence,
 * Realtime WebSocket / BroadcastChannel cross-device playback handoff,
 * and automatic offline queue flushing upon network reconnection.
 */
export class SupabaseSyncService {
  /**
   * @param {object} [options]
   */
  constructor(options = {}) {
    this.config = options.config || SUPABASE_CONFIG;
    this.offlineQueue = options.offlineQueue || new OfflineSyncQueue({
      storage: options.storage,
      indexedDB: options.indexedDB
    });
    this.fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
    this.storage =
      options.storage !== undefined
        ? options.storage
        : typeof globalThis.localStorage !== 'undefined'
          ? globalThis.localStorage
          : null;
    this.navigatorObj =
      options.navigatorObj !== undefined
        ? options.navigatorObj
        : typeof globalThis.navigator !== 'undefined'
          ? globalThis.navigator
          : null;
    this.windowObj =
      options.windowObj !== undefined
        ? options.windowObj
        : typeof globalThis.window !== 'undefined'
          ? globalThis.window
          : null;
    this.WebSocketImpl =
      options.WebSocketImpl !== undefined
        ? options.WebSocketImpl
        : typeof globalThis.WebSocket !== 'undefined'
          ? globalThis.WebSocket
          : null;
    this.BroadcastChannelImpl =
      options.BroadcastChannelImpl !== undefined
        ? options.BroadcastChannelImpl
        : typeof globalThis.BroadcastChannel !== 'undefined'
          ? globalThis.BroadcastChannel
          : null;

    this.deviceId = options.deviceId || this._loadOrCreateDeviceId();
    this.deviceName = options.deviceName || detectDeviceName(this.navigatorObj);
    this.platform = options.platform || detectPlatform(this.navigatorObj);

    this.session = this._loadSession();
    /** @type {Set<Function>} */
    this._remoteListeners = new Set();
    /** @type {Set<Function>} */
    this._flushListeners = new Set();
    this._channel = null;
    this._ws = null;
    this._heartbeatTimer = null;
    this._phxRef = 1;
    this._flushing = false;

    this._onOnlineBound = () => {
      void this.flushOfflineQueue();
    };

    if (this.windowObj && typeof this.windowObj.addEventListener === 'function') {
      this.windowObj.addEventListener('online', this._onOnlineBound);
    }

    this._initBroadcastChannel();
  }

  _loadOrCreateDeviceId() {
    if (this.storage) {
      try {
        const existing = this.storage.getItem(DEVICE_ID_STORAGE_KEY);
        if (existing) return existing;
        const created = generateId('dev');
        this.storage.setItem(DEVICE_ID_STORAGE_KEY, created);
        return created;
      } catch {
        // Fallback below
      }
    }
    return generateId('dev');
  }

  _loadSession() {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(SESSION_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  _saveSession(session) {
    this.session = session || null;
    if (!this.storage) return;
    try {
      if (this.session) {
        this.storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(this.session));
      } else {
        this.storage.removeItem(SESSION_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures
    }
  }

  _isOnline() {
    if (typeof this.navigatorObj?.onLine === 'boolean') {
      return this.navigatorObj.onLine;
    }
    return true;
  }

  _getHeaders(extra = {}) {
    const token = this.session?.access_token || this.config.publishableKey;
    return {
      apikey: this.config.publishableKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...extra
    };
  }

  async _rest(path, { method = 'GET', body, headers = {} } = {}) {
    if (!this.fetchImpl) {
      throw new Error('fetch implementation is not available');
    }
    const url = `${this.config.url}/rest/v1/${path.replace(/^\//, '')}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: this._getHeaders(headers),
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    if (!res.ok) {
      const errorText = typeof res.text === 'function' ? await res.text() : `HTTP ${res.status}`;
      throw new Error(`Supabase REST ${method} ${path} failed (${res.status}): ${errorText}`);
    }
    const text = typeof res.text === 'function' ? await res.text() : '';
    return text ? JSON.parse(text) : null;
  }

  /**
   * Returns true if a Supabase user session is active.
   * @returns {boolean}
   */
  isAuthenticated() {
    return Boolean(this.session?.access_token && this.session?.user?.id);
  }

  /**
   * Manually sets or clears the active session (useful for auth restoration and testing).
   * @param {object|null} session
   */
  setSession(session) {
    this._saveSession(session);
  }

  /**
   * Returns the Google OAuth provider token if available (for Google Drive API v3 calls).
   * @returns {string|null}
   */
  getGoogleAccessToken() {
    return this.session?.provider_token || this.session?.googleAccessToken || null;
  }

  /**
   * Returns { id, email, name, avatarUrl } from Google user_metadata, or null if signed out.
   * @returns {{ id: string|null, email: string, name: string, avatarUrl: string }|null}
   */
  getUserProfile() {
    const user = this.session?.user;
    if (!user) return null;
    const meta = user.user_metadata || {};
    const email = user.email || meta.email || '';
    return {
      id: user.id || null,
      email,
      name: meta.full_name || meta.name || email || 'Listener',
      avatarUrl: meta.avatar_url || meta.picture || ''
    };
  }

  /**
   * Initiates Google OAuth via Supabase Auth, requesting Drive readonly scope for library streaming.
   * If running in a browser, redirects to the OAuth URL unless autoRedirect is false.
   * @param {object} [options]
   * @returns {Promise<{ url: string }>}
   */
  async signInWithGoogle(options = {}) {
    const redirectTo =
      options.redirectTo ||
      this.windowObj?.location?.origin ||
      'http://localhost';
    const scopes =
      options.scopes ||
      'https://www.googleapis.com/auth/drive.readonly email profile';

    const params = new URLSearchParams({
      provider: 'google',
      redirect_to: redirectTo,
      scopes,
      access_type: 'offline',
      prompt: 'consent'
    });

    const authUrl = `${this.config.url}/auth/v1/authorize?${params.toString()}`;
    if (options.autoRedirect !== false && this.windowObj?.location?.assign) {
      this.windowObj.location.assign(authUrl);
    }
    return { url: authUrl };
  }

  /**
   * Parses an OAuth redirect callback URL or hash fragment and hydrates the Supabase user profile.
   * @param {string} [urlOrHash]
   * @returns {Promise<object|null>}
   */
  async handleAuthCallback(urlOrHash) {
    const raw =
      urlOrHash ??
      this.windowObj?.location?.hash ??
      this.windowObj?.location?.search ??
      '';
    const fragment = raw.includes('#') ? raw.split('#')[1] : raw.replace(/^[?#]/, '');
    const params = new URLSearchParams(fragment);
    const accessToken = params.get('access_token');
    if (!accessToken) return null;

    const session = {
      access_token: accessToken,
      refresh_token: params.get('refresh_token') || null,
      provider_token: params.get('provider_token') || null,
      expires_in: Number(params.get('expires_in') || 3600),
      token_type: params.get('token_type') || 'bearer',
      user: null
    };

    if (this.fetchImpl) {
      try {
        const res = await this.fetchImpl(`${this.config.url}/auth/v1/user`, {
          headers: {
            apikey: this.config.publishableKey,
            Authorization: `Bearer ${accessToken}`
          }
        });
        if (res.ok) {
          session.user = await res.json();
        }
      } catch {
        // Keep token-only session if user lookup is temporarily offline
      }
    }

    this._saveSession(session);
    this.connectRealtime();
    return session;
  }

  /**
   * Signs out from Supabase Auth, clears local session, and disconnects Realtime.
   * @returns {Promise<void>}
   */
  async signOut() {
    const token = this.session?.access_token;
    if (token && this.fetchImpl && this._isOnline()) {
      try {
        await this.fetchImpl(`${this.config.url}/auth/v1/logout`, {
          method: 'POST',
          headers: {
            apikey: this.config.publishableKey,
            Authorization: `Bearer ${token}`
          }
        });
      } catch {
        // Proceed with local sign-out even if network call fails
      }
    }
    this._saveSession(null);
    this.disconnectRealtime();
  }

  /**
   * Pushes a playback progress checkpoint to /rest/v1/audiobook_progress,
   * automatically falling back to OfflineSyncQueue when offline or on network failure.
   * @param {object} checkpoint
   * @returns {Promise<{ synced: boolean, queued: boolean, record: object }>}
   */
  async pushProgress(checkpoint) {
    const stamped = {
      ...checkpoint,
      deviceId: checkpoint.deviceId || this.deviceId,
      deviceName: checkpoint.deviceName || this.deviceName,
      clientUpdatedAt: checkpoint.clientUpdatedAt || new Date().toISOString()
    };

    this.offlineQueue.saveLocalProgress(stamped.bookKey, stamped);

    if (!this._isOnline() || !this.isAuthenticated()) {
      const queuedRecord = this.offlineQueue.enqueueProgress(stamped);
      return { synced: false, queued: true, record: queuedRecord };
    }

    try {
      const row = {
        user_id: this.session.user.id,
        book_key: stamped.bookKey,
        chapter_index: Number(stamped.chapterIndex ?? 0),
        position_sec: Number(stamped.positionSec ?? 0),
        duration_sec: Number(stamped.durationSec ?? 0),
        completed: Boolean(stamped.completed),
        device_id: stamped.deviceId,
        device_name: stamped.deviceName,
        client_updated_at: stamped.clientUpdatedAt
      };

      await this._rest('audiobook_progress?on_conflict=user_id,book_key', {
        method: 'POST',
        headers: {
          Prefer: 'resolution=merge-duplicates,return=representation'
        },
        body: row
      });

      this.offlineQueue.clearFlushed(stamped.bookKey, stamped.clientUpdatedAt);
      return { synced: true, queued: false, record: stamped };
    } catch {
      const queuedRecord = this.offlineQueue.enqueueProgress(stamped);
      return { synced: false, queued: true, record: queuedRecord };
    }
  }

  /**
   * Fetches all progress records from Supabase and reconciles them with local records
   * via resolveProgressConflict so newer offline positions are never overwritten.
   * @returns {Promise<Record<string, object>>}
   */
  async fetchAllProgress() {
    const localMap = this.offlineQueue.getAllLocalProgress();
    if (!this._isOnline() || !this.isAuthenticated()) {
      return localMap;
    }

    try {
      const rows = await this._rest(
        'audiobook_progress?select=*&order=client_updated_at.desc'
      );
      const merged = { ...localMap };
      for (const row of Array.isArray(rows) ? rows : []) {
        const remote = mapProgressRowToClient(row);
        if (!remote?.bookKey) continue;
        const winner = resolveProgressConflict(merged[remote.bookKey], remote);
        if (winner) {
          merged[remote.bookKey] = winner;
          this.offlineQueue.saveLocalProgress(remote.bookKey, winner);
        }
      }
      return merged;
    } catch {
      return localMap;
    }
  }

  /**
   * Saves a bookmark locally and pushes it to /rest/v1/audiobook_bookmarks.
   * @param {string} bookKey
   * @param {object} bookmark
   * @returns {Promise<{ synced: boolean, queued: boolean, bookmark: object }>}
   */
  async saveBookmark(bookKey, bookmark) {
    const savedLocal = this.offlineQueue.saveLocalBookmark(bookKey, bookmark, true);

    if (!this._isOnline() || !this.isAuthenticated()) {
      return { synced: false, queued: true, bookmark: savedLocal };
    }

    try {
      await this._rest('audiobook_bookmarks', {
        method: 'POST',
        headers: {
          Prefer: 'return=representation'
        },
        body: {
          user_id: this.session.user.id,
          book_key: savedLocal.bookKey,
          chapter_index: savedLocal.chapterIndex,
          position_sec: savedLocal.positionSec,
          label: savedLocal.label || '',
          note: savedLocal.note || '',
          client_updated_at: savedLocal.clientUpdatedAt
        }
      });
      this.offlineQueue.clearFlushedBookmark(savedLocal.id);
      return { synced: true, queued: false, bookmark: savedLocal };
    } catch {
      return { synced: false, queued: true, bookmark: savedLocal };
    }
  }

  /**
   * Fetches bookmarks for a book from /rest/v1/audiobook_bookmarks and merges local bookmarks.
   * @param {string} [bookKey]
   * @returns {Promise<object[]>}
   */
  async fetchBookmarks(bookKey) {
    const localList = bookKey ? this.offlineQueue.getLocalBookmarks(bookKey) : [];
    if (!this._isOnline() || !this.isAuthenticated()) {
      return localList;
    }

    try {
      const query = bookKey
        ? `audiobook_bookmarks?book_key=eq.${encodeURIComponent(bookKey)}&select=*&order=position_sec.asc`
        : 'audiobook_bookmarks?select=*&order=created_at.desc';
      const rows = await this._rest(query);
      const remoteList = (Array.isArray(rows) ? rows : []).map(mapBookmarkRowToClient);

      const seen = new Set();
      const combined = [];
      for (const bm of [...remoteList, ...localList]) {
        const dedupeKey = bm.id || `${bm.bookKey}:${bm.chapterIndex}:${Math.round(bm.positionSec)}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        combined.push(bm);
      }
      return combined.sort((a, b) => a.positionSec - b.positionSec);
    } catch {
      return localList;
    }
  }

  /**
   * Registers or updates this device in /rest/v1/audiobook_devices.
   * @param {object} [deviceState]
   * @returns {Promise<object|null>}
   */
  async registerDevice(deviceState = {}) {
    if (!this._isOnline() || !this.isAuthenticated()) {
      return null;
    }
    const payload = {
      user_id: this.session.user.id,
      device_id: this.deviceId,
      device_name: deviceState.deviceName || this.deviceName,
      platform: deviceState.platform || this.platform,
      active_book_key: deviceState.activeBookKey ?? null,
      is_playing: Boolean(deviceState.isPlaying),
      last_seen_at: new Date().toISOString()
    };
    return this._rest('audiobook_devices?on_conflict=user_id,device_id', {
      method: 'POST',
      headers: {
        Prefer: 'resolution=merge-duplicates,return=representation'
      },
      body: payload
    });
  }

  /**
   * Lists connected devices on this account from /rest/v1/audiobook_devices.
   * @returns {Promise<object[]>}
   */
  async fetchDevices() {
    if (!this._isOnline() || !this.isAuthenticated()) {
      return [
        {
          deviceId: this.deviceId,
          deviceName: this.deviceName,
          platform: this.platform,
          isCurrentDevice: true
        }
      ];
    }
    try {
      const rows = await this._rest('audiobook_devices?select=*&order=last_seen_at.desc');
      return (Array.isArray(rows) ? rows : []).map((row) => ({
        deviceId: row.device_id,
        deviceName: row.device_name,
        platform: row.platform,
        activeBookKey: row.active_book_key,
        isPlaying: Boolean(row.is_playing),
        lastSeenAt: row.last_seen_at,
        isCurrentDevice: row.device_id === this.deviceId
      }));
    } catch {
      return [];
    }
  }

  /**
   * Upserts normalized library items to /rest/v1/audiobook_library_items.
   * @param {object[]} items
   * @returns {Promise<object[]|null>}
   */
  async syncLibraryItems(items = []) {
    if (!this._isOnline() || !this.isAuthenticated() || !Array.isArray(items) || items.length === 0) {
      return null;
    }
    const rows = items.map((item) => ({
      user_id: this.session.user.id,
      book_key: item.bookKey,
      title: item.title || 'Untitled',
      author: item.author || '',
      narrator: item.narrator || '',
      series: item.series || '',
      cover_url: item.coverUrl || '',
      total_duration_sec: Number(item.totalDurationSec ?? item.durationSec ?? 0),
      sources: Array.isArray(item.sources) ? item.sources : [],
      drive_file_id: item.driveFileId || null,
      metadata_json: {
        description: item.description || '',
        chapters: Array.isArray(item.chapters) ? item.chapters : []
      },
      updated_at: new Date().toISOString()
    }));

    return this._rest('audiobook_library_items?on_conflict=user_id,book_key', {
      method: 'POST',
      headers: {
        Prefer: 'resolution=merge-duplicates,return=representation'
      },
      body: rows
    });
  }

  /**
   * Fetches synced library items from /rest/v1/audiobook_library_items.
   * @returns {Promise<object[]>}
   */
  async fetchLibraryItems() {
    if (!this._isOnline() || !this.isAuthenticated()) {
      return [];
    }
    try {
      const rows = await this._rest('audiobook_library_items?select=*&order=updated_at.desc');
      return (Array.isArray(rows) ? rows : []).map((row) => ({
        bookKey: row.book_key,
        title: row.title,
        author: row.author,
        narrator: row.narrator,
        series: row.series,
        coverUrl: row.cover_url,
        totalDurationSec: Number(row.total_duration_sec ?? 0),
        sources: Array.isArray(row.sources) ? row.sources : [],
        driveFileId: row.drive_file_id,
        description: row.metadata_json?.description || '',
        chapters: row.metadata_json?.chapters || []
      }));
    } catch {
      return [];
    }
  }

  _initBroadcastChannel() {
    if (!this.BroadcastChannelImpl) return;
    try {
      this._channel = new this.BroadcastChannelImpl(BROADCAST_CHANNEL_NAME);
      this._channel.onmessage = (msg) => {
        if (msg?.data) {
          this.receiveRemoteEvent(msg.data);
        }
      };
    } catch {
      this._channel = null;
    }
  }

  /**
   * Opens the Supabase Realtime Phoenix WebSocket channel for cross-device handoff.
   */
  connectRealtime() {
    if (!this.WebSocketImpl || !this._isOnline() || !this.isAuthenticated()) {
      return;
    }
    if (this._ws && this._ws.readyState <= 1) {
      return;
    }

    const wsBase = this.config.url.replace(/^http/, 'ws');
    const wsUrl = `${wsBase}/realtime/v1/websocket?apikey=${encodeURIComponent(this.config.publishableKey)}&vsn=1.0.0`;
    const topic = `realtime:audiobook-sync:${this.session.user.id}`;

    try {
      const ws = new this.WebSocketImpl(wsUrl);
      this._ws = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            topic,
            event: 'phx_join',
            payload: {
              config: {
                broadcast: { self: false }
              },
              access_token: this.session.access_token
            },
            ref: String(this._phxRef++)
          })
        );

        this._heartbeatTimer = setInterval(() => {
          if (ws.readyState === 1) {
            ws.send(
              JSON.stringify({
                topic: 'phoenix',
                event: 'heartbeat',
                payload: {},
                ref: String(this._phxRef++)
              })
            );
          }
        }, 25000);
      };

      ws.onmessage = (event) => {
        try {
          const frame = JSON.parse(event.data);
          if (frame?.event === 'broadcast' && frame?.payload?.payload) {
            this.receiveRemoteEvent(frame.payload.payload);
          }
        } catch {
          // Ignore non-JSON frames
        }
      };

      ws.onclose = () => {
        if (this._heartbeatTimer) {
          clearInterval(this._heartbeatTimer);
          this._heartbeatTimer = null;
        }
      };
    } catch {
      this._ws = null;
    }
  }

  /**
   * Closes Realtime WebSocket and heartbeat timer.
   */
  disconnectRealtime() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._ws) {
      try {
        this._ws.close();
      } catch {
        // Ignore close errors
      }
      this._ws = null;
    }
  }

  /**
   * Broadcasts playback state across BroadcastChannel (cross-tab) and Supabase Realtime (cross-device).
   * @param {object} statePayload
   * @returns {object}
   */
  broadcastPlaybackState(statePayload = {}) {
    const event =
      statePayload.event ||
      (statePayload.isPlaying ? 'PLAYBACK_STARTED' : 'PLAYBACK_PAUSED');

    const message = {
      event,
      deviceId: statePayload.deviceId || this.deviceId,
      deviceName: statePayload.deviceName || this.deviceName,
      bookKey: statePayload.bookKey ?? null,
      chapterIndex: Number(statePayload.chapterIndex ?? 0),
      positionSec: Number(statePayload.positionSec ?? 0),
      clientUpdatedAt: statePayload.clientUpdatedAt || new Date().toISOString()
    };

    if (this._channel) {
      try {
        this._channel.postMessage(message);
      } catch {
        // Ignore BroadcastChannel errors
      }
    }

    if (this._ws && this._ws.readyState === 1 && this.session?.user?.id) {
      const topic = `realtime:audiobook-sync:${this.session.user.id}`;
      try {
        this._ws.send(
          JSON.stringify({
            topic,
            event: 'broadcast',
            payload: {
              type: 'broadcast',
              event: 'playback_handoff',
              payload: message
            },
            ref: String(this._phxRef++)
          })
        );
      } catch {
        // Ignore WebSocket send failures
      }
    }

    return message;
  }

  /**
   * Delivers an incoming remote playback event to registered listeners (ignoring self-echoes).
   * @param {object} remoteEvent
   */
  receiveRemoteEvent(remoteEvent) {
    if (!remoteEvent || remoteEvent.deviceId === this.deviceId) {
      return;
    }
    for (const listener of this._remoteListeners) {
      try {
        listener(remoteEvent);
      } catch {
        // Isolate subscriber errors
      }
    }
  }

  /**
   * Subscribes to remote playback handoff events. Returns an unsubscribe function.
   * @param {(event: object) => void} callback
   * @returns {() => void}
   */
  onRemotePlaybackEvent(callback) {
    if (typeof callback !== 'function') {
      throw new Error('Callback must be a function');
    }
    this._remoteListeners.add(callback);
    return () => {
      this._remoteListeners.delete(callback);
    };
  }

  /**
   * Subscribes to offline queue flush notifications.
   * @param {(result: object) => void} callback
   * @returns {() => void}
   */
  onQueueFlushed(callback) {
    if (typeof callback !== 'function') {
      throw new Error('Callback must be a function');
    }
    this._flushListeners.add(callback);
    return () => {
      this._flushListeners.delete(callback);
    };
  }

  /**
   * Flushes all queued offline progress checkpoints and bookmarks to Supabase.
   * @returns {Promise<{ flushedProgress: number, flushedBookmarks: number, remaining: number }>}
   */
  async flushOfflineQueue() {
    if (this._flushing) {
      return {
        flushedProgress: 0,
        flushedBookmarks: 0,
        remaining: this.offlineQueue.getPendingQueue().length
      };
    }

    if (!this._isOnline() || !this.isAuthenticated()) {
      return {
        flushedProgress: 0,
        flushedBookmarks: 0,
        remaining: this.offlineQueue.getPendingQueue().length
      };
    }

    this._flushing = true;
    let flushedProgress = 0;
    let flushedBookmarks = 0;

    try {
      const pendingProgress = this.offlineQueue.getPendingQueue();
      for (const cp of pendingProgress) {
        try {
          await this._rest('audiobook_progress?on_conflict=user_id,book_key', {
            method: 'POST',
            headers: {
              Prefer: 'resolution=merge-duplicates,return=representation'
            },
            body: {
              user_id: this.session.user.id,
              book_key: cp.bookKey,
              chapter_index: Number(cp.chapterIndex ?? 0),
              position_sec: Number(cp.positionSec ?? 0),
              duration_sec: Number(cp.durationSec ?? 0),
              completed: Boolean(cp.completed),
              device_id: cp.deviceId || this.deviceId,
              device_name: cp.deviceName || this.deviceName,
              client_updated_at: cp.clientUpdatedAt
            }
          });
          this.offlineQueue.clearFlushed(cp.bookKey, cp.clientUpdatedAt);
          flushedProgress += 1;
        } catch {
          // Stop flushing further items on network failure; keep remaining queued
          break;
        }
      }

      const pendingBookmarks = this.offlineQueue.getPendingBookmarks();
      for (const bm of pendingBookmarks) {
        try {
          await this._rest('audiobook_bookmarks', {
            method: 'POST',
            headers: {
              Prefer: 'return=representation'
            },
            body: {
              user_id: this.session.user.id,
              book_key: bm.bookKey,
              chapter_index: bm.chapterIndex,
              position_sec: bm.positionSec,
              label: bm.label || '',
              note: bm.note || '',
              client_updated_at: bm.clientUpdatedAt
            }
          });
          this.offlineQueue.clearFlushedBookmark(bm.id);
          flushedBookmarks += 1;
        } catch {
          break;
        }
      }

      const result = {
        flushedProgress,
        flushedBookmarks,
        remaining: this.offlineQueue.getPendingQueue().length
      };

      for (const listener of this._flushListeners) {
        try {
          listener(result);
        } catch {
          // Isolate listener errors
        }
      }

      return result;
    } finally {
      this._flushing = false;
    }
  }

  /**
   * Cleans up event listeners, BroadcastChannel, and Realtime WebSocket connections.
   */
  destroy() {
    if (this.windowObj && typeof this.windowObj.removeEventListener === 'function') {
      this.windowObj.removeEventListener('online', this._onOnlineBound);
    }
    if (this._channel) {
      try {
        this._channel.close();
      } catch {
        // Ignore close errors
      }
      this._channel = null;
    }
    this.disconnectRealtime();
  }
}
