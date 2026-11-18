/**
 * Audiobook Player — Main Interactive Application Controller
 * Supports:
 * - Automatic viewport layout switching (Desktop 3-column, Mobile full-bleed, Wear OS Watch)
 * - Midnight Black (default) & Pitch Black themes (via Profile menu)
 * - Real adaptive audio output detection via navigator.mediaDevices.enumerateDevices()
 * - Gmail Profile Avatar + Clean Minimalist Profile & Settings Popover
 * - Live Cover Image Search Modal + Local Cover Upload
 * - Real Local Folder Scanning (#localFolderInput) + Google Drive Scanning + Deduplication
 */

import { OfflineSyncQueue, resolveProgressConflict } from '../services/offline-queue.js';
import { SupabaseSyncService, handleRemoteEvent } from '../services/supabase-sync.js';
import {
  deduplicateLibraryItems,
  scanLocalFiles,
  scanGoogleDriveFolder,
  normalizeBookKey
} from '../services/library-scanner.js';
import { enrichBookMetadata } from '../services/metadata-enrichment.js';
import { searchCoverImages, buildCuratedSvgCover } from '../services/cover-search.js';
import { SelfUpdaterService, LOCAL_VERSION } from '../services/self-updater.js';
import { AudioEngine } from '../player/audio-engine.js';
import { MediaSessionBridge } from '../player/media-session-bridge.js';
import {
  ICON_PLAY,
  ICON_PAUSE,
  ICON_PREV,
  ICON_NEXT,
  ICON_SKIP_BACK_15,
  ICON_SKIP_FORWARD_30,
  ICON_BOOKMARK,
  ICON_SEARCH,
  ICON_HOME,
  ICON_LIBRARY,
  ICON_COVER_IMAGE,
  ICON_CLOSE,
  ICON_CHEVRON,
  ICON_DOWNLOADED,
  ICON_DOWNLOAD_CIRCLE,
  ICON_SLEEP,
  ICON_SPEAKER,
  ICON_SPARKLES,
  ICON_PANEL_RIGHT,
  ICON_UPLOAD,
  FLUENT_3D_FOLDER,
  FLUENT_3D_CLOUD
} from './icons.js';

const STORAGE_THEME_KEY = 'audiobook_player_theme_v1';
const STORAGE_LIBRARY_KEY = 'audiobook_player_library_v1';
const STORAGE_ACTIVE_BOOK_KEY = 'audiobook_player_active_book_v1';
const STORAGE_DEMO_USER_KEY = 'audiobook_player_demo_user_v1';

const PLAYBACK_RATES = [1.0, 1.25, 1.5, 1.75, 2.0];

function formatPlaybackRate(rate = 1.0) {
  const num = Number(rate) || 1.0;
  return `${num.toFixed(num % 1 === 0 ? 1 : 2)}x`;
}

