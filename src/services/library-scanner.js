/**
 * Smart library scanner for Local Folders & Google Drive, plus deterministic
 * book key normalization and Local + Drive deduplication.
 */

import {
  parseAudioTags,
  parseFilenameMetadata,
  parseSeriesAndOrder,
  normalizeBookSeriesAndChapters,
  cleanSeriesName,
  isGenericSeriesFolderName,
} from './metadata-enrichment.js';

const SUPPORTED_AUDIO_RE = /\.(m4b|mp3|m4a|ogg|flac)$/i;
const ANY_AUDIO_EXT_RE = /\.(m4b|mp3|m4a|ogg|flac|aac|wav|opus)$/i;
const IMAGE_FILE_RE = /\.(jpg|jpeg|png|webp)$/i;
const TRACK_LIKE_FILE_RE = /^(?:\d{1,4}[\s._-]|(?:chapter|chap|ch|part|pt|disc|cd|track|tr)[\s._-]*\d+)/i;

/**
 * Extract a Google Drive Folder ID from a pasted Drive URL or raw ID string.
 * Supports links like:
 * - https://drive.google.com/drive/u/0/folders/1WO4laKR_L_RhfK6OFypmMFV9GwxZpyuD
 * - https://drive.google.com/drive/folders/1WO4laKR_L_RhfK6OFypmMFV9GwxZpyuD?usp=sharing
 * - https://drive.google.com/open?id=1WO4laKR_L_RhfK6OFypmMFV9GwxZpyuD
 * - 1WO4laKR_L_RhfK6OFypmMFV9GwxZpyuD
 * @param {string} [input='']
 * @returns {string}
 */
