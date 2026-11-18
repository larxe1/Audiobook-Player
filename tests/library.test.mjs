import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeBookKey,
  extractGoogleDriveFolderId,
  deduplicateLibraryItems,
  scanLocalFiles,
  scanGoogleDriveFolder,
} from '../src/services/library-scanner.js';
import {
  parseAudioTags,
  parseFilenameMetadata,
  parseSeriesAndOrder,
  cleanSeriesName,
  normalizeBookChapters,
  normalizeBookSeriesAndChapters,
  isDriveThumbnailOrMissingCover,
  isLikelyNonEnglishText,
  isLikelyEnglishText,
  needsAutomatedEnrichment,
  enrichBookMetadata,
} from '../src/services/metadata-enrichment.js';
import { searchCoverImages } from '../src/services/cover-search.js';
import { AudioEngine } from '../src/player/audio-engine.js';
import { SupabaseSyncService } from '../src/services/supabase-sync.js';

function writeSynchsafe(value) {
  return [
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f,
  ];
}

function writeUint32BE(value) {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function buildSyntheticId3v23(frames) {
  const frameChunks = [];
  for (const { id, text, encoding = 3 } of frames) {
    const textBytes = Buffer.from(text, 'utf8');
    const payload = Buffer.concat([Buffer.from([encoding]), textBytes]);
    const header = Buffer.concat([
      Buffer.from(id, 'ascii'),
      Buffer.from(writeUint32BE(payload.length)),
      Buffer.from([0x00, 0x00]),
    ]);
    frameChunks.push(header, payload);
  }
  const body = Buffer.concat(frameChunks);
  const tagHeader = Buffer.from([
    0x49, 0x44, 0x33, // "ID3"
    0x03, 0x00,       // v2.3.0
    0x00,             // flags
    ...writeSynchsafe(body.length),
  ]);
  return new Uint8Array(Buffer.concat([tagHeader, body]));
}

function makeBox(typeBytes, payload) {
  const len = 8 + payload.length;
  return Buffer.concat([
    Buffer.from(writeUint32BE(len)),
    Buffer.from(typeBytes),
    payload,
  ]);
}

function makeIlstTextAtom(typeBytes, value) {
  const textBuf = Buffer.from(value, 'utf8');
  const dataPayload = Buffer.concat([
    Buffer.from(writeUint32BE(1)), // UTF-8
    Buffer.from([0, 0, 0, 0]),
    textBuf,
  ]);
  const dataBox = makeBox(Buffer.from('data', 'ascii'), dataPayload);
  return makeBox(typeBytes, dataBox);
}

function buildSyntheticMp4({ title, author, narrator, series, chapters = [] }) {
  const ilstChildren = [];
  if (title) ilstChildren.push(makeIlstTextAtom([0xa9, 0x6e, 0x61, 0x6d], title));
  if (author) ilstChildren.push(makeIlstTextAtom([0xa9, 0x41, 0x52, 0x54], author));
  if (narrator) ilstChildren.push(makeIlstTextAtom([0xa9, 0x77, 0x72, 0x74], narrator));
  if (series) ilstChildren.push(makeIlstTextAtom([0xa9, 0x61, 0x6c, 0x62], series));

  const ilstBox = makeBox(Buffer.from('ilst', 'ascii'), Buffer.concat(ilstChildren));
  const metaPayload = Buffer.concat([Buffer.from([0, 0, 0, 0]), ilstBox]);
  const metaBox = makeBox(Buffer.from('meta', 'ascii'), metaPayload);

  const udtaChildren = [metaBox];

  if (chapters.length > 0) {
    const chplParts = [
      Buffer.from([0x01, 0x00, 0x00, 0x00]), // version 1 + flags
      Buffer.from([0x00, 0x00, 0x00, 0x00]), // reserved
      Buffer.from([chapters.length]),
    ];
    for (const ch of chapters) {
      const ts100ns = BigInt(Math.round(ch.startSec * 1e7));
      const tsBuf = Buffer.alloc(8);
      tsBuf.writeBigUInt64BE(ts100ns, 0);
      const nameBuf = Buffer.from(ch.title, 'utf8');
      chplParts.push(tsBuf, Buffer.from([nameBuf.length]), nameBuf);
    }
    udtaChildren.push(makeBox(Buffer.from('chpl', 'ascii'), Buffer.concat(chplParts)));
  }

  const udtaBox = makeBox(Buffer.from('udta', 'ascii'), Buffer.concat(udtaChildren));
  const moovBox = makeBox(Buffer.from('moov', 'ascii'), udtaBox);
  const ftypBox = makeBox(Buffer.from('ftyp', 'ascii'), Buffer.from('M4B \x00\x00\x00\x00M4B mp42', 'ascii'));

  return new Uint8Array(Buffer.concat([ftypBox, moovBox]));
}

test('normalizeBookKey strips casing, punctuation, accents, and file extensions', () => {
  assert.equal(
    normalizeBookKey('Project Hail Mary.m4b', 'Andy Weir'),
    'project-hail-mary::andy-weir',
  );
  assert.equal(
    normalizeBookKey('  PROJECT, HAIL MARY! ', 'Andy  Weir.'),
    'project-hail-mary::andy-weir',
  );
  assert.equal(
    normalizeBookKey('Café Society.mp3', 'José Saramago'),
    'cafe-society::jose-saramago',
  );
  assert.equal(normalizeBookKey('The Fellowship of the Ring', 'J.R.R. Tolkien'), 'the-fellowship-of-the-ring::j-r-r-tolkien');
  assert.equal(normalizeBookKey('Dune.flac', ''), 'dune');
});

test('deduplicateLibraryItems merges Local and Google Drive entries and prefers local playback', () => {
  const driveBook = {
    id: 'drv-1',
    title: 'Project Hail Mary.m4b',
    author: 'Andy Weir',
    source: 'drive',
    driveFileId: 'drive_file_123',
    driveStreamUrl: 'https://www.googleapis.com/drive/v3/files/drive_file_123?alt=media',
    isOffline: false,
    positionSec: 1240,
    chapterIndex: 2,
    totalDurationSec: 57900,
    chapters: [
      { index: 0, title: 'Chapter 1', startSec: 0 },
      { index: 1, title: 'Chapter 2', startSec: 600 },
      { index: 2, title: 'Chapter 3', startSec: 1200 },
    ],
    bookmarks: [{ id: 'bm-1', positionSec: 450, label: 'Airlock wake up' }],
    coverUrl: 'https://example.com/phm.jpg',
  };

  const localBook = {
    id: 'loc-1',
    title: 'project hail mary!',
    author: 'andy weir',
    sources: ['local'],
    localUrl: 'blob:http://localhost/local-phm-uuid',
    isOffline: true,
    positionSec: 3420,
    chapterIndex: 5,
    bookmarks: [
      { id: 'bm-1', positionSec: 450, label: 'Airlock wake up' },
      { id: 'bm-2', positionSec: 3100, label: 'Rocky first contact' },
    ],
  };

  const driveOnlyBook = {
    id: 'drv-2',
    title: 'Dune',
    author: 'Frank Herbert',
    sources: ['drive'],
    driveFileId: 'drive_dune_456',
    positionSec: 120,
  };

  const merged = deduplicateLibraryItems([driveBook, localBook, driveOnlyBook]);
  assert.equal(merged.length, 2);

  const phm = merged.find((b) => b.bookKey === 'project-hail-mary::andy-weir');
  assert.ok(phm);
  assert.deepEqual(phm.sources, ['drive', 'local']);
  assert.equal(phm.preferredPlaybackSource, 'local');
  assert.equal(phm.localUrl, 'blob:http://localhost/local-phm-uuid');
  assert.equal(phm.driveFileId, 'drive_file_123');
  assert.equal(phm.isOffline, true);
  assert.equal(phm.positionSec, 3420);
  assert.equal(phm.chapterIndex, 5);
  assert.equal(phm.totalDurationSec, 57900);
  assert.equal(phm.chapters.length, 3);
  assert.equal(phm.bookmarks.length, 2);
  assert.equal(phm.coverUrl, 'https://example.com/phm.jpg');

  const dune = merged.find((b) => b.bookKey === 'dune::frank-herbert');
  assert.ok(dune);
  assert.deepEqual(dune.sources, ['drive']);
  assert.equal(dune.preferredPlaybackSource, 'drive');
});

test('parseAudioTags extracts ID3v2 frames cleanly', () => {
  const id3 = buildSyntheticId3v23([
    { id: 'TIT2', text: 'Project Hail Mary' },
    { id: 'TPE1', text: 'Andy Weir' },
    { id: 'TALB', text: 'Standalone Sci-Fi' },
    { id: 'TCOM', text: 'Ray Porter' },
  ]);

  const tags = parseAudioTags(id3, 'unknown_file.mp3');
  assert.equal(tags.source, 'id3v2');
  assert.equal(tags.title, 'Project Hail Mary');
  assert.equal(tags.author, 'Andy Weir');
  assert.equal(tags.series, 'Standalone Sci-Fi');
  assert.equal(tags.narrator, 'Ray Porter');
});

test('parseAudioTags extracts MP4/M4B atoms and chpl chapters', () => {
  const m4b = buildSyntheticMp4({
    title: 'The Fellowship of the Ring',
    author: 'J.R.R. Tolkien',
    narrator: 'Andy Serkis',
    series: 'The Lord of the Rings',
    chapters: [
      { title: 'A Long-expected Party', startSec: 0 },
      { title: 'The Shadow of the Past', startSec: 1850 },
    ],
  });

  const tags = parseAudioTags(m4b, 'lotr1.m4b');
  assert.equal(tags.source, 'mp4');
  assert.equal(tags.title, 'The Fellowship of the Ring');
  assert.equal(tags.author, 'J.R.R. Tolkien');
  assert.equal(tags.narrator, 'Andy Serkis');
  assert.equal(tags.series, 'The Lord of the Rings');
  assert.equal(tags.chapters.length, 2);
  assert.equal(tags.chapters[1].title, 'The Shadow of the Past');
  assert.equal(tags.chapters[1].startSec, 1850);
});

test('parseAudioTags falls back to filename and never throws on empty or corrupt buffers', () => {
  const fallback = parseAudioTags(new Uint8Array(0), 'Andy Weir - Project Hail Mary.m4b');
  assert.equal(fallback.source, 'filename');
  assert.equal(fallback.title, 'Project Hail Mary');
  assert.equal(fallback.author, 'Andy Weir');

  // Truncated ID3 header claiming huge size
  const truncatedId3 = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x7f, 0x7f, 0x7f, 0x7f, 0x54, 0x49]);
  const res1 = parseAudioTags(truncatedId3, 'Frank Herbert - Dune.mp3');
  assert.equal(res1.title, 'Dune');
  assert.equal(res1.author, 'Frank Herbert');

  // Random malformed bytes & invalid types
  const corrupt = new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x6d, 0x6f, 0x6f, 0x76, 0x00, 0x00, 0x00, 0x02]);
  const res2 = parseAudioTags(corrupt, 'The Martian by Andy Weir.m4b');
  assert.equal(res2.title, 'The Martian');
  assert.equal(res2.author, 'Andy Weir');

  const res3 = parseAudioTags(null, '');
  assert.equal(res3.title, '');
  assert.equal(res3.author, '');
});

