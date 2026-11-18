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
  collectFilesFromDirectoryHandle,
  normalizeBookKey
} from '../services/library-scanner.js';
import * as metadataEnrichment from '../services/metadata-enrichment.js';
import { searchCoverImages, buildCuratedSvgCover } from '../services/cover-search.js';

const {
  enrichBookMetadata,
  parseFilenameMetadata
} = metadataEnrichment;

const isDriveThumbnailOrMissingCover =
  metadataEnrichment.isDriveThumbnailOrMissingCover ||
  ((url) =>
    !url ||
    /googleusercontent\.com|drive\.google\.com\/thumbnail|docs\.google\.com/i.test(String(url)));

const parseSeriesAndOrder =
  metadataEnrichment.parseSeriesAndOrder ||
  ((title = '', author = '', series = '') => ({
    series: String(series || '').trim(),
    seriesOrder: null,
    cleanTitle: String(title || '').trim(),
    cleanAuthor: String(author || '').trim()
  }));

const normalizeBookSeriesAndChapters =
  metadataEnrichment.normalizeBookSeriesAndChapters || ((book) => book);

const needsAutomatedEnrichment =
  metadataEnrichment.needsAutomatedEnrichment ||
  ((book) =>
    Boolean(book) &&
    !book.enrichmentCheckedAt &&
    (isDriveThumbnailOrMissingCover(book.coverUrl) ||
      !book.author ||
      book.author === 'Unknown Author' ||
      book.seriesOrder == null ||
      !book.chapters?.length ||
      (book.chapters.length === 1 && book.chapters[0]?.title === 'Chapter 1')));