export function extractGoogleDriveFolderId(input = '') {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const folderMatch = raw.match(/\/folders\/([a-zA-Z0-9_-]+)/i);
  if (folderMatch && folderMatch[1]) {
    return folderMatch[1];
  }
  const idParamMatch = raw.match(/[?&]id=([a-zA-Z0-9_-]+)/i);
  if (idParamMatch && idParamMatch[1]) {
    return idParamMatch[1];
  }
  // If someone pasted another Drive URL without /folders/ or ?id=, strip query/slash safely
  if (/^https?:\/\//i.test(raw)) {
    const seg = raw.split('?')[0].split('#')[0].split('/').filter(Boolean).pop() || '';
    return seg.replace(/[^a-zA-Z0-9_-]/g, '');
  }
  return raw.replace(/^['"]+|['"]+$/g, '');
}

/**
 * Strip accents, file extensions, punctuation, and casing into a canonical slug segment.
 * @param {string} value
 * @returns {string}
 */
function slugifySegment(value = '') {
  if (!value || typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(ANY_AUDIO_EXT_RE, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Produce a canonical deterministic book key (e.g. "project-hail-mary::andy-weir").
 * @param {string} title
 * @param {string} [author='']
 * @returns {string}
 */
export function normalizeBookKey(title, author = '') {
  const titleSlug = slugifySegment(title) || 'untitled';
  const authorSlug = slugifySegment(author);
  return authorSlug ? `${titleSlug}::${authorSlug}` : titleSlug;
}

/**
 * Build the Google Drive v3 media streaming URL (supports HTTP Range requests).
 * @param {string} fileId
 * @returns {string}
 */
export function buildDriveStreamUrl(fileId) {
  if (!fileId) return '';
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
}

function isPodcastItem(item) {
  return Boolean(
    item?.isPodcast ||
      item?.mediaType === 'podcast' ||
      String(item?.bookKey || '').startsWith('podcast:') ||
      item?.source === 'podcast' ||
      (Array.isArray(item?.sources) && item.sources.includes('podcast'))
  );
}

function normalizeFeedUrlKey(feedUrl = '') {
  return String(feedUrl || '').trim().replace(/\/+$/, '').toLowerCase();
}

function mergeEpisodeProgress(existingMap = {}, incomingMap = {}) {
  const a = existingMap && typeof existingMap === 'object' && !Array.isArray(existingMap) ? existingMap : {};
  const b = incomingMap && typeof incomingMap === 'object' && !Array.isArray(incomingMap) ? incomingMap : {};
  const merged = {};
  for (const epId of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const first = a[epId];
    const second = b[epId];
    if (!first) {
      if (second && typeof second === 'object') merged[epId] = { ...second };
      continue;
    }
    if (!second) {
      if (first && typeof first === 'object') merged[epId] = { ...first };
      continue;
    }
    const firstTs = parseTimestampMs(first.updatedAt);
    const secondTs = parseTimestampMs(second.updatedAt);
    const winner =
      secondTs > firstTs
        ? second
        : firstTs > secondTs
          ? first
          : Number(second.positionSec || 0) >= Number(first.positionSec || 0)
            ? second
            : first;
    merged[epId] = {
      ...winner,
      completed: Boolean(first.completed || second.completed || winner.completed)
    };
  }
  return merged;
}

function mergePodcastChapters(existing = [], incoming = [], preferIncoming = false) {
  const a = Array.isArray(existing) ? existing : [];
  const b = Array.isArray(incoming) ? incoming : [];
  if (a.length === 0) return b.map((ch) => ({ ...ch }));
  if (b.length === 0) return a.map((ch) => ({ ...ch }));
  const offlineById = new Map();
  for (const ch of [...a, ...b]) {
    if (ch?.episodeId && ch.offlineCached) {
      offlineById.set(ch.episodeId, true);
    }
  }
  const base = preferIncoming || b.length >= a.length ? b : a;
  return base.map((ch) => ({
    ...ch,
    ...(ch?.episodeId && offlineById.has(ch.episodeId) ? { offlineCached: true } : {})
  }));
}

function collectSources(item) {
  const set = new Set();
  if (Array.isArray(item?.sources)) {
    for (const src of item.sources) {
      if (src) set.add(String(src).toLowerCase());
    }
  }
  if (typeof item?.source === 'string' && item.source) {
    set.add(item.source.toLowerCase());
  }
  if (isPodcastItem(item)) {
    set.add('podcast');
  }
  if (item?.driveFileId || item?.driveStreamUrl) {
    set.add('drive');
  }
  if (item?.localUrl || (Array.isArray(item?.tracks) && item.tracks.some((t) => t?.localUrl))) {
    set.add('local');
  }
  return set;
}

function orderSources(sourceSet) {
  const ordered = [];
  if (sourceSet.has('drive')) ordered.push('drive');
  if (sourceSet.has('local')) ordered.push('local');
  for (const s of sourceSet) {
    if (s !== 'drive' && s !== 'local') ordered.push(s);
  }
  return ordered;
}

function mergeBookmarks(a = [], b = []) {
  const combined = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
  if (combined.length === 0) return [];
  const seen = new Map();
  for (const bm of combined) {
    if (!bm) continue;
    const pos = Number(bm.positionSec ?? bm.timeSec ?? 0);
    const key = bm.id ? `id:${bm.id}` : `pos:${pos}:${bm.label || bm.note || ''}`;
    if (!seen.has(key)) {
      seen.set(key, bm);
    }
  }
  return Array.from(seen.values()).sort(
    (x, y) => Number(x.positionSec ?? x.timeSec ?? 0) - Number(y.positionSec ?? y.timeSec ?? 0),
  );
}

function collectBookDriveFileIds(book) {
  const ids = new Set();
  if (!book || typeof book !== 'object') return ids;
  if (book.driveFileId) ids.add(String(book.driveFileId));
  if (Array.isArray(book.chapters)) {
    for (const ch of book.chapters) {
      if (ch?.driveFileId) ids.add(String(ch.driveFileId));
    }
  }
  if (Array.isArray(book.tracks)) {
    for (const tr of book.tracks) {
      if (tr?.driveFileId) ids.add(String(tr.driveFileId));
    }
  }
  return ids;
}

function mergeChapters(existing = [], incoming = []) {
  const a = Array.isArray(existing) ? existing : [];
  const b = Array.isArray(incoming) ? incoming : [];
  if (a.length === 0) return b.map((ch) => ({ ...ch }));
  if (b.length === 0) return a.map((ch) => ({ ...ch }));

  const hasDriveTrackIds =
    a.some((ch) => Boolean(ch?.driveFileId || ch?.driveStreamUrl)) ||
    b.some((ch) => Boolean(ch?.driveFileId || ch?.driveStreamUrl));

  if (!hasDriveTrackIds) {
    // Prefer whichever source has richer embedded chapter metadata
    return b.length > a.length ? b.map((ch) => ({ ...ch })) : a.map((ch) => ({ ...ch }));
  }

  const incomingByDriveId = new Map();
  const incomingByFileName = new Map();
  for (const ch of b) {
    if (ch?.driveFileId) incomingByDriveId.set(String(ch.driveFileId), ch);
    if (ch?.fileName) incomingByFileName.set(String(ch.fileName).toLowerCase(), ch);
  }

  const seenDriveIds = new Set();
  const seenFileNames = new Set();
  const merged = a.map((ch, idx) => {
    const fId = ch?.driveFileId ? String(ch.driveFileId) : '';
    const fName = ch?.fileName ? String(ch.fileName).toLowerCase() : '';
    const match =
      (fId && incomingByDriveId.get(fId)) ||
      (fName && incomingByFileName.get(fName)) ||
      (!fId && !fName && b[idx] && b[idx].driveFileId ? b[idx] : null);

    const nextDriveId = ch?.driveFileId || match?.driveFileId || '';
    if (nextDriveId) seenDriveIds.add(String(nextDriveId));
    if (fName) seenFileNames.add(fName);
    if (match?.fileName) seenFileNames.add(String(match.fileName).toLowerCase());

    if (!match) return { ...ch };
    return {
      ...ch,
      driveFileId: nextDriveId,
      driveStreamUrl:
        ch?.driveStreamUrl ||
        match.driveStreamUrl ||
        (nextDriveId ? buildDriveStreamUrl(nextDriveId) : ''),
      ...(match.streamUrl && !ch?.streamUrl ? { streamUrl: match.streamUrl } : {}),
      ...(!Number(ch?.durationSec) && Number(match.durationSec) > 0
        ? { durationSec: match.durationSec }
        : {}),
      ...(!Number(ch?.sizeBytes) && Number(match.sizeBytes) > 0
        ? { sizeBytes: match.sizeBytes }
        : {}),
    };
  });

  for (const ch of b) {
    const fId = ch?.driveFileId ? String(ch.driveFileId) : '';
    const fName = ch?.fileName ? String(ch.fileName).toLowerCase() : '';
    if (fId && seenDriveIds.has(fId)) continue;
    if (!fId && fName && seenFileNames.has(fName)) continue;
    if (!fId && !fName) continue;
    if (fId) seenDriveIds.add(fId);
    if (fName) seenFileNames.add(fName);
    merged.push({ ...ch, index: merged.length });
  }

  return merged;
}

function mergeTracks(existing = [], incoming = []) {
  const a = Array.isArray(existing) ? existing : [];
  const b = Array.isArray(incoming) ? incoming : [];
  if (a.length === 0) return b.length > 0 ? b.map((tr) => ({ ...tr })) : undefined;
  if (b.length === 0) return a.map((tr) => ({ ...tr }));

  const incomingByDriveId = new Map();
  const incomingByFileName = new Map();
  for (const tr of b) {
    if (tr?.driveFileId) incomingByDriveId.set(String(tr.driveFileId), tr);
    const nameKey = String(tr?.fileName || tr?.title || '').toLowerCase();
    if (nameKey) incomingByFileName.set(nameKey, tr);
  }

  const seenDriveIds = new Set();
  const seenNames = new Set();
  const merged = a.map((tr) => {
    const fId = tr?.driveFileId ? String(tr.driveFileId) : '';
    const nameKey = String(tr?.fileName || tr?.title || '').toLowerCase();
    const match =
      (fId && incomingByDriveId.get(fId)) ||
      (nameKey && incomingByFileName.get(nameKey)) ||
      null;
    const nextDriveId = tr?.driveFileId || match?.driveFileId || '';
    if (nextDriveId) seenDriveIds.add(String(nextDriveId));
    if (nameKey) seenNames.add(nameKey);
    if (!match) return { ...tr };
    return {
      ...tr,
      driveFileId: nextDriveId,
      driveStreamUrl:
        tr?.driveStreamUrl ||
        match.driveStreamUrl ||
        (nextDriveId ? buildDriveStreamUrl(nextDriveId) : ''),
    };
  });

  for (const tr of b) {
    const fId = tr?.driveFileId ? String(tr.driveFileId) : '';
    const nameKey = String(tr?.fileName || tr?.title || '').toLowerCase();
    if (fId && seenDriveIds.has(fId)) continue;
    if (!fId && nameKey && seenNames.has(nameKey)) continue;
    if (fId) seenDriveIds.add(fId);
    if (nameKey) seenNames.add(nameKey);
    merged.push({ ...tr, index: merged.length });
  }

  return merged;
}

function parseTimestampMs(value) {
  if (!value) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Merge duplicate audiobooks across Local Folders and Google Drive sharing the same
 * driveFileId or normalized bookKey, preferring 'local' playback whenever a local copy exists.
 * @param {Array<object>} items
 * @returns {Array<object>}
 */
export function deduplicateLibraryItems(items = []) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const byKey = new Map();
  const podcastByFeedUrl = new Map();
  const driveFileIdToMapKey = new Map();

  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const isPodcast = isPodcastItem(raw);
    const normFeedUrl = isPodcast ? normalizeFeedUrlKey(raw.feedUrl) : '';
    const key = raw.bookKey
      ? String(raw.bookKey).trim()
      : (isPodcast && normFeedUrl
        ? `podcast:${normFeedUrl}`
        : normalizeBookKey(raw.title || '', raw.author || ''));

    let mapKey = isPodcast ? `podcast-ns:${key}` : key;
    if (isPodcast && normFeedUrl) {
      const existingFeedMapKey = podcastByFeedUrl.get(normFeedUrl);
      if (existingFeedMapKey) {
        mapKey = existingFeedMapKey;
      } else {
        podcastByFeedUrl.set(normFeedUrl, mapKey);
      }
    } else if (!isPodcast) {
      const rawDriveIds = collectBookDriveFileIds(raw);
      for (const fid of rawDriveIds) {
        const matchedKey = driveFileIdToMapKey.get(fid);
        if (matchedKey) {
          mapKey = matchedKey;
          break;
        }
      }
    }

    const rawSources = collectSources(raw);
    const rawPos = Number(raw.positionSec ?? raw.progressSec ?? 0) || 0;
    const rawProgress = Number(raw.progress ?? 0) || 0;
    const rawDuration = Number(raw.totalDurationSec ?? raw.durationSec ?? 0) || 0;
    const rawChapterIdx = Number(raw.chapterIndex ?? 0) || 0;
    const rawOffline = Boolean(raw.isOffline || raw.offline || rawSources.has('local'));

    if (!byKey.has(mapKey)) {
      const sources = orderSources(rawSources);
      const created = {
        ...raw,
        id: raw.id || key,
        bookKey: key,
        sources,
        preferredPlaybackSource: sources.includes('local')
          ? 'local'
          : (isPodcast ? 'podcast' : (sources[0] || 'drive')),
        localUrl: raw.localUrl || '',
        driveFileId: raw.driveFileId || '',
        driveStreamUrl: raw.driveStreamUrl || (raw.driveFileId ? buildDriveStreamUrl(raw.driveFileId) : ''),
        isOffline: rawOffline,
        offline: rawOffline,
        ...(isPodcast
          ? {
              isPodcast: true,
              mediaType: 'podcast',
              feedUrl: raw.feedUrl || '',
              lastFeedRefreshAt: raw.lastFeedRefreshAt || '',
              episodeProgress:
                raw.episodeProgress && typeof raw.episodeProgress === 'object'
                  ? { ...raw.episodeProgress }
                  : {}
            }
          : {}),
        chapters: Array.isArray(raw.chapters) ? [...raw.chapters] : [],
        bookmarks: mergeBookmarks(raw.bookmarks),
        seriesOrder:
          raw.seriesOrder != null && Number.isFinite(Number(raw.seriesOrder))
            ? Number(raw.seriesOrder)
            : null,
        positionSec: rawPos,
        progressSec: rawPos,
        progress: rawProgress,
        chapterIndex: rawChapterIdx,
        totalDurationSec: rawDuration,
      };
      byKey.set(mapKey, created);
      if (!isPodcast) {
        for (const fid of collectBookDriveFileIds(created)) {
          driveFileIdToMapKey.set(fid, mapKey);
        }
      }
      continue;
    }

    const existing = byKey.get(mapKey);
    const mergedSourceSet = new Set([...existing.sources, ...rawSources]);
    const sources = orderSources(mergedSourceSet);

    const existingPos = Number(existing.positionSec ?? existing.progressSec ?? 0) || 0;
    const useIncomingProgress = rawPos > existingPos;
    const bestPos = Math.max(existingPos, rawPos);
    const bestProgress = Math.max(Number(existing.progress ?? 0) || 0, rawProgress);
    const bestDuration = Math.max(Number(existing.totalDurationSec ?? 0) || 0, rawDuration);
    const bestChapterIndex = useIncomingProgress
      ? rawChapterIdx
      : (rawPos === existingPos ? Math.max(existing.chapterIndex || 0, rawChapterIdx) : (existing.chapterIndex || 0));

    const existingTs = parseTimestampMs(existing.clientUpdatedAt || existing.lastPlayedAt);
    const incomingTs = parseTimestampMs(raw.clientUpdatedAt || raw.lastPlayedAt);
    const latestTs = incomingTs >= existingTs
      ? (raw.clientUpdatedAt || raw.lastPlayedAt || existing.clientUpdatedAt || existing.lastPlayedAt)
      : (existing.clientUpdatedAt || existing.lastPlayedAt);

    const offlineStatus = Boolean(existing.isOffline || existing.offline || rawOffline);
    const existingOrder =
      existing.seriesOrder != null && Number.isFinite(Number(existing.seriesOrder))
        ? Number(existing.seriesOrder)
        : null;
    const rawOrder =
      raw.seriesOrder != null && Number.isFinite(Number(raw.seriesOrder))
        ? Number(raw.seriesOrder)
        : null;
    const mergedSeriesOrder = existingOrder !== null ? existingOrder : rawOrder;

    const existingRefreshMs = parseTimestampMs(existing.lastFeedRefreshAt);
    const incomingRefreshMs = parseTimestampMs(raw.lastFeedRefreshAt);
    const preferIncomingFeed = isPodcast && incomingRefreshMs > existingRefreshMs;
    const mergedChapters = isPodcast
      ? mergePodcastChapters(existing.chapters, raw.chapters, preferIncomingFeed)
      : mergeChapters(existing.chapters, raw.chapters);
    const mergedTracks = isPodcast
      ? (Array.isArray(existing.tracks) && existing.tracks.length > 0
          ? existing.tracks
          : (Array.isArray(raw.tracks) ? raw.tracks : undefined))
      : mergeTracks(existing.tracks, raw.tracks);

    const mergedItem = {
      ...existing,
      id: existing.id || raw.id || existing.bookKey,
      bookKey: existing.bookKey || key,
      title: existing.title || raw.title || '',
      author: existing.author || raw.author || '',
      narrator: existing.narrator || raw.narrator || '',
      series: existing.series || raw.series || '',
      seriesOrder: mergedSeriesOrder,
      description: existing.description || raw.description || '',
      coverUrl: existing.coverUrl || raw.coverUrl || '',
      year: existing.year || raw.year || '',
      sources,
      preferredPlaybackSource: sources.includes('local')
        ? 'local'
        : (isPodcast ? 'podcast' : (sources[0] || 'drive')),
      localUrl: existing.localUrl || raw.localUrl || '',
      localFile: existing.localFile || raw.localFile || null,
      ...(mergedTracks ? { tracks: mergedTracks } : {}),
      driveFileId: existing.driveFileId || raw.driveFileId || '',
      driveStreamUrl:
        existing.driveStreamUrl ||
        raw.driveStreamUrl ||
        (raw.driveFileId ? buildDriveStreamUrl(raw.driveFileId) : ''),
      isOffline: offlineStatus,
      offline: offlineStatus,
      ...(existing.offlineCached !== undefined || raw.offlineCached !== undefined
        ? { offlineCached: Boolean(existing.offlineCached ?? raw.offlineCached) }
        : {}),
      ...(existing.completed !== undefined || raw.completed !== undefined
        ? { completed: existing.completed !== undefined ? Boolean(existing.completed) : Boolean(raw.completed) }
        : {}),
      ...(isPodcast
        ? {
            isPodcast: true,
            mediaType: 'podcast',
            feedUrl: existing.feedUrl || raw.feedUrl || '',
            lastFeedRefreshAt:
              preferIncomingFeed
                ? raw.lastFeedRefreshAt
                : (existing.lastFeedRefreshAt || raw.lastFeedRefreshAt || ''),
            episodeProgress: mergeEpisodeProgress(existing.episodeProgress, raw.episodeProgress),
            hasOfflineEpisodes: Boolean(
              mergedChapters.some((c) => Boolean(c?.offlineCached)) ||
                existing.hasOfflineEpisodes ||
                raw.hasOfflineEpisodes
            )
          }
        : {}),
      chapters: mergedChapters,
      bookmarks: mergeBookmarks(existing.bookmarks, raw.bookmarks),
      positionSec: bestPos,
      progressSec: bestPos,
      progress: bestProgress,
      chapterIndex: bestChapterIndex,
      totalDurationSec: bestDuration,
      ...(existing.enrichmentCheckedAt || raw.enrichmentCheckedAt
        ? { enrichmentCheckedAt: existing.enrichmentCheckedAt || raw.enrichmentCheckedAt }
        : {}),
      ...(latestTs ? { lastPlayedAt: latestTs } : {}),
    };

    byKey.set(mapKey, mergedItem);
    if (!isPodcast) {
      for (const fid of collectBookDriveFileIds(mergedItem)) {
        driveFileIdToMapKey.set(fid, mapKey);
      }
    }
  }

  return Array.from(byKey.values()).map((item) =>
    isPodcastItem(item) ? item : normalizeBookSeriesAndChapters(item)
  );
}

export const deduplicateBooks = deduplicateLibraryItems;

/**
 * Diff an existing library against a fresh Google Drive folder scan without clobbering
 * locally edited metadata, progress, covers, or offline state, and without auto-deleting
 * missing Drive books.
 *
 * @param {Array<object>} [existingBooks=[]]
 * @param {Array<object>} [scannedDriveBooks=[]]
 * @param {string} [folderId='']
 * @returns {{ mergedNonRemovedBooks: Array<object>, addedBooks: Array<object>, removedDriveBooks: Array<object> }}
 */
export function diffDriveLibrarySync(existingBooks = [], scannedDriveBooks = [], folderId = '') {
  const existingList = Array.isArray(existingBooks) ? existingBooks.filter((b) => b && typeof b === 'object') : [];
  const scannedList = Array.isArray(scannedDriveBooks) ? scannedDriveBooks.filter((b) => b && typeof b === 'object') : [];
  const cleanFolderId = extractGoogleDriveFolderId(folderId || '');

  const existingByDriveFileId = new Map();
  const existingByBookKey = new Map();

  existingList.forEach((book, idx) => {
    if (isPodcastItem(book)) return;
    for (const fid of collectBookDriveFileIds(book)) {
      if (!existingByDriveFileId.has(fid)) {
        existingByDriveFileId.set(fid, idx);
      }
    }
    const directKey = book.bookKey ? String(book.bookKey).trim() : '';
    if (directKey && !existingByBookKey.has(directKey)) {
      existingByBookKey.set(directKey, idx);
    }
    const normalizedKey = normalizeBookKey(book.title || '', book.author || '');
    if (normalizedKey && !existingByBookKey.has(normalizedKey)) {
      existingByBookKey.set(normalizedKey, idx);
    }
  });

  const matchedExistingByIndex = new Map();
  const addedBooks = [];
  const allScannedFileIds = new Set();

  for (const scanned of scannedList) {
    if (isPodcastItem(scanned)) continue;
    const scannedIds = collectBookDriveFileIds(scanned);
    for (const fid of scannedIds) {
      allScannedFileIds.add(fid);
    }

    let matchedIdx = -1;
    for (const fid of scannedIds) {
      if (existingByDriveFileId.has(fid)) {
        matchedIdx = existingByDriveFileId.get(fid);
        break;
      }
    }

    if (matchedIdx < 0) {
      const scannedKey = scanned.bookKey ? String(scanned.bookKey).trim() : '';
      const scannedNormKey = normalizeBookKey(scanned.title || '', scanned.author || '');
      if (scannedKey && existingByBookKey.has(scannedKey)) {
        matchedIdx = existingByBookKey.get(scannedKey);
      } else if (scannedNormKey && existingByBookKey.has(scannedNormKey)) {
        matchedIdx = existingByBookKey.get(scannedNormKey);
      }
    }

    if (matchedIdx < 0) {
      const preparedNew = {
        ...scanned,
        ...(cleanFolderId && !scanned.driveFolderId ? { driveFolderId: cleanFolderId } : {})
      };
      addedBooks.push(preparedNew);
      continue;
    }

    const base = matchedExistingByIndex.get(matchedIdx) || existingList[matchedIdx];
    const sources = orderSources(new Set([...collectSources(base), 'drive']));
    const mergedDriveFileId = base.driveFileId || scanned.driveFileId || '';
    const mergedStreamUrl =
      base.driveStreamUrl ||
      scanned.driveStreamUrl ||
      (mergedDriveFileId ? buildDriveStreamUrl(mergedDriveFileId) : '');
    const mergedChapters = mergeChapters(base.chapters, scanned.chapters);
    const mergedTracks = mergeTracks(base.tracks, scanned.tracks);

    const updated = {
      ...base,
      bookKey: base.bookKey || scanned.bookKey || normalizeBookKey(base.title || '', base.author || ''),
      title: base.title || scanned.title || '',
      author: base.author || scanned.author || '',
      coverUrl: base.coverUrl || scanned.coverUrl || '',
      positionSec: Number(base.positionSec ?? base.progressSec ?? 0) || 0,
      bookmarks: mergeBookmarks(base.bookmarks),
      ...(base.completed !== undefined ? { completed: base.completed } : {}),
      ...(base.offlineCached !== undefined ? { offlineCached: base.offlineCached } : {}),
      ...(base.episodeProgress !== undefined ? { episodeProgress: base.episodeProgress } : {}),
      sources,
      preferredPlaybackSource: sources.includes('local')
        ? 'local'
        : (base.preferredPlaybackSource || 'drive'),
      driveFileId: mergedDriveFileId,
      driveStreamUrl: mergedStreamUrl,
      ...(base.streamUrl || mergedStreamUrl ? { streamUrl: base.streamUrl || mergedStreamUrl } : {}),
      ...(base.driveFolderId || cleanFolderId || scanned.driveFolderId
        ? { driveFolderId: base.driveFolderId || cleanFolderId || scanned.driveFolderId }
        : {}),
      chapters: mergedChapters,
      ...(mergedTracks ? { tracks: mergedTracks } : {}),
      totalDurationSec:
        Number(base.totalDurationSec || 0) > 0
          ? Number(base.totalDurationSec)
          : Number(scanned.totalDurationSec || 0),
    };

    matchedExistingByIndex.set(matchedIdx, updated);
    for (const fid of collectBookDriveFileIds(updated)) {
      if (!existingByDriveFileId.has(fid)) {
        existingByDriveFileId.set(fid, matchedIdx);
      }
    }
  }

  const removedDriveBooks = [];
  const removedIndices = new Set();

  existingList.forEach((book, idx) => {
    if (matchedExistingByIndex.has(idx)) return;
    if (isPodcastItem(book)) return;
    const sources = collectSources(book);
    if (!sources.has('drive')) return;

    const bookFolderId = extractGoogleDriveFolderId(book.driveFolderId || '');
    if (cleanFolderId && bookFolderId && bookFolderId !== cleanFolderId) {
      return;
    }

    const existingIds = collectBookDriveFileIds(book);
    if (existingIds.size > 0) {
      const anyStillPresent = Array.from(existingIds).some((fid) => allScannedFileIds.has(fid));
      if (anyStillPresent) return;
    }

    removedIndices.add(idx);
    removedDriveBooks.push(book);
  });

  const nonRemovedExisting = [];
  existingList.forEach((book, idx) => {
    if (removedIndices.has(idx)) return;
    nonRemovedExisting.push(matchedExistingByIndex.get(idx) || book);
  });

  const mergedNonRemovedBooks = [...nonRemovedExisting, ...addedBooks];
  return {
    mergedNonRemovedBooks,
    addedBooks,
    removedDriveBooks,
  };
}

/**
 * Safely read up to the first 128 KB of a File/Blob-like object.
 * @param {File|Blob|object} file
 * @returns {Promise<Uint8Array>}
 */
async function readHeaderBytes(file) {
  try {
    if (!file) return new Uint8Array(0);
    if (file.bytes instanceof Uint8Array) return file.bytes;
    if (file.buffer instanceof ArrayBuffer) return new Uint8Array(file.buffer);
    const slice = typeof file.slice === 'function' ? file.slice(0, 131072) : file;
    if (typeof slice.arrayBuffer === 'function') {
      const buf = await slice.arrayBuffer();
      return new Uint8Array(buf);
    }
  } catch {
    return new Uint8Array(0);
  }
  return new Uint8Array(0);
}

function createLocalFileUrl(file) {
  if (file?.localUrl) return file.localUrl;
  if (file?.url) return file.url;
  try {
    if (
      typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function' &&
      typeof Blob !== 'undefined' &&
      file instanceof Blob
    ) {
      return URL.createObjectURL(file);
    }
  } catch {
    return '';
  }
  return '';
}

function getDirectoryInfo(file) {
  const raw = String(file?.webkitRelativePath || file?.relativePath || '').replace(/\\/g, '/');
  if (!raw || !raw.includes('/')) {
    return { dirPath: '', folderName: '', parentFolderName: '', depth: 0 };
  }
  const parts = raw.split('/').filter(Boolean);
  if (parts.length < 2) {
    return { dirPath: '', folderName: '', parentFolderName: '', depth: 0 };
  }
  const dirParts = parts.slice(0, -1);
  return {
    dirPath: dirParts.join('/'),
    folderName: dirParts[dirParts.length - 1] || '',
    parentFolderName: dirParts.length >= 2 ? dirParts[dirParts.length - 2] : '',
    depth: dirParts.length - 1,
  };
}

/**
 * Recursively scan local FileList / File[] (from `<input type="file" webkitdirectory multiple>`,
 * `showDirectoryPicker`, or multi-file selection) into deduplicated audiobook items with
 * extracted tags, chapters, and sibling folder cover images.
 * @param {FileList|Array<File|object>} fileList
 * @param {{ onProgress?: Function, signal?: AbortSignal }} [options={}]
 * @returns {Promise<Array<object>>}
 */
export async function scanLocalFiles(fileList, options = {}) {
  if (!fileList) return [];
  const allEntries = Array.from(fileList).filter((f) => f && typeof f.name === 'string');
  const files = allEntries.filter(
    (f) => SUPPORTED_AUDIO_RE.test(f.name) || (typeof f.type === 'string' && f.type.startsWith('audio/')),
  );
  if (files.length === 0) return [];

  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const signal = options.signal || null;

  // Map sibling cover images (cover.jpg, folder.png, etc.) by exact directory path
  const coverByDir = new Map();
  for (const imgFile of allEntries) {
    if (!IMAGE_FILE_RE.test(imgFile.name)) continue;
    const { dirPath } = getDirectoryInfo(imgFile);
    if (!dirPath) continue;
    const existing = coverByDir.get(dirPath);
    if (!existing || /cover|folder|front|poster/i.test(imgFile.name)) {
      coverByDir.set(dirPath, imgFile);
    }
  }

  // Sort deterministically by full relative path so nested subfolders & multi-part tracks stay ordered
  files.sort((a, b) =>
    (a.webkitRelativePath || a.relativePath || a.name).localeCompare(
      b.webkitRelativePath || b.relativePath || b.name,
      undefined,
      { numeric: true, sensitivity: 'base' },
    ),
  );

  // Group files by exact directory path first so subfolders with identical names (e.g. Disc 1) never collide
  const dirGroups = new Map();
  for (const file of files) {
    const info = getDirectoryInfo(file);
    const dirKey = info.dirPath || '__root__';
    if (!dirGroups.has(dirKey)) {
      dirGroups.set(dirKey, { info, files: [] });
    }
    dirGroups.get(dirKey).files.push(file);
  }

  const totalFiles = files.length;
  let processed = 0;
  const collectedBooks = [];

  for (const [dirKey, group] of dirGroups.entries()) {
    if (signal?.aborted) {
      throw new DOMException('Local folder scan cancelled.', 'AbortError');
    }

    const { info, files: dirFiles } = group;
    const folderName = info.folderName;
    const isRootLevel = dirKey === '__root__' || info.depth === 0;
    const coverFile = dirKey !== '__root__' ? coverByDir.get(dirKey) : null;
    const folderCoverUrl = coverFile ? createLocalFileUrl(coverFile) : '';

    const parsedEntries = [];
    for (const file of dirFiles) {
      if (signal?.aborted) {
        throw new DOMException('Local folder scan cancelled.', 'AbortError');
      }
      const headerBytes = await readHeaderBytes(file);
      const tags = parseAudioTags(headerBytes, file.name);
      const localUrl = createLocalFileUrl(file);
      parsedEntries.push({ file, tags, localUrl });
      processed += 1;
      if (onProgress) {
        onProgress({
          phase: 'local',
          processed,
          total: totalFiles,
          currentFolder: folderName || 'Local Files',
          booksFound: collectedBooks.length,
          percent: Math.min(99, Math.round((processed / totalFiles) * 100)),
        });
      }
    }

    // Multiple files inside a subfolder: group into 1 book unless they are distinct .m4b book containers in a series folder
    const allSingleM4bContainers = parsedEntries.every(
      ({ file }) => /\.m4b$/i.test(file.name) && !TRACK_LIKE_FILE_RE.test(file.name),
    );
    const shouldGroupFolderAsOneBook =
      !isRootLevel &&
      parsedEntries.length > 1 &&
      !allSingleM4bContainers;

    const folderIsDisc = /^(disc|cd|part|volume|vol)[\s_-]*\d+$/i.test(folderName || '');
    const parentMeta =
      folderIsDisc && info.depth >= 2 && info.parentFolderName
        ? parseFilenameMetadata(info.parentFolderName)
        : { title: '', author: '' };
    const effectiveFolderTitle =
      folderIsDisc && info.depth >= 2 && info.parentFolderName
        ? `${parentMeta.title || info.parentFolderName} - ${folderName}`
        : '';

    const safeParentName =
      info.depth >= 2 && info.parentFolderName && !isGenericSeriesFolderName(info.parentFolderName)
        ? info.parentFolderName
        : '';

    if (shouldGroupFolderAsOneBook) {
      const folderMeta = parseFilenameMetadata(folderName || '');
      const firstTags = parsedEntries[0].tags;
      const title = firstTags.series || effectiveFolderTitle || folderMeta.title || folderName;
      const rawAuthor = firstTags.author || folderMeta.author || parentMeta.author || '';
      const rawSeries = firstTags.series || folderMeta.series || safeParentName || '';
      const seriesParsed = parseSeriesAndOrder(title, rawAuthor, rawSeries, safeParentName);
      const author = seriesParsed.authorPolluted
        ? (seriesParsed.inferredAuthor || '')
        : (rawAuthor || seriesParsed.inferredAuthor || '');
      const finalTitle = seriesParsed.titleCleaned && seriesParsed.cleanTitle ? seriesParsed.cleanTitle : title;
      const bookKey = normalizeBookKey(finalTitle, author);

      const tracks = parsedEntries.map(({ file, localUrl }) => ({
        name: file.name,
        localUrl,
        size: file.size || 0,
      }));
      const chapters = parsedEntries.map(({ file, tags, localUrl }, idx) => ({
        index: idx,
        title: tags.title || file.name.replace(ANY_AUDIO_EXT_RE, '') || `Chapter ${idx + 1}`,
        fileName: file.name,
        startSec: 0,
        ...(Number(tags.totalDurationSec) > 0 ? { durationSec: Math.round(Number(tags.totalDurationSec)) } : {}),
        localUrl,
        localFile: file,
      }));

      collectedBooks.push(
        normalizeBookSeriesAndChapters({
          id: bookKey,
          bookKey,
          title: finalTitle,
          author,
          narrator: parsedEntries.find((e) => e.tags.narrator)?.tags.narrator || '',
          series: seriesParsed.series || cleanSeriesName(rawSeries, author),
          seriesOrder: seriesParsed.seriesOrder ?? folderMeta.seriesOrder ?? firstTags.seriesOrder ?? null,
          parentFolderName: safeParentName,
          description: parsedEntries.find((e) => e.tags.description)?.tags.description || '',
          year: parsedEntries.find((e) => e.tags.year)?.tags.year || '',
          totalDurationSec: parsedEntries.reduce((s, e) => s + Number(e.tags.totalDurationSec || 0), 0),
          coverUrl: folderCoverUrl || '',
          sources: ['local'],
          preferredPlaybackSource: 'local',
          localUrl: parsedEntries[0].localUrl,
          localFile: parsedEntries[0].file,
          tracks,
          chapters,
          bookmarks: [],
          positionSec: 0,
          progressSec: 0,
          chapterIndex: 0,
          isOffline: true,
          offline: true,
          fileSizeBytes: parsedEntries.reduce((s, e) => s + Number(e.file.size || 0), 0),
        }),
      );
      continue;
    }

    // Individual book files (or series folder containing multiple distinct .m4b books)
    const perFileGroups = new Map();
    for (const { file, tags, localUrl } of parsedEntries) {
      const folderMeta = !isRootLevel && folderName ? parseFilenameMetadata(folderName) : { title: '', author: '' };
      const useFolderTitle =
        parsedEntries.length === 1 &&
        !isRootLevel &&
        folderName &&
        (TRACK_LIKE_FILE_RE.test(file.name) || /^(audiobook|book|audio|part)/i.test(file.name));

      const title = useFolderTitle
        ? effectiveFolderTitle || folderMeta.title || folderName
        : tags.title || file.name.replace(ANY_AUDIO_EXT_RE, '');
      const rawAuthor = tags.author || folderMeta.author || parentMeta.author || '';
      const safeFolderSeries =
        !isRootLevel && parsedEntries.length > 1 && folderName && !isGenericSeriesFolderName(folderName)
          ? folderName
          : '';
      const explicitFolderFirstLawWorld = /^first law world$/i.test(safeFolderSeries.trim())
        ? safeFolderSeries.trim()
        : /^first law world$/i.test(safeParentName.trim())
          ? safeParentName.trim()
          : '';
      const rawSeries =
        explicitFolderFirstLawWorld ||
        tags.series ||
        folderMeta.series ||
        safeFolderSeries ||
        safeParentName ||
        '';
      const seriesParsed = parseSeriesAndOrder(title, rawAuthor, rawSeries, safeParentName);
      const author = seriesParsed.authorPolluted
        ? (seriesParsed.inferredAuthor || '')
        : (rawAuthor || seriesParsed.inferredAuthor || '');
      const finalTitle = seriesParsed.titleCleaned && seriesParsed.cleanTitle ? seriesParsed.cleanTitle : title;
      const series = seriesParsed.series || cleanSeriesName(rawSeries, author);
      const seriesOrder = seriesParsed.seriesOrder ?? tags.seriesOrder ?? folderMeta.seriesOrder ?? null;
      const bookKey = normalizeBookKey(finalTitle, author);

      if (!perFileGroups.has(bookKey)) {
        const initialChapters =
          tags.chapters && tags.chapters.length > 0
            ? tags.chapters
            : [
                {
                  index: 0,
                  title: 'Chapter 1',
                  fileName: file.name,
                  startSec: 0,
                  ...(Number(tags.totalDurationSec) > 0 ? { durationSec: Math.round(Number(tags.totalDurationSec)) } : {}),
                  localUrl,
                  localFile: file,
                },
              ];

        perFileGroups.set(bookKey, {
          id: bookKey,
          bookKey,
          title,
          author,
          narrator: tags.narrator || '',
          series,
          seriesOrder,
          parentFolderName: info.depth >= 2 ? info.parentFolderName : '',
          description: tags.description || '',
          year: tags.year || '',
          totalDurationSec: tags.totalDurationSec || 0,
          coverUrl: folderCoverUrl || '',
          sources: ['local'],
          preferredPlaybackSource: 'local',
          localUrl,
          localFile: file,
          tracks: [{ name: file.name, localUrl, size: file.size || 0 }],
          chapters: initialChapters,
          bookmarks: [],
          positionSec: 0,
          progressSec: 0,
          chapterIndex: 0,
          isOffline: true,
          offline: true,
          fileSizeBytes: Number(file.size || 0),
        });
      } else {
        const book = perFileGroups.get(bookKey);
        const nextIndex = book.chapters.length;
        book.tracks.push({ name: file.name, localUrl, size: file.size || 0 });
        book.chapters.push({
          index: nextIndex,
          title: tags.title || file.name.replace(ANY_AUDIO_EXT_RE, '') || `Chapter ${nextIndex + 1}`,
          fileName: file.name,
          startSec: 0,
          ...(Number(tags.totalDurationSec) > 0 ? { durationSec: Math.round(Number(tags.totalDurationSec)) } : {}),
          localUrl,
          localFile: file,
        });
        book.fileSizeBytes += Number(file.size || 0);
        if (!book.narrator && tags.narrator) book.narrator = tags.narrator;
        if (!book.author && author) book.author = author;
      }
    }

    collectedBooks.push(...Array.from(perFileGroups.values()).map((b) => normalizeBookSeriesAndChapters(b)));
  }

  const deduped = deduplicateLibraryItems(collectedBooks);
  if (onProgress) {
    onProgress({
      phase: 'local',
      processed: totalFiles,
      total: totalFiles,
      currentFolder: '',
      booksFound: deduped.length,
      percent: 100,
    });
  }
  return deduped;
}

/**
 * Recursively collect all File objects from a File System Access API DirectoryHandle.
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} [prefix='']
 * @returns {Promise<Array<File>>}
 */
export async function collectFilesFromDirectoryHandle(dirHandle, prefix = '') {
  if (!dirHandle || typeof dirHandle.values !== 'function') return [];
  const rootPrefix = prefix || dirHandle.name || 'Audiobooks';
  const collected = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file') {
      const file = await entry.getFile();
      try {
        Object.defineProperty(file, 'relativePath', {
          value: `${rootPrefix}/${file.name}`,
          configurable: true,
        });
      } catch {
        // ignore if read-only
      }
      collected.push(file);
    } else if (entry.kind === 'directory') {
      const nested = await collectFilesFromDirectoryHandle(entry, `${rootPrefix}/${entry.name}`);
      collected.push(...nested);
    }
  }
  return collected;
}

function isDriveFolder(file) {
  return (
    file?.mimeType === 'application/vnd.google-apps.folder' ||
    (file?.mimeType === 'application/vnd.google-apps.shortcut' &&
      file?.shortcutDetails?.targetMimeType === 'application/vnd.google-apps.folder')
  );
}

function resolveDriveFileId(file) {
  if (
    file?.mimeType === 'application/vnd.google-apps.shortcut' &&
    file?.shortcutDetails?.targetId
  ) {
    return file.shortcutDetails.targetId;
  }
  return file?.id || '';
}

function resolveDriveMimeType(file) {
  if (
    file?.mimeType === 'application/vnd.google-apps.shortcut' &&
    file?.shortcutDetails?.targetMimeType
  ) {
    return file.shortcutDetails.targetMimeType;
  }
  return file?.mimeType || '';
}

function isDriveAudioFile(file) {
  if (!file || !file.name) return false;
  const mime = resolveDriveMimeType(file);
  return SUPPORTED_AUDIO_RE.test(file.name) || (typeof mime === 'string' && mime.startsWith('audio/'));
}

function isDriveImageFile(file) {
  if (!file || !file.name) return false;
  const mime = resolveDriveMimeType(file);
  return IMAGE_FILE_RE.test(file.name) || (typeof mime === 'string' && mime.startsWith('image/'));
}

async function parseDriveErrorMessage(res) {
  const status = res?.status || 0;
  let apiMsg = '';
  try {
    if (res && typeof res.text === 'function') {
      const text = await res.text();
      if (text) {
        try {
          const parsed = JSON.parse(text);
          apiMsg = parsed?.error?.message || parsed?.error_description || '';
        } catch {
          apiMsg = text.slice(0, 200);
        }
      }
    }
  } catch {
    // ignore body read failure
  }

  if (status === 401) {
    const err = new Error(
      `Google Drive session expired (401). Please sign in with Google again.${apiMsg ? ` (${apiMsg})` : ''}`,
    );
    err.status = 401;
    return err;
  }
  if (status === 403) {
    const err = new Error(
      `Google Drive access denied (403). Check Drive permissions.${apiMsg ? ` (${apiMsg})` : ''}`,
    );
    err.status = 403;
    return err;
  }
  if (status === 404) {
    const err = new Error(
      `Google Drive folder not found (404). Verify the folder link or sharing permissions.${apiMsg ? ` (${apiMsg})` : ''}`,
    );
    err.status = 404;
    return err;
  }
  const err = new Error(
    `Google Drive scan failed (${status || 'network error'})${apiMsg ? `: ${apiMsg}` : ''}`,
  );
  err.status = status;
  return err;
}

async function listDriveQueryPages(accessToken, q, fetchImpl, options = {}) {
  const allFiles = [];
  let pageToken = '';
  let guard = 0;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 15000;
  const externalSignal = options.signal || null;

  do {
    if (externalSignal?.aborted) {
      throw new DOMException('Google Drive sync cancelled.', 'AbortError');
    }

    const params = new URLSearchParams({
      q,
      fields:
        'nextPageToken,files(id,name,mimeType,size,modifiedTime,webContentLink,thumbnailLink,videoMediaMetadata,shortcutDetails(targetId,targetMimeType))',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
    const reqCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timedOut = false;
    const onExternalAbort = () => reqCtrl?.abort();
    if (externalSignal && reqCtrl) {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timer =
      reqCtrl && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            reqCtrl.abort();
          }, timeoutMs)
        : null;

    let res;
    try {
      res = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        signal: reqCtrl?.signal,
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (externalSignal && reqCtrl) externalSignal.removeEventListener('abort', onExternalAbort);
      if (timedOut) {
        throw new Error(`Google Drive request timed out after ${Math.round(timeoutMs / 1000)}s.`);
      }
      if (externalSignal?.aborted || err?.name === 'AbortError') {
        throw new DOMException('Google Drive sync cancelled.', 'AbortError');
      }
      throw new Error(`Google Drive network error: ${err?.message || 'Unable to reach Google Drive.'}`);
    }

    if (timer) clearTimeout(timer);
    if (externalSignal && reqCtrl) externalSignal.removeEventListener('abort', onExternalAbort);

    if (!res || !res.ok) {
      throw await parseDriveErrorMessage(res);
    }

    const data = await res.json();
    const files = Array.isArray(data?.files) ? data.files : [];
    allFiles.push(...files);
    pageToken = data?.nextPageToken || '';
    guard += 1;
  } while (pageToken && guard < 20);

  return allFiles;
}

function extractDriveDurationSec(file) {
  const millis = Number(file?.videoMediaMetadata?.durationMillis || 0);
  return Number.isFinite(millis) && millis > 0 ? Math.round(millis / 1000) : 0;
}

function buildGroupedDriveBooksFromFolder(folderName, parentFolderName, audioFiles, coverFile, isRootFolder) {
  if (!audioFiles.length) return [];

  const sorted = [...audioFiles].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  );

  // Determine whether multiple files inside this subfolder belong to ONE book (chapters/tracks)
  // vs multiple distinct single-file books (e.g. a series folder containing Book 1.m4b, Book 2.m4b).
  const allSingleBookContainers = sorted.every((f) => /\.m4b$/i.test(f.name) && !TRACK_LIKE_FILE_RE.test(f.name));
  const shouldGroupAsOneBook =
    !isRootFolder &&
    sorted.length > 1 &&
    !allSingleBookContainers;

  // Only use thumbnailLink from an actual image file in the folder, NEVER from audio files
  const preferredCoverUrl = coverFile?.thumbnailLink || '';

  const safeParentName =
    parentFolderName && !isGenericSeriesFolderName(parentFolderName) ? parentFolderName : '';
  const safeFolderSeries =
    !isRootFolder && sorted.length > 1 && folderName && !isGenericSeriesFolderName(folderName)
      ? folderName
      : '';

  if (shouldGroupAsOneBook) {
    const folderMeta = parseFilenameMetadata(folderName || '');
    const title = folderMeta.title || folderName || sorted[0].name.replace(ANY_AUDIO_EXT_RE, '');
    const rawAuthor = folderMeta.author || '';
    const rawSeries = folderMeta.series || safeParentName || '';
    const seriesParsed = parseSeriesAndOrder(title, rawAuthor, rawSeries, safeParentName);
    const author = seriesParsed.authorPolluted
      ? (seriesParsed.inferredAuthor || '')
      : (rawAuthor || seriesParsed.inferredAuthor || '');
    const finalTitle = seriesParsed.titleCleaned && seriesParsed.cleanTitle ? seriesParsed.cleanTitle : title;
    const bookKey = normalizeBookKey(finalTitle, author);
    const primaryFileId = resolveDriveFileId(sorted[0]);
    const primaryStreamUrl = buildDriveStreamUrl(primaryFileId);

    const chapters = sorted.map((file, idx) => {
      const fId = resolveDriveFileId(file);
      const fileMeta = parseAudioTags(null, file.name);
      const durationSec = extractDriveDurationSec(file);
      return {
        index: idx,
        title: fileMeta.title || file.name.replace(ANY_AUDIO_EXT_RE, '') || `Chapter ${idx + 1}`,
        fileName: file.name,
        startSec: 0,
        ...(durationSec > 0 ? { durationSec } : {}),
        driveFileId: fId,
        driveStreamUrl: buildDriveStreamUrl(fId),
        sizeBytes: Number(file.size || 0),
      };
    });

    const totalSize = sorted.reduce((sum, f) => sum + Number(f.size || 0), 0);
    const totalDurationSec = chapters.reduce((sum, ch) => sum + Number(ch.durationSec || 0), 0);

    return [
      normalizeBookSeriesAndChapters({
        id: bookKey,
        bookKey,
        title: finalTitle,
        author,
        series: seriesParsed.series || cleanSeriesName(rawSeries, author),
        seriesOrder: seriesParsed.seriesOrder ?? folderMeta.seriesOrder ?? null,
        parentFolderName: safeParentName,
        narrator: '',
        description: '',
        totalDurationSec,
        sources: ['drive'],
        preferredPlaybackSource: 'drive',
        driveFileId: primaryFileId,
        driveStreamUrl: primaryStreamUrl,
        streamUrl: primaryStreamUrl,
        mimeType: resolveDriveMimeType(sorted[0]) || 'audio/mpeg',
        fileSizeBytes: totalSize,
        modifiedTime: sorted[0].modifiedTime || '',
        coverUrl: preferredCoverUrl,
        coverDriveFileId: coverFile ? resolveDriveFileId(coverFile) : '',
        chapters,
        bookmarks: [],
        positionSec: 0,
        progressSec: 0,
        chapterIndex: 0,
        isOffline: false,
        offline: false,
      }),
    ];
  }

  return sorted.map((file) => {
    const fileId = resolveDriveFileId(file);
    const fileMeta = parseAudioTags(null, file.name);
    const folderMeta = !isRootFolder && folderName ? parseFilenameMetadata(folderName) : { title: '', author: '' };

    const useFolderAsTitle =
      sorted.length === 1 &&
      !isRootFolder &&
      folderName &&
      (TRACK_LIKE_FILE_RE.test(file.name) || /^(audiobook|book|audio|part)/i.test(file.name));

    const title = useFolderAsTitle
      ? folderMeta.title || folderName
      : fileMeta.title || file.name.replace(ANY_AUDIO_EXT_RE, '');
    const rawAuthor = fileMeta.author || folderMeta.author || '';
    const explicitFolderFirstLawWorld = /^first law world$/i.test(safeFolderSeries.trim())
      ? safeFolderSeries.trim()
      : /^first law world$/i.test(safeParentName.trim())
        ? safeParentName.trim()
        : '';
    const rawSeries =
      explicitFolderFirstLawWorld ||
      fileMeta.series ||
      folderMeta.series ||
      safeFolderSeries ||
      safeParentName ||
      '';
    const seriesParsed = parseSeriesAndOrder(title, rawAuthor, rawSeries, safeParentName);
    const author = seriesParsed.authorPolluted
      ? (seriesParsed.inferredAuthor || '')
      : (rawAuthor || seriesParsed.inferredAuthor || '');
    const finalTitle = seriesParsed.titleCleaned && seriesParsed.cleanTitle ? seriesParsed.cleanTitle : title;
    const series = seriesParsed.series || cleanSeriesName(rawSeries, author);
    const seriesOrder = seriesParsed.seriesOrder ?? fileMeta.seriesOrder ?? folderMeta.seriesOrder ?? null;
    const bookKey = normalizeBookKey(finalTitle, author);
    const driveStreamUrl = buildDriveStreamUrl(fileId);
    const durationSec = extractDriveDurationSec(file);

    return normalizeBookSeriesAndChapters({
      id: bookKey,
      bookKey,
      title: finalTitle,
      author,
      series,
      seriesOrder,
      parentFolderName: safeParentName,
      narrator: '',
      description: '',
      totalDurationSec: durationSec,
      sources: ['drive'],
      preferredPlaybackSource: 'drive',
      driveFileId: fileId,
      driveStreamUrl,
      streamUrl: driveStreamUrl,
      mimeType: resolveDriveMimeType(file) || 'audio/mp4',
      fileSizeBytes: Number(file.size || 0),
      modifiedTime: file.modifiedTime || '',
      coverUrl: preferredCoverUrl,
      coverDriveFileId: coverFile ? resolveDriveFileId(coverFile) : '',
      chapters: [
        {
          index: 0,
          title: 'Chapter 1',
          fileName: file.name,
          startSec: 0,
          ...(durationSec > 0 ? { durationSec } : {}),
          driveFileId: fileId,
          driveStreamUrl,
        },
      ],
      bookmarks: [],
      positionSec: 0,
      progressSec: 0,
      chapterIndex: 0,
      isOffline: false,
      offline: false,
    });
  });
}

/**
 * Scan a Google Drive folder (by raw ID or full Drive URL) recursively across subfolders
 * using Drive API v3 and return deduplicated audiobook entries configured for streaming.
 * @param {string} accessToken
 * @param {string} [folderIdOrUrl='']
 * @param {typeof fetch} [fetchImpl=globalThis.fetch]
 * @param {{ maxDepth?: number, concurrency?: number, timeoutMs?: number, signal?: AbortSignal, onProgress?: Function }} [options={}]
 * @returns {Promise<Array<object>>}
 */
export async function scanGoogleDriveFolder(
  accessToken,
  folderIdOrUrl = '',
  fetchImpl = globalThis.fetch,
  options = {},
) {
  if (!accessToken || typeof fetchImpl !== 'function') return [];

  const rootFolderId = extractGoogleDriveFolderId(folderIdOrUrl);
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 5;
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency) || 4));
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const signal = options.signal || null;

  if (!rootFolderId) {
    if (onProgress) {
      onProgress({
        phase: 'drive',
        scannedFolders: 0,
        discoveredFolders: 1,
        currentFolder: 'Google Drive',
        booksFound: 0,
        percent: 15,
      });
    }
    const q =
      "trashed = false and (mimeType contains 'audio/' or name contains '.m4b' or name contains '.mp3' or name contains '.m4a' or name contains '.ogg' or name contains '.flac')";
    const files = await listDriveQueryPages(accessToken, q, fetchImpl, options);
    const audioFiles = files.filter(isDriveAudioFile);
    const result = deduplicateLibraryItems(
      buildGroupedDriveBooksFromFolder('', '', audioFiles, null, true),
    );
    if (onProgress) {
      onProgress({
        phase: 'drive',
        scannedFolders: 1,
        discoveredFolders: 1,
        currentFolder: 'Google Drive',
        booksFound: result.length,
        percent: 100,
      });
    }
    return result;
  }

  const visited = new Set([rootFolderId]);
  const queue = [{ id: rootFolderId, name: '', parentName: '', depth: 0, isRoot: true }];
  const collectedBooks = [];
  let scannedFolders = 0;
  let discoveredFolders = 1;

  if (onProgress) {
    onProgress({
      phase: 'drive',
      scannedFolders: 0,
      discoveredFolders: 1,
      currentFolder: 'Root Folder',
      booksFound: 0,
      percent: 5,
    });
  }

  while (queue.length > 0) {
    if (signal?.aborted) {
      throw new DOMException('Google Drive sync cancelled.', 'AbortError');
    }

    const batch = queue.splice(0, concurrency);
    const results = await Promise.all(
      batch.map(async (current) => {
        const safeId = current.id.replace(/'/g, "\\'");
        const q = `'${safeId}' in parents and trashed = false`;
        const children = await listDriveQueryPages(accessToken, q, fetchImpl, options);
        return { current, children };
      }),
    );

    for (const { current, children } of results) {
      scannedFolders += 1;
      const audioFiles = [];
      let coverFile = null;

      for (const entry of children) {
        if (!entry || !entry.id || !entry.name) continue;
        if (isDriveFolder(entry)) {
          const childFolderId = resolveDriveFileId(entry);
          if (childFolderId && !visited.has(childFolderId) && current.depth < maxDepth) {
            visited.add(childFolderId);
            discoveredFolders += 1;
            queue.push({
              id: childFolderId,
              name: entry.name,
              parentName: current.isRoot ? '' : current.name,
              depth: current.depth + 1,
              isRoot: false,
            });
          }
          continue;
        }

        if (isDriveAudioFile(entry)) {
          audioFiles.push(entry);
        } else if (isDriveImageFile(entry)) {
          if (!coverFile || /cover|folder|front|poster/i.test(entry.name)) {
            coverFile = entry;
          }
        }
      }

      if (audioFiles.length > 0) {
        collectedBooks.push(
          ...buildGroupedDriveBooksFromFolder(
            current.name,
            current.parentName,
            audioFiles,
            coverFile,
            current.isRoot,
          ),
        );
      }

      if (onProgress) {
        const pct = Math.min(98, Math.max(8, Math.round((scannedFolders / discoveredFolders) * 100)));
        onProgress({
          phase: 'drive',
          scannedFolders,
          discoveredFolders,
          currentFolder: current.name || 'Root Folder',
          booksFound: collectedBooks.length,
          percent: pct,
        });
      }
    }
  }

  const deduped = deduplicateLibraryItems(collectedBooks);
  if (onProgress) {
    onProgress({
      phase: 'drive',
      scannedFolders,
      discoveredFolders,
      currentFolder: '',
      booksFound: deduped.length,
      percent: 100,
    });
  }
  return deduped;
}
