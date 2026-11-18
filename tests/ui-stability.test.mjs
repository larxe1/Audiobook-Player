import test from 'node:test';
import assert from 'node:assert/strict';
import { AudiobookApp } from '../src/ui/app.js';
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

  const mockDocument = {
    body: bodyEl,
    documentElement: docEl,
    activeElement: null,
    readyState: 'complete',
    getElementById: (id) => (id === 'appRoot' ? rootEl : rootEl.querySelector(`#${id}`)),
    querySelector: (sel) => rootEl.querySelector(sel),
    querySelectorAll: (sel) => rootEl.querySelectorAll(sel),
    addEventListener: () => {}
  };

  const mockWindow = {
    innerWidth,
    location: { search: '', pathname: '/', hash: '' },
    addEventListener: () => {},
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
    restore() {
      globalThis.window = prevWindow;
      globalThis.document = prevDocument;
      globalThis.localStorage = prevStorage;
    }
  };
}

function makeBook(idx, overrides = {}) {
  return {
    bookKey: `book-${idx}`,
    title: `Series Saga: Book ${idx}`,
    author: `Author ${idx}`,
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
    app.state.activeBookKey = 'book-1';
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
    app.state.activeBookKey = 'book-1';
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

    // Change filter: #book-list scroll resets to 0
    const driveFilterBtn = env.rootEl.querySelector('[data-action="set-filter"][data-filter="drive"]');
    driveFilterBtn.click();
    assert.equal(env.rootEl.querySelector('#book-list').scrollTop, 0, '#book-list resets when filter changes');

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

    // Notification shade gets no-enter-anim on subsequent re-renders while open
    app.state.mobileSheetOpen = false;
    app.state.shadeOpen = true;
    app.render();
    const shadeFirst = env.rootEl.querySelector('.notif-shade');
    assert.ok(shadeFirst);
    assert.equal(shadeFirst.classList.contains('no-enter-anim'), false);
    app.state.snapshot = { ...app.state.snapshot, playing: true };
    app.render();
    const shadeSecond = env.rootEl.querySelector('.notif-shade');
    assert.equal(shadeSecond.classList.contains('no-enter-anim'), true);

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
    app.state.activeBookKey = 'book-1';
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
