/**
 * Smart library scanner for Local Folders & Google Drive, plus deterministic
 * book key normalization and Local + Drive deduplication.
 */

import { parseAudioTags, parseFilenameMetadata } from './metadata-enrichment.js';

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

function mergeChapters(existing = [], incoming = []) {
  const a = Array.isArray(existing) ? existing : [];
  const b = Array.isArray(incoming) ? incoming : [];
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  // Prefer whichever source has richer chapter metadata
  return b.length > a.length ? b : a;
}

function parseTimestampMs(value) {
  if (!value) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Merge duplicate audiobooks across Local Folders and Google Drive sharing the same
 * normalized bookKey, preferring 'local' playback whenever a local copy exists.
 * @param {Array<object>} items
 * @returns {Array<object>}
 */
export function deduplicateLibraryItems(items = []) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const byKey = new Map();

  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const key = raw.bookKey
      ? String(raw.bookKey).trim()
      : normalizeBookKey(raw.title || '', raw.author || '');

    const rawSources = collectSources(raw);
    const rawPos = Number(raw.positionSec ?? raw.progressSec ?? 0) || 0;
    const rawProgress = Number(raw.progress ?? 0) || 0;
    const rawDuration = Number(raw.totalDurationSec ?? raw.durationSec ?? 0) || 0;
    const rawChapterIdx = Number(raw.chapterIndex ?? 0) || 0;
    const rawOffline = Boolean(raw.isOffline || raw.offline || rawSources.has('local'));

    if (!byKey.has(key)) {
      const sources = orderSources(rawSources);
      byKey.set(key, {
        ...raw,
        id: raw.id || key,
        bookKey: key,
        sources,
        preferredPlaybackSource: sources.includes('local') ? 'local' : (sources[0] || 'drive'),
        localUrl: raw.localUrl || '',
        driveFileId: raw.driveFileId || '',
        driveStreamUrl: raw.driveStreamUrl || (raw.driveFileId ? buildDriveStreamUrl(raw.driveFileId) : ''),
        isOffline: rawOffline,
        offline: rawOffline,
        chapters: Array.isArray(raw.chapters) ? [...raw.chapters] : [],
        bookmarks: mergeBookmarks(raw.bookmarks),
        positionSec: rawPos,
        progressSec: rawPos,
        progress: rawProgress,
        chapterIndex: rawChapterIdx,
        totalDurationSec: rawDuration,
      });
      continue;
    }

    const existing = byKey.get(key);
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

    byKey.set(key, {
      ...existing,
      id: existing.id || raw.id || key,
      bookKey: key,
      title: existing.title || raw.title || '',
      author: existing.author || raw.author || '',
      narrator: existing.narrator || raw.narrator || '',
      series: existing.series || raw.series || '',
      description: existing.description || raw.description || '',
      coverUrl: existing.coverUrl || raw.coverUrl || '',
      year: existing.year || raw.year || '',
      sources,
      preferredPlaybackSource: sources.includes('local') ? 'local' : (sources[0] || 'drive'),
      localUrl: existing.localUrl || raw.localUrl || '',
      localFile: existing.localFile || raw.localFile || null,
      tracks: Array.isArray(existing.tracks) && existing.tracks.length > 0
        ? existing.tracks
        : (Array.isArray(raw.tracks) ? raw.tracks : undefined),
      driveFileId: existing.driveFileId || raw.driveFileId || '',
      driveStreamUrl:
        existing.driveStreamUrl ||
        raw.driveStreamUrl ||
        (raw.driveFileId ? buildDriveStreamUrl(raw.driveFileId) : ''),
      isOffline: offlineStatus,
      offline: offlineStatus,
      chapters: mergeChapters(existing.chapters, raw.chapters),
      bookmarks: mergeBookmarks(existing.bookmarks, raw.bookmarks),
      positionSec: bestPos,
      progressSec: bestPos,
      progress: bestProgress,
      chapterIndex: bestChapterIndex,
      totalDurationSec: bestDuration,
      ...(latestTs ? { lastPlayedAt: latestTs } : {}),
    });
  }

  return Array.from(byKey.values());
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

function getParentFolder(file) {
  const rel = file?.webkitRelativePath || file?.relativePath || '';
  if (!rel || !rel.includes('/')) return '';
  const parts = rel.split('/').filter(Boolean);
  if (parts.length < 2) return '';
  return parts[parts.length - 2];
}

/**
 * Scan local FileList / File[] from <input type="file" webkitdirectory multiple>
 * into deduplicated audiobook items with extracted tags and chapters.
 * @param {FileList|Array<File|object>} fileList
 * @returns {Promise<Array<object>>}
 */
