import {
  OfflineSyncQueue,
  resolveProgressConflict,
  toEpochMs
} from './offline-queue.js';

export const SUPABASE_CONFIG = {
  url: 'https://ycokzejqpenvlamvzhrm.supabase.co',
  publishableKey: 'sb_publishable_YzLKM2MCjKhqrc91vgmsFA_8RZlzyOZ'
};

export const DEFAULT_GOOGLE_CLIENT_ID =
  '22283534025-av56s1jjavk740hd5n4i7r10jkjajd1f.apps.googleusercontent.com';

export const DEFAULT_GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.appdata',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
].join(' ');

const DRIVE_SYNC_FILENAME = 'audiobook-player-sync-v1.json';
const SESSION_STORAGE_KEY = 'audiobook_player_supabase_session_v1';
const GOOGLE_TOKEN_STORAGE_KEY = 'audiobook_player_google_token_v1';
const GOOGLE_CLIENT_ID_STORAGE_KEY = 'audiobook_player_google_client_id_v1';
const DEVICE_ID_STORAGE_KEY = 'audiobook_player_device_id_v1';
const BROADCAST_CHANNEL_NAME = 'audiobook-player-sync-channel';

function deriveDisplayNameFromEmail(email = '') {
  const local = String(email || '').split('@')[0] || '';
  const cleaned = local.replace(/[._-]+/g, ' ').trim();
  if (!cleaned) return 'Listener';
  return cleaned.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

async function computeGravatarUrl(email = '') {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean || !globalThis.crypto?.subtle || typeof TextEncoder === 'undefined') {
    return '';
  }
  try {
    const bytes = new TextEncoder().encode(clean);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `https://www.gravatar.com/avatar/${hex}?s=128&d=404`;
  } catch {
    return '';
  }
}

function parseAuthErrorMessage(payload, fallback = 'Authentication failed.') {
  if (!payload) return fallback;
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload);
      return parsed.msg || parsed.error_description || parsed.message || parsed.error || fallback;
    } catch {
      return payload || fallback;
    }
  }
  return (
    payload.msg ||
    payload.error_description ||
    payload.message ||
    payload.error ||
    fallback
  );
}

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

