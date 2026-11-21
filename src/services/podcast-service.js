/**
 * Podcast Discovery, Multi-Tier CORS-Resilient RSS Fetching & Pure-JS XML Parser Service
 * Supports Windows Tauri desktop (`fetch_podcast_rss`), direct browser fetch, CORS proxy fallbacks,
 * Apple Podcasts search/lookup discovery, and normalized Audiobook Player podcast library items.
 */

import { buildCuratedSvgCover } from './cover-search.js';

export const PODCAST_CATEGORIES = [
  { id: 'trending', label: 'Trending', query: 'top podcasts' },
  { id: 'tech', label: 'Tech & AI', query: 'technology ai podcast' },
  { id: 'news', label: 'News', query: 'daily news podcast' },
  { id: 'history', label: 'History', query: 'history podcast' },
  { id: 'science', label: 'Science', query: 'science podcast' },
  { id: 'true-crime', label: 'True Crime', query: 'true crime podcast' },
  { id: 'comedy', label: 'Comedy', query: 'comedy podcast' },
  { id: 'business', label: 'Business', query: 'business finance podcast' },
];

const PODCAST_COVER_THEMES = [
  { id: 'emerald', label: 'Emerald', bg1: '#061512', bg2: '#0f332a', accent: '#1ed760', ring: 'rgba(30,215,96,0.28)' },
  { id: 'sapphire', label: 'Sapphire', bg1: '#070b19', bg2: '#14244d', accent: '#60a5fa', ring: 'rgba(96,165,250,0.28)' },
  { id: 'crimson', label: 'Crimson', bg1: '#15070c', bg2: '#38111f', accent: '#f43f5e', ring: 'rgba(244,63,94,0.28)' },
  { id: 'amber', label: 'Amber', bg1: '#140e06', bg2: '#36240d', accent: '#f59e0b', ring: 'rgba(245,158,11,0.28)' },
];

function buildDefaultPodcastCover(title = 'Podcast', index = 0) {
  const theme = PODCAST_COVER_THEMES[Math.abs(Number(index) || 0) % PODCAST_COVER_THEMES.length];
  return buildCuratedSvgCover(title, theme);
}