export async function scanLocalFiles(fileList) {
  if (!fileList) return [];
  const files = Array.from(fileList).filter(
    (f) => f && typeof f.name === 'string' && SUPPORTED_AUDIO_RE.test(f.name),
  );
  if (files.length === 0) return [];

  // Sort deterministically by relative path or name so multi-part tracks stay ordered
  files.sort((a, b) =>
    (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    }),
  );

  const parsedEntries = await Promise.all(
    files.map(async (file) => {
      const headerBytes = await readHeaderBytes(file);
      const tags = parseAudioTags(headerBytes, file.name);
      const parentFolder = getParentFolder(file);
      const localUrl = createLocalFileUrl(file);
      return { file, tags, parentFolder, localUrl };
    }),
  );

  // Count audio files per subfolder to detect multi-track folder books
  const folderCounts = new Map();
  for (const entry of parsedEntries) {
    if (entry.parentFolder) {
      folderCounts.set(entry.parentFolder, (folderCounts.get(entry.parentFolder) || 0) + 1);
    }
  }

  const grouped = new Map();

  for (const entry of parsedEntries) {
    const { file, tags, parentFolder, localUrl } = entry;
    const isMultiFileFolder =
      parentFolder &&
      (folderCounts.get(parentFolder) || 0) > 1 &&
      (TRACK_LIKE_FILE_RE.test(file.name) || Boolean(tags.series));

    let title = tags.title || file.name.replace(ANY_AUDIO_EXT_RE, '');
    let author = tags.author || '';

    if (isMultiFileFolder) {
      const folderMeta = parseFilenameMetadata(parentFolder);
      title = tags.series || folderMeta.title || parentFolder;
      author = tags.author || folderMeta.author || '';
    } else if (tags.series && TRACK_LIKE_FILE_RE.test(file.name)) {
      title = tags.series;
    }

    const bookKey = normalizeBookKey(title, author);

    if (!grouped.has(bookKey)) {
      const initialChapters =
        tags.chapters && tags.chapters.length > 0
          ? tags.chapters
          : [
              {
                index: 0,
                title: isMultiFileFolder
                  ? tags.title || file.name.replace(ANY_AUDIO_EXT_RE, '')
                  : 'Chapter 1',
                startSec: 0,
                localUrl,
              },
            ];

      grouped.set(bookKey, {
        id: bookKey,
        bookKey,
        title,
        author,
        narrator: tags.narrator || '',
        series: tags.series || '',
        description: tags.description || '',
        year: tags.year || '',
        totalDurationSec: tags.totalDurationSec || 0,
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
      const book = grouped.get(bookKey);
      const nextIndex = book.chapters.length;
      book.tracks.push({ name: file.name, localUrl, size: file.size || 0 });
      book.chapters.push({
        index: nextIndex,
        title: tags.title || file.name.replace(ANY_AUDIO_EXT_RE, '') || `Chapter ${nextIndex + 1}`,
        startSec: 0,
        localUrl,
      });
      book.fileSizeBytes += Number(file.size || 0);
      if (!book.narrator && tags.narrator) book.narrator = tags.narrator;
      if (!book.author && author) book.author = author;
    }
  }

  return deduplicateLibraryItems(Array.from(grouped.values()));
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

async function listDriveQueryPages(accessToken, q, fetchImpl) {
  const allFiles = [];
  let pageToken = '';
  let guard = 0;

  do {
    const params = new URLSearchParams({
      q,
      fields:
        'nextPageToken,files(id,name,mimeType,size,modifiedTime,webContentLink,thumbnailLink,shortcutDetails(targetId,targetMimeType))',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!res || !res.ok) {
      throw new Error(`Google Drive scan failed (${res ? res.status : 'no response'})`);
    }

    const data = await res.json();
    const files = Array.isArray(data?.files) ? data.files : [];
    allFiles.push(...files);
    pageToken = data?.nextPageToken || '';
    guard += 1;
  } while (pageToken && guard < 20);

  return allFiles;
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

  const preferredCoverUrl = coverFile?.thumbnailLink || '';

  if (shouldGroupAsOneBook) {
    const folderMeta = parseFilenameMetadata(folderName || '');
    const title = folderMeta.title || folderName || sorted[0].name.replace(ANY_AUDIO_EXT_RE, '');
    const author = folderMeta.author || '';
    const bookKey = normalizeBookKey(title, author);
    const primaryFileId = resolveDriveFileId(sorted[0]);
    const primaryStreamUrl = buildDriveStreamUrl(primaryFileId);

    const chapters = sorted.map((file, idx) => {
      const fId = resolveDriveFileId(file);
      const fileMeta = parseAudioTags(null, file.name);
      return {
        index: idx,
        title: fileMeta.title || file.name.replace(ANY_AUDIO_EXT_RE, '') || `Chapter ${idx + 1}`,
        startSec: 0,
        driveFileId: fId,
        driveStreamUrl: buildDriveStreamUrl(fId),
        sizeBytes: Number(file.size || 0),
      };
    });

    const totalSize = sorted.reduce((sum, f) => sum + Number(f.size || 0), 0);
    const fallbackThumb = sorted.find((f) => f.thumbnailLink)?.thumbnailLink || '';

    return [
      {
        id: bookKey,
        bookKey,
        title,
        author,
        series: parentFolderName || folderMeta.series || '',
        narrator: '',
        description: '',
        sources: ['drive'],
        preferredPlaybackSource: 'drive',
        driveFileId: primaryFileId,
        driveStreamUrl: primaryStreamUrl,
        streamUrl: primaryStreamUrl,
        mimeType: resolveDriveMimeType(sorted[0]) || 'audio/mpeg',
        fileSizeBytes: totalSize,
        modifiedTime: sorted[0].modifiedTime || '',
        coverUrl: preferredCoverUrl || fallbackThumb,
        coverDriveFileId: coverFile ? resolveDriveFileId(coverFile) : '',
        chapters,
        bookmarks: [],
        positionSec: 0,
        progressSec: 0,
        chapterIndex: 0,
        isOffline: false,
        offline: false,
      },
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
    const author = fileMeta.author || folderMeta.author || '';
    const series =
      !isRootFolder && sorted.length > 1 && folderName
        ? folderName
        : fileMeta.series || '';
    const bookKey = normalizeBookKey(title, author);
    const driveStreamUrl = buildDriveStreamUrl(fileId);

    return {
      id: bookKey,
      bookKey,
      title,
      author,
      series,
      narrator: '',
      description: '',
      sources: ['drive'],
      preferredPlaybackSource: 'drive',
      driveFileId: fileId,
      driveStreamUrl,
      streamUrl: driveStreamUrl,
      mimeType: resolveDriveMimeType(file) || 'audio/mp4',
      fileSizeBytes: Number(file.size || 0),
      modifiedTime: file.modifiedTime || '',
      coverUrl: file.thumbnailLink || preferredCoverUrl || '',
      coverDriveFileId: coverFile ? resolveDriveFileId(coverFile) : '',
      chapters: [
        {
          index: 0,
          title: 'Chapter 1',
          startSec: 0,
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
    };
  });
}

/**
 * Scan a Google Drive folder (by raw ID or full Drive URL) recursively across subfolders
 * using Drive API v3 and return deduplicated audiobook entries configured for streaming.
 * @param {string} accessToken
 * @param {string} [folderIdOrUrl='']
 * @param {typeof fetch} [fetchImpl=globalThis.fetch]
 * @param {{ maxDepth?: number }} [options={}]
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

  if (!rootFolderId) {
    const q =
      "trashed = false and (mimeType contains 'audio/' or name contains '.m4b' or name contains '.mp3' or name contains '.m4a' or name contains '.ogg' or name contains '.flac')";
    const files = await listDriveQueryPages(accessToken, q, fetchImpl);
    const audioFiles = files.filter(isDriveAudioFile);
    return deduplicateLibraryItems(
      buildGroupedDriveBooksFromFolder('', '', audioFiles, null, true),
    );
  }

  const visited = new Set([rootFolderId]);
  const queue = [{ id: rootFolderId, name: '', parentName: '', depth: 0, isRoot: true }];
  const collectedBooks = [];

  while (queue.length > 0) {
    const current = queue.shift();
    const safeId = current.id.replace(/'/g, "\\'");
    const q = `'${safeId}' in parents and trashed = false`;
    const children = await listDriveQueryPages(accessToken, q, fetchImpl);

    const audioFiles = [];
    let coverFile = null;

    for (const entry of children) {
      if (!entry || !entry.id || !entry.name) continue;
      if (isDriveFolder(entry)) {
        const childFolderId = resolveDriveFileId(entry);
        if (childFolderId && !visited.has(childFolderId) && current.depth < maxDepth) {
          visited.add(childFolderId);
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
  }

  return deduplicateLibraryItems(collectedBooks);
}