test('enrichBookMetadata merges iTunes, Audnexus, and Open Library metadata', async () => {
  const mockFetch = async (url) => {
    if (url.includes('itunes.apple.com')) {
      return {
        ok: true,
        json: async () => ({
          results: [
            {
              collectionName: 'Project Hail Mary',
              artistName: 'Andy Weir',
              artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music/100x100bb.jpg',
              description: '<p>A lone astronaut must save Earth.</p>',
              trackTimeMillis: 57900000,
              releaseDate: '2021-05-04T07:00:00Z',
            },
          ],
        }),
      };
    }
    if (url.includes('api.audnex.us')) {
      return {
        ok: true,
        json: async () => ({
          authors: [{ name: 'Andy Weir' }],
          narrators: [{ name: 'Ray Porter' }],
          runtimeLengthMin: 970,
          summary: 'Ryland Grace wakes up millions of miles from home.',
        }),
      };
    }
    if (url.includes('openlibrary.org')) {
      return {
        ok: true,
        json: async () => ({
          docs: [{ title: 'Project Hail Mary', author_name: ['Andy Weir'], cover_i: 1234567, first_publish_year: 2021 }],
        }),
      };
    }
    return { ok: false };
  };

  const enriched = await enrichBookMetadata({ title: 'Project Hail Mary' }, mockFetch);
  assert.equal(enriched.author, 'Andy Weir');
  assert.equal(enriched.narrator, 'Ray Porter');
  assert.equal(enriched.totalDurationSec, 970 * 60);
  assert.equal(enriched.coverUrl, 'https://is1-ssl.mzstatic.com/image/thumb/Music/600x600bb.jpg');
  assert.match(enriched.description, /Ryland Grace/);
});

test('scanLocalFiles and scanGoogleDriveFolder parse and deduplicate books', async () => {
  const id3 = buildSyntheticId3v23([
    { id: 'TIT2', text: 'Project Hail Mary' },
    { id: 'TPE1', text: 'Andy Weir' },
  ]);

  const localBooks = await scanLocalFiles([
    {
      name: 'Andy Weir - Project Hail Mary.mp3',
      size: 1024,
      localUrl: 'blob:local/phm',
      slice: () => ({ arrayBuffer: async () => id3.buffer }),
    },
  ]);

  assert.equal(localBooks.length, 1);
  assert.equal(localBooks[0].bookKey, 'project-hail-mary::andy-weir');
  assert.deepEqual(localBooks[0].sources, ['local']);
  assert.equal(localBooks[0].localUrl, 'blob:local/phm');

  const driveMockFetch = async (url, init) => {
    assert.match(url, /https:\/\/www\.googleapis\.com\/drive\/v3\/files/);
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    return {
      ok: true,
      json: async () => ({
        files: [
          {
            id: 'drv-phm-99',
            name: 'Andy Weir - Project Hail Mary.m4b',
            mimeType: 'audio/mp4',
            size: '500000000',
          },
        ],
      }),
    };
  };

  const driveBooks = await scanGoogleDriveFolder('test-token', 'folder-1', driveMockFetch);
  assert.equal(driveBooks.length, 1);
  assert.equal(driveBooks[0].driveFileId, 'drv-phm-99');
  assert.equal(driveBooks[0].driveStreamUrl, 'https://www.googleapis.com/drive/v3/files/drv-phm-99?alt=media');

  const combined = deduplicateLibraryItems([...driveBooks, ...localBooks]);
  assert.equal(combined.length, 1);
  assert.deepEqual(combined[0].sources, ['drive', 'local']);
  assert.equal(combined[0].preferredPlaybackSource, 'local');
  assert.equal(combined[0].localUrl, 'blob:local/phm');
  assert.equal(combined[0].driveFileId, 'drv-phm-99');
});