const RAW_CURATED_PODCASTS = [
  {
    id: 'curated-the-daily',
    title: 'The Daily',
    author: 'The New York Times',
    feedUrl: 'https://feeds.simplecast.com/54nAGcIl',
    genre: 'News',
    episodeCount: 1500,
    categoryIds: ['trending', 'news'],
    keywords: ['top podcasts', 'daily news podcast', 'news', 'politics', 'world', 'new york times'],
  },
  {
    id: 'curated-hard-fork',
    title: 'Hard Fork',
    author: 'Kevin Roose & Casey Newton',
    feedUrl: 'https://feeds.simplecast.com/l2i9YnTd',
    genre: 'Tech & AI',
    episodeCount: 140,
    categoryIds: ['trending', 'tech'],
    keywords: ['top podcasts', 'technology ai podcast', 'tech', 'ai', 'artificial intelligence', 'silicon valley'],
  },
  {
    id: 'curated-lex-fridman',
    title: 'Lex Fridman Podcast',
    author: 'Lex Fridman',
    feedUrl: 'https://lexfridman.com/feed/podcast/',
    genre: 'Tech & AI',
    episodeCount: 450,
    categoryIds: ['trending', 'tech', 'science'],
    keywords: ['top podcasts', 'technology ai podcast', 'science podcast', 'ai', 'robotics', 'philosophy', 'coding'],
  },
  {
    id: 'curated-darknet-diaries',
    title: 'Darknet Diaries',
    author: 'Jack Rhysider',
    feedUrl: 'https://podcast.darknetdiaries.com',
    genre: 'Tech & AI',
    episodeCount: 155,
    categoryIds: ['tech', 'true-crime'],
    keywords: ['technology ai podcast', 'true crime podcast', 'cybersecurity', 'hacking', 'security', 'tech'],
  },
  {
    id: 'curated-rest-is-history',
    title: 'The Rest Is History',
    author: 'Goalhanger Podcasts',
    feedUrl: 'https://feeds.megaphone.fm/GLT4787413333',
    genre: 'History',
    episodeCount: 520,
    categoryIds: ['trending', 'history'],
    keywords: ['top podcasts', 'history podcast', 'ancient', 'world history', 'civilization'],
  },
  {
    id: 'curated-hardcore-history',
    title: 'Dan Carlin’s Hardcore History',
    author: 'Dan Carlin',
    feedUrl: 'https://feeds.feedburner.com/dancarlin/history',
    genre: 'History',
    episodeCount: 70,
    categoryIds: ['history'],
    keywords: ['history podcast', 'dan carlin', 'military history', 'ancient rome', 'world war'],
  },
  {
    id: 'curated-short-wave',
    title: 'Short Wave',
    author: 'NPR',
    feedUrl: 'https://feeds.npr.org/510351/podcast.xml',
    genre: 'Science',
    episodeCount: 900,
    categoryIds: ['science'],
    keywords: ['science podcast', 'npr', 'physics', 'biology', 'space', 'discovery'],
  },
  {
    id: 'curated-radiolab',
    title: 'Radiolab',
    author: 'WNYC Studios',
    feedUrl: 'https://feeds.simplecast.com/EmVW7VGp',
    genre: 'Science',
    episodeCount: 600,
    categoryIds: ['trending', 'science'],
    keywords: ['top podcasts', 'science podcast', 'curiosity', 'nature', 'medicine'],
  },
  {
    id: 'curated-up-first',
    title: 'Up First from NPR',
    author: 'NPR',
    feedUrl: 'https://feeds.npr.org/510318/podcast.xml',
    genre: 'News',
    episodeCount: 1800,
    categoryIds: ['trending', 'news'],
    keywords: ['top podcasts', 'daily news podcast', 'morning news', 'npr', 'headlines'],
  },
  {
    id: 'curated-planet-money',
    title: 'Planet Money',
    author: 'NPR',
    feedUrl: 'https://feeds.npr.org/510289/podcast.xml',
    genre: 'Business',
    episodeCount: 1200,
    categoryIds: ['business', 'news'],
    keywords: ['business finance podcast', 'daily news podcast', 'economy', 'finance', 'markets', 'money'],
  },
  {
    id: 'curated-acquired',
    title: 'Acquired',
    author: 'Ben Gilbert & David Rosenthal',
    feedUrl: 'https://feeds.transistor.fm/acquired',
    genre: 'Business',
    episodeCount: 180,
    categoryIds: ['trending', 'business', 'tech'],
    keywords: ['top podcasts', 'business finance podcast', 'technology ai podcast', 'investing', 'startups', 'companies'],
  },
  {
    id: 'curated-serial',
    title: 'Serial',
    author: 'Serial Productions',
    feedUrl: 'https://feeds.simplecast.com/xl36XBC2',
    genre: 'True Crime',
    episodeCount: 60,
    categoryIds: ['trending', 'true-crime'],
    keywords: ['top podcasts', 'true crime podcast', 'investigative', 'mystery', 'crime'],
  },
  {
    id: 'curated-criminal',
    title: 'Criminal',
    author: 'Phoebe Judge',
    feedUrl: 'https://feeds.megaphone.fm/VMP7924985569',
    genre: 'True Crime',
    episodeCount: 280,
    categoryIds: ['true-crime'],
    keywords: ['true crime podcast', 'crime', 'stories', 'law', 'mystery'],
  },
  {
    id: 'curated-conan',
    title: 'Conan O’Brien Needs A Friend',
    author: 'Team Coco & Earwolf',
    feedUrl: 'https://feeds.simplecast.com/dHoohVNH',
    genre: 'Comedy',
    episodeCount: 340,
    categoryIds: ['trending', 'comedy'],
    keywords: ['top podcasts', 'comedy podcast', 'humor', 'interviews', 'conan'],
  },
  {
    id: 'curated-smartless',
    title: 'SmartLess',
    author: 'Jason Bateman, Sean Hayes, Will Arnett',
    feedUrl: 'https://rss.art19.com/smartless',
    genre: 'Comedy',
    episodeCount: 240,
    categoryIds: ['trending', 'comedy'],
    keywords: ['top podcasts', 'comedy podcast', 'celebrity', 'humor', 'conversations'],
  },
  {
    id: 'curated-99pi',
    title: '99% Invisible',
    author: 'Roman Mars',
    feedUrl: 'https://feeds.simplecast.com/BqbsxVfO',
    genre: 'History',
    episodeCount: 610,
    categoryIds: ['history', 'science', 'tech'],
    keywords: ['history podcast', 'science podcast', 'technology ai podcast', 'architecture', 'design'],
  },
];

export const CURATED_PODCAST_DIRECTORY = RAW_CURATED_PODCASTS.map((item, idx) => ({
  ...item,
  coverUrl: buildDefaultPodcastCover(item.title, idx),
}));

/**
 * Compute a deterministic lowercase alphanumeric hash/slug for a podcast feed URL.
 * @param {string} feedUrl
 * @returns {string}
 */
export function hashFeedUrl(feedUrl = '') {
  const normalized = String(feedUrl || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');

  if (!normalized) return 'defaultpodcast0';

  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = ((h2 << 5) + h2 + code) >>> 0;
  }

  const slugPart = normalized
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 14);
  const hashPart = `${h1.toString(36)}${h2.toString(36)}`.replace(/[^a-z0-9]/g, '');
  return `${slugPart}${hashPart}`.toLowerCase() || 'podcast0';
}