function safeHexColor(hex, fallback = '#1ed760') {
  return typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex.trim())
    ? hex.trim()
    : fallback;
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatClock(totalSeconds = 0) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hrs = Math.floor(sec / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const remSec = sec % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(remSec).padStart(2, '0')}`;
  }
  return `${mins}:${String(remSec).padStart(2, '0')}`;
}

function formatRemaining(totalSec = 0, positionSec = 0) {
  const left = Math.max(0, Math.floor((Number(totalSec) || 0) - (Number(positionSec) || 0)));
  const hrs = Math.floor(left / 3600);
  const mins = Math.floor((left % 3600) / 60);
  if (hrs > 0) return `${hrs}h ${mins}m left`;
  return `${Math.max(1, mins)}m left`;
}

function createInitialCatalog() {
  const makeCover = (title, bg1, bg2, accent, label) =>
    buildCuratedSvgCover(title, {
      id: title.toLowerCase(),
      label,
      bg1,
      bg2,
      accent,
      ring: `${accent}44`
    });

  return deduplicateLibraryItems([
    {
      bookKey: normalizeBookKey('Project Hail Mary', 'Andy Weir'),
      title: 'Project Hail Mary',
      author: 'Andy Weir',
      narrator: 'Ray Porter',
      series: 'Standalone',
      year: '2021',
      description:
        'Ryland Grace is the sole survivor on a desperate, last-chance mission—and if he fails, humanity and the earth itself will perish.',
      totalDurationSec: 58200,
      positionSec: 18420,
      chapterIndex: 2,
      sources: ['drive', 'local'],
      preferredPlaybackSource: 'local',
      isOffline: true,
      offline: true,
      accentHex: '#f59e0b',
      accentSecondaryHex: '#131b2e',
      coverUrl: makeCover('Project Hail Mary', '#1b1106', '#2c1f0b', '#f59e0b', 'Andy Weir'),
      chapters: [
        { index: 0, title: 'Chapter 1: Awakening', startSec: 0 },
        { index: 1, title: 'Chapter 2: Petrova Line', startSec: 7200 },
        { index: 2, title: 'Chapter 3: Hail Mary', startSec: 16200 },
        { index: 3, title: 'Chapter 4: Eridani', startSec: 28800 },
        { index: 4, title: 'Chapter 5: Astrophage', startSec: 42000 }
      ],
      bookmarks: [
        {
          id: 'bm-phm-1',
          bookKey: 'project-hail-mary::andy-weir',
          chapterIndex: 2,
          positionSec: 17120,
          label: 'First contact signal',
          clientUpdatedAt: '2026-11-17T08:12:00.000Z'
        }
      ]
    },
    {
      bookKey: normalizeBookKey('The Fellowship of the Ring', 'J.R.R. Tolkien'),
      title: 'The Fellowship of the Ring',
      author: 'J.R.R. Tolkien',
      narrator: 'Andy Serkis',
      series: 'The Lord of the Rings',
      year: '1954',
      description:
        'In a sleepy village in the Shire, young Frodo Baggins finds himself faced with an immense task as the One Ring passes into his care.',
      totalDurationSec: 81600,
      positionSec: 12900,
      chapterIndex: 1,
      sources: ['drive'],
      preferredPlaybackSource: 'drive',
      isOffline: false,
      offline: false,
      accentHex: '#1ed760',
      accentSecondaryHex: '#0b1812',
      coverUrl: makeCover('The Fellowship of the Ring', '#071612', '#123328', '#1ed760', 'J.R.R. Tolkien'),
      chapters: [
        { index: 0, title: 'Book I: A Long-Expected Party', startSec: 0 },
        { index: 1, title: 'Book I: The Shadow of the Past', startSec: 9400 },
        { index: 2, title: 'Book I: At the Sign of The Prancing Pony', startSec: 24200 },
        { index: 3, title: 'Book II: The Council of Elrond', startSec: 46800 }
      ],
      bookmarks: []
    },
    {
      bookKey: normalizeBookKey('Dune', 'Frank Herbert'),
      title: 'Dune',
      author: 'Frank Herbert',
      narrator: 'Scott Brick',
      series: 'Dune Chronicles',
      year: '1965',
      description:
        'Set on the desert planet Arrakis, Dune tells the story of young Paul Atreides as his family accepts stewardship of the universe’s most coveted resource.',
      totalDurationSec: 75600,
      positionSec: 34200,
      chapterIndex: 2,
      sources: ['drive'],
      preferredPlaybackSource: 'drive',
      isOffline: true,
      offline: true,
      accentHex: '#fb923c',
      accentSecondaryHex: '#1d1007',
      coverUrl: makeCover('Dune', '#1a0c05', '#3c1e0c', '#fb923c', 'Frank Herbert'),
      chapters: [
        { index: 0, title: 'Book 1: Dune', startSec: 0 },
        { index: 1, title: 'Book 2: Muad’Dib', startSec: 26000 },
        { index: 2, title: 'Book 3: The Prophet', startSec: 52000 }
      ],
      bookmarks: []
    },
    {
      bookKey: normalizeBookKey('Atomic Habits', 'James Clear'),
      title: 'Atomic Habits',
      author: 'James Clear',
      narrator: 'James Clear',
      series: '',
      year: '2018',
      description:
        'An easy and proven way to build good habits and break bad ones through tiny daily systems.',
      totalDurationSec: 19800,
      positionSec: 6300,
      chapterIndex: 1,
      sources: ['local'],
      preferredPlaybackSource: 'local',
      isOffline: true,
      offline: true,
      accentHex: '#60a5fa',
      accentSecondaryHex: '#0b1426',
      coverUrl: makeCover('Atomic Habits', '#070e1d', '#14264b', '#60a5fa', 'James Clear'),
      chapters: [
        { index: 0, title: 'Fundamentals: The Surprising Power', startSec: 0 },
        { index: 1, title: '1st Law: Make It Obvious', startSec: 4800 },
        { index: 2, title: '2nd Law: Make It Attractive', startSec: 10200 },
        { index: 3, title: '3rd Law: Make It Easy', startSec: 15000 }
      ],
      bookmarks: []
    },
    {
      bookKey: normalizeBookKey('The Three-Body Problem', 'Cixin Liu'),
      title: 'The Three-Body Problem',
      author: 'Cixin Liu',
      narrator: 'Luke Daniels',
      series: 'Remembrance of Earth’s Past',
      year: '2008',
      description:
        'A secret military project sends signals into space to establish contact with aliens, sparking a centuries-spanning cosmic confrontation.',
      totalDurationSec: 48600,
      positionSec: 9420,
      chapterIndex: 1,
      sources: ['drive', 'local'],
      preferredPlaybackSource: 'local',
      isOffline: true,
      offline: true,
      accentHex: '#38bdf8',
      accentSecondaryHex: '#0a1628',
      coverUrl: makeCover('The Three-Body Problem', '#07111e', '#102b46', '#38bdf8', 'Cixin Liu'),
      chapters: [
        { index: 0, title: 'Part I: Silent Spring', startSec: 0 },
        { index: 1, title: 'Part II: Three Body', startSec: 8400 },
        { index: 2, title: 'Part III: Sunset for Humanity', startSec: 27400 }
      ],
      bookmarks: []
    },
    {
      bookKey: normalizeBookKey('The Pragmatic Programmer', 'David Thomas & Andrew Hunt'),
      title: 'The Pragmatic Programmer',
      author: 'David Thomas & Andrew Hunt',
      narrator: 'Anna Katarina',
      series: '20th Anniversary Edition',
      year: '2019',
      description:
        'Your journey to mastery through timeless software craftsmanship principles and practical engineering habits.',
      totalDurationSec: 34800,
      positionSec: 2100,
      chapterIndex: 0,
      sources: ['local'],
      preferredPlaybackSource: 'local',
      isOffline: true,
      offline: true,
      accentHex: '#a78bfa',
      accentSecondaryHex: '#150e28',
      coverUrl: makeCover('The Pragmatic Programmer', '#120a24', '#26174a', '#a78bfa', 'Thomas & Hunt'),
      chapters: [
        { index: 0, title: 'Chapter 1: A Pragmatic Philosophy', startSec: 0 },
        { index: 1, title: 'Chapter 2: A Pragmatic Approach', startSec: 6900 },
        { index: 2, title: 'Chapter 3: The Basic Tools', startSec: 15800 }
      ],
      bookmarks: []
    }
  ]);
}

class AudiobookApp {
  constructor(rootEl) {
    this.rootEl = rootEl;
    this.offlineQueue = new OfflineSyncQueue();
    this.syncService = new SupabaseSyncService({ offlineQueue: this.offlineQueue });
    this.updaterService = new SelfUpdaterService();
    this.audioEngine = new AudioEngine({
      onTimeUpdate: (snap) => this._handleTimeUpdate(snap),
      onStateChange: (snap) => this._handleEngineStateChange(snap),
      onChapterChange: () => this._syncMediaSessionMetadata(),
      onEnded: () => this._handleBookEnded(),
      onSleepTimerUpdate: () => this.render(),
      onOfflineChange: (bookKey, cached) => this._handleOfflineChange(bookKey, cached)
    });

    this.mediaBridge = new MediaSessionBridge({
      onPlay: () => this.audioEngine.play(),
      onPause: () => this.audioEngine.pause(),
      onSeekBackward: (sec = 15) => this.audioEngine.skipSeconds(-Math.abs(sec)),
      onSeekForward: (sec = 30) => this.audioEngine.skipSeconds(Math.abs(sec)),
      onPreviousTrack: () => this.prevChapter(),
      onNextTrack: () => this.nextChapter(),
      onSeekTo: (sec) => this.audioEngine.seekToSeconds(sec),
      onAutoPause: () => this._persistProgressCheckpoint(true),
      onAndroidAutoChange: (connected) => {
        if (!this.state) return;
        this.state.androidAutoConnected = connected;
        this.state.layoutMode = this._detectViewportLayout();
        this.render();
      },
      onAudioOutputChange: (outputState) => {
        if (!this.state) return;
        this.state.activeOutputDevice = outputState.activeLabel || 'System Audio';
        this.state.activeOutputDeviceId = outputState.activeDeviceId || 'default';
        this.state.audioOutputs = outputState.devices || [];
        this.render();
      }
    });

    const initialAudioOutput = this.mediaBridge.getAudioOutputState();
    const initialAndroidAuto = this.mediaBridge.isAndroidAutoConnected();

    this.state = {
      theme: this._loadTheme(),
      androidAutoConnected: initialAndroidAuto,
      layoutMode: this._detectViewportLayout(initialAndroidAuto),
      desktopView: 'home', // 'home' | 'detail'
      mobileSheetOpen: false,
      mobileTab: 'home', // 'home' | 'library'
      shadeOpen: false,
      profileOpen: false,
      sidebarCollapsed: false,
      rightPanelOpen: true,
      filterSource: 'all', // 'all' | 'local' | 'drive' | 'downloaded'
      searchQuery: '',
      activeOutputDevice: initialAudioOutput.activeLabel || 'System Audio',
      activeOutputDeviceId: initialAudioOutput.activeDeviceId || 'default',
      audioOutputs: initialAudioOutput.devices || [],
      books: this._loadBooks(),
      activeBookKey: null,
      detailBookKey: null,
      coverModal: {
        open: false,
        bookKey: null,
        query: '',
        loading: false,
        results: []
      },
      enrichingBookKey: null,
      updateState: {
        checking: false,
        checked: false,
        updateAvailable: false,
        latestVersion: LOCAL_VERSION
      },
      bookmarksByBook: {},
      snapshot: {
        playing: false,
        positionSec: 0,
        durationSec: 0,
        playbackRate: 1.0,
        chapterIndex: 0,
        sleepTimerMode: 0,
        sleepRemainingSec: 0
      },
      demoUser: this._loadDemoUser()
    };

    this._lastCheckpointAt = 0;
  }

  _detectViewportLayout(androidAutoOverride = null) {
    if (typeof window === 'undefined') return 'desktop';
    const search = window.location?.search || '';
    const isAuto =
      androidAutoOverride !== null
        ? Boolean(androidAutoOverride)
        : Boolean(this.state?.androidAutoConnected ?? this.mediaBridge?.isAndroidAutoConnected());
    if (isAuto || search.includes('androidAuto=1')) {
      return 'auto';
    }
    if (search.includes('watch=1') || window.innerWidth <= 340) {
      return 'watch';
    }
    if (window.innerWidth < 768 && window.innerWidth > 340) {
      return 'android';
    }
    return 'desktop';
  }

  _loadTheme() {
    try {
      const saved = localStorage.getItem(STORAGE_THEME_KEY);
      if (saved === 'pitch' || saved === 'midnight') return saved;
    } catch {
      // ignore
    }
    return 'midnight';
  }

  _saveTheme(theme) {
    this.state.theme = theme;
    this._applyThemeBodyClass(theme);
    try {
      localStorage.setItem(STORAGE_THEME_KEY, theme);
    } catch {
      // ignore
    }
  }

  _applyThemeBodyClass(theme) {
    if (typeof document === 'undefined') return;
    document.body.classList.remove('theme-midnight', 'theme-pitch');
    document.body.classList.add(theme === 'pitch' ? 'theme-pitch' : 'theme-midnight');
  }

  _loadDemoUser() {
    try {
      const raw = localStorage.getItem(STORAGE_DEMO_USER_KEY);
      if (raw) return JSON.parse(raw);
    } catch {
      // ignore
    }
    return {
      name: 'Alex Morgan',
      email: 'alex.morgan@gmail.com',
      avatarUrl: ''
    };
  }

  _loadBooks() {
    const defaults = createInitialCatalog();
    try {
      const raw = localStorage.getItem(STORAGE_LIBRARY_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (Array.isArray(saved) && saved.length > 0) {
          // Merge saved customizations (covers, progress, new books) with defaults
          const merged = deduplicateLibraryItems([...defaults, ...saved]);
          return merged.map((b) => {
            const override = saved.find((s) => s.bookKey === b.bookKey);
            if (!override) return b;
            return {
              ...b,
              coverUrl: override.coverUrl || b.coverUrl,
              author: override.author || b.author,
              narrator: override.narrator || b.narrator,
              description: override.description || b.description,
              totalDurationSec: override.totalDurationSec || b.totalDurationSec,
              positionSec: override.positionSec ?? b.positionSec,
              chapterIndex: override.chapterIndex ?? b.chapterIndex,
              isOffline: Boolean(override.isOffline ?? b.isOffline),
              offline: Boolean(override.offline ?? b.offline)
            };
          });
        }
      }
    } catch {
      // ignore
    }
    return defaults;
  }

  _persistBooks() {
    try {
      const serializable = this.state.books.map((b) => {
        const { localFile, ...rest } = b;
        return rest;
      });
      localStorage.setItem(STORAGE_LIBRARY_KEY, JSON.stringify(serializable));
    } catch {
      // ignore storage quota errors
    }
  }

  async init() {
    this._applyThemeBodyClass(this.state.theme);
    await this.offlineQueue.ready();

    // Handle OAuth callback if returning from Google login
    if (typeof window !== 'undefined' && window.location.hash.includes('access_token=')) {
      await this.syncService.handleAuthCallback(window.location.hash).catch(() => null);
      if (window.history?.replaceState) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    }

    const token = this.syncService.getGoogleAccessToken();
    if (token) {
      this.audioEngine.setDriveAccessToken(token);
    }

    // Reconcile stored progress & bookmarks
    const progressMap = await this.syncService.fetchAllProgress().catch(() => ({}));
    this.state.books = this.state.books.map((book) => {
      const localStored = progressMap[book.bookKey];
      const merged = localStored ? resolveProgressConflict(book, localStored) : book;
      return {
        ...book,
        positionSec: merged?.positionSec ?? book.positionSec,
        chapterIndex: merged?.chapterIndex ?? book.chapterIndex
      };
    });

    for (const book of this.state.books) {
      this.state.bookmarksByBook[book.bookKey] = await this.syncService
        .fetchBookmarks(book.bookKey)
        .catch(() => book.bookmarks || []);
    }

    // Restore last active book
    let savedActiveKey = null;
    try {
      savedActiveKey = localStorage.getItem(STORAGE_ACTIVE_BOOK_KEY);
    } catch {
      // ignore
    }
    const initialBook =
      this.state.books.find((b) => b.bookKey === savedActiveKey) || this.state.books[0];

    if (initialBook) {
      await this.selectBook(initialBook.bookKey, false);
    }

    // Subscribe to remote playback handoff
    this.syncService.onRemotePlaybackEvent((remoteEvent) => {
      const activeBook = this.getActiveBook();
      const decision = handleRemoteEvent(
        {
          deviceId: this.syncService.deviceId,
          deviceName: this.syncService.deviceName,
          bookKey: activeBook?.bookKey,
          chapterIndex: this.state.snapshot.chapterIndex,
          positionSec: this.state.snapshot.positionSec
        },
        remoteEvent
      );

      if (decision.shouldPauseLocal && this.audioEngine.playing) {
        this.audioEngine.pause();
      }
      if (decision.updatedBookKey && decision.updatedPositionSec !== undefined) {
        const target = this.state.books.find((b) => b.bookKey === decision.updatedBookKey);
        if (target) {
          target.positionSec = decision.updatedPositionSec;
          target.chapterIndex = decision.updatedChapterIndex;
          if (target.bookKey === activeBook?.bookKey) {
            this.audioEngine.seekToSeconds(decision.updatedPositionSec);
          }
          this.render();
        }
      }
    });

    this.syncService.connectRealtime();
    await this.mediaBridge.refreshAudioOutputs().catch(() => null);
    this._bindGlobalInputs();
    this.render();
  }

  _bindGlobalInputs() {
    const folderInput = document.getElementById('localFolderInput');
    if (folderInput) {
      folderInput.addEventListener('change', async (e) => {
        const files = e.target?.files;
        if (!files || files.length === 0) return;
        const scanned = await scanLocalFiles(files);
        if (scanned.length > 0) {
          this.state.books = deduplicateLibraryItems([...this.state.books, ...scanned]);
          this._persistBooks();
          await this.selectBook(scanned[0].bookKey, true);
          this.render();
        }
        folderInput.value = '';
      });
    }

    const coverInput = document.getElementById('localCoverInput');
    if (coverInput) {
      coverInput.addEventListener('change', (e) => {
        const file = e.target?.files?.[0];
        const targetKey = this.state.coverModal.bookKey || this.state.activeBookKey;
        if (!file || !targetKey) return;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = typeof reader.result === 'string' ? reader.result : '';
          if (dataUrl) {
            this._applyCoverToBook(targetKey, dataUrl);
          }
        };
        reader.readAsDataURL(file);
        coverInput.value = '';
      });
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('click', (e) => {
        if (!this.state.profileOpen) return;
        const pop = document.getElementById('profilePopover');
        const btn = document.getElementById('profileAvatarBtn');
        if (pop && !pop.contains(e.target) && btn && !btn.contains(e.target)) {
          this.state.profileOpen = false;
          this.render();
        }
      });
    }

    if (typeof window !== 'undefined') {
      const handleViewportChange = () => {
        const nextLayout = this._detectViewportLayout();
        if (nextLayout !== this.state.layoutMode) {
          this.state.layoutMode = nextLayout;
          this.state.profileOpen = false;
          this.render();
        }
      };
      window.addEventListener('resize', handleViewportChange);
      if (typeof window.matchMedia === 'function') {
        const mqMobile = window.matchMedia('(max-width: 767px)');
        const mqWatch = window.matchMedia('(max-width: 340px)');
        if (typeof mqMobile.addEventListener === 'function') {
          mqMobile.addEventListener('change', handleViewportChange);
        }
        if (typeof mqWatch.addEventListener === 'function') {
          mqWatch.addEventListener('change', handleViewportChange);
        }
      }
    }
  }

  getActiveBook() {
    return (
      this.state.books.find((b) => b.bookKey === this.state.activeBookKey) ||
      this.state.books[0] ||
      null
    );
  }

  getDetailBook() {
    return (
      this.state.books.find((b) => b.bookKey === this.state.detailBookKey) ||
      this.getActiveBook()
    );
  }

  getUserAccount() {
    const supaProfile = this.syncService.getUserProfile();
    if (supaProfile) {
      return { ...supaProfile, authenticated: true };
    }
    return {
      ...this.state.demoUser,
      authenticated: false
    };
  }

  getFilteredBooks() {
    const q = (this.state.searchQuery || '').trim().toLowerCase();
    return this.state.books.filter((book) => {
      if (this.state.filterSource === 'local' && !book.sources?.includes('local')) return false;
      if (this.state.filterSource === 'drive' && !book.sources?.includes('drive')) return false;
      if (this.state.filterSource === 'downloaded' && !book.isOffline && !book.offlineCached) {
        return false;
      }
      if (q) {
        const hay = `${book.title} ${book.author} ${book.narrator || ''} ${book.series || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  async selectBook(bookKey, autoPlay = false) {
    const book = this.state.books.find((b) => b.bookKey === bookKey);
    if (!book) return;
    this.state.activeBookKey = book.bookKey;
    try {
      localStorage.setItem(STORAGE_ACTIVE_BOOK_KEY, book.bookKey);
    } catch {
      // ignore
    }

    await this.audioEngine.loadBook(book, book.positionSec || 0);
    this.state.snapshot = this.audioEngine.getSnapshot();
    this._updateAmbientColor(book.accentHex);
    this._syncMediaSessionMetadata();

    if (autoPlay) {
      await this.audioEngine.play();
      this.syncService.broadcastPlaybackState({
        isPlaying: true,
        bookKey: book.bookKey,
        chapterIndex: this.state.snapshot.chapterIndex,
        positionSec: this.state.snapshot.positionSec
      });
    }
    this.render();
  }

  _updateAmbientColor(hex = '#1ed760') {
    if (typeof document === 'undefined') return;
    const clean = hex && /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#1ed760';
    const r = parseInt(clean.slice(1, 3), 16);
    const g = parseInt(clean.slice(3, 5), 16);
    const b = parseInt(clean.slice(5, 7), 16);
    document.documentElement.style.setProperty('--ambient-color', `rgba(${r}, ${g}, ${b}, 0.22)`);
  }

  _syncMediaSessionMetadata() {
    const book = this.getActiveBook();
    if (!book) return;
    const chapter = book.chapters?.[this.state.snapshot.chapterIndex];
    this.mediaBridge.updateMetadata(book, chapter?.title || '');
    this.mediaBridge.updatePlaybackState(this.state.snapshot);
  }

  _handleTimeUpdate(snap) {
    this.state.snapshot = snap;
    const book = this.getActiveBook();
    if (book && snap.bookKey === book.bookKey) {
      book.positionSec = snap.positionSec;
      book.chapterIndex = snap.chapterIndex;
      if (snap.durationSec > 0) {
        book.totalDurationSec = snap.durationSec;
      }
    }

    this.mediaBridge.updatePlaybackState(snap);
    this._updateLiveProgressDom(snap, book);

    const now = Date.now();
    if (now - this._lastCheckpointAt >= 5000) {
      this._lastCheckpointAt = now;
      this._persistProgressCheckpoint(false);
    }
  }

  _handleEngineStateChange(snap) {
    const prevPlaying = this.state.snapshot?.playing;
    const prevChapter = this.state.snapshot?.chapterIndex;
    this.state.snapshot = snap;
    this.mediaBridge.updatePlaybackState(snap);

    if (prevPlaying !== snap.playing) {
      const book = this.getActiveBook();
      if (book) {
        this.syncService.broadcastPlaybackState({
          isPlaying: snap.playing,
          bookKey: book.bookKey,
          chapterIndex: snap.chapterIndex,
          positionSec: snap.positionSec
        });
      }
      this._persistProgressCheckpoint(true);
      this.render();
      return;
    }

    if (prevChapter !== snap.chapterIndex) {
      this._syncMediaSessionMetadata();
      this.render();
      return;
    }

    this._updateLiveProgressDom(snap, this.getActiveBook());
  }

  _handleBookEnded() {
    this._persistProgressCheckpoint(true);
    this.render();
  }

  _handleOfflineChange(bookKey, cached) {
    const book = this.state.books.find((b) => b.bookKey === bookKey);
    if (book) {
      const hasLocal = book.sources?.includes('local');
      book.offlineCached = cached;
      book.isOffline = Boolean(cached || hasLocal);
      book.offline = book.isOffline;
      this._persistBooks();
      this.render();
    }
  }

  _persistProgressCheckpoint(immediate = false) {
    const book = this.getActiveBook();
    if (!book) return;
    const checkpoint = {
      bookKey: book.bookKey,
      chapterIndex: this.state.snapshot.chapterIndex,
      positionSec: Math.round(this.state.snapshot.positionSec),
      durationSec: Math.round(this.state.snapshot.durationSec || book.totalDurationSec || 0),
      completed:
        (this.state.snapshot.durationSec || 0) > 0 &&
        this.state.snapshot.positionSec >= this.state.snapshot.durationSec - 5,
      clientUpdatedAt: new Date().toISOString()
    };

    this._persistBooks();
    if (immediate) {
      void this.syncService.pushProgress(checkpoint);
    } else {
      this.offlineQueue.saveLocalProgress(book.bookKey, checkpoint);
    }
  }

  _updateLiveProgressDom(snap, book) {
    if (typeof document === 'undefined' || !book) return;
    const duration = Math.max(1, snap.durationSec || book.totalDurationSec || 1);
    const pos = Math.max(0, Math.min(duration, snap.positionSec || 0));
    const pct = Math.min(100, Math.max(0, (pos / duration) * 100));

    document.querySelectorAll('[data-ab-range]').forEach((el) => {
      if (document.activeElement !== el) {
        el.value = String(Math.round(pos));
        el.max = String(Math.round(duration));
      }
      el.style.setProperty('--range-progress', `${pct.toFixed(2)}%`);
    });

    document.querySelectorAll('[data-ab-elapsed]').forEach((el) => {
      el.textContent = formatClock(pos);
    });

    document.querySelectorAll('[data-ab-remaining]').forEach((el) => {
      el.textContent = `-${formatClock(Math.max(0, duration - pos))}`;
    });

    document.querySelectorAll('[data-ab-timeleft]').forEach((el) => {
      if (el.dataset.bookKey === book.bookKey) {
        el.textContent = formatRemaining(duration, pos);
      }
    });

    document.querySelectorAll('[data-ab-watch-ring]').forEach((el) => {
      const circumference = Number(el.dataset.circumference || 791.68);
      const offset = circumference * (1 - pct / 100);
      el.setAttribute('stroke-dashoffset', offset.toFixed(2));
    });

    document.querySelectorAll('[data-ab-progress-fill]').forEach((el) => {
      el.style.width = `${pct.toFixed(2)}%`;
    });
  }

  prevChapter() {
    const book = this.getActiveBook();
    if (!book?.chapters?.length) {
      this.audioEngine.skipSeconds(-15);
      return;
    }
    const curIdx = this.state.snapshot.chapterIndex || 0;
    const curStart = book.chapters[curIdx]?.startSec || 0;
    if (this.state.snapshot.positionSec - curStart > 6 || curIdx === 0) {
      this.audioEngine.jumpToChapter(curIdx);
    } else {
      this.audioEngine.jumpToChapter(curIdx - 1);
    }
  }

  nextChapter() {
    const book = this.getActiveBook();
    if (!book?.chapters?.length) {
      this.audioEngine.skipSeconds(30);
      return;
    }
    const nextIdx = Math.min(book.chapters.length - 1, (this.state.snapshot.chapterIndex || 0) + 1);
    this.audioEngine.jumpToChapter(nextIdx);
  }

  cycleSpeed() {
    const current = this.state.snapshot.playbackRate || 1.0;
    const idx = PLAYBACK_RATES.findIndex((r) => Math.abs(r - current) < 0.05);
    const next = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
    this.audioEngine.setPlaybackRate(next);
    this.state.snapshot = this.audioEngine.getSnapshot();
    this.render();
  }

  async selectOutputDevice(deviceId) {
    const state = this.mediaBridge.selectAudioOutput(deviceId);
    this.state.activeOutputDevice = state.activeLabel || 'System Audio';
    this.state.activeOutputDeviceId = state.activeDeviceId || 'default';
    this.state.audioOutputs = state.devices || [];

    if (this.audioEngine?.audio && typeof this.audioEngine.audio.setSinkId === 'function') {
      try {
        await this.audioEngine.audio.setSinkId(deviceId);
      } catch {
        // Ignore sink selection errors in restricted contexts
      }
    }

    const book = this.getActiveBook();
    if (book) {
      this.syncService.broadcastPlaybackState({
        isPlaying: this.state.snapshot.playing,
        bookKey: book.bookKey,
        chapterIndex: this.state.snapshot.chapterIndex,
        positionSec: this.state.snapshot.positionSec,
        deviceName: this.state.activeOutputDevice
      });
    }
    this.render();
  }

  cycleOutputDevice() {
    const outputs = this.state.audioOutputs || [];
    if (outputs.length <= 1) {
      void this.mediaBridge.refreshAudioOutputs();
      return;
    }
    const idx = outputs.findIndex((d) => d.deviceId === this.state.activeOutputDeviceId);
    const next = outputs[(idx + 1) % outputs.length];
    if (next) {
      void this.selectOutputDevice(next.deviceId);
    }
  }

  async addBookmark(bookKey = null) {
    const book = bookKey
      ? this.state.books.find((b) => b.bookKey === bookKey)
      : this.getActiveBook();
    if (!book) return;

    const snap = this.state.snapshot;
    const chapter = book.chapters?.[snap.chapterIndex];
    const bookmark = {
      id: `bm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      bookKey: book.bookKey,
      chapterIndex: snap.chapterIndex || 0,
      positionSec: Math.round(snap.positionSec || 0),
      label: chapter?.title || `Chapter ${(snap.chapterIndex || 0) + 1}`,
      clientUpdatedAt: new Date().toISOString()
    };

    await this.syncService.saveBookmark(book.bookKey, bookmark);
    const list = this.state.bookmarksByBook[book.bookKey] || [];
    this.state.bookmarksByBook[book.bookKey] = [...list, bookmark].sort(
      (a, b) => a.positionSec - b.positionSec
    );
    this.render();
  }

  async toggleOfflineDownload(bookKey) {
    const book = this.state.books.find((b) => b.bookKey === bookKey);
    if (!book) return;
    if (book.offlineCached) {
      await this.audioEngine.removeOfflineCopy(book);
    } else {
      await this.audioEngine.cacheBookOffline(book);
    }
  }

  async handleAutoMatchTags(bookKey = null) {
    const book = bookKey
      ? this.state.books.find((b) => b.bookKey === bookKey)
      : this.getActiveBook();
    if (!book) return;

    this.state.enrichingBookKey = book.bookKey;
    this.render();
    try {
      const enriched = await enrichBookMetadata(book);
      const idx = this.state.books.findIndex((b) => b.bookKey === book.bookKey);
      if (idx >= 0) {
        this.state.books[idx] = {
          ...this.state.books[idx],
          author: enriched.author || this.state.books[idx].author,
          narrator: enriched.narrator || this.state.books[idx].narrator,
          description: enriched.description || this.state.books[idx].description,
          totalDurationSec: enriched.totalDurationSec || this.state.books[idx].totalDurationSec,
          coverUrl: enriched.coverUrl || this.state.books[idx].coverUrl,
          series: enriched.series || this.state.books[idx].series,
          year: enriched.year || this.state.books[idx].year
        };
        this._persistBooks();
        this._syncMediaSessionMetadata();
      }
    } finally {
      this.state.enrichingBookKey = null;
      this.render();
    }
  }

  async handleConnectGoogleDrive() {
    const token = this.syncService.getGoogleAccessToken();
    if (!token) {
      await this.syncService.signInWithGoogle({ autoRedirect: true });
      return;
    }
    try {
      const driveBooks = await scanGoogleDriveFolder(token);
      if (driveBooks.length > 0) {
        this.state.books = deduplicateLibraryItems([...this.state.books, ...driveBooks]);
        this._persistBooks();
      }
    } catch {
      // Keep existing library if Drive API rejects
    }
    this.state.profileOpen = false;
    this.render();
  }

  async handleCheckForUpdate() {
    if (this.state.updateState.checking) return;
    this.state.updateState.checking = true;
    this.render();

    try {
      const result = await this.updaterService.checkForUpdate();
      this.state.updateState = {
        checking: false,
        checked: true,
        updateAvailable: Boolean(result?.updateAvailable),
        latestVersion: result?.latestVersion || LOCAL_VERSION
      };

      if (result?.updateAvailable) {
        const isAndroid =
          typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
        const hasNativeUrl = isAndroid ? result.apkDownloadUrl : result.exeDownloadUrl;
        if (hasNativeUrl) {
          this.updaterService.downloadNativeUpdate(isAndroid ? 'android' : 'windows');
        } else {
          await this.updaterService.applyOtaUpdate();
        }
      }
    } catch {
      this.state.updateState.checking = false;
    }
    this.render();
  }

  async openCoverSearchModal(bookKey = null) {
    const book = bookKey
      ? this.state.books.find((b) => b.bookKey === bookKey)
      : this.getActiveBook();
    if (!book) return;

    const query = [book.title, book.author].filter(Boolean).join(' ').trim();
    this.state.profileOpen = false;
    this.state.coverModal = {
      open: true,
      bookKey: book.bookKey,
      query,
      loading: true,
      results: []
    };
    this.render();

    const results = await searchCoverImages(query).catch(() => []);
    if (this.state.coverModal.open && this.state.coverModal.bookKey === book.bookKey) {
      this.state.coverModal.loading = false;
      this.state.coverModal.results = results;
      this.render();
    }
  }

  async runCoverSearch(query) {
    this.state.coverModal.query = query;
    this.state.coverModal.loading = true;
    this.render();
    const results = await searchCoverImages(query).catch(() => []);
    this.state.coverModal.loading = false;
    this.state.coverModal.results = results;
    this.render();
  }

  _applyCoverToBook(bookKey, url) {
    const idx = this.state.books.findIndex((b) => b.bookKey === bookKey);
    if (idx >= 0) {
      this.state.books[idx] = { ...this.state.books[idx], coverUrl: url };
      this._persistBooks();
      if (this.state.activeBookKey === bookKey) {
        this._syncMediaSessionMetadata();
      }
    }
    this.state.coverModal.open = false;
    this.render();
  }

  _renderSourceBadges(book, size = 14) {
    const sources = book?.sources || [];
    const badges = [];
    if (sources.includes('local')) {
      badges.push(`<span class="inline-flex items-center shrink-0" title="Local">${FLUENT_3D_FOLDER(size)}</span>`);
    }
    if (sources.includes('drive')) {
      badges.push(`<span class="inline-flex items-center shrink-0" title="Drive">${FLUENT_3D_CLOUD(size)}</span>`);
    }
    return badges.join('');
  }

  _renderDownloadedIcon(book, size = 14) {
    if (book?.isOffline || book?.offlineCached || book?.sources?.includes('local')) {
      return `<span class="inline-flex items-center shrink-0">${ICON_DOWNLOADED(size)}</span>`;
    }
    return '';
  }

  _renderCoverImg(book, classes = 'w-full h-full object-cover', extra = '') {
    const src = escapeHtml(book?.coverUrl || '');
    const alt = escapeHtml(book?.title || 'Audiobook');
    return `<img src="${src}" alt="${alt}" class="${classes}" ${extra} />`;
  }

  _renderAvatarButton() {
    const user = this.getUserAccount();
    const initials = (user.name || 'A')
      .split(/\s+/)
      .map((s) => s[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();

    return `
      <div class="relative shrink-0">
        <button id="profileAvatarBtn" data-action="toggle-profile" aria-label="Account" class="btn-press w-8 h-8 rounded-full overflow-hidden border border-white/15 bg-gradient-to-br from-[#1ed760] to-[#0f766e] flex items-center justify-center text-xs font-bold text-[#050506] shrink-0">
          ${
            user.avatarUrl
              ? `<img src="${escapeHtml(user.avatarUrl)}" alt="${escapeHtml(user.name)}" class="w-full h-full object-cover" />`
              : `<span>${escapeHtml(initials)}</span>`
          }
        </button>
      </div>
    `;
  }

  _renderProfilePopover() {
    if (!this.state.profileOpen) return '';
    const user = this.getUserAccount();
    const activeBook = this.getActiveBook();
    const {
      theme,
      activeOutputDevice,
      activeOutputDeviceId,
      audioOutputs,
      enrichingBookKey
    } = this.state;

    return `
      <div id="profilePopover" class="popover-menu fixed right-3 sm:right-5 top-14 z-50 w-72 max-w-[calc(100vw-24px)] rounded-2xl p-3.5 text-sm">
        <div class="flex items-center gap-3 pb-3 border-b border-[var(--border-subtle)] min-w-0">
          <div class="w-10 h-10 rounded-full overflow-hidden bg-gradient-to-br from-[#1ed760] to-[#0f766e] flex items-center justify-center text-sm font-bold text-[#050506] shrink-0">
            ${
              user.avatarUrl
                ? `<img src="${escapeHtml(user.avatarUrl)}" alt="${escapeHtml(user.name)}" class="w-full h-full object-cover" />`
                : escapeHtml((user.name || 'A')[0].toUpperCase())
            }
          </div>
          <div class="min-w-0 flex-1">
            <div class="font-semibold text-[var(--text-primary)] truncate">${escapeHtml(user.name)}</div>
            <div class="text-xs text-[var(--text-secondary)] truncate">${escapeHtml(user.email)}</div>
          </div>
        </div>

        <div class="py-2.5 border-b border-[var(--border-subtle)] space-y-1.5">
          <div class="flex items-center justify-between text-xs px-2.5">
            <span class="text-[var(--text-secondary)]">Audio Output</span>
            <span class="text-[#1ed760] font-medium truncate max-w-[145px]">${escapeHtml(activeOutputDevice)}</span>
          </div>
          ${
            audioOutputs.length > 1
              ? `<div class="space-y-1 pt-0.5">
                  ${audioOutputs
                    .map(
                      (dev) => `
                    <button data-action="select-output-device" data-device-id="${escapeHtml(dev.deviceId)}" title="${escapeHtml(dev.rawLabel || dev.label)}" class="btn-press w-full px-2.5 py-1.5 rounded-xl text-[11px] font-medium truncate text-left ${
                      activeOutputDeviceId === dev.deviceId
                        ? 'bg-[#1ed760]/15 text-[#1ed760] border border-[#1ed760]/40'
                        : 'surface-card text-[var(--text-secondary)] hover:text-white'
                    }">${escapeHtml(dev.label)}</button>`
                    )
                    .join('')}
                </div>`
              : ''
          }
        </div>

        <div class="py-2 border-b border-[var(--border-subtle)] space-y-0.5">
          <button data-action="open-cover-search" data-book="${escapeHtml(activeBook?.bookKey || '')}" class="btn-press w-full flex items-center justify-between px-2.5 py-2 rounded-xl hover:bg-white/5 text-left text-xs font-medium text-[var(--text-primary)]">
            <span class="truncate">Search Cover Images</span>
          </button>
          <button data-action="auto-match-tags" data-book="${escapeHtml(activeBook?.bookKey || '')}" class="btn-press w-full flex items-center justify-between px-2.5 py-2 rounded-xl hover:bg-white/5 text-left text-xs font-medium text-[var(--text-primary)]">
            <span class="truncate">${enrichingBookKey ? 'Matching...' : 'Auto-Match Tags'}</span>
          </button>
          <button data-action="trigger-local-folder" class="btn-press w-full flex items-center justify-between px-2.5 py-2 rounded-xl hover:bg-white/5 text-left text-xs font-medium text-[var(--text-primary)]">
            <span class="truncate">Add Local Folder</span>
          </button>
          <button data-action="connect-drive" class="btn-press w-full flex items-center justify-between px-2.5 py-2 rounded-xl hover:bg-white/5 text-left text-xs font-medium text-[var(--text-primary)]">
            <span class="truncate">${user.authenticated ? 'Scan Google Drive' : 'Connect Google Drive'}</span>
          </button>
          <button data-action="toggle-theme" class="btn-press w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-xl hover:bg-white/5 text-left text-xs font-medium text-[var(--text-primary)]">
            <span>Theme</span>
            <span class="text-[11px] font-semibold text-[#1ed760] shrink-0">${theme === 'pitch' ? 'Pitch' : 'Midnight'}</span>
          </button>
          <button data-action="check-update" class="btn-press w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-xl hover:bg-white/5 text-left text-xs font-medium text-[var(--text-primary)]">
            <span class="truncate">Update (v${escapeHtml(LOCAL_VERSION)})</span>
            <span class="text-[11px] shrink-0 ${this.state.updateState.updateAvailable ? 'text-[#1ed760] font-semibold' : 'text-[var(--text-muted)]'}">
              ${
                this.state.updateState.checking
                  ? '...'
                  : this.state.updateState.updateAvailable
                    ? `v${escapeHtml(this.state.updateState.latestVersion)}`
                    : this.state.updateState.checked
                      ? 'Latest'
                      : ''
              }
            </span>
          </button>
        </div>

        ${
          user.authenticated
            ? `<div class="pt-2">
                <button data-action="sign-out" class="btn-press w-full py-1.5 rounded-xl surface-card text-xs font-medium text-[var(--text-secondary)] hover:text-white">Sign Out</button>
              </div>`
            : ''
        }
      </div>
    `;
  }

  _renderNotificationShade(book, snap) {
    if (!book) return '';
    const duration = Math.max(1, snap.durationSec || book.totalDurationSec || 1);
    const pos = Math.max(0, Math.min(duration, snap.positionSec || 0));
    const pct = Math.min(100, Math.max(0, (pos / duration) * 100));
    const chapter = book.chapters?.[snap.chapterIndex];

    return `
      <div class="notif-shade rounded-3xl p-4 w-full max-w-[390px] mx-auto space-y-3 overflow-hidden">
        <div class="flex items-center justify-between gap-2 min-w-0">
          <div class="flex items-center gap-2 min-w-0">
            <span class="w-4 h-4 rounded-full bg-[#1ed760] text-[#050506] flex items-center justify-center shrink-0">${ICON_PLAY(9)}</span>
            <span class="text-xs font-medium text-[var(--text-secondary)] truncate">Audiobook Player</span>
          </div>
          <button data-action="cycle-device" class="btn-press inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/10 text-[11px] font-medium text-white shrink-0 max-w-[165px]">
            ${ICON_SPEAKER(12, 'text-[#1ed760] shrink-0')}
            <span class="truncate">${escapeHtml(this.state.activeOutputDevice)}</span>
          </button>
        </div>

        <div class="flex items-center gap-3 min-w-0">
          <button data-action="open-cover-search" data-book="${escapeHtml(book.bookKey)}" class="w-14 h-14 rounded-xl overflow-hidden shrink-0 shadow-lg">
            ${this._renderCoverImg(book)}
          </button>
          <div class="min-w-0 flex-1">
            <div class="text-sm font-semibold text-white truncate">${escapeHtml(book.title)}</div>
            <div class="text-xs text-[var(--text-secondary)] truncate">${escapeHtml(chapter?.title || book.author)}</div>
          </div>
          <button data-action="toggle-play" aria-label="Play or Pause" class="play-fab w-11 h-11 shrink-0">
            ${snap.playing ? ICON_PAUSE(18) : ICON_PLAY(18)}
          </button>
        </div>

        <div class="flex items-center gap-2.5">
          <span data-ab-elapsed class="text-[11px] text-[var(--text-secondary)] tabular-nums shrink-0">${formatClock(pos)}</span>
          <input data-ab-range data-action="seek-range" type="range" min="0" max="${Math.round(duration)}" value="${Math.round(pos)}" style="--range-progress:${pct.toFixed(2)}%" class="ab-range flex-1 min-w-0" />
          <span data-ab-remaining class="text-[11px] text-[var(--text-secondary)] tabular-nums shrink-0">-${formatClock(duration - pos)}</span>
        </div>

        <div class="flex items-center justify-between px-2 pt-0.5">
          <button data-action="skip" data-delta="-15" aria-label="Rewind 15 seconds" class="btn-press p-2 rounded-full text-white/90 hover:bg-white/10">${ICON_SKIP_BACK_15(20)}</button>
          <button data-action="prev-chapter" aria-label="Previous chapter" class="btn-press p-2 rounded-full text-white/90 hover:bg-white/10">${ICON_PREV(18)}</button>
          <button data-action="next-chapter" aria-label="Next chapter" class="btn-press p-2 rounded-full text-white/90 hover:bg-white/10">${ICON_NEXT(18)}</button>
          <button data-action="skip" data-delta="30" aria-label="Forward 30 seconds" class="btn-press p-2 rounded-full text-white/90 hover:bg-white/10">${ICON_SKIP_FORWARD_30(20)}</button>
          <button data-action="bookmark" aria-label="Bookmark" class="btn-press p-2 rounded-full text-[#1ed760] hover:bg-white/10">${ICON_BOOKMARK(18)}</button>
        </div>
      </div>
    `;
  }

  _renderGalaxyWatchView(book, snap) {
    if (!book) return '';
    const duration = Math.max(1, snap.durationSec || book.totalDurationSec || 1);
    const pos = Math.max(0, Math.min(duration, snap.positionSec || 0));
    const pct = Math.min(1, Math.max(0, pos / duration));
    const radius = 128;
    const circumference = 2 * Math.PI * radius;
    const dashOffset = circumference * (1 - pct);
    const accent = safeHexColor(book.accentHex, '#1ed760');
    const secondary = safeHexColor(book.accentSecondaryHex, '#0b1020');

    return `
      <main class="w-full min-h-screen flex flex-col items-center justify-center p-1 sm:p-4 bg-[var(--bg-canvas)]">
        <div class="relative w-[270px] h-[270px] rounded-full overflow-hidden surface-shell shadow-[0_24px_60px_rgba(0,0,0,0.75)] flex flex-col items-center justify-between text-center mx-auto p-5 select-none">
          <!-- Pure radial/linear gradient backdrop (zero text inside backdrop) -->
          <div
            data-testid="watchCoverBackdrop"
            class="watchCoverBackdrop absolute inset-0 pointer-events-none"
            style="background: radial-gradient(circle at 50% 35%, ${accent}38 0%, ${secondary}cc 58%, rgba(6, 9, 17, 0.96) 100%), linear-gradient(160deg, ${accent}24 0%, rgba(6, 9, 17, 0.98) 85%);"
          ></div>

          <!-- Bezel SVG progress ring -->
          <svg class="absolute inset-0 w-[270px] h-[270px] -rotate-90 pointer-events-none" viewBox="0 0 270 270" aria-hidden="true">
            <circle cx="135" cy="135" r="${radius}" fill="none" stroke="rgba(255,255,255,0.10)" stroke-width="5"/>
            <circle data-ab-watch-ring data-circumference="${circumference.toFixed(2)}" cx="135" cy="135" r="${radius}" fill="none" stroke="#1ed760" stroke-width="5" stroke-linecap="round" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${dashOffset.toFixed(2)}"/>
          </svg>

          <!-- Top compact title pill with 24x24px mini cover icon -->
          <div class="relative z-10 mt-2 mx-auto max-w-[196px] flex items-center justify-center gap-2 px-2.5 py-1 rounded-full bg-black/55 backdrop-blur-md border border-white/10 min-w-0">
            <div class="w-6 h-6 rounded-full overflow-hidden shrink-0" style="background: linear-gradient(135deg, ${accent}, ${secondary});">
              ${this._renderCoverImg(book, 'w-full h-full object-cover block')}
            </div>
            <span class="text-xs font-semibold text-white truncate min-w-0">${escapeHtml(book.title)}</span>
          </div>

          <!-- Center transport controls -->
          <div class="relative z-10 flex items-center justify-center gap-4 my-auto mx-auto">
            <button data-action="skip" data-delta="-15" aria-label="Rewind 15 seconds" class="btn-press w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white">
              ${ICON_SKIP_BACK_15(21)}
            </button>
            <button data-action="toggle-play" aria-label="Play or Pause" class="play-fab w-14 h-14">
              ${snap.playing ? ICON_PAUSE(24) : ICON_PLAY(24)}
            </button>
            <button data-action="skip" data-delta="30" aria-label="Forward 30 seconds" class="btn-press w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white">
              ${ICON_SKIP_FORWARD_30(21)}
            </button>
          </div>

          <!-- Bottom speed cycler, clock & 1-tap Bookmark -->
          <div class="relative z-10 mb-1 flex items-center justify-center gap-3 mx-auto">
            <button data-action="cycle-speed" class="btn-press px-3 py-1 rounded-full bg-white/10 hover:bg-white/20 text-xs font-semibold text-white tabular-nums">
              ${formatPlaybackRate(snap.playbackRate)}
            </button>
            <span data-ab-elapsed class="text-[11px] text-[var(--text-secondary)] tabular-nums">${formatClock(pos)}</span>
            <button data-action="bookmark" aria-label="Bookmark" class="btn-press w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-[#1ed760]">
              ${ICON_BOOKMARK(15)}
            </button>
          </div>
        </div>
      </main>
    `;
  }

  _renderAndroidAutoView(book, snap) {
    if (!this.state.androidAutoConnected || !book) return '';
    const duration = Math.max(1, snap.durationSec || book.totalDurationSec || 1);
    const pos = Math.max(0, Math.min(duration, snap.positionSec || 0));
    const pct = Math.min(100, Math.max(0, (pos / duration) * 100));
    const chapter = book.chapters?.[snap.chapterIndex];

    return `
      <main class="min-h-screen flex items-center justify-center p-4 sm:p-8">
        <div class="w-full max-w-3xl surface-panel ambient-surface rounded-3xl p-6 sm:p-8 space-y-6 overflow-hidden shadow-2xl">
          <div class="flex items-center gap-5 min-w-0">
            <div class="w-28 h-28 sm:w-32 sm:h-32 rounded-2xl overflow-hidden shrink-0 shadow-xl">
              ${this._renderCoverImg(book)}
            </div>
            <div class="min-w-0 flex-1 space-y-1.5">
              <h2 class="text-2xl sm:text-3xl font-bold text-white clamp-2 leading-tight">${escapeHtml(book.title)}</h2>
              <div class="text-base text-[var(--text-secondary)] truncate">${escapeHtml(chapter?.title || book.author)}</div>
            </div>
          </div>

          <div class="space-y-2">
            <div class="w-full h-2 rounded-full bg-white/10 overflow-hidden">
              <div data-ab-progress-fill class="h-full bg-[#1ed760] rounded-full" style="width:${pct.toFixed(2)}%"></div>
            </div>
            <div class="flex justify-between text-sm text-[var(--text-secondary)] tabular-nums">
              <span data-ab-elapsed>${formatClock(pos)}</span>
              <span data-ab-remaining>-${formatClock(duration - pos)}</span>
            </div>
          </div>

          <div class="grid grid-cols-4 gap-3 sm:gap-4">
            <button data-action="skip" data-delta="-15" aria-label="Rewind 15 seconds" class="btn-press h-20 rounded-2xl surface-card flex items-center justify-center text-white">
              ${ICON_SKIP_BACK_15(32)}
            </button>
            <button data-action="toggle-play" aria-label="Play or Pause" class="play-fab h-20 rounded-2xl w-full">
              ${snap.playing ? ICON_PAUSE(34) : ICON_PLAY(34)}
            </button>
            <button data-action="skip" data-delta="30" aria-label="Forward 30 seconds" class="btn-press h-20 rounded-2xl surface-card flex items-center justify-center text-white">
              ${ICON_SKIP_FORWARD_30(32)}
            </button>
            <button data-action="bookmark" aria-label="Bookmark" class="btn-press h-20 rounded-2xl surface-card flex items-center justify-center text-[#1ed760]">
              ${ICON_BOOKMARK(30)}
            </button>
          </div>
        </div>
      </main>
    `;
  }

  _renderAndroidMobileView(activeBook, snap) {
    const filtered = this.getFilteredBooks();
    const shadeVisible = this.state.shadeOpen;
    const duration = Math.max(1, snap.durationSec || activeBook?.totalDurationSec || 1);
    const pos = Math.max(0, Math.min(duration, snap.positionSec || 0));
    const pct = Math.min(100, Math.max(0, (pos / duration) * 100));

    const chip = (id, label) => {
      const active = this.state.filterSource === id;
      return `<button data-action="set-filter" data-filter="${id}" class="btn-press px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap ${
        active
          ? 'bg-[#1ed760] text-[#050506]'
          : 'surface-card text-[var(--text-primary)]'
      }">${label}</button>`;
    };

    return `
      <main class="relative w-full h-screen ambient-surface overflow-hidden flex flex-col">
        <!-- Mobile Top Header -->
        <div class="px-4 pt-4 pb-2 flex items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 overflow-x-auto min-w-0">
            ${chip('all', 'All')}
            ${chip('local', 'Local')}
            ${chip('drive', 'Drive')}
            ${chip('downloaded', 'Saved')}
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button data-action="toggle-shade" aria-label="Notification Shade" class="btn-press w-8 h-8 rounded-full surface-card flex items-center justify-center text-[var(--text-secondary)] hover:text-white">
              ${ICON_CHEVRON(shadeVisible ? 'up' : 'down', 15)}
            </button>
            ${this._renderAvatarButton()}
          </div>
        </div>

        ${
          shadeVisible
            ? `<div class="px-3 pb-3 pt-1">${this._renderNotificationShade(activeBook, snap)}</div>`
            : ''
        }

        <!-- Mobile Scrollable Content -->
        <div class="flex-1 overflow-y-auto px-4 pb-24 space-y-6 min-w-0">
          <!-- 2-Column Quick-Resume Grid -->
          <div class="grid grid-cols-2 gap-2.5">
            ${filtered
              .slice(0, 4)
              .map(
                (book) => `
              <button data-action="play-book" data-book="${escapeHtml(book.bookKey)}" class="btn-press surface-card rounded-xl p-1.5 flex items-center gap-2.5 text-left overflow-hidden min-w-0 ${
                  activeBook?.bookKey === book.bookKey ? 'ring-1 ring-[#1ed760]/60' : ''
                }">
                <div class="w-12 h-12 rounded-lg overflow-hidden shrink-0">
                  ${this._renderCoverImg(book)}
                </div>
                <div class="min-w-0 flex-1">
                  <div class="text-xs font-semibold text-[var(--text-primary)] clamp-2 leading-tight">${escapeHtml(book.title)}</div>
                </div>
              </button>`
              )
              .join('')}
          </div>

          <!-- Jump back in (zero subtitle!) -->
          <section class="space-y-3">
            <h2 class="text-lg font-bold tracking-tight text-[var(--text-primary)]">Jump back in</h2>
            <div class="flex gap-3 overflow-x-auto pb-1">
              ${filtered
                .map(
                  (book) => `
                <div class="w-36 shrink-0 surface-card rounded-2xl p-2.5 space-y-2 overflow-hidden min-w-0">
                  <button data-action="play-book" data-book="${escapeHtml(book.bookKey)}" class="w-full aspect-square rounded-xl overflow-hidden block relative group">
                    ${this._renderCoverImg(book)}
                  </button>
                  <div class="min-w-0 space-y-1">
                    <button data-action="play-book" data-book="${escapeHtml(book.bookKey)}" class="text-left text-xs font-semibold text-[var(--text-primary)] clamp-2 leading-snug w-full">${escapeHtml(book.title)}</button>
                    <div class="flex items-center justify-between gap-1 min-w-0">
                      <span class="text-[11px] text-[var(--text-secondary)] truncate min-w-0">${escapeHtml(book.author)}</span>
                      <div class="flex items-center gap-1 shrink-0">${this._renderSourceBadges(book, 12)}</div>
                    </div>
                    <div class="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                      ${this._renderDownloadedIcon(book, 14)}
                      <span data-ab-timeleft data-book-key="${escapeHtml(book.bookKey)}" class="truncate">${formatRemaining(book.totalDurationSec, book.positionSec)}</span>
                    </div>
                  </div>
                </div>`
                )
                .join('')}
            </div>
          </section>

          <!-- Library (zero subtitle!) -->
          <section class="space-y-2.5">
            <h2 class="text-lg font-bold tracking-tight text-[var(--text-primary)]">Library</h2>
            <div class="space-y-2">
              ${filtered
                .map(
                  (book) => `
                <div class="surface-card rounded-2xl p-2.5 flex items-center gap-3 overflow-hidden min-w-0">
                  <button data-action="play-book" data-book="${escapeHtml(book.bookKey)}" class="w-14 h-14 rounded-xl overflow-hidden shrink-0">
                    ${this._renderCoverImg(book)}
                  </button>
                  <button data-action="play-book" data-book="${escapeHtml(book.bookKey)}" class="min-w-0 flex-1 text-left">
                    <div class="text-sm font-semibold text-[var(--text-primary)] truncate">${escapeHtml(book.title)}</div>
                    <div class="text-xs text-[var(--text-secondary)] truncate">${escapeHtml(book.author)}</div>
                    <div class="flex items-center gap-1.5 mt-1 text-[11px] text-[var(--text-muted)]">
                      ${this._renderDownloadedIcon(book, 14)}
                      <span data-ab-timeleft data-book-key="${escapeHtml(book.bookKey)}" class="truncate">${formatRemaining(book.totalDurationSec, book.positionSec)}</span>
                    </div>
                  </button>
                  <div class="flex items-center gap-1.5 shrink-0">
                    ${this._renderSourceBadges(book, 15)}
                  </div>
                </div>`
                )
                .join('')}
            </div>
          </section>
        </div>

        <!-- Floating Mini-Player Bar -->
        ${
          activeBook
            ? `
        <div class="absolute inset-x-3 bottom-3 z-20 rounded-2xl surface-panel border border-white/10 shadow-2xl overflow-hidden backdrop-blur-xl">
          <div class="p-2.5 flex items-center gap-3 min-w-0">
            <button data-action="open-mobile-sheet" class="w-11 h-11 rounded-xl overflow-hidden shrink-0">
              ${this._renderCoverImg(activeBook)}
            </button>
            <button data-action="open-mobile-sheet" class="min-w-0 flex-1 text-left">
              <div class="text-xs font-semibold text-white truncate">${escapeHtml(activeBook.title)}</div>
              <div class="text-[11px] text-[var(--text-secondary)] truncate">${escapeHtml(activeBook.chapters?.[snap.chapterIndex]?.title || activeBook.author)}</div>
            </button>
            <button data-action="bookmark" aria-label="Bookmark" class="btn-press p-2 text-[#1ed760] shrink-0">${ICON_BOOKMARK(17)}</button>
            <button data-action="toggle-play" aria-label="Play or Pause" class="play-fab w-9 h-9 shrink-0">
              ${snap.playing ? ICON_PAUSE(16) : ICON_PLAY(16)}
            </button>
          </div>
          <div class="h-0.5 w-full bg-white/10">
            <div data-ab-progress-fill class="h-full bg-[#1ed760]" style="width:${pct.toFixed(2)}%"></div>
          </div>
        </div>`
            : ''
        }

        ${this.state.mobileSheetOpen ? this._renderMobileFullSheet(activeBook, snap) : ''}
      </main>
    `;
  }

  _renderMobileFullSheet(book, snap) {
    if (!book) return '';
    const duration = Math.max(1, snap.durationSec || book.totalDurationSec || 1);
    const pos = Math.max(0, Math.min(duration, snap.positionSec || 0));
    const pct = Math.min(100, Math.max(0, (pos / duration) * 100));
    const chapter = book.chapters?.[snap.chapterIndex];
    const bookmarks = this.state.bookmarksByBook[book.bookKey] || [];

    return `
      <div class="sheet-modal ambient-surface absolute inset-0 z-30 flex flex-col p-5 overflow-y-auto">
        <div class="flex items-center justify-between gap-2 pb-4">
          <button data-action="close-mobile-sheet" aria-label="Close" class="btn-press p-2 rounded-full hover:bg-white/10 text-white">
            ${ICON_CHEVRON('down', 20)}
          </button>
          <span class="text-xs font-semibold text-[var(--text-secondary)] truncate">${escapeHtml(book.series || book.author)}</span>
          <button data-action="open-cover-search" data-book="${escapeHtml(book.bookKey)}" aria-label="Search Cover" class="btn-press p-2 rounded-full hover:bg-white/10 text-white">
            ${ICON_COVER_IMAGE(18)}
          </button>
        </div>

        <button data-action="open-cover-search" data-book="${escapeHtml(book.bookKey)}" class="w-full max-w-[270px] aspect-square mx-auto rounded-2xl overflow-hidden shadow-2xl shrink-0">
          ${this._renderCoverImg(book)}
        </button>

        <div class="mt-6 flex items-start justify-between gap-3 min-w-0">
          <div class="min-w-0 flex-1">
            <h3 class="text-xl font-bold text-white clamp-2 leading-tight">${escapeHtml(book.title)}</h3>
            <p class="text-sm text-[var(--text-secondary)] truncate mt-0.5">${escapeHtml(book.author)}${book.narrator ? ` • ${escapeHtml(book.narrator)}` : ''}</p>
            <p class="text-xs text-[#1ed760] truncate mt-1">${escapeHtml(chapter?.title || '')}</p>
          </div>
          <button data-action="toggle-download" data-book="${escapeHtml(book.bookKey)}" aria-label="Download" class="btn-press p-2 rounded-full hover:bg-white/10 shrink-0 ${book.offlineCached ? 'text-[#1ed760]' : 'text-[var(--text-secondary)]'}">
            ${book.offlineCached ? ICON_DOWNLOADED(20) : ICON_DOWNLOAD_CIRCLE(20)}
          </button>
        </div>

        <div class="mt-5 space-y-1.5">
          <input data-ab-range data-action="seek-range" type="range" min="0" max="${Math.round(duration)}" value="${Math.round(pos)}" style="--range-progress:${pct.toFixed(2)}%" class="ab-range w-full" />
          <div class="flex justify-between text-xs text-[var(--text-secondary)] tabular-nums">
            <span data-ab-elapsed>${formatClock(pos)}</span>
            <span data-ab-remaining>-${formatClock(duration - pos)}</span>
          </div>
        </div>

        <div class="mt-5 flex items-center justify-between px-2">
          <button data-action="skip" data-delta="-15" aria-label="Rewind 15 seconds" class="btn-press p-2.5 text-white">${ICON_SKIP_BACK_15(26)}</button>
          <button data-action="prev-chapter" aria-label="Previous chapter" class="btn-press p-2.5 text-white">${ICON_PREV(22)}</button>
          <button data-action="toggle-play" aria-label="Play or Pause" class="play-fab w-16 h-16">${snap.playing ? ICON_PAUSE(26) : ICON_PLAY(26)}</button>
          <button data-action="next-chapter" aria-label="Next chapter" class="btn-press p-2.5 text-white">${ICON_NEXT(22)}</button>
          <button data-action="skip" data-delta="30" aria-label="Forward 30 seconds" class="btn-press p-2.5 text-white">${ICON_SKIP_FORWARD_30(26)}</button>
        </div>

        <div class="mt-6 flex items-center justify-between gap-2 pt-3 border-t border-[var(--border-subtle)]">
          <button data-action="cycle-speed" class="btn-press px-3 py-1.5 rounded-full surface-card text-xs font-semibold text-white tabular-nums">${formatPlaybackRate(snap.playbackRate)}</button>
          <button data-action="cycle-sleep" class="btn-press inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full surface-card text-xs font-medium text-[var(--text-secondary)]">
            ${ICON_SLEEP(14)}
            <span>${snap.sleepTimerMode ? (snap.sleepTimerMode === 'chapter' ? 'Ch' : `${snap.sleepTimerMode}m`) : 'Sleep'}</span>
          </button>
          <button data-action="bookmark" aria-label="Bookmark" class="btn-press p-2 rounded-full surface-card text-[#1ed760]">${ICON_BOOKMARK(18)}</button>
        </div>

        ${
          bookmarks.length > 0
            ? `<div class="mt-5 space-y-2">
                <div class="text-xs font-semibold text-[var(--text-secondary)]">Bookmarks</div>
                ${bookmarks
                  .map(
                    (bm) => `
                  <button data-action="seek-sec" data-sec="${bm.positionSec}" class="btn-press w-full surface-card rounded-xl px-3 py-2 flex items-center justify-between gap-2 text-left min-w-0">
                    <span class="text-xs text-white truncate">${escapeHtml(bm.label || 'Bookmark')}</span>
                    <span class="text-xs text-[#1ed760] tabular-nums shrink-0">${formatClock(bm.positionSec)}</span>
                  </button>`
                  )
                  .join('')}
              </div>`
            : ''
        }
      </div>
    `;
  }

  _renderDesktopView(activeBook, snap) {
    const filtered = this.getFilteredBooks();
    const detailBook = this.getDetailBook();
    const { sidebarCollapsed, rightPanelOpen, desktopView, filterSource, searchQuery } = this.state;
    const duration = Math.max(1, snap.durationSec || activeBook?.totalDurationSec || 1);
    const pos = Math.max(0, Math.min(duration, snap.positionSec || 0));
    const pct = Math.min(100, Math.max(0, (pos / duration) * 100));
    const activeChapter = activeBook?.chapters?.[snap.chapterIndex];
    const activeBookmarks = activeBook ? this.state.bookmarksByBook[activeBook.bookKey] || [] : [];

    return `
      <div class="h-screen flex flex-col overflow-hidden">
        <div class="flex-1 flex gap-2 p-2 min-h-0 overflow-hidden">
          <!-- Left Collapsible Library Sidebar -->
          <aside class="${sidebarCollapsed ? 'w-[72px]' : 'w-64 lg:w-72'} shrink-0 surface-panel rounded-2xl flex flex-col overflow-hidden transition-all duration-300">
            <div class="p-3 space-y-2 border-b border-[var(--border-subtle)]">
              <button data-action="desktop-home" class="btn-press w-full flex items-center gap-3 px-2.5 py-2 rounded-xl text-sm font-semibold ${
                desktopView === 'home' ? 'bg-white/10 text-white' : 'text-[var(--text-secondary)] hover:text-white'
              }">
                ${ICON_HOME(19, 'shrink-0')}
                ${sidebarCollapsed ? '' : '<span class="truncate">Home</span>'}
              </button>
              <div class="flex items-center justify-between gap-1 px-1 pt-1">
                <button data-action="toggle-sidebar" class="btn-press flex items-center gap-2.5 text-sm font-bold text-[var(--text-primary)] min-w-0">
                  ${ICON_LIBRARY(19, 'shrink-0')}
                  ${sidebarCollapsed ? '' : '<span class="truncate">Library</span>'}
                </button>
                ${
                  sidebarCollapsed
                    ? ''
                    : `<button data-action="trigger-local-folder" aria-label="Add Local Folder" title="Add Local Folder" class="btn-press p-1.5 rounded-lg hover:bg-white/10 text-[var(--text-secondary)] hover:text-white shrink-0">
                        ${FLUENT_3D_FOLDER(16)}
                      </button>`
                }
              </div>
              ${
                sidebarCollapsed
                  ? ''
                  : `<div class="flex items-center gap-1 pt-1">
                      ${['all', 'local', 'drive']
                        .map(
                          (f) =>
                            `<button data-action="set-filter" data-filter="${f}" class="btn-press px-2.5 py-1 rounded-full text-[11px] font-medium capitalize ${
                              filterSource === f
                                ? 'bg-[#1ed760] text-[#050506]'
                                : 'surface-card text-[var(--text-secondary)] hover:text-white'
                            }">${f}</button>`
                        )
                        .join('')}
                    </div>`
              }
            </div>

            <div class="flex-1 overflow-y-auto p-2 space-y-1">
              ${filtered
                .map(
                  (book) => `
                <button data-action="open-detail" data-book="${escapeHtml(book.bookKey)}" class="btn-press w-full flex items-center gap-2.5 p-2 rounded-xl text-left overflow-hidden min-w-0 ${
                    activeBook?.bookKey === book.bookKey ? 'bg-white/10' : 'hover:bg-white/5'
                  }">
                  <div class="w-11 h-11 rounded-lg overflow-hidden shrink-0">
                    ${this._renderCoverImg(book)}
                  </div>
                  ${
                    sidebarCollapsed
                      ? ''
                      : `<div class="min-w-0 flex-1">
                          <div class="text-xs font-semibold truncate ${
                            activeBook?.bookKey === book.bookKey ? 'text-[#1ed760]' : 'text-[var(--text-primary)]'
                          }">${escapeHtml(book.title)}</div>
                          <div class="flex items-center gap-1.5 mt-0.5 text-[11px] text-[var(--text-secondary)] min-w-0">
                            ${this._renderDownloadedIcon(book, 13)}
                            <span class="truncate min-w-0">${escapeHtml(book.author)}</span>
                          </div>
                        </div>
                        <div class="flex items-center gap-1 shrink-0">${this._renderSourceBadges(book, 13)}</div>`
                  }
                </button>`
                )
                .join('')}
            </div>
          </aside>

          <!-- Center Main Feed / Book Detail -->
          <section class="flex-1 min-w-0 surface-panel ambient-surface rounded-2xl flex flex-col overflow-hidden">
            <div class="px-5 py-3 flex items-center justify-between gap-3 border-b border-[var(--border-subtle)]">
              <div class="relative flex-1 max-w-md min-w-0">
                <span class="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none">${ICON_SEARCH(15)}</span>
                <input id="desktopSearchInput" data-action="search-input" type="search" value="${escapeHtml(searchQuery)}" placeholder="Search audiobooks, authors..." class="w-full pl-9 pr-3 py-1.5 rounded-full bg-white/5 border border-[var(--border-subtle)] text-xs text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[#1ed760]/60" />
              </div>
              <div class="flex items-center gap-2 shrink-0">
                ${
                  desktopView === 'detail'
                    ? `<button data-action="desktop-home" class="btn-press px-3 py-1.5 rounded-full surface-card text-xs font-medium text-white flex items-center gap-1">${ICON_CHEVRON('left', 14)} Back</button>`
                    : ''
                }
                <button data-action="toggle-right-panel" aria-label="Toggle Now Playing Panel" class="btn-press p-2 rounded-full surface-card ${rightPanelOpen ? 'text-[#1ed760]' : 'text-[var(--text-secondary)]'}">
                  ${ICON_PANEL_RIGHT(16)}
                </button>
                ${this._renderAvatarButton()}
              </div>
            </div>

            <div class="flex-1 overflow-y-auto p-5 space-y-7 min-w-0">
              ${
                desktopView === 'detail' && detailBook
                  ? this._renderDesktopDetail(detailBook)
                  : this._renderDesktopHome(filtered, activeBook)
              }
            </div>
          </section>

          <!-- Right Now Playing & Bookmarks Panel -->
          ${
            rightPanelOpen && activeBook
              ? `
          <aside class="hidden lg:flex w-80 shrink-0 surface-panel rounded-2xl flex-col overflow-hidden">
            <div class="px-4 py-3 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2">
              <span class="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] truncate">Now Playing</span>
              <button data-action="toggle-right-panel" aria-label="Close Panel" class="btn-press p-1 rounded-lg hover:bg-white/10 text-[var(--text-secondary)]">${ICON_CLOSE(15)}</button>
            </div>
            <div class="flex-1 overflow-y-auto p-4 space-y-4 min-w-0">
              <button data-action="open-cover-search" data-book="${escapeHtml(activeBook.bookKey)}" class="w-full aspect-square rounded-2xl overflow-hidden shadow-xl block relative group">
                ${this._renderCoverImg(activeBook)}
                <span class="absolute bottom-2 right-2 px-2.5 py-1 rounded-full bg-black/70 text-[11px] font-medium text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                  ${ICON_COVER_IMAGE(12)} Cover
                </span>
              </button>

              <div class="min-w-0 space-y-1">
                <div class="flex items-start justify-between gap-2 min-w-0">
                  <button data-action="open-detail" data-book="${escapeHtml(activeBook.bookKey)}" class="text-left text-base font-bold text-white clamp-2 leading-snug hover:underline min-w-0 flex-1">${escapeHtml(activeBook.title)}</button>
                  <button data-action="bookmark" aria-label="Bookmark" class="btn-press p-1.5 rounded-full hover:bg-white/10 text-[#1ed760] shrink-0">${ICON_BOOKMARK(17)}</button>
                </div>
                <div class="text-xs text-[var(--text-secondary)] truncate">${escapeHtml(activeBook.author)}${activeBook.narrator ? ` • ${escapeHtml(activeBook.narrator)}` : ''}</div>
                <div class="flex items-center gap-1.5 pt-1 text-[11px] text-[var(--text-muted)]">
                  ${this._renderSourceBadges(activeBook, 14)}
                  ${this._renderDownloadedIcon(activeBook, 14)}
                  <span data-ab-timeleft data-book-key="${escapeHtml(activeBook.bookKey)}" class="truncate">${formatRemaining(activeBook.totalDurationSec, activeBook.positionSec)}</span>
                </div>
              </div>

              <div class="surface-card rounded-xl p-3 space-y-1.5 min-w-0">
                <div class="text-[11px] font-semibold text-[var(--text-secondary)]">Chapter</div>
                <div class="text-xs font-medium text-white truncate">${escapeHtml(activeChapter?.title || 'Chapter 1')}</div>
              </div>

              <div class="space-y-2 min-w-0">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-semibold text-[var(--text-secondary)]">Bookmarks</span>
                  <button data-action="bookmark" class="btn-press text-[11px] font-semibold text-[#1ed760] hover:underline">+ Add</button>
                </div>
                ${
                  activeBookmarks.length === 0
                    ? `<div class="text-xs text-[var(--text-muted)] py-2">No bookmarks yet</div>`
                    : `<div class="space-y-1.5">
                        ${activeBookmarks
                          .map(
                            (bm) => `
                          <button data-action="seek-sec" data-sec="${bm.positionSec}" class="btn-press w-full surface-card rounded-xl px-3 py-2 flex items-center justify-between gap-2 text-left min-w-0">
                            <span class="text-xs text-white truncate">${escapeHtml(bm.label || 'Bookmark')}</span>
                            <span class="text-xs text-[#1ed760] tabular-nums shrink-0">${formatClock(bm.positionSec)}</span>
                          </button>`
                          )
                          .join('')}
                      </div>`
                }
              </div>
            </div>
          </aside>`
              : ''
          }
        </div>

        <!-- Persistent Bottom Transport Bar -->
        ${
          activeBook
            ? `
        <footer class="h-20 shrink-0 px-4 border-t border-[var(--border-subtle)] bg-[var(--bg-canvas)] flex items-center justify-between gap-4">
          <div class="flex items-center gap-3 w-64 lg:w-72 min-w-0">
            <button data-action="open-detail" data-book="${escapeHtml(activeBook.bookKey)}" class="w-12 h-12 rounded-lg overflow-hidden shrink-0">
              ${this._renderCoverImg(activeBook)}
            </button>
            <div class="min-w-0 flex-1">
              <div class="text-xs font-semibold text-white truncate">${escapeHtml(activeBook.title)}</div>
              <div class="text-[11px] text-[var(--text-secondary)] truncate">${escapeHtml(activeBook.author)}</div>
            </div>
            <div class="flex items-center gap-1 shrink-0">${this._renderSourceBadges(activeBook, 14)}</div>
            <button data-action="bookmark" aria-label="Bookmark" class="btn-press p-1.5 rounded-full hover:bg-white/10 text-[#1ed760] shrink-0">${ICON_BOOKMARK(16)}</button>
          </div>

          <div class="flex-1 max-w-xl flex flex-col items-center gap-1.5 min-w-0">
            <div class="flex items-center gap-4">
              <button data-action="skip" data-delta="-15" aria-label="Rewind 15 seconds" class="btn-press p-1.5 text-[var(--text-secondary)] hover:text-white">${ICON_SKIP_BACK_15(19)}</button>
              <button data-action="prev-chapter" aria-label="Previous chapter" class="btn-press p-1.5 text-[var(--text-secondary)] hover:text-white">${ICON_PREV(17)}</button>
              <button data-action="toggle-play" aria-label="Play or Pause" class="play-fab w-9 h-9">${snap.playing ? ICON_PAUSE(16) : ICON_PLAY(16)}</button>
              <button data-action="next-chapter" aria-label="Next chapter" class="btn-press p-1.5 text-[var(--text-secondary)] hover:text-white">${ICON_NEXT(17)}</button>
              <button data-action="skip" data-delta="30" aria-label="Forward 30 seconds" class="btn-press p-1.5 text-[var(--text-secondary)] hover:text-white">${ICON_SKIP_FORWARD_30(19)}</button>
            </div>
            <div class="w-full flex items-center gap-2.5">
              <span data-ab-elapsed class="text-[11px] text-[var(--text-secondary)] tabular-nums shrink-0">${formatClock(pos)}</span>
              <input data-ab-range data-action="seek-range" type="range" min="0" max="${Math.round(duration)}" value="${Math.round(pos)}" style="--range-progress:${pct.toFixed(2)}%" class="ab-range flex-1 min-w-0" />
              <span data-ab-remaining class="text-[11px] text-[var(--text-secondary)] tabular-nums shrink-0">-${formatClock(duration - pos)}</span>
            </div>
          </div>

          <div class="hidden md:flex items-center justify-end gap-2 w-64 shrink-0">
            <button data-action="cycle-speed" class="btn-press px-2.5 py-1 rounded-full surface-card text-xs font-semibold text-white tabular-nums">${formatPlaybackRate(snap.playbackRate)}</button>
            <button data-action="cycle-sleep" class="btn-press inline-flex items-center gap-1 px-2.5 py-1 rounded-full surface-card text-xs text-[var(--text-secondary)] hover:text-white">
              ${ICON_SLEEP(13)}
              <span>${snap.sleepTimerMode ? (snap.sleepTimerMode === 'chapter' ? 'Ch' : `${snap.sleepTimerMode}m`) : 'Sleep'}</span>
            </button>
            <button data-action="cycle-device" class="btn-press inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full surface-card text-xs text-[var(--text-secondary)] hover:text-white max-w-[130px]">
              ${ICON_SPEAKER(13, 'text-[#1ed760] shrink-0')}
              <span class="truncate">${escapeHtml(this.state.activeOutputDevice)}</span>
            </button>
          </div>
        </footer>`
            : ''
        }
      </div>
    `;
  }

  _renderDesktopHome(filtered, activeBook) {
    return `
      <!-- Quick-Resume Grid -->
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        ${filtered
          .slice(0, 6)
          .map(
            (book) => `
          <div class="surface-card rounded-xl flex items-center gap-3 pr-3 overflow-hidden min-w-0 group ${
              activeBook?.bookKey === book.bookKey ? 'ring-1 ring-[#1ed760]/50' : ''
            }">
            <button data-action="open-detail" data-book="${escapeHtml(book.bookKey)}" class="w-16 h-16 shrink-0 overflow-hidden">
              ${this._renderCoverImg(book)}
            </button>
            <button data-action="open-detail" data-book="${escapeHtml(book.bookKey)}" class="min-w-0 flex-1 text-left py-1.5">
              <div class="text-sm font-semibold text-white clamp-2 leading-tight">${escapeHtml(book.title)}</div>
              <div class="flex items-center gap-1.5 mt-1 text-[11px] text-[var(--text-secondary)] min-w-0">
                ${this._renderDownloadedIcon(book, 13)}
                <span class="truncate min-w-0">${escapeHtml(book.author)}</span>
              </div>
            </button>
            <button data-action="play-book" data-book="${escapeHtml(book.bookKey)}" aria-label="Play" class="play-fab w-9 h-9 shrink-0 opacity-90 group-hover:opacity-100">
              ${activeBook?.bookKey === book.bookKey && this.state.snapshot.playing ? ICON_PAUSE(15) : ICON_PLAY(15)}
            </button>
          </div>`
          )
          .join('')}
      </div>

      <!-- Jump back in (zero subtitle!) -->
      <section class="space-y-3">
        <h2 class="text-xl font-bold tracking-tight text-white">Jump back in</h2>
        <div class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-4">
          ${filtered
            .slice(0, 5)
            .map((book) => this._renderDesktopShelfCard(book, activeBook))
            .join('')}
        </div>
      </section>

      <!-- Library (zero subtitle!) -->
      <section class="space-y-3">
        <h2 class="text-xl font-bold tracking-tight text-white">Library</h2>
        <div class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-4">
          ${filtered.map((book) => this._renderDesktopShelfCard(book, activeBook)).join('')}
        </div>
      </section>
    `;
  }

  _renderDesktopShelfCard(book, activeBook) {
    const isPlayingThis = activeBook?.bookKey === book.bookKey && this.state.snapshot.playing;
    return `
      <div class="surface-card rounded-2xl p-3 space-y-2.5 overflow-hidden min-w-0 group">
        <div class="relative aspect-square rounded-xl overflow-hidden">
          <button data-action="open-detail" data-book="${escapeHtml(book.bookKey)}" class="w-full h-full block">
            ${this._renderCoverImg(book)}
          </button>
          <button data-action="play-book" data-book="${escapeHtml(book.bookKey)}" aria-label="Play" class="play-fab w-10 h-10 absolute right-2 bottom-2 opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all">
            ${isPlayingThis ? ICON_PAUSE(17) : ICON_PLAY(17)}
          </button>
        </div>
        <div class="min-w-0 space-y-1">
          <button data-action="open-detail" data-book="${escapeHtml(book.bookKey)}" class="text-left text-sm font-semibold text-white clamp-2 leading-snug w-full hover:underline">
            ${escapeHtml(book.title)}
          </button>
          <div class="flex items-center justify-between gap-1.5 min-w-0">
            <span class="text-xs text-[var(--text-secondary)] truncate min-w-0">${escapeHtml(book.author)}</span>
            <div class="flex items-center gap-1 shrink-0">${this._renderSourceBadges(book, 13)}</div>
          </div>
          <div class="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
            ${this._renderDownloadedIcon(book, 14)}
            <span data-ab-timeleft data-book-key="${escapeHtml(book.bookKey)}" class="truncate">${formatRemaining(book.totalDurationSec, book.positionSec)}</span>
          </div>
        </div>
      </div>
    `;
  }

  _renderDesktopDetail(book) {
    const chapters = book.chapters || [];
    const activeBook = this.getActiveBook();
    const isCurrent = activeBook?.bookKey === book.bookKey;
    const isEnriching = this.state.enrichingBookKey === book.bookKey;

    return `
      <div class="space-y-6 min-w-0">
        <div class="flex flex-col sm:flex-row gap-5 items-start min-w-0">
          <button data-action="open-cover-search" data-book="${escapeHtml(book.bookKey)}" class="w-44 h-44 rounded-2xl overflow-hidden shadow-2xl shrink-0 relative group">
            ${this._renderCoverImg(book)}
            <span class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1.5 text-xs font-semibold text-white">
              ${ICON_COVER_IMAGE(16)} Search Cover
            </span>
          </button>
          <div class="min-w-0 flex-1 space-y-2.5">
            <div class="flex items-center gap-2">${this._renderSourceBadges(book, 16)} ${this._renderDownloadedIcon(book, 14)}</div>
            <h1 class="text-2xl sm:text-3xl font-extrabold text-white clamp-2 leading-tight">${escapeHtml(book.title)}</h1>
            <div class="text-sm text-[var(--text-secondary)] truncate">
              ${escapeHtml(book.author)}${book.narrator ? ` • Narrated by ${escapeHtml(book.narrator)}` : ''}
            </div>
            ${
              book.description
                ? `<p class="text-xs text-[var(--text-secondary)] leading-relaxed line-clamp-3 max-w-2xl">${escapeHtml(book.description)}</p>`
                : ''
            }
            <div class="flex flex-wrap items-center gap-2.5 pt-1">
              <button data-action="play-book" data-book="${escapeHtml(book.bookKey)}" class="btn-press inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#1ed760] text-[#050506] text-xs font-bold">
                ${isCurrent && this.state.snapshot.playing ? ICON_PAUSE(16) : ICON_PLAY(16)}
                <span>${isCurrent && this.state.snapshot.playing ? 'Pause' : 'Play'}</span>
              </button>
              <button data-action="toggle-download" data-book="${escapeHtml(book.bookKey)}" class="btn-press inline-flex items-center gap-1.5 px-4 py-2 rounded-full surface-card text-xs font-semibold text-white">
                ${book.offlineCached ? ICON_DOWNLOADED(14) : ICON_DOWNLOAD_CIRCLE(15)}
                <span>${book.offlineCached ? 'Saved' : 'Download'}</span>
              </button>
              <button data-action="open-cover-search" data-book="${escapeHtml(book.bookKey)}" class="btn-press inline-flex items-center gap-1.5 px-4 py-2 rounded-full surface-card text-xs font-semibold text-white">
                ${ICON_COVER_IMAGE(15)}
                <span>Cover</span>
              </button>
              <button data-action="auto-match-tags" data-book="${escapeHtml(book.bookKey)}" class="btn-press inline-flex items-center gap-1.5 px-4 py-2 rounded-full surface-card text-xs font-semibold text-white">
                ${ICON_SPARKLES(15, 'text-[#60a5fa]')}
                <span>${isEnriching ? 'Matching...' : 'Auto-Match'}</span>
              </button>
            </div>
          </div>
        </div>

        <div class="space-y-2">
          <h3 class="text-sm font-bold text-white">Chapters</h3>
          <div class="space-y-1.5">
            ${chapters
              .map((ch, idx) => {
                const isActiveCh = isCurrent && this.state.snapshot.chapterIndex === idx;
                return `
                  <button data-action="jump-chapter" data-book="${escapeHtml(book.bookKey)}" data-chapter="${idx}" class="btn-press w-full surface-card rounded-xl px-3.5 py-2.5 flex items-center justify-between gap-3 text-left min-w-0 ${
                    isActiveCh ? 'border border-[#1ed760]/50 bg-[#1ed760]/10' : ''
                  }">
                    <div class="flex items-center gap-3 min-w-0">
                      <span class="text-xs font-mono text-[var(--text-muted)] w-5 shrink-0">${idx + 1}</span>
                      <span class="text-xs font-semibold truncate ${isActiveCh ? 'text-[#1ed760]' : 'text-white'}">${escapeHtml(ch.title)}</span>
                    </div>
                    <span class="text-xs text-[var(--text-secondary)] tabular-nums shrink-0">${formatClock(ch.startSec)}</span>
                  </button>`;
              })
              .join('')}
          </div>
        </div>
      </div>
    `;
  }

  _renderCoverSearchModal() {
    const { open, query, loading, results, bookKey } = this.state.coverModal;
    if (!open) return '';

    return `
      <div class="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="sheet-modal w-full max-w-2xl max-h-[85vh] rounded-3xl flex flex-col overflow-hidden">
          <div class="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center justify-between gap-3">
            <h2 class="text-base font-bold text-white truncate">Search Cover Images</h2>
            <button data-action="close-cover-modal" aria-label="Close" class="btn-press p-1.5 rounded-full hover:bg-white/10 text-[var(--text-secondary)] hover:text-white">
              ${ICON_CLOSE(18)}
            </button>
          </div>

          <form id="coverSearchForm" class="px-5 py-3 border-b border-[var(--border-subtle)] flex items-center gap-2">
            <div class="relative flex-1 min-w-0">
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">${ICON_SEARCH(15)}</span>
              <input id="coverSearchInput" type="text" value="${escapeHtml(query)}" placeholder="Book title or author..." class="w-full pl-9 pr-3 py-2 rounded-xl bg-white/5 border border-[var(--border-subtle)] text-sm text-white focus:outline-none focus:border-[#1ed760]/60" />
            </div>
            <button type="submit" class="btn-press px-4 py-2 rounded-xl bg-[#1ed760] text-[#050506] text-xs font-bold shrink-0">Search</button>
            <button type="button" data-action="trigger-local-cover" data-book="${escapeHtml(bookKey || '')}" class="btn-press inline-flex items-center gap-1.5 px-3 py-2 rounded-xl surface-card text-xs font-semibold text-white shrink-0">
              ${ICON_UPLOAD(14)}
              <span>Upload</span>
            </button>
          </form>

          <div class="flex-1 overflow-y-auto p-5">
            ${
              loading
                ? `<div class="grid grid-cols-2 sm:grid-cols-3 gap-4">${Array.from({ length: 6 })
                    .map(() => `<div class="aspect-square rounded-2xl surface-card animate-pulse"></div>`)
                    .join('')}</div>`
                : `<div class="grid grid-cols-2 sm:grid-cols-3 gap-4">
                    ${results
                      .map(
                        (item) => `
                      <button data-action="pick-cover" data-url="${escapeHtml(item.url)}" class="btn-press surface-card rounded-2xl p-2 space-y-2 text-left overflow-hidden min-w-0 hover:ring-2 hover:ring-[#1ed760]">
                        <div class="aspect-square rounded-xl overflow-hidden bg-black/30">
                          <img src="${escapeHtml(item.thumbnailUrl || item.url)}" alt="${escapeHtml(item.title)}" class="w-full h-full object-cover" loading="lazy" />
                        </div>
                        <div class="min-w-0">
                          <div class="text-xs font-semibold text-white truncate">${escapeHtml(item.title)}</div>
                          <div class="text-[11px] text-[var(--text-secondary)] truncate">${escapeHtml(item.source)}</div>
                        </div>
                      </button>`
                      )
                      .join('')}
                  </div>`
            }
          </div>
        </div>
      </div>
    `;
  }

  render() {
    if (!this.rootEl) return;
    const activeBook = this.getActiveBook();
    const snap = this.state.snapshot;
    const layoutMode = this._detectViewportLayout();
    this.state.layoutMode = layoutMode;

    let bodyView = '';
    if (layoutMode === 'watch') {
      bodyView = this._renderGalaxyWatchView(activeBook, snap);
    } else if (layoutMode === 'auto') {
      bodyView = this._renderAndroidAutoView(activeBook, snap);
    } else if (layoutMode === 'android') {
      bodyView = this._renderAndroidMobileView(activeBook, snap);
    } else {
      bodyView = this._renderDesktopView(activeBook, snap);
    }

    this.rootEl.innerHTML = `
      <div class="min-h-screen flex flex-col bg-[var(--bg-canvas)] text-[var(--text-primary)]">
        ${bodyView}
        ${this._renderProfilePopover()}
        ${this._renderCoverSearchModal()}
      </div>
    `;

    if (this.state.profileOpen && typeof document !== 'undefined' && typeof window !== 'undefined') {
      const btn = document.getElementById('profileAvatarBtn');
      const pop = document.getElementById('profilePopover');
      if (btn && pop && typeof btn.getBoundingClientRect === 'function') {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const rightOffset = Math.max(12, window.innerWidth - rect.right);
          const topOffset = Math.min(window.innerHeight - 20, rect.bottom + 8);
          pop.style.right = `${Math.round(rightOffset)}px`;
          pop.style.top = `${Math.round(topOffset)}px`;
        }
      }
    }

    this._bindViewEvents();
  }

  _bindViewEvents() {
    const searchInput = document.getElementById('desktopSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const val = e.target.value;
        const selStart = e.target.selectionStart;
        this.state.searchQuery = val;
        this.render();
        const nextInput = document.getElementById('desktopSearchInput');
        if (nextInput) {
          nextInput.focus();
          try {
            nextInput.setSelectionRange(selStart, selStart);
          } catch {
            // ignore
          }
        }
      });
    }

    const coverForm = document.getElementById('coverSearchForm');
    if (coverForm) {
      coverForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = document.getElementById('coverSearchInput');
        if (input) {
          void this.runCoverSearch(input.value);
        }
      });
    }

    this.rootEl.querySelectorAll('[data-action="seek-range"]').forEach((rangeEl) => {
      rangeEl.addEventListener('input', (e) => {
        const val = Number(e.target.value || 0);
        this.audioEngine.seekToSeconds(val);
      });
    });

    this.rootEl.querySelectorAll('[data-action]').forEach((el) => {
      const action = el.dataset.action;
      if (action === 'seek-range' || action === 'search-input') return;

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        switch (action) {
          case 'toggle-theme': {
            const nextTheme = this.state.theme === 'pitch' ? 'midnight' : 'pitch';
            this._saveTheme(nextTheme);
            this.render();
            break;
          }
          case 'set-theme': {
            const nextTheme = el.dataset.theme === 'pitch' ? 'pitch' : 'midnight';
            this._saveTheme(nextTheme);
            this.render();
            break;
          }
          case 'toggle-profile': {
            this.state.profileOpen = !this.state.profileOpen;
            if (this.state.profileOpen) {
              void this.mediaBridge.refreshAudioOutputs();
            }
            this.render();
            break;
          }
          case 'select-output-device': {
            const deviceId = el.dataset.deviceId;
            if (deviceId) {
              void this.selectOutputDevice(deviceId);
            }
            break;
          }
          case 'cycle-device': {
            this.cycleOutputDevice();
            break;
          }
          case 'toggle-play': {
            void this.audioEngine.togglePlay();
            break;
          }
          case 'skip': {
            this.audioEngine.skipSeconds(Number(el.dataset.delta || 0));
            break;
          }
          case 'prev-chapter': {
            this.prevChapter();
            break;
          }
          case 'next-chapter': {
            this.nextChapter();
            break;
          }
          case 'cycle-speed': {
            this.cycleSpeed();
            break;
          }
          case 'cycle-sleep': {
            this.audioEngine.cycleSleepTimer();
            break;
          }
          case 'bookmark': {
            void this.addBookmark();
            break;
          }
          case 'seek-sec': {
            this.audioEngine.seekToSeconds(Number(el.dataset.sec || 0));
            break;
          }
          case 'play-book': {
            const key = el.dataset.book;
            if (key === this.state.activeBookKey) {
              void this.audioEngine.togglePlay();
            } else {
              void this.selectBook(key, true);
            }
            break;
          }
          case 'open-detail': {
            const key = el.dataset.book;
            this.state.detailBookKey = key;
            this.state.desktopView = 'detail';
            this.render();
            break;
          }
          case 'desktop-home': {
            this.state.desktopView = 'home';
            this.render();
            break;
          }
          case 'jump-chapter': {
            const key = el.dataset.book;
            const chIdx = Number(el.dataset.chapter || 0);
            if (key && key !== this.state.activeBookKey) {
              void this.selectBook(key, true).then(() => {
                this.audioEngine.jumpToChapter(chIdx);
              });
            } else {
              this.audioEngine.jumpToChapter(chIdx);
              if (!this.audioEngine.playing) void this.audioEngine.play();
            }
            break;
          }
          case 'set-filter': {
            this.state.filterSource = el.dataset.filter || 'all';
            this.render();
            break;
          }
          case 'toggle-sidebar': {
            this.state.sidebarCollapsed = !this.state.sidebarCollapsed;
            this.render();
            break;
          }
          case 'toggle-right-panel': {
            this.state.rightPanelOpen = !this.state.rightPanelOpen;
            this.render();
            break;
          }
          case 'toggle-shade': {
            this.state.shadeOpen = !this.state.shadeOpen;
            this.render();
            break;
          }
          case 'open-mobile-sheet': {
            this.state.mobileSheetOpen = true;
            this.render();
            break;
          }
          case 'close-mobile-sheet': {
            this.state.mobileSheetOpen = false;
            this.render();
            break;
          }
          case 'toggle-download': {
            void this.toggleOfflineDownload(el.dataset.book);
            break;
          }
          case 'open-cover-search': {
            void this.openCoverSearchModal(el.dataset.book);
            break;
          }
          case 'close-cover-modal': {
            this.state.coverModal.open = false;
            this.render();
            break;
          }
          case 'pick-cover': {
            const url = el.dataset.url;
            if (url && this.state.coverModal.bookKey) {
              this._applyCoverToBook(this.state.coverModal.bookKey, url);
            }
            break;
          }
          case 'trigger-local-cover': {
            const coverInput = document.getElementById('localCoverInput');
            if (coverInput) coverInput.click();
            break;
          }
          case 'trigger-local-folder': {
            this.state.profileOpen = false;
            const folderInput = document.getElementById('localFolderInput');
            if (folderInput) folderInput.click();
            break;
          }
          case 'connect-drive': {
            void this.handleConnectGoogleDrive();
            break;
          }
          case 'check-update': {
            void this.handleCheckForUpdate();
            break;
          }
          case 'auto-match-tags': {
            void this.handleAutoMatchTags(el.dataset.book);
            break;
          }
          case 'sign-out': {
            void this.syncService.signOut().then(() => {
              this.state.profileOpen = false;
              this.render();
            });
            break;
          }
          default:
            break;
        }
      });
    });
  }
}

if (typeof document !== 'undefined') {
  const mount = () => {
    const root = document.getElementById('appRoot');
    if (!root) return;
    const app = new AudiobookApp(root);
    window.__audiobookApp = app;
    void app.init();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
}

export { AudiobookApp };