test('searchCoverImages upgrades iTunes artwork to 600x600 and includes offline SVG fallbacks', async () => {
  const mockFetch = async (url) => {
    if (url.includes('itunes.apple.com')) {
      return {
        ok: true,
        json: async () => ({
          results: [
            {
              collectionId: 101,
              collectionName: 'Project Hail Mary',
              artistName: 'Andy Weir',
              artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/100x100bb.jpg',
            },
          ],
        }),
      };
    }
    if (url.includes('googleapis.com/books')) {
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              id: 'gb-1',
              volumeInfo: {
                title: 'Project Hail Mary',
                authors: ['Andy Weir'],
                imageLinks: { thumbnail: 'http://books.google.com/books/content?id=123' },
              },
            },
          ],
        }),
      };
    }
    if (url.includes('openlibrary.org')) {
      return {
        ok: true,
        json: async () => ({
          docs: [{ title: 'Project Hail Mary', author_name: ['Andy Weir'], cover_i: 998877 }],
        }),
      };
    }
    return { ok: false };
  };

  const onlineResults = await searchCoverImages('Project Hail Mary', mockFetch);
  assert.ok(onlineResults.some((c) => c.source === 'itunes' && c.url.includes('600x600bb')));
  assert.ok(onlineResults.some((c) => c.source === 'google-books' && c.url.startsWith('https://')));
  assert.ok(onlineResults.some((c) => c.source === 'open-library' && c.url.includes('998877-L.jpg')));
  assert.ok(onlineResults.some((c) => c.source === 'curated-svg' && c.url.startsWith('data:image/svg+xml')));

  // Offline / failing fetch fallback still yields curated SVG candidates
  const offlineResults = await searchCoverImages('Project Hail Mary', async () => {
    throw new Error('Network offline');
  });
  assert.ok(offlineResults.length >= 4);
  assert.ok(offlineResults.every((c) => c.source === 'curated-svg' && c.url.startsWith('data:image/svg+xml')));
});

test('extractGoogleDriveFolderId parses full Drive URLs and raw IDs', () => {
  assert.equal(
    extractGoogleDriveFolderId('https://drive.google.com/drive/u/0/folders/1WO4laKR_L_RhfK6OFypmMFV9GwxZpyuD'),
    '1WO4laKR_L_RhfK6OFypmMFV9GwxZpyuD',
  );
  assert.equal(
    extractGoogleDriveFolderId('https://drive.google.com/drive/folders/1WO4laKR_L_RhfK6OFypmMFV9GwxZpyuD?usp=sharing'),
    '1WO4laKR_L_RhfK6OFypmMFV9GwxZpyuD',
  );
  assert.equal(
    extractGoogleDriveFolderId('https://drive.google.com/open?id=1WO4laKR_L_RhfK6OFypmMFV9GwxZpyuD'),
    '1WO4laKR_L_RhfK6OFypmMFV9GwxZpyuD',
  );
  assert.equal(
    extractGoogleDriveFolderId('1WO4laKR_L_RhfK6OFypmMFV9GwxZpyuD'),
    '1WO4laKR_L_RhfK6OFypmMFV9GwxZpyuD',
  );
});

test('scanGoogleDriveFolder recursively scans subfolders and groups multi-track audiobook folders', async () => {
  const driveTree = {
    '1WO4laKR_L_RhfK6OFypmMFV9GwxZpyuD': [
      { id: 'sub-phm', name: 'Andy Weir - Project Hail Mary', mimeType: 'application/vnd.google-apps.folder' },
      { id: 'sub-red', name: 'Pierce Brown - Red Rising', mimeType: 'application/vnd.google-apps.folder' },
      { id: 'sub-series', name: 'First Law World', mimeType: 'application/vnd.google-apps.folder' },
    ],
    'sub-phm': [
      { id: 'file-phm', name: 'Project Hail Mary.m4b', mimeType: 'audio/mp4', size: '512000000' },
      { id: 'img-phm', name: 'cover.jpg', mimeType: 'image/jpeg', thumbnailLink: 'https://lh3.googleusercontent.com/phm-thumb' },
    ],
    'sub-red': [
      { id: 'rr-1', name: '01 - Part One.mp3', mimeType: 'audio/mpeg', size: '12000000' },
      { id: 'rr-2', name: '02 - Part Two.mp3', mimeType: 'audio/mpeg', size: '14000000' },
    ],
    'sub-series': [
      { id: 'fl-1', name: 'Joe Abercrombie - The Blade Itself.m4b', mimeType: 'audio/mp4', size: '400000000' },
      { id: 'fl-2', name: 'Joe Abercrombie - Before They Are Hanged.m4b', mimeType: 'audio/mp4', size: '420000000' },
    ],
  };

  const mockFetch = async (url) => {
    const u = new URL(url);
    const q = u.searchParams.get('q') || '';
    const match = q.match(/'([^']+)'\s+in\s+parents/);
    const parentId = match ? match[1] : '';
    return {
      ok: true,
      json: async () => ({ files: driveTree[parentId] || [] }),
    };
  };

  const books = await scanGoogleDriveFolder(
    'test-token',
    'https://drive.google.com/drive/u/0/folders/1WO4laKR_L_RhfK6OFypmMFV9GwxZpyuD',
    mockFetch,
  );

  assert.equal(books.length, 4);

  const phm = books.find((b) => b.bookKey === 'project-hail-mary::andy-weir');
  assert.ok(phm);
  assert.equal(phm.driveFileId, 'file-phm');
  assert.equal(phm.coverUrl, 'https://lh3.googleusercontent.com/phm-thumb');

  const redRising = books.find((b) => b.bookKey === 'red-rising::pierce-brown');
  assert.ok(redRising);
  assert.equal(redRising.chapters.length, 2);
  assert.equal(redRising.chapters[0].driveFileId, 'rr-1');
  assert.equal(redRising.chapters[1].driveFileId, 'rr-2');

  const blade = books.find((b) => b.bookKey === 'the-blade-itself::joe-abercrombie');
  assert.ok(blade);
  assert.equal(blade.series, 'First Law World');
});