function normalizeFeedUrlKey(url = '') {
  return String(url || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

function extractApplePodcastId(input = '') {
  const raw = String(input || '').trim();
  if (!/podcasts\.apple\.com|itunes\.apple\.com/i.test(raw)) return null;
  const pathMatch = raw.match(/\/id(\d{5,15})\b/i);
  if (pathMatch) return pathMatch[1];
  const queryMatch = raw.match(/[?&]id=(\d{5,15})\b/i);
  return queryMatch ? queryMatch[1] : null;
}

function isDirectFeedUrl(input = '') {
  const raw = String(input || '').trim();
  if (!/^https?:\/\/\S+$/i.test(raw)) return false;
  if (extractApplePodcastId(raw)) return false;
  if (/podcasts\.apple\.com|itunes\.apple\.com/i.test(raw)) return false;
  return true;
}

function mapItunesPodcastItem(item, index = 0) {
  if (!item || typeof item.feedUrl !== 'string' || !item.feedUrl.trim()) return null;
  const feedUrl = item.feedUrl.trim();
  const title = String(item.collectionName || item.trackName || 'Untitled Podcast').trim();
  const rawCover = String(item.artworkUrl600 || item.artworkUrl100 || '').trim();
  const coverUrl = rawCover
    ? rawCover.replace(/^http:\/\//i, 'https://')
    : buildDefaultPodcastCover(title, index);

  return {
    id: String(item.collectionId || item.trackId || hashFeedUrl(feedUrl)),
    title,
    author: String(item.artistName || 'Podcast').trim(),
    feedUrl,
    coverUrl,
    genre: String(item.primaryGenreName || 'Podcast').trim(),
    episodeCount: Number(item.trackCount || 0),
  };
}

function filterCuratedPodcasts(query = '') {
  const trimmed = String(query || '').trim().toLowerCase();
  if (!trimmed || trimmed === 'top podcasts' || trimmed === 'trending') {
    return CURATED_PODCAST_DIRECTORY.map(({ categoryIds, keywords, ...rest }) => ({ ...rest }));
  }

  const matchedCategory = PODCAST_CATEGORIES.find(
    (cat) =>
      cat.id.toLowerCase() === trimmed ||
      cat.label.toLowerCase() === trimmed ||
      cat.query.toLowerCase() === trimmed
  );

  const tokens = trimmed
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length >= 2 && tok !== 'podcast' && tok !== 'podcasts');

  const matches = CURATED_PODCAST_DIRECTORY.filter((item) => {
    if (matchedCategory && item.categoryIds?.includes(matchedCategory.id)) {
      return true;
    }
    const haystack = [
      item.title,
      item.author,
      item.genre,
      ...(item.categoryIds || []),
      ...(item.keywords || []),
    ]
      .join(' ')
      .toLowerCase();

    if (haystack.includes(trimmed)) return true;
    if (tokens.length > 0 && tokens.some((tok) => haystack.includes(tok))) return true;
    return false;
  });

  const list = matches.length > 0 ? matches : CURATED_PODCAST_DIRECTORY;
  return list.map(({ categoryIds, keywords, ...rest }) => ({ ...rest }));
}

/**
 * Search podcasts via Apple Podcasts Directory API with automatic direct RSS detection,
 * Apple Podcasts `/id12345` lookup resolution, and curated directory merge/fallback.
 *
 * @param {string} query
 * @param {{ fetchImpl?: typeof fetch, limit?: number }} [options]
 * @returns {Promise<Array<{ id: string, title: string, author: string, feedUrl: string, coverUrl: string, genre: string, episodeCount: number, isDirectFeed?: boolean }>>}
 */
export async function searchPodcasts(query = '', options = {}) {
  const trimmed = String(query || '').trim();
  const limit = Number(options.limit) > 0 ? Math.min(Number(options.limit), 50) : 15;
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  // 1. Direct RSS URL pasted into search box
  if (isDirectFeedUrl(trimmed)) {
    return [
      {
        id: `direct-${hashFeedUrl(trimmed)}`,
        title: trimmed,
        author: 'Direct RSS Feed',
        feedUrl: trimmed,
        coverUrl: buildDefaultPodcastCover(trimmed, 0),
        genre: 'Podcast',
        episodeCount: 0,
        isDirectFeed: true,
      },
    ];
  }

  // 2. Apple Podcasts link containing /id(\d+)
  const appleId = extractApplePodcastId(trimmed);
  if (appleId) {
    if (typeof fetchImpl === 'function') {
      try {
        const lookupUrl = `https://itunes.apple.com/lookup?id=${encodeURIComponent(appleId)}&entity=podcast`;
        const res = await fetchImpl(lookupUrl, {
          headers: { Accept: 'application/json' },
        });
        if (res && res.ok) {
          const data = await res.json();
          const mapped = (Array.isArray(data?.results) ? data.results : [])
            .map((item, idx) => mapItunesPodcastItem(item, idx))
            .filter(Boolean);
          if (mapped.length > 0) {
            return mapped.slice(0, limit);
          }
        }
      } catch {
        // Fall through to curated fallback
      }
    }
    return filterCuratedPodcasts('').slice(0, limit);
  }

  // 3. Keyword or Category search via Apple Podcasts Search API + Curated Directory
  const matchedCat = PODCAST_CATEGORIES.find(
    (cat) => cat.id.toLowerCase() === trimmed.toLowerCase() || cat.label.toLowerCase() === trimmed.toLowerCase()
  );
  const searchTerm = matchedCat ? matchedCat.query : trimmed || 'top podcasts';

  const results = [];
  const seenFeeds = new Set();

  if (typeof fetchImpl === 'function') {
    try {
      const searchUrl = `https://itunes.apple.com/search?media=podcast&entity=podcast&limit=${limit}&term=${encodeURIComponent(searchTerm)}`;
      const res = await fetchImpl(searchUrl, {
        headers: { Accept: 'application/json' },
      });
      if (res && res.ok) {
        const data = await res.json();
        const items = Array.isArray(data?.results) ? data.results : [];
        for (let i = 0; i < items.length; i += 1) {
          const mapped = mapItunesPodcastItem(items[i], i);
          if (!mapped) continue;
          const key = normalizeFeedUrlKey(mapped.feedUrl);
          if (!key || seenFeeds.has(key)) continue;
          seenFeeds.add(key);
          results.push(mapped);
        }
      }
    } catch {
      // Offline or rate-limited: fall back to curated directory below
    }
  }

  const curatedMatches = filterCuratedPodcasts(searchTerm);
  for (const curated of curatedMatches) {
    const key = normalizeFeedUrlKey(curated.feedUrl);
    if (!key || seenFeeds.has(key)) continue;
    seenFeeds.add(key);
    results.push(curated);
  }

  return results.slice(0, Math.max(limit, 12));
}

function isValidRssOrAtomXml(text = '') {
  if (typeof text !== 'string') return false;
  const sample = text.trim();
  if (sample.length < 24) return false;
  return /<rss[\s>]|<feed[\s>]|<channel[\s>]/i.test(sample);
}

/**
 * Fetch podcast RSS/Atom XML with 3-tier CORS resilience:
 * - Tier 1: Windows Tauri native `fetch_podcast_rss` command
 * - Tier 2: Direct `fetch`
 * - Tier 3: CORS proxy fallbacks (`api.allorigins.win/raw`, `corsproxy.io`)
 *
 * @param {string} feedUrl
 * @param {{ fetchImpl?: typeof fetch, tauriInvoke?: Function }} [options]
 * @returns {Promise<string>}
 */
export async function fetchPodcastFeedXml(feedUrl, options = {}) {
  const trimmedUrl = String(feedUrl || '').trim();
  if (!/^https?:\/\/\S+$/i.test(trimmedUrl)) {
    throw new Error(`Invalid podcast RSS feed URL: ${feedUrl}`);
  }

  const tauriInvoke =
    options.tauriInvoke ||
    (typeof globalThis !== 'undefined' ? globalThis.window?.__TAURI_INTERNALS__?.invoke : undefined);

  // Tier 1: Native Windows Tauri command
  if (typeof tauriInvoke === 'function') {
    try {
      const xml = await tauriInvoke('fetch_podcast_rss', { url: trimmedUrl });
      if (isValidRssOrAtomXml(xml)) {
        return xml;
      }
    } catch {
      // Proceed to Tier 2
    }
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('No fetch implementation available to load podcast feed.');
  }

  const acceptHeaders = {
    Accept: 'application/rss+xml, application/xml, text/xml, */*',
  };

  // Tier 2: Direct fetch
  try {
    const directRes = await fetchImpl(trimmedUrl, { headers: acceptHeaders });
    if (directRes && directRes.ok) {
      const text = await directRes.text();
      if (isValidRssOrAtomXml(text)) {
        return text;
      }
    }
  } catch {
    // Proceed to Tier 3 CORS proxies
  }

  // Tier 3: CORS proxy fallbacks
  const proxyUrls = [
    `https://api.allorigins.win/raw?url=${encodeURIComponent(trimmedUrl)}`,
    `https://corsproxy.io/?${encodeURIComponent(trimmedUrl)}`,
  ];

  for (const proxyUrl of proxyUrls) {
    try {
      const proxyRes = await fetchImpl(proxyUrl, { headers: acceptHeaders });
      if (proxyRes && proxyRes.ok) {
        const text = await proxyRes.text();
        if (isValidRssOrAtomXml(text)) {
          return text;
        }
      }
    } catch {
      // Try next proxy
    }
  }

  throw new Error(`Failed to fetch valid podcast RSS feed from ${trimmedUrl}`);
}

/**
 * Parse iTunes duration (`HH:MM:SS`, `MM:SS`, or seconds) into integer seconds.
 * Defaults to 1800 (30m) when missing, zero, or invalid.
 *
 * @param {string | number} raw
 * @returns {number}
 */
export function parseItunesDuration(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 1800;
  }
  const str = String(raw ?? '').trim();
  if (!str) return 1800;

  if (str.includes(':')) {
    const parts = str.split(':').map((p) => Number(p.trim()));
    if (parts.some((n) => !Number.isFinite(n) || n < 0)) return 1800;
    let seconds = 0;
    if (parts.length === 3) {
      seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      seconds = parts[0] * 60 + parts[1];
    } else {
      return 1800;
    }
    return seconds > 0 ? Math.round(seconds) : 1800;
  }

  const numeric = Number(str);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : 1800;
}

const NAMED_HTML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
  reg: '®',
};

