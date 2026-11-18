/**
 * Audio tag parser (ID3v2 + MP4/M4B atoms) and online audiobook metadata enrichment.
 */

const AUDIO_EXT_RE = /\.(m4b|mp3|m4a|ogg|flac|aac|wav|opus)$/i;
const TRACK_PREFIX_RE = /^(?:\d{1,4}|(?:part|pt|chapter|chap|ch|disc|cd|track|tr)\s*\d+)$/i;

/**
 * Safely convert supported binary inputs into a Uint8Array.
 * Never throws on null, undefined, or invalid input.
 * @param {unknown} input
 * @returns {Uint8Array}
 */
function toUint8Array(input) {
  try {
    if (!input) return new Uint8Array(0);
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
  } catch {
    return new Uint8Array(0);
  }
  return new Uint8Array(0);
}

/**
 * Decode bytes with TextDecoder safely, stripping trailing null characters.
 * @param {Uint8Array} bytes
 * @param {string} encoding
 * @returns {string}
 */
function decodeText(bytes, encoding = 'utf-8') {
  if (!bytes || bytes.length === 0) return '';
  try {
    const decoder = new TextDecoder(encoding, { fatal: false });
    return decoder.decode(bytes).replace(/\0+/g, '').trim();
  } catch {
    // Manual ASCII/Latin-1 fallback
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] !== 0) out += String.fromCharCode(bytes[i]);
    }
    return out.trim();
  }
}

/**
 * Decode an ID3v2 text payload according to its leading encoding byte.
 * @param {Uint8Array} payload
 * @returns {string}
 */
function decodeId3Text(payload) {
  if (!payload || payload.length === 0) return '';
  const enc = payload[0];
  const body = payload.subarray(1);
  if (body.length === 0) return '';

  if (enc === 0) {
    return decodeText(body, 'latin1');
  }
  if (enc === 1) {
    // UTF-16 with BOM
    if (body.length >= 2) {
      if (body[0] === 0xff && body[1] === 0xfe) {
        return decodeText(body.subarray(2), 'utf-16le');
      }
      if (body[0] === 0xfe && body[1] === 0xff) {
        return decodeText(body.subarray(2), 'utf-16be');
      }
    }
    return decodeText(body, 'utf-16le');
  }
  if (enc === 2) {
    return decodeText(body, 'utf-16be');
  }
  if (enc === 3) {
    return decodeText(body, 'utf-8');
  }
  // Fallback if no standard encoding byte
  return decodeText(payload, 'utf-8');
}

