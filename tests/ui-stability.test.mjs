import test from 'node:test';
import assert from 'node:assert/strict';
import { AudiobookApp } from '../src/ui/app.js';
import { normalizeBookKey } from '../src/services/library-scanner.js';
import * as metadataEnrichment from '../src/services/metadata-enrichment.js';

const VOID_TAGS = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'circle', 'line', 'polyline', 'polygon', 'path']);

function parseAttributes(attrText = '') {
  const attrs = {};
  const re = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match;
  while ((match = re.exec(attrText)) !== null) {
    const key = match[1];
    const val = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[key] = val;
  }
  return attrs;
}

class MockElement {
  constructor(tagName = 'div') {
    this.tagName = String(tagName || 'div').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this._id = '';
    this._className = '';
    this._textContent = '';
    this._value = '';
    this.disabled = false;
    this.checked = false;
    this.style = {
      setProperty: (k, v) => {
        this.style[k] = v;
      }
    };
    this.classList = {
      add: (...cls) => {
        const set = new Set(this._className.split(/\s+/).filter(Boolean));
        cls.forEach((c) => c && set.add(c));
        this._className = Array.from(set).join(' ');
      },
      remove: (...cls) => {
        const removeSet = new Set(cls);
        this._className = this._className
          .split(/\s+/)
          .filter((c) => c && !removeSet.has(c))
          .join(' ');
      },
      contains: (c) => this._className.split(/\s+/).includes(c)
    };
  }

  get id() {
    return this._id;
  }
  set id(val) {
    this._id = String(val || '');
    this.attributes.id = this._id;
  }

  get className() {
    return this._className;
  }
  set className(val) {
    this._className = String(val || '');
    this.attributes.class = this._className;
  }

  get value() {
    return this._value;
  }
  set value(val) {
    this._value = String(val ?? '');
  }

  get textContent() {
    if (this.children.length === 0) return this._textContent;
    return this._textContent + this.children.map((c) => c.textContent).join('');
  }
  set textContent(val) {
    this.children = [];
    this._textContent = String(val ?? '');
  }

  get innerHTML() {
    return this._rawInnerHtml ?? '';
  }
  set innerHTML(html) {
    const str = String(html ?? '');
    this._rawInnerHtml = str;
    this.children = [];
    this._textContent = '';
    parseHtmlInto(str, this);
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name, val) {
    this.attributes[name] = String(val ?? '');
    if (name === 'id') this._id = this.attributes[name];
    if (name === 'class') this._className = this.attributes[name];
    if (name === 'value') this._value = this.attributes[name];
    if (name === 'disabled') this.disabled = true;
    if (name === 'checked') this.checked = true;
    if (name.startsWith('data-')) {
      const camel = name
        .slice(5)
        .replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      this.dataset[camel] = this.attributes[name];
    }
  }

  contains(target) {
    if (!target) return false;
    if (target === this) return true;
    return this.children.some((c) => c.contains(target));
  }

  addEventListener(type, fn) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }

  click() {
    const evt = {
      type: 'click',
      target: this,
      currentTarget: this,
      stopPropagation() {},
      preventDefault() {}
    };
    for (const fn of this.listeners.click || []) {
      fn(evt);
    }
  }

  focus() {}
  setSelectionRange() {}
  getBoundingClientRect() {
    return { width: 32, height: 32, top: 10, right: 400, bottom: 42, left: 368 };
  }

  _matches(selector) {
    const sel = selector.trim();
    if (!sel) return false;
    const parts = sel.match(/#[a-zA-Z0-9_-]+|\.[a-zA-Z0-9_-]+|\[[^\]]+\]|[a-zA-Z0-9_-]+/g);
    if (!parts || parts.join('') !== sel) return false;
    return parts.every((part) => {
      if (part.startsWith('#')) return this._id === part.slice(1);
      if (part.startsWith('.')) return this.classList.contains(part.slice(1));
      const attrEq = part.match(/^\[([a-zA-Z0-9_-]+)="([^"]*)"\]$/);
      if (attrEq) return this.attributes[attrEq[1]] === attrEq[2];
      const attrHas = part.match(/^\[([a-zA-Z0-9_-]+)\]$/);
      if (attrHas) return Object.prototype.hasOwnProperty.call(this.attributes, attrHas[1]);
      return this.tagName.toLowerCase() === part.toLowerCase();
    });
  }

  querySelectorAll(selector) {
    const results = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child._matches(selector)) results.push(child);
        walk(child);
      }
    };
    walk(this);
    return results;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function parseHtmlInto(html, root) {
  const stack = [root];
  const tokenRe = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9_-]+)\s*>|<([a-zA-Z0-9_-]+)([^>]*?)(\/?)>|([^<]+)/g;
  let match;
  while ((match = tokenRe.exec(html)) !== null) {
    if (match[1]) {
      const closeTag = match[1].toUpperCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === closeTag) {
          stack.length = i;
          break;
        }
      }
    } else if (match[2]) {
      const tag = match[2].toLowerCase();
      const el = new MockElement(tag);
      const attrs = parseAttributes(match[3] || '');
      for (const [k, v] of Object.entries(attrs)) {
        el.setAttribute(k, v);
      }
      stack[stack.length - 1].appendChild(el);
      const selfClosing = Boolean(match[4]) || VOID_TAGS.has(tag);
      if (!selfClosing) {
        stack.push(el);
      }
    } else if (match[5]) {
      const parent = stack[stack.length - 1];
      if (parent) {
        parent._textContent += match[5];
      }
    }
  }
}

function createDomEnv({ innerWidth = 1280 } = {}) {
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevStorage = globalThis.localStorage;

  const store = new Map();
  const rootEl = new MockElement('div');
  rootEl.id = 'appRoot';
  const bodyEl = new MockElement('body');
  bodyEl.appendChild(rootEl);
  const docEl = new MockElement('html');
  docEl.appendChild(bodyEl);

  const docListeners = new Map();
  const winListeners = new Map();
  const addTo = (map, type, fn) => {
    if (!map.has(type)) map.set(type, new Set());
    map.get(type).add(fn);
  };
  const removeFrom = (map, type, fn) => {
    map.get(type)?.delete(fn);
  };
  const dispatchFrom = (map, type, extra = {}) => {
    for (const fn of [...(map.get(type) || [])]) {
      fn({ type, ...extra });
    }
  };

  const mockDocument = {
    body: bodyEl,
    documentElement: docEl,
    activeElement: null,
    readyState: 'complete',
    hidden: false,
    visibilityState: 'visible',
    getElementById: (id) => (id === 'appRoot' ? rootEl : rootEl.querySelector(`#${id}`)),
    querySelector: (sel) => rootEl.querySelector(sel),
    querySelectorAll: (sel) => rootEl.querySelectorAll(sel),
    addEventListener: (type, fn) => addTo(docListeners, type, fn),
    removeEventListener: (type, fn) => removeFrom(docListeners, type, fn),
    dispatchEvent: (type, extra) => dispatchFrom(docListeners, type, extra)
  };

  const mockWindow = {
    innerWidth,
    location: { search: '', pathname: '/', hash: '' },
    addEventListener: (type, fn) => addTo(winListeners, type, fn),
    removeEventListener: (type, fn) => removeFrom(winListeners, type, fn),
    dispatchEvent: (type, extra) => dispatchFrom(winListeners, type, extra),
    matchMedia: () => ({ matches: false, addEventListener: () => {} })
  };

  const mockStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };

  globalThis.window = mockWindow;
  globalThis.document = mockDocument;
  globalThis.localStorage = mockStorage;

  return {
    rootEl,
    mockWindow,
    mockDocument,
    restore() {
      globalThis.window = prevWindow;
      globalThis.document = prevDocument;
      globalThis.localStorage = prevStorage;
    }
  };
}

function makeBook(idx, overrides = {}) {
  const title = overrides.title ?? `Series Saga: Book ${idx}`;
  const author = overrides.author ?? `Author ${idx}`;
  return {
    bookKey: normalizeBookKey(title, author),
    title,
    author,
    series: 'Series Saga',
    seriesOrder: idx,
    sources: ['drive'],
    totalDurationSec: 3600,
    positionSec: 0,
    chapters: [{ index: 0, title: 'Chapter 1', startSec: 0 }],
    ...overrides
  };
}

test('handleWipeSyncedFiles suppresses per-book render/sheetSlideUp and disables buttons while wiping', async () => {
  const env = createDomEnv({ innerWidth: 1280 });
  try {
    const app = new AudiobookApp(env.rootEl);
    app._enrichSingleBookInBackground = async () => {};
    app._runBackgroundMetadataEnrichment = async () => {};
    app.guestLocalMode = true;
    app.books = [
      makeBook(1, { offlineCached: true }),
      makeBook(2, { offlineCached: true }),
      makeBook(3, { offlineCached: true }),
      makeBook(4, { sources: ['local'], offlineCached: false })
    ];
    app.state.activeBookKey = app.books[0].bookKey;
    app.state.showWipeSyncedModal = true;
    app.state.driveModal.open = true;

    let renderCount = 0;
    const origRender = app.render.bind(app);
    let sawWipingState = false;
    app.render = () => {
      renderCount += 1;
      origRender();
      if (app.state.wipeInProgress) {
        const wipeSlot = env.rootEl.querySelector('#appOverlayWipe');
        const confirmBtn = wipeSlot?.querySelector('[data-action="confirm-wipe-synced"]');
        const cancelBtn = wipeSlot?.querySelector('[data-action="close-wipe-synced-modal"]');
        const modal = wipeSlot?.querySelector('.sheet-modal');
        assert.ok(confirmBtn?.disabled, 'confirm button must be disabled while wiping');
        assert.ok(cancelBtn?.disabled, 'cancel button must be disabled while wiping');
        assert.match(confirmBtn?.textContent || '', /Wiping\.\.\./);
        assert.ok(modal?.classList.contains('no-enter-anim'), 'open wipe modal must get no-enter-anim');
        sawWipingState = true;
      }
    };

    // Initial render mounts open modals
    app.render();
    renderCount = 0;

    let removeCalls = 0;
    app.audioEngine.removeOfflineCopy = async (book) => {
      removeCalls += 1;
      book.offlineCached = false;
      app._handleOfflineChange(book.bookKey, false);
      return { ok: true };
    };
    app.audioEngine.loadBook = async () => {};
    app.syncService.deleteLibraryItems = async () => {};

    await app.handleWipeSyncedFiles();

    assert.equal(removeCalls, 3, 'should remove offline copies for all 3 Drive-only books');
    assert.equal(sawWipingState, true);
    // Only 3 renders total: 1 when entering wipeInProgress, 1 from selectBook(localBook), 1 from showStatusToast
    assert.ok(renderCount <= 3, `expected <= 3 renders without per-book loop renders, got ${renderCount}`);
    assert.equal(app.state.wipeInProgress, false);
    assert.equal(app.state.showWipeSyncedModal, false);
    assert.equal(app.state.driveModal.open, false);
    assert.equal(env.rootEl.querySelector('#appOverlayWipe').innerHTML, '');
    assert.match(env.rootEl.querySelector('#appOverlayToast').innerHTML, /Wiped 3 synced Drive books/);

    // Dismissing status toast clears timer cleanly
    const dismissBtn = env.rootEl.querySelector('[data-action="dismiss-status-toast"]');
    assert.ok(dismissBtn);
    dismissBtn.click();
    assert.equal(app._statusToastTimer, null);
    assert.equal(app.state.statusToast, null);
    app.syncService?.destroy?.();
    app.audioEngine?.destroy?.();
  } finally {
    env.restore();
  }
});