function decodeXmlEntities(input = '') {
  return String(input)
    .replace(/&#(\d+);?/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);?/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&([a-zA-Z0-9#]+);/g, (full, name) => {
      const lower = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_HTML_ENTITIES, lower)
        ? NAMED_HTML_ENTITIES[lower]
        : full;
    });
}

/**
 * Strip `<![CDATA[...]]>`, HTML tags, and decode XML/HTML entities into clean plain text.
 *
 * @param {string} raw
 * @returns {string}
 */
export function stripHtmlToText(raw = '') {
  if (raw === null || raw === undefined) return '';
  let text = String(raw);
  if (!text) return '';

  // Unwrap CDATA sections (supports multiple CDATA blocks)
  text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1');
  text = text.replace(/<!\[CDATA\[|\]\]>/gi, '');

  // Remove script/style/comments completely
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  // Replace block-level closing tags and <br> with space so words don't glue together
  text = text.replace(/<(?:br|hr)\b[^>]*\/?>/gi, ' ');
  text = text.replace(/<\/(?:p|div|li|ul|ol|h[1-6]|blockquote|tr|section|article)>/gi, ' ');

  // Strip all HTML/XML tags
  text = text.replace(/<\/?[a-zA-Z!/?][^>]*>/g, '');

  // Decode entities (twice to handle double-encoded feeds like &amp;amp; or &lt;p&gt;)
  text = decodeXmlEntities(text);
  text = text.replace(/<(?:br|hr)\b[^>]*\/?>/gi, ' ');
  text = text.replace(/<\/?(?:p|div|span|a|ul|ol|li|strong|em|b|i|u|h[1-6]|blockquote|img|table|tr|td|th|section|article)\b[^>]*>/gi, ' ');
  text = decodeXmlEntities(text);

  return text.replace(/\s+/g, ' ').trim();
}

