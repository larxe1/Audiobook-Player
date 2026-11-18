const DEFAULT_STORAGE_KEY = 'audiobook_player_offline_sync_v1';
const AUTH_BACKUP_STORAGE_KEY = 'audiobook_player_auth_backup_v1';
const IDB_NAME = 'audiobook-player-sync';
const IDB_VERSION = 2;
const STORE_PENDING_PROGRESS = 'pending_progress';
const STORE_LOCAL_PROGRESS = 'local_progress';
const STORE_BOOKMARKS = 'bookmarks';
const STORE_META = 'meta';

/**
 * Converts an ISO timestamp string, Date, or epoch number into epoch milliseconds.
 * Returns 0 for missing or invalid timestamps.
 * @param {string|number|Date|null|undefined} value
 * @returns {number}
 */
export function toEpochMs(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed);
      return Number.isFinite(num) ? num : 0;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function getRecordTimestamp(record) {
  if (!record) return 0;
  return toEpochMs(
    record.clientUpdatedAt ??
      record.client_updated_at ??
      record.updatedAt ??
      record.updated_at
  );
}

function getRecordPosition(record) {
  if (!record) return 0;
  const pos = Number(record.positionSec ?? record.position_sec ?? 0);
  return Number.isFinite(pos) ? pos : 0;
}

/**
 * Resolves a conflict between a local progress record and a remote progress record.
 * Compares clientUpdatedAt (ISO string or epoch ms) and returns the newer record,
 * tie-breaking in favor of higher positionSec when timestamps are equal.
 * @param {object|null|undefined} localRecord
 * @param {object|null|undefined} remoteRecord
 * @returns {object|null}
 */
export function resolveProgressConflict(localRecord, remoteRecord) {
  if (!localRecord && !remoteRecord) return null;
  if (!localRecord) return remoteRecord;
  if (!remoteRecord) return localRecord;

  const localTs = getRecordTimestamp(localRecord);
  const remoteTs = getRecordTimestamp(remoteRecord);

  if (localTs > remoteTs) return localRecord;
  if (remoteTs > localTs) return remoteRecord;

  const localPos = getRecordPosition(localRecord);
  const remotePos = getRecordPosition(remoteRecord);
  return localPos >= remotePos ? localRecord : remoteRecord;
}

function normalizeProgressRecord(checkpoint) {
  if (!checkpoint || !checkpoint.bookKey) {
    throw new Error('Progress checkpoint requires a non-empty bookKey');
  }
  const hasExplicitTimestamp =
    checkpoint.clientUpdatedAt !== undefined &&
    checkpoint.clientUpdatedAt !== null &&
    checkpoint.clientUpdatedAt !== '';

  const clientUpdatedAt = hasExplicitTimestamp
    ? checkpoint.clientUpdatedAt
    : new Date().toISOString();

  return {
    ...checkpoint,
    bookKey: String(checkpoint.bookKey),
    chapterIndex: Number.isFinite(Number(checkpoint.chapterIndex))
      ? Number(checkpoint.chapterIndex)
      : 0,
    positionSec: Number.isFinite(Number(checkpoint.positionSec))
      ? Number(checkpoint.positionSec)
      : 0,
    clientUpdatedAt,
    _hasExplicitTimestamp: hasExplicitTimestamp
  };
}

function stripInternalFields(record) {
  if (!record) return null;
  const { _hasExplicitTimestamp, ...clean } = record;
  return clean;
}

/**
 * Offline-first sync queue and local progress/bookmark store.
 * Uses IndexedDB when running in a browser, backed by synchronous in-memory
 * state and localStorage fallback so Node.js tests and offline environments work cleanly.
 */