test('scroll positions persist across folder toggle and open-detail on Desktop and Mobile, resetting only on filter/search/view changes', () => {
  const env = createDomEnv({ innerWidth: 1280 });
  try {
    const app = new AudiobookApp(env.rootEl);
    app._enrichSingleBookInBackground = async () => {};
    app._runBackgroundMetadataEnrichment = async () => {};
    app.guestLocalMode = true;
    app.books = [makeBook(1), makeBook(2), makeBook(3, { series: 'Other Saga', title: 'Other Saga: Book 1' })];
    app.state.activeBookKey = app.books[0].bookKey;
    app.render();

    // Scroll left library list and desktop right panel
    const bookList = env.rootEl.querySelector('#book-list');
    const desktopRight = env.rootEl.querySelector('#desktopRightScroll');
    assert.ok(bookList);
    assert.ok(desktopRight);
    bookList.scrollTop = 440;
    desktopRight.scrollTop = 120;

    // Toggle a series folder
    const folderBtn = env.rootEl.querySelector('[data-action="toggle-series-folder"]');
    assert.ok(folderBtn);
    folderBtn.click();

    const bookListAfterToggle = env.rootEl.querySelector('#book-list');
    assert.equal(bookListAfterToggle.scrollTop, 440, 'Desktop #book-list scrollTop must persist after folder toggle');
    assert.equal(env.rootEl.querySelector('#desktopRightScroll').scrollTop, 120);

    // Open detail for a book: #book-list scroll persists, #desktopMainScroll resets to 0
    env.rootEl.querySelector('#desktopMainScroll').scrollTop = 260;
    const openDetailBtn = env.rootEl.querySelector('[data-action="open-detail"]');
    openDetailBtn.click();
    assert.equal(env.rootEl.querySelector('#book-list').scrollTop, 440, 'Desktop #book-list scrollTop must persist on open-detail');
    assert.equal(env.rootEl.querySelector('#desktopMainScroll').scrollTop, 0, '#desktopMainScroll resets on view/detail change');

    // Change filter: #book-list scroll resets to 0 (2-way Audiobooks | Podcasts toggle)
    assert.equal(
      env.rootEl.querySelector('[data-action="set-filter"][data-filter="drive"]'),
      null,
      'Drive filter pill must be removed'
    );
    assert.equal(
      env.rootEl.querySelector('[data-action="set-filter"][data-filter="local"]'),
      null,
      'Local filter pill must be removed'
    );
    assert.equal(
      env.rootEl.querySelector('[data-action="toggle-group-series"]'),
      null,
      'Series toggle button must be removed'
    );
    const podcastsFilterBtn = env.rootEl.querySelector('[data-action="set-filter"][data-filter="podcasts"]');
    assert.ok(podcastsFilterBtn, 'Podcasts filter pill must exist');
    podcastsFilterBtn.click();
    assert.equal(env.rootEl.querySelector('#book-list').scrollTop, 0, '#book-list resets when filter changes');
    const audiobooksFilterBtn = env.rootEl.querySelector('[data-action="set-filter"][data-filter="audiobooks"]');
    assert.ok(audiobooksFilterBtn, 'Audiobooks filter pill must exist');
    audiobooksFilterBtn.click();

    // Switch to Android Mobile viewport (< 768px)
    env.mockWindow.innerWidth = 390;
    app.render();

    const mobileMain = env.rootEl.querySelector('#mobileMainScroll');
    const mobileJump = env.rootEl.querySelector('#mobileJumpStrip');
    assert.ok(mobileMain);
    assert.ok(mobileJump);
    mobileMain.scrollTop = 530;
    mobileJump.scrollLeft = 175;

    const mobileFolderBtn = env.rootEl.querySelector('[data-action="toggle-series-folder"]');
    assert.ok(mobileFolderBtn);
    mobileFolderBtn.click();

    assert.equal(env.rootEl.querySelector('#mobileMainScroll').scrollTop, 530, 'Mobile #mobileMainScroll scrollTop must persist after folder toggle');
    assert.equal(env.rootEl.querySelector('#mobileJumpStrip').scrollLeft, 175, 'Mobile #mobileJumpStrip scrollLeft must persist');

    // Open mobile sheet, scroll it, then re-render: scroll persists and no-enter-anim is added
    app.state.mobileSheetOpen = true;
    app.render();
    const sheetFirst = env.rootEl.querySelector('#mobileSheetScroll');
    assert.ok(sheetFirst);
    assert.equal(sheetFirst.classList.contains('no-enter-anim'), false, 'first open should animate');
    sheetFirst.scrollTop = 210;

    app.state.mobileChaptersExpanded = !app.state.mobileChaptersExpanded;
    app.render();
    const sheetSecond = env.rootEl.querySelector('#mobileSheetScroll');
    assert.equal(sheetSecond.scrollTop, 210, '#mobileSheetScroll scrollTop persists across re-render');
    assert.equal(sheetSecond.classList.contains('no-enter-anim'), true, 'already-open mobile sheet gets no-enter-anim');

    // Inline notification shade button & inline shade are removed from Mobile header
    app.state.mobileSheetOpen = false;
    app.render();
    assert.equal(
      env.rootEl.querySelector('[data-action="toggle-shade"]'),
      null,
      'Mobile header must not render inline notification shade toggle button'
    );
    assert.equal(
      env.rootEl.querySelector('.notif-shade'),
      null,
      'Mobile view must not render redundant inline notification shade'
    );

    app.syncService?.destroy?.();
    app.audioEngine?.destroy?.();
  } finally {
    env.restore();
  }
});

test('open overlays preserve DOM identity across background renders and update sync progress in-place', async () => {
  const env = createDomEnv({ innerWidth: 1280 });
  try {
    const app = new AudiobookApp(env.rootEl);
    app._enrichSingleBookInBackground = async () => {};
    app._runBackgroundMetadataEnrichment = async () => {};
    app.guestLocalMode = true;
    app.books = [makeBook(1)];
    app.state.activeBookKey = app.books[0].bookKey;
    app.state.driveModal = {
      open: true,
      folderId: 'folder-123',
      token: 'tok-abc',
      loading: false,
      error: ''
    };
    app.render();

    const driveSlot = env.rootEl.querySelector('#appOverlayDrive');
    const initialModalEl = driveSlot.querySelector('.sheet-modal');
    const closeBtn = driveSlot.querySelector('[data-action="close-drive-modal"]');
    assert.ok(initialModalEl);
    assert.equal(initialModalEl.classList.contains('no-enter-anim'), false);
    assert.equal(closeBtn.listeners.click.length, 1);

    // Background render while drive modal is unchanged must keep exact DOM node identity and no duplicate listeners
    app.state.snapshot = { ...app.state.snapshot, playing: true };
    app.render();
    assert.equal(
      driveSlot.querySelector('.sheet-modal'),
      initialModalEl,
      'unchanged open overlay must preserve exact DOM identity'
    );
    assert.equal(closeBtn.listeners.click.length, 1, 'untouched overlay must not accumulate duplicate listeners');

    // Transitioning loading false -> true adds no-enter-anim and mounts progress bar
    app.state.driveModal.loading = true;
    app.state.syncProgress = {
      active: true,
      phase: 'drive',
      percent: 10,
      currentFolder: 'Root',
      scannedFolders: 1,
      discoveredFolders: 10,
      booksFound: 0
    };
    app.render();

    const loadingModalEl = driveSlot.querySelector('.sheet-modal');
    assert.ok(loadingModalEl.classList.contains('no-enter-anim'), 're-rendered open modal gets no-enter-anim');

    // _updateSyncProgress updates bar/label/pct in-place without replacing modal DOM
    app._updateSyncProgress({
      phase: 'drive',
      percent: 50,
      currentFolder: 'Sci-Fi',
      scannedFolders: 5,
      discoveredFolders: 10,
      booksFound: 3
    });
    assert.equal(driveSlot.querySelector('.sheet-modal'), loadingModalEl);
    assert.equal(driveSlot.querySelector('[data-sync-progress-bar]').style.width, '50%');
    assert.equal(driveSlot.querySelector('[data-sync-progress-pct]').textContent, '50%');

    // Unrelated background render while loading is true must NOT tear down #appOverlayDrive
    app.state.snapshot = { ...app.state.snapshot, positionSec: 42 };
    app.render();
    assert.equal(
      driveSlot.querySelector('.sheet-modal'),
      loadingModalEl,
      'background render during active Drive sync must not tear down #appOverlayDrive'
    );
    assert.equal(driveSlot.querySelector('[data-sync-progress-bar]').style.width, '50%');

    // Duplicate concurrent runGoogleDriveSync is blocked while loading is true
    let syncCalled = false;
    app.syncService.setGoogleAccessToken = () => {
      syncCalled = true;
    };
    await app.runGoogleDriveSync('folder-123', 'tok-abc');
    assert.equal(syncCalled, false, 'duplicate concurrent runGoogleDriveSync must be ignored');

    // Floating syncProgress overlay mounts in-place when driveModal is closed
    app.state.driveModal.open = false;
    app.state.driveModal.loading = false;
    app.render();
    const progressSlot = env.rootEl.querySelector('#appOverlaySyncProgress');
    const floatingBar = progressSlot.querySelector('[data-sync-progress-bar]');
    assert.ok(floatingBar);

    app._updateSyncProgress({
      phase: 'local',
      percent: 80,
      currentFolder: 'Fantasy',
      scannedFolders: 8,
      discoveredFolders: 10,
      booksFound: 6
    });
    app.state.snapshot = { ...app.state.snapshot, positionSec: 99 };
    app.render();
    assert.equal(
      progressSlot.querySelector('[data-sync-progress-bar]'),
      floatingBar,
      'background render must not tear down #appOverlaySyncProgress'
    );
    assert.equal(floatingBar.style.width, '80%');
    app.syncService?.destroy?.();
    app.audioEngine?.destroy?.();
  } finally {
    env.restore();
  }
});