function escapeRegex(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractFirstTagRaw(xmlSlice = '', tagNames = []) {
  for (const tag of tagNames) {
    const escaped = escapeRegex(tag);
    const re = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i');
    const match = xmlSlice.match(re);
    if (match && match[1] !== undefined && String(match[1]).trim() !== '') {
      return match[1];
    }
  }
  return '';
}

function extractTagAttribute(xmlSlice = '', tagName = '', attrName = '') {
  const escapedTag = escapeRegex(tagName);
  const escapedAttr = escapeRegex(attrName);
  const tagRe = new RegExp(`<${escapedTag}\\b([^>]*?)\\/?>`, 'ig');
  const attrRe = new RegExp(`\\b${escapedAttr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  let tagMatch = tagRe.exec(xmlSlice);
  while (tagMatch) {
    const attrs = tagMatch[1] || '';
    const attrMatch = attrs.match(attrRe);
    if (attrMatch) {
      const val = attrMatch[1] ?? attrMatch[2] ?? attrMatch[3] ?? '';
      if (String(val).trim()) return decodeXmlEntities(String(val).trim());
    }
    tagMatch = tagRe.exec(xmlSlice);
  }
  return '';
}

function normalizePublishDate(rawDate = '') {
  const cleaned = stripHtmlToText(rawDate);
  if (!cleaned) return '';
  const parsed = new Date(cleaned);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }
  return cleaned;
}

/**
 * Pure-JS RSS 2.0 / Atom / iTunes XML parser (works identically in browser & Node.js tests).
 * Extracts show metadata and up to 50 episodes with `episodeId`, `title`, `audioUrl`,
 * `durationSec`, `publishedAt`, and sanitized `description`.
 *
 * @param {string} xmlText
 * @param {string} [feedUrl]
 * @returns {{ title: string, author: string, description: string, coverUrl: string, feedUrl: string, episodes: Array<{ episodeId: string, title: string, audioUrl: string, durationSec: number, publishedAt: string, description: string }> }}
 */
export function parsePodcastRssXml(xmlText = '', feedUrl = '') {
  const xml = String(xmlText || '');
  if (!xml.trim()) {
    return {
      title: 'Podcast',
      author: 'Podcast',
      description: '',
      coverUrl: '',
      feedUrl: String(feedUrl || '').trim(),
      episodes: [],
    };
  }

  // Isolate channel/feed header before the first <item> or <entry>
  const firstItemMatch = xml.match(/<(?:item|entry)[\s>]/i);
  const headerXml = firstItemMatch ? xml.slice(0, firstItemMatch.index) : xml;

  // Extract cover artwork from <itunes:image href="..."> or <image><url>...</url></image>
  let coverUrl =
    extractTagAttribute(headerXml, 'itunes:image', 'href') ||
    extractTagAttribute(headerXml, 'media:thumbnail', 'url') ||
    extractTagAttribute(headerXml, 'media:content', 'url');
  if (!coverUrl) {
    const imageBlockMatch = headerXml.match(/<image(?:\s[^>]*)?>([\s\S]*?)<\/image>/i);
    if (imageBlockMatch) {
      coverUrl = stripHtmlToText(extractFirstTagRaw(imageBlockMatch[1], ['url']));
    }
  }
  if (!coverUrl) {
    coverUrl = stripHtmlToText(extractFirstTagRaw(headerXml, ['logo', 'icon']));
  }
  coverUrl = String(coverUrl || '').trim().replace(/^http:\/\//i, 'https://');

  // Remove <image>...</image> from headerXml so <image><title> doesn't shadow channel <title>
  const headerWithoutImage = headerXml.replace(/<image(?:\s[^>]*)?>[\s\S]*?<\/image>/gi, '');

  const title =
    stripHtmlToText(extractFirstTagRaw(headerWithoutImage, ['title', 'itunes:title'])) || 'Podcast';
  let author = stripHtmlToText(
    extractFirstTagRaw(headerWithoutImage, [
      'itunes:author',
      'author',
      'dc:creator',
      'managingEditor',
      'itunes:owner',
    ])
  );
  if (!author) author = 'Podcast';

  const description = stripHtmlToText(
    extractFirstTagRaw(headerWithoutImage, [
      'description',
      'itunes:summary',
      'itunes:subtitle',
      'subtitle',
    ])
  );

  const resolvedFeedUrl =
    String(feedUrl || '').trim() ||
    extractTagAttribute(headerWithoutImage, 'atom:link', 'href') ||
    '';

  // Extract up to 50 <item> or <entry> blocks
  const itemBlocks = [];
  const itemRe = /<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let itemMatch = itemRe.exec(xml);
  while (itemMatch && itemBlocks.length < 60) {
    itemBlocks.push(itemMatch[2]);
    itemMatch = itemRe.exec(xml);
  }

  const episodes = [];
  for (let i = 0; i < itemBlocks.length && episodes.length < 50; i += 1) {
    const block = itemBlocks[i];
    let audioUrl =
      extractTagAttribute(block, 'enclosure', 'url') ||
      extractTagAttribute(block, 'media:content', 'url');

    if (!audioUrl) {
      // Atom <link rel="enclosure" href="...">
      const linkRe = /<link\b([^>]*?)\/?>/gi;
      let linkMatch = linkRe.exec(block);
      while (linkMatch) {
        const attrs = linkMatch[1] || '';
        if (/rel\s*=\s*["']enclosure["']/i.test(attrs) || /type\s*=\s*["']audio\//i.test(attrs)) {
          const hrefMatch = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
          if (hrefMatch) {
            audioUrl = decodeXmlEntities((hrefMatch[1] || hrefMatch[2] || '').trim());
            break;
          }
        }
        linkMatch = linkRe.exec(block);
      }
    }

    if (!audioUrl) continue;

    const epTitle =
      stripHtmlToText(extractFirstTagRaw(block, ['title', 'itunes:title'])) ||
      `Episode ${episodes.length + 1}`;
    const rawGuid = stripHtmlToText(extractFirstTagRaw(block, ['guid', 'id']));
    const episodeId = rawGuid || audioUrl || `${hashFeedUrl(resolvedFeedUrl || title)}-ep-${i}`;
    const rawDuration =
      stripHtmlToText(extractFirstTagRaw(block, ['itunes:duration', 'duration'])) ||
      extractTagAttribute(block, 'media:content', 'duration') ||
      '';
    const durationSec = parseItunesDuration(rawDuration);
    const publishedAt = normalizePublishDate(
      extractFirstTagRaw(block, ['pubDate', 'published', 'updated', 'dc:date'])
    );
    const epDescription = stripHtmlToText(
      extractFirstTagRaw(block, [
        'description',
        'itunes:summary',
        'content:encoded',
        'summary',
        'content',
        'itunes:subtitle',
      ])
    );

    episodes.push({
      episodeId,
      title: epTitle,
      audioUrl,
      durationSec,
      publishedAt,
      description: epDescription,
    });
  }

  return {
    title,
    author,
    description,
    coverUrl,
    feedUrl: resolvedFeedUrl,
    episodes,
  };
}

/**
 * Create or update a normalized Audiobook Player podcast library item (`isPodcast: true`),
 * preserving per-episode progress (`episodeProgress`), offline cached flags, and matching the
 * previously active `episodeId` to its updated `chapterIndex` when new episodes arrive.
 *
 * @param {object} parsedFeed
 * @param {object | null} [existingBook]
 * @returns {object}
 */
export function createPodcastBookItem(parsedFeed = {}, existingBook = null) {
  const feedUrl = String(parsedFeed.feedUrl || existingBook?.feedUrl || '').trim();
  const hash = hashFeedUrl(feedUrl || parsedFeed.title || existingBook?.title || 'podcast');
  const bookKey = existingBook?.bookKey || `podcast:${hash}`;
  const title = stripHtmlToText(parsedFeed.title || existingBook?.title || 'Podcast') || 'Podcast';
  const author = stripHtmlToText(parsedFeed.author || existingBook?.author || 'Podcast') || 'Podcast';
  const description = stripHtmlToText(parsedFeed.description ?? existingBook?.description ?? '');
  const coverUrl =
    String(parsedFeed.coverUrl || existingBook?.coverUrl || '').trim() ||
    buildDefaultPodcastCover(title, 0);

  // Clone and update episodeProgress map
  const episodeProgress = {
    ...(existingBook?.episodeProgress && typeof existingBook.episodeProgress === 'object'
      ? existingBook.episodeProgress
      : {}),
  };

  const prevChapters = Array.isArray(existingBook?.chapters) ? existingBook.chapters : [];
  const prevChapterIndex = Number(existingBook?.chapterIndex) || 0;
  const prevActiveChapter = prevChapters[prevChapterIndex] || null;
  const prevActiveEpisodeId = prevActiveChapter?.episodeId || existingBook?.activeEpisodeId || null;

  if (prevActiveEpisodeId && Number(existingBook?.positionSec) > 0) {
    const existingEntry = episodeProgress[prevActiveEpisodeId] || {};
    const pos = Math.max(Number(existingBook.positionSec) || 0, Number(existingEntry.positionSec) || 0);
    const dur = Number(prevActiveChapter?.durationSec) || Number(existingEntry.durationSec) || 1800;
    episodeProgress[prevActiveEpisodeId] = {
      positionSec: pos,
      durationSec: dur,
      completed: Boolean(existingEntry.completed || (dur > 0 && pos >= dur * 0.95)),
      updatedAt: existingEntry.updatedAt || new Date().toISOString(),
    };
  }

  const prevByEpisodeId = new Map();
  const prevByAudioUrl = new Map();
  for (const ch of prevChapters) {
    if (ch?.episodeId) prevByEpisodeId.set(String(ch.episodeId), ch);
    if (ch?.audioUrl) prevByAudioUrl.set(String(ch.audioUrl), ch);
  }

  const incomingEpisodes =
    Array.isArray(parsedFeed.episodes) && parsedFeed.episodes.length > 0
      ? parsedFeed.episodes
      : prevChapters;

  const chapters = incomingEpisodes.slice(0, 50).map((ep, idx) => {
    const rawEpisodeId = String(ep?.episodeId || ep?.audioUrl || `${bookKey}-ep-${idx}`);
    const prevCh = prevByEpisodeId.get(rawEpisodeId) || (ep?.audioUrl ? prevByAudioUrl.get(String(ep.audioUrl)) : null);
    const audioUrl = String(ep?.audioUrl || ep?.driveStreamUrl || prevCh?.audioUrl || '');
    const durationSec =
      Number(ep?.durationSec) > 0
        ? Math.round(Number(ep.durationSec))
        : Number(prevCh?.durationSec) > 0
          ? Math.round(Number(prevCh.durationSec))
          : 1800;

    return {
      index: idx,
      title: stripHtmlToText(ep?.title || prevCh?.title || `Episode ${idx + 1}`) || `Episode ${idx + 1}`,
      startSec: 0,
      durationSec,
      episodeId: rawEpisodeId,
      audioUrl,
      driveStreamUrl: audioUrl,
      publishedAt: String(ep?.publishedAt ?? prevCh?.publishedAt ?? ''),
      description: stripHtmlToText(ep?.description ?? prevCh?.description ?? ''),
      offlineCached: Boolean(ep?.offlineCached ?? prevCh?.offlineCached ?? false),
    };
  });

  // Match active episodeId so prepended newer episodes shift chapterIndex to the right episode
  let chapterIndex = 0;
  let positionSec = 0;

  if (prevActiveEpisodeId && chapters.length > 0) {
    const matchedIdx = chapters.findIndex((ch) => ch.episodeId === prevActiveEpisodeId);
    if (matchedIdx >= 0) {
      chapterIndex = matchedIdx;
      const savedProg = episodeProgress[prevActiveEpisodeId];
      positionSec =
        Number(existingBook?.positionSec) > 0
          ? Number(existingBook.positionSec)
          : Number(savedProg?.positionSec || 0);
    }
  } else if (chapters.length > 0) {
    const firstEpId = chapters[0].episodeId;
    positionSec = Number(episodeProgress[firstEpId]?.positionSec || 0);
  }

  const totalDurationSec =
    chapters.reduce((sum, ch) => sum + (Number(ch.durationSec) || 1800), 0) || 1800;
  const hasOfflineEpisodes = chapters.some((ch) => Boolean(ch.offlineCached));

  return {
    ...(existingBook || {}),
    bookKey,
    title,
    author,
    narrator: author,
    series: '',
    description,
    coverUrl,
    isPodcast: true,
    mediaType: 'podcast',
    feedUrl,
    lastFeedRefreshAt: new Date().toISOString(),
    sources: ['podcast'],
    source: 'podcast',
    chapterIndex,
    positionSec,
    totalDurationSec,
    episodeProgress,
    hasOfflineEpisodes,
    offlineCached: hasOfflineEpisodes,
    chapters,
  };
}

/**
 * Subscribe to or refresh a podcast from a search result choice object or feed URL string.
 * Automatically resolves Apple Podcasts links and generates a graceful starter episode entry
 * if the feed is unreachable while offline.
 *
 * @param {object | string} choiceOrFeedUrl
 * @param {{ existingBook?: object, fetchImpl?: typeof fetch, tauriInvoke?: Function }} [options]
 * @returns {Promise<object>}
 */
export async function subscribeToPodcastFromChoice(choiceOrFeedUrl, options = {}) {
  const existingBook = options.existingBook || null;
  let choice =
    typeof choiceOrFeedUrl === 'string'
      ? { feedUrl: choiceOrFeedUrl.trim(), title: existingBook?.title || '' }
      : { ...(choiceOrFeedUrl || {}) };

  let feedUrl = String(choice.feedUrl || existingBook?.feedUrl || '').trim();

  // If an Apple Podcasts link was provided instead of a direct RSS feed URL, resolve it first
  if (extractApplePodcastId(feedUrl)) {
    const resolved = await searchPodcasts(feedUrl, options);
    if (resolved.length > 0 && resolved[0].feedUrl) {
      choice = { ...resolved[0], ...choice, feedUrl: resolved[0].feedUrl };
      feedUrl = resolved[0].feedUrl;
    }
  }

  if (!feedUrl) {
    throw new Error('Cannot subscribe to podcast: missing feedUrl.');
  }

  try {
    const xmlText = await fetchPodcastFeedXml(feedUrl, options);
    const parsed = parsePodcastRssXml(xmlText, feedUrl);

    const mergedFeed = {
      title:
        parsed.title && parsed.title !== 'Podcast'
          ? parsed.title
          : choice.title || existingBook?.title || 'Podcast',
      author:
        parsed.author && parsed.author !== 'Podcast'
          ? parsed.author
          : choice.author || existingBook?.author || 'Podcast',
      description: parsed.description || choice.description || existingBook?.description || '',
      coverUrl: parsed.coverUrl || choice.coverUrl || existingBook?.coverUrl || '',
      feedUrl,
      episodes:
        parsed.episodes.length > 0
          ? parsed.episodes
          : existingBook?.chapters?.length
            ? existingBook.chapters
            : [
                {
                  episodeId: `${hashFeedUrl(feedUrl)}-starter`,
                  title: `${choice.title || parsed.title || 'Podcast'} — Latest Episode`,
                  audioUrl: feedUrl,
                  durationSec: 1800,
                  publishedAt: new Date().toISOString(),
                  description: parsed.description || choice.description || '',
                },
              ],
    };

    return createPodcastBookItem(mergedFeed, existingBook);
  } catch {
    // Graceful offline starter fallback so following works even if feed host is unreachable offline
    const fallbackTitle = choice.title || existingBook?.title || 'Podcast';
    const fallbackAuthor = choice.author || existingBook?.author || 'Podcast';
    const fallbackEpisodes =
      existingBook?.chapters?.length > 0
        ? existingBook.chapters
        : [
            {
              episodeId: `${hashFeedUrl(feedUrl)}-offline-starter`,
              title: `${fallbackTitle} — Latest Episode`,
              audioUrl: feedUrl,
              durationSec: 1800,
              publishedAt: new Date().toISOString(),
              description: choice.description || existingBook?.description || '',
            },
          ];

    return createPodcastBookItem(
      {
        title: fallbackTitle,
        author: fallbackAuthor,
        description: choice.description || existingBook?.description || '',
        coverUrl: choice.coverUrl || existingBook?.coverUrl || buildDefaultPodcastCover(fallbackTitle, 0),
        feedUrl,
        episodes: fallbackEpisodes,
      },
      existingBook
    );
  }
}
