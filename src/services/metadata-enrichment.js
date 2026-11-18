/**
 * Audio tag parser (ID3v2 + MP4/M4B atoms) and online audiobook metadata enrichment.
 */

const AUDIO_EXT_RE = /\.(m4b|mp3|m4a|ogg|flac|aac|wav|opus)$/i;
const TRACK_PREFIX_RE = /^(?:\d{1,4}|(?:part|pt|chapter|chap|ch|disc|cd|track|tr)\s*\d+)$/i;
const GENERIC_SECTION_ONLY_RE = /^(?:disc|cd|part|pt|chapter|chap|ch|track|tr|volume|vol|book|act|tome|episode|ep)$/i;
const ROMAN_MAP = new Map([
  ['I', 1], ['II', 2], ['III', 3], ['IV', 4], ['V', 5],
  ['VI', 6], ['VII', 7], ['VIII', 8], ['IX', 9], ['X', 10],
  ['XI', 11], ['XII', 12], ['XIII', 13], ['XIV', 14], ['XV', 15],
  ['XVI', 16], ['XVII', 17], ['XVIII', 18], ['XIX', 19], ['XX', 20],
]);

const KNOWN_FRANCHISES = [
  {
    series: 'The Expanse',
    author: 'James S. A. Corey',
    requireHintForAmbiguous: true,
    hintRe: /\b(expanse|corey|leviathan|caliban|abaddon|cibola|nemesis|babylon|persepolis|tiamat)\b/i,
    books: [
      { order: 0.1, title: 'drive', ambiguous: true },
      { order: 0.2, title: 'the churn', ambiguous: true },
      { order: 0.5, title: 'the butcher of anderson station', ambiguous: false },
      { order: 1, title: 'leviathan wakes', ambiguous: false },
      { order: 2, title: "caliban's war", ambiguous: false },
      { order: 2, title: 'calibans war', ambiguous: false },
      { order: 3, title: "abaddon's gate", ambiguous: false },
      { order: 3, title: 'abaddons gate', ambiguous: false },
      { order: 3.5, title: 'gods of risk', ambiguous: false },
      { order: 4, title: 'cibola burn', ambiguous: false },
      { order: 5, title: 'nemesis games', ambiguous: false },
      { order: 6, title: "babylon's ashes", ambiguous: false },
      { order: 6, title: 'babylons ashes', ambiguous: false },
      { order: 6.5, title: 'the vital abyss', ambiguous: false },
      { order: 7, title: 'persepolis rising', ambiguous: false },
      { order: 7.5, title: 'strange dogs', ambiguous: false },
      { order: 8, title: "tiamat's wrath", ambiguous: false },
      { order: 8, title: 'tiamats wrath', ambiguous: false },
      { order: 8.5, title: 'auberon', ambiguous: false },
      { order: 9, title: 'leviathan falls', ambiguous: false },
      { order: 9.5, title: 'the sins of our fathers', ambiguous: false },
    ],
  },
  {
    series: 'The Sandman',
    author: 'Neil Gaiman',
    requireHintForAmbiguous: false,
    hintRe: /\b(sandman|gaiman)\b/i,
    books: [
      { order: 1, title: 'the sandman', ambiguous: false },
      { order: 1, title: 'the sandman act i', ambiguous: false },
      { order: 2, title: 'the sandman act ii', ambiguous: false },
      { order: 3, title: 'the sandman act iii', ambiguous: false },
      { order: 4, title: 'the sandman act iv', ambiguous: false },
    ],
  },
  {
    series: 'Harry Potter',
    author: 'J.K. Rowling',
    requireHintForAmbiguous: false,
    hintRe: /\b(harry potter|rowling|hogwarts)\b/i,
    books: [
      { order: 1, title: "harry potter and the philosopher's stone", ambiguous: false },
      { order: 1, title: "harry potter and the sorcerer's stone", ambiguous: false },
      { order: 2, title: 'harry potter and the chamber of secrets', ambiguous: false },
      { order: 3, title: 'harry potter and the prisoner of azkaban', ambiguous: false },
      { order: 4, title: 'harry potter and the goblet of fire', ambiguous: false },
      { order: 5, title: 'harry potter and the order of the phoenix', ambiguous: false },
      { order: 6, title: 'harry potter and the half-blood prince', ambiguous: false },
      { order: 7, title: 'harry potter and the deathly hallows', ambiguous: false },
    ],
  },
];