test('_mergeEnrichedBook preserves enrichmentVersion and upgrades non-English descriptions when available', () => {
  const env = createDomEnv({ innerWidth: 1280 });
  try {
    const app = new AudiobookApp(env.rootEl);
    const existing = makeBook(1, {
      description: 'Una historia sobre un mundo antiguo y sus misterios para todos los lectores.',
      enrichmentVersion: 1
    });
    const enriched = {
      description: 'A story about an ancient world and its mysteries for every reader.',
      enrichmentVersion: 2
    };
    const merged = app._mergeEnrichedBook(existing, enriched);
    assert.equal(merged.enrichmentVersion, 2);
    if (typeof metadataEnrichment.isLikelyNonEnglishText === 'function') {
      assert.equal(merged.description, enriched.description);
    }
    app.syncService?.destroy?.();
    app.audioEngine?.destroy?.();
  } finally {
    env.restore();
  }
});

test('loading cached split Expanse books normalizes keys/series, deduplicates copies, preserves progress, and groups into one The Expanse folder', async () => {
  const env = createDomEnv({ innerWidth: 1280 });
  let app = null;
  try {
    const cachedBooks = [
      {
        bookKey: 'leviathan-wakes-2011::james-s-a-corey',
        title: 'Leviathan Wakes (2011)',
        author: 'James S. A. Corey',
        series: 'James S. A. Corey - The Expanse Complete 2.0 - Jefferson Mays (1)',
        sources: ['drive'],
        positionSec: 120,
        totalDurationSec: 3600
      },
      {
        bookKey: 'caliban’s-war-2013::james-s-a-corey',
        title: 'Caliban’s War (2013)',
        author: 'James S. A. Corey',
        series: 'The Expanse',
        sources: ['drive'],
        positionSec: 450,
        totalDurationSec: 3600
      },
      {
        bookKey: 'drive-2013::james-s-a-corey',
        title: 'An Expanse Novella - Drive (2013)',
        author: 'James S. A. Corey',
        series: 'James S. A. Corey - The Expanse Complete 2.0 - Jefferson Mays',
        sources: ['drive'],
        positionSec: 90,
        totalDurationSec: 1800
      },
      {
        bookKey: 'the-expanse-x-complete-novella-collection-2022::the-expanse-x',
        title: 'Complete Novella Collection (2022)',
        author: 'The Expanse X',
        series: 'James S. A. Corey - The Expanse Complete 2.0 - Jefferson Mays (1)',
        seriesOrder: 2,
        sources: ['drive'],
        positionSec: 0,
        totalDurationSec: 7200
      },
      {
        bookKey: 'the-wisdom-of-crowds-1::joe-abercrombie',
        title: 'The Wisdom of Crowds (1)',
        author: 'Joe Abercrombie',
        series: '02 - The Age of Madness (1)',
        sources: ['local'],
        positionSec: 300,
        totalDurationSec: 5000
      },
      {
        bookKey: 'the-wisdom-of-crowds::joe-abercrombie',
        title: 'The Wisdom of Crowds',
        author: 'Joe Abercrombie',
        series: 'The Age of Madness',
        sources: ['drive'],
        positionSec: 100,
        totalDurationSec: 5000
      }
    ];

    globalThis.localStorage.setItem('audiobook_user_library_v1', JSON.stringify(cachedBooks));
    globalThis.localStorage.setItem('audiobook_player_active_book_v1', 'drive-2013::james-s-a-corey');

    app = new AudiobookApp(env.rootEl);
    app._enrichSingleBookInBackground = async () => {};
    app._runBackgroundMetadataEnrichment = async () => {};
    app.guestLocalMode = true;
    app.audioEngine.loadBook = async () => {};
    app.syncService.fetchAllProgress = async () => ({
      'the-wisdom-of-crowds-1::joe-abercrombie': {
        bookKey: 'the-wisdom-of-crowds-1::joe-abercrombie',
        positionSec: 650,
        chapterIndex: 2,
        clientUpdatedAt: '2026-11-18T12:00:00.000Z'
      }
    });
    app.syncService.fetchBookmarks = async (key) =>
      key === 'leviathan-wakes-2011::james-s-a-corey'
        ? [{ id: 'bm-1', positionSec: 120, label: 'Chapter 1' }]
        : [];

    await app._loadUserLibraryAndSync();

    // Duplicate "The Wisdom of Crowds (1)" + "The Wisdom of Crowds" should merge into 1 entry
    const wisdomBooks = app.books.filter((b) => /wisdom of crowds/i.test(b.title));
    assert.equal(wisdomBooks.length, 1, 'duplicate (1) copy and Drive copy should deduplicate into one book');
    assert.equal(wisdomBooks[0].series, 'The Age of Madness');
    assert.equal(wisdomBooks[0].positionSec, 650, 'progress from legacy key should be preserved');
    assert.deepEqual(wisdomBooks[0].sources.sort(), ['drive', 'local']);

    const entries = app._groupBooksByFranchise(app.books);
    const expanseFolders = entries.filter(
      (e) => e.type === 'franchise' && /expanse/i.test(e.seriesName)
    );
    assert.equal(expanseFolders.length, 1, 'all Expanse books must group into a single folder');
    assert.equal(expanseFolders[0].seriesName, 'The Expanse');
    assert.equal(expanseFolders[0].books.length, 4);
  } finally {
    app?.syncService?.destroy?.();
    app?.audioEngine?.destroy?.();
    env.restore();
  }
});

test('auto-updater banner, dismiss, profile action, and installNativeUpdate progress/permission UX', async () => {
  const env = createDomEnv({ innerWidth: 1280 });
  let app = null;
  try {
    app = new AudiobookApp(env.rootEl);
    app._enrichSingleBookInBackground = async () => {};
    app._runBackgroundMetadataEnrichment = async () => {};
    app.guestLocalMode = true;
    app.books = [makeBook(1)];
    app.state.activeBookKey = app.books[0].bookKey;

    app.updaterService.checkForUpdate = async () => ({
      updateAvailable: true,
      currentVersion: '1.0.11',
      latestVersion: '1.2.0',
      releaseNotes: 'Adds faster sync and seamless handoff.',
      exeDownloadUrl: 'https://github.com/larxe1/Audiobook-Player/releases/latest/download/Audiobook-Player.exe',
      apkDownloadUrl: 'https://github.com/larxe1/Audiobook-Player/releases/latest/download/Audiobook-Player.apk'
    });
    app.updaterService.lastManifest = {
      version: '1.2.0',
      exeDownloadUrl: 'https://github.com/larxe1/Audiobook-Player/releases/latest/download/Audiobook-Player.exe'
    };

    await app.handleCheckForUpdate({ silent: true });
    assert.equal(app.state.updateState.updateAvailable, true);
    assert.equal(app.state.updateState.latestVersion, '1.2.0');
    assert.equal(app.state.updateState.dismissed, false);

    const banner = env.rootEl.querySelector('.update-banner');
    assert.ok(banner, 'Update Available banner should render on Desktop');
    assert.match(banner.textContent, /v1\.2\.0 available/);
    assert.match(banner.textContent, /Adds faster sync/);

    let calledInstall = null;
    app.updaterService.detectPlatform = () => 'android-apk';
    app.updaterService.installNativeUpdate = async (platform, manifest, { onProgress }) => {
      calledInstall = { platform, manifest };
      onProgress({ status: 'downloading', progress: 45 });
      assert.match(env.rootEl.querySelector('.update-banner')?.textContent || '', /45%/);
      onProgress({
        status: 'permission_required',
        message: 'Allow Install unknown apps for Audiobook Player, then tap Update Now again.'
      });
      return { ok: false, reason: 'permission_required' };
    };

    const installBtn = env.rootEl.querySelector('[data-action="install-update"]');
    assert.ok(installBtn);
    installBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(calledInstall?.platform, 'android-apk');
    assert.equal(app.state.updateState.installing, false);
    assert.match(app.state.updateState.statusText, /Allow Install unknown apps/);

    // Profile menu also exposes Update to v1.2.0
    app.state.profileOpen = true;
    app.render();
    const profileInstallBtn = env.rootEl
      .querySelector('#appOverlayProfile')
      ?.querySelector('[data-action="install-update"]');
    assert.ok(profileInstallBtn);
    assert.match(profileInstallBtn.textContent, /Update to v1\.2\.0/);

    // Dismissing hides banner
    const dismissBtn = env.rootEl.querySelector('[data-action="dismiss-update"]');
    dismissBtn.click();
    assert.equal(app.state.updateState.dismissed, true);
    assert.equal(env.rootEl.querySelector('.update-banner'), null);
  } finally {
    app?.destroy?.();
    env.restore();
  }
});