function buildDriveStreamUrl(fileId) {
  const clean = String(fileId || '').trim();
  return clean ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(clean)}?alt=media` : '';
}

function sanitizeMediaEntry(entry, index = 0) {
  if (!entry || typeof entry !== 'object') return null;
  const driveFileId = String(entry.driveFileId || entry.drive_file_id || '').trim();
  const rawStreamUrl = String(entry.driveStreamUrl || entry.drive_stream_url || '').trim();
  const driveStreamUrl = rawStreamUrl || (driveFileId ? buildDriveStreamUrl(driveFileId) : '');
  const clean = {
    index: Number.isFinite(Number(entry.index)) ? Number(entry.index) : index,
    title: entry.title || entry.name || `Chapter ${index + 1}`,
    ...(entry.fileName ? { fileName: entry.fileName } : {}),
    ...(entry.name ? { name: entry.name } : {}),
    startSec: Number.isFinite(Number(entry.startSec)) ? Number(entry.startSec) : 0,
    ...(Number.isFinite(Number(entry.durationSec)) && Number(entry.durationSec) > 0
      ? { durationSec: Number(entry.durationSec) }
      : {}),
    ...(Number.isFinite(Number(entry.sizeBytes ?? entry.size)) && Number(entry.sizeBytes ?? entry.size) > 0
      ? { sizeBytes: Number(entry.sizeBytes ?? entry.size) }
      : {}),
    ...(driveFileId ? { driveFileId } : {}),
    ...(driveStreamUrl ? { driveStreamUrl } : {})
  };
  return clean;
}

function sanitizeMediaList(list) {
  if (!Array.isArray(list)) return [];
  return list.map((entry, idx) => sanitizeMediaEntry(entry, idx)).filter(Boolean);
}

function normalizeCloudBook(rawBook, fallbackDevice = {}) {
  if (!rawBook || typeof rawBook !== 'object') return null;
  const bookKey = String(rawBook.bookKey || rawBook.book_key || rawBook.id || '').trim();
  if (!bookKey) return null;

  const meta = rawBook.metadata_json && typeof rawBook.metadata_json === 'object' ? rawBook.metadata_json : {};
  const driveFileId = String(rawBook.driveFileId || rawBook.drive_file_id || '').trim();
  const driveFolderId = String(
    rawBook.driveFolderId || rawBook.drive_folder_id || meta.driveFolderId || ''
  ).trim();
  const coverDriveFileId = String(rawBook.coverDriveFileId || meta.coverDriveFileId || '').trim();
  const rawCoverUrl = String(rawBook.coverUrl || rawBook.cover_url || '').trim();
  const coverUrl = rawCoverUrl.startsWith('blob:') ? '' : rawCoverUrl;

  const rawChapters = rawBook.chapters_json ?? rawBook.chapters ?? meta.chapters;
  const chapters = sanitizeMediaList(rawChapters);

  const rawTracks = rawBook.tracks ?? meta.tracks;
  const tracks = sanitizeMediaList(rawTracks);

  const rawSeriesOrder = rawBook.seriesOrder ?? meta.seriesOrder;
  const seriesOrder =
    rawSeriesOrder != null && rawSeriesOrder !== '' && Number.isFinite(Number(rawSeriesOrder))
      ? Number(rawSeriesOrder)
      : null;

  const driveStreamUrl =
    String(rawBook.driveStreamUrl || '').trim() ||
    (driveFileId ? buildDriveStreamUrl(driveFileId) : '') ||
    (tracks.find((t) => t.driveStreamUrl)?.driveStreamUrl || '') ||
    (chapters.find((c) => c.driveStreamUrl)?.driveStreamUrl || '');

  const rawSources = Array.isArray(rawBook.sources) ? rawBook.sources.filter(Boolean) : [];
  const hasDriveMedia = Boolean(
    driveFileId ||
      driveStreamUrl ||
      tracks.some((t) => t.driveFileId || t.driveStreamUrl) ||
      chapters.some((c) => c.driveFileId || c.driveStreamUrl)
  );
  const sources = Array.from(new Set(hasDriveMedia && !rawSources.includes('drive') ? [...rawSources, 'drive'] : rawSources));

  const enrichmentCheckedAt = rawBook.enrichmentCheckedAt || meta.enrichmentCheckedAt || null;
  const originDeviceId = rawBook.originDeviceId || meta.originDeviceId || fallbackDevice.deviceId || null;
  const originDeviceName = rawBook.originDeviceName || meta.originDeviceName || fallbackDevice.deviceName || null;
  const updatedAt = rawBook.updatedAt || meta.updatedAt || rawBook.updated_at || new Date().toISOString();

  return {
    id: bookKey,
    bookKey,
    title: rawBook.title || 'Untitled',
    author: rawBook.author || '',
    narrator: rawBook.narrator || '',
    series: rawBook.series || '',
    seriesOrder,
    description: rawBook.description ?? meta.description ?? '',
    coverUrl,
    coverDriveFileId,
    totalDurationSec: Number(rawBook.totalDurationSec ?? rawBook.total_duration_sec ?? rawBook.durationSec ?? 0),
    sources,
    driveFileId,
    driveStreamUrl,
    driveFolderId,
    chapters,
    tracks,
    ...(enrichmentCheckedAt ? { enrichmentCheckedAt } : {}),
    ...(originDeviceId ? { originDeviceId } : {}),
    ...(originDeviceName ? { originDeviceName } : {}),
    updatedAt
  };
}

function mergeCloudBook(existingBook, incomingBook) {
  if (!existingBook) return incomingBook;
  if (!incomingBook) return existingBook;

  const existingTs = toEpochMs(existingBook.updatedAt);
  const incomingTs = toEpochMs(incomingBook.updatedAt);
  const newer = incomingTs >= existingTs ? incomingBook : existingBook;
  const older = incomingTs >= existingTs ? existingBook : incomingBook;

  const tracks =
    Array.isArray(newer.tracks) && newer.tracks.length > 0
      ? newer.tracks
      : Array.isArray(older.tracks)
        ? older.tracks
        : [];
  const chapters =
    Array.isArray(newer.chapters) && newer.chapters.length > 0
      ? newer.chapters
      : Array.isArray(older.chapters)
        ? older.chapters
        : [];
  const driveFileId = newer.driveFileId || older.driveFileId || '';
  const driveStreamUrl = newer.driveStreamUrl || older.driveStreamUrl || (driveFileId ? buildDriveStreamUrl(driveFileId) : '');
  const driveFolderId = newer.driveFolderId || older.driveFolderId || '';
  const coverDriveFileId = newer.coverDriveFileId || older.coverDriveFileId || '';
  const hasDriveMedia = Boolean(
    driveFileId ||
      driveStreamUrl ||
      tracks.some((t) => t.driveFileId || t.driveStreamUrl) ||
      chapters.some((c) => c.driveFileId || c.driveStreamUrl)
  );
  const combinedSources = Array.from(
    new Set([
      ...(Array.isArray(older.sources) ? older.sources : []),
      ...(Array.isArray(newer.sources) ? newer.sources : []),
      ...(hasDriveMedia ? ['drive'] : [])
    ])
  );

  return {
    ...older,
    ...newer,
    coverUrl: newer.coverUrl || older.coverUrl || '',
    coverDriveFileId,
    driveFileId,
    driveStreamUrl,
    driveFolderId,
    tracks,
    chapters,
    sources: combinedSources,
    totalDurationSec: Number(newer.totalDurationSec || older.totalDurationSec || 0),
    originDeviceId: newer.originDeviceId || older.originDeviceId || null,
    originDeviceName: newer.originDeviceName || older.originDeviceName || null,
    updatedAt: newer.updatedAt || older.updatedAt
  };
}

function normalizeDeviceRecord(row, currentDeviceId) {
  if (!row || typeof row !== 'object') return null;
  const deviceId = String(row.device_id ?? row.deviceId ?? '').trim();
  if (!deviceId) return null;
  const currentBookKey = row.current_book_key ?? row.currentBookKey ?? row.active_book_key ?? row.activeBookKey ?? null;
  const currentChapterIndex = Number(
    row.current_chapter_index ?? row.currentChapterIndex ?? row.chapterIndex ?? 0
  );
  const currentPositionSec = Number(
    row.current_position_sec ?? row.currentPositionSec ?? row.positionSec ?? 0
  );
  const lastSeenAt = row.last_seen_at ?? row.lastSeenAt ?? null;
  const isPlaying = Boolean(row.is_playing ?? row.isPlaying);
  const isActivePlayer = Boolean(row.is_active_player ?? row.isActivePlayer ?? isPlaying);
  return {
    deviceId,
    deviceName: row.device_name ?? row.deviceName ?? 'Device',
    platform: row.platform ?? 'web',
    activeBookKey: currentBookKey,
    currentBookKey,
    activeBookTitle: row.active_book_title ?? row.activeBookTitle ?? '',
    chapterIndex: Number.isFinite(currentChapterIndex) ? currentChapterIndex : 0,
    currentChapterIndex: Number.isFinite(currentChapterIndex) ? currentChapterIndex : 0,
    positionSec: Number.isFinite(currentPositionSec) ? currentPositionSec : 0,
    currentPositionSec: Number.isFinite(currentPositionSec) ? currentPositionSec : 0,
    durationSec: Number(row.duration_sec ?? row.durationSec ?? 0),
    isPlaying,
    isActivePlayer,
    lastSeenAt,
    isCurrentDevice: deviceId === currentDeviceId
  };
}

function createEmptyDriveSyncPayload() {
  return {
    version: 1,
    driveFolder: null,
    library: {},
    progress: {},
    bookmarks: [],
    devices: {}
  };
}

function normalizeDriveSyncPayload(raw) {
  if (!raw || typeof raw !== 'object') return createEmptyDriveSyncPayload();
  const base = createEmptyDriveSyncPayload();
  base.version = Number(raw.version || 1);
  if (raw.driveFolder && typeof raw.driveFolder === 'object') {
    base.driveFolder = {
      folderId: String(raw.driveFolder.folderId || ''),
      folderName: String(raw.driveFolder.folderName || ''),
      ...(raw.driveFolder.lastActiveBookKey ? { lastActiveBookKey: raw.driveFolder.lastActiveBookKey } : {}),
      updatedAt: raw.driveFolder.updatedAt || null
    };
  }
  if (raw.library && typeof raw.library === 'object' && !Array.isArray(raw.library)) {
    for (const [key, book] of Object.entries(raw.library)) {
      const normalized = normalizeCloudBook({ ...book, bookKey: book?.bookKey || key });
      if (normalized?.bookKey) {
        base.library[normalized.bookKey] = normalized;
      }
    }
  }
  if (raw.progress && typeof raw.progress === 'object' && !Array.isArray(raw.progress)) {
    for (const [key, cp] of Object.entries(raw.progress)) {
      const mapped = mapProgressRowToClient({ ...cp, bookKey: cp?.bookKey || cp?.book_key || key });
      if (mapped?.bookKey) {
        base.progress[mapped.bookKey] = mapped;
      }
    }
  }
  if (Array.isArray(raw.bookmarks)) {
    base.bookmarks = raw.bookmarks.map(mapBookmarkRowToClient).filter(Boolean);
  }
  if (raw.devices && typeof raw.devices === 'object' && !Array.isArray(raw.devices)) {
    for (const [devId, dev] of Object.entries(raw.devices)) {
      if (dev && typeof dev === 'object') {
        base.devices[devId] = { ...dev, deviceId: dev.deviceId || devId };
      }
    }
  }
  return base;
}

function mergeDriveSyncPayloads(remoteRaw, delta = {}) {
  const remote = normalizeDriveSyncPayload(remoteRaw);
  const merged = {
    version: 1,
    driveFolder: remote.driveFolder,
    library: { ...remote.library },
    progress: { ...remote.progress },
    bookmarks: [...remote.bookmarks],
    devices: { ...remote.devices }
  };

  if (delta.driveFolder && typeof delta.driveFolder === 'object') {
    const remoteTs = toEpochMs(remote.driveFolder?.updatedAt);
    const deltaTs = toEpochMs(delta.driveFolder.updatedAt);
    if (!remote.driveFolder || deltaTs >= remoteTs) {
      merged.driveFolder = {
        folderId: String(delta.driveFolder.folderId || ''),
        folderName: String(delta.driveFolder.folderName || ''),
        ...(delta.driveFolder.lastActiveBookKey
          ? { lastActiveBookKey: delta.driveFolder.lastActiveBookKey }
          : remote.driveFolder?.lastActiveBookKey
            ? { lastActiveBookKey: remote.driveFolder.lastActiveBookKey }
            : {}),
        updatedAt: delta.driveFolder.updatedAt || new Date().toISOString()
      };
    }
  }

  if (delta.replaceLibrary) {
    merged.library = {};
  }
  if (Array.isArray(delta.deleteBookKeys)) {
    for (const key of delta.deleteBookKeys) {
      delete merged.library[key];
    }
  }
  if (delta.library && typeof delta.library === 'object') {
    for (const [key, book] of Object.entries(delta.library)) {
      const normalized = normalizeCloudBook({ ...book, bookKey: book?.bookKey || key });
      if (!normalized?.bookKey) continue;
      merged.library[normalized.bookKey] = mergeCloudBook(merged.library[normalized.bookKey], normalized);
    }
  }

  if (delta.progress && typeof delta.progress === 'object') {
    for (const [key, cp] of Object.entries(delta.progress)) {
      const mapped = mapProgressRowToClient({ ...cp, bookKey: cp?.bookKey || cp?.book_key || key });
      if (!mapped?.bookKey) continue;
      merged.progress[mapped.bookKey] = resolveProgressConflict(merged.progress[mapped.bookKey], mapped);
    }
  }

  if (Array.isArray(delta.bookmarks) && delta.bookmarks.length > 0) {
    const byKey = new Map();
    for (const bm of [...merged.bookmarks, ...delta.bookmarks.map(mapBookmarkRowToClient).filter(Boolean)]) {
      const dedupeKey = bm.id || `${bm.bookKey}:${bm.chapterIndex}:${Math.round(bm.positionSec)}`;
      const existing = byKey.get(dedupeKey);
      if (!existing || toEpochMs(bm.clientUpdatedAt) >= toEpochMs(existing.clientUpdatedAt)) {
        byKey.set(dedupeKey, bm);
      }
    }
    merged.bookmarks = Array.from(byKey.values());
  }

  if (delta.devices && typeof delta.devices === 'object') {
    for (const [devId, dev] of Object.entries(delta.devices)) {
      if (!dev || typeof dev !== 'object') continue;
      const existing = merged.devices[devId];
      if (!existing || toEpochMs(dev.lastSeenAt) >= toEpochMs(existing.lastSeenAt)) {
        merged.devices[devId] = { ...dev, deviceId: dev.deviceId || devId };
      }
    }
  }

  return merged;
}

function mapProgressRowToClient(row) {
  if (!row) return null;
  return {
    bookKey: row.book_key ?? row.bookKey,
    chapterIndex: Number(row.chapter_index ?? row.chapterIndex ?? 0),
    positionSec: Number(row.position_sec ?? row.positionSec ?? 0),
    durationSec: Number(row.duration_sec ?? row.durationSec ?? 0),
    playbackRate: Number(row.playback_rate ?? row.playbackRate ?? 1),
    completed: Boolean(row.is_finished ?? row.completed),
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
 * Google Drive appDataFolder cloud sync, Realtime WebSocket / BroadcastChannel
 * cross-device playback handoff, and automatic offline queue flushing.
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

    this.driveSyncFileId = null;
    this.lastDriveSyncModifiedTime = null;
    this.needsDriveSyncReauth = false;
    this._lastDrivePayload = null;
    this._lastLocalDeviceState = null;
    this._driveWriteQueue = Promise.resolve();

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
   * Returns true if either a Supabase session or a Google OAuth token is active for cloud sync.
   * @returns {boolean}
   */
  hasCloudSyncAuth() {
    return Boolean(this.isAuthenticated() || this.getGoogleAccessToken());
  }

  /**
   * Refreshes the Supabase access token using session.refresh_token when expired or nearing expiry.
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<{ refreshed: boolean, session: object|null }>}
   */
  async refreshSupabaseSessionIfNeeded(options = {}) {
    const refreshToken = this.session?.refresh_token;
    if (!refreshToken || !this.fetchImpl || !this._isOnline()) {
      return { refreshed: false, session: this.session };
    }

    const decodeJwtExpMs = (jwt) => {
      try {
        const parts = String(jwt || '').split('.');
        if (parts.length !== 3 || typeof atob !== 'function') return 0;
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        return payload?.exp ? Number(payload.exp) * 1000 : 0;
      } catch {
        return 0;
      }
    };

    const expiresAtMs = this.session?.expires_at
      ? Number(this.session.expires_at) * 1000
      : decodeJwtExpMs(this.session?.access_token);

    if (!options.force && expiresAtMs > 0 && Date.now() < expiresAtMs - 60_000) {
      return { refreshed: false, session: this.session };
    }

    try {
      const res = await this.fetchImpl(`${this.config.url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: {
          apikey: this.config.publishableKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ refresh_token: refreshToken })
      });
      if (!res.ok) {
        return { refreshed: false, session: this.session };
      }
      const data = await res.json();
      if (!data?.access_token) {
        return { refreshed: false, session: this.session };
      }
      const updated = {
        ...this.session,
        access_token: data.access_token,
        refresh_token: data.refresh_token || refreshToken,
        expires_in: Number(data.expires_in || this.session.expires_in || 3600),
        expires_at: data.expires_at || Math.floor(Date.now() / 1000) + Number(data.expires_in || 3600),
        user: data.user || this.session.user
      };
      this._saveSession(updated);
      return { refreshed: true, session: updated };
    } catch {
      return { refreshed: false, session: this.session };
    }
  }

  /**
   * Manually sets or clears the active session (useful for auth restoration and testing).
   * @param {object|null} session
   */
  setSession(session) {
    this._saveSession(session);
  }

  _loadManualGoogleToken() {
    if (!this.storage) return null;
    try {
      return this.storage.getItem(GOOGLE_TOKEN_STORAGE_KEY) || null;
    } catch {
      return null;
    }
  }

  /**
   * Persists a Google OAuth provider token for Google Drive API v3 calls.
   * @param {string|null} token
   */
  setGoogleAccessToken(token) {
    const clean = typeof token === 'string' ? token.trim() : '';
    if (clean) {
      this.needsDriveSyncReauth = false;
    } else {
      this.driveSyncFileId = null;
      this.lastDriveSyncModifiedTime = null;
      this._lastDrivePayload = null;
    }
    if (this.storage) {
      try {
        if (clean) {
          this.storage.setItem(GOOGLE_TOKEN_STORAGE_KEY, clean);
        } else {
          this.storage.removeItem(GOOGLE_TOKEN_STORAGE_KEY);
        }
      } catch {
        // Ignore storage failures
      }
    }
    if (this.session) {
      this._saveSession({
        ...this.session,
        provider_token: clean || null
      });
    }
  }

  /**
   * Returns the Google OAuth provider token if available (for Google Drive API v3 calls).
   * @returns {string|null}
   */
  getGoogleAccessToken() {
    return (
      this.session?.provider_token ||
      this.session?.googleAccessToken ||
      this._loadManualGoogleToken() ||
      null
    );
  }

  /**
   * Returns the configured Google OAuth Client ID (falling back to the local default).
   * @returns {string}
   */
  getGoogleClientId() {
    if (this.storage) {
      try {
        const stored = this.storage.getItem(GOOGLE_CLIENT_ID_STORAGE_KEY);
        if (stored !== null) return stored.trim();
      } catch {
        // Ignore storage errors
      }
    }
    return this.config.googleClientId || DEFAULT_GOOGLE_CLIENT_ID;
  }

  /**
   * Persists a custom Google OAuth Client ID (or clears to revert to default).
   * @param {string|null} clientId
   */
  setGoogleClientId(clientId) {
    if (!this.storage) return;
    const clean = typeof clientId === 'string' ? clientId.trim() : '';
    try {
      if (clean) {
        this.storage.setItem(GOOGLE_CLIENT_ID_STORAGE_KEY, clean);
      } else {
        this.storage.removeItem(GOOGLE_CLIENT_ID_STORAGE_KEY);
      }
    } catch {
      // Ignore storage errors
    }
  }

  _isTauriEnvironment() {
    const origin = this.windowObj?.location?.origin || '';
    return Boolean(
      this.windowObj?.__TAURI__ ||
        this.windowObj?.__TAURI_INTERNALS__ ||
        /tauri\.localhost/i.test(origin)
    );
  }

  _isCapacitorEnvironment() {
    const origin = this.windowObj?.location?.origin || '';
    const protocol = this.windowObj?.location?.protocol || '';
    const ua = this.navigatorObj?.userAgent || '';
    return Boolean(
      this.windowObj?.Capacitor ||
        protocol === 'capacitor:' ||
        /^capacitor:\/\//i.test(origin) ||
        (/Android/i.test(ua) && /^https?:\/\/localhost(?::\d+)?$/i.test(origin))
    );
  }

  /**
   * Queries Supabase /auth/v1/settings to inspect enabled auth providers before navigating.
   * @param {{ forceRefresh?: boolean }} [options]
   * @returns {Promise<object|null>}
   */
  async getAuthSettings({ forceRefresh = false } = {}) {
    if (!forceRefresh && this._authSettings) {
      return this._authSettings;
    }
    if (!this.fetchImpl || !this._isOnline()) {
      return null;
    }
    try {
      const res = await this.fetchImpl(`${this.config.url}/auth/v1/settings`, {
        headers: {
          apikey: this.config.publishableKey
        }
      });
      if (!res.ok) return null;
      const data = await res.json();
      this._authSettings = data;
      return data;
    } catch {
      return null;
    }
  }

  /**
   * Restores and validates any persisted Supabase or Google OAuth session.
   * Returns the validated session or null when signed out / expired.
   * @returns {Promise<object|null>}
   */
  async restoreSession() {
    this.session = this._loadSession();
    if (!this.session) {
      return null;
    }

    if (this.session.auth_mode === 'google_oauth' && !this.session.access_token) {
      const googleToken = this.getGoogleAccessToken();
      if (googleToken && this._isOnline() && this.fetchImpl) {
        try {
          const res = await this.fetchImpl('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${googleToken}` }
          });
          if (res.ok) {
            const info = await res.json();
            const updatedUser = {
              ...(this.session.user || {}),
              id: info.sub ? `google_${info.sub}` : (this.session.user?.id || 'google_user'),
              email: info.email || this.session.user?.email || '',
              user_metadata: {
                ...(this.session.user?.user_metadata || {}),
                email: info.email || this.session.user?.email || '',
                name: info.name || this.session.user?.user_metadata?.name || '',
                full_name: info.name || this.session.user?.user_metadata?.full_name || '',
                avatar_url: info.picture || this.session.user?.user_metadata?.avatar_url || '',
                picture: info.picture || this.session.user?.user_metadata?.picture || ''
              }
            };
            this._saveSession({ ...this.session, user: updatedUser });
          } else if (res.status === 401 || res.status === 403) {
            this.setGoogleAccessToken(null);
          }
        } catch {
          // Offline fallback: keep persisted Google user profile
        }
      }
      return this.session?.user ? this.session : null;
    }

    if (!this.session?.access_token) {
      return null;
    }
    if (this._isOnline() && this.fetchImpl) {
      try {
        const res = await this.fetchImpl(`${this.config.url}/auth/v1/user`, {
          headers: {
            apikey: this.config.publishableKey,
            Authorization: `Bearer ${this.session.access_token}`
          }
        });
        if (res.ok) {
          const user = await res.json();
          this._saveSession({ ...this.session, user });
          return this.session;
        }
        if (res.status === 401 || res.status === 403) {
          this._saveSession(null);
          return null;
        }
      } catch {
        // Offline fallback: keep persisted user session if user object exists
      }
    }
    return this.session?.user ? this.session : null;
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
   * Signs in with Gmail + password via Supabase /auth/v1/token?grant_type=password,
   * automatically creating the account via /auth/v1/signup if it does not exist yet.
   * @param {string} emailInput
   * @param {string} passwordInput
   * @returns {Promise<{ ok: boolean, session: object|null, created?: boolean, confirmationRequired?: boolean, error?: string }>}
   */
  async signInWithEmail(emailInput, passwordInput) {
    const email = String(emailInput || '').trim().toLowerCase();
    const password = String(passwordInput || '');

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, session: null, error: 'Enter a valid Gmail address.' };
    }
    if (password.length < 6) {
      return { ok: false, session: null, error: 'Password must be at least 6 characters.' };
    }
    if (!this.fetchImpl) {
      return { ok: false, session: null, error: 'Network fetch is unavailable.' };
    }
    if (!this._isOnline()) {
      return { ok: false, session: null, error: 'You appear to be offline.' };
    }

    const avatarUrl = await computeGravatarUrl(email);
    const displayName = deriveDisplayNameFromEmail(email);

    const finalizeSession = (data, created = false) => {
      const existingMeta = data.user?.user_metadata || {};
      const enrichedUser = {
        ...data.user,
        email: data.user?.email || email,
        user_metadata: {
          ...existingMeta,
          email: existingMeta.email || email,
          full_name: existingMeta.full_name || existingMeta.name || displayName,
          name: existingMeta.name || existingMeta.full_name || displayName,
          avatar_url: existingMeta.avatar_url || existingMeta.picture || avatarUrl,
          picture: existingMeta.picture || existingMeta.avatar_url || avatarUrl
        }
      };
      const session = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || null,
        provider_token: this.getGoogleAccessToken() || null,
        expires_in: Number(data.expires_in || 3600),
        token_type: data.token_type || 'bearer',
        user: enrichedUser
      };
      this._saveSession(session);
      this.connectRealtime();
      void this.flushOfflineQueue();
      return { ok: true, session, created, confirmationRequired: false };
    };

    try {
      const signInRes = await this.fetchImpl(
        `${this.config.url}/auth/v1/token?grant_type=password`,
        {
          method: 'POST',
          headers: {
            apikey: this.config.publishableKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ email, password })
        }
      );

      const signInText = typeof signInRes.text === 'function' ? await signInRes.text() : '';
      const signInData = signInText ? JSON.parse(signInText) : {};

      if (signInRes.ok && signInData?.access_token) {
        return finalizeSession(signInData, false);
      }

      const signInMsg = parseAuthErrorMessage(signInData, 'Invalid login credentials');
      if (/email not confirmed/i.test(signInMsg)) {
        return {
          ok: false,
          session: null,
          confirmationRequired: true,
          error: 'Confirm your Gmail verification link first, then click Sign In with Gmail.'
        };
      }

      const looksLikeMissingOrInvalid =
        signInRes.status === 400 &&
        /invalid login credentials|invalid_credentials|invalid_grant/i.test(signInMsg);
      if (!looksLikeMissingOrInvalid) {
        return { ok: false, session: null, error: signInMsg };
      }

      // Account may not exist yet — try automatic sign-up
      const signupRes = await this.fetchImpl(`${this.config.url}/auth/v1/signup`, {
        method: 'POST',
        headers: {
          apikey: this.config.publishableKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email,
          password,
          data: {
            full_name: displayName,
            name: displayName,
            avatar_url: avatarUrl,
            picture: avatarUrl
          }
        })
      });

      const signupText = typeof signupRes.text === 'function' ? await signupRes.text() : '';
      const signupData = signupText ? JSON.parse(signupText) : {};

      if (signupRes.ok && signupData?.access_token) {
        return finalizeSession(signupData, true);
      }

      if (signupRes.ok && (signupData?.id || signupData?.user?.id)) {
        return {
          ok: false,
          session: null,
          created: true,
          confirmationRequired: true,
          error: `Account created for ${email}! Open the confirmation email in Gmail, then click Sign In.`
        };
      }

      const signupMsg = parseAuthErrorMessage(signupData, signInMsg);
      if (/already registered|already exists|user_already_exists/i.test(signupMsg)) {
        return {
          ok: false,
          session: null,
          error: 'Incorrect password for this Gmail account.'
        };
      }
      return { ok: false, session: null, error: signupMsg };
    } catch (err) {
      return {
        ok: false,
        session: null,
        error: err?.message || 'Unable to reach authentication server.'
      };
    }
  }

  /**
   * Fetches Google userinfo using a Google OAuth access token, persists Drive access,
   * and links/updates the active session with real Gmail email, name, and photo.
   * @param {string} accessToken
   * @returns {Promise<{ ok: boolean, session: object|null, profile?: object, error?: string }>}
   */
  async completeGoogleOAuthToken(accessToken) {
    const cleanToken = String(accessToken || '').trim();
    if (!cleanToken) {
      return { ok: false, session: null, error: 'Missing Google access token.' };
    }

    let info = {};
    if (this.fetchImpl) {
      try {
        const res = await this.fetchImpl('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${cleanToken}` }
        });
        if (res.ok) {
          info = await res.json();
        }
      } catch {
        // Proceed with token even if userinfo lookup fails
      }
    }

    this.setGoogleAccessToken(cleanToken);
    const email = info.email || this.session?.user?.email || '';
    const displayName =
      info.name ||
      this.session?.user?.user_metadata?.full_name ||
      deriveDisplayNameFromEmail(email);
    const avatarUrl =
      info.picture ||
      this.session?.user?.user_metadata?.avatar_url ||
      (email ? await computeGravatarUrl(email) : '');

    if (this.isAuthenticated()) {
      const updated = {
        ...this.session,
        provider_token: cleanToken,
        user: {
          ...this.session.user,
          email: this.session.user.email || email,
          user_metadata: {
            ...(this.session.user.user_metadata || {}),
            email,
            name: displayName,
            full_name: displayName,
            avatar_url: avatarUrl,
            picture: avatarUrl
          }
        }
      };
      this._saveSession(updated);
      return { ok: true, session: updated, profile: this.getUserProfile() };
    }

    const googleSession = {
      access_token: null,
      provider_token: cleanToken,
      auth_mode: 'google_oauth',
      user: {
        id: info.sub ? `google_${info.sub}` : 'google_user',
        email,
        user_metadata: {
          email,
          name: displayName,
          full_name: displayName,
          avatar_url: avatarUrl,
          picture: avatarUrl
        }
      }
    };
    this._saveSession(googleSession);
    return { ok: true, session: googleSession, profile: this.getUserProfile() };
  }

  /**
   * Loads Google Identity Services (accounts.google.com/gsi/client) on demand.
   * @returns {Promise<boolean>}
   */
  async _ensureGoogleIdentityScript() {
    if (this.windowObj?.google?.accounts?.oauth2) return true;
    if (typeof document === 'undefined' || typeof globalThis.window === 'undefined') return false;

    return new Promise((resolve) => {
      const existing = document.querySelector('script[src*="accounts.google.com/gsi/client"]');
      if (existing) {
        const timer = setTimeout(() => resolve(Boolean(globalThis.window?.google?.accounts?.oauth2)), 4000);
        existing.addEventListener('load', () => {
          clearTimeout(timer);
          resolve(Boolean(globalThis.window?.google?.accounts?.oauth2));
        }, { once: true });
        existing.addEventListener('error', () => {
          clearTimeout(timer);
          resolve(false);
        }, { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      const timer = setTimeout(() => resolve(Boolean(globalThis.window?.google?.accounts?.oauth2)), 5000);
      script.onload = () => {
        clearTimeout(timer);
        resolve(Boolean(globalThis.window?.google?.accounts?.oauth2));
      };
      script.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
      document.head.appendChild(script);
    });
  }

  /**
   * Runs direct Google OAuth via native Tauri popup, Android native bridge, GIS Token Client,
   * or browser popup window (never replacing the main window).
   * @param {object} [options]
   * @returns {Promise<{ ok: boolean, session?: object|null, reason?: string, error?: string }>}
   */
  async signInWithGooglePopup(options = {}) {
    const clientId = (options.clientId || this.getGoogleClientId() || '').trim();
    if (!clientId) {
      return {
        ok: false,
        reason: 'no_google_client_id',
        error: 'No Google Client ID configured.'
      };
    }

    const scopes = options.scopes || DEFAULT_GOOGLE_SCOPES;
    const promptValue = options.forceConsent ? 'select_account consent' : (options.prompt || 'select_account');

    // 1. Native Tauri Desktop Google Sign-In Popup (opens dedicated WebviewWindow to accounts.google.com)
    const tauriInvoke = this.windowObj?.__TAURI_INTERNALS__?.invoke || this.windowObj?.__TAURI__?.core?.invoke;
    if (!options.forceBrowserPopup && this._isTauriEnvironment() && typeof tauriInvoke === 'function') {
      try {
        const startRes = await tauriInvoke('desktop_start_google_oauth', {
          silent: Boolean(options.silent),
          loginHint: options.hint || null,
          forceRefresh: Boolean(options.forceRefresh || options.forceConsent),
          forceConsent: Boolean(options.forceConsent)
        });
        if (startRes?.status === 'success' && startRes?.accessToken) {
          return await this.completeGoogleOAuthToken(startRes.accessToken);
        }
        const startedAt = Date.now();
        while (Date.now() - startedAt < 180000) {
          await new Promise((r) => setTimeout(r, 350));
          const pollRes = await tauriInvoke('desktop_poll_google_oauth', {});
          if (pollRes?.status === 'success' && pollRes?.accessToken) {
            return await this.completeGoogleOAuthToken(pollRes.accessToken);
          }
          if (pollRes?.status === 'closed') {
            return {
              ok: false,
              reason: 'popup_closed',
              error: 'Google sign-in popup was closed.'
            };
          }
          if (pollRes?.status === 'needs_interactive' && options.silent) {
            return this.signInWithGooglePopup({ ...options, silent: false });
          }
        }
        return {
          ok: false,
          reason: 'oauth_timeout',
          error: 'Google sign-in timed out.'
        };
      } catch (err) {
        return {
          ok: false,
          reason: 'tauri_oauth_error',
          error: err?.message || 'Unable to open Google sign-in popup.'
        };
      }
    }

    // 2. Native Android (Capacitor) Google Sign-In Bridge if registered by the .apk shell
    if (this._isCapacitorEnvironment() && typeof this.windowObj?.__ANDROID_GOOGLE_OAUTH__ === 'function') {
      try {
        const androidRes = await this.windowObj.__ANDROID_GOOGLE_OAUTH__(
          clientId,
          scopes,
          options.hint || '',
          {
            forceConsent: Boolean(options.forceConsent),
            forceRefresh: Boolean(options.forceRefresh)
          }
        );
        if (androidRes?.access_token || androidRes?.accessToken) {
          return await this.completeGoogleOAuthToken(androidRes.access_token || androidRes.accessToken);
        }
        return {
          ok: false,
          reason: androidRes?.error || 'android_oauth_cancelled',
          error: androidRes?.error_description || 'Google sign-in did not complete.'
        };
      } catch (err) {
        return {
          ok: false,
          reason: 'android_oauth_error',
          error: err?.message || 'Google sign-in popup failed on Android.'
        };
      }
    }

    const nativeOAuthBridge = this.windowObj?.AudiobookOAuthNative;
    if (this._isCapacitorEnvironment() && typeof nativeOAuthBridge?.startGoogleOAuth === 'function') {
      const parseNativePayload = (raw) => {
        if (!raw) return null;
        if (typeof raw === 'string') {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        }
        return typeof raw === 'object' ? raw : null;
      };

      const initialPending = parseNativePayload(nativeOAuthBridge.consumePendingResult?.());
      if (initialPending?.access_token || initialPending?.accessToken) {
        return await this.completeGoogleOAuthToken(
          initialPending.access_token || initialPending.accessToken
        );
      }

      const randomNonce =
        typeof globalThis.crypto?.randomUUID === 'function'
          ? globalThis.crypto.randomUUID().replace(/-/g, '')
          : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const state = `android_${randomNonce}`;
      const redirectUri = 'https://larxe1.github.io/Audiobook-Player/oauth-callback.html';
      const cancelDelayMs = Math.max(0, Number(options.androidCancelDelayMs ?? 1800));
      const doc = this.windowObj?.document || (typeof document !== 'undefined' ? document : null);

      return await new Promise((resolve) => {
        let settled = false;
        let cancelTimer = null;
        let overallTimer = null;

        const cleanup = () => {
          if (cancelTimer) {
            clearTimeout(cancelTimer);
            cancelTimer = null;
          }
          if (overallTimer) {
            clearTimeout(overallTimer);
            overallTimer = null;
          }
          if (doc && typeof doc.removeEventListener === 'function') {
            doc.removeEventListener('visibilitychange', onReturnToApp);
          }
          if (this.windowObj && typeof this.windowObj.removeEventListener === 'function') {
            this.windowObj.removeEventListener('visibilitychange', onReturnToApp);
            this.windowObj.removeEventListener('focus', onReturnToApp);
          }
          if (this.windowObj && this.windowObj.__onAndroidGoogleOAuthResult === onAndroidResult) {
            delete this.windowObj.__onAndroidGoogleOAuthResult;
          }
        };

        const finish = (result) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };

        const handlePayload = async (rawPayload) => {
          const payload = parseNativePayload(rawPayload);
          if (!payload || settled) return;

          if (payload.state !== state) {
            if (payload.error && !payload.state) {
              finish({
                ok: false,
                reason: payload.error || 'android_oauth_cancelled',
                error: payload.error_description || 'Google sign-in did not complete.'
              });
              return;
            }
            finish({
              ok: false,
              reason: 'oauth_state_mismatch',
              error: 'Google sign-in state verification failed.'
            });
            return;
          }

          if (payload.error) {
            finish({
              ok: false,
              reason: payload.error || 'android_oauth_cancelled',
              error: payload.error_description || 'Google sign-in was cancelled or rejected.'
            });
            return;
          }

          const token = payload.access_token || payload.accessToken;
          if (token) {
            settled = true;
            cleanup();
            resolve(await this.completeGoogleOAuthToken(token));
            return;
          }

          finish({
            ok: false,
            reason: 'android_oauth_cancelled',
            error: 'Google sign-in did not return an access token.'
          });
        };

        const onAndroidResult = (rawPayload) => {
          void handlePayload(rawPayload);
        };

        const checkPendingResult = () => {
          const pending = parseNativePayload(nativeOAuthBridge.consumePendingResult?.());
          if (pending) {
            void handlePayload(pending);
            return true;
          }
          return false;
        };

        const onReturnToApp = () => {
          if (settled) return;
          if (doc && (doc.hidden || doc.visibilityState === 'hidden')) {
            return;
          }
          if (checkPendingResult()) return;
          if (!cancelTimer) {
            cancelTimer = setTimeout(() => {
              if (settled) return;
              if (checkPendingResult()) return;
              finish({
                ok: false,
                reason: 'popup_closed',
                error: 'Google sign-in was cancelled.'
              });
            }, cancelDelayMs);
          }
        };

        this.windowObj.__onAndroidGoogleOAuthResult = onAndroidResult;

        if (doc && typeof doc.addEventListener === 'function') {
          doc.addEventListener('visibilitychange', onReturnToApp);
        }
        if (this.windowObj && typeof this.windowObj.addEventListener === 'function') {
          this.windowObj.addEventListener('visibilitychange', onReturnToApp);
          this.windowObj.addEventListener('focus', onReturnToApp);
        }

        overallTimer = setTimeout(() => {
          finish({
            ok: false,
            reason: 'oauth_timeout',
            error: 'Google sign-in timed out.'
          });
        }, 180000);

        try {
          let started;
          try {
            started = nativeOAuthBridge.startGoogleOAuth(
              clientId,
              scopes,
              options.hint || '',
              state,
              redirectUri,
              promptValue
            );
          } catch (bridgeErr) {
            const msg = String(bridgeErr?.message || bridgeErr || '');
            if (
              /wrong number of arguments|method not found|no such method|overload|parameter count|argument/i.test(
                msg
              )
            ) {
              started = nativeOAuthBridge.startGoogleOAuth(
                clientId,
                scopes,
                options.hint || '',
                state,
                redirectUri
              );
            } else {
              throw bridgeErr;
            }
          }
          if (started === false) {
            finish({
              ok: false,
              reason: 'android_oauth_error',
              error: 'Unable to open Google sign-in in Chrome Custom Tabs.'
            });
          }
        } catch (err) {
          finish({
            ok: false,
            reason: 'android_oauth_error',
            error: err?.message || 'Google sign-in failed on Android.'
          });
        }
      });
    }

    // 3. Browser / PWA: try Google Identity Services token client first, falling back to popup window
    const openBrowserOAuthPopup = () => {
      if (typeof this.windowObj?.open !== 'function') {
        return Promise.resolve({
          ok: false,
          reason: 'popup_unavailable',
          error: 'Google sign-in popup is unavailable in this window.'
        });
      }

      const origin = this.windowObj?.location?.origin || 'http://localhost';
      const pathname = this.windowObj?.location?.pathname || '/';
      const redirectUri = options.redirectTo || `${origin}${pathname}`;
      const authParams = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'token',
        scope: scopes,
        include_granted_scopes: 'true',
        prompt: promptValue
      });
      if (options.hint) authParams.set('login_hint', options.hint);
      const oauthUrl = `https://accounts.google.com/o/oauth2/v2/auth?${authParams.toString()}`;
      let popup = null;
      try {
        popup = this.windowObj.open(
          oauthUrl,
          'audiobook_google_oauth',
          'width=500,height=680,menubar=no,toolbar=no'
        );
      } catch {
        popup = null;
      }

      if (!popup || (this._isCapacitorEnvironment() && typeof popup.closed !== 'boolean')) {
        return Promise.resolve({
          ok: false,
          reason: 'popup_blocked',
          error: 'Google sign-in popup was blocked. Allow popups and try again.'
        });
      }

      return new Promise((resolve) => {
        const startedAt = Date.now();
        let settled = false;
        let poll = null;

        const cleanup = () => {
          if (poll) {
            clearInterval(poll);
            poll = null;
          }
          if (this.windowObj && typeof this.windowObj.removeEventListener === 'function') {
            this.windowObj.removeEventListener('message', onMessage);
          }
        };

        const onMessage = async (event) => {
          if (settled) return;
          if (event?.origin && origin && event.origin !== origin) return;
          const data = event?.data;
          if (!data || data.type !== 'audiobook_google_oauth') return;
          settled = true;
          cleanup();
          try { popup.close(); } catch {}
          if (data.access_token) {
            resolve(await this.completeGoogleOAuthToken(data.access_token));
            return;
          }
          resolve({
            ok: false,
            reason: 'oauth_error',
            error: data.error_description || data.error || 'Google sign-in was cancelled or rejected.'
          });
        };

        if (this.windowObj && typeof this.windowObj.addEventListener === 'function') {
          this.windowObj.addEventListener('message', onMessage);
        }

        poll = setInterval(async () => {
          if (settled) return;
          if (popup.closed) {
            settled = true;
            cleanup();
            resolve({
              ok: false,
              reason: 'popup_closed',
              error: 'Google sign-in window was closed.'
            });
            return;
          }
          try {
            const hash = popup.location?.hash || '';
            if (hash.includes('access_token=')) {
              settled = true;
              cleanup();
              const params = new URLSearchParams(hash.replace(/^#/, ''));
              const token = params.get('access_token');
              try { popup.close(); } catch {}
              resolve(await this.completeGoogleOAuthToken(token));
              return;
            }
            if (hash.includes('error=')) {
              settled = true;
              cleanup();
              try { popup.close(); } catch {}
              resolve({
                ok: false,
                reason: 'oauth_error',
                error: 'Google sign-in was cancelled or rejected.'
              });
              return;
            }
          } catch {
            // Cross-origin while user is on accounts.google.com
          }
          if (Date.now() - startedAt > 120000) {
            settled = true;
            cleanup();
            try { popup.close(); } catch {}
            resolve({
              ok: false,
              reason: 'oauth_timeout',
              error: 'Google sign-in timed out.'
            });
          }
        }, 300);
      });
    };

    if (!options.forcePopup && (await this._ensureGoogleIdentityScript())) {
      const oauth2 = this.windowObj?.google?.accounts?.oauth2;
      if (oauth2?.initTokenClient) {
        return new Promise((resolve) => {
          let settled = false;
          const timeout = setTimeout(() => {
            if (!settled) {
              settled = true;
              resolve({
                ok: false,
                reason: 'oauth_timeout',
                error: 'Google sign-in timed out.'
              });
            }
          }, 60000);

          try {
            const client = oauth2.initTokenClient({
              client_id: clientId,
              scope: scopes,
              hint: options.hint || undefined,
              callback: async (resp) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                if (resp?.error || !resp?.access_token) {
                  resolve({
                    ok: false,
                    reason: resp?.error || 'oauth_cancelled',
                    error: resp?.error_description || 'Google sign-in did not complete.'
                  });
                  return;
                }
                resolve(await this.completeGoogleOAuthToken(resp.access_token));
              },
              error_callback: async () => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve(await openBrowserOAuthPopup());
              }
            });
            client.requestAccessToken({ prompt: promptValue });
          } catch {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              void openBrowserOAuthPopup().then(resolve);
            }
          }
        });
      }
    }

    return openBrowserOAuthPopup();
  }

  /**
   * Initiates Google OAuth via Supabase Auth only after verifying /auth/v1/settings (`external.google === true`).
   * Never replaces the main window with a raw JSON error page when the provider is disabled.
   * @param {object} [options]
   * @returns {Promise<{ url: string, supported?: boolean|null, reason?: string, ok?: boolean, session?: object|null, error?: string }>}
   */
  async signInWithGoogle(options = {}) {
    const redirectTo =
      options.redirectTo ||
      this.windowObj?.location?.origin ||
      'http://localhost';
    const scopes = options.scopes || DEFAULT_GOOGLE_SCOPES;

    const params = new URLSearchParams({
      provider: 'google',
      redirect_to: redirectTo,
      scopes,
      access_type: 'offline',
      prompt: options.forceConsent ? 'select_account consent' : (options.prompt || 'consent')
    });

    const authUrl = `${this.config.url}/auth/v1/authorize?${params.toString()}`;
    if (options.autoRedirect === false) {
      return { url: authUrl };
    }

    const settings = options.skipSettingsCheck ? { external: { google: true } } : await this.getAuthSettings();
    const googleEnabledOnSupabase = Boolean(settings?.external?.google);

    if (!googleEnabledOnSupabase) {
      if (options.fallbackToDirectGoogleOAuth && this.getGoogleClientId()) {
        const directResult = await this.signInWithGooglePopup(options);
        return { url: authUrl, supported: false, ...directResult };
      }
      return {
        url: authUrl,
        supported: false,
        ok: false,
        reason: 'provider_not_enabled',
        error: 'Google sign-in is not enabled on the Supabase server.'
      };
    }

    if (this._isTauriEnvironment() || this._isCapacitorEnvironment() || options.preferPopup) {
      if (typeof this.windowObj?.open === 'function') {
        let popup = null;
        try {
          popup = this.windowObj.open(authUrl, 'audiobook_supabase_google', 'width=520,height=680');
        } catch {
          popup = null;
        }
        if (popup) {
          return { url: authUrl, supported: true, mode: 'popup' };
        }
      }
      return {
        url: authUrl,
        supported: true,
        ok: false,
        reason: 'popup_unavailable',
        error: 'Popup unavailable in this app window.'
      };
    }

    if (this.windowObj?.location?.assign) {
      this.windowObj.location.assign(authUrl);
    }
    return { url: authUrl, supported: true, mode: 'redirect' };
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

    const scopeParam = params.get('scope') || '';
    if (accessToken.startsWith('ya29.') || scopeParam.includes('googleapis.com')) {
      const result = await this.completeGoogleOAuthToken(accessToken);
      return result.ok ? result.session : null;
    }

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
        } else if (res.status === 401 || res.status === 403) {
          return null;
        }
      } catch {
        // Keep token-only session if user lookup is temporarily offline
      }
    }

    if (session.provider_token) {
      this.setGoogleAccessToken(session.provider_token);
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
    this.driveSyncFileId = null;
    this.lastDriveSyncModifiedTime = null;
    this._lastDrivePayload = null;
    this.needsDriveSyncReauth = false;
    this._lastLocalDeviceState = null;
    this.setGoogleAccessToken(null);
    this._saveSession(null);
    this.disconnectRealtime();
    const tauriInvoke = this.windowObj?.__TAURI_INTERNALS__?.invoke || this.windowObj?.__TAURI__?.core?.invoke;
    if (this._isTauriEnvironment() && typeof tauriInvoke === 'function') {
      try {
        await tauriInvoke('desktop_clear_google_oauth', {});
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  async _driveFetch(url, init = {}) {
    const token = this.getGoogleAccessToken();
    if (!token || !this.fetchImpl || !this._isOnline()) {
      return { res: null, forbidden: false, text: '' };
    }
    const res = await this.fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.headers || {})
      }
    });
    if (res.status === 403) {
      const text = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
      if (!text || /insufficientPermissions|insufficient|PERMISSION_DENIED|scope/i.test(text)) {
        this.needsDriveSyncReauth = true;
      }
      return { res, forbidden: true, text };
    }
    return { res, forbidden: false, text: '' };
  }

  async _findDriveSyncFileMeta() {
    const token = this.getGoogleAccessToken();
    if (!token || !this.fetchImpl || !this._isOnline()) {
      return null;
    }

    if (this.driveSyncFileId) {
      try {
        const { res, forbidden } = await this._driveFetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(this.driveSyncFileId)}?fields=id,name,modifiedTime`
        );
        if (forbidden) return null;
        if (res?.ok) {
          const meta = await res.json();
          if (meta?.id) return meta;
        }
        if (res?.status === 404) {
          this.driveSyncFileId = null;
        }
      } catch {
        // Fall through to list query
      }
    }

    const query = encodeURIComponent(`name='${DRIVE_SYNC_FILENAME}' and trashed=false`);
    const listUrl = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}&fields=files(id,name,modifiedTime)&pageSize=1`;
    try {
      const { res, forbidden } = await this._driveFetch(listUrl);
      if (forbidden || !res?.ok) return null;
      const data = await res.json();
      const file = Array.isArray(data?.files) ? data.files[0] : null;
      if (file?.id) {
        this.driveSyncFileId = file.id;
      }
      return file || null;
    } catch {
      return null;
    }
  }

  async _readDriveSyncPayload({ force = false } = {}) {
    const token = this.getGoogleAccessToken();
    if (!token || !this.fetchImpl || !this._isOnline()) {
      return { exists: false, changed: false, payload: null, modifiedTime: null };
    }

    const meta = await this._findDriveSyncFileMeta();
    if (this.needsDriveSyncReauth) {
      return { exists: false, changed: false, payload: null, modifiedTime: null };
    }
    if (!meta?.id) {
      return { exists: false, changed: false, payload: null, modifiedTime: null };
    }

    if (
      !force &&
      meta.modifiedTime &&
      this.lastDriveSyncModifiedTime &&
      meta.modifiedTime === this.lastDriveSyncModifiedTime &&
      this._lastDrivePayload
    ) {
      return {
        exists: true,
        changed: false,
        payload: this._lastDrivePayload,
        modifiedTime: meta.modifiedTime
      };
    }

    try {
      const { res, forbidden } = await this._driveFetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(meta.id)}?alt=media`
      );
      if (forbidden || !res?.ok) {
        return {
          exists: true,
          changed: false,
          payload: this._lastDrivePayload || null,
          modifiedTime: null
        };
      }
      const rawText = typeof res.text === 'function' ? await res.text() : '';
      const parsed = rawText ? JSON.parse(rawText) : (typeof res.json === 'function' ? await res.json() : null);
      const payload = normalizeDriveSyncPayload(parsed);
      this._lastDrivePayload = payload;
      this.lastDriveSyncModifiedTime = meta.modifiedTime || new Date().toISOString();
      return {
        exists: true,
        changed: true,
        payload,
        modifiedTime: this.lastDriveSyncModifiedTime
      };
    } catch {
      return {
        exists: true,
        changed: false,
        payload: this._lastDrivePayload || null,
        modifiedTime: null
      };
    }
  }

  async _writeDriveSyncPayload(buildDeltaFn) {
    const task = this._driveWriteQueue.then(async () => {
      const token = this.getGoogleAccessToken();
      if (!token || !this.fetchImpl || !this._isOnline()) {
        return null;
      }

      const remoteState = await this._readDriveSyncPayload({ force: true });
      if (this.needsDriveSyncReauth) {
        return null;
      }

      const remotePayload = remoteState.payload || createEmptyDriveSyncPayload();
      const delta = typeof buildDeltaFn === 'function' ? buildDeltaFn(remotePayload) : buildDeltaFn;
      if (!delta) return remotePayload;

      const merged = mergeDriveSyncPayloads(remotePayload, delta);
      const boundary = `audiobook_sync_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const metadata = this.driveSyncFileId
        ? { name: DRIVE_SYNC_FILENAME }
        : { name: DRIVE_SYNC_FILENAME, parents: ['appDataFolder'] };

      const multipartBody =
        `--${boundary}\r\n` +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\n` +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        `${JSON.stringify(merged)}\r\n` +
        `--${boundary}--`;

      const uploadUrl = this.driveSyncFileId
        ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(this.driveSyncFileId)}?uploadType=multipart&fields=id,modifiedTime`
        : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime';

      const { res, forbidden } = await this._driveFetch(uploadUrl, {
        method: this.driveSyncFileId ? 'PATCH' : 'POST',
        headers: {
          'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body: multipartBody
      });

      if (forbidden || !res?.ok) {
        return null;
      }

      try {
        const resData = typeof res.json === 'function' ? await res.json() : null;
        if (resData?.id) this.driveSyncFileId = resData.id;
        this.lastDriveSyncModifiedTime = resData?.modifiedTime || new Date().toISOString();
      } catch {
        this.lastDriveSyncModifiedTime = new Date().toISOString();
      }
      this._lastDrivePayload = merged;
      return merged;
    });

    this._driveWriteQueue = task.catch(() => null);
    return task;
  }

  /**
   * Checks Google Drive appDataFolder modifiedTime (lightweight metadata check first)
   * and Supabase if authenticated, returning merged cloud state.
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<{ changed: boolean, library: object[], progress: Record<string, object>, devices: object[], driveFolder: object|null }>}
   */
  async pullCloudSnapshot({ force = false } = {}) {
    const localProgress = this.offlineQueue.getAllLocalProgress();
    if (!this._isOnline() || !this.hasCloudSyncAuth()) {
      return {
        changed: false,
        library: [],
        progress: localProgress,
        devices: this._lastLocalDeviceState ? [this._lastLocalDeviceState] : [],
        driveFolder: null
      };
    }

    let driveResult = { exists: false, changed: false, payload: this._lastDrivePayload, modifiedTime: null };
    if (this.getGoogleAccessToken()) {
      driveResult = await this._readDriveSyncPayload({ force });
    }

    if (!force && !driveResult.changed && !this.isAuthenticated()) {
      const cached = driveResult.payload || this._lastDrivePayload;
      return {
        changed: false,
        library: cached ? Object.values(cached.library || {}) : [],
        progress: { ...(cached?.progress || {}), ...localProgress },
        devices: cached
          ? Object.values(cached.devices || {})
              .map((d) => normalizeDeviceRecord(d, this.deviceId))
              .filter(Boolean)
          : [],
        driveFolder: cached?.driveFolder || null
      };
    }

    if (this.isAuthenticated()) {
      await this.refreshSupabaseSessionIfNeeded().catch(() => null);
    }

    const [library, progress, devices, driveFolder] = await Promise.all([
      this._fetchMergedLibraryItems(driveResult.payload),
      this._fetchMergedProgress(driveResult.payload),
      this._fetchMergedDevices(driveResult.payload),
      this._fetchMergedDriveFolderConfig(driveResult.payload)
    ]);

    return {
      changed: Boolean(driveResult.changed || this.isAuthenticated() || force),
      library,
      progress,
      devices,
      driveFolder
    };
  }

  /**
   * Pushes a playback progress checkpoint to Supabase /rest/v1/audiobook_progress
   * or Google Drive appDataFolder, falling back to OfflineSyncQueue when offline.
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

    if (!this._isOnline() || !this.hasCloudSyncAuth()) {
      const queuedRecord = this.offlineQueue.enqueueProgress(stamped);
      return { synced: false, queued: true, record: queuedRecord };
    }

    try {
      let synced = false;
      if (this.isAuthenticated()) {
        const row = {
          user_id: this.session.user.id,
          book_key: stamped.bookKey,
          chapter_index: Number(stamped.chapterIndex ?? 0),
          position_sec: Number(stamped.positionSec ?? 0),
          playback_rate: Number(stamped.playbackRate ?? 1),
          is_finished: Boolean(stamped.completed ?? stamped.isFinished),
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
        synced = true;
      } else if (this.getGoogleAccessToken()) {
        const written = await this._writeDriveSyncPayload({
          progress: { [stamped.bookKey]: stamped }
        });
        synced = Boolean(written);
      }

      if (synced) {
        this.offlineQueue.clearFlushed(stamped.bookKey, stamped.clientUpdatedAt);
        return { synced: true, queued: false, record: stamped };
      }

      const queuedRecord = this.offlineQueue.enqueueProgress(stamped);
      return { synced: false, queued: true, record: queuedRecord };
    } catch {
      const queuedRecord = this.offlineQueue.enqueueProgress(stamped);
      return { synced: false, queued: true, record: queuedRecord };
    }
  }

  async _fetchMergedProgress(preloadedDrivePayload = undefined) {
    const localMap = this.offlineQueue.getAllLocalProgress();
    if (!this._isOnline() || !this.hasCloudSyncAuth()) {
      return localMap;
    }

    const merged = { ...localMap };

    if (this.isAuthenticated()) {
      try {
        const rows = await this._rest(
          'audiobook_progress?select=*&order=client_updated_at.desc'
        );
        for (const row of Array.isArray(rows) ? rows : []) {
          const remote = mapProgressRowToClient(row);
          if (!remote?.bookKey) continue;
          const winner = resolveProgressConflict(merged[remote.bookKey], remote);
          if (winner) {
            merged[remote.bookKey] = winner;
            this.offlineQueue.saveLocalProgress(remote.bookKey, winner);
          }
        }
      } catch {
        // Keep local/Drive results
      }
    }

    if (this.getGoogleAccessToken()) {
      try {
        const drivePayload =
          preloadedDrivePayload !== undefined
            ? preloadedDrivePayload
            : (await this._readDriveSyncPayload()).payload;
        if (drivePayload?.progress && typeof drivePayload.progress === 'object') {
          for (const [bookKey, remote] of Object.entries(drivePayload.progress)) {
            const normalized = mapProgressRowToClient({ ...remote, bookKey: remote?.bookKey || bookKey });
            if (!normalized?.bookKey) continue;
            const winner = resolveProgressConflict(merged[normalized.bookKey], normalized);
            if (winner) {
              merged[normalized.bookKey] = winner;
              this.offlineQueue.saveLocalProgress(normalized.bookKey, winner);
            }
          }
        }
      } catch {
        // Keep local/Supabase results
      }
    }

    return merged;
  }

  /**
   * Fetches all progress records from Supabase and/or Drive appDataFolder and reconciles them
   * with local records via resolveProgressConflict so newer offline positions are never overwritten.
   * @returns {Promise<Record<string, object>>}
   */
  async fetchAllProgress() {
    return this._fetchMergedProgress();
  }

  /**
   * Saves a bookmark locally and pushes it to Supabase /rest/v1/audiobook_bookmarks or Drive appDataFolder.
   * @param {string} bookKey
   * @param {object} bookmark
   * @returns {Promise<{ synced: boolean, queued: boolean, bookmark: object }>}
   */
  async saveBookmark(bookKey, bookmark) {
    const savedLocal = this.offlineQueue.saveLocalBookmark(bookKey, bookmark, true);

    if (!this._isOnline() || !this.hasCloudSyncAuth()) {
      return { synced: false, queued: true, bookmark: savedLocal };
    }

    try {
      let synced = false;
      if (this.isAuthenticated()) {
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
        synced = true;
      } else if (this.getGoogleAccessToken()) {
        const written = await this._writeDriveSyncPayload({
          bookmarks: [savedLocal]
        });
        synced = Boolean(written);
      }

      if (synced) {
        this.offlineQueue.clearFlushedBookmark(savedLocal.id);
        return { synced: true, queued: false, bookmark: savedLocal };
      }
      return { synced: false, queued: true, bookmark: savedLocal };
    } catch {
      return { synced: false, queued: true, bookmark: savedLocal };
    }
  }

  /**
   * Fetches bookmarks for a book from Supabase / Drive appDataFolder and merges local bookmarks.
   * @param {string} [bookKey]
   * @returns {Promise<object[]>}
   */
  async fetchBookmarks(bookKey) {
    const localList = bookKey ? this.offlineQueue.getLocalBookmarks(bookKey) : [];
    if (!this._isOnline() || !this.hasCloudSyncAuth()) {
      return localList;
    }

    const remoteList = [];

    if (this.isAuthenticated()) {
      try {
        const query = bookKey
          ? `audiobook_bookmarks?book_key=eq.${encodeURIComponent(bookKey)}&select=*&order=position_sec.asc`
          : 'audiobook_bookmarks?select=*&order=created_at.desc';
        const rows = await this._rest(query);
        remoteList.push(...(Array.isArray(rows) ? rows : []).map(mapBookmarkRowToClient).filter(Boolean));
      } catch {
        // Keep other sources
      }
    }

    if (this.getGoogleAccessToken()) {
      try {
        const { payload } = await this._readDriveSyncPayload();
        const driveBookmarks = Array.isArray(payload?.bookmarks) ? payload.bookmarks : [];
        for (const bm of driveBookmarks) {
          if (!bookKey || bm.bookKey === bookKey) {
            remoteList.push(bm);
          }
        }
      } catch {
        // Keep other sources
      }
    }

    const seen = new Set();
    const combined = [];
    for (const bm of [...remoteList, ...localList]) {
      const dedupeKey = bm.id || `${bm.bookKey}:${bm.chapterIndex}:${Math.round(bm.positionSec)}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      combined.push(bm);
    }
    return combined.sort((a, b) => a.positionSec - b.positionSec);
  }

  /**
   * Registers or updates this device in Supabase /rest/v1/audiobook_devices and/or Drive appDataFolder.
   * @param {object} [deviceState]
   * @returns {Promise<object|null>}
   */
  async registerDevice(deviceState = {}) {
    const currentBookKey = deviceState.activeBookKey ?? deviceState.currentBookKey ?? null;
    const currentChapterIndex = Number(
      deviceState.chapterIndex ?? deviceState.currentChapterIndex ?? 0
    );
    const currentPositionSec = Number(
      deviceState.positionSec ?? deviceState.currentPositionSec ?? 0
    );
    const lastSeenAt = deviceState.lastSeenAt || new Date().toISOString();
    const isPlaying = Boolean(deviceState.isPlaying);
    const isActivePlayer = Boolean(deviceState.isActivePlayer ?? isPlaying);

    const normalizedLocal = normalizeDeviceRecord(
      {
        deviceId: this.deviceId,
        deviceName: deviceState.deviceName || this.deviceName,
        platform: deviceState.platform || this.platform,
        activeBookKey: currentBookKey,
        currentBookKey,
        activeBookTitle: deviceState.activeBookTitle || '',
        chapterIndex: currentChapterIndex,
        currentChapterIndex,
        positionSec: currentPositionSec,
        currentPositionSec,
        durationSec: Number(deviceState.durationSec ?? 0),
        isPlaying,
        isActivePlayer,
        lastSeenAt
      },
      this.deviceId
    );
    this._lastLocalDeviceState = normalizedLocal;

    if (!this._isOnline() || !this.hasCloudSyncAuth()) {
      return null;
    }

    let supabaseResult = null;
    if (this.isAuthenticated()) {
      const payload = {
        user_id: this.session.user.id,
        device_id: this.deviceId,
        device_name: normalizedLocal.deviceName,
        platform: normalizedLocal.platform,
        is_active_player: isActivePlayer,
        is_playing: isPlaying,
        current_book_key: currentBookKey,
        current_chapter_index: currentChapterIndex,
        current_position_sec: currentPositionSec,
        last_seen_at: lastSeenAt
      };
      try {
        supabaseResult = await this._rest('audiobook_devices?on_conflict=user_id,device_id', {
          method: 'POST',
          headers: {
            Prefer: 'resolution=merge-duplicates,return=representation'
          },
          body: payload
        });
      } catch {
        // Still attempt Drive sync if available
      }
    }

    let driveResult = null;
    if (this.getGoogleAccessToken()) {
      driveResult = await this._writeDriveSyncPayload({
        devices: {
          [this.deviceId]: normalizedLocal
        }
      }).catch(() => null);
    }

    if (!supabaseResult && !driveResult) return null;
    return supabaseResult || normalizedLocal;
  }

  async _fetchMergedDevices(preloadedDrivePayload = undefined) {
    if (!this._isOnline() || !this.hasCloudSyncAuth()) {
      return [
        this._lastLocalDeviceState || {
          deviceId: this.deviceId,
          deviceName: this.deviceName,
          platform: this.platform,
          isCurrentDevice: true
        }
      ];
    }

    const byId = new Map();

    if (this.isAuthenticated()) {
      try {
        const rows = await this._rest('audiobook_devices?select=*&order=last_seen_at.desc');
        for (const row of Array.isArray(rows) ? rows : []) {
          const normalized = normalizeDeviceRecord(row, this.deviceId);
          if (normalized) {
            byId.set(normalized.deviceId, normalized);
          }
        }
      } catch {
        // Continue with Drive/local
      }
    }

    if (this.getGoogleAccessToken()) {
      try {
        const drivePayload =
          preloadedDrivePayload !== undefined
            ? preloadedDrivePayload
            : (await this._readDriveSyncPayload()).payload;
        if (drivePayload?.devices && typeof drivePayload.devices === 'object') {
          for (const rawDev of Object.values(drivePayload.devices)) {
            const normalized = normalizeDeviceRecord(rawDev, this.deviceId);
            if (!normalized) continue;
            const existing = byId.get(normalized.deviceId);
            if (!existing || toEpochMs(normalized.lastSeenAt) >= toEpochMs(existing.lastSeenAt)) {
              byId.set(normalized.deviceId, {
                ...(existing || {}),
                ...normalized,
                activeBookTitle: normalized.activeBookTitle || existing?.activeBookTitle || '',
                durationSec: normalized.durationSec || existing?.durationSec || 0
              });
            }
          }
        }
      } catch {
        // Keep Supabase results
      }
    }

    return Array.from(byId.values()).sort(
      (a, b) => toEpochMs(b.lastSeenAt) - toEpochMs(a.lastSeenAt)
    );
  }

  /**
   * Lists connected devices on this account from Supabase and/or Google Drive appDataFolder.
   * @returns {Promise<object[]>}
   */
  async fetchDevices() {
    return this._fetchMergedDevices();
  }

  /**
   * Persists the linked Google Drive folder configuration across Supabase and/or Drive appDataFolder.
   * @param {{ folderId?: string, folderName?: string, lastActiveBookKey?: string|null, updatedAt?: string }} [config]
   * @returns {Promise<{ folderId: string, folderName: string, lastActiveBookKey: string|null, updatedAt: string }|null>}
   */
  async syncDriveFolderConfig({ folderId = '', folderName = '', lastActiveBookKey = null, updatedAt } = {}) {
    const cleanConfig = {
      folderId: String(folderId || '').trim(),
      folderName: String(folderName || '').trim(),
      lastActiveBookKey: lastActiveBookKey || null,
      updatedAt: updatedAt || new Date().toISOString()
    };

    if (!this._isOnline() || !this.hasCloudSyncAuth()) {
      return null;
    }

    let supaSaved = false;
    if (this.isAuthenticated()) {
      try {
        await this._rest('audiobook_user_settings?on_conflict=user_id', {
          method: 'POST',
          headers: {
            Prefer: 'resolution=merge-duplicates,return=representation'
          },
          body: {
            user_id: this.session.user.id,
            drive_folder_id: cleanConfig.folderId,
            drive_folder_name: cleanConfig.folderName,
            last_active_book_key: cleanConfig.lastActiveBookKey,
            updated_at: cleanConfig.updatedAt
          }
        });
        supaSaved = true;
      } catch {
        // Continue to Drive appDataFolder
      }
    }

    let driveSaved = false;
    if (this.getGoogleAccessToken()) {
      const written = await this._writeDriveSyncPayload({
        driveFolder: cleanConfig
      }).catch(() => null);
      driveSaved = Boolean(written);
    }

    if (!supaSaved && !driveSaved) return null;
    return cleanConfig;
  }

  async _fetchMergedDriveFolderConfig(preloadedDrivePayload = undefined) {
    if (!this._isOnline() || !this.hasCloudSyncAuth()) {
      return null;
    }

    let supaConfig = null;
    if (this.isAuthenticated()) {
      try {
        const rows = await this._rest('audiobook_user_settings?select=*&limit=1');
        const row = Array.isArray(rows) ? rows[0] : null;
        if (row) {
          supaConfig = {
            folderId: String(row.drive_folder_id || ''),
            folderName: String(row.drive_folder_name || ''),
            lastActiveBookKey: row.last_active_book_key || null,
            updatedAt: row.updated_at || null
          };
        }
      } catch {
        // Continue to Drive
      }
    }

    let driveConfig = null;
    if (this.getGoogleAccessToken()) {
      try {
        const drivePayload =
          preloadedDrivePayload !== undefined
            ? preloadedDrivePayload
            : (await this._readDriveSyncPayload()).payload;
        if (drivePayload?.driveFolder && typeof drivePayload.driveFolder === 'object') {
          driveConfig = {
            folderId: String(drivePayload.driveFolder.folderId || ''),
            folderName: String(drivePayload.driveFolder.folderName || ''),
            lastActiveBookKey: drivePayload.driveFolder.lastActiveBookKey || null,
            updatedAt: drivePayload.driveFolder.updatedAt || null
          };
        }
      } catch {
        // Ignore
      }
    }

    if (!supaConfig && !driveConfig) return null;
    if (!supaConfig) return driveConfig;
    if (!driveConfig) return supaConfig;
    return toEpochMs(driveConfig.updatedAt) >= toEpochMs(supaConfig.updatedAt)
      ? driveConfig
      : supaConfig;
  }

  /**
   * Fetches the linked Google Drive folder configuration from Supabase and/or Drive appDataFolder.
   * @returns {Promise<{ folderId: string, folderName: string, lastActiveBookKey: string|null, updatedAt: string|null }|null>}
   */
  async fetchDriveFolderConfig() {
    return this._fetchMergedDriveFolderConfig();
  }

  /**
   * Upserts normalized library items to Supabase /rest/v1/audiobook_library_items
   * and/or Google Drive appDataFolder, preserving Drive tracks and origin device metadata.
   * @param {object[]} items
   * @returns {Promise<object[]|null>}
   */
  async syncLibraryItems(items = []) {
    if (!this._isOnline() || !this.hasCloudSyncAuth() || !Array.isArray(items) || items.length === 0) {
      return null;
    }

    const fallbackDevice = { deviceId: this.deviceId, deviceName: this.deviceName };
    const normalizedItems = items
      .map((item) => normalizeCloudBook(item, fallbackDevice))
      .filter(Boolean);
    if (normalizedItems.length === 0) {
      return null;
    }

    let supaResult = null;
    if (this.isAuthenticated()) {
      const rows = normalizedItems.map((item) => ({
        user_id: this.session.user.id,
        book_key: item.bookKey,
        title: item.title || 'Untitled',
        author: item.author || '',
        narrator: item.narrator || '',
        series: item.series || '',
        description: item.description || '',
        cover_url: item.coverUrl || '',
        sources: Array.isArray(item.sources) ? item.sources : [],
        drive_file_id: item.driveFileId || null,
        drive_folder_id: item.driveFolderId || null,
        total_duration_sec: Number(item.totalDurationSec ?? 0),
        chapters_json: Array.isArray(item.chapters) ? item.chapters : [],
        metadata_json: {
          tracks: Array.isArray(item.tracks) ? item.tracks : [],
          coverDriveFileId: item.coverDriveFileId || '',
          driveFolderId: item.driveFolderId || '',
          seriesOrder:
            item.seriesOrder != null && Number.isFinite(Number(item.seriesOrder))
              ? Number(item.seriesOrder)
              : null,
          ...(item.enrichmentCheckedAt ? { enrichmentCheckedAt: item.enrichmentCheckedAt } : {}),
          originDeviceId: item.originDeviceId || this.deviceId,
          originDeviceName: item.originDeviceName || this.deviceName,
          updatedAt: item.updatedAt || new Date().toISOString()
        }
      }));

      supaResult = await this._rest('audiobook_library_items?on_conflict=user_id,book_key', {
        method: 'POST',
        headers: {
          Prefer: 'resolution=merge-duplicates,return=representation'
        },
        body: rows
      });
    }

    let driveResult = null;
    if (this.getGoogleAccessToken()) {
      const libraryMap = {};
      for (const item of normalizedItems) {
        libraryMap[item.bookKey] = item;
      }
      driveResult = await this._writeDriveSyncPayload({
        library: libraryMap
      }).catch(() => null);
    }

    if (!supaResult && !driveResult) return null;
    return supaResult || normalizedItems;
  }

  /**
   * Deletes matching library items from Supabase and/or Google Drive appDataFolder
   * for the authenticated user (e.g. when wiping synced Google Drive books).
   * @param {string[]} [bookKeys=[]]
   * @param {{ all?: boolean }} [options={}]
   * @returns {Promise<{ ok: boolean, deleted: number }>}
   */
  async deleteLibraryItems(bookKeys = [], options = {}) {
    if (!this._isOnline() || !this.hasCloudSyncAuth()) {
      return { ok: false, deleted: 0 };
    }

    const keys = Array.isArray(bookKeys)
      ? Array.from(new Set(bookKeys.map((k) => String(k || '').trim()).filter(Boolean)))
      : [];

    if (!options?.all && keys.length === 0) {
      return { ok: true, deleted: 0 };
    }

    let deleted = 0;
    if (this.isAuthenticated()) {
      const userId = encodeURIComponent(this.session.user.id);
      if (options?.all) {
        await this._rest(`audiobook_library_items?user_id=eq.${userId}`, {
          method: 'DELETE'
        });
        deleted = -1;
      } else {
        const chunkSize = 50;
        for (let i = 0; i < keys.length; i += chunkSize) {
          const chunk = keys.slice(i, i + chunkSize);
          const filter =
            chunk.length === 1
              ? `book_key=eq.${encodeURIComponent(chunk[0])}`
              : `book_key=in.(${chunk.map((k) => `"${encodeURIComponent(k)}"`).join(',')})`;
          await this._rest(`audiobook_library_items?user_id=eq.${userId}&${filter}`, {
            method: 'DELETE'
          });
          deleted += chunk.length;
        }
      }
    }

    if (this.getGoogleAccessToken()) {
      if (options?.all) {
        await this._writeDriveSyncPayload({
          replaceLibrary: true,
          library: {}
        }).catch(() => null);
        if (!this.isAuthenticated()) deleted = -1;
      } else {
        await this._writeDriveSyncPayload({
          deleteBookKeys: keys
        }).catch(() => null);
        if (!this.isAuthenticated()) deleted = keys.length;
      }
    }

    return { ok: true, deleted };
  }

  async _fetchMergedLibraryItems(preloadedDrivePayload = undefined) {
    if (!this._isOnline() || !this.hasCloudSyncAuth()) {
      return [];
    }

    const mergedByKey = new Map();

    if (this.isAuthenticated()) {
      try {
        const rows = await this._rest('audiobook_library_items?select=*&order=updated_at.desc');
        for (const row of Array.isArray(rows) ? rows : []) {
          const normalized = normalizeCloudBook(row);
          if (!normalized?.bookKey) continue;
          mergedByKey.set(
            normalized.bookKey,
            mergeCloudBook(mergedByKey.get(normalized.bookKey), normalized)
          );
        }
      } catch {
        // Continue to Drive appDataFolder
      }
    }

    if (this.getGoogleAccessToken()) {
      try {
        const drivePayload =
          preloadedDrivePayload !== undefined
            ? preloadedDrivePayload
            : (await this._readDriveSyncPayload()).payload;
        if (drivePayload?.library && typeof drivePayload.library === 'object') {
          for (const [key, rawBook] of Object.entries(drivePayload.library)) {
            const normalized = normalizeCloudBook({ ...rawBook, bookKey: rawBook?.bookKey || key });
            if (!normalized?.bookKey) continue;
            mergedByKey.set(
              normalized.bookKey,
              mergeCloudBook(mergedByKey.get(normalized.bookKey), normalized)
            );
          }
        }
      } catch {
        // Keep Supabase results
      }
    }

    return Array.from(mergedByKey.values());
  }

  /**
   * Fetches synced library items from Supabase and/or Google Drive appDataFolder.
   * @returns {Promise<object[]>}
   */
  async fetchLibraryItems() {
    return this._fetchMergedLibraryItems();
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
   * Flushes all queued offline progress checkpoints and bookmarks to Supabase and/or Google Drive appDataFolder.
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

    if (!this._isOnline() || !this.hasCloudSyncAuth()) {
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
      const pendingBookmarks = this.offlineQueue.getPendingBookmarks();

      if (this.isAuthenticated()) {
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
                playback_rate: Number(cp.playbackRate ?? 1),
                is_finished: Boolean(cp.completed ?? cp.isFinished),
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
      } else if (this.getGoogleAccessToken() && (pendingProgress.length > 0 || pendingBookmarks.length > 0)) {
        const progressDelta = {};
        for (const cp of pendingProgress) {
          progressDelta[cp.bookKey] = cp;
        }
        const written = await this._writeDriveSyncPayload({
          progress: progressDelta,
          bookmarks: pendingBookmarks
        }).catch(() => null);
        if (written) {
          for (const cp of pendingProgress) {
            this.offlineQueue.clearFlushed(cp.bookKey, cp.clientUpdatedAt);
            flushedProgress += 1;
          }
          for (const bm of pendingBookmarks) {
            this.offlineQueue.clearFlushedBookmark(bm.id);
            flushedBookmarks += 1;
          }
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