function readUint32BE(bytes, offset) {
  if (offset + 4 > bytes.length) return 0;
  return (
    ((bytes[offset] << 24) >>> 0) +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function readUint24BE(bytes, offset) {
  if (offset + 3 > bytes.length) return 0;
  return (bytes[offset] << 16) + (bytes[offset + 1] << 8) + bytes[offset + 2];
}

function readSynchsafe32(bytes, offset) {
  if (offset + 4 > bytes.length) return 0;
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

function readUint64BE(bytes, offset) {
  if (offset + 8 > bytes.length) return 0;
  const hi = readUint32BE(bytes, offset);
  const lo = readUint32BE(bytes, offset + 4);
  return hi * 4294967296 + lo;
}

function readAscii(bytes, offset, length) {
  if (offset + length > bytes.length) return '';
  let str = '';
  for (let i = 0; i < length; i += 1) {
    str += String.fromCharCode(bytes[offset + i]);
  }
  return str;
}

function readLatin1(bytes, offset, length) {
  return readAscii(bytes, offset, length);
}

/**
 * Parse filename into fallback title, author, and optional series.
 * Examples:
 *  - "Andy Weir - Project Hail Mary.m4b" -> { title: "Project Hail Mary", author: "Andy Weir" }
 *  - "Project Hail Mary by Andy Weir.mp3" -> { title: "Project Hail Mary", author: "Andy Weir" }
 * @param {string} filename
 * @returns {{ title: string, author: string, series: string }}
 */
export function parseFilenameMetadata(filename = '') {
  if (!filename || typeof filename !== 'string') {
    return { title: '', author: '', series: '' };
  }

  const leaf = filename.split(/[/\\]/).pop() || '';
  const withoutExt = leaf.replace(AUDIO_EXT_RE, '').trim();
  const cleaned = withoutExt.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return { title: '', author: '', series: '' };
  }

  const dashParts = cleaned.split(/\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean);
  if (dashParts.length === 2) {
    const [left, right] = dashParts;
    if (TRACK_PREFIX_RE.test(left)) {
      return { title: right, author: '', series: '' };
    }
    return { title: right, author: left, series: '' };
  }

  if (dashParts.length >= 3) {
    const [first, second, ...rest] = dashParts;
    if (TRACK_PREFIX_RE.test(first)) {
      return { title: [second, ...rest].join(' - '), author: '', series: '' };
    }
    return {
      author: first,
      series: second,
      title: rest.join(' - '),
    };
  }

  const byMatch = cleaned.match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch) {
    return {
      title: byMatch[1].trim(),
      author: byMatch[2].trim(),
      series: '',
    };
  }

  return { title: cleaned, author: '', series: '' };
}

/**
 * Parse ID3v2.2 / v2.3 / v2.4 header frames safely.
 * @param {Uint8Array} bytes
 */
function parseId3v2(bytes) {
  if (bytes.length < 10) return null;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null;

  const major = bytes[3];
  if (major < 2 || major > 4) return null;

  const flags = bytes[5];
  const tagSize = readSynchsafe32(bytes, 6);
  const tagEnd = Math.min(bytes.length, 10 + tagSize);

  let offset = 10;

  // Skip extended header if present in v2.3 or v2.4
  if ((flags & 0x40) !== 0 && major >= 3 && offset + 4 <= tagEnd) {
    const extSize = major === 4 ? readSynchsafe32(bytes, offset) : readUint32BE(bytes, offset) + 4;
    if (extSize > 0 && offset + extSize <= tagEnd) {
      offset += extSize;
    }
  }

  const result = {
    title: '',
    author: '',
    albumAuthor: '',
    series: '',
    narrator: '',
    year: '',
    description: '',
    chapters: [],
    found: false,
  };

  if (major === 2) {
    // ID3v2.2: 3-char frame ID + 3-byte size
    while (offset + 6 <= tagEnd) {
      if (bytes[offset] === 0) break;
      const frameId = readAscii(bytes, offset, 3);
      if (!/^[A-Z0-9]{3}$/.test(frameId)) break;
      const frameSize = readUint24BE(bytes, offset + 3);
      if (frameSize <= 0) break;

      const dataStart = offset + 6;
      const dataEnd = Math.min(tagEnd, dataStart + frameSize);
      const payload = bytes.subarray(dataStart, dataEnd);

      if (frameId === 'TT2' && !result.title) {
        result.title = decodeId3Text(payload);
        result.found = true;
      } else if (frameId === 'TP1' && !result.author) {
        result.author = decodeId3Text(payload);
        result.found = true;
      } else if (frameId === 'TP2' && !result.albumAuthor) {
        result.albumAuthor = decodeId3Text(payload);
        result.found = true;
      } else if (frameId === 'TAL' && !result.series) {
        result.series = decodeId3Text(payload);
        result.found = true;
      } else if (frameId === 'TCM' && !result.narrator) {
        result.narrator = decodeId3Text(payload);
        result.found = true;
      }

      if (dataEnd >= tagEnd) break;
      offset = dataStart + frameSize;
    }
  } else {
    // ID3v2.3 / ID3v2.4: 4-char frame ID + 4-byte size + 2-byte flags
    while (offset + 10 <= tagEnd) {
      if (bytes[offset] === 0) break;
      const frameId = readAscii(bytes, offset, 4);
      if (!/^[A-Z0-9]{4}$/.test(frameId)) break;

      const frameSize = major === 4 ? readSynchsafe32(bytes, offset + 4) : readUint32BE(bytes, offset + 4);
      if (frameSize <= 0) break;

      const dataStart = offset + 10;
      const dataEnd = Math.min(tagEnd, dataStart + frameSize);
      const payload = bytes.subarray(dataStart, dataEnd);

      if (frameId === 'TIT2' && !result.title) {
        result.title = decodeId3Text(payload);
        result.found = true;
      } else if (frameId === 'TPE1' && !result.author) {
        result.author = decodeId3Text(payload);
        result.found = true;
      } else if (frameId === 'TPE2' && !result.albumAuthor) {
        result.albumAuthor = decodeId3Text(payload);
        result.found = true;
      } else if (frameId === 'TALB' && !result.series) {
        result.series = decodeId3Text(payload);
        result.found = true;
      } else if (frameId === 'TCOM' && !result.narrator) {
        result.narrator = decodeId3Text(payload);
        result.found = true;
      } else if ((frameId === 'TDRC' || frameId === 'TYER') && !result.year) {
        result.year = decodeId3Text(payload).slice(0, 4);
        result.found = true;
      }

      if (dataEnd >= tagEnd) break;
      offset = dataStart + frameSize;
    }
  }

  if (!result.author && result.albumAuthor) {
    result.author = result.albumAuthor;
  }

  return result.found ? result : null;
}

/**
 * Decode an iTunes MP4 ilst item atom (contains a nested `data` atom).
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @returns {string}
 */
function extractMp4IlstText(bytes, start, end) {
  let cursor = start;
  while (cursor + 8 <= end) {
    let size = readUint32BE(bytes, cursor);
    const type = readLatin1(bytes, cursor + 4, 4);
    if (size === 0) size = end - cursor;
    if (size < 8) break;
    const boxEnd = Math.min(end, cursor + size);

    if (type === 'data' && cursor + 16 <= boxEnd) {
      const dataType = readUint32BE(bytes, cursor + 8);
      const textBytes = bytes.subarray(cursor + 16, boxEnd);
      if (dataType === 2) {
        return decodeText(textBytes, 'utf-16be');
      }
      return decodeText(textBytes, 'utf-8');
    }

    if (boxEnd <= cursor) break;
    cursor = boxEnd;
  }
  return '';
}

/**
 * Parse Nero `chpl` chapter list atom payload.
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @returns {Array<{index: number, title: string, startSec: number}>}
 */
function parseChplAtom(bytes, start, end) {
  if (start + 5 > end) return [];
  const version = bytes[start];
  let countOffset = start + 4;
  if (version === 1) {
    countOffset = start + 8;
  }
  if (countOffset >= end) return [];

  const count = bytes[countOffset];
  let cursor = countOffset + 1;
  const chapters = [];

  for (let i = 0; i < count && cursor + 9 <= end; i += 1) {
    const start100Ns = readUint64BE(bytes, cursor);
    const titleLen = bytes[cursor + 8];
    const titleStart = cursor + 9;
    const titleEnd = titleStart + titleLen;
    if (titleEnd > end) break;

    const title = decodeText(bytes.subarray(titleStart, titleEnd), 'utf-8') || `Chapter ${i + 1}`;
    chapters.push({
      index: i,
      title,
      startSec: Math.max(0, Math.round(start100Ns / 1e7)),
    });
    cursor = titleEnd;
  }

  return chapters;
}

const MP4_CONTAINERS = new Set(['moov', 'udta', 'meta', 'ilst']);
const MP4_ILST_KEYS = new Set(['\u00a9nam', '\u00a9ART', '\u00a9wrt', '\u00a9alb', 'aART', '\u00a9day', 'desc', 'ldes']);

/**
 * Parse MP4 / M4B container atoms recursively for metadata and chapters.
 * @param {Uint8Array} bytes
 */
function parseMp4Atoms(bytes) {
  if (bytes.length < 8) return null;

  const result = {
    title: '',
    author: '',
    albumAuthor: '',
    series: '',
    narrator: '',
    year: '',
    description: '',
    durationSec: 0,
    chapters: [],
    found: false,
  };

  function walk(start, end, depth) {
    if (depth > 8) return;
    let cursor = start;
    while (cursor + 8 <= end) {
      let size = readUint32BE(bytes, cursor);
      const type = readLatin1(bytes, cursor + 4, 4);

      if (size === 0) {
        size = end - cursor;
      } else if (size === 1 && cursor + 16 <= end) {
        size = readUint64BE(bytes, cursor + 8);
      }

      if (!Number.isFinite(size) || size < 8) break;
      const boxEnd = Math.min(end, cursor + size);
      const headerSize = readUint32BE(bytes, cursor) === 1 ? 16 : 8;
      const payloadStart = cursor + headerSize;

      if (payloadStart > boxEnd) break;

      if (MP4_CONTAINERS.has(type)) {
        let childStart = payloadStart;
        if (type === 'meta' && payloadStart + 4 <= boxEnd) {
          // ISO BMFF `meta` is a FullBox with 4 bytes version/flags before child boxes.
          const potentialChildType = readLatin1(bytes, payloadStart + 4, 4);
          if (!MP4_CONTAINERS.has(potentialChildType) && bytes[payloadStart] === 0) {
            childStart = payloadStart + 4;
          } else if (bytes[payloadStart] === 0 && bytes[payloadStart + 1] === 0) {
            childStart = payloadStart + 4;
          }
        }
        walk(childStart, boxEnd, depth + 1);
      } else if (MP4_ILST_KEYS.has(type)) {
        const value = extractMp4IlstText(bytes, payloadStart, boxEnd);
        if (value) {
          result.found = true;
          if (type === '\u00a9nam' && !result.title) result.title = value;
          else if (type === '\u00a9ART' && !result.author) result.author = value;
          else if (type === 'aART' && !result.albumAuthor) result.albumAuthor = value;
          else if (type === '\u00a9wrt' && !result.narrator) result.narrator = value;
          else if (type === '\u00a9alb' && !result.series) result.series = value;
          else if (type === '\u00a9day' && !result.year) result.year = value.slice(0, 4);
          else if ((type === 'ldes' || type === 'desc') && !result.description) result.description = value;
        }
      } else if (type === 'chpl') {
        const chapters = parseChplAtom(bytes, payloadStart, boxEnd);
        if (chapters.length > 0) {
          result.chapters = chapters;
          result.found = true;
        }
      } else if (type === 'mvhd' && payloadStart + 20 <= boxEnd) {
        const version = bytes[payloadStart];
        if (version === 0 && payloadStart + 20 <= boxEnd) {
          const timescale = readUint32BE(bytes, payloadStart + 12);
          const duration = readUint32BE(bytes, payloadStart + 16);
          if (timescale > 0 && duration > 0) {
            result.durationSec = Math.round(duration / timescale);
          }
        } else if (version === 1 && payloadStart + 32 <= boxEnd) {
          const timescale = readUint32BE(bytes, payloadStart + 20);
          const duration = readUint64BE(bytes, payloadStart + 24);
          if (timescale > 0 && duration > 0) {
            result.durationSec = Math.round(duration / timescale);
          }
        }
      }

      if (boxEnd <= cursor) break;
      cursor = boxEnd;
    }
  }

  // Quick sanity check: look for a valid top-level MP4 box signature in first 8 bytes
  const firstType = readLatin1(bytes, 4, 4);
  if (!/^[a-zA-Z0-9\u00a9 ]{4}$/.test(firstType)) {
    return null;
  }

  walk(0, bytes.length, 0);

  if (!result.author && result.albumAuthor) {
    result.author = result.albumAuthor;
  }

  return result.found ? result : null;
}

/**
 * Safely parse ID3v2 and MP4/M4B metadata from a binary buffer, falling back
 * to filename parsing when tags are missing, truncated, or malformed.
 * Never throws.
 * @param {Uint8Array|ArrayBuffer|Buffer|null|undefined} uint8ArrayOrBuffer
 * @param {string} [filename='']
 */
export function parseAudioTags(uint8ArrayOrBuffer, filename = '') {
  const fallback = parseFilenameMetadata(filename);
  const bytes = toUint8Array(uint8ArrayOrBuffer);

  let parsed = null;
  let source = fallback.title ? 'filename' : 'none';

  try {
    if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
      parsed = parseId3v2(bytes);
      if (parsed) source = 'id3v2';
    } else if (bytes.length >= 8) {
      parsed = parseMp4Atoms(bytes);
      if (parsed) source = 'mp4';
    }
  } catch {
    parsed = null;
  }

  const title = parsed?.title || fallback.title || '';
  const author = parsed?.author || fallback.author || '';
  const series = parsed?.series || fallback.series || '';
  const narrator = parsed?.narrator || '';
  const description = parsed?.description || '';
  const year = parsed?.year || '';
  const chapters = Array.isArray(parsed?.chapters) ? parsed.chapters : [];
  const totalDurationSec = parsed?.durationSec || 0;

  return {
    title,
    author,
    narrator,
    series,
    album: series,
    description,
    year,
    totalDurationSec,
    chapters,
    source,
  };
}