test('cross-device library merge, Drive folder auto-link, remote-local badge/notice, reauth banner, and Continue Here handoff', async () => {
  const env = createDomEnv({ innerWidth: 390 });
  let app = null;
  try {
    app = new AudiobookApp(env.rootEl);
    app._enrichSingleBookInBackground = async () => {};
    app._runBackgroundMetadataEnrichment = async () => {};
    app.audioEngine.loadBook = async () => {};
    let playedCalls = 0;
    app.audioEngine.play = async () => {
      playedCalls += 1;
      app.audioEngine.playing = true;
      app.state.snapshot = { ...app.state.snapshot, playing: true };
    };
    let seekedTo = null;
    app.audioEngine.seekToSeconds = (sec) => {
      seekedTo = sec;
      app.audioEngine.positionSec = sec;
      app.state.snapshot = { ...app.state.snapshot, positionSec: sec };
    };

    app.user = { id: 'google_123', email: 'reader@gmail.com', name: 'Reader' };
    app.syncService.deviceId = 'dev_android';
    app.syncService.deviceName = 'Android Device';
    app.syncService.hasCloudSyncAuth = () => true;
    app.syncService.needsDriveSyncReauth = true;
    app.syncService.fetchDriveFolderConfig = async () => ({
      folderId: 'drive-folder-from-pc',
      folderName: 'Audiobooks'
    });
    app.syncService.fetchLibraryItems = async () => [
      {
        bookKey: 'project-hail-mary::andy-weir',
        title: 'Project Hail Mary',
        author: 'Andy Weir',
        sources: ['drive'],
        driveFileId: 'drv-phm-1',
        driveStreamUrl: 'https://www.googleapis.com/drive/v3/files/drv-phm-1?alt=media',
        tracks: [{ name: 'phm.m4b', driveFileId: 'drv-phm-1', driveStreamUrl: 'https://www.googleapis.com/drive/v3/files/drv-phm-1?alt=media' }],
        chapters: [{ index: 0, title: 'Chapter 1', startSec: 0 }, { index: 1, title: 'Chapter 2', startSec: 300 }],
        totalDurationSec: 3600
      },
      {
        bookKey: 'pc-local-book::some-author',
        title: 'PC Local Only Book',
        author: 'Some Author',
        sources: ['local'],
        originDeviceId: 'dev_pc',
        originDeviceName: 'Windows PC',
        totalDurationSec: 1800,
        chapters: [{ index: 0, title: 'Chapter 1', startSec: 0 }]
      }
    ];
    app.syncService.fetchAllProgress = async () => ({
      'project-hail-mary::andy-weir': {
        bookKey: 'project-hail-mary::andy-weir',
        chapterIndex: 1,
        positionSec: 420,
        clientUpdatedAt: '2026-11-18T14:50:00.000Z'
      }
    });
    app.syncService.fetchBookmarks = async () => [];
    app.syncService.fetchDevices = async () => [
      {
        deviceId: 'dev_pc',
        deviceName: 'Windows PC',
        platform: 'windows',
        currentBookKey: 'project-hail-mary::andy-weir',
        currentBookTitle: 'Project Hail Mary',
        chapterIndex: 1,
        positionSec: 420,
        isPlaying: true,
        isActivePlayer: true,
        lastSeenAt: '2026-11-18T14:55:00.000Z'
      }
    ];
    const registeredCalls = [];
    app.syncService.registerDevice = async (payload) => {
      registeredCalls.push(payload);
      return payload;
    };

    await app._loadUserLibraryAndSync();
    app.render();

    // Auto-linked PC's Drive folder ID
    assert.equal(globalThis.localStorage.getItem('audiobook_drive_folder_v1'), 'drive-folder-from-pc');
    assert.equal(app.state.driveModal.folderId, 'drive-folder-from-pc');

    // Reauth banner renders when needsDriveSyncReauth is true (401 skips consent; 403 forces consent)
    const reauthBtn = env.rootEl.querySelector('[data-action="reauth-drive-sync"]');
    assert.ok(reauthBtn, 'Enable Cloud Library Sync button should render');
    let consentOpts = null;
    app.syncService.signInWithGoogle = async (opts) => {
      consentOpts = opts;
      return { ok: false, mode: 'popup' };
    };
    reauthBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(consentOpts?.forceConsent, false);
    assert.equal(consentOpts?.hint, 'reader@gmail.com');

    app.syncService.needsDriveConsent = true;
    reauthBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(consentOpts?.forceConsent, true);
    assert.equal(consentOpts?.hint, 'reader@gmail.com');
    app.syncService.needsDriveConsent = false;

    // Remote-local-only book shows "On Windows PC" badge and shows friendly message on play click
    assert.match(env.rootEl.querySelector('#appMainLayer').innerHTML, /On Windows PC/);
    const remoteLocalBtn = env.rootEl
      .querySelectorAll('[data-action="play-book"]')
      .find((b) => b.dataset.book === 'pc-local-only-book::some-author');
    assert.ok(remoteLocalBtn);
    remoteLocalBtn.click();
    assert.equal(app.state.errorModal.open, true);
    assert.match(app.state.errorModal.message, /stored locally on Windows PC/);
    app.state.errorModal.open = false;
    app.render();

    // Continue from Windows PC banner renders and Continue Here switches/seeks/plays
    const continueCard = env.rootEl.querySelector('.continue-device-card');
    assert.ok(continueCard, 'Continue from Windows PC card should render');
    assert.match(continueCard.textContent, /Continue from Windows PC/);
    assert.match(continueCard.textContent, /Playing now/);

    const continueBtn = continueCard.querySelector('[data-action="continue-remote-device"]');
    continueBtn.click();
    await new Promise((r) => setTimeout(r, 15));

    assert.equal(app.state.activeBookKey, 'project-hail-mary::andy-weir');
    assert.equal(seekedTo, 420);
    assert.equal(playedCalls, 1);
    assert.ok(registeredCalls.some((c) => c.isPlaying === true && c.activeBookKey === 'project-hail-mary::andy-weir'));

    // Devices modal opens in #appOverlayDevices
    app.state.devicesModalOpen = true;
    app.render();
    const devicesSlot = env.rootEl.querySelector('#appOverlayDevices');
    assert.match(devicesSlot.innerHTML, /Signed-In Devices/);
    assert.match(devicesSlot.innerHTML, /Windows PC/);
  } finally {
    app?.destroy?.();
    env.restore();
  }
});

test('returning via focus or visibilitychange after Android installing resets installing=false so Update Now is clickable again', async () => {
  const env = createDomEnv({ innerWidth: 390 });
  let app = null;
  try {
    app = new AudiobookApp(env.rootEl);
    app._enrichSingleBookInBackground = async () => {};
    app._runBackgroundMetadataEnrichment = async () => {};
    app.guestLocalMode = true;
    app.books = [makeBook(1)];
    app.state.activeBookKey = app.books[0].bookKey;

    app.state.updateState = {
      ...app.state.updateState,
      checked: true,
      updateAvailable: true,
      latestVersion: '1.0.12',
      manifest: {
        version: '1.0.12',
        apkDownloadUrl: 'https://github.com/larxe1/Audiobook-Player/releases/latest/download/Audiobook-Player.apk'
      }
    };
    app.render();

    let progressHandler = null;
    let installCalls = 0;
    app.updaterService.detectPlatform = () => 'android-apk';
    app.updaterService.installNativeUpdate = async (platform, manifest, { onProgress }) => {
      installCalls += 1;
      progressHandler = onProgress;
      return { ok: true, started: true, platform, url: manifest.apkDownloadUrl };
    };

    // 1. Trigger install and advance to Android PackageInstaller launch (`installing` at 100%)
    env.rootEl.querySelector('[data-action="install-update"]').click();
    await new Promise((r) => setTimeout(r, 10));
    progressHandler({ status: 'downloading', progress: 60 });
    progressHandler({ status: 'installing', progress: 100, message: 'Opening Android installer...' });

    const disabledBtn = env.rootEl.querySelector('[data-action="install-update"]');
    assert.equal(app.state.updateState.installing, true);
    assert.equal(disabledBtn?.disabled, true);
    assert.match(disabledBtn?.textContent || '', /Updating 100%/);

    // Hidden visibilitychange when PackageInstaller opens must NOT reset prematurely
    env.mockDocument.hidden = true;
    env.mockDocument.visibilityState = 'hidden';
    env.mockDocument.dispatchEvent('visibilitychange');
    assert.equal(app.state.updateState.installing, true);

    // Returning via focus resets installing=false and makes Update Now clickable again
    env.mockDocument.hidden = false;
    env.mockDocument.visibilityState = 'visible';
    env.mockWindow.dispatchEvent('focus');

    assert.equal(app.state.updateState.installing, false);
    assert.equal(app.state.updateState.statusText, '');
    const reenabledBtn = env.rootEl.querySelector('[data-action="install-update"]');
    assert.equal(reenabledBtn?.disabled, false);
    assert.match(reenabledBtn?.textContent || '', /Update Now/);

    // 2. Retry install and verify visibilitychange -> visible also resets cleanly
    reenabledBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(installCalls, 2);
    progressHandler({ status: 'installing', progress: 100, message: 'Opening Android installer...' });
    assert.equal(app.state.updateState.installing, true);

    env.mockDocument.hidden = false;
    env.mockDocument.visibilityState = 'visible';
    env.mockDocument.dispatchEvent('visibilitychange');

    assert.equal(app.state.updateState.installing, false);
    assert.equal(env.rootEl.querySelector('[data-action="install-update"]')?.disabled, false);
  } finally {
    app?.destroy?.();
    env.restore();
  }
});

test('startup never flashes Login Screen when persisted session exists in localStorage or native/IDB while restoreSession is pending', async () => {
  // Part 1: Persisted Google session in localStorage -> immediate workspace, NEVER login view
  const env1 = createDomEnv({ innerWidth: 1280 });
  let app1 = null;
  try {
    globalThis.localStorage.setItem(
      'audiobook_player_supabase_session_v1',
      JSON.stringify({
        access_token: 'supa-jwt-1',
        provider_token: 'ya29.expired_1h',
        auth_mode: 'google_oauth',
        user: {
          id: 'user-1',
          email: 'reader@gmail.com',
          user_metadata: { full_name: 'Reader One' }
        }
      })
    );
    const cachedBook = makeBook(1, { title: 'Dune', author: 'Frank Herbert', series: 'Dune' });
    globalThis.localStorage.setItem('audiobook_user_library_v1', JSON.stringify([cachedBook]));
    globalThis.localStorage.setItem('audiobook_player_active_book_v1', cachedBook.bookKey);

    app1 = new AudiobookApp(env1.rootEl);
    app1._enrichSingleBookInBackground = async () => {};
    app1._runBackgroundMetadataEnrichment = async () => {};
    app1.handleCheckForUpdate = async () => {};
    const loadedBooks = [];
    app1.audioEngine.loadBook = async (book, startPos) => {
      loadedBooks.push({ bookKey: book.bookKey, startPos });
      app1.audioEngine.currentBook = book;
      app1.audioEngine.durationSec = book.totalDurationSec || 3600;
    };
    app1.syncService.fetchImpl = async () => ({ ok: false, status: 500, async text() { return ''; } });
    app1.syncService.syncLibraryItems = async () => null;
    app1.syncService.fetchLibraryItems = async () => [];
    app1.syncService.fetchAllProgress = async () => ({});
    app1.syncService.fetchBookmarks = async () => [];
    app1.syncService.fetchDevices = async () => [];
    app1.syncService.fetchDriveFolderConfig = async () => null;
    app1.syncService.pullCloudSnapshot = async () => ({
      changed: true,
      library: [],
      progress: {
        [cachedBook.bookKey]: {
          bookKey: cachedBook.bookKey,
          chapterIndex: 0,
          positionSec: 320,
          clientUpdatedAt: '2026-11-21T12:00:00.000Z'
        }
      },
      devices: [],
      driveFolder: null,
      latestActivePlayback: {
        bookKey: cachedBook.bookKey,
        bookTitle: cachedBook.title,
        chapterIndex: 0,
        positionSec: 320,
        isPlaying: false,
        updatedAt: '2026-11-21T12:00:00.000Z',
        deviceId: 'other-dev',
        deviceName: 'Other Device'
      }
    });
    app1.syncService.registerDevice = async () => null;

    // Constructor eagerly hydrates user synchronously
    assert.equal(app1.user?.email, 'reader@gmail.com');

    let resolveRestore;
    const restoreGate = new Promise((r) => {
      resolveRestore = r;
    });
    app1.syncService.restoreSession = async () => {
      await restoreGate;
      app1.syncService.setGoogleAccessToken('ya29.silently_refreshed');
      return app1.syncService.session;
    };

    const initPromise = app1.init();
    // Simulate MediaSessionBridge firing onAudioOutputChange ~10ms into startup while restoreSession() is still pending
    await new Promise((r) => setTimeout(r, 10));
    app1.mediaBridge.onAudioOutputChange({
      activeLabel: 'Headphones',
      activeDeviceId: 'dev-1',
      devices: [{ deviceId: 'dev-1', label: 'Headphones' }]
    });

    assert.equal(
      env1.rootEl.querySelector('[data-action="login-google"]'),
      null,
      'Login screen must NEVER render while restoreSession() is pending'
    );
    assert.ok(
      env1.rootEl.querySelector('#book-list') || env1.rootEl.querySelector('#appMainLayer'),
      'Signed-in workspace must render immediately with cached local books'
    );
    assert.equal(app1.books.length, 1);

    resolveRestore();
    await initPromise;
    assert.equal(app1.audioEngine.driveAccessToken, 'ya29.silently_refreshed');
    assert.equal(env1.rootEl.querySelector('[data-action="login-google"]'), null);
    assert.equal(
      loadedBooks.length,
      1,
      'startup must still call audioEngine.loadBook even when fast hydration pre-set matching activeBookKey'
    );
    assert.equal(loadedBooks[0].bookKey, cachedBook.bookKey);
    assert.equal(loadedBooks[0].startPos, 320);
    assert.equal(app1.audioEngine.currentBook?.bookKey, cachedBook.bookKey);
  } finally {
    app1?.destroy?.();
    env1.restore();
  }

  // Part 2: localStorage wiped, session recovered async from native/IDB -> shows #authRestoringView (NEVER Login Screen) while hydrating
  const env2 = createDomEnv({ innerWidth: 390 });
  let app2 = null;
  try {
    app2 = new AudiobookApp(env2.rootEl);
    app2._enrichSingleBookInBackground = async () => {};
    app2._runBackgroundMetadataEnrichment = async () => {};
    app2.handleCheckForUpdate = async () => {};
    app2.audioEngine.loadBook = async () => {};
    app2.syncService.fetchImpl = async () => ({ ok: false, status: 500, async text() { return ''; } });
    app2.syncService.syncLibraryItems = async () => null;
    app2.syncService.fetchLibraryItems = async () => [];
    app2.syncService.fetchAllProgress = async () => ({});
    app2.syncService.fetchBookmarks = async () => [];
    app2.syncService.fetchDevices = async () => [];
    app2.syncService.fetchDriveFolderConfig = async () => null;
    app2.syncService.pullCloudSnapshot = async () => ({
      changed: false,
      library: [],
      progress: {},
      devices: [],
      driveFolder: null,
      latestActivePlayback: null
    });
    app2.syncService.registerDevice = async () => null;

    let resolveHydrate;
    let resolveRestore;
    const hydrateGate = new Promise((r) => {
      resolveHydrate = r;
    });
    const restoreGate = new Promise((r) => {
      resolveRestore = r;
    });

    app2.syncService.hydratePersistedSession = async () => {
      await hydrateGate;
      app2.syncService.setSession({
        access_token: 'supa-recovered',
        auth_mode: 'google_oauth',
        provider_token: 'ya29.recovered_tok',
        user: { id: 'u-rec', email: 'recovered@gmail.com', user_metadata: { full_name: 'Recovered User' } }
      });
      return app2.syncService.session;
    };
    app2.syncService.restoreSession = async () => {
      await restoreGate;
      return app2.syncService.session;
    };

    const initPromise = app2.init();
    // While hydratePersistedSession() is still awaiting native disk / IDB, fire MediaSessionBridge render
    app2.mediaBridge.onAudioOutputChange({
      activeLabel: 'Speaker',
      activeDeviceId: 'default',
      devices: []
    });

    assert.equal(
      env2.rootEl.querySelector('[data-action="login-google"]'),
      null,
      'Login screen must NEVER flash while hydratePersistedSession() is pending'
    );
    assert.ok(
      env2.rootEl.querySelector('#authRestoringView'),
      'Minimal restoring view must render while async native/IDB hydration is in flight'
    );

    // Finish fast hydration while slow network restoreSession() is still pending
    resolveHydrate();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(app2.user?.email, 'recovered@gmail.com');
    assert.equal(env2.rootEl.querySelector('[data-action="login-google"]'), null);
    assert.equal(env2.rootEl.querySelector('#authRestoringView'), null);

    resolveRestore();
    await initPromise;
    assert.equal(env2.rootEl.querySelector('[data-action="login-google"]'), null);
  } finally {
    app2?.destroy?.();
    env2.restore();
  }
});

