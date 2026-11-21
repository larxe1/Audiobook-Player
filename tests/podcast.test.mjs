import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  PODCAST_CATEGORIES,
  CURATED_PODCAST_DIRECTORY,
  hashFeedUrl,
  searchPodcasts,
  fetchPodcastFeedXml,
  parseItunesDuration,
  stripHtmlToText,
  parsePodcastRssXml,
  createPodcastBookItem,
  subscribeToPodcastFromChoice,
} from '../src/services/podcast-service.js';
import { AudioEngine } from '../src/player/audio-engine.js';
import { SupabaseSyncService } from '../src/services/supabase-sync.js';
import { deduplicateBooks } from '../src/services/library-scanner.js';

const SAMPLE_RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <image>
      <url>http://example.com/fallback-image.jpg</url>
      <title>Ignored Image Title</title>
    </image>
    <title><![CDATA[Tech &amp; Future Frontiers]]></title>
    <itunes:author><![CDATA[Dr. Ada &amp; Alan]]></itunes:author>
    <description><![CDATA[<p>Weekly deep dives into <strong>AI</strong> &amp; computing &lt;systems&gt;.</p>]]></description>
    <itunes:image href="http://cdn.example.com/artwork-600.jpg" />
    <item>
      <title><![CDATA[<p>Ep 2: Neural Engines &amp; Agents</p>]]></title>
      <guid isPermaLink="false">ep-guid-002</guid>
      <pubDate>Wed, 20 Nov 2026 12:00:00 GMT</pubDate>
      <itunes:duration>01:05:30</itunes:duration>
      <description><![CDATA[<p>Episode &amp; Notes with <a href="https://example.com">links</a> and &#39;quotes&#39; &mdash; enjoy!</p>]]></description>
      <enclosure url="https://cdn.example.com/audio/ep002.mp3" length="48000000" type="audio/mpeg" />
    </item>
    <item>
      <title><![CDATA[Ep 1: Genesis &amp; Origins]]></title>
      <guid>ep-guid-001</guid>
      <pubDate>Wed, 13 Nov 2026 12:00:00 GMT</pubDate>
      <itunes:duration>42:15</itunes:duration>
      <description><![CDATA[<div>First episode &quot;intro&quot; &nbsp; notes.</div>]]></description>
      <enclosure url="https://cdn.example.com/audio/ep001.mp3" type="audio/mpeg" />
    </item>
  </channel>
</rss>`;

test('PODCAST_CATEGORIES and CURATED_PODCAST_DIRECTORY have required categories and 12+ live feeds', () => {
  const expectedIds = [
    'trending',
    'tech',
    'news',
    'history',
    'science',
    'true-crime',
    'comedy',
    'business',
  ];
  assert.equal(PODCAST_CATEGORIES.length, expectedIds.length);
  for (const id of expectedIds) {
    const cat = PODCAST_CATEGORIES.find((c) => c.id === id);
    assert.ok(cat, `Missing category ${id}`);
    assert.ok(cat.label && cat.query);
  }

  assert.ok(Array.isArray(CURATED_PODCAST_DIRECTORY));
  assert.ok(CURATED_PODCAST_DIRECTORY.length >= 12);
  for (const item of CURATED_PODCAST_DIRECTORY) {
    assert.ok(item.id);
    assert.ok(item.title);
    assert.ok(item.author);
    assert.match(item.feedUrl, /^https?:\/\//);
    assert.ok(item.coverUrl);
    assert.ok(item.genre);
  }
});

test('hashFeedUrl returns deterministic lowercase alphanumeric hash/slug', () => {
  const h1 = hashFeedUrl('https://feeds.simplecast.com/54nAGcIl');
  const h2 = hashFeedUrl('HTTPS://feeds.simplecast.com/54nAGcIl/');
  const h3 = hashFeedUrl('https://lexfridman.com/feed/podcast/');

  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.match(h1, /^[a-z0-9]+$/);
  assert.match(h3, /^[a-z0-9]+$/);
});

test('Review Focus 1: stripHtmlToText strips CDATA, HTML tags, and decodes XML/HTML entities', () => {
  assert.equal(
    stripHtmlToText('<![CDATA[<p>Episode &amp; Notes</p>]]>'),
    'Episode & Notes'
  );
  assert.equal(
    stripHtmlToText('<![CDATA[<div>Hello <b>World</b> &quot;2026&quot; &#39;Test&#39; &#x26; More</div>]]>'),
    'Hello World "2026" \'Test\' & More'
  );
  assert.equal(
    stripHtmlToText('&lt;p&gt;Double encoded &amp;amp; clean&lt;/p&gt;'),
    'Double encoded & clean'
  );
  assert.equal(stripHtmlToText(null), '');
});

test('parseItunesDuration parses HH:MM:SS, MM:SS, and raw seconds with 1800 default', () => {
  assert.equal(parseItunesDuration('01:05:30'), 3930);
  assert.equal(parseItunesDuration('42:15'), 2535);
  assert.equal(parseItunesDuration('2400'), 2400);
  assert.equal(parseItunesDuration(1540), 1540);
  assert.equal(parseItunesDuration('00:00'), 1800);
  assert.equal(parseItunesDuration(0), 1800);
  assert.equal(parseItunesDuration(''), 1800);
  assert.equal(parseItunesDuration('invalid'), 1800);
});

test('parsePodcastRssXml extracts show metadata and sanitized episodes in pure JS', () => {
  const parsed = parsePodcastRssXml(SAMPLE_RSS_XML, 'https://example.com/feed.xml');

  assert.equal(parsed.title, 'Tech & Future Frontiers');
  assert.equal(parsed.author, 'Dr. Ada & Alan');
  assert.equal(parsed.description, 'Weekly deep dives into AI & computing <systems>.');
  assert.equal(parsed.coverUrl, 'https://cdn.example.com/artwork-600.jpg');
  assert.equal(parsed.feedUrl, 'https://example.com/feed.xml');
  assert.equal(parsed.episodes.length, 2);

  const ep0 = parsed.episodes[0];
  assert.equal(ep0.episodeId, 'ep-guid-002');
  assert.equal(ep0.title, 'Ep 2: Neural Engines & Agents');
  assert.equal(ep0.audioUrl, 'https://cdn.example.com/audio/ep002.mp3');
  assert.equal(ep0.durationSec, 3930);
  assert.equal(ep0.description, "Episode & Notes with links and 'quotes' — enjoy!");
  assert.match(ep0.publishedAt, /^2026-11-20T12:00:00/);

  const ep1 = parsed.episodes[1];
  assert.equal(ep1.episodeId, 'ep-guid-001');
  assert.equal(ep1.title, 'Ep 1: Genesis & Origins');
  assert.equal(ep1.durationSec, 2535);
  assert.equal(ep1.description, 'First episode "intro" notes.');
});

test('Review Focus 3: createPodcastBookItem preserves episodeProgress and shifts chapterIndex when new episodes prepend', () => {
  const initialFeed = parsePodcastRssXml(SAMPLE_RSS_XML, 'https://example.com/feed.xml');
  const bookV1 = createPodcastBookItem(initialFeed);

  assert.equal(bookV1.bookKey, `podcast:${hashFeedUrl('https://example.com/feed.xml')}`);
  assert.equal(bookV1.isPodcast, true);
  assert.equal(bookV1.mediaType, 'podcast');
  assert.equal(bookV1.series, '');
  assert.deepEqual(bookV1.sources, ['podcast']);
  assert.equal(bookV1.source, 'podcast');
  assert.equal(bookV1.chapters.length, 2);
  assert.equal(bookV1.chapters[0].driveStreamUrl, bookV1.chapters[0].audioUrl);

  // Simulate user listening to Ep 2 (at chapterIndex 0) at 1234s and having completed Ep 1
  bookV1.chapterIndex = 0;
  bookV1.positionSec = 1234;
  bookV1.chapters[0].offlineCached = true;
  bookV1.episodeProgress = {
    'ep-guid-002': { positionSec: 1234, durationSec: 3930, completed: false, updatedAt: '2026-11-20T13:00:00.000Z' },
    'ep-guid-001': { positionSec: 2535, durationSec: 2535, completed: true, updatedAt: '2026-11-19T10:00:00.000Z' },
  };

  // Now a newer Episode 3 is prepended at index 0 on feed refresh
  const refreshedFeed = {
    ...initialFeed,
    episodes: [
      {
        episodeId: 'ep-guid-003',
        title: 'Ep 3: Quantum Leap',
        audioUrl: 'https://cdn.example.com/audio/ep003.mp3',
        durationSec: 1800,
        publishedAt: '2026-11-21T12:00:00.000Z',
        description: 'Brand new episode',
      },
      ...initialFeed.episodes,
    ],
  };

  const bookV2 = createPodcastBookItem(refreshedFeed, bookV1);

  assert.equal(bookV2.chapters.length, 3);
  assert.equal(bookV2.chapters[0].episodeId, 'ep-guid-003');
  assert.equal(bookV2.chapters[1].episodeId, 'ep-guid-002');
  // Active chapterIndex must shift from 0 -> 1 to stay on ep-guid-002!
  assert.equal(bookV2.chapterIndex, 1);
  assert.equal(bookV2.positionSec, 1234);
  assert.equal(bookV2.chapters[1].offlineCached, true);
  assert.equal(bookV2.hasOfflineEpisodes, true);
  assert.equal(bookV2.episodeProgress['ep-guid-002'].positionSec, 1234);
  assert.equal(bookV2.episodeProgress['ep-guid-001'].completed, true);
});

test('Review Focus 5: searchPodcasts handles direct RSS URLs, Apple Podcasts id links, iTunes search, and offline curated fallback', async () => {
  // 1. Direct RSS URL pasted into search box
  const directResults = await searchPodcasts('https://example.com/custom-podcast.xml');
  assert.equal(directResults.length, 1);
  assert.equal(directResults[0].isDirectFeed, true);
  assert.equal(directResults[0].feedUrl, 'https://example.com/custom-podcast.xml');

  // 2. Apple Podcasts link containing /id123456789
  let lookedUpUrl = '';
  const appleResults = await searchPodcasts(
    'https://podcasts.apple.com/us/podcast/sample-show/id1200361736',
    {
      fetchImpl: async (url) => {
        lookedUpUrl = url;
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                collectionId: 1200361736,
                collectionName: 'Resolved Apple Show',
                artistName: 'Apple Host',
                feedUrl: 'https://feeds.example.com/resolved.xml',
                artworkUrl600: 'http://cdn.example.com/art600.jpg',
                primaryGenreName: 'Technology',
                trackCount: 95,
              },
            ],
          }),
        };
      },
    }
  );
  assert.match(lookedUpUrl, /itunes\.apple\.com\/lookup\?id=1200361736/);
  assert.equal(appleResults[0].title, 'Resolved Apple Show');
  assert.equal(appleResults[0].feedUrl, 'https://feeds.example.com/resolved.xml');
  assert.equal(appleResults[0].coverUrl, 'https://cdn.example.com/art600.jpg');

  // 3. Normal search merges iTunes results + curated directory deduplicated by feedUrl
  const searchResults = await searchPodcasts('technology ai podcast', {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        results: [
          {
            collectionId: 999,
            collectionName: 'AI Weekly Live',
            artistName: 'Synth Host',
            feedUrl: 'https://feeds.example.com/ai-weekly.xml',
            artworkUrl600: 'https://cdn.example.com/ai.jpg',
            primaryGenreName: 'Technology',
            trackCount: 42,
          },
        ],
      }),
    }),
  });
  assert.ok(searchResults.length > 1);
  assert.equal(searchResults[0].title, 'AI Weekly Live');
  assert.ok(searchResults.some((item) => item.title === 'Hard Fork' || item.title === 'Lex Fridman Podcast'));

  // 4. Offline fallback when fetch throws
  const offlineResults = await searchPodcasts('history', {
    fetchImpl: async () => {
      throw new Error('Network unreachable');
    },
  });
  assert.ok(offlineResults.length >= 2);
  assert.ok(offlineResults.every((item) => /^https?:\/\//.test(item.feedUrl)));
});

test('fetchPodcastFeedXml tries Tauri invoke first, then direct fetch, then CORS proxies', async () => {
  // Tier 1: Tauri invoke succeeds
  let tauriCalled = false;
  const xmlFromTauri = await fetchPodcastFeedXml('https://example.com/rss.xml', {
    tauriInvoke: async (cmd, args) => {
      tauriCalled = cmd === 'fetch_podcast_rss' && args.url === 'https://example.com/rss.xml';
      return SAMPLE_RSS_XML;
    },
    fetchImpl: async () => {
      throw new Error('Should not call fetch when Tauri succeeds');
    },
  });
  assert.ok(tauriCalled);
  assert.equal(xmlFromTauri, SAMPLE_RSS_XML);

  // Tier 3: Direct fetch fails with CORS error, CORS proxy succeeds
  const attemptedUrls = [];
  const xmlFromProxy = await fetchPodcastFeedXml('https://blocked-host.example.com/feed.xml', {
    tauriInvoke: async () => {
      throw new Error('Tauri not available');
    },
    fetchImpl: async (url) => {
      attemptedUrls.push(url);
      if (url === 'https://blocked-host.example.com/feed.xml') {
        throw new TypeError('Failed to fetch (CORS)');
      }
      if (url.startsWith('https://api.allorigins.win/raw?url=')) {
        return {
          ok: true,
          text: async () => SAMPLE_RSS_XML,
        };
      }
      throw new Error('Unexpected URL');
    },
  });
  assert.equal(attemptedUrls.length, 2);
  assert.equal(xmlFromProxy, SAMPLE_RSS_XML);
});

test('subscribeToPodcastFromChoice builds normalized podcast item and falls back gracefully offline', async () => {
  const onlineItem = await subscribeToPodcastFromChoice(
    {
      title: 'Tech & Future Frontiers',
      author: 'Dr. Ada & Alan',
      feedUrl: 'https://example.com/feed.xml',
    },
    {
      fetchImpl: async () => ({
        ok: true,
        text: async () => SAMPLE_RSS_XML,
      }),
    }
  );
  assert.equal(onlineItem.isPodcast, true);
  assert.equal(onlineItem.chapters.length, 2);
  assert.equal(onlineItem.chapters[0].episodeId, 'ep-guid-002');

  // Offline fallback starter episode
  const offlineItem = await subscribeToPodcastFromChoice(
    {
      title: 'Offline Curated Show',
      author: 'Offline Host',
      feedUrl: 'https://offline.example.com/feed.xml',
    },
    {
      fetchImpl: async () => {
        throw new Error('Offline');
      },
    }
  );
  assert.equal(offlineItem.isPodcast, true);
  assert.equal(offlineItem.title, 'Offline Curated Show');
  assert.equal(offlineItem.chapters.length, 1);
  assert.equal(offlineItem.chapters[0].audioUrl, 'https://offline.example.com/feed.xml');
});

test('Windows Tauri main.rs registers fetch_podcast_rss command', () => {
  const mainRsPath = path.resolve('src-tauri/src/main.rs');
  const mainRs = fs.readFileSync(mainRsPath, 'utf8');
  assert.match(mainRs, /fn\s+fetch_podcast_rss\s*\(\s*url:\s*String\s*\)\s*->\s*Result<String,\s*String>/);
  assert.match(mainRs, /generate_handler!\[[\s\S]*?fetch_podcast_rss[\s\S]*?\]/);
});

test('Review Focus 2 & 4: AudioEngine handles single/multi-episode duration, per-episode progress, and CORS-resilient cacheEpisodeOffline', async () => {
  const parsed = parsePodcastRssXml(SAMPLE_RSS_XML, 'https://example.com/feed.xml');
  const podcastBook = createPodcastBookItem(parsed);

  const engine = new AudioEngine({
    fetchImpl: async (url) => {
      if (url === 'https://cdn.example.com/audio/ep002.mp3') {
        throw new TypeError('CORS blocked');
      }
      if (url.startsWith('https://corsproxy.io/?')) {
        return {
          ok: true,
          blob: async () => new Blob(['mock-mp3-bytes'], { type: 'audio/mpeg' }),
        };
      }
      return { ok: false };
    },
  });

  // Multi-episode podcast should set durationSec to active episode (3930), NOT totalDurationSec (6465)
  await engine.loadBook(podcastBook);
  assert.equal(engine._isMultiFileChapters(podcastBook.chapters), true);
  assert.equal(engine.durationSec, 3930);
  assert.equal(engine.chapterIndex, 0);

  // Seek to 900s on episode 0, then switch to episode 1 (duration 2535s)
  engine.seekToSeconds(900);
  assert.equal(podcastBook.episodeProgress['ep-guid-002'].positionSec, 900);

  await engine.setChapter(1);
  assert.equal(engine.chapterIndex, 1);
  assert.equal(engine.durationSec, 2535);
  assert.equal(engine.positionSec, 0);

  // Seek on episode 1, then switch back to episode 0 and verify 900s is restored
  engine.seekToSeconds(450);
  assert.equal(podcastBook.episodeProgress['ep-guid-001'].positionSec, 450);

  await engine.setChapter(0);
  assert.equal(engine.chapterIndex, 0);
  assert.equal(engine.durationSec, 3930);
  assert.equal(engine.positionSec, 900);

  // Single-episode podcast duration check
  const singleEpPodcast = createPodcastBookItem({
    ...parsed,
    episodes: [parsed.episodes[0]],
  });
  await engine.loadBook(singleEpPodcast);
  assert.equal(engine._isMultiFileChapters(singleEpPodcast.chapters), true);
  assert.equal(engine.durationSec, 3930);

  // Offline episode caching with CORS-proxy fallback
  const cacheRes = await engine.cacheEpisodeOffline(podcastBook, 0);
  assert.equal(cacheRes.ok, true);
  assert.equal(cacheRes.cacheKey, `${podcastBook.bookKey}::ep-guid-002`);
  assert.equal(podcastBook.chapters[0].offlineCached, true);
  assert.equal(podcastBook.hasOfflineEpisodes, true);
  assert.equal(await engine.isEpisodeCachedOffline(podcastBook.bookKey, 'ep-guid-002'), true);

  const removeRes = await engine.removeEpisodeOffline(podcastBook, 0);
  assert.equal(removeRes.ok, true);
  assert.equal(podcastBook.chapters[0].offlineCached, false);
  assert.equal(await engine.isEpisodeCachedOffline(podcastBook.bookKey, 'ep-guid-002'), false);
  engine.destroy();
});

test('SupabaseSyncService and deduplicateBooks preserve podcast metadata without merging into audiobooks', () => {
  const parsed = parsePodcastRssXml(SAMPLE_RSS_XML, 'https://example.com/feed.xml');
  const podcastBook = createPodcastBookItem(parsed);
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  const sync = new SupabaseSyncService({
    storage,
    windowObj: null,
    navigatorObj: { onLine: false },
    BroadcastChannelImpl: null,
    WebSocketImpl: null,
  });

  const normalizedCloud = sync._normalizeLibraryItemForCloud({
    ...podcastBook,
    episodeProgress: {
      'ep-guid-002': { positionSec: 320, durationSec: 3930, completed: false },
    },
  });
  sync.destroy?.();

  assert.equal(normalizedCloud.isPodcast, true);
  assert.equal(normalizedCloud.mediaType, 'podcast');
  assert.equal(normalizedCloud.feedUrl, 'https://example.com/feed.xml');
  assert.equal(normalizedCloud.episodeProgress['ep-guid-002'].positionSec, 320);
  assert.equal(normalizedCloud.chapters.length, 2);
  assert.ok(podcastBook.chapters[0].driveStreamUrl, 'podcast chapters carry driveStreamUrl for AudioEngine');
  assert.deepEqual(normalizedCloud.sources, ['podcast'], 'cloud-normalized podcast must never be polluted with drive source');

  // Ensure deduplicateBooks does not merge a podcast and an audiobook with the same title
  const sameTitleAudiobook = {
    bookKey: 'local:tech-future-frontiers',
    title: 'Tech & Future Frontiers',
    author: 'Dr. Ada & Alan',
    totalDurationSec: 36000,
    sources: ['local'],
    source: 'local',
    chapters: [{ index: 0, title: 'Chapter 1', startSec: 0, durationSec: 36000 }],
  };
  const deduped = deduplicateBooks([sameTitleAudiobook, podcastBook]);
  assert.equal(deduped.length, 2);
  assert.ok(deduped.some((b) => b.isPodcast === true));
  assert.ok(deduped.some((b) => !b.isPodcast));
});

