import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeBookKey,
  deduplicateLibraryItems,
  scanLocalFiles,
  scanGoogleDriveFolder,
} from '../src/services/library-scanner.js';
import {
  parseAudioTags,
  enrichBookMetadata,
} from '../src/services/metadata-enrichment.js';
import { searchCoverImages } from '../src/services/cover-search.js';

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