test('guestLocalMode persists across AudiobookApp restart and clears on handleSignOut', async () => {
  const env = createDomEnv({ innerWidth: 1280 });
  let app1 = null;
  let app2 = null;
  try {
    app1 = new AudiobookApp(env.rootEl);
    app1._enrichSingleBookInBackground = async () => {};
    app1._runBackgroundMetadataEnrichment = async () => {};
    app1.audioEngine.loadBook = async () => {};

    assert.equal(app1.guestLocalMode, false);
    await app1.enterLocalMode();
    assert.equal(app1.guestLocalMode, true);
    assert.equal(globalThis.localStorage.getItem('audiobook_player_guest_mode_v1'), '1');

    // Simulate full app restart -> new AudiobookApp immediately restores guestLocalMode without login screen
    app1.destroy();
    app1 = null;

    app2 = new AudiobookApp(env.rootEl);
    app2._enrichSingleBookInBackground = async () => {};
    app2._runBackgroundMetadataEnrichment = async () => {};
    app2.audioEngine.loadBook = async () => {};

    assert.equal(app2.guestLocalMode, true);
    app2.render();
    assert.equal(env.rootEl.querySelector('[data-action="login-google"]'), null);

    // Explicit sign-out clears persisted guestLocalMode and returns to Login Screen
    await app2.handleSignOut();
    assert.equal(app2.guestLocalMode, false);
    assert.equal(globalThis.localStorage.getItem('audiobook_player_guest_mode_v1'), null);
    assert.ok(env.rootEl.querySelector('[data-action="login-google"]'));
  } finally {
    app1?.destroy?.();
    app2?.destroy?.();
    env.restore();
  }
});

test('podcasts filter chip, + Podcast trigger, Podcast Finder modal stability, series exclusion, New Episodes shelf, and episode actions on Desktop and Mobile', async () => {
  const env = createDomEnv({ innerWidth: 1280 });
  let app = null;
  try {
    app = new AudiobookApp(env.rootEl);
    app._enrichSingleBookInBackground = async () => {};
    app._runBackgroundMetadataEnrichment = async () => {};
    app.guestLocalMode = true;
    app.audioEngine.loadBook = async (book) => {
      app.audioEngine.currentBook = book;
    };
    app.audioEngine.play = async () => {
      app.audioEngine.playing = true;
    };
    app.audioEngine.setChapter = async (idx) => {
      app.audioEngine.chapterIndex = idx;
    };
    app.audioEngine.fetchImpl = async () => ({
      ok: true,
      async blob() {
        return new Blob(['mock-episode-audio'], { type: 'audio/mpeg' });
      }
    });

    app.books = [makeBook(1), makeBook(2)];
    app.state.activeBookKey = app.books[0].bookKey;
    app.render();

    // 1. Desktop sidebar & main header render Audiobooks/Podcasts filter chips, unified Search trigger, and zero standalone Devices clutter in transport bar
    const desktopAudiobooksChip = env.rootEl.querySelector('[data-action="set-filter"][data-filter="audiobooks"]');
    const desktopPodcastChip = env.rootEl.querySelector('[data-action="set-filter"][data-filter="podcasts"]');
    const desktopSearchTrigger = env.rootEl.querySelector('[data-action="open-search-modal"]');
    assert.ok(desktopAudiobooksChip, 'Desktop sidebar must render Audiobooks filter chip');
    assert.ok(desktopPodcastChip, 'Desktop sidebar must render Podcasts filter chip');
    assert.ok(desktopPodcastChip.classList.contains('filter-pill'), 'Filter chip must carry filter-pill animation class');
    assert.ok(desktopSearchTrigger, 'Desktop must render unified Search trigger button');
    assert.equal(
      env.rootEl.querySelector('#appMainLayer')?.querySelector('[data-action="open-devices-modal"]'),
      null,
      'Standalone open-devices-modal button must not clutter Desktop bottom transport bar'
    );

    // Profile popover still retains Devices entry
    app.state.profileOpen = true;
    app.render();
    assert.ok(
      env.rootEl.querySelector('#appOverlayProfile')?.querySelector('[data-action="open-devices-modal"]'),
      'Devices action must remain accessible inside Profile Avatar popover'
    );
    app.state.profileOpen = false;
    app.render();

    // Switch to Podcasts filter -> renders inline Podcast Discovery Hub (open-podcast-category) and 1-tap Live Podcasts search button
    desktopPodcastChip.click();
    assert.equal(app.state.filterSource, 'podcasts');
    assert.ok(
      env.rootEl.querySelector('[data-action="open-podcast-category"][data-category-id="trending"]'),
      'Inline Podcast Discovery Hub must render 1-tap category pills when filterSource === podcasts'
    );
    app.state.searchQuery = 'Hard Fork';
    app.render();
    const liveSearchBtn = env.rootEl.querySelector('[data-action="open-podcast-modal"][data-query="Hard Fork"]');
    assert.ok(liveSearchBtn, 'Must render 1-tap Search in Live Podcasts button when searching under podcasts filter');
    app.state.searchQuery = '';

    // 2. Podcast Finder modal opens with curated/search results, category chips, and preserves DOM identity across background renders
    app.state.podcastModal = {
      open: true,
      query: '',
      activeCategory: 'trending',
      loading: false,
      subscribingId: '',
      error: '',
      results: [
        {
          id: 'curated-hard-fork',
          title: 'Hard Fork',
          author: 'Kevin Roose & Casey Newton',
          feedUrl: 'https://feeds.simplecast.com/l2i9YnTd',
          coverUrl: '',
          genre: 'Tech & AI',
          episodeCount: 140
        }
      ]
    };
    app.render();

    const podcastSlot = env.rootEl.querySelector('#appOverlayPodcast');
    const initialPodcastModal = podcastSlot.querySelector('.sheet-modal');
    assert.ok(initialPodcastModal, 'Podcast Finder modal should mount in #appOverlayPodcast');
    assert.ok(podcastSlot.querySelector('.modal-backdrop'), 'Podcast Finder modal backdrop must carry modal-backdrop class');
    assert.ok(podcastSlot.querySelector('.ui-stagger-grid'), 'Podcast Finder results must carry ui-stagger-grid class');
    assert.ok(podcastSlot.querySelector('[data-action="podcast-search-input"]'), 'Podcast search input must render');
    assert.ok(
      podcastSlot.querySelector('[data-action="select-podcast-category"][data-category-id="tech"]'),
      '1-tap category chips must render'
    );
    const followBtn = podcastSlot.querySelector('[data-action="subscribe-podcast"]');
    assert.ok(followBtn);
    assert.match(followBtn.textContent, /Follow/);

    // Background playback tick must preserve open Podcast Finder modal DOM identity
    app.state.snapshot = { ...app.state.snapshot, positionSec: 45 };
    app.render();
    assert.equal(
      podcastSlot.querySelector('.sheet-modal'),
      initialPodcastModal,
      'unchanged open Podcast Finder modal must preserve exact DOM identity'
    );

    // 3. Add two subscribed podcasts sharing a prefix -> never grouped into book series folders
    const podcast1 = {
      bookKey: 'podcast:hardfork1',
      title: 'Hard Fork: Daily',
      author: 'Kevin Roose',
      series: 'Hard Fork',
      isPodcast: true,
      mediaType: 'podcast',
      feedUrl: 'https://feeds.simplecast.com/l2i9YnTd',
      sources: ['podcast'],
      source: 'podcast',
      totalDurationSec: 3600,
      positionSec: 0,
      chapterIndex: 0,
      episodeProgress: {
        'ep-1': { positionSec: 1800, durationSec: 1800, completed: true, updatedAt: '2026-11-21T10:00:00Z' }
      },
      chapters: [
        {
          index: 0,
          episodeId: 'ep-1',
          title: 'AI Agents in 2026',
          audioUrl: 'https://cdn.example.com/ep1.mp3',
          durationSec: 1800,
          publishedAt: '2026-11-21T08:00:00Z',
          description: 'Clean plain text episode summary without tags.',
          offlineCached: false
        },
        {
          index: 1,
          episodeId: 'ep-2',
          title: 'Quantum Chips Breakdown',
          audioUrl: 'https://cdn.example.com/ep2.mp3',
          durationSec: 2400,
          publishedAt: '2026-11-19T08:00:00Z',
          description: 'Second episode notes.',
          offlineCached: false
        }
      ]
    };
    const podcast2 = {
      ...podcast1,
      bookKey: 'podcast:hardfork2',
      title: 'Hard Fork: Weekend',
      feedUrl: 'https://feeds.simplecast.com/weekend'
    };

    app.state.podcastModal.open = false;
    app.books = [makeBook(1), makeBook(2), podcast1, podcast2];
    app._persistBooks();

    const savedPodcastsRaw = globalThis.localStorage.getItem('audiobook_podcasts_v1');
    assert.ok(savedPodcastsRaw, 'Subscribed podcasts must persist to audiobook_podcasts_v1');
    assert.equal(JSON.parse(savedPodcastsRaw).length, 2);

    const groupedAll = app._groupBooksBySeries(app.books);
    const hardForkFolder = groupedAll.find(
      (e) => e.type === 'franchise' && /hard fork/i.test(e.seriesName || '')
    );
    assert.equal(hardForkFolder, undefined, 'Podcasts must NEVER be grouped into series folders');

    // 4. Desktop New Episodes shelf (under Podcasts filter) & Podcast Detail view (Episodes list, Refresh, Unfollow, Offline toggle)
    app.state.filterSource = 'podcasts';
    app.render();
    assert.match(env.rootEl.querySelector('#appMainLayer').innerHTML, /New Episodes/);
    assert.match(env.rootEl.querySelector('#appMainLayer').innerHTML, /AI Agents in 2026/);

    // Open Podcast Detail view
    app.state.detailBookKey = podcast1.bookKey;
    app.state.desktopView = 'detail';
    app.render();

    const detailText = env.rootEl.querySelector('#desktopMainScroll').textContent;
    assert.match(detailText, /Episodes \(2\)/);
    assert.match(detailText, /✓ Played/);
    assert.ok(env.rootEl.querySelector('[data-action="refresh-podcast-feed"]'));
    assert.ok(env.rootEl.querySelector('[data-action="unsubscribe-podcast"]'));

    // Toggle episode offline download
    const dlBtn = env.rootEl.querySelector(
      `[data-action="toggle-episode-offline"][data-book-key="${podcast1.bookKey}"][data-chapter-index="0"]`
    );
    assert.ok(dlBtn);
    await app.toggleEpisodeOffline(podcast1.bookKey, 0);
    assert.equal(app.books.find((b) => b.bookKey === podcast1.bookKey).chapters[0].offlineCached, true);

    // Saved / downloaded filter includes podcast with offline episode
    app.state.filterSource = 'downloaded';
    assert.ok(
      app.getFilteredBooks().some((b) => b.bookKey === podcast1.bookKey),
      'downloaded filter must include podcasts with offlineCached episodes'
    );

    // 5. Switch to Android Mobile viewport (< 768px) -> verifies mobile Audiobooks/Podcasts chips, unified Search trigger, inline Discovery Hub, animation classes, and zero standalone Devices clutter
    app.state.filterSource = 'podcasts';
    env.mockWindow.innerWidth = 390;
    app.render();
    assert.ok(env.rootEl.querySelector('[data-action="set-filter"][data-filter="audiobooks"]'));
    assert.ok(env.rootEl.querySelector('[data-action="set-filter"][data-filter="podcasts"]'));
    assert.ok(env.rootEl.querySelector('[data-action="open-search-modal"]'));
    assert.ok(
      env.rootEl.querySelector('[data-action="open-podcast-category"][data-category-id="tech"]'),
      'Inline Podcast Discovery Hub must render on Mobile even when podcasts are already followed'
    );
    assert.equal(
      env.rootEl.querySelector('#appMainLayer')?.querySelector('[data-action="open-devices-modal"]'),
      null,
      'Standalone open-devices-modal button must not clutter Mobile top header'
    );
    assert.ok(env.rootEl.querySelector('.ui-view-enter'), 'Main sections must carry ui-view-enter class');
    assert.ok(env.rootEl.querySelector('.ui-stagger-grid'), 'Card grids must carry ui-stagger-grid class');
    assert.match(env.rootEl.querySelector('#mobileMainScroll').textContent, /New Episodes/);
  } finally {
    app?.destroy?.();
    env.restore();
  }
});