test('scanLocalFiles scans nested subfolders, isolates identical Disc folders, attaches sibling covers, and emits progress', async () => {
  const prevCreateObjectURL = globalThis.URL?.createObjectURL;
  let objCounter = 0;
  if (globalThis.URL) {
    globalThis.URL.createObjectURL = (blob) => `blob:test-${++objCounter}-${blob?.name || 'item'}`;
  }

  const makeMockFile = (name, webkitRelativePath, type = 'audio/mpeg') => {
    const blob = new Blob([new Uint8Array(128)], { type });
    Object.defineProperties(blob, {
      name: { value: name, configurable: true },
      webkitRelativePath: { value: webkitRelativePath, configurable: true },
    });
    return blob;
  };

  const progressUpdates = [];
  try {
    const books = await scanLocalFiles(
      [
        makeMockFile('01 Intro.mp3', 'audiobooks/Red Rising/01 Intro.mp3'),
        makeMockFile('02 Chapter Two.mp3', 'audiobooks/Red Rising/02 Chapter Two.mp3'),
        makeMockFile('cover.jpg', 'audiobooks/Red Rising/cover.jpg', 'image/jpeg'),
        makeMockFile('The Blade Itself.m4b', 'audiobooks/First Law World/The Blade Itself.m4b', 'audio/mp4'),
        makeMockFile('Before They Are Hanged.m4b', 'audiobooks/First Law World/Before They Are Hanged.m4b', 'audio/mp4'),
        makeMockFile('01 Opening.mp3', 'audiobooks/Book Alpha/Disc 1/01 Opening.mp3'),
        makeMockFile('01 Opening.mp3', 'audiobooks/Book Beta/Disc 1/01 Opening.mp3'),
      ],
      {
        onProgress: (info) => progressUpdates.push(info),
      },
    );

    assert.equal(books.length, 5);
    assert.ok(progressUpdates.length >= 2);
    assert.equal(progressUpdates[progressUpdates.length - 1].percent, 100);

    const redRising = books.find((b) => b.title === 'Red Rising');
    assert.ok(redRising);
    assert.equal(redRising.chapters.length, 2);
    assert.ok(redRising.coverUrl && redRising.coverUrl.startsWith('blob:test-'));

    const blade = books.find((b) => b.title.includes('The Blade Itself'));
    assert.ok(blade);
    assert.equal(blade.series, 'First Law World');

    const discBooks = books.filter((b) => /Disc 1/i.test(b.title));
    assert.equal(discBooks.length, 2);
    assert.notEqual(discBooks[0].bookKey, discBooks[1].bookKey);
  } finally {
    if (globalThis.URL) {
      globalThis.URL.createObjectURL = prevCreateObjectURL;
    }
  }
});

test('scanGoogleDriveFolder emits progress, supports AbortSignal cancellation, and formats 401/403 API errors', async () => {
  const driveTree = {
    rootFolder: [
      { id: 'f-book1', name: 'Project Hail Mary', mimeType: 'application/vnd.google-apps.folder' },
    ],
    'f-book1': [
      { id: 'track-1', name: 'Hail Mary.m4b', mimeType: 'audio/mp4', size: '12345' },
    ],
  };

  const progressEvents = [];
  const okFetch = async (url) => {
    const u = new URL(url);
    const q = u.searchParams.get('q') || '';
    const match = q.match(/'([^']+)'\s+in\s+parents/);
    const parentId = match ? match[1] : '';
    return {
      ok: true,
      json: async () => ({ files: driveTree[parentId] || [] }),
    };
  };

  const books = await scanGoogleDriveFolder('token', 'rootFolder', okFetch, {
    onProgress: (p) => progressEvents.push(p),
  });
  assert.equal(books.length, 1);
  assert.ok(progressEvents.length >= 2);
  assert.equal(progressEvents[progressEvents.length - 1].percent, 100);

  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => scanGoogleDriveFolder('token', 'rootFolder', okFetch, { signal: ac.signal }),
    /cancelled|abort/i,
  );

  const errFetch401 = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: { message: 'Invalid Credentials' } }),
  });
  await assert.rejects(
    () => scanGoogleDriveFolder('token', 'rootFolder', errFetch401),
    (err) => err?.status === 401 && /expired/i.test(err.message),
  );

  const errFetch403 = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: { message: 'Insufficient Permission' } }),
  });
  await assert.rejects(
    () => scanGoogleDriveFolder('token', 'rootFolder', errFetch403),
    (err) => err?.status === 403 && /access denied|403/i.test(err.message),
  );
});

test('parseSeriesAndOrder, parseFilenameMetadata, and normalizeBookSeriesAndChapters normalize franchises and polluted authors', () => {
  const fnExpanse = parseFilenameMetadata('The Expanse 0.1 - Drive (2013).m4b');
  assert.equal(fnExpanse.series, 'The Expanse');
  assert.equal(fnExpanse.seriesOrder, 0.1);
  assert.equal(fnExpanse.title, 'Drive (2013)');
  assert.equal(fnExpanse.author, 'James S. A. Corey');

  const pollutedExpanse = normalizeBookSeriesAndChapters({
    title: 'The Churn (2014)',
    author: 'The Expanse 0.2',
    chapters: [{ index: 0, title: 'Chapter 1', startSec: 0 }],
  });
  assert.equal(pollutedExpanse.series, 'The Expanse');
  assert.equal(pollutedExpanse.seriesOrder, 0.2);
  assert.equal(pollutedExpanse.author, 'James S. A. Corey');

  const pollutedGeneric = normalizeBookSeriesAndChapters({
    title: 'Starfall',
    author: 'Galactic Saga 1.5',
    chapters: [],
  });
  assert.equal(pollutedGeneric.series, 'Galactic Saga');
  assert.equal(pollutedGeneric.seriesOrder, 1.5);
  assert.equal(pollutedGeneric.author, 'Unknown Author');

  const sandman1 = parseSeriesAndOrder('The Sandman', 'Neil Gaiman');
  const sandman2 = parseSeriesAndOrder('The Sandman: Act II', 'Neil Gaiman');
  const sandman3 = parseSeriesAndOrder('The Sandman Act III', '');
  assert.equal(sandman1.series, 'The Sandman');
  assert.equal(sandman1.seriesOrder, 1);
  assert.equal(sandman2.series, 'The Sandman');
  assert.equal(sandman2.seriesOrder, 2);
  assert.equal(sandman3.series, 'The Sandman');
  assert.equal(sandman3.seriesOrder, 3);
  assert.equal(sandman3.inferredAuthor, 'Neil Gaiman');

  const hp1 = parseSeriesAndOrder("Harry Potter and the Philosopher's Stone");
  const hp4 = parseSeriesAndOrder('Harry Potter Book 4');
  assert.equal(hp1.series, 'Harry Potter');
  assert.equal(hp1.seriesOrder, 1);
  assert.equal(hp4.series, 'Harry Potter');
  assert.equal(hp4.seriesOrder, 4);
});