function stripHtml(text = '') {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function upgradeItunesArtwork(url = '') {
  if (!url || typeof url !== 'string') return '';
  return url
    .replace(/^http:\/\//i, 'https://')
    .replace(/\/\d+x\d+bb\./i, '/600x600bb.');
}

async function safeFetchJson(url, fetchImpl) {
  if (typeof fetchImpl !== 'function') return null;
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Enrich an audiobook object with narrator, author, description, duration,
 * and high-res cover art from iTunes Search, Audnexus, and Open Library.
 * @param {object} book
 * @param {typeof fetch} [fetchImpl=globalThis.fetch]
 * @returns {Promise<object>}
 */
export async function enrichBookMetadata(book = {}, fetchImpl = globalThis.fetch) {
  const title = (book.title || '').trim();
  const author = (book.author || '').trim();
  const query = [title, author].filter(Boolean).join(' ').trim();

  if (!query || typeof fetchImpl !== 'function') {
    return { ...book };
  }

  const itunesUrl = `https://itunes.apple.com/search?media=audiobook&limit=5&term=${encodeURIComponent(query)}`;
  const openLibUrl = title
    ? `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}${author ? `&author=${encodeURIComponent(author)}` : ''}&limit=5`
    : `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=5`;
  const audnexusUrl = book.asin
    ? `https://api.audnex.us/books/${encodeURIComponent(book.asin)}`
    : `https://api.audnex.us/books?title=${encodeURIComponent(title || query)}${author ? `&author=${encodeURIComponent(author)}` : ''}`;

  const [itunesRes, audnexusRes, openLibRes] = await Promise.allSettled([
    safeFetchJson(itunesUrl, fetchImpl),
    safeFetchJson(audnexusUrl, fetchImpl),
    safeFetchJson(openLibUrl, fetchImpl),
  ]);

  const itunesData = itunesRes.status === 'fulfilled' ? itunesRes.value : null;
  const audnexusData = audnexusRes.status === 'fulfilled' ? audnexusRes.value : null;
  const openLibData = openLibRes.status === 'fulfilled' ? openLibRes.value : null;

  const itunesHit = Array.isArray(itunesData?.results) ? itunesData.results[0] : null;
  const audnexusHit = Array.isArray(audnexusData) ? audnexusData[0] : audnexusData;
  const openLibHit = Array.isArray(openLibData?.docs) ? openLibData.docs[0] : null;

  const audnexusNarrator = Array.isArray(audnexusHit?.narrators)
    ? audnexusHit.narrators.map((n) => n?.name || n).filter(Boolean).join(', ')
    : audnexusHit?.narrator || '';
  const audnexusAuthor = Array.isArray(audnexusHit?.authors)
    ? audnexusHit.authors.map((a) => a?.name || a).filter(Boolean).join(', ')
    : audnexusHit?.author || '';
  const audnexusDurationSec = audnexusHit?.runtimeLengthMin
    ? Math.round(Number(audnexusHit.runtimeLengthMin) * 60)
    : Number(audnexusHit?.totalDurationSec || 0);

  const itunesDurationSec = itunesHit?.trackTimeMillis
    ? Math.round(Number(itunesHit.trackTimeMillis) / 1000)
    : 0;
  const itunesDescription = stripHtml(itunesHit?.description || '');

  // Attempt to extract "narrated by X" from description if narrator still missing
  let inferredNarrator = '';
  if (!book.narrator && !audnexusNarrator && itunesDescription) {
    const narrMatch = itunesDescription.match(/narrated by\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3})/);
    if (narrMatch) inferredNarrator = narrMatch[1].trim();
  }

  const openLibAuthor = Array.isArray(openLibHit?.author_name) ? openLibHit.author_name[0] : '';
  const openLibCover = openLibHit?.cover_i
    ? `https://covers.openlibrary.org/b/id/${openLibHit.cover_i}-L.jpg`
    : '';
  const openLibDescription = Array.isArray(openLibHit?.first_sentence)
    ? openLibHit.first_sentence[0]
    : typeof openLibHit?.first_sentence === 'string'
      ? openLibHit.first_sentence
      : '';

  return {
    ...book,
    author: book.author || audnexusAuthor || itunesHit?.artistName || openLibAuthor || '',
    narrator: book.narrator || audnexusNarrator || inferredNarrator || '',
    description:
      book.description ||
      stripHtml(audnexusHit?.summary || audnexusHit?.description || '') ||
      itunesDescription ||
      openLibDescription ||
      '',
    totalDurationSec:
      book.totalDurationSec ||
      audnexusDurationSec ||
      itunesDurationSec ||
      0,
    coverUrl:
      book.coverUrl ||
      upgradeItunesArtwork(itunesHit?.artworkUrl100 || '') ||
      audnexusHit?.image ||
      openLibCover ||
      '',
    series:
      book.series ||
      audnexusHit?.seriesPrimary?.name ||
      '',
    year:
      book.year ||
      (itunesHit?.releaseDate ? String(itunesHit.releaseDate).slice(0, 4) : '') ||
      (openLibHit?.first_publish_year ? String(openLibHit.first_publish_year) : ''),
  };
}