test('MultiPlayer rename, Pitch default + Midnight migration, series collapsed by default, offline-only checkmark & zero cloud icon', () => {
  const env = createDomEnv({ innerWidth: 1280 });
  let app = null;
  try {
    // Stored 'midnight' theme must auto-migrate to 'pitch'
    globalThis.localStorage.setItem('audiobook_player_theme_v1', 'midnight');
    app = new AudiobookApp(env.rootEl);
    assert.equal(app.state.theme, 'pitch', 'Midnight theme must auto-migrate to pitch');
    assert.equal(globalThis.localStorage.getItem('audiobook_player_theme_v1'), 'pitch');

    // Login screen displays MultiPlayer
    app.render();
    assert.match(env.rootEl.querySelector('h1')?.textContent || '', /^MultiPlayer$/);
    assert.match(app._renderNotificationShade(null, app.state.snapshot), /MultiPlayer/);
    assert.match(app._renderGalaxyWatchView(null, app.state.snapshot), /MultiPlayer/);

    // Series folders must start collapsed by default (expandedSeries empty)
    app.guestLocalMode = true;
    app.books = [
      makeBook(1, { sources: ['drive'], offlineCached: false, isOffline: false }),
      makeBook(2, { sources: ['drive'], offlineCached: true, isOffline: true }),
      makeBook(3, { title: 'Standalone Local', author: 'Indie', series: '', sources: ['local'], offlineCached: false, isOffline: false })
    ];
    app.render();
    assert.equal(app.state.expandedSeries.size, 0, 'Series folders must be collapsed by default');
    assert.equal(
      env.rootEl.querySelector('#book-list')?.querySelectorAll('.franchise-book-item').length,
      0,
      'Nested series books must not render until folder is expanded'
    );

    // Expanding folder reveals nested books
    env.rootEl.querySelector('[data-action="toggle-series-folder"]').click();
    assert.equal(app.state.expandedSeries.size, 1);
    assert.equal(
      env.rootEl.querySelector('#book-list')?.querySelectorAll('.franchise-book-item').length,
      2
    );

    // _renderSourceBadges returns empty string (no blue cloud icon / folder icon)
    assert.equal(app._renderSourceBadges(app.books[0]), '');
    assert.equal(app._renderSourceBadges(app.books[2]), '');

    // _renderDownloadedIcon shows green checkmark ONLY when genuinely saved offline
    assert.equal(app._renderDownloadedIcon(app.books[0]), '', 'Uncached Drive book must NOT show offline checkmark');
    assert.equal(app._renderDownloadedIcon(app.books[2]), '', 'Non-offline book without offlineCached/isOffline must NOT show checkmark');
    assert.match(
      app._renderDownloadedIcon(app.books[1]),
      /data-offline-saved="true"/,
      'Offline-cached book must render green checkmark'
    );
  } finally {
    app?.destroy?.();
    env.restore();
  }
});

test('Unified Search modal preserves #podcastSearchInput DOM node in-place on keystrokes and filters All/Audiobooks/Podcasts', () => {
  const env = createDomEnv({ innerWidth: 390 });
  let app = null;
  try {
    app = new AudiobookApp(env.rootEl);
    app._enrichSingleBookInBackground = async () => {};
    app._runBackgroundMetadataEnrichment = async () => {};
    app.guestLocalMode = true;
    app.books = [
      makeBook(1, { title: 'Dune', author: 'Frank Herbert', series: 'Dune' }),
      makeBook(2, { title: 'Hyperion', author: 'Dan Simmons', series: 'Hyperion' })
    ];
    app.state.podcastModal = {
      open: true,
      query: '',
      searchFilter: 'all',
      activeCategory: 'trending',
      loading: false,
      subscribingId: '',
      error: '',
      results: [
        { id: 'p1', title: 'Tech Talk', author: 'Host', feedUrl: 'https://example.com/rss', genre: 'Tech' }
      ]
    };
    app.render();

    const podcastSlot = env.rootEl.querySelector('#appOverlayPodcast');
    const initialInput = podcastSlot.querySelector('#podcastSearchInput');
    assert.ok(initialInput, '#podcastSearchInput must mount');

    // Update query & loading transition (simulating Android keystroke + async fetch)
    app.state.podcastModal.query = 'Dune';
    app.state.podcastModal.loading = true;
    app.render();
    assert.equal(
      podcastSlot.querySelector('#podcastSearchInput'),
      initialInput,
      '#podcastSearchInput DOM node MUST stay identical on keystroke render (zero keyboard blur/pop-in)'
    );

    // Switch filter to Audiobooks -> shows Dune, hides Podcasts to Follow
    const abFilterBtn = podcastSlot.querySelector('[data-action="set-search-filter"][data-search-filter="audiobooks"]');
    assert.ok(abFilterBtn);
    abFilterBtn.click();
    assert.equal(app.state.podcastModal.searchFilter, 'audiobooks');
    assert.equal(podcastSlot.querySelector('#podcastSearchInput'), initialInput);
    const regionText = podcastSlot.querySelector('#podcastModalResultsRegion').textContent;
    assert.match(regionText, /Dune/);
    assert.doesNotMatch(regionText, /Hyperion/);
    assert.doesNotMatch(regionText, /Tech Talk/);
  } finally {
    app?.destroy?.();
    env.restore();
  }
});