test('normalizeBookChapters fixes repeated Lincoln in the Bardo titles, builds cumulative timestamps, and extracts hierarchy', () => {
  const lincolnChapters = normalizeBookChapters(
    [
      { index: 0, title: 'Lincoln in the Bardo', fileName: '01 - Lincoln in the Bardo.mp3', startSec: 0, durationSec: 1200 },
      { index: 1, title: 'Lincoln in the Bardo', fileName: '02 - Lincoln in the Bardo.mp3', startSec: 0, durationSec: 1500 },
      { index: 2, title: 'Lincoln in the Bardo', fileName: '03 - Lincoln in the Bardo.mp3', startSec: 0, durationSec: 900 },
    ],
    'Lincoln in the Bardo',
  );
  assert.deepEqual(
    lincolnChapters.map((c) => c.title),
    ['Part 1', 'Part 2', 'Part 3'],
  );
  assert.deepEqual(
    lincolnChapters.map((c) => c.startSec),
    [0, 1200, 2700],
  );

  const hierarchical = normalizeBookChapters(
    [
      { index: 0, title: 'Act I - Chapter 1: Arrival', startSec: 0 },
      { index: 1, title: 'Act I - Chapter 2: Departure', startSec: 600 },
      { index: 2, title: '1.1 Epilogue', startSec: 1200 },
    ],
    'Some Book',
  );
  assert.equal(hierarchical[0].sectionTitle, 'Act I');
  assert.equal(hierarchical[0].title, 'Chapter 1: Arrival');
  assert.equal(hierarchical[0].level, 1);
  assert.equal(hierarchical[0].durationSec, 600);
  assert.equal(hierarchical[2].level, 1);
});

test('isDriveThumbnailOrMissingCover, needsAutomatedEnrichment, and Drive single-file series + videoMediaMetadata', async () => {
  assert.equal(isDriveThumbnailOrMissingCover(''), true);
  assert.equal(isDriveThumbnailOrMissingCover('https://lh3.googleusercontent.com/abc'), true);
  assert.equal(isDriveThumbnailOrMissingCover('https://drive.google.com/thumbnail?id=123'), true);
  assert.equal(isDriveThumbnailOrMissingCover('https://docs.google.com/uc?id=123'), true);
  assert.equal(isDriveThumbnailOrMissingCover('https://is1-ssl.mzstatic.com/image/600x600bb.jpg'), false);

  assert.equal(needsAutomatedEnrichment({ title: 'Test', author: 'Unknown Author', coverUrl: 'https://x.com/a.jpg' }), true);
  assert.equal(
    needsAutomatedEnrichment({
      title: 'Test',
      author: 'Author',
      coverUrl: 'https://x.com/a.jpg',
      seriesOrder: 1,
      chapters: [{ index: 0, title: 'Opening', startSec: 0 }],
      enrichmentCheckedAt: '2026-01-01T00:00:00Z',
    }),
    false,
  );

  const driveTree = {
    root: [
      { id: 'series-fl', name: 'First Law World', mimeType: 'application/vnd.google-apps.folder' },
    ],
    'series-fl': [
      { id: 'book-blade', name: 'The Blade Itself', mimeType: 'application/vnd.google-apps.folder' },
    ],
    'book-blade': [
      {
        id: 'file-blade',
        name: 'Joe Abercrombie - The Blade Itself.m4b',
        mimeType: 'audio/mp4',
        size: '450000000',
        thumbnailLink: 'https://lh3.googleusercontent.com/black-audio-box',
        videoMediaMetadata: { durationMillis: '3600000' },
      },
    ],
  };

  const mockFetch = async (url) => {
    const u = new URL(url);
    assert.match(u.searchParams.get('fields') || '', /videoMediaMetadata/);
    const q = u.searchParams.get('q') || '';
    const match = q.match(/'([^']+)'\s+in\s+parents/);
    const parentId = match ? match[1] : '';
    return {
      ok: true,
      json: async () => ({ files: driveTree[parentId] || [] }),
    };
  };

  const books = await scanGoogleDriveFolder('token', 'root', mockFetch);
  assert.equal(books.length, 1);
  assert.equal(books[0].series, 'First Law World');
  assert.equal(books[0].coverUrl, ''); // Must NOT use audio file's thumbnailLink
  assert.equal(books[0].totalDurationSec, 3600);
});

test('enrichBookMetadata cleans queries, pulls Audnexus seriesOrder + chapters, Google Books fallback, and replaces Drive thumbnails', async () => {
  const seenUrls = [];
  const mockFetch = async (url) => {
    seenUrls.push(url);
    if (url.includes('itunes.apple.com')) {
      return { ok: true, json: async () => ({ results: [] }) };
    }
    if (url.includes('api.audnex.us/books/B00DRIVE123/chapters')) {
      return {
        ok: true,
        json: async () => ({
          runtimeLengthSec: 1800,
          chapters: [
            { title: 'Part I - Launch', startOffsetSec: 0, lengthMs: 900000 },
            { title: 'Part I - Burn', startOffsetSec: 900, lengthMs: 900000 },
          ],
        }),
      };
    }
    if (url.includes('api.audnex.us/books')) {
      return {
        ok: true,
        json: async () => [
          {
            asin: 'B00DRIVE123',
            title: 'Drive',
            authors: [{ name: 'James S. A. Corey' }],
            narrators: [{ name: 'Jefferson Mays' }],
            seriesPrimary: { name: 'The Expanse', position: '0.1' },
            runtimeLengthMin: 30,
          },
        ],
      };
    }
    if (url.includes('googleapis.com/books')) {
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              volumeInfo: {
                title: 'Drive',
                authors: ['James S. A. Corey'],
                imageLinks: { thumbnail: 'http://books.google.com/books/content?id=expanse1&edge=curl' },
              },
            },
          ],
        }),
      };
    }
    return { ok: false };
  };

  const enriched = await enrichBookMetadata(
    {
      title: 'Drive (2013)',
      author: 'The Expanse 0.1',
      coverUrl: 'https://lh3.googleusercontent.com/broken-thumb',
      chapters: [{ index: 0, title: 'Chapter 1', startSec: 0 }],
    },
    mockFetch,
  );

  assert.equal(enriched.author, 'James S. A. Corey');
  assert.equal(enriched.series, 'The Expanse');
  assert.equal(enriched.seriesOrder, 0.1);
  assert.equal(enriched.narrator, 'Jefferson Mays');
  assert.equal(enriched.coverUrl, 'https://books.google.com/books/content?id=expanse1');
  assert.equal(enriched.chapters.length, 2);
  assert.equal(enriched.chapters[0].sectionTitle, 'Part I');
  assert.equal(enriched.chapters[0].title, 'Launch');
  assert.equal(enriched.chapters[0].level, 1);
  assert.ok(enriched.enrichmentCheckedAt);
  assert.ok(!seenUrls.some((u) => u.includes('2013') && u.includes('api.audnex.us/books?')));
});