const ICON_TRASH = (size = 14, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">
  <polyline points="3 6 5 6 21 6"/>
  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
  <line x1="10" y1="11" x2="10" y2="17"/>
  <line x1="14" y1="11" x2="14" y2="17"/>
</svg>`;

const ICON_LAYERS = (size = 13, cls = '') => `
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">
  <polygon points="12 2 2 7 12 12 22 7 12 2"/>
  <polyline points="2 17 12 22 22 17"/>
  <polyline points="2 12 12 17 22 12"/>
</svg>`;
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
const STORAGE_LIBRARY_KEY = 'audiobook_user_library_v1';
const STORAGE_ACTIVE_BOOK_KEY = 'audiobook_player_active_book_v1';
const STORAGE_LAST_EMAIL_KEY = 'audiobook_player_last_email_v1';

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
      onOfflineChange: (bookKey, cached) => this._handleOfflineChange(bookKey, cached),
      onError: (errMsg) => {
        if (errMsg) this.showError('Playback Error', errMsg);
      }
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

    this.user = null;
    this.guestLocalMode = false;

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
      books: [],
      activeBookKey: null,
      detailBookKey: null,
      authLoading: false,
      authError: '',
      authNotice: '',
      authEmail: this._loadLastEmail(),
      driveModal: {
        open: false,
        folderId:
          typeof globalThis.localStorage !== 'undefined'
            ? globalThis.localStorage.getItem('audiobook_drive_folder_v1') || ''
            : '',
        token: '',
        loading: false,
        error: ''
      },
      coverModal: {
        open: false,
        bookKey: null,
        query: '',
        loading: false,
        results: []
      },
      syncProgress: {
        active: false,
        phase: 'drive',
        percent: 0,
        currentFolder: '',
        scannedFolders: 0,
        discoveredFolders: 0,
        booksFound: 0
      },
      errorModal: {
        open: false,
        title: '',
        message: '',
        showRelogin: false
      },
      showWipeSyncedModal: false,
      wipeClearDriveFolder: false,
      expandedSeries: new Set(),
      groupBySeries: true,
      collapsedChapterSections: new Set(),
      mobileChaptersExpanded: true,
      statusToast: null,
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
      }
    };

    this._lastCheckpointAt = 0;
    this._syncAbortController = null;
    this._isAutoEnriching = false;
    this._pendingReEnrich = false;
    this._seenSeriesKeys = new Set();
    this._sessionEnrichedKeys = new Set();
    this._statusToastTimer = null;

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('error', (event) => {
        const msg = event?.error?.message || event?.message;
        if (msg) this.showError('Unexpected Error', msg);
      });
      window.addEventListener('unhandledrejection', (event) => {
        const reason = event?.reason;
        if (reason?.name === 'AbortError') return;
        const msg = reason?.message || (typeof reason === 'string' ? reason : '');
        if (msg) this.showError('Unexpected Error', msg);
      });
    }
  }

  showStatusToast(message = '', type = 'success') {
    const clean = String(message || '').trim();
    if (!clean) return;
    if (this._statusToastTimer) {
      clearTimeout(this._statusToastTimer);
      this._statusToastTimer = null;
    }
    this.state.statusToast = { message: clean, type };
    this.render();
    if (typeof setTimeout === 'function') {
      this._statusToastTimer = setTimeout(() => {
        this.state.statusToast = null;
        this._statusToastTimer = null;
        this.render();
      }, 4000);
    }
  }

  showError(title = 'Something went wrong', message = '', options = {}) {
    const cleanMsg = String(message || '').trim() || 'An unexpected error occurred.';
    this.state.errorModal = {
      open: true,
      title: String(title || 'Error'),
      message: cleanMsg,
      showRelogin: Boolean(options.showRelogin) || /\b401\b|expired|unauthorized/i.test(cleanMsg)
    };
    this.render();
  }

  cancelActiveSync() {
    if (this._syncAbortController) {
      try {
        this._syncAbortController.abort();
      } catch {
        // ignore
      }
      this._syncAbortController = null;
    }
    this.state.syncProgress.active = false;
    this.state.driveModal.loading = false;
    this.render();
  }

  _updateSyncProgress(progress = {}) {
    const next = {
      active: true,
      phase: progress.phase || this.state.syncProgress.phase || 'drive',
      percent: Math.max(0, Math.min(100, Math.round(Number(progress.percent || 0)))),
      currentFolder: progress.currentFolder || '',
      scannedFolders: Number(progress.scannedFolders ?? progress.processed ?? 0),
      discoveredFolders: Number(progress.discoveredFolders ?? progress.total ?? 0),
      booksFound: Number(progress.booksFound || 0)
    };
    this.state.syncProgress = next;

    if (typeof document !== 'undefined') {
      const bars = document.querySelectorAll('[data-sync-progress-bar]');
      const labels = document.querySelectorAll('[data-sync-progress-label]');
      const pcts = document.querySelectorAll('[data-sync-progress-pct]');
      if (bars.length > 0) {
        bars.forEach((el) => {
          el.style.width = `${next.percent}%`;
        });
        const summary =
          next.discoveredFolders > 0
            ? `${next.scannedFolders}/${next.discoveredFolders}${next.currentFolder ? ` • ${next.currentFolder}` : ''}${next.booksFound > 0 ? ` • ${next.booksFound} books` : ''}`
            : next.currentFolder || 'Scanning...';
        labels.forEach((el) => {
          el.textContent = summary;
        });
        pcts.forEach((el) => {
          el.textContent = `${next.percent}%`;
        });
        return;
      }
    }
    this.render();
  }

  get books() {
    return this.state.books;
  }

  set books(nextBooks) {
    this.state.books = Array.isArray(nextBooks) ? nextBooks : [];
  }

  _isAndroidOrMobileViewport() {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    const isAndroidUa = /Android/i.test(ua);
    const isNarrow = typeof window !== 'undefined' && window.innerWidth < 768;
    return isAndroidUa || isNarrow;
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

  _normalizeBookRecord(book) {
    if (!book || typeof book !== 'object') return book;
    const normalized = normalizeBookSeriesAndChapters(book) || book;
    return {
      ...normalized,
      positionSec: normalized.positionSec ?? normalized.elapsedSec ?? 0
    };
  }

  _loadBooks() {
    try {
      const raw = localStorage.getItem(STORAGE_LIBRARY_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (Array.isArray(saved) && saved.length > 0) {
          return deduplicateLibraryItems(saved).map((b) => this._normalizeBookRecord(b));
        }
      }
    } catch {
      // ignore
    }
    return [];
  }

  _persistBooks() {
    try {
      const serializable = this.books.map((b) => {
        const { localFile, ...rest } = b;
        const total = Number(b.totalDurationSec || 0);
        const elapsedSec = Math.round(Number(b.positionSec || 0));
        const progressPct =
          total > 0 ? Math.min(100, Math.round((elapsedSec / total) * 1000) / 10) : 0;
        return {
          ...rest,
          elapsedSec,
          progressPct,
          bookmarks: this.state.bookmarksByBook[b.bookKey] || b.bookmarks || []
        };
      });
      localStorage.setItem(STORAGE_LIBRARY_KEY, JSON.stringify(serializable));
    } catch {
      // ignore storage quota errors
    }
  }

  async _loadUserLibraryAndSync() {
    const localBooks = this._loadBooks();
    let combined = localBooks;

    if (this.syncService.isAuthenticated()) {
      const remoteBooks = await this.syncService.fetchLibraryItems().catch(() => []);
      if (Array.isArray(remoteBooks) && remoteBooks.length > 0) {
        combined = deduplicateLibraryItems([...localBooks, ...remoteBooks]);
      }
    }

    const progressMap = await this.syncService.fetchAllProgress().catch(() => ({}));
    this.books = combined.map((book) => {
      const normalized = this._normalizeBookRecord(book);
      const localStored = progressMap[normalized.bookKey];
      const merged = localStored ? resolveProgressConflict(normalized, localStored) : normalized;
      return {
        ...normalized,
        positionSec: merged?.positionSec ?? normalized.positionSec ?? 0,
        chapterIndex: merged?.chapterIndex ?? normalized.chapterIndex ?? 0
      };
    });
    if (this.books.length > 0) {
      this._persistBooks();
    }

    for (const book of this.books) {
      this.state.bookmarksByBook[book.bookKey] = await this.syncService
        .fetchBookmarks(book.bookKey)
        .catch(() => book.bookmarks || []);
    }

    if (this.books.length > 0) {
      let savedActiveKey = null;
      try {
        savedActiveKey = localStorage.getItem(STORAGE_ACTIVE_BOOK_KEY);
      } catch {
        // ignore
      }
      const initialBook =
        this.books.find((b) => b.bookKey === savedActiveKey) || this.books[0];
      if (initialBook) {
        await this.selectBook(initialBook.bookKey, false);
      }
      void this._runBackgroundMetadataEnrichment();
    } else {
      this.state.activeBookKey = null;
      this.state.detailBookKey = null;
    }
  }

  async init() {
    this._applyThemeBodyClass(this.state.theme);
    await this.offlineQueue.ready();

    // Handle OAuth callback if returning from Google login
    if (typeof window !== 'undefined' && window.location.hash.includes('access_token=')) {
      const callbackSession = await this.syncService
        .handleAuthCallback(window.location.hash)
        .catch(() => null);
      if (window.history?.replaceState) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      if (!callbackSession) {
        this.state.authError = 'Google sign-in could not be completed.';
      }
    } else {
      await this.syncService.restoreSession().catch(() => null);
    }

    this.user = this.syncService.getUserProfile();

    const token = this.syncService.getGoogleAccessToken();
    if (token) {
      this.audioEngine.setDriveAccessToken(token);
    }

    if (this.user || this.guestLocalMode) {
      await this._loadUserLibraryAndSync();
    } else {
      this.books = [];
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
        const target = this.books.find((b) => b.bookKey === decision.updatedBookKey);
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

    if (this.syncService.isAuthenticated()) {
      this.syncService.connectRealtime();
    }
    await this.mediaBridge.refreshAudioOutputs().catch(() => null);
    this._bindGlobalInputs();
    this.render();
  }

  async _importLocalFiles(fileList) {
    if (!fileList || fileList.length === 0) return;
    const filesArr = Array.from(fileList);
    this._syncAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    this.state.syncProgress = {
      active: true,
      phase: 'local',
      percent: 5,
      currentFolder: 'Scanning local files...',
      scannedFolders: 0,
      discoveredFolders: filesArr.length,
      booksFound: 0
    };
    this.render();

    try {
      const scanned = await scanLocalFiles(filesArr, {
        signal: this._syncAbortController?.signal,
        onProgress: (p) => this._updateSyncProgress(p)
      });

      // Fallback for .wav / generic audio/* files not matched by scanLocalFiles
      const scannedNames = new Set(
        scanned.flatMap((b) => (b.tracks || []).map((t) => t.name)).filter(Boolean)
      );
      const extraAudio = filesArr.filter(
        (f) =>
          f &&
          typeof f.name === 'string' &&
          !scannedNames.has(f.name) &&
          (/\.(wav|aac|opus|m4b|mp3|m4a|ogg|flac)$/i.test(f.name) ||
            (typeof f.type === 'string' && f.type.startsWith('audio/')))
      );

      const extraBooks = extraAudio.map((file) => {
        const meta = parseFilenameMetadata(file.name);
        const title = meta.title || file.name.replace(/\.[^/.]+$/, '');
        const author = meta.author || '';
        const bookKey = normalizeBookKey(title, author);
        const localUrl =
          typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
            ? URL.createObjectURL(file)
            : '';
        return {
          id: bookKey,
          bookKey,
          title,
          author,
          narrator: '',
          series: '',
          description: '',
          totalDurationSec: 0,
          sources: ['local'],
          preferredPlaybackSource: 'local',
          localUrl,
          localFile: file,
          tracks: [{ name: file.name, localUrl, size: file.size || 0 }],
          chapters: [{ index: 0, title: 'Chapter 1', startSec: 0, localUrl }],
          bookmarks: [],
          positionSec: 0,
          progressSec: 0,
          chapterIndex: 0,
          isOffline: true,
          offline: true
        };
      });

      const imported = deduplicateLibraryItems([...scanned, ...extraBooks]).map((b) =>
        this._normalizeBookRecord(b)
      );
      this.state.syncProgress.active = false;
      this._syncAbortController = null;

      if (imported.length === 0) {
        this.showError(
          'No Audiobooks Found',
          'No supported audio files (.m4b, .mp3, .m4a, .ogg, .flac, .wav) were found in the selected folder.'
        );
        return;
      }

      this.books = deduplicateLibraryItems([...this.books, ...imported]).map((b) =>
        this._normalizeBookRecord(b)
      );
      this._persistBooks();
      if (this.syncService.isAuthenticated()) {
        void this.syncService.syncLibraryItems(imported).catch(() => null);
      }
      await this.selectBook(imported[0].bookKey, false);
      this.render();
      void this._runBackgroundMetadataEnrichment();
    } catch (err) {
      this.state.syncProgress.active = false;
      this._syncAbortController = null;
      if (err?.name !== 'AbortError') {
        this.showError('Local Scan Failed', err?.message || 'Unable to scan local audiobooks.');
      } else {
        this.render();
      }
    }
  }

  _bindGlobalInputs() {
    const folderInput = document.getElementById('localFolderInput');
    if (folderInput) {
      folderInput.addEventListener('change', async (e) => {
        const files = e.target?.files;
        if (files && files.length > 0) {
          await this._importLocalFiles(files);
        }
        folderInput.value = '';
      });
    }

    const audioFilesInput = document.getElementById('localAudioFilesInput');
    if (audioFilesInput) {
      audioFilesInput.addEventListener('change', async (e) => {
        const files = e.target?.files;
        if (files && files.length > 0) {
          await this._importLocalFiles(files);
        }
        audioFilesInput.value = '';
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
      this.user = supaProfile;
      return { ...supaProfile, authenticated: true };
    }
    if (this.guestLocalMode) {
      return {
        id: null,
        name: 'Local Mode',
        email: 'Offline library',
        avatarUrl: '',
        authenticated: false
      };
    }
    return null;
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
    const franchiseKey = this._getBookSeriesKey(book);
    if (franchiseKey) {
      this.state.expandedSeries.add(franchiseKey);
    }
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
    void this._enrichSingleBookInBackground(book.bookKey);
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

  _mergeEnrichedBook(existing, enriched) {
    if (!existing) return existing;
    if (!enriched || typeof enriched !== 'object') {
      return this._normalizeBookRecord({
        ...existing,
        enrichmentCheckedAt: existing.enrichmentCheckedAt || new Date().toISOString()
      });
    }
    const existingAuthorPolluted =
      !existing.author ||
      existing.author === 'Unknown Author' ||
      existing.author === existing.series ||
      parseSeriesAndOrder('', existing.author).seriesOrder != null;
    const nextAuthor =
      enriched.author && (existingAuthorPolluted || !existing.author)
        ? enriched.author
        : existing.author || enriched.author || '';

    const nextCoverUrl =
      isDriveThumbnailOrMissingCover(existing.coverUrl) &&
      enriched.coverUrl &&
      !isDriveThumbnailOrMissingCover(enriched.coverUrl)
        ? enriched.coverUrl
        : !isDriveThumbnailOrMissingCover(existing.coverUrl)
          ? existing.coverUrl
          : enriched.coverUrl || existing.coverUrl || '';

    const existingChaptersGeneric =
      !existing.chapters?.length ||
      (existing.chapters.length === 1 && existing.chapters[0]?.title === 'Chapter 1');
    const nextChapters =
      Array.isArray(enriched.chapters) &&
      enriched.chapters.length > 0 &&
      (existingChaptersGeneric ||
        enriched.chapters.length > existing.chapters.length ||
        enriched.chapters.some((c) => c.sectionTitle || c.level > 0))
        ? enriched.chapters
        : existing.chapters;

    return this._normalizeBookRecord({
      ...existing,
      author: nextAuthor,
      narrator: existing.narrator || enriched.narrator || '',
      description: existing.description || enriched.description || '',
      totalDurationSec: existing.totalDurationSec || enriched.totalDurationSec || 0,
      coverUrl: nextCoverUrl,
      series: existing.series || enriched.series || '',
      seriesOrder: existing.seriesOrder ?? enriched.seriesOrder ?? null,
      year: existing.year || enriched.year || null,
      chapters: nextChapters,
      enrichmentCheckedAt: new Date().toISOString()
    });
  }

  async _enrichSingleBookInBackground(bookKey) {
    if (!bookKey || this._sessionEnrichedKeys.has(bookKey)) return;
    const book = this.state.books.find((b) => b.bookKey === bookKey);
    if (!book) return;

    const hasGenericChapters =
      !book.chapters?.length ||
      (book.chapters.length === 1 && book.chapters[0]?.title === 'Chapter 1') ||
      book.chapters.every(
        (ch) => String(ch.title || '').trim().toLowerCase() === String(book.title || '').trim().toLowerCase()
      );
    if (!needsAutomatedEnrichment(book) && !hasGenericChapters) {
      this._sessionEnrichedKeys.add(bookKey);
      return;
    }

    this._sessionEnrichedKeys.add(bookKey);
    try {
      const enriched = await enrichBookMetadata(book);
      const idx = this.state.books.findIndex((b) => b.bookKey === bookKey);
      if (idx < 0) return;
      const updated = this._mergeEnrichedBook(this.state.books[idx], enriched);
      this.state.books[idx] = updated;
      if (this.audioEngine?.currentBook?.bookKey === bookKey) {
        this.audioEngine.currentBook = updated;
      }
      this._persistBooks();
      if (bookKey === this.state.activeBookKey) {
        this._syncMediaSessionMetadata();
      }
      if (this.syncService.isAuthenticated()) {
        void this.syncService.syncLibraryItems([updated]).catch(() => null);
      }
      this.render();
    } catch {
      // non-blocking background enrichment
    }
  }

  async _runBackgroundMetadataEnrichment() {
    if (this._isAutoEnriching) {
      this._pendingReEnrich = true;
      return;
    }
    this._isAutoEnriching = true;
    try {
      const candidates = this.books.filter((b) => needsAutomatedEnrichment(b));
      for (let i = 0; i < candidates.length; i += 2) {
        const batch = candidates.slice(i, i + 2);
        const updatedBatch = [];
        await Promise.all(
          batch.map(async (targetBook) => {
            try {
              this._sessionEnrichedKeys.add(targetBook.bookKey);
              const enriched = await enrichBookMetadata(targetBook);
              const idx = this.state.books.findIndex((b) => b.bookKey === targetBook.bookKey);
              if (idx >= 0) {
                const updated = this._mergeEnrichedBook(this.state.books[idx], enriched);
                this.state.books[idx] = updated;
                updatedBatch.push(updated);
                if (this.audioEngine?.currentBook?.bookKey === updated.bookKey) {
                  this.audioEngine.currentBook = updated;
                }
                if (updated.bookKey === this.state.activeBookKey) {
                  this._syncMediaSessionMetadata();
                }
              }
            } catch {
              // ignore individual book failure
            }
          })
        );
        if (updatedBatch.length > 0) {
          this._persistBooks();
          if (this.syncService.isAuthenticated()) {
            void this.syncService.syncLibraryItems(updatedBatch).catch(() => null);
          }
          this.render();
        }
      }
    } finally {
      this._isAutoEnriching = false;
      if (this._pendingReEnrich) {
        this._pendingReEnrich = false;
        void this._runBackgroundMetadataEnrichment();
      }
    }
  }

  _getDriveSyncedBooksStats() {
    let driveOnlyCount = 0;
    let hybridCount = 0;
    for (const book of this.books) {
      const sources = book?.sources || [];
      if (sources.includes('drive')) {
        if (sources.includes('local')) {
          hybridCount += 1;
        } else {
          driveOnlyCount += 1;
        }
      }
    }
    return {
      driveOnlyCount,
      hybridCount,
      totalDriveCount: driveOnlyCount + hybridCount
    };
  }

  async handleWipeSyncedFiles() {
    const wipedBookKeys = [];
    const updatedHybridBooks = [];
    const nextBooks = [];

    for (const book of this.books) {
      const sources = Array.isArray(book.sources) ? book.sources : [];
      if (!sources.includes('drive')) {
        nextBooks.push(book);
        continue;
      }

      if (!sources.includes('local')) {
        wipedBookKeys.push(book.bookKey);
        if (book.offlineCached || typeof this.audioEngine?.removeOfflineCopy === 'function') {
          await this.audioEngine?.removeOfflineCopy?.(book).catch(() => null);
        }
      } else {
        const strippedChapters = Array.isArray(book.chapters)
          ? book.chapters.map((ch) => {
              const { driveFileId, driveStreamUrl, streamUrl, ...restCh } = ch;
              return restCh;
            })
          : [];
        const strippedBook = {
          ...book,
          sources: sources.filter((s) => s !== 'drive'),
          preferredPlaybackSource: 'local',
          driveFileId: null,
          driveStreamUrl: '',
          streamUrl: '',
          coverDriveFileId: null,
          coverUrl: isDriveThumbnailOrMissingCover(book.coverUrl) ? '' : book.coverUrl,
          chapters: strippedChapters
        };
        updatedHybridBooks.push(strippedBook);
        nextBooks.push(strippedBook);
      }
    }

    const totalWiped = wipedBookKeys.length + updatedHybridBooks.length;
    this.books = nextBooks;

    const activeWasRemoved =
      this.state.activeBookKey && wipedBookKeys.includes(this.state.activeBookKey);
    const detailWasRemoved =
      this.state.detailBookKey && wipedBookKeys.includes(this.state.detailBookKey);

    if (activeWasRemoved) {
      try {
        this.audioEngine?.pause?.();
      } catch {
        // ignore
      }
      try {
        localStorage.removeItem(STORAGE_ACTIVE_BOOK_KEY);
      } catch {
        // ignore
      }
      this.state.activeBookKey = null;
      this.state.mobileSheetOpen = false;
    }

    if (detailWasRemoved) {
      this.state.detailBookKey = null;
      if (this.state.desktopView === 'detail') {
        this.state.desktopView = 'home';
      }
    }

    this._persistBooks();

    const remoteClient =
      typeof this.supabase?.deleteLibraryItems === 'function'
        ? this.supabase
        : this.syncService;

    if (wipedBookKeys.length > 0) {
      try {
        await remoteClient?.deleteLibraryItems?.(wipedBookKeys);
      } catch {
        // ignore remote delete failures
      }
    }
    if (updatedHybridBooks.length > 0) {
      try {
        await remoteClient?.syncLibraryItems?.(updatedHybridBooks);
      } catch {
        // ignore remote sync failures
      }
    }

    if (this.state.wipeClearDriveFolder) {
      try {
        localStorage.removeItem('audiobook_drive_folder_v1');
      } catch {
        // ignore
      }
      this.state.driveModal.folderId = '';
    }

    this.state.showWipeSyncedModal = false;
    this.state.wipeClearDriveFolder = false;
    if (this.state.driveModal.open) {
      this.state.driveModal.open = false;
    }

    if (nextBooks.length > 0 && !this.state.activeBookKey) {
      await this.selectBook(nextBooks[0].bookKey, false);
    } else if (nextBooks.length === 0) {
      if (this.audioEngine) {
        this.audioEngine.currentBook = null;
      }
      this.state.snapshot = {
        ...this.state.snapshot,
        bookKey: null,
        playing: false,
        positionSec: 0,
        durationSec: 0,
        chapterIndex: 0
      };
    }

    this.showStatusToast(
      totalWiped > 0
        ? `Wiped ${totalWiped} synced Drive book${totalWiped === 1 ? '' : 's'}`
        : 'No synced Drive books to wipe'
    );
    this.render();
  }

  _extractSeriesBasePrefix(title = '') {
    const cleaned = String(title || '').replace(/\s*\(\d{4}\)\s*$/i, '').trim();
    const match = cleaned.match(
      /^(.+?)(?:\s*[:–—-]\s+|\s+(?:Act|Book|Part|Vol\.?|Volume|Tome)\s+(?:[IVXLCDM]+|\d+(?:\.\d+)?)\b|\s+#\d+(?:\.\d+)?\b)/i
    );
    if (match && match[1] && match[1].trim().length >= 3) {
      return match[1].trim();
    }
    return cleaned;
  }

  _getBookSeriesKey(book) {
    if (!book) return '';
    const parsed = parseSeriesAndOrder(
      book.title || '',
      book.author || '',
      book.series || '',
      book.parentFolderName || ''
    );
    const name = String(book.series || parsed?.series || '').trim();
    return name ? name.toLowerCase() : '';
  }

  _formatSeriesOrderPill(order) {
    if (order == null || order === '' || !Number.isFinite(Number(order))) return '';
    const num = Number(order);
    return `#${num}`;
  }

  _stripRedundantSeriesPrefix(title = '', seriesName = '') {
    const t = String(title || '').trim();
    const s = String(seriesName || '').trim();
    if (!t || !s) return t;
    const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stripped = t.replace(new RegExp(`^${escaped}\\s*[:–—-]\\s*`, 'i'), '').trim();
    return stripped || t;
  }

  _groupBooksByFranchise(books = []) {
    const normalizedList = books.map((b) => this._normalizeBookRecord(b));

    // Count shared base prefixes across the full library so filtering stays consistent
    const prefixCounts = new Map();
    for (const b of this.books) {
      if (b.series) continue;
      const prefix = this._extractSeriesBasePrefix(b.title);
      const key = prefix.toLowerCase();
      if (key.length >= 3) {
        prefixCounts.set(key, (prefixCounts.get(key) || 0) + 1);
      }
    }

    const entries = [];
    const franchiseMap = new Map();

    for (const book of normalizedList) {
      const parsed = parseSeriesAndOrder(
        book.title || '',
        book.author || '',
        book.series || '',
        book.parentFolderName || ''
      );
      let seriesName = String(book.series || parsed?.series || '').trim();
      let seriesOrder = book.seriesOrder ?? parsed?.seriesOrder ?? null;

      if (!seriesName) {
        const prefix = this._extractSeriesBasePrefix(book.title);
        const prefixKey = prefix.toLowerCase();
        if ((prefixCounts.get(prefixKey) || 0) >= 2) {
          seriesName = prefix;
          if (seriesOrder == null && book.title.replace(/\s*\(\d{4}\)\s*$/i, '').trim().toLowerCase() === prefixKey) {
            seriesOrder = 1;
          }
        }
      }

      if (seriesName) {
        const seriesKey = seriesName.toLowerCase();
        let group = franchiseMap.get(seriesKey);
        if (!group) {
          group = {
            type: 'franchise',
            seriesKey,
            seriesName,
            books: []
          };
          franchiseMap.set(seriesKey, group);
          entries.push(group);
        }
        group.books.push({
          ...book,
          series: seriesName,
          seriesOrder
        });
      } else {
        entries.push({
          type: 'book',
          book
        });
      }
    }

    for (const group of franchiseMap.values()) {
      group.books.sort((a, b) => {
        const oa = a.seriesOrder != null && Number.isFinite(Number(a.seriesOrder)) ? Number(a.seriesOrder) : Infinity;
        const ob = b.seriesOrder != null && Number.isFinite(Number(b.seriesOrder)) ? Number(b.seriesOrder) : Infinity;
        if (oa !== ob) return oa - ob;
        const ya = Number(a.year || 0);
        const yb = Number(b.year || 0);
        if (ya && yb && ya !== yb) return ya - yb;
        return String(a.title || '').localeCompare(String(b.title || ''));
      });

      const authors = group.books
        .map((b) => String(b.author || '').trim())
        .filter((a) => a && a !== 'Unknown Author' && a.toLowerCase() !== group.seriesKey);
      group.authorLabel = authors[0] || '';

      const validCoverBook = group.books.find((b) => !isDriveThumbnailOrMissingCover(b.coverUrl));
      group.coverBook = validCoverBook || {
        bookKey: `series:${group.seriesKey}`,
        title: group.seriesName,
        author: group.authorLabel || `${group.books.length} books`,
        coverUrl: buildCuratedSvgCover(group.seriesName, {
          id: `series:${group.seriesKey}`,
          label: group.authorLabel || `${group.books.length} books`
        })
      };

      const sourceSet = new Set();
      for (const b of group.books) {
        for (const s of b.sources || []) sourceSet.add(s);
      }
      group.sources = Array.from(sourceSet);
      group.containsActive = group.books.some(
        (b) => b.bookKey === this.state.activeBookKey || b.bookKey === this.state.detailBookKey
      );

      if (!this._seenSeriesKeys.has(group.seriesKey)) {
        this._seenSeriesKeys.add(group.seriesKey);
        this.state.expandedSeries.add(group.seriesKey);
      }
    }

    return entries;
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
        const updated = this._mergeEnrichedBook(this.state.books[idx], enriched);
        this.state.books[idx] = updated;
        if (this.audioEngine?.currentBook?.bookKey === updated.bookKey) {
          this.audioEngine.currentBook = updated;
        }
        this._persistBooks();
        this._syncMediaSessionMetadata();
      }
    } finally {
      this.state.enrichingBookKey = null;
      this.render();
    }
  }

  async handleConnectGoogleDrive() {
    const existingToken = this.syncService.getGoogleAccessToken() || '';
    this.state.profileOpen = false;
    this.state.driveModal = {
      open: true,
      folderId: this.state.driveModal?.folderId || '',
      token: existingToken,
      loading: false,
      error: ''
    };
    this.render();
  }

  async runGoogleDriveSync(folderIdInput = '', tokenInput = '') {
    const cleanToken = (tokenInput || this.syncService.getGoogleAccessToken() || '').trim();
    const cleanFolderId = (folderIdInput || '').trim();
    if (!cleanToken) {
      const msg = 'Your Google Drive session is not connected. Click Continue with Google to authorize Drive.';
      this.state.driveModal = {
        ...this.state.driveModal,
        error: msg
      };
      this.showError('Google Sign-In Required', msg, { showRelogin: true });
      return;
    }

    this.syncService.setGoogleAccessToken(cleanToken);
    this.audioEngine.setDriveAccessToken(cleanToken);
    if (typeof globalThis.localStorage !== 'undefined' && cleanFolderId) {
      try {
        globalThis.localStorage.setItem('audiobook_drive_folder_v1', cleanFolderId);
      } catch {
        // ignore storage errors
      }
    }

    this._syncAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    this.state.driveModal = {
      ...this.state.driveModal,
      token: cleanToken,
      folderId: cleanFolderId,
      loading: true,
      error: ''
    };
    this.state.syncProgress = {
      active: true,
      phase: 'drive',
      percent: 5,
      currentFolder: 'Connecting to Google Drive...',
      scannedFolders: 0,
      discoveredFolders: 1,
      booksFound: 0
    };
    this.render();

    try {
      const driveBooks = await scanGoogleDriveFolder(cleanToken, cleanFolderId, undefined, {
        signal: this._syncAbortController?.signal,
        timeoutMs: 15000,
        concurrency: 4,
        onProgress: (p) => this._updateSyncProgress(p)
      });
      this.state.syncProgress.active = false;
      this._syncAbortController = null;

      if (driveBooks.length > 0) {
        const normalizedDriveBooks = driveBooks.map((b) => this._normalizeBookRecord(b));
        this.books = deduplicateLibraryItems([...this.books, ...normalizedDriveBooks]).map((b) =>
          this._normalizeBookRecord(b)
        );
        this._persistBooks();
        if (this.syncService.isAuthenticated()) {
          void this.syncService.syncLibraryItems(normalizedDriveBooks).catch(() => null);
        }
        if (!this.state.activeBookKey) {
          await this.selectBook(normalizedDriveBooks[0].bookKey, false);
        }
        this.state.driveModal.open = false;
        this.state.driveModal.loading = false;
        void this._runBackgroundMetadataEnrichment();
      } else {
        this.state.driveModal.loading = false;
        const emptyMsg = 'No audio files (.m4b, .mp3, .m4a, .ogg, .flac) were found in that Google Drive folder or its subfolders.';
        this.state.driveModal.error = emptyMsg;
        this.showError('No Audiobooks Found', emptyMsg);
      }
    } catch (err) {
      this.state.syncProgress.active = false;
      this.state.driveModal.loading = false;
      this._syncAbortController = null;
      if (err?.name === 'AbortError') {
        this.state.driveModal.error = 'Sync cancelled.';
      } else {
        const errMsg = err?.message || 'Google Drive sync failed.';
        this.state.driveModal.error = errMsg;
        this.showError('Google Drive Sync Error', errMsg, { showRelogin: err?.status === 401 });
      }
    }
    this.render();
  }

  _loadLastEmail() {
    try {
      return localStorage.getItem(STORAGE_LAST_EMAIL_KEY) || '';
    } catch {
      return '';
    }
  }

  _saveLastEmail(email) {
    const clean = String(email || '').trim().toLowerCase();
    this.state.authEmail = clean;
    try {
      if (clean) {
        localStorage.setItem(STORAGE_LAST_EMAIL_KEY, clean);
      }
    } catch {
      // ignore
    }
  }

  async enterLocalMode() {
    this.guestLocalMode = true;
    this.state.authError = '';
    this.state.authNotice = '';
    await this._loadUserLibraryAndSync();
    this.render();
  }

  async handleGmailSignIn(emailInput = '', passwordInput = '') {
    const email = String(emailInput || '').trim().toLowerCase();
    const password = String(passwordInput || '');
    this._saveLastEmail(email);

    this.state.authLoading = true;
    this.state.authError = '';
    this.state.authNotice = '';
    this.render();

    try {
      const result = await this.syncService.signInWithEmail(email, password);
      this.state.authLoading = false;

      if (result?.ok) {
        this.user = this.syncService.getUserProfile();
        this.guestLocalMode = false;
        const token = this.syncService.getGoogleAccessToken();
        if (token) {
          this.audioEngine.setDriveAccessToken(token);
        }
        await this._loadUserLibraryAndSync();
        this.render();
        return;
      }

      if (result?.confirmationRequired) {
        this.state.authNotice =
          result.error ||
          `Confirmation link sent to ${email}. Check Gmail, then click Sign In with Gmail.`;
        this.render();
        return;
      }

      this.state.authError = result?.error || 'Unable to sign in with Gmail.';
      this.render();
    } catch (err) {
      this.state.authLoading = false;
      this.state.authError = err?.message || 'Unable to sign in with Gmail.';
      this.render();
    }
  }

  async handleGoogleOAuth() {
    this.state.profileOpen = false;
    this.state.errorModal.open = false;
    this.state.authError = '';
    this.state.authNotice = '';
    this.state.authLoading = true;
    this.render();

    try {
      const result = await this.syncService.signInWithGoogle({
        autoRedirect: true,
        fallbackToDirectGoogleOAuth: true,
        hint: this.state.authEmail || undefined
      });

      this.state.authLoading = false;

      if (result?.ok && (result.session || this.syncService.getUserProfile())) {
        this.user = this.syncService.getUserProfile();
        this.guestLocalMode = false;
        const token = this.syncService.getGoogleAccessToken();
        if (token) {
          this.audioEngine.setDriveAccessToken(token);
        }
        if (this.state.driveModal.open) {
          this.state.driveModal.token = token || '';
          this.state.driveModal.error = '';
        }
        await this._loadUserLibraryAndSync();
        this.render();
        return;
      }

      if (result?.mode === 'popup' || result?.mode === 'redirect') {
        this.render();
        return;
      }

      const fallbackMsg =
        result?.error || 'Google sign-in popup could not complete. Please try again.';
      if (this.state.driveModal.open) {
        this.state.driveModal.error = fallbackMsg;
      } else {
        this.state.authError = fallbackMsg;
        this.showError('Google Sign-In Error', fallbackMsg);
        return;
      }
      this.render();
    } catch (err) {
      this.state.authLoading = false;
      const msg = err?.message || 'Google sign-in could not start. Please try again.';
      if (this.state.driveModal.open) {
        this.state.driveModal.error = msg;
      } else {
        this.state.authError = msg;
        this.showError('Google Sign-In Error', msg);
        return;
      }
      this.render();
    }
  }

  async handleSignOut() {
    this.audioEngine.pause();
    await this.syncService.signOut();
    this.user = null;
    this.guestLocalMode = false;
    this.books = [];
    this.state.activeBookKey = null;
    this.state.detailBookKey = null;
    this.state.profileOpen = false;
    this.state.driveModal.open = false;
    this.state.coverModal.open = false;
    this.state.desktopView = 'home';
    this.state.authError = '';
    this.state.authNotice = '';
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
    } catch (err) {
      this.state.updateState.checking = false;
      this.showError('Update Check Failed', err?.message || 'Unable to check for updates.');
      return;
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
    const fallbackUrl = buildCuratedSvgCover(book?.title || 'Audiobook', {
      id: book?.bookKey || book?.title || 'audiobook',
      label: book?.author || 'Audiobook'
    });
    const rawUrl = book?.coverUrl || '';
    const src = escapeHtml(isDriveThumbnailOrMissingCover(rawUrl) ? fallbackUrl : rawUrl);
    const safeFallback = escapeHtml(fallbackUrl);
    const alt = escapeHtml(book?.title || 'Audiobook');
    return `<img src="${src}" data-fallback-src="${safeFallback}" onerror="if(!this.dataset.abFb){this.dataset.abFb='1';this.src=this.dataset.fallbackSrc;}" alt="${alt}" class="${classes}" ${extra} />`;
  }

  _renderAvatarButton() {
    const user = this.getUserAccount() || { name: 'Local Mode', email: '', avatarUrl: '' };
    const initials = (user.name || 'L')
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
              ? `<img src="${escapeHtml(user.avatarUrl)}" alt="${escapeHtml(user.name)}" class="w-full h-full object-cover" onerror="this.style.display='none';if(this.nextElementSibling)this.nextElementSibling.style.display='flex';" /><span style="display:none" class="w-full h-full items-center justify-center">${escapeHtml(initials)}</span>`
              : `<span>${escapeHtml(initials)}</span>`
          }
        </button>
      </div>
    `;
  }

  _renderProfilePopover() {
    if (!this.state.profileOpen) return '';
    const user = this.getUserAccount();
    if (!user) return '';
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
                ? `<img src="${escapeHtml(user.avatarUrl)}" alt="${escapeHtml(user.name)}" class="w-full h-full object-cover" onerror="this.style.display='none';if(this.nextElementSibling)this.nextElementSibling.style.display='flex';" /><span style="display:none" class="w-full h-full items-center justify-center">${escapeHtml((user.name || 'L')[0].toUpperCase())}</span>`
                : escapeHtml((user.name || 'L')[0].toUpperCase())
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
          ${
            activeBook
              ? `<button data-action="open-cover-search" data-book="${escapeHtml(activeBook.bookKey)}" class="btn-press w-full flex items-center justify-between px-2.5 py-2 rounded-xl hover:bg-white/5 text-left text-xs font-medium text-[var(--text-primary)]">
                  <span class="truncate">Search Cover Images</span>
                </button>
                <button data-action="auto-match-tags" data-book="${escapeHtml(activeBook.bookKey)}" class="btn-press w-full flex items-center justify-between px-2.5 py-2 rounded-xl hover:bg-white/5 text-left text-xs font-medium text-[var(--text-primary)]">
                  <span class="truncate">${enrichingBookKey ? 'Matching...' : 'Auto-Match Tags'}</span>
                </button>`
              : ''
          }
          <button data-action="trigger-local-folder" class="btn-press w-full flex items-center justify-between px-2.5 py-2 rounded-xl hover:bg-white/5 text-left text-xs font-medium text-[var(--text-primary)]">
            <span class="truncate">${this._isAndroidOrMobileViewport() ? 'Add Local Folder / Files' : 'Add Local Folder'}</span>
          </button>
          <button data-action="trigger-local-files" class="btn-press w-full flex items-center justify-between px-2.5 py-2 rounded-xl hover:bg-white/5 text-left text-xs font-medium text-[var(--text-primary)]">
            <span class="truncate">Add Audio Files</span>
          </button>
          <button data-action="connect-drive" class="btn-press w-full flex items-center justify-between px-2.5 py-2 rounded-xl hover:bg-white/5 text-left text-xs font-medium text-[var(--text-primary)]">
            <span class="truncate">Sync Google Drive</span>
          </button>
          ${
            this._getDriveSyncedBooksStats().totalDriveCount > 0
              ? `<button data-action="open-wipe-synced-modal" class="btn-press w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-xl hover:bg-red-500/10 text-left text-xs font-medium text-red-300">
                  <span class="truncate">Wipe Synced Files</span>
                  ${ICON_TRASH(13, 'shrink-0')}
                </button>`
              : ''
          }
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

        <div class="pt-2 space-y-1.5">
          ${
            user.authenticated
              ? `<button data-action="sign-out" class="btn-press w-full py-1.5 rounded-xl surface-card text-xs font-medium text-[var(--text-secondary)] hover:text-white">Sign Out</button>`
              : `<button data-action="login-google" class="btn-press w-full py-1.5 rounded-xl bg-[#1ed760] text-xs font-bold text-[#050506]">Continue with Google</button>
                 <button data-action="sign-out" class="btn-press w-full py-1.5 rounded-xl surface-card text-xs font-medium text-[var(--text-secondary)] hover:text-white">Return to Login</button>`
          }
        </div>
      </div>
    `;
  }

  _renderLoginView() {
    const { authError, authNotice, authLoading } = this.state;
    return `
      <main class="min-h-screen w-full flex items-center justify-center p-4 sm:p-6 bg-[var(--bg-canvas)]">
        <div class="w-full max-w-sm surface-panel rounded-3xl p-6 sm:p-8 border border-[var(--border-subtle)] shadow-2xl space-y-6 text-center">
          <div class="flex flex-col items-center gap-4">
            <div class="w-16 h-16 rounded-2xl bg-[#1ed760]/15 border border-[#1ed760]/35 flex items-center justify-center text-[#1ed760] shadow-lg">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 18v-6a9 9 0 0 1 18 0v6"/>
                <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/>
                <path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>
              </svg>
            </div>
            <div class="space-y-1">
              <h1 class="text-2xl font-bold tracking-tight text-white">Audiobook Player</h1>
            </div>
          </div>

          ${
            authError
              ? `<div class="rounded-xl bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-300 text-left">${escapeHtml(authError)}</div>`
              : ''
          }
          ${
            authNotice
              ? `<div class="rounded-xl bg-[#1ed760]/10 border border-[#1ed760]/30 px-3 py-2 text-xs text-[#86efac] text-left">${escapeHtml(authNotice)}</div>`
              : ''
          }

          <div class="space-y-3 pt-1">
            <button type="button" data-action="login-google" ${authLoading ? 'disabled' : ''} class="btn-press w-full py-3 px-4 rounded-full bg-[#1ed760] hover:brightness-105 text-[#050506] text-sm font-bold flex items-center justify-center gap-2.5 shadow-lg disabled:opacity-60">
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M21.35 11.1h-9.17v2.73h6.51c-.33 3.81-3.5 5.44-6.5 5.44C8.36 19.27 5 16.25 5 12c0-4.1 3.2-7.27 7.2-7.27c3.09 0 4.9 1.97 4.9 1.97L19 4.72S16.56 2 12.1 2C6.42 2 2.03 6.8 2.03 12c0 5.05 4.13 10 10.22 10c5.35 0 9.25-3.67 9.25-9.09c0-1.15-.15-1.81-.15-1.81Z"/>
              </svg>
              <span>${authLoading ? 'Signing in...' : 'Continue with Google'}</span>
            </button>

            <button type="button" data-action="login-local" class="btn-press w-full py-2.5 px-4 rounded-full bg-white/5 hover:bg-white/10 text-[var(--text-secondary)] hover:text-white text-xs font-semibold">
              Continue with Local Files
            </button>
          </div>
        </div>
      </main>
    `;
  }

  _renderEmptyLibraryCard() {
    return `
      <div class="flex-1 min-h-[360px] flex items-center justify-center p-4">
        <div class="w-full max-w-md surface-card rounded-3xl p-7 text-center space-y-5 border border-[var(--border-subtle)]">
          <div class="w-14 h-14 mx-auto rounded-2xl bg-white/5 border border-[var(--border-subtle)] flex items-center justify-center text-[#1ed760]">
            ${ICON_LIBRARY(26)}
          </div>
          <div class="space-y-1">
            <h2 class="text-lg font-bold text-white">Your library is empty</h2>
            <p class="text-xs text-[var(--text-secondary)]">Import audiobooks from your device or Google Drive.</p>
          </div>
          <div class="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center justify-center gap-2.5 pt-1">
            <button data-action="trigger-local-folder" class="btn-press px-4 py-2.5 rounded-full bg-[#1ed760] text-[#050506] text-xs font-bold">
              ${this._isAndroidOrMobileViewport() ? 'Add Local Folder / Files' : 'Add Local Folder'}
            </button>
            <button data-action="trigger-local-files" class="btn-press px-4 py-2.5 rounded-full surface-panel border border-[var(--border-subtle)] hover:bg-white/10 text-white text-xs font-semibold">
              Add Audio Files
            </button>
            <button data-action="connect-drive" class="btn-press px-4 py-2.5 rounded-full surface-panel border border-[var(--border-subtle)] hover:bg-white/10 text-white text-xs font-semibold">
              Sync Google Drive
            </button>
          </div>
        </div>
      </div>
    `;
  }

  _renderSyncProgressBarHtml() {
    const { active, percent, currentFolder, scannedFolders, discoveredFolders, booksFound } =
      this.state.syncProgress;
    if (!active) return '';
    const summary =
      discoveredFolders > 0
        ? `${scannedFolders}/${discoveredFolders}${currentFolder ? ` • ${currentFolder}` : ''}${booksFound > 0 ? ` • ${booksFound} books` : ''}`
        : currentFolder || 'Scanning...';

    return `
      <div class="rounded-2xl bg-white/5 border border-[var(--border-subtle)] p-3 space-y-2">
        <div class="flex items-center justify-between gap-2 text-[11px]">
          <span data-sync-progress-label class="text-[var(--text-secondary)] truncate min-w-0">${escapeHtml(summary)}</span>
          <span data-sync-progress-pct class="font-mono font-semibold text-[#1ed760] shrink-0">${percent}%</span>
        </div>
        <div class="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div data-sync-progress-bar class="h-full bg-[#1ed760] transition-all duration-200 rounded-full" style="width:${percent}%"></div>
        </div>
      </div>
    `;
  }

  _renderSyncProgressOverlay() {
    if (!this.state.syncProgress.active || this.state.driveModal.open) return '';
    return `
      <div class="fixed bottom-24 right-4 z-[60] w-80 max-w-[calc(100vw-2rem)] surface-panel rounded-2xl p-3.5 border border-[var(--border-subtle)] shadow-2xl space-y-2.5">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-bold text-white truncate">Scanning Library</span>
          <button type="button" data-action="cancel-sync" class="btn-press px-2.5 py-0.5 rounded-full surface-card text-[11px] font-medium text-[var(--text-secondary)] hover:text-white">Cancel</button>
        </div>
        ${this._renderSyncProgressBarHtml()}
      </div>
    `;
  }

  _renderErrorModal() {
    const { open, title, message, showRelogin } = this.state.errorModal;
    if (!open) return '';

    return `
      <div class="fixed inset-0 z-[70] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="sheet-modal w-full max-w-sm rounded-3xl overflow-hidden border border-red-500/30">
          <div class="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center justify-between gap-3">
            <h2 class="text-sm font-bold text-red-300 truncate">${escapeHtml(title || 'Error')}</h2>
            <button type="button" data-action="close-error-modal" aria-label="Close" class="btn-press p-1 rounded-full hover:bg-white/10 text-[var(--text-secondary)] hover:text-white">
              ${ICON_CLOSE(16)}
            </button>
          </div>
          <div class="p-5 space-y-4">
            <p class="text-xs text-[var(--text-primary)] leading-relaxed break-words">${escapeHtml(message)}</p>
            <div class="flex items-center justify-end gap-2">
              ${
                showRelogin
                  ? `<button type="button" data-action="login-google" class="btn-press px-4 py-2 rounded-full bg-[#1ed760] text-[#050506] text-xs font-bold">Continue with Google</button>`
                  : ''
              }
              <button type="button" data-action="close-error-modal" class="btn-press px-4 py-2 rounded-full surface-card text-xs font-semibold text-white">Dismiss</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  _renderDriveSyncModal() {
    const { open, folderId, token, loading, error } = this.state.driveModal;
    if (!open) return '';
    const hasToken = Boolean(token || this.syncService.getGoogleAccessToken());
    const driveStats = this._getDriveSyncedBooksStats();

    return `
      <div class="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="sheet-modal w-full max-w-md rounded-3xl overflow-hidden">
          <div class="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center justify-between gap-3">
            <h2 class="text-base font-bold text-white truncate">Sync Google Drive</h2>
            <button type="button" data-action="close-drive-modal" aria-label="Close" class="btn-press p-1.5 rounded-full hover:bg-white/10 text-[var(--text-secondary)] hover:text-white">
              ${ICON_CLOSE(18)}
            </button>
          </div>

          <form id="driveSyncForm" class="p-5 space-y-4">
            ${
              !hasToken
                ? `<div class="space-y-1.5">
                    <label for="driveTokenInput" class="block text-xs font-medium text-[var(--text-secondary)]">Google OAuth Token</label>
                    <input id="driveTokenInput" type="password" value="${escapeHtml(token)}" placeholder="Paste Google OAuth access token..." class="w-full px-3.5 py-2.5 rounded-xl bg-white/5 border border-[var(--border-subtle)] text-xs text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[#1ed760]/60" />
                  </div>`
                : ''
            }
            <div class="space-y-1.5">
              <label for="driveFolderIdInput" class="block text-xs font-medium text-[var(--text-secondary)]">Google Drive Folder Link or ID</label>
              <input id="driveFolderIdInput" type="text" value="${escapeHtml(folderId)}" placeholder="Paste Drive folder URL or ID (blank scans all Drive)" class="w-full px-3.5 py-2.5 rounded-xl bg-white/5 border border-[var(--border-subtle)] text-xs text-white placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[#1ed760]/60" />
            </div>

            ${loading ? this._renderSyncProgressBarHtml() : ''}

            ${
              error
                ? `<div class="rounded-xl bg-red-500/10 border border-red-500/30 px-3 py-2 text-xs text-red-300">${escapeHtml(error)}</div>`
                : ''
            }

            <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
              ${
                driveStats.totalDriveCount > 0 && !loading
                  ? `<button type="button" data-action="open-wipe-synced-modal" class="btn-press inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-red-500/15 border border-red-500/30 text-xs font-semibold text-red-300 hover:bg-red-500/25 mr-auto">
                      ${ICON_TRASH(13)}
                      <span>Wipe Synced Files</span>
                    </button>`
                  : !hasToken && !loading
                    ? `<button type="button" data-action="login-google" class="btn-press px-4 py-2 rounded-full surface-card text-xs font-semibold text-white mr-auto">Continue with Google</button>`
                    : ''
              }
              ${
                loading
                  ? `<button type="button" data-action="cancel-sync" class="btn-press px-4 py-2 rounded-full surface-card text-xs font-medium text-red-300 hover:text-white">Cancel Sync</button>`
                  : `<button type="button" data-action="close-drive-modal" class="btn-press px-4 py-2 rounded-full surface-card text-xs font-medium text-[var(--text-secondary)] hover:text-white">Cancel</button>
                     <button type="submit" class="btn-press px-5 py-2 rounded-full bg-[#1ed760] text-[#050506] text-xs font-bold">Sync Drive</button>`
              }
            </div>
          </form>
        </div>
      </div>
    `;
  }

  _renderWipeSyncedModal() {
    if (!this.state.showWipeSyncedModal) return '';
    const { driveOnlyCount, hybridCount, totalDriveCount } = this._getDriveSyncedBooksStats();

    return `
      <div class="fixed inset-0 z-[65] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="sheet-modal w-full max-w-md rounded-3xl overflow-hidden border border-red-500/30">
          <div class="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-red-400 shrink-0">${ICON_TRASH(17)}</span>
              <h2 class="text-base font-bold text-white truncate">Wipe Synced Drive Files</h2>
            </div>
            <button type="button" data-action="close-wipe-synced-modal" aria-label="Close" class="btn-press p-1.5 rounded-full hover:bg-white/10 text-[var(--text-secondary)] hover:text-white">
              ${ICON_CLOSE(18)}
            </button>
          </div>
          <div class="p-5 space-y-4">
            <div class="rounded-2xl bg-red-500/10 border border-red-500/25 p-3.5 space-y-1.5">
              <div class="text-xs font-semibold text-red-200">
                ${
                  totalDriveCount > 0
                    ? `${totalDriveCount} Google Drive synced book${totalDriveCount === 1 ? '' : 's'} will be wiped.`
                    : 'No Google Drive synced books found in your library.'
                }
              </div>
              <p class="text-[11px] text-[var(--text-secondary)] leading-relaxed">
                ${
                  driveOnlyCount > 0
                    ? `${driveOnlyCount} Drive-only book${driveOnlyCount === 1 ? '' : 's'} and cached offline Drive audio will be removed.`
                    : ''
                }
                ${
                  hybridCount > 0
                    ? ` ${hybridCount} book${hybridCount === 1 ? '' : 's'} with local files will keep their local audio and drop Google Drive links.`
                    : ''
                }
                Local-only audiobooks will remain untouched.
              </p>
            </div>

            <label class="flex items-start gap-2.5 cursor-pointer select-none px-1">
              <input id="wipeClearDriveFolderCheckbox" data-action="toggle-wipe-clear-folder" type="checkbox" ${this.state.wipeClearDriveFolder ? 'checked' : ''} class="mt-0.5 rounded border-[var(--border-subtle)] bg-white/5 accent-[#1ed760]" />
              <span class="text-xs text-[var(--text-secondary)] leading-snug">Also disconnect and forget saved Google Drive folder ID</span>
            </label>

            <div class="flex items-center justify-end gap-2 pt-1">
              <button type="button" data-action="close-wipe-synced-modal" class="btn-press px-4 py-2 rounded-full surface-card text-xs font-medium text-[var(--text-secondary)] hover:text-white">Cancel</button>
              <button type="button" data-action="confirm-wipe-synced" ${totalDriveCount === 0 ? 'disabled' : ''} class="btn-press px-4 py-2 rounded-full bg-red-500 text-white text-xs font-bold hover:bg-red-400 disabled:opacity-40 disabled:cursor-not-allowed">Wipe Synced Files</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  _renderStatusToast() {
    const toast = this.state.statusToast;
    if (!toast?.message) return '';
    return `
      <div class="fixed bottom-24 left-1/2 -translate-x-1/2 z-[65] max-w-[calc(100vw-2rem)]">
        <div class="surface-panel rounded-full px-4 py-2 border border-[#1ed760]/40 shadow-2xl flex items-center gap-2.5 text-xs font-semibold text-white">
          <span class="w-2 h-2 rounded-full bg-[#1ed760] shrink-0"></span>
          <span class="truncate">${escapeHtml(toast.message)}</span>
          <button type="button" data-action="dismiss-status-toast" aria-label="Dismiss" class="btn-press text-[var(--text-muted)] hover:text-white shrink-0">${ICON_CLOSE(13)}</button>
        </div>
      </div>
    `;
  }

  _renderNotificationShade(book, snap) {
    if (!book) {
      return `
        <div class="notif-shade rounded-3xl p-4 w-full max-w-[390px] mx-auto space-y-3 overflow-hidden">
          <div class="flex items-center justify-between gap-2 min-w-0">
            <div class="flex items-center gap-2 min-w-0">
              <span class="w-4 h-4 rounded-full bg-white/15 text-[var(--text-secondary)] flex items-center justify-center shrink-0">${ICON_PLAY(9)}</span>
              <span class="text-xs font-medium text-[var(--text-secondary)] truncate">Audiobook Player</span>
            </div>
            <button data-action="cycle-device" class="btn-press inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/10 text-[11px] font-medium text-white shrink-0 max-w-[165px]">
              ${ICON_SPEAKER(12, 'text-[#1ed760] shrink-0')}
              <span class="truncate">${escapeHtml(this.state.activeOutputDevice)}</span>
            </button>
          </div>
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-14 h-14 rounded-xl bg-white/5 border border-[var(--border-subtle)] flex items-center justify-center text-[var(--text-muted)] shrink-0">
              ${ICON_LIBRARY(20)}
            </div>
            <div class="min-w-0 flex-1">
              <div class="text-sm font-semibold text-white truncate">No audiobook playing</div>
              <div class="text-xs text-[var(--text-secondary)] truncate">Add audiobooks to listen</div>
            </div>
            <button disabled aria-label="Play or Pause" class="play-fab w-11 h-11 shrink-0 opacity-40 cursor-not-allowed">
              ${ICON_PLAY(18)}
            </button>
          </div>
        </div>
      `;
    }
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
    if (!book) {
      return `
        <main class="w-full min-h-screen flex flex-col items-center justify-center p-1 sm:p-4 bg-[var(--bg-canvas)]">
          <div class="relative w-[270px] h-[270px] rounded-full overflow-hidden surface-shell shadow-[0_24px_60px_rgba(0,0,0,0.75)] flex flex-col items-center justify-between text-center mx-auto p-6 select-none">
            <div data-testid="watchCoverBackdrop" class="watchCoverBackdrop absolute inset-0 pointer-events-none" style="background: radial-gradient(circle at 50% 35%, rgba(30,215,96,0.12) 0%, rgba(11,16,32,0.92) 60%, rgba(6,9,17,0.98) 100%);"></div>
            <div class="relative z-10 mt-3 px-3 py-1 rounded-full bg-black/55 border border-white/10 text-xs font-semibold text-white">Audiobook Player</div>
            <div class="relative z-10 flex flex-col items-center gap-2 my-auto">
              <button disabled aria-label="Play or Pause" class="play-fab w-14 h-14 opacity-40 cursor-not-allowed">${ICON_PLAY(24)}</button>
              <span class="text-xs text-[var(--text-secondary)]">No audiobook playing</span>
            </div>
            <div class="relative z-10 mb-2 text-[11px] text-[var(--text-muted)]">Idle</div>
          </div>
        </main>
      `;
    }
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
    if (!this.state.androidAutoConnected) return '';
    if (!book) {
      return `
        <main class="min-h-screen flex items-center justify-center p-4 sm:p-8">
          <div class="w-full max-w-3xl surface-panel ambient-surface rounded-3xl p-6 sm:p-8 space-y-6 overflow-hidden shadow-2xl text-center">
            <h2 class="text-2xl font-bold text-white">No audiobook playing</h2>
            <p class="text-sm text-[var(--text-secondary)]">Import audiobooks in the player to listen here.</p>
          </div>
        </main>
      `;
    }
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

  _renderDesktopBookRow(book, activeBook, displayTitle = null, orderPill = '', nested = false) {
    const isActive = activeBook?.bookKey === book.bookKey;
    const shownTitle = displayTitle || book.title;
    return `
      <button data-action="open-detail" data-book="${escapeHtml(book.bookKey)}" class="btn-press w-full flex items-center gap-2.5 ${nested ? 'p-1.5 rounded-lg franchise-book-item' : 'p-2 rounded-xl'} text-left overflow-hidden min-w-0 ${
        isActive ? 'bg-white/10' : 'hover:bg-white/5'
      }">
        <div class="${nested ? 'w-9 h-9' : 'w-11 h-11'} rounded-lg overflow-hidden shrink-0">
          ${this._renderCoverImg(book)}
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5 min-w-0">
            ${orderPill ? `<span class="series-order-pill">${escapeHtml(orderPill)}</span>` : ''}
            <span class="text-xs font-semibold truncate ${
              isActive ? 'text-[#1ed760]' : 'text-[var(--text-primary)]'
            }">${escapeHtml(shownTitle)}</span>
          </div>
          <div class="flex items-center gap-1.5 mt-0.5 text-[11px] text-[var(--text-secondary)] min-w-0">
            ${this._renderDownloadedIcon(book, 13)}
            <span class="truncate min-w-0">${escapeHtml(book.author)}</span>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">${this._renderSourceBadges(book, 13)}</div>
      </button>`;
  }

  _renderMobileBookCard(book, activeBook, displayTitle = null, orderPill = '', nested = false) {
    const isActive = activeBook?.bookKey === book.bookKey;
    const shownTitle = displayTitle || book.title;
    return `
      <div class="surface-card ${nested ? 'rounded-xl p-2 franchise-book-item' : 'rounded-2xl p-2.5'} flex items-center gap-3 overflow-hidden min-w-0 ${
        isActive ? 'ring-1 ring-[#1ed760]/50' : ''
      }">
        <button data-action="play-book" data-book="${escapeHtml(book.bookKey)}" class="${nested ? 'w-11 h-11' : 'w-14 h-14'} rounded-xl overflow-hidden shrink-0">
          ${this._renderCoverImg(book)}
        </button>
        <button data-action="play-book" data-book="${escapeHtml(book.bookKey)}" class="min-w-0 flex-1 text-left">
          <div class="flex items-center gap-1.5 min-w-0">
            ${orderPill ? `<span class="series-order-pill">${escapeHtml(orderPill)}</span>` : ''}
            <span class="${nested ? 'text-xs' : 'text-sm'} font-semibold truncate ${isActive ? 'text-[#1ed760]' : 'text-[var(--text-primary)]'}">${escapeHtml(shownTitle)}</span>
          </div>
          <div class="text-xs text-[var(--text-secondary)] truncate mt-0.5">${escapeHtml(book.author)}</div>
          <div class="flex items-center gap-1.5 mt-1 text-[11px] text-[var(--text-muted)]">
            ${this._renderDownloadedIcon(book, 14)}
            <span data-ab-timeleft data-book-key="${escapeHtml(book.bookKey)}" class="truncate">${formatRemaining(book.totalDurationSec, book.positionSec)}</span>
          </div>
        </button>
        <div class="flex items-center gap-1.5 shrink-0">
          ${this._renderSourceBadges(book, 15)}
        </div>
      </div>`;
  }

  _renderGroupedLibraryEntries(filtered, activeBook, variant = 'desktop') {
    if (!this.state.groupBySeries) {
      return filtered
        .map((book) =>
          variant === 'mobile'
            ? this._renderMobileBookCard(book, activeBook)
            : this._renderDesktopBookRow(book, activeBook)
        )
        .join('');
    }

    const entries = this._groupBooksByFranchise(filtered);
    return entries
      .map((entry) => {
        if (entry.type === 'book') {
          return variant === 'mobile'
            ? this._renderMobileBookCard(entry.book, activeBook)
            : this._renderDesktopBookRow(entry.book, activeBook);
        }

        const isExpanded = this.state.expandedSeries.has(entry.seriesKey);
        const countLabel = `${entry.books.length} ${entry.books.length === 1 ? 'book' : 'books'}`;
        const subtitle = entry.authorLabel ? `${entry.authorLabel} · ${countLabel}` : countLabel;
        const sourceBadges = this._renderSourceBadges(
          { sources: entry.sources },
          variant === 'mobile' ? 14 : 13
        );

        const childHtml = isExpanded
          ? `<div class="franchise-book-list space-y-1.5 mt-1.5 mb-2">
              ${entry.books
                .map((book) => {
                  const orderPill = this._formatSeriesOrderPill(book.seriesOrder);
                  const cleanTitle = this._stripRedundantSeriesPrefix(book.title, entry.seriesName);
                  return variant === 'mobile'
                    ? this._renderMobileBookCard(book, activeBook, cleanTitle, orderPill, true)
                    : this._renderDesktopBookRow(book, activeBook, cleanTitle, orderPill, true);
                })
                .join('')}
            </div>`
          : '';

        if (variant === 'mobile') {
          return `
            <div class="space-y-1">
              <button data-action="toggle-series-folder" data-series="${escapeHtml(entry.seriesKey)}" class="franchise-folder-header btn-press w-full surface-card rounded-2xl p-2.5 flex items-center gap-3 text-left overflow-hidden min-w-0 ${
                entry.containsActive ? 'border-[#1ed760]/40' : ''
              }">
                <div class="franchise-cover-stack w-13 h-13 w-[52px] h-[52px] rounded-xl shrink-0">
                  ${this._renderCoverImg(entry.coverBook, 'w-full h-full object-cover rounded-xl')}
                </div>
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-bold text-white truncate">${escapeHtml(entry.seriesName)}</div>
                  <div class="text-xs text-[var(--text-secondary)] truncate mt-0.5">${escapeHtml(subtitle)}</div>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  ${sourceBadges}
                  <span class="text-[var(--text-secondary)]">${ICON_CHEVRON(isExpanded ? 'down' : 'right', 15, 'franchise-chevron')}</span>
                </div>
              </button>
              ${childHtml}
            </div>`;
        }

        return `
          <div class="space-y-0.5">
            <button data-action="toggle-series-folder" data-series="${escapeHtml(entry.seriesKey)}" class="franchise-folder-header btn-press w-full flex items-center gap-2.5 p-2 rounded-xl text-left overflow-hidden min-w-0 border border-transparent ${
              entry.containsActive ? 'bg-white/10 border-[#1ed760]/30' : 'bg-white/[0.03] hover:bg-white/[0.07]'
            }">
              <div class="franchise-cover-stack w-11 h-11 rounded-lg shrink-0">
                ${this._renderCoverImg(entry.coverBook, 'w-full h-full object-cover rounded-lg')}
              </div>
              <div class="min-w-0 flex-1">
                <div class="text-xs font-bold truncate ${entry.containsActive ? 'text-[#1ed760]' : 'text-white'}">${escapeHtml(entry.seriesName)}</div>
                <div class="text-[11px] text-[var(--text-secondary)] truncate mt-0.5">${escapeHtml(subtitle)}</div>
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                ${sourceBadges}
                <span class="text-[var(--text-secondary)]">${ICON_CHEVRON(isExpanded ? 'down' : 'right', 13, 'franchise-chevron')}</span>
              </div>
            </button>
            ${childHtml}
          </div>`;
      })
      .join('');
  }

  _formatChapterTiming(ch, idx) {
    const startSec = Number(ch?.startSec || 0);
    const durationSec = Number(ch?.durationSec || 0);
    if (idx > 0 && startSec <= 0) {
      return durationSec > 0 ? formatClock(durationSec) : `Part ${idx + 1}`;
    }
    if (durationSec > 0) {
      return `${formatClock(startSec)} · ${formatClock(durationSec)}`;
    }
    return formatClock(startSec);
  }

  _renderSingleChapterItem(book, ch, idx, isCurrent, compact = false) {
    const isActiveCh = isCurrent && this.state.snapshot.chapterIndex === idx;
    const isSubLevel = Number(ch?.level || 0) > 0 && !ch?.sectionTitle;
    const timingLabel = this._formatChapterTiming(ch, idx);
    const subchapters = Array.isArray(ch?.subchapters) ? ch.subchapters : [];

    const mainBtn = `
      <button data-action="jump-chapter" data-book="${escapeHtml(book.bookKey)}" data-chapter="${idx}" class="btn-press w-full surface-card rounded-xl ${compact ? 'px-3 py-2' : 'px-3.5 py-2.5'} flex items-center justify-between gap-3 text-left min-w-0 ${
        isSubLevel ? 'ml-4 w-[calc(100%-1rem)]' : ''
      } ${isActiveCh ? 'border border-[#1ed760]/50 bg-[#1ed760]/10' : ''}">
        <div class="flex items-center gap-2.5 min-w-0">
          <span class="text-xs font-mono text-[var(--text-muted)] w-5 shrink-0">${isSubLevel ? '↳' : idx + 1}</span>
          <span class="text-xs font-semibold truncate ${isActiveCh ? 'text-[#1ed760]' : 'text-white'}">${escapeHtml(ch.title || `Chapter ${idx + 1}`)}</span>
        </div>
        <span class="text-[11px] text-[var(--text-secondary)] tabular-nums shrink-0">${escapeHtml(timingLabel)}</span>
      </button>`;

    if (subchapters.length === 0) return mainBtn;

    const subHtml = `
      <div class="chapter-section-group space-y-1 mt-1">
        ${subchapters
          .map((sub, subIdx) => {
            const subStart = Number(sub?.startSec ?? ch?.startSec ?? 0);
            const subDur = Number(sub?.durationSec || 0);
            const subTime = subStart > 0 ? formatClock(subStart) : subDur > 0 ? formatClock(subDur) : `${idx + 1}.${subIdx + 1}`;
            return `
              <button data-action="seek-subchapter" data-book="${escapeHtml(book.bookKey)}" data-chapter="${idx}" data-sec="${subStart}" class="btn-press w-full surface-card rounded-lg px-3 py-1.5 flex items-center justify-between gap-2 text-left min-w-0 opacity-90 hover:opacity-100">
                <div class="flex items-center gap-2 min-w-0">
                  <span class="text-[10px] font-mono text-[var(--text-muted)] shrink-0">${idx + 1}.${subIdx + 1}</span>
                  <span class="text-[11px] font-medium text-[var(--text-primary)] truncate">${escapeHtml(sub?.title || `Part ${subIdx + 1}`)}</span>
                </div>
                <span class="text-[10px] text-[var(--text-secondary)] tabular-nums shrink-0">${escapeHtml(subTime)}</span>
              </button>`;
          })
          .join('')}
      </div>`;

    return `<div class="space-y-1">${mainBtn}${subHtml}</div>`;
  }

  _renderChaptersHierarchy(book, isCurrent, compact = false) {
    const chapters = Array.isArray(book?.chapters) ? book.chapters : [];
    if (chapters.length === 0) {
      return `<div class="text-xs text-[var(--text-muted)] py-2">No chapters available</div>`;
    }

    const groups = [];
    for (let idx = 0; idx < chapters.length; idx++) {
      const ch = chapters[idx];
      const sectionTitle = String(ch?.sectionTitle || '').trim();
      if (sectionTitle) {
        const last = groups[groups.length - 1];
        if (last && last.type === 'section' && last.sectionTitle === sectionTitle) {
          last.items.push({ ch, idx });
        } else {
          groups.push({ type: 'section', sectionTitle, items: [{ ch, idx }] });
        }
      } else {
        groups.push({ type: 'item', ch, idx });
      }
    }

    return groups
      .map((group) => {
        if (group.type === 'item') {
          return this._renderSingleChapterItem(book, group.ch, group.idx, isCurrent, compact);
        }

        const sectionKey = `${book.bookKey}::${group.sectionTitle}`;
        const isCollapsed = this.state.collapsedChapterSections.has(sectionKey);
        const containsActive =
          isCurrent && group.items.some((item) => item.idx === this.state.snapshot.chapterIndex);

        return `
          <div class="space-y-1">
            <button data-action="toggle-chapter-section" data-section-key="${escapeHtml(sectionKey)}" class="btn-press w-full surface-card rounded-xl ${compact ? 'px-3 py-2' : 'px-3.5 py-2.5'} flex items-center justify-between gap-2 text-left min-w-0 ${
              containsActive ? 'border border-[#1ed760]/40 bg-[#1ed760]/5' : ''
            }">
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-[var(--text-secondary)] shrink-0">${ICON_CHEVRON(isCollapsed ? 'right' : 'down', 13)}</span>
                <span class="text-xs font-bold truncate ${containsActive ? 'text-[#1ed760]' : 'text-white'}">${escapeHtml(group.sectionTitle)}</span>
              </div>
              <span class="text-[11px] text-[var(--text-muted)] shrink-0">${group.items.length} ${group.items.length === 1 ? 'part' : 'parts'}</span>
            </button>
            ${
              isCollapsed
                ? ''
                : `<div class="chapter-section-group space-y-1">
                    ${group.items
                      .map((item) =>
                        this._renderSingleChapterItem(book, item.ch, item.idx, isCurrent, compact)
                      )
                      .join('')}
                  </div>`
            }
          </div>`;
      })
      .join('');
  }

  _renderAndroidMobileView(activeBook, snap) {
    const filtered = this.getFilteredBooks();
    const driveCount = this._getDriveSyncedBooksStats().totalDriveCount;
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
            <button data-action="toggle-group-series" title="Group by Series" class="btn-press inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium whitespace-nowrap ${
              this.state.groupBySeries
                ? 'bg-[#1ed760]/20 text-[#1ed760] border border-[#1ed760]/40'
                : 'surface-card text-[var(--text-secondary)]'
            }">
              ${ICON_LAYERS(12)}
              <span>Series</span>
            </button>
            ${
              driveCount > 0
                ? `<button data-action="open-wipe-synced-modal" class="btn-press inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-red-500/15 border border-red-500/30 text-xs font-medium text-red-300 whitespace-nowrap">
                    ${ICON_TRASH(12)}
                    <span>Wipe Synced</span>
                  </button>`
                : ''
            }
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
        <div class="flex-1 overflow-y-auto px-4 pb-24 space-y-6 min-w-0 flex flex-col">
          ${
            this.books.length === 0
              ? this._renderEmptyLibraryCard()
              : filtered.length === 0
                ? `<div class="flex-1 flex flex-col items-center justify-center text-center py-12 space-y-3">
                    <div class="text-sm font-semibold text-white">No matching audiobooks</div>
                    <button data-action="clear-filters" class="btn-press px-4 py-2 rounded-full surface-card text-xs font-medium text-[#1ed760]">Clear filters</button>
                  </div>`
                : `
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

          <!-- Library (Franchise Folders + Books) -->
          <section class="space-y-2.5">
            <div class="flex items-center justify-between gap-2">
              <h2 class="text-lg font-bold tracking-tight text-[var(--text-primary)]">Library</h2>
              ${
                driveCount > 0
                  ? `<button data-action="open-wipe-synced-modal" class="btn-press inline-flex items-center gap-1 px-2.5 py-1 rounded-full surface-card text-[11px] font-medium text-red-300 hover:bg-red-500/15">
                      ${ICON_TRASH(11)}
                      <span>Wipe Synced Files</span>
                    </button>`
                  : ''
              }
            </div>
            <div class="space-y-2">
              ${this._renderGroupedLibraryEntries(filtered, activeBook, 'mobile')}
            </div>
          </section>`
          }
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
            : `
        <div class="absolute inset-x-3 bottom-3 z-20 rounded-2xl surface-panel border border-white/10 shadow-2xl overflow-hidden backdrop-blur-xl">
          <div class="p-2.5 flex items-center gap-3 min-w-0">
            <div class="w-11 h-11 rounded-xl bg-white/5 border border-[var(--border-subtle)] flex items-center justify-center text-[var(--text-muted)] shrink-0">
              ${ICON_LIBRARY(18)}
            </div>
            <div class="min-w-0 flex-1">
              <div class="text-xs font-semibold text-white truncate">No audiobook playing</div>
              <div class="text-[11px] text-[var(--text-secondary)] truncate">Library idle</div>
            </div>
            <button disabled aria-label="Play or Pause" class="play-fab w-9 h-9 shrink-0 opacity-40 cursor-not-allowed">
              ${ICON_PLAY(16)}
            </button>
          </div>
          <div class="h-0.5 w-full bg-white/10"></div>
        </div>`
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
    const chapters = book.chapters || [];
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
          chapters.length > 0
            ? `<div class="mt-5 space-y-2">
                <button data-action="toggle-mobile-chapters" class="w-full flex items-center justify-between text-xs font-semibold text-[var(--text-secondary)]">
                  <span>Chapters (${chapters.length})</span>
                  <span>${ICON_CHEVRON(this.state.mobileChaptersExpanded ? 'down' : 'right', 14)}</span>
                </button>
                ${
                  this.state.mobileChaptersExpanded
                    ? `<div class="space-y-1.5">${this._renderChaptersHierarchy(book, true, true)}</div>`
                    : ''
                }
              </div>`
            : ''
        }

        ${
          bookmarks.length > 0
            ? `<div class="mt-5 space-y-2 pb-4">
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
    const driveCount = this._getDriveSyncedBooksStats().totalDriveCount;
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
                    : `<div class="flex items-center gap-1 shrink-0">
                        ${
                          driveCount > 0
                            ? `<button data-action="open-wipe-synced-modal" aria-label="Wipe Synced Files" title="Wipe Synced Files" class="btn-press inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-[10px] font-semibold text-red-300 shrink-0">
                                ${ICON_TRASH(12)}
                                <span>Wipe</span>
                              </button>`
                            : ''
                        }
                        <button data-action="trigger-local-folder" aria-label="Add Local Folder" title="Add Local Folder" class="btn-press p-1.5 rounded-lg hover:bg-white/10 text-[var(--text-secondary)] hover:text-white shrink-0">
                          ${FLUENT_3D_FOLDER(16)}
                        </button>
                      </div>`
                }
              </div>
              ${
                sidebarCollapsed
                  ? ''
                  : `<div class="flex items-center justify-between gap-1 pt-1">
                      <div class="flex items-center gap-1 min-w-0">
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
                      </div>
                      <button data-action="toggle-group-series" title="Group by Franchise / Series" class="btn-press inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium shrink-0 ${
                        this.state.groupBySeries
                          ? 'bg-[#1ed760]/20 text-[#1ed760] border border-[#1ed760]/40'
                          : 'surface-card text-[var(--text-secondary)] hover:text-white'
                      }">
                        ${ICON_LAYERS(11)}
                        <span>Series</span>
                      </button>
                    </div>`
              }
            </div>

            <div id="book-list" class="flex-1 overflow-y-auto p-2 space-y-1">
              ${
                this.books.length === 0
                  ? sidebarCollapsed
                    ? ''
                    : `<div class="px-2 py-6 text-center space-y-2.5">
                        <div class="text-xs text-[var(--text-muted)]">No audiobooks yet</div>
                        <button data-action="trigger-local-files" class="btn-press w-full py-1.5 px-3 rounded-full surface-card text-[11px] font-semibold text-white hover:bg-white/10">
                          + Add Audio Files
                        </button>
                      </div>`
                  : sidebarCollapsed
                    ? filtered
                        .map(
                          (book) => `
                  <button data-action="open-detail" data-book="${escapeHtml(book.bookKey)}" class="btn-press w-full flex items-center justify-center p-2 rounded-xl overflow-hidden ${
                            activeBook?.bookKey === book.bookKey ? 'bg-white/10' : 'hover:bg-white/5'
                          }">
                    <div class="w-11 h-11 rounded-lg overflow-hidden shrink-0">
                      ${this._renderCoverImg(book)}
                    </div>
                  </button>`
                        )
                        .join('')
                    : this._renderGroupedLibraryEntries(filtered, activeBook, 'desktop')
              }
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

            <div class="flex-1 overflow-y-auto p-5 space-y-7 min-w-0 flex flex-col">
              ${
                desktopView === 'detail' && detailBook
                  ? this._renderDesktopDetail(detailBook)
                  : this._renderDesktopHome(filtered, activeBook)
              }
            </div>
          </section>

          <!-- Right Now Playing & Bookmarks Panel -->
          ${
            rightPanelOpen
              ? activeBook
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
                : `
          <aside class="hidden lg:flex w-80 shrink-0 surface-panel rounded-2xl flex-col overflow-hidden">
            <div class="px-4 py-3 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2">
              <span class="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] truncate">Now Playing</span>
              <button data-action="toggle-right-panel" aria-label="Close Panel" class="btn-press p-1 rounded-lg hover:bg-white/10 text-[var(--text-secondary)]">${ICON_CLOSE(15)}</button>
            </div>
            <div class="flex-1 flex flex-col items-center justify-center p-6 text-center space-y-3">
              <div class="w-24 h-24 rounded-2xl bg-white/5 border border-[var(--border-subtle)] flex items-center justify-center text-[var(--text-muted)]">
                ${ICON_LIBRARY(30)}
              </div>
              <div class="space-y-1">
                <div class="text-sm font-semibold text-white">No audiobook playing</div>
                <div class="text-xs text-[var(--text-secondary)]">Select or import an audiobook to listen.</div>
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
            : `
        <footer class="h-20 shrink-0 px-4 border-t border-[var(--border-subtle)] bg-[var(--bg-canvas)] flex items-center justify-between gap-4">
          <div class="flex items-center gap-3 w-64 lg:w-72 min-w-0">
            <div class="w-12 h-12 rounded-lg bg-white/5 border border-[var(--border-subtle)] flex items-center justify-center text-[var(--text-muted)] shrink-0">
              ${ICON_LIBRARY(18)}
            </div>
            <div class="min-w-0 flex-1">
              <div class="text-xs font-semibold text-white truncate">No audiobook playing</div>
              <div class="text-[11px] text-[var(--text-secondary)] truncate">Library idle</div>
            </div>
          </div>

          <div class="flex-1 max-w-xl flex flex-col items-center gap-1.5 min-w-0">
            <div class="flex items-center gap-4 opacity-40">
              <button disabled aria-label="Rewind 15 seconds" class="p-1.5 text-[var(--text-secondary)] cursor-not-allowed">${ICON_SKIP_BACK_15(19)}</button>
              <button disabled aria-label="Previous chapter" class="p-1.5 text-[var(--text-secondary)] cursor-not-allowed">${ICON_PREV(17)}</button>
              <button disabled aria-label="Play or Pause" class="play-fab w-9 h-9 cursor-not-allowed">${ICON_PLAY(16)}</button>
              <button disabled aria-label="Next chapter" class="p-1.5 text-[var(--text-secondary)] cursor-not-allowed">${ICON_NEXT(17)}</button>
              <button disabled aria-label="Forward 30 seconds" class="p-1.5 text-[var(--text-secondary)] cursor-not-allowed">${ICON_SKIP_FORWARD_30(19)}</button>
            </div>
            <div class="w-full flex items-center gap-2.5 opacity-50">
              <span class="text-[11px] text-[var(--text-secondary)] tabular-nums shrink-0">0:00</span>
              <input disabled type="range" min="0" max="100" value="0" style="--range-progress:0%" class="ab-range flex-1 min-w-0 cursor-not-allowed" />
              <span class="text-[11px] text-[var(--text-secondary)] tabular-nums shrink-0">-0:00</span>
            </div>
          </div>

          <div class="hidden md:flex items-center justify-end gap-2 w-64 shrink-0">
            <button data-action="cycle-speed" class="btn-press px-2.5 py-1 rounded-full surface-card text-xs font-semibold text-white tabular-nums">${formatPlaybackRate(snap.playbackRate)}</button>
            <button data-action="cycle-device" class="btn-press inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full surface-card text-xs text-[var(--text-secondary)] hover:text-white max-w-[130px]">
              ${ICON_SPEAKER(13, 'text-[#1ed760] shrink-0')}
              <span class="truncate">${escapeHtml(this.state.activeOutputDevice)}</span>
            </button>
          </div>
        </footer>`
        }
      </div>
    `;
  }

  _renderDesktopHome(filtered, activeBook) {
    if (this.books.length === 0) {
      return this._renderEmptyLibraryCard();
    }
    if (filtered.length === 0) {
      return `
        <div class="flex-1 min-h-[280px] flex flex-col items-center justify-center text-center space-y-3">
          <div class="text-sm font-semibold text-white">No matching audiobooks</div>
          <button data-action="clear-filters" class="btn-press px-4 py-2 rounded-full surface-card text-xs font-medium text-[#1ed760]">Clear filters</button>
        </div>
      `;
    }
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
            <div class="flex flex-wrap items-center gap-2">
              ${this._renderSourceBadges(book, 16)}
              ${this._renderDownloadedIcon(book, 14)}
              ${
                book.series
                  ? `<span class="series-order-pill">${escapeHtml(book.series)}${book.seriesOrder != null ? ` #${book.seriesOrder}` : ''}</span>`
                  : ''
              }
            </div>
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
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-sm font-bold text-white">Chapters (${chapters.length})</h3>
          </div>
          <div class="space-y-1.5">
            ${this._renderChaptersHierarchy(book, isCurrent, false)}
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

    if (!this.user && !this.guestLocalMode) {
      this.rootEl.innerHTML = `
        <div class="min-h-screen flex flex-col bg-[var(--bg-canvas)] text-[var(--text-primary)]">
          ${this._renderLoginView()}
          ${this._renderWipeSyncedModal()}
          ${this._renderStatusToast()}
          ${this._renderErrorModal()}
        </div>
      `;
      this._bindViewEvents();
      return;
    }

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
        ${this._renderDriveSyncModal()}
        ${this._renderWipeSyncedModal()}
        ${this._renderSyncProgressOverlay()}
        ${this._renderStatusToast()}
        ${this._renderErrorModal()}
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

    const driveSyncForm = document.getElementById('driveSyncForm');
    if (driveSyncForm) {
      driveSyncForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const tokenInput = document.getElementById('driveTokenInput');
        const folderInput = document.getElementById('driveFolderIdInput');
        void this.runGoogleDriveSync(folderInput?.value || '', tokenInput?.value || '');
      });
    }

    const wipeFolderCheckbox = document.getElementById('wipeClearDriveFolderCheckbox');
    if (wipeFolderCheckbox) {
      wipeFolderCheckbox.addEventListener('change', (e) => {
        this.state.wipeClearDriveFolder = Boolean(e.target.checked);
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
      if (
        action === 'seek-range' ||
        action === 'search-input' ||
        action === 'toggle-wipe-clear-folder'
      ) {
        return;
      }

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
            const detailTarget = this.state.books.find((b) => b.bookKey === key);
            const franchiseKey = this._getBookSeriesKey(detailTarget);
            if (franchiseKey) {
              this.state.expandedSeries.add(franchiseKey);
            }
            this.render();
            void this._enrichSingleBookInBackground(key);
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
          case 'seek-subchapter': {
            const key = el.dataset.book;
            const chIdx = Number(el.dataset.chapter || 0);
            const sec = Number(el.dataset.sec || 0);
            const jumpAndSeek = () => {
              this.audioEngine.jumpToChapter(chIdx);
              if (sec > 0) this.audioEngine.seekToSeconds(sec);
              if (!this.audioEngine.playing) void this.audioEngine.play();
            };
            if (key && key !== this.state.activeBookKey) {
              void this.selectBook(key, true).then(jumpAndSeek);
            } else {
              jumpAndSeek();
            }
            break;
          }
          case 'toggle-series-folder': {
            const seriesKey = el.dataset.series;
            if (seriesKey) {
              if (this.state.expandedSeries.has(seriesKey)) {
                this.state.expandedSeries.delete(seriesKey);
              } else {
                this.state.expandedSeries.add(seriesKey);
              }
              this.render();
            }
            break;
          }
          case 'toggle-group-series': {
            this.state.groupBySeries = !this.state.groupBySeries;
            this.render();
            break;
          }
          case 'toggle-chapter-section': {
            const sectionKey = el.dataset.sectionKey;
            if (sectionKey) {
              if (this.state.collapsedChapterSections.has(sectionKey)) {
                this.state.collapsedChapterSections.delete(sectionKey);
              } else {
                this.state.collapsedChapterSections.add(sectionKey);
              }
              this.render();
            }
            break;
          }
          case 'toggle-mobile-chapters': {
            this.state.mobileChaptersExpanded = !this.state.mobileChaptersExpanded;
            this.render();
            break;
          }
          case 'open-wipe-synced-modal': {
            this.state.profileOpen = false;
            this.state.showWipeSyncedModal = true;
            this.render();
            break;
          }
          case 'close-wipe-synced-modal': {
            this.state.showWipeSyncedModal = false;
            this.state.wipeClearDriveFolder = false;
            this.render();
            break;
          }
          case 'confirm-wipe-synced': {
            void this.handleWipeSyncedFiles();
            break;
          }
          case 'dismiss-status-toast': {
            this.state.statusToast = null;
            this.render();
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
            if (!this._isAndroidOrMobileViewport() && typeof window.showDirectoryPicker === 'function') {
              void (async () => {
                try {
                  const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
                  const pickedFiles = await collectFilesFromDirectoryHandle(dirHandle);
                  await this._importLocalFiles(pickedFiles);
                } catch (err) {
                  if (err?.name === 'AbortError') return;
                  const fallbackEl =
                    document.getElementById('localFolderInput') ||
                    document.getElementById('localAudioFilesInput');
                  if (fallbackEl) {
                    fallbackEl.click();
                  } else {
                    this.showError('Folder Picker Error', err?.message || 'Unable to open folder picker.');
                  }
                }
              })();
              break;
            }
            const targetId = this._isAndroidOrMobileViewport()
              ? 'localAudioFilesInput'
              : 'localFolderInput';
            const inputEl =
              document.getElementById(targetId) ||
              document.getElementById('localAudioFilesInput') ||
              document.getElementById('localFolderInput');
            if (inputEl) inputEl.click();
            break;
          }
          case 'trigger-local-files': {
            this.state.profileOpen = false;
            const filesInput = document.getElementById('localAudioFilesInput');
            if (filesInput) filesInput.click();
            break;
          }
          case 'cancel-sync': {
            this.cancelActiveSync();
            break;
          }
          case 'close-error-modal': {
            this.state.errorModal.open = false;
            this.render();
            break;
          }
          case 'login-google': {
            void this.handleGoogleOAuth();
            break;
          }
          case 'login-local': {
            void this.enterLocalMode();
            break;
          }
          case 'clear-filters': {
            this.state.filterSource = 'all';
            this.state.searchQuery = '';
            this.render();
            break;
          }
          case 'close-drive-modal': {
            this.state.driveModal.open = false;
            this.render();
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
            void this.handleSignOut();
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