test('Compact Continue Listening dismissal persists in localStorage across heartbeats and restarts', () => {
  const env1 = createDomEnv({ innerWidth: 390 });
  let app1 = null;
  let app2 = null;
  try {
    app1 = new AudiobookApp(env1.rootEl);
    app1.guestLocalMode = true;
    app1.syncService.deviceId = 'dev_android';
    app1.books = [makeBook(1, { title: 'Dune', author: 'Frank Herbert' })];
    const bookKey = app1.books[0].bookKey;

    const makeRemoteDevice = (posSec, iso) => [
      {
        deviceId: 'dev_pc',
        deviceName: 'Windows PC',
        currentBookKey: bookKey,
        currentBookTitle: 'Dune',
        positionSec: posSec,
        isPlaying: true,
        isActivePlayer: true,
        lastSeenAt: iso
      }
    ];

    app1._updateDevicesAndPrompt(makeRemoteDevice(120, '2026-11-22T01:00:00Z'));
    app1.render();
    assert.ok(env1.rootEl.querySelector('.continue-device-card'));

    // Click X dismiss
    env1.rootEl.querySelector('[data-action="dismiss-remote-prompt"]').click();
    assert.equal(app1.state.remotePlaybackPrompt, null);
    assert.ok(globalThis.localStorage.getItem('multiplayer_dismissed_continue_v1'));

    // Subsequent 14-second heartbeat with updated positionSec & lastSeenAt MUST NOT reopen banner
    app1._updateDevicesAndPrompt(makeRemoteDevice(134, '2026-11-22T01:00:14Z'));
    assert.equal(app1.state.remotePlaybackPrompt, null, 'Heartbeat must not reopen dismissed Continue banner');

    // Fresh app instance (simulating reload) MUST still stay dismissed for same device+book
    app1.destroy();
    app1 = null;
    app2 = new AudiobookApp(env1.rootEl);
    app2.guestLocalMode = true;
    app2.syncService.deviceId = 'dev_android';
    app2.books = [makeBook(1, { title: 'Dune', author: 'Frank Herbert' }), makeBook(2, { title: 'Dune Messiah', author: 'Frank Herbert' })];
    app2._updateDevicesAndPrompt(makeRemoteDevice(180, '2026-11-22T01:01:00Z'));
    assert.equal(app2.state.remotePlaybackPrompt, null, 'Reload must remember dismissed Continue banner');

    // Switching remote device to a DIFFERENT book re-shows banner
    app2._updateDevicesAndPrompt([
      {
        deviceId: 'dev_pc',
        deviceName: 'Windows PC',
        currentBookKey: app2.books[1].bookKey,
        currentBookTitle: 'Dune Messiah',
        positionSec: 15,
        isPlaying: true,
        isActivePlayer: true,
        lastSeenAt: '2026-11-22T01:02:00Z'
      }
    ]);
    assert.equal(app2.state.remotePlaybackPrompt?.bookKey, app2.books[1].bookKey);
  } finally {
    app1?.destroy?.();
    app2?.destroy?.();
    env1.restore();
  }
});

test('Settings > Advanced Settings houses the 6 tucked actions, Profile popover is uncluttered, Context Menu & Back button work', async () => {
  const env = createDomEnv({ innerWidth: 390 });
  let app = null;
  try {
    app = new AudiobookApp(env.rootEl);
    app._enrichSingleBookInBackground = async () => {};
    app._runBackgroundMetadataEnrichment = async () => {};
    app.guestLocalMode = true;
    const book1 = makeBook(1, { title: 'Book One', author: 'Auth One', series: '' });
    const book2 = makeBook(2, { title: 'Book Two', author: 'Auth Two', series: '' });
    const pod = {
      bookKey: 'podcast:show1',
      title: 'My Show',
      author: 'Host',
      isPodcast: true,
      mediaType: 'podcast',
      sources: ['podcast'],
      chapters: [{ index: 0, episodeId: 'ep-1', title: 'Ep 1', durationSec: 600 }],
      episodeProgress: {}
    };
    app.books = [book1, book2, pod];
    app.state.activeBookKey = book1.bookKey;

    // 1. Profile popover has Settings & Devices, NOT the 6 tucked actions or Midnight
    app.state.profileOpen = true;
    app.render();
    const profileSlot = env.rootEl.querySelector('#appOverlayProfile');
    assert.ok(profileSlot.querySelector('[data-action="open-settings-modal"]'));
    assert.ok(profileSlot.querySelector('[data-action="open-devices-modal"]'));
    assert.equal(profileSlot.querySelector('[data-action="trigger-local-folder"]'), null);
    assert.equal(profileSlot.querySelector('[data-action="trigger-local-files"]'), null);
    assert.equal(profileSlot.querySelector('[data-action="connect-drive"]'), null);
    assert.equal(profileSlot.querySelector('[data-action="open-cover-search"]'), null);
    assert.equal(profileSlot.querySelector('[data-action="auto-match-tags"]'), null);
    assert.equal(profileSlot.querySelector('[data-action="open-wipe-synced-modal"]'), null);
    assert.doesNotMatch(profileSlot.textContent, /Midnight/);

    // 2. Open Settings -> expand Advanced Settings -> all 6 actions present + auto-sync toggle
    profileSlot.querySelector('[data-action="open-settings-modal"]').click();
    assert.equal(app.state.settingsModalOpen, true);
    const settingsSlot = env.rootEl.querySelector('#appOverlaySettings');
    assert.ok(settingsSlot.querySelector('[data-action="toggle-auto-drive-sync"]'));
    settingsSlot.querySelector('[data-action="toggle-advanced-settings"]').click();
    assert.ok(settingsSlot.querySelector('[data-action="trigger-local-folder"]'));
    assert.ok(settingsSlot.querySelector('[data-action="trigger-local-files"]'));
    assert.ok(settingsSlot.querySelector('[data-action="connect-drive"]'));
    assert.ok(settingsSlot.querySelector('[data-action="open-cover-search"]'));
    assert.ok(settingsSlot.querySelector('[data-action="auto-match-tags"]'));
    assert.ok(settingsSlot.querySelector('[data-action="open-wipe-synced-modal"]'));

    // 3. Context Menu for Podcast & Audiobook + handlers
    app.state.settingsModalOpen = false;
    app.openContextMenuForTarget({ attr: 'data-book-key', value: pod.bookKey }, { x: 40, y: 80, fromTouch: true });
    const cmSlot = env.rootEl.querySelector('#appOverlayContextMenu');
    assert.ok(cmSlot.querySelector('[data-action="unsubscribe-podcast"]'));
    assert.ok(cmSlot.querySelector('[data-action="mark-podcast-played"]'));
    cmSlot.querySelector('[data-action="mark-podcast-played"]').click();
    assert.equal(app.state.contextMenu, null);
    assert.equal(app.books.find((b) => b.bookKey === pod.bookKey).episodeProgress['ep-1'].completed, true);

    // 4. Paused switch & zero-blink no-enter-anim on same-view selection
    let loadCalls = [];
    app.audioEngine.loadBook = async (b) => {
      loadCalls.push(b.bookKey);
      app.audioEngine.currentBook = b;
    };
    app.audioEngine.play = async () => {};
    app.render();
    await app.selectBook(book2.bookKey, false);
    assert.equal(app.state.activeBookKey, book2.bookKey);
    assert.ok(app._lastLocalPlayAt > 0, 'Paused book selection must update _lastLocalPlayAt');
    assert.equal(loadCalls.at(-1), book2.bookKey);
    assert.ok(
      env.rootEl.querySelector('#mobileMainScroll')?.classList.contains('no-enter-anim'),
      'Same-view selection on mobile must apply no-enter-anim to eliminate blink'
    );

    // 5. Android Back button closes overlays in priority order and requires double-press at root
    assert.equal(window.__audiobookApp, app);
    app.state.mobileSheetOpen = true;
    app.state.settingsModalOpen = true;
    app.openContextMenuForTarget({ attr: 'data-book-key', value: book1.bookKey });
    assert.equal(app.handleBackPress(), true);
    assert.equal(app.state.contextMenu, null);
    assert.equal(app.handleBackPress(), true);
    assert.equal(app.state.settingsModalOpen, false);
    assert.equal(app.handleBackPress(), true);
    assert.equal(app.state.mobileSheetOpen, false);

    // At root: 1st back press shows toast & returns true; 2nd within 2s returns false
    assert.equal(app.handleBackPress(), true);
    assert.match(app.state.statusToast?.message || '', /Press back again to exit/);
    assert.equal(app.handleBackPress(), false);

    // 6. Removed Drive files confirmation prompt renders, Keep Files suppresses re-prompting, and local token change pushes Drive folder config
    app.state.pendingDriveRemovals = [book1];
    app.render();
    const removalSlot = env.rootEl.querySelector('#appOverlayDriveRemovals');
    assert.ok(removalSlot.querySelector('[data-action="confirm-drive-removals"]'));
    assert.ok(removalSlot.querySelector('[data-action="dismiss-drive-removals"]'));
    removalSlot.querySelector('[data-action="dismiss-drive-removals"]').click();
    assert.equal(app.state.pendingDriveRemovals.length, 0);
    assert.ok(app.books.some((b) => b.bookKey === book1.bookKey), 'Keep Files must preserve book');
    assert.ok(
      app._dismissedDriveRemovalKeys.has(book1.bookKey),
      'Keep Files must record bookKey to prevent 5-min auto-sync re-prompting'
    );

    // 7. Context menu closes immediately on async action before promise settles
    let resolveAsyncDownload;
    app.toggleOfflineDownload = () =>
      new Promise((r) => {
        resolveAsyncDownload = r;
      });
    app.openContextMenuForTarget({ attr: 'data-book-key', value: book1.bookKey }, { fromTouch: true });
    assert.ok(env.rootEl.querySelector('#appOverlayContextMenu')?.innerHTML);
    env.rootEl
      .querySelector('#appOverlayContextMenu')
      .querySelector('[data-action="toggle-download"]')
      .click();
    assert.equal(app.state.contextMenu, null);
    assert.equal(
      env.rootEl.querySelector('#appOverlayContextMenu').innerHTML,
      '',
      'Context menu must close immediately before async action finishes'
    );
    resolveAsyncDownload?.();

    // 8. Mobile handleBackPress ignores stale desktopView === 'detail'
    app.state.layoutMode = 'android';
    app.state.desktopView = 'detail';
    app._lastBackPressAt = 0;
    app._lastRootBackPressAt = 0;
    assert.equal(app.handleBackPress(), true);
    assert.match(app.state.statusToast?.message || '', /Press back again to exit/);
    assert.equal(app.handleBackPress(), false);
  } finally {
    app?.destroy?.();
    env.restore();
  }
});