test('parseAudioTags parses ID3v2 CHAP frames and MP4 chpl chapter durationSec', () => {
  // Build synthetic ID3v2.3 with CHAP frame containing embedded TIT2
  const tit2Text = Buffer.concat([Buffer.from([3]), Buffer.from('Opening Scene', 'utf8')]);
  const tit2Frame = Buffer.concat([
    Buffer.from('TIT2', 'ascii'),
    Buffer.from(writeUint32BE(tit2Text.length)),
    Buffer.from([0, 0]),
    tit2Text,
  ]);
  const chapPayload = Buffer.concat([
    Buffer.from('chp1\0', 'latin1'),
    Buffer.from(writeUint32BE(0)),
    Buffer.from(writeUint32BE(45000)),
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    tit2Frame,
  ]);
  const chapFrame = Buffer.concat([
    Buffer.from('CHAP', 'ascii'),
    Buffer.from(writeUint32BE(chapPayload.length)),
    Buffer.from([0, 0]),
    chapPayload,
  ]);
  const id3Header = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, ...writeSynchsafe(chapFrame.length)]);
  const tags = parseAudioTags(new Uint8Array(Buffer.concat([id3Header, chapFrame])), 'book.mp3');
  assert.equal(tags.chapters.length, 1);
  assert.equal(tags.chapters[0].title, 'Opening Scene');
  assert.equal(tags.chapters[0].startSec, 0);
  assert.equal(tags.chapters[0].durationSec, 45);

  // MP4 chpl durationSec
  const m4b = buildSyntheticMp4({
    title: 'Test',
    chapters: [
      { title: 'Ch 1', startSec: 0 },
      { title: 'Ch 2', startSec: 100 },
    ],
  });
  const mp4Tags = parseAudioTags(m4b, 'test.m4b');
  assert.equal(mp4Tags.chapters[0].durationSec, 100);
});

test('AudioEngine computeChapterIndex and chapter sleep timer work reliably for multi-file books', () => {
  const engine = new AudioEngine();
  const multiBook = {
    bookKey: 'lincoln::saunders',
    totalDurationSec: 3600,
    chapters: [
      { index: 0, title: 'Part 1', startSec: 0, durationSec: 600, driveFileId: 'f1', driveStreamUrl: 'https://d/1' },
      { index: 1, title: 'Part 2', startSec: 0, durationSec: 900, driveFileId: 'f2', driveStreamUrl: 'https://d/2' },
    ],
  };
  engine.currentBook = multiBook;
  engine.chapterIndex = 1;
  engine.positionSec = 120;
  assert.equal(engine.computeChapterIndex(120, multiBook.chapters), 1);

  // Cycle sleep presets: [0, 15, 30, 45, 'chapter']
  for (let i = 0; i < 4; i += 1) engine.cycleSleepTimer();
  assert.equal(engine.sleepTimerMode, 'chapter');
  assert.equal(engine.sleepRemainingSec, 780);
  engine.destroy();
});

test('SupabaseSyncService deleteLibraryItems deletes keys and syncLibraryItems/fetchLibraryItems preserve seriesOrder', async () => {
  const requests = [];
  const mockFetch = async (url, init = {}) => {
    requests.push({ url, method: init.method || 'GET', body: init.body });
    if ((init.method || 'GET') === 'GET') {
      return {
        ok: true,
        text: async () =>
          JSON.stringify([
            {
              book_key: 'drive-2013::james-s-a-corey',
              title: 'Drive (2013)',
              author: 'James S. A. Corey',
              narrator: 'Jefferson Mays',
              series: 'The Expanse',
              cover_url: 'https://example.com/drive.jpg',
              total_duration_sec: 1800,
              sources: ['drive'],
              drive_file_id: 'drv-1',
              metadata_json: {
                description: 'Epstein drive',
                chapters: [],
                seriesOrder: 0.1,
              },
            },
          ]),
      };
    }
    return { ok: true, text: async () => '' };
  };

  const client = new SupabaseSyncService({ fetchImpl: mockFetch });
  client.setSession({ access_token: 'tok', user: { id: 'user-123' } });

  await client.syncLibraryItems([
    {
      bookKey: 'drive-2013::james-s-a-corey',
      title: 'Drive (2013)',
      author: 'James S. A. Corey',
      series: 'The Expanse',
      seriesOrder: 0.1,
      sources: ['drive'],
    },
  ]);

  const postReq = requests.find((r) => r.method === 'POST');
  assert.ok(postReq);
  const postedRows = JSON.parse(postReq.body);
  assert.equal(postedRows[0].metadata_json.seriesOrder, 0.1);

  const fetched = await client.fetchLibraryItems();
  assert.equal(fetched[0].seriesOrder, 0.1);

  const delRes = await client.deleteLibraryItems(['drive-2013::james-s-a-corey', 'book-2::author']);
  assert.equal(delRes.ok, true);
  assert.equal(delRes.deleted, 2);
  const delReq = requests.find((r) => r.method === 'DELETE');
  assert.ok(delReq);
  assert.match(delReq.url, /audiobook_library_items\?user_id=eq\.user-123&book_key=in\./);
  client.destroy();
});

test('isLikelyNonEnglishText detects Spanish, Italian, French, German, Portuguese, and non-Latin scripts without false-flagging English prose', () => {
  // Positive cases: Romance & Germanic languages
  assert.equal(
    isLikelyNonEnglishText(
      'En esta apasionante novela, el protagonista viaja por el universo para salvar la Tierra antes de que sea demasiado tarde.',
    ),
    true,
  );
  assert.equal(
    isLikelyNonEnglishText(
      'Un romanzo straordinario che racconta la storia di un uomo solo nello spazio, tra misteri e scoperte per il futuro.',
    ),
    true,
  );
  assert.equal(
    isLikelyNonEnglishText(
      'Dans ce roman captivant, le héros traverse les étoiles avec une équipe qui lutte pour sa survie dans un monde hostile.',
    ),
    true,
  );
  assert.equal(
    isLikelyNonEnglishText(
      'Ein fesselnder Roman über einen Astronauten, der allein im All aufwacht und mit Mut und Verstand um sein Überleben kämpft.',
    ),
    true,
  );
  assert.equal(
    isLikelyNonEnglishText(
      'Um livro envolvente sobre um astronauta que acorda sozinho no espaço e precisa lutar para salvar a humanidade com ajuda de um amigo.',
    ),
    true,
  );

  // Positive cases: Non-Latin scripts (even when short)
  assert.equal(isLikelyNonEnglishText('三体'), true);
  assert.equal(isLikelyNonEnglishText('Дюна'), true);
  assert.equal(isLikelyNonEnglishText('العربية'), true);
  assert.equal(isLikelyNonEnglishText('한국어'), true);

  // Negative cases: Empty, short, and English prose with foreign names or loanwords
  assert.equal(isLikelyNonEnglishText(''), false);
  assert.equal(isLikelyNonEnglishText('Dune'), false);
  assert.equal(isLikelyNonEnglishText('El Camino'), false);
  assert.equal(isLikelyNonEnglishText('Las Vegas Nights'), false);
  assert.equal(
    isLikelyNonEnglishText(
      'In 1984, José Arcadio Buendía and his family build the town of Macondo in a story about life, love, and solitude.',
    ),
    false,
  );
  assert.equal(
    isLikelyNonEnglishText(
      'Set in a Paris café, Clara and her fiancé uncover a secret from before the war while Jean-Luc watches from the street.',
    ),
    false,
  );
  assert.equal(
    isLikelyNonEnglishText(
      'The story follows Don Quixote de la Mancha and his loyal squire Sancho Panza across the countryside.',
    ),
    false,
  );
  assert.equal(
    isLikelyNonEnglishText(
      'Do as you wish, no regrets, for life is short and this world rewards the bold.',
    ),
    false,
  );

  assert.equal(isLikelyEnglishText('A gripping story about survival on Mars.'), true);
  assert.equal(isLikelyEnglishText(''), false);
});