export class OfflineSyncQueue {
  /**
   * @param {object} [options]
   * @param {string} [options.storageKey]
   * @param {Storage|null} [options.storage]
   * @param {IDBFactory|null} [options.indexedDB]
   */
  constructor(options = {}) {
    this.storageKey = options.storageKey || DEFAULT_STORAGE_KEY;
    this.storage =
      options.storage !== undefined
        ? options.storage
        : typeof globalThis.localStorage !== 'undefined'
          ? globalThis.localStorage
          : null;
    this.idbFactory =
      options.indexedDB !== undefined
        ? options.indexedDB
        : typeof globalThis.indexedDB !== 'undefined'
          ? globalThis.indexedDB
          : null;

    /** @type {Map<string, object>} */
    this._pendingProgress = new Map();
    /** @type {Map<string, object>} */
    this._localProgress = new Map();
    /** @type {Map<string, object[]>} */
    this._bookmarksByBook = new Map();
    /** @type {Map<string, object>} */
    this._pendingBookmarks = new Map();
    /** @type {object|null} */
    this._authSession = null;
    this._authSessionSavedAt = 0;
    this._authSessionDirty = false;

    this._db = null;
    this._loadFromStorage();
    this._readyPromise = this._initIndexedDB();
  }

  /**
   * Resolves once any asynchronous IndexedDB hydration has completed.
   * @returns {Promise<void>}
   */
  async ready() {
    await this._readyPromise;
  }