test('Android app open after 1-hour Google token expires with valid Supabase refresh_token keeps needsDriveSyncReauth = false and never renders Reconnect Google Sync', async () => {
  const env = createDomEnv({ innerWidth: 390 });
  let app = null;
  try {
    env.mockWindow.location = {
      origin: 'https://localhost',
      protocol: 'https:',
      pathname: '/',
      search: '',
      hash: ''
    };
    let silentOAuthUrl = null;
    env.mockWindow.Capacitor = { isNativePlatform: () => true };
    env.mockWindow.AudiobookOAuthNative = {
      loadAuthSession: () => null,
      saveAuthSession: () => true,
      clearAuthSession: () => true,
      consumePendingResult: () => null,
      startSilentGoogleOAuth: (url) => {
        silentOAuthUrl = url;
        // Simulate silent refresh returning login_required (no Google cookie in WebView)
        const state = new URL(url).searchParams.get('state');
        env.mockWindow.__onAndroidGoogleOAuthResult?.({ error: 'login_required', state });
      }
    };

    const twoHoursAgo = Date.now() - 2 * 3600 * 1000;
    const persistedSession = {
      access_token: 'expired-supa-jwt',
      refresh_token: 'long-lived-supa-refresh',
      auth_mode: 'google_oauth',
      provider_token: 'ya29.expired-2h-ago',
      googleAccessToken: 'ya29.expired-2h-ago',
      googleTokenObtainedAt: twoHoursAgo,
      user: {
        id: 'supa-android-user-1',
        email: 'android.listener@gmail.com',
        user_metadata: {
          email: 'android.listener@gmail.com',
          full_name: 'Android Listener'
        }
      }
    };
    globalThis.localStorage.setItem(
      'audiobook_player_supabase_session_v1',
      JSON.stringify(persistedSession)
    );
    globalThis.localStorage.setItem('audiobook_drive_folder_v1', 'folder-abc');

    const fetchedUrls = [];
    app = new AudiobookApp(env.rootEl);
    app._enrichSingleBookInBackground = async () => {};
    app._runBackgroundMetadataEnrichment = async () => {};
    app.syncService.navigatorObj = { onLine: true, userAgent: 'Mozilla/5.0 (Linux; Android 14)' };
    app.syncService.fetchImpl = async (url, init = {}) => {
      fetchedUrls.push(url);
      if (url.endsWith('/auth/v1/user')) {
        return { ok: false, status: 401, async text() { return 'JWT expired'; } };
      }
      if (url.includes('/auth/v1/token?grant_type=refresh_token')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              access_token: 'fresh-supa-jwt',
              refresh_token: 'rotated-supa-refresh',
              expires_in: 3600,
              user: persistedSession.user
            };
          }
        };
      }
      if (url.includes('/rest/v1/audiobook_user_settings')) {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify([
              {
                user_id: 'supa-android-user-1',
                drive_folder_id: 'folder-abc',
                drive_folder_name: 'Audiobooks',
                updated_at: '2026-11-22T00:00:00.000Z'
              }
            ]);
          }
        };
      }
      if (url.includes('googleapis.com/oauth2/v3/userinfo')) {
        throw new Error('Should NOT hit Google userinfo with an already-expired 2h old token');
      }
      if (url.includes('/rest/v1/')) {
        return { ok: true, status: 200, async text() { return '[]'; } };
      }
      throw new Error(`Unexpected fetch: ${url} (${init.method || 'GET'})`);
    };

    let iframeCreated = false;
    env.mockDocument.createElement = (tag) => {
      if (String(tag).toLowerCase() === 'iframe') iframeCreated = true;
      return new MockElement(tag);
    };
    const restored = await app.syncService.restoreSession();
    assert.ok(restored, 'restoreSession must succeed via Supabase refresh_token');
    assert.equal(iframeCreated, false, 'Android Capacitor must NOT fall through to web hidden iframe after native silent OAuth fails');
    assert.equal(app.syncService.isAuthenticated(), true);
    assert.equal(app.syncService.needsDriveSyncReauth, false, 'needsDriveSyncReauth MUST remain false when Supabase is authenticated');
    assert.equal(app.syncService.getGoogleAccessToken(), null, 'Expired 2h Google token must be cleared from memory');
    assert.equal(app.syncService.hasDriveSyncToken(), false);
    assert.ok(silentOAuthUrl && silentOAuthUrl.includes('prompt=none'), 'Android native silent OAuth must be attempted with prompt=none');
    assert.ok(
      !fetchedUrls.some((u) => u.includes('googleapis.com/oauth2/v3/userinfo')),
      'Expired Google token must skip Google userinfo check'
    );

    // _maybeRunAutoDriveSync must skip quietly without calling runGoogleDriveSync or setting needsDriveSyncReauth
    let driveSyncCalled = false;
    app.runGoogleDriveSync = async () => {
      driveSyncCalled = true;
    };
    const autoSynced = await app._maybeRunAutoDriveSync({ force: true });
    assert.equal(autoSynced, false);
    assert.equal(driveSyncCalled, false);
    assert.equal(app.syncService.needsDriveSyncReauth, false);

    // UI banners and empty library card MUST NOT render "Reconnect Google Sync" when Supabase is authenticated
    app.user = app.syncService.getUserProfile();
    app.books = [];
    app.state.needsDriveSyncReauth = true; // even if stale flag were set, authenticated Supabase suppresses banner
    app.render();
    assert.equal(env.rootEl.querySelector('.sync-reauth-banner'), null, 'Workspace banner must NOT show Reconnect Google Sync');
    assert.equal(env.rootEl.querySelector('[data-action="reauth-drive-sync"]'), null, 'Empty library card must NOT show Reconnect Google button');
    assert.doesNotMatch(env.rootEl.innerHTML, /Reconnect Google Sync/);
  } finally {
    app?.destroy?.();
    env.restore();
  }
});

test('Android handleBackPress closes modals (including driveModal.loading), syncProgress, expanded series, and podcasts tab first, deduplicates native+popstate, and requires double-tap within 2500ms at root', () => {
  const env = createDomEnv({ innerWidth: 390 });
  let app = null;
  try {
    const pushedStates = [];
    env.mockWindow.history = {
      state: null,
      pushState: (state) => {
        env.mockWindow.history.state = state;
        pushedStates.push(state);
      }
    };
    let capBackHandler = null;
    env.mockWindow.Capacitor = {
      Plugins: {
        App: {
          addListener: (name, fn) => {
            if (name === 'backButton') capBackHandler = fn;
            return { remove: () => {} };
          }
        }
      }
    };

    app = new AudiobookApp(env.rootEl);
    app._enrichSingleBookInBackground = async () => {};
    app._runBackgroundMetadataEnrichment = async () => {};
    app.guestLocalMode = true;
    app.books = [makeBook(1), makeBook(2)];
    app.state.activeBookKey = app.books[0].bookKey;

    // Binding global inputs registers popstate, cordova backbutton, capacitor backButton, and user-gesture guard
    app._bindGlobalInputs();
    assert.equal(typeof capBackHandler, 'function', 'Capacitor App backButton listener must be registered');
    env.mockDocument.dispatchEvent('pointerdown');
    assert.equal(env.mockWindow.history.state?.multiplayerUserGuard, true, 'User gesture must arm multiplayerUserGuard');

    // Simulating popstate while an overlay is open must push the guard at most once (no duplicate history leak)
    app.state.settingsModalOpen = true;
    env.mockWindow.history.state = null; // browser popped the guard entry before firing popstate
    const pushesBeforePop = pushedStates.length;
    env.mockWindow.dispatchEvent('popstate');
    assert.equal(app.state.settingsModalOpen, false);
    assert.equal(
      pushedStates.length - pushesBeforePop,
      1,
      '_popstateHandler must re-arm history guard once without leaking duplicate history entries'
    );
    app._lastBackPressHandledAt = 0;
    app._lastBackPressSource = '';

    // Open multiple layers including driveModal.loading, syncProgress, expanded series, and podcasts filter
    let aborted = false;
    app._syncAbortController = { abort: () => { aborted = true; } };
    app.state.contextMenu = { type: 'book', bookKey: app.books[0].bookKey, x: 20, y: 20 };
    app.state.driveModal = { open: true, folderId: 'f1', token: 't1', loading: true, error: '' };
    app.state.syncProgress = { active: true, phase: 'drive', percent: 40, currentFolder: 'Books', scannedFolders: 1, discoveredFolders: 2, booksFound: 1 };
    app.state.settingsModalOpen = true;
    app.state.profileOpen = true;
    app.state.mobileSheetOpen = true;
    app.state.searchQuery = 'dune';
    app.state.expandedSeries = new Set(['Series Saga']);
    app.state.filterSource = 'podcasts';

    // 1. Context menu closes first (from native); simultaneous popstate within 300ms MUST be deduplicated
    assert.equal(app.handleBackPress({ source: 'native' }), true);
    assert.equal(app.state.contextMenu, null);
    assert.equal(app.state.driveModal.open, true);
    assert.equal(app.handleBackPress({ source: 'popstate' }), true, 'Simultaneous popstate from same physical tap must be deduplicated');
    assert.equal(app.state.driveModal.open, true, 'Deduplicated popstate must NOT close the next modal layer');

    // 2. Drive modal closes EVEN WHEN loading: true (and aborts in-flight sync)
    assert.equal(app.handleBackPress({ source: 'native' }), true);
    assert.equal(app.state.driveModal.open, false);
    assert.equal(app.state.driveModal.loading, false);
    assert.equal(aborted, true, 'Closing loading driveModal must abort in-flight sync');

    // 3. syncProgress.active closes next
    assert.equal(app.handleBackPress({ source: 'native' }), true);
    assert.equal(app.state.syncProgress.active, false);

    // 4. settingsModalOpen -> profileOpen -> mobileSheetOpen
    assert.equal(app.handleBackPress({ source: 'native' }), true);
    assert.equal(app.state.settingsModalOpen, false);
    assert.equal(app.handleBackPress({ source: 'native' }), true);
    assert.equal(app.state.profileOpen, false);
    assert.equal(app.handleBackPress({ source: 'native' }), true);
    assert.equal(app.state.mobileSheetOpen, false);

    // 5. searchQuery -> expandedSeries -> podcasts filter tab
    assert.equal(app.handleBackPress({ source: 'native' }), true);
    assert.equal(app.state.searchQuery, '');
    assert.equal(app.handleBackPress({ source: 'native' }), true);
    assert.equal(app.state.expandedSeries.size, 0);
    assert.equal(app.handleBackPress({ source: 'native' }), true);
    assert.equal(app.state.filterSource, 'audiobooks');

    // 6. Now at root home screen: 1st tap returns true + toast; simultaneous popstate is deduplicated (does NOT exit!)
    assert.equal(app.handleBackPress({ source: 'native' }), true);
    assert.match(app.state.statusToast?.message || '', /Press back again to exit/);
    assert.equal(app.handleBackPress({ source: 'popstate' }), true, 'Duplicate popstate on 1st root tap must NOT trigger exit');

    // 7. 2nd genuine tap at root within 2500ms from same source returns false (confirmed exit)
    assert.equal(app.handleBackPress({ source: 'native' }), false);
    assert.equal(app._lastRootBackPressAt, 0);

    // 8. Tap after >2500ms expires window and shows toast again instead of exiting
    app._lastRootBackPressAt = Date.now() - 2600;
    app._lastBackPressAt = app._lastRootBackPressAt;
    assert.equal(app.handleBackPress({ source: 'native' }), true);
    assert.match(app.state.statusToast?.message || '', /Press back again to exit/);
  } finally {
    app?.destroy?.();
    env.restore();
  }
});