test('enrichBookMetadata requests English params, rejects Spanish/Italian hits, and upgrades cached non-English descriptions', async () => {
  const seenUrls = [];
  const spanishSummary =
    'Un astronauta despierta solo en una nave espacial sin recordar su misión y debe salvar la Tierra.';
  const italianSummary =
    'Un astronauta si risveglia solo nello spazio senza ricordare la sua missione e deve salvare la Terra.';
  const englishSummary =
    'Ryland Grace is the sole survivor on a desperate, last-chance mission to save humanity and Earth.';

  const mockFetch = async (url) => {
    seenUrls.push(url);
    if (url.includes('itunes.apple.com')) {
      return {
        ok: true,
        json: async () => ({
          results: [
            {
              collectionName: 'Proyecto Hail Mary (Edición en Español)',
              artistName: 'Andy Weir',
              description: spanishSummary,
            },
            {
              collectionName: 'Project Hail Mary',
              artistName: 'Andy Weir',
              description: `<p>${englishSummary}</p>`,
              artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/100x100bb.jpg',
            },
          ],
        }),
      };
    }
    if (url.includes('api.audnex.us/books?')) {
      return {
        ok: true,
        json: async () => [
          {
            asin: 'B0SPANISH1',
            title: 'Project Hail Mary',
            language: 'spanish',
            authors: [{ name: 'Andy Weir' }],
            narrators: [{ name: 'Narrador Español' }],
            seriesPrimary: { name: 'La Serie Espacial', position: '1' },
            summary: spanishSummary,
          },
          {
            asin: 'B0ENGLISH1',
            title: 'Project Hail Mary',
            language: 'english',
            authors: [{ name: 'Andy Weir' }],
            narrators: [{ name: 'Ray Porter' }],
            runtimeLengthMin: 970,
            summary: englishSummary,
          },
        ],
      };
    }
    if (url.includes('googleapis.com/books')) {
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              volumeInfo: {
                title: 'Project Hail Mary',
                language: 'it',
                authors: ['Andy Weir'],
                description: italianSummary,
              },
            },
            {
              volumeInfo: {
                title: 'Project Hail Mary',
                language: 'en',
                authors: ['Andy Weir'],
                description: englishSummary,
              },
            },
          ],
        }),
      };
    }
    if (url.includes('openlibrary.org')) {
      return {
        ok: true,
        json: async () => ({
          docs: [
            { title: 'Project Hail Mary', language: ['ita'], cover_i: 111111, first_sentence: [italianSummary] },
            { title: 'Project Hail Mary', language: ['eng'], cover_i: 222222, first_sentence: ['I woke up alone.'] },
          ],
        }),
      };
    }
    return { ok: false };
  };

  // Book with previously-cached Spanish description and old enrichmentCheckedAt
  const staleBook = {
    title: 'Project Hail Mary',
    author: 'Andy Weir',
    description: spanishSummary,
    coverUrl: 'https://is1-ssl.mzstatic.com/image/thumb/600x600bb.jpg',
    seriesOrder: 1,
    chapters: [{ index: 0, title: 'Chapter 1: Wake Up', startSec: 0 }],
    enrichmentCheckedAt: '2025-12-01T00:00:00Z',
  };

  assert.equal(needsAutomatedEnrichment(staleBook), true);

  const enriched = await enrichBookMetadata(staleBook, mockFetch);

  // Verify English query params on outbound requests
  assert.ok(seenUrls.some((u) => u.includes('itunes.apple.com') && u.includes('country=US') && u.includes('lang=en_us')));
  assert.ok(seenUrls.some((u) => u.includes('api.audnex.us/books?') && u.includes('region=us')));
  assert.ok(seenUrls.some((u) => u.includes('googleapis.com/books') && u.includes('langRestrict=en')));

  // Verify English hit won over Spanish/Italian hits
  assert.equal(enriched.asin, 'B0ENGLISH1');
  assert.equal(enriched.narrator, 'Ray Porter');
  assert.equal(enriched.description, englishSummary);
  assert.equal(enriched.series, '');
  assert.equal(enriched.enrichmentVersion, 2);

  // Once upgraded to enrichmentVersion 2, needsAutomatedEnrichment returns false
  assert.equal(needsAutomatedEnrichment(enriched), false);
  assert.equal(
    needsAutomatedEnrichment({
      ...staleBook,
      enrichmentVersion: 2,
    }),
    false,
  );
});

test('enrichBookMetadata never falls back to Spanish/Italian description when no English description exists', async () => {
  const onlyNonEnglishFetch = async (url) => {
    if (url.includes('itunes.apple.com')) {
      return {
        ok: true,
        json: async () => ({
          results: [
            {
              collectionName: 'Dune',
              artistName: 'Frank Herbert',
              description:
                'En el planeta desértico Arrakis, la historia sigue al joven Paul Atreides y su familia en una lucha por la supervivencia.',
            },
          ],
        }),
      };
    }
    if (url.includes('api.audnex.us/books?')) {
      return {
        ok: true,
        json: async () => [
          {
            asin: 'B0ONLYES',
            title: 'Dune',
            language: 'spanish',
            summary: 'La novela clásica de ciencia ficción en español sobre el planeta Arrakis.',
          },
        ],
      };
    }
    return { ok: false };
  };

  const enrichedNoDesc = await enrichBookMetadata({ title: 'Dune', author: 'Frank Herbert' }, onlyNonEnglishFetch);
  assert.equal(enrichedNoDesc.description, '');
  assert.equal(enrichedNoDesc.asin, undefined);
  assert.equal(enrichedNoDesc.enrichmentVersion, 2);
});