  _loadFromStorage() {
    if (!this.storage) return;
    try {
      const rawAuth = this.storage.getItem(AUTH_BACKUP_STORAGE_KEY);
      if (rawAuth) {
        const parsedAuth = JSON.parse(rawAuth);
        const restoredSession =
          parsedAuth && typeof parsedAuth === 'object' && 'session' in parsedAuth
            ? parsedAuth.session
            : parsedAuth;
        if (restoredSession && typeof restoredSession === 'object') {
          this._authSession = { ...restoredSession };
          this._authSessionSavedAt = toEpochMs(parsedAuth?.savedAt);
        }
      }
    } catch {
      // Ignore corrupt auth backup payloads
    }
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.pendingProgress)) {
        for (const item of parsed.pendingProgress) {
          if (item?.bookKey) {
            this._pendingProgress.set(item.bookKey, item);
          }
        }
      }
      if (parsed.localProgress && typeof parsed.localProgress === 'object') {
        for (const [bookKey, item] of Object.entries(parsed.localProgress)) {
          if (item) {
            this._localProgress.set(bookKey, item);
          }
        }
      }
      if (parsed.bookmarksByBook && typeof parsed.bookmarksByBook === 'object') {
        for (const [bookKey, list] of Object.entries(parsed.bookmarksByBook)) {
          if (Array.isArray(list)) {
            this._bookmarksByBook.set(bookKey, list);
          }
        }
      }
      if (Array.isArray(parsed.pendingBookmarks)) {
        for (const bm of parsed.pendingBookmarks) {
          if (bm?.id) {
            this._pendingBookmarks.set(bm.id, bm);
          }
        }
      }
    } catch {
      // Ignore corrupt localStorage payloads
    }
  }

  _persistToStorage() {
    if (!this.storage) return;
    try {
      const payload = {
        pendingProgress: Array.from(this._pendingProgress.values()).map(stripInternalFields),
        localProgress: Object.fromEntries(this._localProgress.entries()),
        bookmarksByBook: Object.fromEntries(this._bookmarksByBook.entries()),
        pendingBookmarks: Array.from(this._pendingBookmarks.values())
      };
      this.storage.setItem(this.storageKey, JSON.stringify(payload));
    } catch {
      // Ignore quota or serialization errors
    }
  }

  async _initIndexedDB() {
    if (!this.idbFactory) return;
    try {
      const db = await new Promise((resolve, reject) => {
        const request = this.idbFactory.open(IDB_NAME, IDB_VERSION);
        request.onupgradeneeded = () => {
          const upgradeDb = request.result;
          if (!upgradeDb.objectStoreNames.contains(STORE_PENDING_PROGRESS)) {
            upgradeDb.createObjectStore(STORE_PENDING_PROGRESS, { keyPath: 'bookKey' });
          }
          if (!upgradeDb.objectStoreNames.contains(STORE_LOCAL_PROGRESS)) {
            upgradeDb.createObjectStore(STORE_LOCAL_PROGRESS, { keyPath: 'bookKey' });
          }
          if (!upgradeDb.objectStoreNames.contains(STORE_BOOKMARKS)) {
            upgradeDb.createObjectStore(STORE_BOOKMARKS, { keyPath: 'id' });
          }
          if (!upgradeDb.objectStoreNames.contains(STORE_META)) {
            upgradeDb.createObjectStore(STORE_META, { keyPath: 'key' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      this._db = db;
      await this._hydrateFromIndexedDB();
    } catch {
      this._db = null;
    }
  }

  async _hydrateFromIndexedDB() {
    if (!this._db) return;
    const readAll = (storeName) =>
      new Promise((resolve) => {
        try {
          const tx = this._db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const req = store.getAll();
          req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
          req.onerror = () => resolve([]);
        } catch {
          resolve([]);
        }
      });

    const [pendingList, localList, bookmarkList, metaList] = await Promise.all([
      readAll(STORE_PENDING_PROGRESS),
      readAll(STORE_LOCAL_PROGRESS),
      readAll(STORE_BOOKMARKS),
      readAll(STORE_META)
    ]);

    for (const item of pendingList) {
      if (!item?.bookKey) continue;
      const existing = this._pendingProgress.get(item.bookKey);
      const winner = resolveProgressConflict(existing, item);
      if (winner) this._pendingProgress.set(item.bookKey, winner);
    }

    for (const item of localList) {
      if (!item?.bookKey) continue;
      const existing = this._localProgress.get(item.bookKey);
      const winner = resolveProgressConflict(existing, item);
      if (winner) this._localProgress.set(item.bookKey, winner);
    }

    for (const bm of bookmarkList) {
      if (!bm?.bookKey || !bm?.id) continue;
      const existingList = this._bookmarksByBook.get(bm.bookKey) || [];
      if (!existingList.some((entry) => entry.id === bm.id)) {
        this._bookmarksByBook.set(bm.bookKey, [...existingList, bm]);
      }
      if (bm._pending) {
        this._pendingBookmarks.set(bm.id, bm);
      }
    }

    if (this._authSessionDirty) {
      if (this._authSession) {
        this._idbPut(STORE_META, {
          key: 'auth_session',
          session: { ...this._authSession },
          savedAt: this._authSessionSavedAt
            ? new Date(this._authSessionSavedAt).toISOString()
            : new Date().toISOString()
        });
      } else {
        this._idbDelete(STORE_META, 'auth_session');
      }
    } else {
      const authRecord = metaList.find((entry) => entry?.key === 'auth_session');
      if (authRecord?.session && typeof authRecord.session === 'object') {
        const idbSavedAt = toEpochMs(authRecord.savedAt);
        if (!this._authSession || idbSavedAt > (this._authSessionSavedAt || 0)) {
          this._authSession = { ...authRecord.session };
          this._authSessionSavedAt = idbSavedAt;
          if (this.storage) {
            try {
              this.storage.setItem(AUTH_BACKUP_STORAGE_KEY, JSON.stringify(authRecord));
            } catch {
              // Ignore storage quota errors
            }
          }
        }
      }
    }
  }

  _idbPut(storeName, value) {
    if (!this._db) return;
    try {
      const tx = this._db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
    } catch {
      // Non-fatal in-memory fallback remains active
    }
  }

  _idbDelete(storeName, key) {
    if (!this._db) return;
    try {
      const tx = this._db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
    } catch {
      // Non-fatal
    }
  }

  /**
   * Adds or updates a pending progress checkpoint, deduplicating by bookKey
   * so only the latest checkpoint per bookKey is kept.
   * @param {object} checkpoint
   * @returns {object}
   */
  enqueueProgress(checkpoint) {
    const normalized = normalizeProgressRecord(checkpoint);
    const existing = this._pendingProgress.get(normalized.bookKey);

    let winner = normalized;
    if (existing) {
      const existingTs = getRecordTimestamp(existing);
      const incomingTs = getRecordTimestamp(normalized);

      if (incomingTs > existingTs) {
        winner = normalized;
      } else if (incomingTs < existingTs) {
        winner = existing;
      } else if (!normalized._hasExplicitTimestamp) {
        // Sequential live updates within the same millisecond keep the latest call
        winner = normalized;
      } else {
        winner = resolveProgressConflict(existing, normalized);
      }
    }

    const cleanWinner = stripInternalFields(winner);
    this._pendingProgress.set(normalized.bookKey, cleanWinner);
    this.saveLocalProgress(normalized.bookKey, cleanWinner);
    this._persistToStorage();
    this._idbPut(STORE_PENDING_PROGRESS, cleanWinner);
    return { ...cleanWinner };
  }

  /**
   * Returns all pending checkpoints sorted ascending by clientUpdatedAt.
   * @returns {object[]}
   */
  getPendingQueue() {
    return Array.from(this._pendingProgress.values())
      .map((item) => ({ ...stripInternalFields(item) }))
      .sort((a, b) => getRecordTimestamp(a) - getRecordTimestamp(b));
  }

  /**
   * Removes flushed checkpoint(s) if no newer update arrived after upToTimestamp.
   * Supports both clearFlushed(bookKey, upToTimestamp) and clearFlushed(upToTimestamp).
   * @param {string|number|Date} bookKeyOrTimestamp
   * @param {string|number|Date} [upToTimestamp]
   * @returns {number} Number of entries cleared
   */
  clearFlushed(bookKeyOrTimestamp, upToTimestamp) {
    let cleared = 0;

    if (upToTimestamp !== undefined) {
      const bookKey = String(bookKeyOrTimestamp);
      const cutoff = toEpochMs(upToTimestamp);
      const existing = this._pendingProgress.get(bookKey);
      if (existing && getRecordTimestamp(existing) <= cutoff) {
        this._pendingProgress.delete(bookKey);
        this._idbDelete(STORE_PENDING_PROGRESS, bookKey);
        cleared = 1;
      }
    } else if (bookKeyOrTimestamp !== undefined && bookKeyOrTimestamp !== null) {
      const asTimestamp = toEpochMs(bookKeyOrTimestamp);
      const looksLikeBookKey =
        typeof bookKeyOrTimestamp === 'string' &&
        this._pendingProgress.has(bookKeyOrTimestamp);

      if (looksLikeBookKey && asTimestamp === 0) {
        this._pendingProgress.delete(bookKeyOrTimestamp);
        this._idbDelete(STORE_PENDING_PROGRESS, bookKeyOrTimestamp);
        cleared = 1;
      } else {
        const cutoff = asTimestamp;
        for (const [bookKey, entry] of this._pendingProgress.entries()) {
          if (getRecordTimestamp(entry) <= cutoff) {
            this._pendingProgress.delete(bookKey);
            this._idbDelete(STORE_PENDING_PROGRESS, bookKey);
            cleared += 1;
          }
        }
      }
    }

    if (cleared > 0) {
      this._persistToStorage();
    }
    return cleared;
  }

  /**
   * Persists the latest known local progress for a bookKey.
   * @param {string} bookKey
   * @param {object} checkpoint
   * @returns {object}
   */
  saveLocalProgress(bookKey, checkpoint) {
    if (!bookKey) throw new Error('bookKey is required');
    const clean = stripInternalFields({
      ...checkpoint,
      bookKey: String(bookKey),
      clientUpdatedAt:
        checkpoint?.clientUpdatedAt ?? new Date().toISOString()
    });
    const existing = this._localProgress.get(clean.bookKey);
    let winner = clean;
    if (existing) {
      const existingTs = getRecordTimestamp(existing);
      const incomingTs = getRecordTimestamp(clean);
      if (incomingTs > existingTs) {
        winner = clean;
      } else if (incomingTs < existingTs) {
        winner = existing;
      } else if (!checkpoint?.clientUpdatedAt) {
        winner = clean;
      } else {
        winner = resolveProgressConflict(existing, clean);
      }
    }
    this._localProgress.set(clean.bookKey, winner);
    this._persistToStorage();
    this._idbPut(STORE_LOCAL_PROGRESS, winner);
    return { ...winner };
  }

  /**
   * Retrieves the locally stored progress checkpoint for a bookKey.
   * @param {string} bookKey
   * @returns {object|null}
   */
  getLocalProgress(bookKey) {
    const entry = this._localProgress.get(String(bookKey));
    return entry ? { ...entry } : null;
  }

  /**
   * Returns a shallow copy map of all locally stored progress records keyed by bookKey.
   * @returns {Record<string, object>}
   */
  getAllLocalProgress() {
    const out = {};
    for (const [bookKey, entry] of this._localProgress.entries()) {
      out[bookKey] = { ...entry };
    }
    return out;
  }

  /**
   * Saves a bookmark locally and optionally queues it for cloud sync.
   * @param {string} bookKey
   * @param {object} bookmark
   * @param {boolean} [queueForSync=false]
   * @returns {object}
   */
  saveLocalBookmark(bookKey, bookmark, queueForSync = false) {
    if (!bookKey) throw new Error('bookKey is required');
    const id =
      bookmark.id ||
      `${bookKey}:${bookmark.chapterIndex ?? 0}:${Math.round(Number(bookmark.positionSec ?? 0))}:${Date.now()}`;
    const record = {
      ...bookmark,
      id,
      bookKey: String(bookKey),
      chapterIndex: Number(bookmark.chapterIndex ?? 0),
      positionSec: Number(bookmark.positionSec ?? 0),
      clientUpdatedAt: bookmark.clientUpdatedAt || new Date().toISOString()
    };

    const list = this._bookmarksByBook.get(record.bookKey) || [];
    const idx = list.findIndex((item) => item.id === id);
    const nextList =
      idx >= 0
        ? list.map((item, i) => (i === idx ? record : item))
        : [...list, record];

    this._bookmarksByBook.set(record.bookKey, nextList);

    if (queueForSync) {
      this._pendingBookmarks.set(id, { ...record, _pending: true });
    }

    this._persistToStorage();
    this._idbPut(STORE_BOOKMARKS, queueForSync ? { ...record, _pending: true } : record);
    return { ...record };
  }

  /**
   * Returns locally cached bookmarks for a bookKey.
   * @param {string} bookKey
   * @returns {object[]}
   */
  getLocalBookmarks(bookKey) {
    const list = this._bookmarksByBook.get(String(bookKey)) || [];
    return list.map((item) => ({ ...item }));
  }

  /**
   * Returns pending bookmarks awaiting cloud sync.
   * @returns {object[]}
   */
  getPendingBookmarks() {
    return Array.from(this._pendingBookmarks.values()).map(({ _pending, ...rest }) => ({
      ...rest
    }));
  }

  /**
   * Marks a pending bookmark as flushed.
   * @param {string} bookmarkId
   */
  clearFlushedBookmark(bookmarkId) {
    if (this._pendingBookmarks.delete(bookmarkId)) {
      this._persistToStorage();
      const bm = Array.from(this._bookmarksByBook.values())
        .flat()
        .find((item) => item.id === bookmarkId);
      if (bm) {
        this._idbPut(STORE_BOOKMARKS, bm);
      }
    }
  }

  /**
   * Persists the active auth session durably to memory, localStorage backup, and IndexedDB.
   * @param {object|null} session
   * @returns {object|null}
   */
  saveAuthSession(session) {
    const cleanSession = session && typeof session === 'object' ? { ...session } : null;
    const savedAt = new Date().toISOString();
    const record = {
      key: 'auth_session',
      session: cleanSession,
      savedAt
    };
    this._authSession = cleanSession;
    this._authSessionSavedAt = toEpochMs(savedAt);
    this._authSessionDirty = true;
    if (this.storage) {
      try {
        this.storage.setItem(AUTH_BACKUP_STORAGE_KEY, JSON.stringify(record));
      } catch {
        // Ignore storage errors
      }
    }
    this._idbPut(STORE_META, record);
    return cleanSession ? { ...cleanSession } : null;
  }

  /**
   * Returns the durably backed-up auth session, if any.
   * @returns {object|null}
   */
  getAuthSession() {
    return this._authSession ? { ...this._authSession } : null;
  }

  /**
   * Clears the backed-up auth session from memory, localStorage, and IndexedDB.
   */
  clearAuthSession() {
    this._authSession = null;
    this._authSessionSavedAt = 0;
    this._authSessionDirty = true;
    if (this.storage) {
      try {
        this.storage.removeItem(AUTH_BACKUP_STORAGE_KEY);
      } catch {
        // Ignore storage errors
      }
    }
    this._idbDelete(STORE_META, 'auth_session');
  }
}