function parseOrderToken(token = '') {
  const cleaned = String(token || '').trim().toUpperCase();
  if (!cleaned) return null;
  if (ROMAN_MAP.has(cleaned)) return ROMAN_MAP.get(cleaned);
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function stripTrailingYear(text = '') {
  return String(text || '').replace(/\s*[\(\[]\s*(?:19|20)\d{2}\s*[\)\]]\s*$/g, '').trim();
}

function normalizeMatchText(text = '') {
  return stripTrailingYear(String(text || '').replace(AUDIO_EXT_RE, ''))
    .toLowerCase()
    .replace(/[:\-–—_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchSeriesNumberPattern(raw = '') {
  const value = stripTrailingYear(String(raw || '').trim());
  if (!value) return null;

  // Pattern 1: "<Series> -? (Act|Book|Vol|Volume|Part|Tome|#) <num|Roman>"
  const keywordMatch = value.match(
    /^(.+?)\s*(?:[-–—:,]\s*|\s+)(?:act|book|vol\.?|volume|part|tome|#)\s*(\d+(?:\.\d+)?|[IVXLCDM]{1,5})\b(?:\s*[-–—:]\s*(.+))?$/i,
  );
  if (keywordMatch) {
    const candidateSeries = keywordMatch[1].replace(/[-–—:,\s]+$/, '').trim();
    const order = parseOrderToken(keywordMatch[2]);
    const remainder = (keywordMatch[3] || '').trim();
    if (
      candidateSeries.length >= 2 &&
      /[a-zA-Z]/.test(candidateSeries) &&
      !GENERIC_SECTION_ONLY_RE.test(candidateSeries) &&
      order !== null
    ) {
      return { series: candidateSeries, seriesOrder: order, remainder };
    }
  }

  // Pattern 2: "<Series> <decimal/integer>" (e.g., "The Expanse 0.1", "The Expanse 1.0", "Dune 2")
  const trailingNumMatch = value.match(/^(.+?)\s+(\d+(?:\.\d+)?)$/);
  if (trailingNumMatch) {
    const candidateSeries = trailingNumMatch[1].replace(/[-–—:,\s]+$/, '').trim();
    const numStr = trailingNumMatch[2];
    const order = Number(numStr);
    const isLikelyYear = !numStr.includes('.') && order >= 1900 && order <= 2099;
    if (
      candidateSeries.length >= 2 &&
      /[a-zA-Z]/.test(candidateSeries) &&
      !GENERIC_SECTION_ONLY_RE.test(candidateSeries) &&
      Number.isFinite(order) &&
      !isLikelyYear &&
      order <= 200
    ) {
      return { series: candidateSeries, seriesOrder: order, remainder: '' };
    }
  }

  return null;
}

function lookupKnownFranchise(title = '', author = '', series = '', parentFolderName = '') {
  const normTitle = normalizeMatchText(title);
  const hintPool = [title, author, series, parentFolderName].filter(Boolean).join(' ');
  const normSeries = normalizeMatchText(series);

  for (const franchise of KNOWN_FRANCHISES) {
    const hasHint = franchise.hintRe.test(hintPool);
    for (const entry of franchise.books) {
      if (normTitle === entry.title || (normTitle.startsWith(`${entry.title} `) && !entry.ambiguous)) {
        if (entry.ambiguous && !hasHint) continue;
        return {
          series: franchise.series,
          seriesOrder: entry.order,
          inferredAuthor: franchise.author,
        };
      }
    }
    if (normSeries && normSeries === normalizeMatchText(franchise.series)) {
      return {
        series: franchise.series,
        seriesOrder: null,
        inferredAuthor: franchise.author,
      };
    }
  }
  return null;
}

/**
 * Detect series / franchise name, numeric book order, clean title, and inferred
 * franchise author from title, author, series, or parent folder hints.
 * @param {string} title
 * @param {string} [author='']
 * @param {string} [series='']
 * @param {string} [parentFolderName='']
 * @returns {{ series: string, seriesOrder: number|null, cleanTitle: string, inferredAuthor: string, authorPolluted: boolean }}
 */
export function parseSeriesAndOrder(title = '', author = '', series = '', parentFolderName = '') {
  const rawTitle = String(title || '').trim();
  const rawAuthor = String(author || '').trim();
  const rawSeries = String(series || '').trim();
  const rawParent = String(parentFolderName || '').trim();

  let detectedSeries = '';
  let detectedOrder = null;
  let cleanTitle = rawTitle;
  let authorPolluted = false;

  // 1. Check parenthesized series markers inside title, e.g. "Leviathan Wakes (The Expanse, Book 1)"
  const parenSeriesMatch = rawTitle.match(/^(.+?)\s*\(([^()]+?)\s*(?:,\s*|\s+)(?:book|vol\.?|volume|part|#)\s*(\d+(?:\.\d+)?|[IVXLCDM]{1,5})\)\s*$/i);
  if (parenSeriesMatch) {
    const order = parseOrderToken(parenSeriesMatch[3]);
    if (order !== null) {
      cleanTitle = parenSeriesMatch[1].trim();
      detectedSeries = parenSeriesMatch[2].replace(/[,\s#]+$/, '').trim();
      detectedOrder = order;
    }
  }

  // 2. Check polluted author field (e.g. author = "The Expanse 0.1")
  if (rawAuthor) {
    const authorMatch = matchSeriesNumberPattern(rawAuthor);
    if (authorMatch) {
      detectedSeries = detectedSeries || authorMatch.series;
      if (detectedOrder === null) detectedOrder = authorMatch.seriesOrder;
      authorPolluted = true;
    }
  }

  // 3. Check explicit series field (e.g. series = "The Expanse 0.1" or "The Expanse")
  if (rawSeries) {
    const seriesMatch = matchSeriesNumberPattern(rawSeries);
    if (seriesMatch) {
      detectedSeries = seriesMatch.series;
      if (detectedOrder === null) detectedOrder = seriesMatch.seriesOrder;
    } else if (!detectedSeries) {
      detectedSeries = rawSeries;
    }
  }

  // 4. Check title for "<Series> <num> - <Title>" or "<Series> Act II"
  if (rawTitle) {
    const dashParts = rawTitle.split(/\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean);
    if (dashParts.length >= 2) {
      const leftMatch = matchSeriesNumberPattern(dashParts[0]);
      if (leftMatch) {
        detectedSeries = leftMatch.series;
        detectedOrder = leftMatch.seriesOrder;
        cleanTitle = dashParts.slice(1).join(' - ');
      }
    }
    if (detectedOrder === null) {
      const titleMatch = matchSeriesNumberPattern(rawTitle);
      if (titleMatch) {
        detectedSeries = detectedSeries || titleMatch.series;
        detectedOrder = titleMatch.seriesOrder;
        if (titleMatch.remainder) {
          cleanTitle = titleMatch.remainder;
        }
      }
    }
  }

  // 5. Check parentFolderName if series/order still missing
  if (rawParent && (!detectedSeries || detectedOrder === null)) {
    const parentMatch = matchSeriesNumberPattern(rawParent);
    if (parentMatch) {
      detectedSeries = detectedSeries || parentMatch.series;
      if (detectedOrder === null) detectedOrder = parentMatch.seriesOrder;
    } else if (!detectedSeries) {
      detectedSeries = rawParent;
    }
  }

  // 6. Known franchise lookup (e.g. The Sandman, The Expanse, Harry Potter)
  const known = lookupKnownFranchise(cleanTitle, rawAuthor, detectedSeries || rawSeries, rawParent);
  let inferredAuthor = '';
  if (known) {
    detectedSeries = known.series;
    if (detectedOrder === null && known.seriesOrder !== null) {
      detectedOrder = known.seriesOrder;
    }
    inferredAuthor = known.inferredAuthor || '';
  }

  return {
    series: detectedSeries,
    seriesOrder: detectedOrder,
    cleanTitle: cleanTitle || rawTitle,
    inferredAuthor,
    authorPolluted,
  };
}

/**
 * Returns true if the cover URL is missing or a Google Drive thumbnail URL that
 * often fails or renders as a black box for audio files.
 * @param {string} [url='']
 * @returns {boolean}
 */
export function isDriveThumbnailOrMissingCover(url = '') {
  if (!url || typeof url !== 'string' || !url.trim()) return true;
  const lower = url.trim().toLowerCase();
  return (
    lower.includes('googleusercontent.com') ||
    lower.includes('drive.google.com/thumbnail') ||
    lower.includes('docs.google.com')
  );
}

/**
 * Returns true if a book has not yet been automatically enriched and is missing
 * cover art, real author, series order, or meaningful chapter metadata.
 * @param {object} book
 * @returns {boolean}
 */
export function needsAutomatedEnrichment(book) {
  if (!book || typeof book !== 'object') return false;
  if (book.enrichmentCheckedAt) return false;
  if (isDriveThumbnailOrMissingCover(book.coverUrl)) return true;
  const author = String(book.author || '').trim();
  if (!author || author === 'Unknown Author') return true;
  if (matchSeriesNumberPattern(author)) return true;
  if (book.seriesOrder == null) return true;
  if (!Array.isArray(book.chapters) || book.chapters.length === 0) return true;
  if (book.chapters.length === 1 && /^chapter\s*1$/i.test(String(book.chapters[0]?.title || '').trim())) {
    return true;
  }
  return false;
}

const CHAPTER_SECTION_PREFIX_RE = /^(Act\s+(?:[IVXLCDM]+|\d+)|Part\s+(?:[IVXLCDM]+|\d+)|Book\s+(?:[IVXLCDM]+|\d+)|Disc\s+\d+|CD\s*\d+|Volume\s+\d+|Vol\.?\s*\d+|Section\s+\d+)\s*[-–—:]\s*(.+)$/i;
const SUBCHAPTER_TITLE_RE = /^(?:\d+\.\d+\b|(?:chapter|chap|ch)\s*\d+\.\d+\b|scene\s+\d+|subchapter\s+\d+)/i;

function extractTrackNumberFromText(text = '') {
  const clean = String(text || '').replace(AUDIO_EXT_RE, '').trim();
  if (!clean) return null;
  const lead = clean.match(/^(?:part|pt|chapter|chap|ch|disc|track|tr)?[\s._-]*0*(\d{1,4})\b/i);
  if (lead) return Number(lead[1]);
  const anyPart = clean.match(/\b(?:part|pt|chapter|chap|ch|track|tr)[\s._-]*0*(\d{1,4})\b/i);
  if (anyPart) return Number(anyPart[1]);
  return null;
}

/**
 * Normalize book chapters, extracting hierarchical sectionTitle / level and
 * fixing duplicate book-title track names (e.g., "Lincoln in the Bardo" repeated
 * on every track) and computing cumulative startSec when durationSec is known.
 * @param {Array<object>} chapters
 * @param {string} [bookTitle='']
 * @returns {Array<object>}
 */
export function normalizeBookChapters(chapters = [], bookTitle = '') {
  if (!Array.isArray(chapters) || chapters.length === 0) return [];

  const normBook = normalizeMatchText(bookTitle);
  const titleCounts = new Map();
  const prelim = chapters.map((ch, idx) => {
    const rawSource = String(ch?.rawTitle || ch?.title || '').trim();
    const rawFile = String(ch?.fileName || ch?.localFile?.name || '').replace(AUDIO_EXT_RE, '').trim();
    let title = rawSource;
    let sectionTitle = String(ch?.sectionTitle || '').trim();
    let level = Number.isInteger(ch?.level) ? ch.level : 0;

    // Strip leading numeric prefix like "01 - " if present in title
    const strippedLead = title.replace(/^\d{1,4}\s*[-–—.]\s+/, '').trim();
    if (strippedLead) title = strippedLead;

    const secMatch = title.match(CHAPTER_SECTION_PREFIX_RE);
    if (secMatch) {
      const prefix = secMatch[1].trim();
      const rest = secMatch[2].trim();
      if (normBook && normalizeMatchText(rest) === normBook) {
        // e.g. "Part 1 - Lincoln in the Bardo" -> chapter title is "Part 1"
        title = prefix;
      } else if (rest) {
        if (!sectionTitle) sectionTitle = prefix;
        title = rest;
        level = Math.max(level, 1);
      }
    } else if (SUBCHAPTER_TITLE_RE.test(title) || sectionTitle) {
      level = Math.max(level, 1);
    }

    const normT = normalizeMatchText(title);
    if (normT) {
      titleCounts.set(normT, (titleCounts.get(normT) || 0) + 1);
    }

    return {
      ...ch,
      index: idx,
      title,
      rawFile,
      sectionTitle,
      level,
      startSec: Math.max(0, Number(ch?.startSec || 0) || 0),
      ...(Number(ch?.durationSec) > 0 ? { durationSec: Math.round(Number(ch.durationSec)) } : {}),
    };
  });

  const normalized = prelim.map((ch, idx) => {
    const normT = normalizeMatchText(ch.title);
    const repeatsBookTitle = Boolean(normBook && normT === normBook);
    const isDuplicateTitle = Boolean(normT && (titleCounts.get(normT) || 0) > 1);
    let finalTitle = ch.title;

    if (!finalTitle || repeatsBookTitle || (isDuplicateTitle && (repeatsBookTitle || prelim.length > 1))) {
      const trackNum =
        extractTrackNumberFromText(ch.rawFile) ||
        extractTrackNumberFromText(ch.rawTitle) ||
        idx + 1;
      finalTitle = prelim.length === 1 ? `Chapter ${trackNum}` : `Part ${trackNum}`;
    }

    const out = { ...ch, title: finalTitle };
    delete out.rawFile;
    if (!out.sectionTitle) delete out.sectionTitle;
    return out;
  });

  // Compute cumulative startSec for multi-file chapters when durations are available
  let runningSec = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (i === 0) {
      runningSec = ch.startSec + (Number(ch.durationSec) > 0 ? Number(ch.durationSec) : 0);
    } else if (ch.startSec === 0 && runningSec > 0) {
      ch.startSec = runningSec;
      runningSec = Number(ch.durationSec) > 0 ? runningSec + Number(ch.durationSec) : 0;
    } else {
      runningSec = ch.startSec + (Number(ch.durationSec) > 0 ? Number(ch.durationSec) : 0);
    }
  }

  // Backfill missing durationSec on single-file timestamped chapters from next startSec
  for (let i = 0; i < normalized.length - 1; i += 1) {
    const cur = normalized[i];
    const next = normalized[i + 1];
    if (!cur.durationSec && next.startSec > cur.startSec) {
      cur.durationSec = next.startSec - cur.startSec;
    }
  }

  return normalized;
}

/**
 * Non-destructively normalize a book's series, seriesOrder, author (fixing
 * polluted series+order values like "The Expanse 0.1"), and chapters.
 * @param {object} book
 * @returns {object}
 */
export function normalizeBookSeriesAndChapters(book) {
  if (!book || typeof book !== 'object') return book;

  const parsed = parseSeriesAndOrder(
    book.title || '',
    book.author || '',
    book.series || '',
    book.parentFolderName || '',
  );

  let author = String(book.author || '').trim();
  if (parsed.authorPolluted || !author) {
    author = parsed.inferredAuthor || (parsed.authorPolluted ? 'Unknown Author' : author);
  } else if (author === 'Unknown Author' && parsed.inferredAuthor) {
    author = parsed.inferredAuthor;
  }

  const series = parsed.series || String(book.series || '').trim();
  const seriesOrder =
    parsed.seriesOrder !== null
      ? parsed.seriesOrder
      : book.seriesOrder != null && Number.isFinite(Number(book.seriesOrder))
        ? Number(book.seriesOrder)
        : null;

  const chapters = Array.isArray(book.chapters)
    ? normalizeBookChapters(book.chapters, book.title || parsed.cleanTitle || '')
    : [];

  return {
    ...book,
    author,
    series,
    seriesOrder,
    chapters,
  };
}

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
 * Parse filename into fallback title, author, and optional series + seriesOrder.
 * Examples:
 *  - "Andy Weir - Project Hail Mary.m4b" -> { title: "Project Hail Mary", author: "Andy Weir" }
 *  - "The Expanse 0.1 - Drive (2013).m4b" -> { title: "Drive (2013)", series: "The Expanse", seriesOrder: 0.1 }
 *  - "Project Hail Mary by Andy Weir.mp3" -> { title: "Project Hail Mary", author: "Andy Weir" }
 * @param {string} filename
 * @returns {{ title: string, author: string, series: string, seriesOrder: number|null }}
 */
export function parseFilenameMetadata(filename = '') {
  if (!filename || typeof filename !== 'string') {
    return { title: '', author: '', series: '', seriesOrder: null };
  }

  const leaf = filename.split(/[/\\]/).pop() || '';
  const withoutExt = leaf.replace(AUDIO_EXT_RE, '').trim();
  const cleaned = withoutExt.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return { title: '', author: '', series: '', seriesOrder: null };
  }

  const dashParts = cleaned.split(/\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean);
  if (dashParts.length === 2) {
    const [left, right] = dashParts;
    if (TRACK_PREFIX_RE.test(left)) {
      return { title: right, author: '', series: '', seriesOrder: null };
    }
    const leftSeries = matchSeriesNumberPattern(left);
    if (leftSeries) {
      const known = lookupKnownFranchise(right, '', leftSeries.series, '');
      return {
        title: right,
        author: known?.inferredAuthor || '',
        series: known?.series || leftSeries.series,
        seriesOrder: leftSeries.seriesOrder,
      };
    }
    const rightSeries = matchSeriesNumberPattern(right);
    if (rightSeries) {
      const known = lookupKnownFranchise(left, '', rightSeries.series, '');
      return {
        title: left,
        author: known?.inferredAuthor || '',
        series: known?.series || rightSeries.series,
        seriesOrder: rightSeries.seriesOrder,
      };
    }
    const parsed = parseSeriesAndOrder(right, left, '', '');
    return {
      title: right,
      author: left,
      series: parsed.series || '',
      seriesOrder: parsed.seriesOrder,
    };
  }

  if (dashParts.length >= 3) {
    const [first, second, ...rest] = dashParts;
    if (TRACK_PREFIX_RE.test(first)) {
      return { title: [second, ...rest].join(' - '), author: '', series: '', seriesOrder: null };
    }
    const firstSeries = matchSeriesNumberPattern(first);
    if (firstSeries) {
      const titleStr = [second, ...rest].join(' - ');
      const known = lookupKnownFranchise(titleStr, '', firstSeries.series, '');
      return {
        author: known?.inferredAuthor || '',
        series: known?.series || firstSeries.series,
        seriesOrder: firstSeries.seriesOrder,
        title: titleStr,
      };
    }
    const secondSeries = matchSeriesNumberPattern(second);
    if (secondSeries) {
      return {
        author: first,
        series: secondSeries.series,
        seriesOrder: secondSeries.seriesOrder,
        title: rest.join(' - '),
      };
    }
    return {
      author: first,
      series: second,
      seriesOrder: null,
      title: rest.join(' - '),
    };
  }

  const byMatch = cleaned.match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch) {
    const t = byMatch[1].trim();
    const a = byMatch[2].trim();
    const parsed = parseSeriesAndOrder(t, a, '', '');
    return {
      title: t,
      author: a,
      series: parsed.series || '',
      seriesOrder: parsed.seriesOrder,
    };
  }

  const parsed = parseSeriesAndOrder(cleaned, '', '', '');
  return {
    title: cleaned,
    author: parsed.inferredAuthor || '',
    series: parsed.series || '',
    seriesOrder: parsed.seriesOrder,
  };
}

function parseId3ChapFrame(payload, major, fallbackIndex) {
  let nullIdx = -1;
  for (let i = 0; i < payload.length; i += 1) {
    if (payload[i] === 0) {
      nullIdx = i;
      break;
    }
  }
  if (nullIdx < 0 || nullIdx + 17 > payload.length) return null;

  const elementId = decodeText(payload.subarray(0, nullIdx), 'latin1');
  const startMs = readUint32BE(payload, nullIdx + 1);
  const endMs = readUint32BE(payload, nullIdx + 5);

  let title = '';
  let subOffset = nullIdx + 17;
  while (subOffset + 10 <= payload.length) {
    if (payload[subOffset] === 0) break;
    const subId = readAscii(payload, subOffset, 4);
    if (!/^[A-Z0-9]{4}$/.test(subId)) break;
    const subSize = major === 4 ? readSynchsafe32(payload, subOffset + 4) : readUint32BE(payload, subOffset + 4);
    if (subSize <= 0) break;
    const subStart = subOffset + 10;
    const subEnd = Math.min(payload.length, subStart + subSize);
    if (subId === 'TIT2' && !title) {
      title = decodeId3Text(payload.subarray(subStart, subEnd));
    }
    if (subEnd >= payload.length) break;
    subOffset = subStart + subSize;
  }

  const startSec = Math.max(0, Math.round(startMs / 1000));
  const durationSec =
    endMs !== 0xffffffff && endMs > startMs ? Math.max(1, Math.round((endMs - startMs) / 1000)) : 0;

  return {
    index: fallbackIndex,
    title: title || elementId || `Chapter ${fallbackIndex + 1}`,
    startSec,
    ...(durationSec > 0 ? { durationSec } : {}),
  };
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
      } else if (frameId === 'CHAP') {
        const chap = parseId3ChapFrame(payload, major, result.chapters.length);
        if (chap) {
          result.chapters.push(chap);
          result.found = true;
        }
      }

      if (dataEnd >= tagEnd) break;
      offset = dataStart + frameSize;
    }
  }

  if (!result.author && result.albumAuthor) {
    result.author = result.albumAuthor;
  }

  if (result.chapters.length > 1) {
    result.chapters.sort((a, b) => a.startSec - b.startSec);
    result.chapters = result.chapters.map((ch, idx) => ({ ...ch, index: idx }));
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

  if (result.chapters.length > 0) {
    for (let i = 0; i < result.chapters.length; i += 1) {
      const cur = result.chapters[i];
      const next = result.chapters[i + 1];
      if (!cur.durationSec) {
        if (next && next.startSec > cur.startSec) {
          cur.durationSec = next.startSec - cur.startSec;
        } else if (!next && result.durationSec > cur.startSec) {
          cur.durationSec = result.durationSec - cur.startSec;
        }
      }
    }
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
  const rawAuthor = parsed?.author || fallback.author || '';
  const rawSeries = parsed?.series || fallback.series || '';
  const seriesParsed = parseSeriesAndOrder(title, rawAuthor, rawSeries, '');
  const author = seriesParsed.authorPolluted
    ? (seriesParsed.inferredAuthor || '')
    : (rawAuthor || seriesParsed.inferredAuthor || '');
  const series = seriesParsed.series || rawSeries || '';
  const seriesOrder = seriesParsed.seriesOrder ?? fallback.seriesOrder ?? null;
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
    seriesOrder,
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

function upgradeGoogleBooksCover(imageLinks = {}) {
  if (!imageLinks || typeof imageLinks !== 'object') return '';
  const raw =
    imageLinks.extraLarge ||
    imageLinks.large ||
    imageLinks.medium ||
    imageLinks.thumbnail ||
    imageLinks.smallThumbnail ||
    '';
  if (!raw) return '';
  return raw.replace(/^http:\/\//i, 'https://').replace(/&edge=curl/gi, '');
}

async function safeFetchJson(url, fetchImpl, timeoutMs = 0) {
  if (typeof fetchImpl !== 'function') return null;
  let ctrl = null;
  let timer = null;
  try {
    if (timeoutMs > 0 && typeof AbortController !== 'undefined') {
      ctrl = new AbortController();
      timer = setTimeout(() => ctrl.abort(), timeoutMs);
    }
    const res = await fetchImpl(
      url,
      ctrl ? { headers: { Accept: 'application/json' }, signal: ctrl.signal } : { headers: { Accept: 'application/json' } },
    );
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cleanSearchTitleForLookup(title = '') {
  return stripTrailingYear(title)
    .replace(/\s*[-–—:]?\s*\bAct\s+(?:[IVXLCDM]+|\d+)\b\s*$/i, '')
    .trim();
}

function pickBestHit(items, getTitle, targetTitle) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const normTarget = normalizeMatchText(targetTitle);
  if (!normTarget) return items[0];
  const exact = items.find((item) => normalizeMatchText(getTitle(item)) === normTarget);
  if (exact) return exact;
  const partial = items.find((item) => {
    const cand = normalizeMatchText(getTitle(item));
    return cand && (cand.includes(normTarget) || normTarget.includes(cand));
  });
  return partial || items[0];
}

function parseNumericSeriesPosition(pos) {
  if (pos === null || pos === undefined || pos === '') return null;
  if (typeof pos === 'number') return Number.isFinite(pos) ? pos : null;
  const match = String(pos).match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isFinite(num) ? num : null;
}

function shouldFetchAudnexusChapters(book, asin) {
  if (!asin) return false;
  const chapters = Array.isArray(book.chapters) ? book.chapters : [];
  // Do not overwrite multi-file audio tracks that each point to distinct files/URLs
  const distinctTracks = new Set(
    chapters.map((c) => c?.driveFileId || c?.driveStreamUrl || c?.localUrl).filter(Boolean),
  );
  if (distinctTracks.size > 1) return false;
  if (chapters.length === 0) return true;
  if (chapters.length === 1 && /^chapter\s*1$/i.test(String(chapters[0]?.title || '').trim())) {
    return true;
  }
  return chapters.some((c) => !c?.title || (!c?.durationSec && chapters.length === 1));
}

/**
 * Enrich an audiobook object with narrator, author, description, duration,
 * series/seriesOrder, chapters, and high-res cover art from iTunes Search,
 * Audnexus, Google Books, and Open Library.
 * @param {object} book
 * @param {typeof fetch | { fetchImpl?: typeof fetch }} [fetchImplOrOptions=globalThis.fetch]
 * @param {object} [maybeOptions={}]
 * @returns {Promise<object>}
 */
export async function enrichBookMetadata(book = {}, fetchImplOrOptions = globalThis.fetch, maybeOptions = {}) {
  const fetchImpl =
    typeof fetchImplOrOptions === 'function'
      ? fetchImplOrOptions
      : (fetchImplOrOptions?.fetchImpl || globalThis.fetch);
  const options =
    typeof fetchImplOrOptions === 'function'
      ? (maybeOptions || {})
      : (fetchImplOrOptions || {});
  const chapterTimeoutMs = Number(options.chapterTimeoutMs) > 0 ? Number(options.chapterTimeoutMs) : 4500;

  const normalized = normalizeBookSeriesAndChapters(book);
  const parsedLocal = parseSeriesAndOrder(
    book.title || '',
    book.author || '',
    book.series || '',
    book.parentFolderName || '',
  );

  const rawTitle = (parsedLocal.cleanTitle || normalized.title || book.title || '').trim();
  const searchTitle = cleanSearchTitleForLookup(rawTitle) || stripTrailingYear(rawTitle) || rawTitle;

  const currentAuthor = String(normalized.author || '').trim();
  const currentSeries = String(normalized.series || '').trim();
  const authorIsInvalid =
    !currentAuthor ||
    currentAuthor === 'Unknown Author' ||
    (currentSeries && currentAuthor.toLowerCase() === currentSeries.toLowerCase()) ||
    Boolean(matchSeriesNumberPattern(currentAuthor));

  const searchAuthor = authorIsInvalid ? (parsedLocal.inferredAuthor || '') : currentAuthor;
  const query = [searchTitle, searchAuthor].filter(Boolean).join(' ').trim();

  if (!query || typeof fetchImpl !== 'function') {
    return normalized;
  }

  const itunesUrl = `https://itunes.apple.com/search?media=audiobook&limit=5&term=${encodeURIComponent(query)}`;
  const openLibUrl = searchTitle
    ? `https://openlibrary.org/search.json?title=${encodeURIComponent(searchTitle)}${searchAuthor ? `&author=${encodeURIComponent(searchAuthor)}` : ''}&limit=5`
    : `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=5`;
  const audnexusUrl = book.asin
    ? `https://api.audnex.us/books/${encodeURIComponent(book.asin)}`
    : `https://api.audnex.us/books?title=${encodeURIComponent(searchTitle || query)}${searchAuthor ? `&author=${encodeURIComponent(searchAuthor)}` : ''}`;
  const googleBooksUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5`;

  const [itunesRes, audnexusRes, openLibRes, googleBooksRes] = await Promise.allSettled([
    safeFetchJson(itunesUrl, fetchImpl),
    safeFetchJson(audnexusUrl, fetchImpl),
    safeFetchJson(openLibUrl, fetchImpl),
    safeFetchJson(googleBooksUrl, fetchImpl),
  ]);

  const itunesData = itunesRes.status === 'fulfilled' ? itunesRes.value : null;
  const audnexusData = audnexusRes.status === 'fulfilled' ? audnexusRes.value : null;
  const openLibData = openLibRes.status === 'fulfilled' ? openLibRes.value : null;
  const googleBooksData = googleBooksRes.status === 'fulfilled' ? googleBooksRes.value : null;

  const itunesHit = pickBestHit(
    itunesData?.results,
    (item) => item?.collectionName || item?.trackName || '',
    searchTitle,
  );
  const audnexusList = Array.isArray(audnexusData) ? audnexusData : audnexusData ? [audnexusData] : [];
  const audnexusHit = pickBestHit(audnexusList, (item) => item?.title || '', searchTitle);
  const openLibHit = pickBestHit(openLibData?.docs, (item) => item?.title || '', searchTitle);
  const googleHit = pickBestHit(
    googleBooksData?.items,
    (item) => item?.volumeInfo?.title || '',
    searchTitle,
  );

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
  if (!normalized.narrator && !audnexusNarrator && itunesDescription) {
    const narrMatch = itunesDescription.match(/narrated by\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3})/);
    if (narrMatch) inferredNarrator = narrMatch[1].trim();
  }

  const googleInfo = googleHit?.volumeInfo || null;
  const googleAuthor = Array.isArray(googleInfo?.authors) ? googleInfo.authors.join(', ') : '';
  const googleCover = upgradeGoogleBooksCover(googleInfo?.imageLinks);
  const googleDescription = stripHtml(googleInfo?.description || '');
  const googleYear = googleInfo?.publishedDate ? String(googleInfo.publishedDate).slice(0, 4) : '';

  const openLibAuthor = Array.isArray(openLibHit?.author_name) ? openLibHit.author_name[0] : '';
  const openLibCover = openLibHit?.cover_i
    ? `https://covers.openlibrary.org/b/id/${openLibHit.cover_i}-L.jpg`
    : '';
  const openLibDescription = Array.isArray(openLibHit?.first_sentence)
    ? openLibHit.first_sentence[0]
    : typeof openLibHit?.first_sentence === 'string'
      ? openLibHit.first_sentence
      : '';

  // Series & numeric seriesOrder resolution
  const audnexusSeriesName = audnexusHit?.seriesPrimary?.name || '';
  const audnexusSeriesOrder = parseNumericSeriesPosition(audnexusHit?.seriesPrimary?.position);

  const remoteTitleHints = [
    itunesHit?.collectionName,
    googleInfo?.title && googleInfo?.subtitle ? `${googleInfo.title}: ${googleInfo.subtitle}` : googleInfo?.title,
    googleInfo?.subtitle,
    openLibHit?.title,
  ].filter(Boolean);

  let remoteSeries = audnexusSeriesName || '';
  let remoteSeriesOrder = audnexusSeriesOrder;
  for (const hint of remoteTitleHints) {
    if (remoteSeries && remoteSeriesOrder !== null) break;
    const hintParsed = parseSeriesAndOrder(hint, '', remoteSeries, '');
    if (!remoteSeries && hintParsed.series) remoteSeries = hintParsed.series;
    if (remoteSeriesOrder === null && hintParsed.seriesOrder !== null) {
      remoteSeriesOrder = hintParsed.seriesOrder;
    }
  }

  const resolvedAuthor = authorIsInvalid
    ? (audnexusAuthor || itunesHit?.artistName || googleAuthor || openLibAuthor || parsedLocal.inferredAuthor || currentAuthor || '')
    : currentAuthor;

  const bestOnlineCover =
    upgradeItunesArtwork(itunesHit?.artworkUrl100 || '') ||
    audnexusHit?.image ||
    googleCover ||
    openLibCover ||
    '';

  const resolvedCover = isDriveThumbnailOrMissingCover(normalized.coverUrl)
    ? (bestOnlineCover || normalized.coverUrl || '')
    : normalized.coverUrl;

  // Fetch Audnexus chapters if ASIN matched and existing chapters are generic/missing
  const matchedAsin = book.asin || audnexusHit?.asin || '';
  let resolvedChapters = normalized.chapters;
  let resolvedDurationSec =
    normalized.totalDurationSec ||
    audnexusDurationSec ||
    itunesDurationSec ||
    0;

  if (shouldFetchAudnexusChapters(normalized, matchedAsin)) {
    const chapData = await safeFetchJson(
      `https://api.audnex.us/books/${encodeURIComponent(matchedAsin)}/chapters`,
      fetchImpl,
      chapterTimeoutMs,
    );
    if (Array.isArray(chapData?.chapters) && chapData.chapters.length > 0) {
      const existingFirst = normalized.chapters[0] || {};
      const mapped = chapData.chapters.map((ch, idx) => {
        const startSec = Number.isFinite(Number(ch.startOffsetSec))
          ? Math.max(0, Math.round(Number(ch.startOffsetSec)))
          : Math.max(0, Math.round(Number(ch.startOffsetMs || 0) / 1000));
        const durationSec = ch.lengthMs ? Math.max(1, Math.round(Number(ch.lengthMs) / 1000)) : 0;
        return {
          index: idx,
          title: ch.title || `Chapter ${idx + 1}`,
          startSec,
          ...(durationSec > 0 ? { durationSec } : {}),
          ...(existingFirst.driveFileId ? { driveFileId: existingFirst.driveFileId } : {}),
          ...(existingFirst.driveStreamUrl ? { driveStreamUrl: existingFirst.driveStreamUrl } : {}),
          ...(existingFirst.localUrl ? { localUrl: existingFirst.localUrl } : {}),
          ...(existingFirst.localFile ? { localFile: existingFirst.localFile } : {}),
        };
      });
      resolvedChapters = normalizeBookChapters(mapped, rawTitle || normalized.title || '');
      if (!resolvedDurationSec && chapData.runtimeLengthSec) {
        resolvedDurationSec = Math.round(Number(chapData.runtimeLengthSec));
      } else if (!resolvedDurationSec && chapData.runtimeLengthMs) {
        resolvedDurationSec = Math.round(Number(chapData.runtimeLengthMs) / 1000);
      }
    }
  }

  return {
    ...normalized,
    ...(matchedAsin ? { asin: matchedAsin } : {}),
    author: resolvedAuthor,
    narrator: normalized.narrator || audnexusNarrator || inferredNarrator || '',
    description:
      normalized.description ||
      stripHtml(audnexusHit?.summary || audnexusHit?.description || '') ||
      itunesDescription ||
      googleDescription ||
      openLibDescription ||
      '',
    totalDurationSec: resolvedDurationSec,
    coverUrl: resolvedCover,
    series: normalized.series || remoteSeries || '',
    seriesOrder:
      normalized.seriesOrder !== null && normalized.seriesOrder !== undefined
        ? normalized.seriesOrder
        : remoteSeriesOrder,
    chapters: resolvedChapters,
    year:
      normalized.year ||
      (itunesHit?.releaseDate ? String(itunesHit.releaseDate).slice(0, 4) : '') ||
      googleYear ||
      (openLibHit?.first_publish_year ? String(openLibHit.first_publish_year) : ''),
    enrichmentCheckedAt: new Date().toISOString(),
  };
}