test('cleanSeriesName, parseSeriesAndOrder, and normalizeBookSeriesAndChapters unify split Expanse, Abercrombie, Sandman, and Harry Potter cached entries', async () => {
  // cleanSeriesName rules
  assert.equal(cleanSeriesName('James S. A. Corey - The Expanse Complete 2.0 - Jefferson Mays (1)', 'James S. A. Corey'), 'The Expanse');
  assert.equal(cleanSeriesName('James S. A. Corey - The Expanse Complete 2.0 - Jefferson Mays'), 'The Expanse');
  assert.equal(cleanSeriesName('01 - The First Law (1)'), 'The First Law');
  assert.equal(cleanSeriesName('02 - The Age of Madness (1)'), 'The Age of Madness');
  assert.equal(cleanSeriesName('Neil Gaiman Dirk Maggs - The Sandman'), 'The Sandman');
  assert.equal(cleanSeriesName('Audio'), '');
  assert.equal(cleanSeriesName('Audiobooks'), '');

  // Filename metadata with novella prefix, curly apostrophes, and Roman numeral X
  const driveNovella = parseFilenameMetadata('The Expanse 0.1 - An Expanse Novella - Drive (2013).m4b');
  assert.equal(driveNovella.title, 'Drive (2013)');
  assert.equal(driveNovella.series, 'The Expanse');
  assert.equal(driveNovella.seriesOrder, 0.1);
  assert.equal(driveNovella.author, 'James S. A. Corey');

  const expanseX = parseFilenameMetadata('The Expanse X - Complete Novella Collection (2022).m4b');
  assert.equal(expanseX.title, 'Complete Novella Collection (2022)');
  assert.equal(expanseX.series, 'The Expanse');
  assert.equal(expanseX.seriesOrder, 10);
  assert.equal(expanseX.author, 'James S. A. Corey');

  // Cached broken entries heal in-place
  const healedNovella = normalizeBookSeriesAndChapters({
    title: 'An Expanse Novella - Drive (2013)',
    author: 'James S. A. Corey',
    series: 'James S. A. Corey - The Expanse Complete 2.0 - Jefferson Mays',
  });
  assert.equal(healedNovella.title, 'Drive (2013)');
  assert.equal(healedNovella.series, 'The Expanse');
  assert.equal(healedNovella.seriesOrder, 0.1);

  const healedCaliban = normalizeBookSeriesAndChapters({
    title: 'Caliban’s War (2013)',
    author: 'James S. A. Corey',
    series: 'James S. A. Corey - The Expanse Complete 2.0 - Jefferson Mays (1)',
  });
  assert.equal(healedCaliban.series, 'The Expanse');
  assert.equal(healedCaliban.seriesOrder, 2);

  const healedAbaddon = normalizeBookSeriesAndChapters({
    title: 'Abaddon’s Gate (2013)',
    author: 'James S. A. Corey',
    series: 'James S. A. Corey - The Expanse Complete 2.0 - Jefferson Mays',
  });
  assert.equal(healedAbaddon.series, 'The Expanse');
  assert.equal(healedAbaddon.seriesOrder, 3);

  const healedExpanseX = normalizeBookSeriesAndChapters({
    title: 'Complete Novella Collection (2022)',
    author: 'The Expanse X',
    series: 'James S. A. Corey - The Expanse Complete 2.0 - Jefferson Mays (1)',
    seriesOrder: 2,
  });
  assert.equal(healedExpanseX.author, 'James S. A. Corey');
  assert.equal(healedExpanseX.series, 'The Expanse');
  assert.equal(healedExpanseX.seriesOrder, 10);

  const healedWisdom = normalizeBookSeriesAndChapters({
    title: 'The Wisdom of Crowds (1)',
    author: 'Joe Abercrombie',
    series: '02 - The Age of Madness (1)',
  });
  assert.equal(healedWisdom.title, 'The Wisdom of Crowds');
  assert.equal(healedWisdom.series, 'The Age of Madness');
  assert.equal(healedWisdom.seriesOrder, 3);

  const healedFirstLaw = normalizeBookSeriesAndChapters({
    title: 'The Blade Itself',
    author: 'Joe Abercrombie',
    series: '01 - The First Law (1)',
  });
  assert.equal(healedFirstLaw.series, 'The First Law');
  assert.equal(healedFirstLaw.seriesOrder, 1);

  const healedHp4 = normalizeBookSeriesAndChapters({
    title: 'J.K. Rowling (2000) Harry Potter and the Goblet of Fire (Various Artists)',
    author: 'Unknown Author',
    series: 'Audio',
  });
  assert.equal(healedHp4.series, 'Harry Potter');
  assert.equal(healedHp4.seriesOrder, 4);
  assert.equal(healedHp4.author, 'J.K. Rowling');

  const healedSandman = normalizeBookSeriesAndChapters({
    title: 'The Sandman',
    author: 'Neil Gaiman',
    series: 'Neil Gaiman Dirk Maggs - The Sandman',
  });
  assert.equal(healedSandman.series, 'The Sandman');
  assert.equal(healedSandman.seriesOrder, 1);

  const standaloneInAudio = normalizeBookSeriesAndChapters({
    title: 'Standalone Novel',
    author: 'Some Author',
    series: 'Audio',
  });
  assert.equal(standaloneInAudio.series, '');

  // Drive scanner ignores generic folder names and unifies Expanse folder variants
  const driveTree = {
    root: [
      { id: 'exp-dir', name: 'James S. A. Corey - The Expanse Complete 2.0 - Jefferson Mays (1)', mimeType: 'application/vnd.google-apps.folder' },
      { id: 'audio-dir', name: 'Audio', mimeType: 'application/vnd.google-apps.folder' },
    ],
    'exp-dir': [
      { id: 'e-01', name: 'The Expanse 0.1 - An Expanse Novella - Drive (2013).m4b', mimeType: 'audio/mp4', size: '1000' },
      { id: 'e-02', name: 'The Expanse 02 - Caliban’s War (2013).m4b', mimeType: 'audio/mp4', size: '1000' },
      { id: 'e-10', name: 'The Expanse X - Complete Novella Collection (2022).m4b', mimeType: 'audio/mp4', size: '1000' },
    ],
    'audio-dir': [
      { id: 'hp-4', name: 'J.K. Rowling (2000) Harry Potter and the Goblet of Fire (Various Artists).m4b', mimeType: 'audio/mp4', size: '1000' },
      { id: 'standalone', name: 'Jane Doe - Standalone Book.m4b', mimeType: 'audio/mp4', size: '1000' },
    ],
  };

  const mockDriveFetch = async (url) => {
    const u = new URL(url);
    const q = u.searchParams.get('q') || '';
    const match = q.match(/'([^']+)'\s+in\s+parents/);
    const parentId = match ? match[1] : '';
    return {
      ok: true,
      json: async () => ({ files: driveTree[parentId] || [] }),
    };
  };

  const driveBooks = await scanGoogleDriveFolder('token', 'root', mockDriveFetch);
  const expanseBooks = driveBooks.filter((b) => b.series === 'The Expanse');
  assert.equal(expanseBooks.length, 3);
  assert.ok(expanseBooks.every((b) => b.author === 'James S. A. Corey'));
  assert.equal(expanseBooks.find((b) => b.seriesOrder === 0.1)?.title, 'Drive (2013)');
  assert.equal(expanseBooks.find((b) => b.seriesOrder === 2)?.title, 'Caliban’s War (2013)');
  assert.equal(expanseBooks.find((b) => b.seriesOrder === 10)?.title, 'Complete Novella Collection (2022)');

  const hpBook = driveBooks.find((b) => b.title.includes('Goblet of Fire'));
  assert.equal(hpBook?.series, 'Harry Potter');
  assert.equal(hpBook?.seriesOrder, 4);

  const standaloneBook = driveBooks.find((b) => b.title === 'Standalone Book');
  assert.equal(standaloneBook?.series, '');
});
