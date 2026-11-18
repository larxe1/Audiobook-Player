/**
 * Online cover image search (iTunes Audiobook Artwork, Google Books, Open Library)
 * with curated high-contrast SVG gradient cover fallbacks for offline reliability.
 */

function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function upgradeItunesCover(url = '') {
  if (!url || typeof url !== 'string') return '';
  return url
    .replace(/^http:\/\//i, 'https://')
    .replace(/\/\d+x\d+bb\./i, '/600x600bb.');
}

function upgradeGoogleBooksCover(imageLinks = {}) {
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

const CURATED_THEMES = [
  {
    id: 'curated-midnight-emerald',
    label: 'Midnight Emerald',
    bg1: '#071412',
    bg2: '#0f2f27',
    accent: '#1ed760',
    ring: 'rgba(30,215,96,0.28)',
  },
  {
    id: 'curated-deep-sapphire',
    label: 'Deep Sapphire',
    bg1: '#070b18',
    bg2: '#132145',
    accent: '#60a5fa',
    ring: 'rgba(96,165,250,0.28)',
  },
  {
    id: 'curated-crimson-noir',
    label: 'Crimson Noir',
    bg1: '#14070b',
    bg2: '#35101d',
    accent: '#f43f5e',
    ring: 'rgba(244,63,94,0.28)',
  },
  {
    id: 'curated-amber-obsidian',
    label: 'Amber Obsidian',
    bg1: '#120d06',
    bg2: '#33220c',
    accent: '#f59e0b',
    ring: 'rgba(245,158,11,0.28)',
  },
];

/**
 * Generate a curated high-contrast 600x600 SVG cover data URL.
 * @param {string} title
 * @param {{id: string, label: string, bg1: string, bg2: string, accent: string, ring: string}} theme
 * @returns {string}
 */
export function buildCuratedSvgCover(title, theme) {
  const cleanTitle = (title || 'Audiobook').trim().slice(0, 42);
  const words = cleanTitle.split(/\s+/).filter(Boolean);
  const line1 = words.slice(0, 3).join(' ') || 'Audiobook';
  const line2 = words.slice(3, 6).join(' ');

  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600">',
    '<defs>',
    `<linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">`,
    `<stop offset="0%" stop-color="${theme.bg1}"/>`,
    `<stop offset="100%" stop-color="${theme.bg2}"/>`,
    '</linearGradient>',
    `<radialGradient id="glow" cx="78%" cy="22%" r="60%">`,
    `<stop offset="0%" stop-color="${theme.accent}" stop-opacity="0.32"/>`,
    `<stop offset="100%" stop-color="${theme.bg1}" stop-opacity="0"/>`,
    '</radialGradient>',
    '</defs>',
    '<rect width="600" height="600" fill="url(#g)"/>',
    '<rect width="600" height="600" fill="url(#glow)"/>',
    `<circle cx="480" cy="120" r="145" fill="none" stroke="${theme.ring}" stroke-width="2"/>`,
    `<circle cx="480" cy="120" r="95" fill="none" stroke="${theme.ring}" stroke-width="1.5"/>`,
    `<rect x="48" y="48" width="56" height="6" rx="3" fill="${theme.accent}"/>`,
    `<text x="48" y="395" fill="#f8fafc" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="44" font-weight="800" letter-spacing="-0.8">${escapeXml(line1)}</text>`,
    line2
      ? `<text x="48" y="450" fill="#cbd5e1" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="36" font-weight="700" letter-spacing="-0.5">${escapeXml(line2)}</text>`
      : '',
    `<text x="48" y="540" fill="${theme.accent}" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="18" font-weight="700" letter-spacing="2.4">${escapeXml(theme.label.toUpperCase())}</text>`,
    '</svg>',
  ].join('');

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
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

function cleanCoverQuery(query = '') {
  return String(query || '')
    .replace(/\bUnknown Author\b/gi, '')
    .replace(/\s*[\(\[]\s*(?:19|20)\d{2}\s*[\)\]]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Search online audiobook & book cover artwork from iTunes (600x600),
 * Google Books, and Open Library, always appending curated high-contrast
 * SVG gradient fallback candidates so offline search always succeeds.
 * @param {string} query
 * @param {typeof fetch} [fetchImpl=globalThis.fetch]
 * @returns {Promise<Array<{id: string, url: string, thumbnailUrl: string, title: string, author: string, source: string, width: number, height: number}>>}
 */
export async function searchCoverImages(query, fetchImpl = globalThis.fetch) {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  const searchTerm = cleanCoverQuery(trimmed) || trimmed;
  const candidates = [];

  if (searchTerm && typeof fetchImpl === 'function') {
    const itunesUrl = `https://itunes.apple.com/search?media=audiobook&limit=6&term=${encodeURIComponent(searchTerm)}`;
    const googleBooksUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(searchTerm)}&maxResults=6`;
    const openLibUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(searchTerm)}&limit=6`;

    const [itunesRes, googleRes, openLibRes] = await Promise.allSettled([
      safeFetchJson(itunesUrl, fetchImpl),
      safeFetchJson(googleBooksUrl, fetchImpl),
      safeFetchJson(openLibUrl, fetchImpl),
    ]);

    const itunesData = itunesRes.status === 'fulfilled' ? itunesRes.value : null;
    if (Array.isArray(itunesData?.results)) {
      for (const item of itunesData.results) {
        const hiRes = upgradeItunesCover(item?.artworkUrl100 || '');
        if (!hiRes) continue;
        candidates.push({
          id: `itunes-${item.collectionId || candidates.length}`,
          url: hiRes,
          thumbnailUrl: hiRes,
          title: item.collectionName || trimmed,
          author: item.artistName || '',
          source: 'itunes',
          width: 600,
          height: 600,
        });
      }
    }

    const googleData = googleRes.status === 'fulfilled' ? googleRes.value : null;
    if (Array.isArray(googleData?.items)) {
      for (const vol of googleData.items) {
        const imgUrl = upgradeGoogleBooksCover(vol?.volumeInfo?.imageLinks);
        if (!imgUrl) continue;
        candidates.push({
          id: `gbooks-${vol.id || candidates.length}`,
          url: imgUrl,
          thumbnailUrl: imgUrl,
          title: vol?.volumeInfo?.title || trimmed,
          author: Array.isArray(vol?.volumeInfo?.authors) ? vol.volumeInfo.authors.join(', ') : '',
          source: 'google-books',
          width: 500,
          height: 750,
        });
      }
    }

    const openLibData = openLibRes.status === 'fulfilled' ? openLibRes.value : null;
    if (Array.isArray(openLibData?.docs)) {
      for (const doc of openLibData.docs) {
        if (!doc?.cover_i) continue;
        const largeUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`;
        const medUrl = `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`;
        candidates.push({
          id: `openlib-${doc.cover_i}`,
          url: largeUrl,
          thumbnailUrl: medUrl,
          title: doc.title || trimmed,
          author: Array.isArray(doc.author_name) ? doc.author_name[0] : '',
          source: 'open-library',
          width: 600,
          height: 900,
        });
      }
    }
  }

  // Always include curated high-contrast SVG gradient covers as offline-capable fallbacks
  for (const theme of CURATED_THEMES) {
    const svgUrl = buildCuratedSvgCover(trimmed || 'Audiobook', theme);
    candidates.push({
      id: theme.id,
      url: svgUrl,
      thumbnailUrl: svgUrl,
      title: trimmed || 'Audiobook',
      author: theme.label,
      source: 'curated-svg',
      width: 600,
      height: 600,
    });
  }

  // Deduplicate by URL while preserving priority order
  const seen = new Set();
  return candidates.filter((c) => {
    if (!c.url || seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
}
