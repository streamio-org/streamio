import { api, apiFetch, logout, escapeHtml, parseShowKey } from '/scripts/auth.js';
import { renderReactionBar, attachReactionHandlers, initShareBadge, refreshShareBadge } from '/scripts/social.js';
import { getName as providerLabel } from '/scripts/provider-names.js';
import { ICON_ALERT, ICON_FILM, ICON_BOOKMARK, ICON_CLOCK, ICON_SETTINGS, ICON_MAIL, ICON_GLOBE, ICON_CHECK_CIRCLE, ICON_X_CIRCLE, ICON_LOADER } from '/scripts/icons.js';

// ── Helpers ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);
let toastTimer;
function toast(msg, type = 'success') {
  const t = $('toast');
  t.className = 'show ' + type;
  $('toastMsg').textContent = msg;
  t.querySelector('.toast-dot').style.background = type === 'success' ? '#46d369' : '#e50914';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3000);
}

function openModal(id) { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }

// Inline onerror="" attributes can't safely embed raw SVG markup (its own
// quotes terminate the attribute early and corrupt the surrounding HTML), so
// broken poster images fall back through this global handler instead.
window.__posterFallback = function (imgEl) {
  const span = document.createElement('span');
  span.innerHTML = ICON_FILM;
  imgEl.replaceWith(span);
};

function relativeDate(d) {
  const diff = Date.now() - new Date(d).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  < 60)  return `${mins}m ago`;
  if (hours < 24)  return `${hours}h ago`;
  if (days  < 365) return `${days}d ago`;
  return new Date(d).toLocaleDateString();
}

function buildQuery(params) {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') usp.set(k, v);
  });
  const s = usp.toString();
  return s ? `?${s}` : '';
}

const SHOW_FETCH_CONCURRENCY = 4;
const SHOW_FETCH_RETRIES = 2;
const SHOW_FETCH_RETRY_DELAY_MS = 500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Marks a row the server refused as 18+. Distinct from a null (failed lookup),
// which is transient and worth retrying — this one never will be, and the row
// has to disappear rather than render as a bare show_id with no poster.
const GATED = Symbol('gated');

async function fetchShow(provider, showId) {
  for (let attempt = 0; attempt <= SHOW_FETCH_RETRIES; attempt++) {
    try {
      const data = await api(`/api/shows/${encodeURIComponent(showId)}?provider=${encodeURIComponent(provider)}`);
      const show = data?.data ?? data;
      if (show && show.title) return show;
    } catch (err) {
      if (err.message === 'Adult content disabled') return GATED;
    }
    if (attempt < SHOW_FETCH_RETRIES) await sleep(SHOW_FETCH_RETRY_DELAY_MS * (attempt + 1));
  }
  return null;
}

async function runWithConcurrency(tasks, limit) {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const task = queue.shift();
      await task();
    }
  });
  await Promise.all(workers);
}

// Fetches show details for any item not yet in showCache. Failed lookups are
// left unset (not poisoned) so a later call — e.g. re-opening the tab — retries them.
async function hydrateShowCache(items) {
  const uniqueKeys = [...new Set(items.map(i => `${i.provider}:${i.show_id}`))]
    .filter(key => !(key in showCache));

  await runWithConcurrency(
    uniqueKeys.map(key => async () => {
      const { provider, showId } = parseShowKey(key);
      const show = await fetchShow(provider, showId);
      if (show) showCache[key] = show;
    }),
    SHOW_FETCH_CONCURRENCY
  );
}

/**
 * Drops entries the server refused as 18+.
 *
 * The library endpoints already filter what they can, but a row only carries
 * `{ provider, show_id }` — a title flagged 18+ is only recognisable once its
 * details come back, which is here.
 */
function withoutGated(items) {
  return items.filter(i => showCache[`${i.provider}:${i.show_id}`] !== GATED);
}

// Re-attempts show lookups that failed on a previous load (e.g. transient
// scraper errors) and re-renders only if any of them now succeeded.
async function retryMissingShows(items, renderFn) {
  const missingBefore = items.filter(i => !(`${i.provider}:${i.show_id}` in showCache)).length;
  if (missingBefore === 0) return;
  await hydrateShowCache(items);
  const missingAfter = items.filter(i => !(`${i.provider}:${i.show_id}` in showCache)).length;
  if (missingAfter < missingBefore) renderFn(items);
}

function populateProviderOptions(items, selectId) {
  items.forEach(i => knownProviders.add(i.provider));
  const sel = $(selectId);
  if (!sel) return;
  const current = sel.value;
  const opts = ['<option value="">All providers</option>']
    .concat([...knownProviders].sort().map(p => `<option value="${p}">${p}</option>`));
  sel.innerHTML = opts.join('');
  sel.value = current;
}

function memberSince(d) {
  return 'Member since ' + new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
}

// ── State ────────────────────────────────────────────────────
let isAdmin = false;
let user   = null;
let showCache = {};
const knownProviders = new Set();

const PAGE_SIZE = 24;          // one full row of the grid at every breakpoint
const SCROLL_MARGIN_PX = 400;  // start the next page this far before the end

/**
 * The three paginated library tabs.
 *
 * Watchlist, favorites and history differ only in their endpoints, markup and
 * counters, so one loader drives all three rather than three near-copies that
 * drift. `data` is the authoritative list for each tab — nothing keeps a
 * parallel copy.
 */
const lists = {
  wl: {
    endpoint: '/api/account/watchlist',
    contentId: 'watchlistContent',
    wrapId: 'wlLoadMoreWrap',
    sentinelId: 'wlSentinel',
    providerSelectId: 'wlProviderFilter',
    errorLabel: 'watchlist',
  },
  fv: {
    endpoint: '/api/account/favorites',
    contentId: 'favoritesContent',
    wrapId: 'fvLoadMoreWrap',
    sentinelId: 'fvSentinel',
    providerSelectId: 'fvProviderFilter',
    errorLabel: 'favorites',
  },
  hist: {
    endpoint: '/api/account/history',
    contentId: 'historyContent',
    wrapId: 'loadMoreWrap',
    sentinelId: 'histSentinel',
    providerSelectId: 'histProviderFilter',
    errorLabel: 'history',
  },
};

for (const list of Object.values(lists)) {
  Object.assign(list, {
    data: [],
    filters: {},
    offset: 0,
    total: null,      // from X-Total-Count; null until the first page lands
    exhausted: false,
    loading: false,
    filling: false,
    inflight: null,  // the page currently in flight, so a second caller can join it
    generation: 0,   // bumped on reset, so an in-flight page can be discarded
  });
  list.searchEndpoint = `${list.endpoint}/search`;
}

// ── Paging ───────────────────────────────────────────────────

/**
 * Like `api()`, but also returns the listing's full size.
 *
 * The library endpoints answer with a bare JSON array and carry the total in an
 * `X-Total-Count` header, so the count survives paging without changing the
 * response shape for any other client. `apiFetch` is used directly because
 * `api()` discards the response object along with its headers.
 */
async function fetchPage(url) {
  const res = await apiFetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  const items = await res.json();
  // An absent header must stay null, not fall through to Number(null) === 0 and
  // report an empty library.
  const num = name => {
    const raw = res.headers.get(name);
    const n = raw === null || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  // `rows` is what the query read; `items` is what survived 18+ filtering and
  // can be shorter. Paging must follow `rows` — see X-Page-Rows on the server.
  return { items, total: num('X-Total-Count'), rows: num('X-Page-Rows') ?? items.length };
}

/** True while the sentinel is on screen (or nearly), and its tab is visible. */
function sentinelInView(list) {
  const el = $(list.sentinelId);
  // An inactive tab panel is display:none, which nulls offsetParent — that
  // alone keeps a hidden tab from paging itself in the background.
  if (!el || !el.offsetParent) return false;
  const rect = el.getBoundingClientRect();
  return rect.top < window.innerHeight + SCROLL_MARGIN_PX && rect.bottom > -SCROLL_MARGIN_PX;
}

/**
 * Keeps pulling pages while the sentinel stays in view.
 *
 * An IntersectionObserver only fires on a *transition*, so a page that lands
 * shorter than the viewport — the first one, or one whose rows were mostly
 * dropped as 18+ — would otherwise leave the sentinel parked on screen with
 * nothing left to retrigger it.
 */
async function fillViewport(list) {
  if (list.filling) return;
  list.filling = true;
  try {
    while (!list.exhausted && sentinelInView(list)) {
      const before = list.offset;
      await loadPage(list);
      if (list.offset === before) break;  // a failed or empty page — don't spin
    }
  } finally {
    list.filling = false;
  }
}

function observeSentinel(list) {
  if (typeof IntersectionObserver === 'undefined') return;  // Load More still works
  const el = $(list.sentinelId);
  if (!el) return;
  list.observer = new IntersectionObserver(
    entries => { if (entries.some(e => e.isIntersecting)) fillViewport(list); },
    { rootMargin: `${SCROLL_MARGIN_PX}px` }
  );
  list.observer.observe(el);
}

/**
 * Fetches one page and appends it. `reset` starts the listing over.
 *
 * A caller that arrives while a page is already in flight **joins** it instead
 * of giving up. Bailing looked harmless but stalled the scroll: the first page
 * takes a while (every row is hydrated through `/api/shows/:id`), so a reader
 * who reaches the bottom during it triggers the observer, gets dropped — and
 * because the sentinel then just sits on screen, no further intersection ever
 * fires to try again.
 *
 * A reset always goes through, even mid-flight: changing a filter while page
 * one is still loading has to win, or the list keeps the old filter's rows and
 * appears to ignore the change. The in-flight page is discarded by generation
 * rather than cancelled, so its response can't land on top of the new listing.
 */
function loadPage(list, opts = {}) {
  if (list.loading && !opts.reset) return list.inflight ?? Promise.resolve();
  const p = fetchAndAppend(list, opts);
  list.inflight = p;
  return p;
}

async function fetchAndAppend(list, { reset = false } = {}) {
  if (reset) {
    list.generation++;
    list.offset = 0;
    list.data = [];
    list.total = null;
    list.exhausted = false;
  }
  if (list.exhausted) return;

  const gen = list.generation;
  const stale = () => gen !== list.generation;
  list.loading = true;
  try {
    const qs = buildQuery({ ...list.filters, limit: PAGE_SIZE, offset: list.offset });
    const endpoint = Object.keys(list.filters).length ? list.searchEndpoint : list.endpoint;
    const { items, total, rows } = await fetchPage(`${endpoint}${qs}`);
    if (stale()) return;

    // Both of these follow the rows the server *read*, never the array length:
    // 18+ filtering happens after the LIMIT, so a page of 24 can arrive as 21.
    // Stepping by 21 would re-request — and duplicate — the three that were
    // dropped, and would read a full page as the last one.
    list.offset   += rows;
    list.exhausted = rows < PAGE_SIZE;
    if (total !== null) list.total = total;

    await hydrateShowCache(items);
    if (stale()) return;

    list.data = [...list.data, ...withoutGated(items)];
    populateProviderOptions(list.data, list.providerSelectId);
    list.render(list.data);
    updateListCounts(list);
  } catch {
    // A failed *first* page has nothing to show but the error; a failed later
    // one must not wipe out the rows already on screen.
    if (!stale() && !list.data.length) {
      $(list.contentId).innerHTML = `<div class="empty"><div class="empty-icon">${ICON_ALERT}</div><h3>Couldn't Load</h3><p>Failed to load ${list.errorLabel}.</p></div>`;
      updateListCounts(list);
    }
  } finally {
    // A superseded page leaves both flags to the newer call that owns them.
    if (!stale()) {
      list.loading = false;
      const wrap = $(list.wrapId);
      if (wrap) wrap.style.display = list.exhausted ? 'none' : 'block';
    }
  }
}

/**
 * Syncs a tab's badge and subtitle.
 *
 * The count is the server's total, not the number of rows loaded so far, so it
 * reads correctly from the first page. History has no counter of its own.
 */
function updateListCounts(list) {
  if (!list.countId) return;
  const n = list.total ?? list.data.length;
  $(list.countId).textContent = n;
  $(list.subtitleId).textContent = `${n} saved show${n !== 1 ? 's' : ''}`;
}

lists.wl.countId    = 'wlCount';
lists.wl.subtitleId = 'wlSubtitle';
lists.fv.countId    = 'fvCount';
lists.fv.subtitleId = 'fvSubtitle';

// ── Boot ─────────────────────────────────────────────────────
async function boot() {
  try {
    user = await api('/api/account/me');
    renderHero(user);
    loadFavorites();
    loadWatchlist();
    initShareBadge();
    checkAdminAccess();
  } catch (e) {
    // Not authed — redirect to login
    window.location.href = '/login?redirect=/account';
  }
}

// The only way the client knows whether the current user is a server admin
// is to probe an admin-gated endpoint — there's no admin flag on the user
// object. A plain 403 means "not an admin," so the tab stays hidden.
//
// The two failures that are NOT that are worth telling apart, because both
// used to land in the same bare `catch` and look identical to the user (the
// panel simply isn't there):
//
//   reason "email_unverified" — the address IS in ADMIN_EMAILS but has never
//     been verified. Common on an install that upgraded into the verification
//     requirement. Say so, rather than letting the operator conclude
//     ADMIN_EMAILS is broken.
//   503 — the server couldn't reach the database to answer. A blip during page
//     load shouldn't be indistinguishable from "you are not an admin".
async function checkAdminAccess(attempt = 0) {
  try {
    await api('/api/settings/sync');
    isAdmin = true;
    $('adminTabBtn').style.display = '';
  } catch (err) {
    if (err?.reason === 'email_unverified') {
      showAdminUnverifiedNotice(err.message);
      return;
    }
    if (err?.status >= 500 && attempt < 1) {
      // Retry once, quietly: this is a transient failure, not an answer.
      setTimeout(() => { checkAdminAccess(attempt + 1).catch(() => {}); }, 4000);
    }
    // Anything else — not an admin. Leave the tab hidden.
  }
}

// Rendered into the Preferences pane rather than a toast: an operator who has
// just deployed and can't find the admin panel needs this to still be on
// screen when they go looking, not to have flashed by three seconds earlier.
//
// Attached to the panel, not to #prefsContent — loadPreferences() replaces
// that element's innerHTML wholesale every time the tab is opened, which would
// take the notice with it.
function showAdminUnverifiedNotice(message) {
  const host = $('panel-preferences');
  if (!host || document.getElementById('adminUnverifiedNotice')) return;

  const box = document.createElement('div');
  box.id = 'adminUnverifiedNotice';
  box.className = 'pref-card';
  box.style.cssText = 'border:1px solid rgba(229,9,20,.45);margin-bottom:14px;padding:14px;border-radius:8px;';

  const title = document.createElement('div');
  title.style.cssText = 'font-weight:700;margin-bottom:6px;color:#fff;';
  title.textContent = 'Admin access is waiting on email verification';

  const body = document.createElement('div');
  body.style.cssText = 'font-size:0.85rem;color:var(--muted2);line-height:1.55;';
  body.textContent = message || 'Verify your email address to enable admin access.';

  const help = document.createElement('div');
  help.style.cssText = 'font-size:0.85rem;color:var(--muted2);line-height:1.55;margin-top:8px;';
  const resend = document.createElement('button');
  resend.className = 'btn btn-secondary btn-sm';
  resend.textContent = 'Send me a new verification link';
  resend.addEventListener('click', async () => {
    resend.disabled = true;
    try {
      await api('/api/auth/verify-email/resend', { method: 'POST', body: { email: user.email } });
      help.textContent = 'Sent. Check your inbox, then reload this page.';
    } catch {
      help.textContent = 'Could not send it. Try again in a moment.';
    }
  });

  box.append(title, body, resend, help);
  host.prepend(box);
}

function renderHero(u) {
  $('heroName').textContent   = u.display_name || u.email.split('@')[0];
  $('heroEmail').textContent  = u.email;
  $('avatarInitial').textContent = (u.display_name || u.email)[0].toUpperCase();
  if (u.avatar_url) {
    // Built as DOM rather than markup: both halves are user-set strings, and
    // the fallback used to be an inline onerror handler with one of them
    // interpolated into it.
    const initial = (u.display_name || u.email)[0].toUpperCase();
    const img = document.createElement('img');
    img.src = u.avatar_url;
    img.alt = 'avatar';
    img.addEventListener('error', () => {
      const span = document.createElement('span');
      span.textContent = initial;
      $('avatarEl').replaceChildren(span);
    });
    $('avatarEl').replaceChildren(img);
  }
  if (u.email_verified) $('verifiedBadge').style.display = 'inline-block';
  if (u.created_at)     $('memberSince').textContent = memberSince(u.created_at);

  // Pre-fill profile form
  if ($('displayName')) $('displayName').value = u.display_name || '';
  if ($('emailField'))  $('emailField').value  = u.email;
  if ($('avatarUrl'))   $('avatarUrl').value   = u.avatar_url  || '';
}

function activateList(list, load) {
  if (list.data.length === 0 && !list.loading) { load(); return; }
  retryMissingShows(list.data, list.render);
  fillViewport(list);
}

// ── Tabs ─────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    $(`panel-${tab}`).classList.add('active');

    // A tab only fills its viewport once it's visible — a hidden panel's
    // sentinel never intersects, so pages stop arriving until you open it.
    if (tab === 'watchlist') activateList(lists.wl, loadWatchlist);
    if (tab === 'favorites') activateList(lists.fv, loadFavorites);
    if (tab === 'history')   activateList(lists.hist, () => loadHistory(true));
    if (tab === 'stats')       loadStats();
    if (tab === 'preferences') loadPreferences();
    if (tab === 'social') loadSocialPeople();
    if (tab === 'admin') loadAdminSettings();
  });
});

// ── Profile ──────────────────────────────────────────────────
$('saveProfileBtn').addEventListener('click', async () => {
  const btn = $('saveProfileBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const updated = await api('/api/account/me', {
      method: 'PATCH',
      body: {
        display_name: $('displayName').value.trim() || undefined,
        avatar_url:   $('avatarUrl').value.trim()   || undefined,
      }
    });
    user = updated;
    renderHero(updated);
    toast('Profile saved!');
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Save Changes'; }
});

$('cancelProfileBtn').addEventListener('click', () => {
  if (user) {
    $('displayName').value = user.display_name || '';
    $('avatarUrl').value   = user.avatar_url   || '';
  }
});

$('changePwBtn').addEventListener('click', async () => {
  const np = $('newPw').value, cp = $('confirmPw').value;
  if (!np || !cp) return toast('Fill in new password fields.', 'error');
  if (np !== cp)  return toast('Passwords do not match.', 'error');
  if (np.length < 8) return toast('Password must be at least 8 characters.', 'error');
  // Password change would go via a dedicated endpoint not in this scope
  toast('Password change not yet wired to an endpoint.', 'error');
});

// ── Delete Account ────────────────────────────────────────────
$('deleteAccountBtn').addEventListener('click', () => {
  $('deleteConfirmInput').value = '';
  $('confirmDeleteBtn').disabled = true;
  openModal('deleteModal');
});
$('cancelDeleteBtn').addEventListener('click', () => closeModal('deleteModal'));
$('deleteConfirmInput').addEventListener('input', e => {
  $('confirmDeleteBtn').disabled = e.target.value !== 'DELETE';
});
$('confirmDeleteBtn').addEventListener('click', async () => {
  const btn = $('confirmDeleteBtn');
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    await api('/api/account/me', { method: 'DELETE' });
    toast('Account deleted. Redirecting…');
    setTimeout(() => { window.location.href = '/'; }, 1500);
  } catch (err) {
    toast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Delete Forever';
  }
  closeModal('deleteModal');
});

// ── Watchlist / favorites / history loaders ──────────────────
// Each fetches a page and then tops the list up until the viewport is full,
// so a first page shorter than the screen still ends with a reachable sentinel.
async function loadWatchlist(reset = true) {
  await loadPage(lists.wl, { reset });
  await fillViewport(lists.wl);
}

async function loadFavorites(reset = true) {
  await loadPage(lists.fv, { reset });
  await fillViewport(lists.fv);
}

async function loadHistory(reset = false) {
  await loadPage(lists.hist, { reset });
  await fillViewport(lists.hist);
}

/**
 * One click handler per grid, bound once.
 *
 * Rebinding per render — which is what these tabs used to do — would attach a
 * duplicate handler to every already-rendered card each time a page arrived.
 */
function wireCardGrid(list, { cardSel, removeSel, deleteBase, removedMsg }) {
  $(list.contentId).addEventListener('click', async e => {
    const card = e.target.closest(cardSel);
    if (!card) return;
    const { provider, show: showId } = card.dataset;

    if (!e.target.closest(removeSel)) {
      switchProviderAndGo(provider, showId);
      return;
    }
    e.stopPropagation();
    try {
      await api(`${deleteBase}/${encodeURIComponent(provider)}/${encodeURIComponent(showId)}`, { method: 'DELETE' });
      list.data = list.data.filter(i => !(i.provider === provider && i.show_id === showId));
      if (list.total !== null) list.total = Math.max(0, list.total - 1);
      list.render(list.data);
      updateListCounts(list);
      toast(removedMsg);
      // The grid just got shorter — the sentinel may have risen into view.
      fillViewport(list);
    } catch (err) { toast(err.message, 'error'); }
  });
}

function renderFavorites(items) {
  if (!items.length) {
    $('favoritesContent').innerHTML = `
      <div class="empty">
        <div class="empty-icon">${ICON_BOOKMARK}</div>
        <h3>Nothing Saved Yet</h3>
        <p>Add shows from the catalog to see them here.</p>
        <a href="/catalog" class="btn btn-primary">Browse Catalog</a>
      </div>`;
    return;
  }
  const html = `<div class="favorites-grid">${items.map(item => {
    const show = showCache[`${item.provider}:${item.show_id}`];
    const title = show?.title ?? item.show_id;
    const poster = show?.poster ?? show?.posterUrl ?? null;

    return `
    <div class="fv-card" data-provider="${item.provider}" data-show="${item.show_id}">
      <div class="fv-poster">
        ${poster
          ? `<img src="${poster}" alt="" style="width:100%;height:100%;object-fit:cover;" onerror="window.__posterFallback(this)">`
          : `<span>${ICON_FILM}</span>`}
        <div class="fv-overlay">▶</div>
        <span class="fv-provider-chip">${item.provider}</span>
        <div class="fv-remove" title="Remove" data-provider="${item.provider}" data-show="${item.show_id}">✕</div>
      </div>
      <div class="fv-info">
        <div class="fv-title">${title}</div>
        <div class="fv-meta">Added ${relativeDate(item.added_at)}</div>
      </div>
    </div>`;
  }).join('')}</div>`;
  $('favoritesContent').innerHTML = html;
  // Clicks are handled by the delegated grid handler, not rebound per render.
}

function renderWatchlist(items) {
  if (!items.length) {
    $('watchlistContent').innerHTML = `
      <div class="empty">
        <div class="empty-icon">${ICON_BOOKMARK}</div>
        <h3>Nothing Saved Yet</h3>
        <p>Add shows from the catalog to see them here.</p>
        <a href="/catalog" class="btn btn-primary">Browse Catalog</a>
      </div>`;
    return;
  }
  const html = `<div class="watchlist-grid">${items.map(item => {
    const show = showCache[`${item.provider}:${item.show_id}`];
    const title = show?.title ?? item.show_id;
    const poster = show?.poster ?? show?.posterUrl ?? null;

    return `
    <div class="wl-card" data-provider="${item.provider}" data-show="${item.show_id}">
      <div class="wl-poster">
        ${poster
          ? `<img src="${poster}" alt="" style="width:100%;height:100%;object-fit:cover;" onerror="window.__posterFallback(this)">`
          : `<span>${ICON_FILM}</span>`}
        <div class="wl-overlay">▶</div>
        <span class="wl-provider-chip">${item.provider}</span>
        <div class="wl-remove" title="Remove" data-provider="${item.provider}" data-show="${item.show_id}">✕</div>
      </div>
      <div class="wl-info">
        <div class="wl-title">${title}</div>
        <div class="wl-meta">Added ${relativeDate(item.added_at)}</div>
      </div>
    </div>`;
  }).join('')}</div>`;
  $('watchlistContent').innerHTML = html;
  // Clicks are handled by the delegated grid handler, not rebound per render.
}

// ── History ───────────────────────────────────────────────────
function renderHistory(items) {
  if (!items.length) {
    $('historyContent').innerHTML = `
      <div class="empty">
        <div class="empty-icon">${ICON_CLOCK}</div>
        <h3>No History Yet</h3>
        <p>Start watching to see your progress here.</p>
        <a href="/catalog" class="btn btn-primary">Browse Catalog</a>
      </div>`;
    return;
  }
  const html = `<div class="history-list">${items.map(item => {
    const show = showCache[`${item.provider}:${item.show_id}`];
    const title = show?.title ?? item.show_id;
    const poster = show?.poster ?? show?.posterUrl ?? null;
    const pct = item.progress_seconds > 0 && item.duration_seconds > 0
      ? Math.min(100, (item.progress_seconds / item.duration_seconds) * 100) : 0;
    const epLabel = item.episode_label ?? (item.episode_id ? `Ep. ${item.episode_id}` : null);

    return `
    <div class="history-item" data-show-id="${item.show_id}" data-provider="${item.provider}" data-episode="${item.episode_id || ''}">
      <div class="history-thumb">
        ${poster
          ? `<img src="${poster}" alt="" onerror="window.__posterFallback(this)">`
          : `<span>${ICON_FILM}</span>`}
      </div>
      <div class="history-body">
        <div class="history-title">${title}</div>
        <div class="history-ep">${epLabel ? `${epLabel} · ` : ''}${item.provider}</div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="history-meta">
        <div class="history-date">${relativeDate(item.watched_at)}</div>
        <span class="history-badge ${item.completed ? 'done' : 'prog'}">${item.completed ? '✓ Done' : 'In progress'}</span>
      </div>
      <button class="btn btn-ghost btn-sm btn-icon history-complete" title="Mark as complete" style="flex-shrink:0; margin-left:8px;">✓</button>
      <button class="btn btn-ghost btn-sm btn-icon history-remove" title="Remove" style="flex-shrink:0; margin-left:8px;">✕</button>
    </div>`;
  }).join('')}</div>`;
  $('historyContent').innerHTML = html;
  // Clicks are handled by the delegated list handler, not rebound per render.
}

// Bound once, for the same reason as the watchlist/favorites grids.
$('historyContent').addEventListener('click', async e => {
  const row = e.target.closest('.history-item');
  if (!row) return;
  const { provider, showId, episode } = row.dataset;
  const hist = lists.hist;

  if (e.target.closest('.history-remove')) {
    e.stopPropagation();
    try {
      await api(`/api/account/history/${encodeURIComponent(provider)}/${encodeURIComponent(showId)}${episode ? `/${encodeURIComponent(episode)}` : ''}`, { method: 'DELETE' });
      hist.data = hist.data.filter(h =>
        !(h.provider === provider && h.show_id === showId && (h.episode_id || '') === episode)
      );
      if (hist.total !== null) hist.total = Math.max(0, hist.total - 1);
      renderHistory(hist.data);
      toast('Removed from history.');
      fillViewport(hist);
    } catch (err) { toast(err.message, 'error'); }
    return;
  }

  if (e.target.closest('.history-complete')) {
    e.stopPropagation();
    try {
      await api(`/api/account/history/complete`, {
        method: 'PUT',
        body: { provider, show_id: showId, episode_id: episode || null }
      });
      hist.data = hist.data.map(h =>
        h.provider === provider &&
        h.show_id === showId &&
        (h.episode_id || '') === episode
          ? { ...h, completed: true, progress_seconds: h.duration_seconds ?? h.progress_seconds }
          : h
      );
      renderHistory(hist.data);
      toast('Marked as complete.');
    } catch (err) { toast(err.message, 'error'); }
    return;
  }

  switchProviderAndGo(provider, showId);
});

// ── Paging wiring ────────────────────────────────────────────
lists.wl.render   = renderWatchlist;
lists.fv.render   = renderFavorites;
lists.hist.render = renderHistory;

wireCardGrid(lists.wl, {
  cardSel: '.wl-card', removeSel: '.wl-remove',
  deleteBase: '/api/account/watchlist', removedMsg: 'Removed from watchlist.',
});
wireCardGrid(lists.fv, {
  cardSel: '.fv-card', removeSel: '.fv-remove',
  deleteBase: '/api/account/favorites', removedMsg: 'Removed from favorites.',
});

// The buttons stay as a fallback: they cover a browser without
// IntersectionObserver, and give a way forward if the sentinel is somehow
// never reached.
$('loadMoreBtn').addEventListener('click', () => loadHistory(false));
$('wlLoadMoreBtn').addEventListener('click', () => loadWatchlist(false));
$('fvLoadMoreBtn').addEventListener('click', () => loadFavorites(false));

Object.values(lists).forEach(observeSentinel);

$('clearHistoryBtn').addEventListener('click', async () => {
  if (!confirm('Clear your entire watch history?')) return;
  try {
    await api('/api/account/history', { method: 'DELETE' });
    Object.assign(lists.hist, { data: [], offset: 0, total: 0, exhausted: true });
    renderHistory([]);
    $('loadMoreWrap').style.display = 'none';
    toast('History cleared.');
  } catch (err) { toast(err.message, 'error'); }
});

// ── Preferences ───────────────────────────────────────────────
const PREF_META = {
  autoplay:        { desc: 'Automatically play the next episode' },
  subtitles:       { desc: 'Show subtitles by default' },
  preferred_lang:  { desc: 'Preferred audio/subtitle language' },
  default_quality: { desc: 'Default video quality selection' },
  notifications:   { desc: 'Receive email notifications' },
  // Added with "+ Add Custom" (value true) and enforced server-side.
  adult_content: { desc: 'Show titles in your library flagged 18+' },
};

async function loadPreferences() {
  try {
    const prefs = await api('/api/account/preferences');
    renderPreferences(prefs);
  } catch {
    $('prefsContent').innerHTML = `<div class="empty"><div class="empty-icon">${ICON_ALERT}</div><h3>Couldn't Load</h3><p>Failed to load preferences.</p></div>`;
  }
}

function renderPreferences(prefs) {
  const keys = Object.keys(prefs);
  if (!keys.length) {
    $('prefsContent').innerHTML = `
      <div class="empty">
        <div class="empty-icon">${ICON_SETTINGS}</div>
        <h3>No Preferences Set</h3>
        <p>Use the button above to add custom preferences.</p>
      </div>`;
    return;
  }
  const html = `<div class="pref-grid">${keys.map(key => {
    const meta = PREF_META[key] || {};
    const val  = prefs[key];
    const isBool = typeof val === 'boolean';
    return `
    <div class="pref-row">
      <div class="pref-info">
        <div class="pref-key">${key}</div>
        ${meta.desc ? `<div class="pref-desc">${meta.desc}</div>` : ''}
      </div>
      ${isBool ? `
        <label class="toggle">
          <input type="checkbox" ${val ? 'checked' : ''} data-pref-key="${key}" class="pref-toggle">
          <span class="toggle-slider"></span>
        </label>` : `
        <div class="pref-val">${JSON.stringify(val)}</div>
        <div class="pref-actions">
          <button class="btn btn-ghost btn-sm btn-icon" title="Edit" data-edit-pref="${key}" data-edit-val='${JSON.stringify(val)}'>✎</button>
          <button class="btn btn-danger btn-sm btn-icon" title="Delete" data-delete-pref="${key}">✕</button>
        </div>`}
    </div>`;
  }).join('')}</div>`;
  $('prefsContent').innerHTML = html;

  // Toggle handlers
  document.querySelectorAll('.pref-toggle').forEach(toggle => {
    toggle.addEventListener('change', async e => {
      try {
        await api(`/api/account/preferences/${e.target.dataset.prefKey}`, {
          method: 'PUT', body: { value: e.target.checked }
        });
        toast('Preference saved.');
      } catch (err) { toast(err.message, 'error'); e.target.checked = !e.target.checked; }
    });
  });

  // Edit
  document.querySelectorAll('[data-edit-pref]').forEach(btn => {
    btn.addEventListener('click', () => {
      $('prefModalTitle').textContent = 'Edit Preference';
      $('prefKeyInput').value = btn.dataset.editPref;
      $('prefKeyInput').disabled = true;
      try { $('prefValInput').value = JSON.parse(btn.dataset.editVal); } catch { $('prefValInput').value = btn.dataset.editVal; }
      openModal('prefModal');
    });
  });

  // Delete
  document.querySelectorAll('[data-delete-pref]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.deletePref;
      try {
        await api(`/api/account/preferences/${key}`, { method: 'DELETE' });
        toast(`Preference "${key}" removed.`);
        loadPreferences();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

// ── Social: People ────────────────────────────────────────────
let peopleSearchDebounce;
let followersLoaded = false;
let followingLoaded = false;

// Everything here is another user's profile text, rendered into innerHTML in a
// page that holds the viewer's access token — so every interpolation goes
// through escapeHtml. A display name reaches this function unfiltered from
// whatever that user typed into their profile.
function renderPersonRow(person, { mode }) {
  const name = person.display_name || 'User';
  const initial = escapeHtml(name[0].toUpperCase());
  const avatar = person.avatar_url
    ? `<img src="${escapeHtml(person.avatar_url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`
    : `<span>${initial}</span>`;

  const id = escapeHtml(person.id);
  const nameAttr = escapeHtml(name);

  let actionHtml = '';
  if (mode === 'search') {
    actionHtml = `<button class="btn btn-secondary btn-sm follow-toggle" data-user="${id}" data-name="${nameAttr}" data-following="0">Follow</button>`;
  } else if (mode === 'following') {
    actionHtml = `<button class="btn btn-ghost btn-sm follow-toggle" data-user="${id}" data-name="${nameAttr}" data-following="1">Unfollow</button>`;
  }

  return `
    <div class="person-row" data-user="${id}">
      <div class="person-avatar">${avatar}</div>
      <div class="person-name">${escapeHtml(name)}</div>
      ${actionHtml}
    </div>`;
}

function wireFollowToggles(container) {
  container.querySelectorAll('.follow-toggle').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const userId = btn.dataset.user;
      const isFollowing = btn.dataset.following === '1';
      btn.disabled = true;
      try {
        if (isFollowing) {
          await api(`/api/social/follows/${userId}`, { method: 'DELETE' });
          btn.dataset.following = '0';
          btn.textContent = 'Follow';
          btn.className = 'btn btn-secondary btn-sm follow-toggle';
          toast(`Unfollowed ${btn.dataset.name}.`);
        } else {
          await api(`/api/social/follows/${userId}`, { method: 'POST' });
          btn.dataset.following = '1';
          btn.textContent = 'Unfollow';
          btn.className = 'btn btn-ghost btn-sm follow-toggle';
          toast(`Following ${btn.dataset.name}.`);
        }
        loadFollowCounts();
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
  });
}

async function loadSocialPeople() {
  loadFollowCounts();
  if (!followersLoaded) loadFollowers();
  if (!followingLoaded) loadFollowing();
}

async function loadFollowCounts() {
  try {
    const counts = await api('/api/social/me/follow-counts');
    $('followersCount').textContent = counts.followers;
    $('followingCount').textContent = counts.following;
  } catch { /* ignore */ }
}

async function loadFollowers() {
  try {
    const items = await api(`/api/social/users/${user.id}/followers`);
    followersLoaded = true;
    $('followersList').innerHTML = items.length
      ? items.map((i) => renderPersonRow(i, { mode: 'view' })).join('')
      : `<div class="empty"><div style="color:var(--muted2);font-size:0.85rem;">No followers yet.</div></div>`;
  } catch {
    $('followersList').innerHTML = `<div class="empty"><div style="color:var(--muted2);font-size:0.85rem;">Failed to load followers.</div></div>`;
  }
}

async function loadFollowing() {
  try {
    const items = await api(`/api/social/users/${user.id}/following`);
    followingLoaded = true;
    $('followingList').innerHTML = items.length
      ? items.map((i) => renderPersonRow(i, { mode: 'following' })).join('')
      : `<div class="empty"><div style="color:var(--muted2);font-size:0.85rem;">Not following anyone yet.</div></div>`;
    wireFollowToggles($('followingList'));
  } catch {
    $('followingList').innerHTML = `<div class="empty"><div style="color:var(--muted2);font-size:0.85rem;">Failed to load following.</div></div>`;
  }
}

$('peopleSearchInput').addEventListener('input', (e) => {
  clearTimeout(peopleSearchDebounce);
  const q = e.target.value.trim();
  if (!q) { $('peopleSearchResults').innerHTML = ''; return; }
  peopleSearchDebounce = setTimeout(async () => {
    try {
      const results = await api(`/api/social/users/search?q=${encodeURIComponent(q)}`);
      $('peopleSearchResults').innerHTML = results.length
        ? results.map((r) => renderPersonRow(r, { mode: 'search' })).join('')
        : `<div class="empty"><div style="color:var(--muted2);font-size:0.85rem;">No matches.</div></div>`;
      wireFollowToggles($('peopleSearchResults'));
      // Reflect current follow status for each result.
      results.forEach(async (r) => {
        try {
          const { following } = await api(`/api/social/follows/${r.id}/status`);
          if (!following) return;
          const btn = $('peopleSearchResults').querySelector(`.follow-toggle[data-user="${r.id}"]`);
          if (btn) {
            btn.dataset.following = '1';
            btn.textContent = 'Unfollow';
            btn.className = 'btn btn-ghost btn-sm follow-toggle';
          }
        } catch { /* ignore */ }
      });
    } catch {
      $('peopleSearchResults').innerHTML = `<div class="empty"><div style="color:var(--muted2);font-size:0.85rem;">Search failed.</div></div>`;
    }
  }, 250);
});

// ── Social: Shares ────────────────────────────────────────────
let shareSubtab = 'inbox';
let sharesLoadedFor = { inbox: false, sent: false };

async function loadShares(view) {
  try {
    const items = await api(`/api/social/shares/${view}`);
    await hydrateShowCache(items);
    renderShares(items, view);
    await Promise.all(items.map(async (item) => {
      try {
        const detail = await api(`/api/social/shares/${item.id}`);
        item.sender     = detail.sender;
        item.recipients = detail.recipients;
        item.reactions  = detail.reactions;
      } catch { /* keep summary-level data */ }
    }));
    sharesLoadedFor[view] = true;
    renderShares(items, view);

    // Viewing the inbox marks its shares as read, which lowers the unread badge.
    if (view === 'inbox' && items.length) {
      Promise.all(items.map((item) =>
        api(`/api/social/shares/${item.id}/read`, { method: 'PATCH' }).catch(() => {})
      )).then(refreshShareBadge);
    }
  } catch {
    $('sharesContent').innerHTML = `<div class="empty"><div class="empty-icon">${ICON_ALERT}</div><h3>Couldn't Load</h3><p>Failed to load shares.</p></div>`;
  }
}

function shareContentLabel(item) {
  const show = showCache[`${item.provider}:${item.show_id}`];
  let label = show?.title ?? item.show_id;
  if (item.episode_label) label += ` · ${item.episode_label}`;
  if (item.clip_start_seconds != null && item.clip_end_seconds != null) {
    const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    label += ` (clip ${fmt(item.clip_start_seconds)}–${fmt(item.clip_end_seconds)})`;
  }
  return label;
}

async function updateShareReactionBar(shareId) {
  try {
    const detail = await api(`/api/social/shares/${shareId}`);
    const card = $('sharesContent').querySelector(`.share-card[data-share="${shareId}"] .share-body`);
    if (!card) return;
    const placeholder = card.querySelector('.reaction-bar, .reaction-bar-placeholder');
    placeholder.outerHTML = renderReactionBar(shareId, detail.reactions, user.id);
    // Re-attach only to this share's freshly-rendered bar, not the whole list
    // (avoids stacking duplicate listeners on unrelated, already-wired bars).
    attachReactionHandlers(card, updateShareReactionBar);
  } catch { /* ignore */ }
}

function renderShares(items, view) {
  if (!items.length) {
    $('sharesContent').innerHTML = `
      <div class="empty">
        <div class="empty-icon">${ICON_MAIL}</div>
        <h3>${view === 'inbox' ? 'Nothing Shared With You Yet' : 'You Haven’t Shared Anything Yet'}</h3>
        <p>${view === 'inbox' ? 'Shows, episodes, and clips people share with you will show up here.' : 'Share a show or clip from its details page.'}</p>
      </div>`;
    return;
  }

  const html = items.map((item) => {
    // A share carries two strings the *sender* controls — their display name
    // and the attached message — and lands in the recipient's inbox with no
    // action on their part, so both are escaped here.
    const who = view === 'inbox'
      ? (item.sender ? (item.sender.display_name || 'Someone') : '…')
      : (item.recipients ? item.recipients.map((r) => r.display_name || 'Someone').join(', ') : '…');
    const whoLabel = escapeHtml(view === 'inbox' ? `From ${who}` : `To ${who}`);

    return `
    <div class="share-card" data-share="${escapeHtml(item.id)}" data-provider="${escapeHtml(item.provider)}" data-show="${escapeHtml(item.show_id)}"
      data-episode="${escapeHtml(item.episode_id || '')}" data-clip-start="${escapeHtml(item.clip_start_seconds ?? '')}">
      <div class="share-body">
        <div class="share-who">${whoLabel}</div>
        <div class="share-content-label">${escapeHtml(shareContentLabel(item))}</div>
        ${item.message ? `<div class="share-message">"${escapeHtml(item.message)}"</div>` : ''}
        ${item.reactions ? renderReactionBar(item.id, item.reactions, user.id) : '<div class="reaction-bar-placeholder"></div>'}
      </div>
      <button class="btn btn-ghost btn-sm btn-icon share-delete" title="Delete" data-share="${item.id}">✕</button>
    </div>`;
  }).join('');

  $('sharesContent').innerHTML = `<div class="shares-list">${html}</div>`;

  attachReactionHandlers($('sharesContent'), updateShareReactionBar);

  $('sharesContent').querySelectorAll('.share-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.share-delete') || e.target.closest('.reaction-btn')) return;
      goToSharedContent(card.dataset);
    });
  });

  $('sharesContent').querySelectorAll('.share-delete').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await api(`/api/social/shares/${btn.dataset.share}`, { method: 'DELETE' });
        toast('Share removed.');
        loadShares(shareSubtab);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

// ── Social sub-tab wiring ─────────────────────────────────────
document.querySelectorAll('.social-subtab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.social-subtab').forEach((b) => {
      b.classList.remove('active', 'btn-secondary');
      b.classList.add('btn-ghost');
    });
    btn.classList.remove('btn-ghost');
    btn.classList.add('active', 'btn-secondary');
    const sub = btn.dataset.subtab;
    $('social-people').style.display = sub === 'people' ? 'block' : 'none';
    $('social-shares').style.display = sub === 'shares' ? 'block' : 'none';
    if (sub === 'shares' && !sharesLoadedFor[shareSubtab]) loadShares(shareSubtab);
  });
});

document.querySelectorAll('.share-subtab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.share-subtab').forEach((b) => {
      b.classList.remove('active', 'btn-secondary');
      b.classList.add('btn-ghost');
    });
    btn.classList.remove('btn-ghost');
    btn.classList.add('active', 'btn-secondary');
    shareSubtab = btn.dataset.sharetab;
    loadShares(shareSubtab);
  });
});

function switchProviderAndGo(provider, showId) {
    localStorage.setItem('streamio.provider', provider);
    window.location.href = `/details?id=${encodeURIComponent(showId)}&provider=${encodeURIComponent(provider)}`;
}

// A share pointing at a specific episode or clip range should drop the
// recipient straight into the player at that point, not onto the show's
// overview page — otherwise the clip's timestamp is just inert text.
function goToSharedContent({ provider, show, episode, clipStart }) {
  if (!episode && clipStart === '') {
    switchProviderAndGo(provider, show);
    return;
  }
  localStorage.setItem('streamio.provider', provider);
  const params = new URLSearchParams({ id: show, provider });
  if (episode) params.set('ep', episode);
  if (clipStart !== '') params.set('t', clipStart);
  window.location.href = `/watch?${params.toString()}`;
}

// Add pref btn
$('addPrefBtn').addEventListener('click', () => {
  $('prefModalTitle').textContent = 'Add Preference';
  $('prefKeyInput').value    = '';
  $('prefValInput').value    = '';
  $('prefKeyInput').disabled = false;
  openModal('prefModal');
});
$('cancelPrefBtn').addEventListener('click', () => closeModal('prefModal'));
$('savePrefBtn').addEventListener('click', async () => {
  const key = $('prefKeyInput').value.trim();
  const rawVal = $('prefValInput').value.trim();
  if (!key || rawVal === '') return toast('Key and value are required.', 'error');
  let value;
  try { value = JSON.parse(rawVal); } catch { value = rawVal; }
  try {
    await api(`/api/account/preferences/${key}`, { method: 'PUT', body: { value } });
    toast(`Preference "${key}" saved.`);
    closeModal('prefModal');
    loadPreferences();
  } catch (err) { toast(err.message, 'error'); }
});

// Close modals on backdrop click
document.querySelectorAll('.modal-backdrop').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
});

// ── Watchlist filters ───────────────────────────────────────
$('wlFilterBtn').addEventListener('click', () => {
  lists.wl.filters = {
    search:     $('wlSearch').value.trim(),
    provider:   $('wlProviderFilter').value,
    min_rating: $('wlRatingFilter').value,
  };
  loadWatchlist();
});
$('wlFilterClearBtn').addEventListener('click', () => {
  $('wlSearch').value = '';
  $('wlProviderFilter').value = '';
  $('wlRatingFilter').value = '';
  lists.wl.filters = {};
  loadWatchlist();
});

// ── Favorites filters ───────────────────────────────────────
$('fvFilterBtn').addEventListener('click', () => {
  lists.fv.filters = {
    search:     $('fvSearch').value.trim(),
    provider:   $('fvProviderFilter').value,
    min_rating: $('fvRatingFilter').value,
  };
  loadFavorites();
});
$('fvFilterClearBtn').addEventListener('click', () => {
  $('fvSearch').value = '';
  $('fvProviderFilter').value = '';
  $('fvRatingFilter').value = '';
  lists.fv.filters = {};
  loadFavorites();
});

// ── History filters ──────────────────────────────────────────
$('histFilterBtn').addEventListener('click', () => {
  lists.hist.filters = {
    search:     $('histSearch').value.trim(),
    provider:   $('histProviderFilter').value,
    completed:  $('histStatusFilter').value,
    date_from:  $('histDateFrom').value,
    date_to:    $('histDateTo').value,
  };
  loadHistory(true);
});

document.querySelectorAll('.fvFilter').forEach(el => {
  el.addEventListener('change', () => $('fvFilterBtn').click());
});
document.querySelectorAll('.wlFilter').forEach(el => {
  el.addEventListener('change', () => $('wlFilterBtn').click());
});
document.querySelectorAll('.histFilter').forEach(el => {
  el.addEventListener('change', () => $('histFilterBtn').click());
});

$('histFilterClearBtn').addEventListener('click', () => {
  $('histSearch').value = '';
  $('histProviderFilter').value = '';
  $('histStatusFilter').value = '';
  $('histDateFrom').value = '';
  $('histDateTo').value = '';
  lists.hist.filters = {};
  loadHistory(true);
});



// ── Admin: sync settings + hosting points ───────────────────
let hostingPoints = [];

async function loadAdminSettings() {
  if (!isAdmin) return;
  loadVersionInfo();
  loadUpdateStatus();
  loadUpdateHistory();
  loadClientVersionSettings();
  loadSyncSettings();
  loadHostingPoints();
  loadPowerSettings();
  loadPowerStatus();
}

async function loadSyncSettings() {
  try {
    const settings = await api('/api/settings/sync');
    $('syncEnabledToggle').checked = !!settings.enabled;
    $('syncEnabledLabel').textContent = settings.enabled ? 'Enabled' : 'Disabled';
    $('syncIntervalInput').value = settings.intervalMinutes;
  } catch (err) { toast(err.message, 'error'); }
}

$('syncEnabledToggle').addEventListener('change', () => {
  $('syncEnabledLabel').textContent = $('syncEnabledToggle').checked ? 'Enabled' : 'Disabled';
});

$('saveSyncBtn').addEventListener('click', async () => {
  const interval = parseInt($('syncIntervalInput').value, 10);
  if (!interval || interval < 1) return toast('Interval must be at least 1 minute.', 'error');
  try {
    await api('/api/settings/sync', {
      method: 'PUT',
      body: { enabled: $('syncEnabledToggle').checked, interval_minutes: interval },
    });
    toast('Sync settings saved.');
  } catch (err) { toast(err.message, 'error'); }
});

async function loadHostingPoints() {
  try {
    hostingPoints = await api('/api/settings/hosting-points');
    renderHostingPoints();
  } catch (err) {
    $('hostingPointsContent').innerHTML = `<div class="empty"><div class="empty-icon">${ICON_ALERT}</div><h3>Couldn't Load</h3><p>Failed to load hosting points.</p></div>`;
  }
}

function renderHostingPoints() {
  if (!hostingPoints.length) {
    $('hostingPointsContent').innerHTML = `
      <div class="empty">
        <div class="empty-icon">${ICON_GLOBE}</div>
        <h3>No Hosting Points</h3>
        <p>Add another Streamio server to start syncing library data.</p>
      </div>`;
    return;
  }

  $('hostingPointsContent').innerHTML = `<div class="pref-grid">${hostingPoints.map(hp => `
    <div class="pref-row">
      <div class="pref-info">
        <div class="pref-key">${hp.name}</div>
        <div class="pref-desc">${hp.url}</div>
        <div class="pref-desc">
          ${hp.enabled ? 'Enabled' : 'Disabled'} ·
          ${hp.last_sync_status === 'error'
            ? `last sync failed${hp.last_sync_error ? ': ' + hp.last_sync_error : ''}`
            : hp.last_synced_at ? `last synced ${relativeDate(hp.last_synced_at)}` : 'never synced'}
        </div>
      </div>
      <div class="pref-actions">
        <button class="btn btn-ghost btn-sm btn-icon" title="Edit" data-edit-hp="${hp.id}">✎</button>
        <button class="btn btn-danger btn-sm btn-icon" title="Delete" data-delete-hp="${hp.id}">✕</button>
      </div>
    </div>`).join('')}</div>`;

  document.querySelectorAll('[data-edit-hp]').forEach(btn => {
    btn.addEventListener('click', () => {
      const hp = hostingPoints.find(h => h.id === btn.dataset.editHp);
      if (!hp) return;
      $('hpModalTitle').textContent = 'Edit Hosting Point';
      $('hpModalDesc').textContent = 'Update this hosting point. Leave the secret blank to keep it unchanged.';
      $('saveHpBtn').dataset.editId = hp.id;
      $('hpNameInput').value = hp.name;
      $('hpUrlInput').value = hp.url;
      $('hpSecretInput').value = '';
      $('hpSecretInput').placeholder = 'Leave blank to keep current secret';
      $('hpEnabledField').style.display = '';
      $('hpEnabledInput').checked = hp.enabled;
      openModal('hostingPointModal');
    });
  });

  document.querySelectorAll('[data-delete-hp]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const hp = hostingPoints.find(h => h.id === btn.dataset.deleteHp);
      if (!hp || !confirm(`Remove hosting point "${hp.name}"? This server will stop syncing with it.`)) return;
      try {
        await api(`/api/settings/hosting-points/${hp.id}`, { method: 'DELETE' });
        toast('Hosting point removed.');
        loadHostingPoints();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

$('addHostingPointBtn').addEventListener('click', () => {
  $('hpModalTitle').textContent = 'Add Hosting Point';
  $('hpModalDesc').textContent = "Register another Streamio server to sync library data with.";
  delete $('saveHpBtn').dataset.editId;
  $('hpNameInput').value = '';
  $('hpUrlInput').value = '';
  $('hpSecretInput').value = '';
  $('hpSecretInput').placeholder = 'Leave blank to auto-generate';
  $('hpEnabledField').style.display = 'none';
  openModal('hostingPointModal');
});
$('cancelHpBtn').addEventListener('click', () => closeModal('hostingPointModal'));

$('saveHpBtn').addEventListener('click', async () => {
  const name = $('hpNameInput').value.trim();
  const url = $('hpUrlInput').value.trim();
  const secret = $('hpSecretInput').value.trim();
  if (!name || !url) return toast('Name and URL are required.', 'error');

  const editId = $('saveHpBtn').dataset.editId;
  try {
    if (editId) {
      const body = { name, url, enabled: $('hpEnabledInput').checked };
      if (secret) body.shared_secret = secret;
      await api(`/api/settings/hosting-points/${editId}`, { method: 'PUT', body });
      toast('Hosting point updated.');
      closeModal('hostingPointModal');
      loadHostingPoints();
    } else {
      const body = { name, url };
      if (secret) body.shared_secret = secret;
      const created = await api('/api/settings/hosting-points', { method: 'POST', body });
      closeModal('hostingPointModal');
      loadHostingPoints();
      if (created.shared_secret) {
        $('hpSecretRevealInput').value = created.shared_secret;
        openModal('hpSecretModal');
      }
    }
  } catch (err) { toast(err.message, 'error'); }
});

$('closeHpSecretBtn').addEventListener('click', () => closeModal('hpSecretModal'));
$('copyHpSecretBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('hpSecretRevealInput').value);
    toast('Secret copied to clipboard.');
  } catch {
    $('hpSecretRevealInput').select();
    toast('Select and copy the secret manually.', 'error');
  }
});

// ── Admin: auto-shutdown settings ────────────────────────────
async function loadPowerSettings() {
  try {
    const settings = await api('/api/settings/power');
    $('powerEnabledToggle').checked = !!settings.enabled;
    $('powerEnabledLabel').textContent = settings.enabled ? 'Enabled' : 'Disabled';
    $('powerIdleMinutesInput').value = settings.idleMinutes;
    $('powerMinUptimeInput').value = settings.minUptimeMinutes;
  } catch (err) { toast(err.message, 'error'); }
}

$('powerEnabledToggle').addEventListener('change', () => {
  $('powerEnabledLabel').textContent = $('powerEnabledToggle').checked ? 'Enabled' : 'Disabled';
});

$('savePowerSettingsBtn').addEventListener('click', async () => {
  const idleMinutes = parseInt($('powerIdleMinutesInput').value, 10);
  const minUptimeMinutes = parseInt($('powerMinUptimeInput').value, 10);
  if (isNaN(idleMinutes) || idleMinutes < 0) return toast('Idle minutes must be 0 or more.', 'error');
  if (isNaN(minUptimeMinutes) || minUptimeMinutes < 0) return toast('Min uptime minutes must be 0 or more.', 'error');
  try {
    await api('/api/settings/power', {
      method: 'PUT',
      body: {
        enabled: $('powerEnabledToggle').checked,
        idle_minutes: idleMinutes,
        min_uptime_minutes: minUptimeMinutes,
      },
    });
    toast('Auto-shutdown settings saved.');
    loadPowerStatus();
  } catch (err) { toast(err.message, 'error'); }
});

// ── Admin: power / shutdown ─────────────────────────────────
// A shutdown "request" is just a flag the app sets — the app runs in Docker
// and can't power off the host itself. A separate host-side process
// (power-controller/) polls for that flag and actually runs the poweroff,
// on up to a ~30s delay, so the UI reflects "requested" rather than an
// immediate state change.
async function loadPowerStatus() {
  try {
    const status = await api('/api/settings/power/status');
    if (status.shouldShutdown && status.reason === 'manual') {
      $('powerStatusDesc').textContent = 'Shutdown requested — the server will power off shortly.';
      $('shutdownServerBtn').style.display = 'none';
      $('cancelPendingShutdownBtn').style.display = '';
    } else {
      $('powerStatusDesc').textContent = status.enabled
        ? `Auto-shutdown is enabled after ${status.idleMinutes} min idle. Currently idle for ${Math.floor(status.idleSeconds / 60)} min.`
        : 'Power off the physical machine running this server for everyone. It can only be turned back on via Wake-on-LAN.';
      $('shutdownServerBtn').style.display = '';
      $('cancelPendingShutdownBtn').style.display = 'none';
    }
  } catch (err) {
    $('powerStatusDesc').textContent = 'Failed to load power status.';
  }
}

$('shutdownServerBtn').addEventListener('click', () => {
  $('shutdownConfirmInput').value = '';
  $('confirmShutdownBtn').disabled = true;
  openModal('shutdownModal');
});
$('cancelShutdownModalBtn').addEventListener('click', () => closeModal('shutdownModal'));
$('shutdownConfirmInput').addEventListener('input', e => {
  $('confirmShutdownBtn').disabled = e.target.value !== 'SHUTDOWN';
});
$('confirmShutdownBtn').addEventListener('click', async () => {
  const btn = $('confirmShutdownBtn');
  btn.disabled = true;
  btn.textContent = 'Requesting…';
  try {
    await api('/api/settings/power/shutdown', { method: 'POST' });
    toast('Shutdown requested.');
    closeModal('shutdownModal');
    loadPowerStatus();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Shut Down Now';
  }
});

$('cancelPendingShutdownBtn').addEventListener('click', async () => {
  try {
    await api('/api/settings/power/shutdown/cancel', { method: 'POST' });
    toast('Pending shutdown cancelled.');
    loadPowerStatus();
  } catch (err) { toast(err.message, 'error'); }
});

// ── Admin: version info ──────────────────────────────────────
async function loadVersionInfo() {
  try {
    const info = await api('/api/version');
    const built = info.server.builtAt
      ? new Date(info.server.builtAt).toLocaleString()
      : 'unknown';
    $('versionInfoContent').innerHTML = `
      <div class="pref-grid">
        <div class="pref-row">
          <div class="pref-info">
            <div class="pref-key">Streamio ${escapeHtml(info.server.version)}</div>
            <div class="pref-desc">
              build ${escapeHtml(info.server.commit)} · built ${escapeHtml(built)} ·
              API v${info.api.version}
            </div>
          </div>
        </div>
      </div>`;
  } catch (err) {
    $('versionInfoContent').innerHTML =
      `<div style="color:var(--muted2);font-size:0.85rem;">Failed to load version info.</div>`;
  }
}

// ── Admin: updates ───────────────────────────────────────────
// GET /api/settings/update returns settings *and* live status in one shape,
// so a single call fills both the form and the status box below it.
let updateStatus = null;

async function loadUpdateStatus(force = false) {
  try {
    updateStatus = force
      ? await api('/api/settings/update/check', { method: 'POST' })
      : await api('/api/settings/update');

    $('updateEnabledToggle').checked = !!updateStatus.enabled;
    $('updateEnabledLabel').textContent = updateStatus.enabled ? 'Enabled' : 'Disabled';
    $('updateAutoApplyToggle').checked = !!updateStatus.autoApply;
    $('updateAutoApplyLabel').textContent = updateStatus.autoApply
      ? 'On — install without asking'
      : 'Off — ask first';
    $('updateRepoInput').value = updateStatus.repo || '';

    renderUpdateStatus();
  } catch (err) {
    $('updateStatusDesc').textContent = 'Failed to load update status.';
  }
}

function renderUpdateStatus() {
  const s = updateStatus;
  const desc = $('updateStatusDesc');
  const installBtn = $('installUpdateBtn');
  const cancelBtn = $('cancelUpdateBtn');

  installBtn.style.display = 'none';
  cancelBtn.style.display = 'none';

  if (!s.enabled) {
    desc.innerHTML = `Update checking is off. Running <strong>${escapeHtml(s.currentVersion)}</strong>.`;
    return;
  }
  if (s.lastCheckError) {
    // Most often a private repo with no token, or no published release yet —
    // both look like "nothing available", so say what actually went wrong.
    desc.innerHTML = `
      <span style="color:var(--red);">Couldn't check for updates: ${escapeHtml(s.lastCheckError)}</span><br>
      Running <strong>${escapeHtml(s.currentVersion)}</strong>.`;
    return;
  }
  if (s.shouldUpdate) {
    desc.innerHTML = `
      <strong>Update pending.</strong> ${escapeHtml(s.latest.version)} will be installed by the
      host updater shortly${s.requestedBy ? ` (requested by ${escapeHtml(s.requestedBy)})` : ''}.`;
    cancelBtn.style.display = '';
    return;
  }
  if (s.updateAvailable) {
    desc.innerHTML = `
      <strong>${escapeHtml(s.latest.version)} is available.</strong>
      You're running ${escapeHtml(s.currentVersion)}.
      ${s.latest.url ? `<a href="${escapeHtml(s.latest.url)}" target="_blank" rel="noopener">Release notes ↗</a>` : ''}`;
    installBtn.style.display = '';
    return;
  }
  desc.innerHTML = `
    Up to date — running <strong>${escapeHtml(s.currentVersion)}</strong>${
      s.latest ? `, latest release is ${escapeHtml(s.latest.version)}` : ''
    }.`;
}

$('updateEnabledToggle').addEventListener('change', () => {
  $('updateEnabledLabel').textContent = $('updateEnabledToggle').checked ? 'Enabled' : 'Disabled';
});
$('updateAutoApplyToggle').addEventListener('change', () => {
  $('updateAutoApplyLabel').textContent = $('updateAutoApplyToggle').checked
    ? 'On — install without asking'
    : 'Off — ask first';
});

$('saveUpdateSettingsBtn').addEventListener('click', async () => {
  try {
    await api('/api/settings/update', {
      method: 'PUT',
      body: {
        enabled: $('updateEnabledToggle').checked,
        auto_apply: $('updateAutoApplyToggle').checked,
        repo: $('updateRepoInput').value.trim(),
      },
    });
    toast('Update settings saved.');
    loadUpdateStatus();
  } catch (err) { toast(err.message, 'error'); }
});

$('checkUpdateBtn').addEventListener('click', async () => {
  const btn = $('checkUpdateBtn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    await loadUpdateStatus(true);
    toast(updateStatus?.updateAvailable ? 'An update is available.' : 'Already up to date.');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check for Updates';
  }
});

$('installUpdateBtn').addEventListener('click', () => {
  if (!updateStatus?.latest) return;
  $('updateModalDesc').innerHTML =
    `This installs <strong>${escapeHtml(updateStatus.latest.version)}</strong>, replacing
     ${escapeHtml(updateStatus.currentVersion)}.`;
  openModal('updateModal');
});
$('cancelUpdateModalBtn').addEventListener('click', () => closeModal('updateModal'));

$('confirmUpdateBtn').addEventListener('click', async () => {
  const btn = $('confirmUpdateBtn');
  btn.disabled = true;
  btn.textContent = 'Requesting…';
  try {
    await api('/api/settings/update/apply', { method: 'POST' });
    toast('Update requested.');
    closeModal('updateModal');
    loadUpdateStatus();
    loadUpdateHistory();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Install Now';
  }
});

$('cancelUpdateBtn').addEventListener('click', async () => {
  try {
    await api('/api/settings/update/cancel', { method: 'POST' });
    toast('Pending update cancelled.');
    loadUpdateStatus();
  } catch (err) { toast(err.message, 'error'); }
});

async function loadUpdateHistory() {
  try {
    const rows = await api('/api/settings/update/history');
    if (!rows.length) {
      $('updateHistoryContent').innerHTML =
        `<div style="color:var(--muted2);font-size:0.85rem;">No updates installed yet.</div>`;
      return;
    }
    const icon = {
      ok: `<span class="update-status-icon ok">${ICON_CHECK_CIRCLE}</span>`,
      error: `<span class="update-status-icon error">${ICON_X_CIRCLE}</span>`,
      started: `<span class="update-status-icon started">${ICON_LOADER}</span>`,
    };
    $('updateHistoryContent').innerHTML = `<div class="pref-grid">${rows.map(r => `
      <div class="pref-row">
        <div class="pref-info">
          <div class="pref-key">${icon[r.status] || ''} ${escapeHtml(r.from_version)} → ${escapeHtml(r.to_version)}</div>
          <div class="pref-desc">
            ${escapeHtml(r.trigger)}${r.requested_by ? ` by ${escapeHtml(r.requested_by)}` : ''} ·
            ${relativeDate(r.started_at)}${r.status === 'error' && r.error ? ` · ${escapeHtml(r.error)}` : ''}
          </div>
        </div>
      </div>`).join('')}</div>`;
  } catch (err) {
    $('updateHistoryContent').innerHTML =
      `<div style="color:var(--muted2);font-size:0.85rem;">Failed to load update history.</div>`;
  }
}

// ── Admin: app version policy ────────────────────────────────
async function loadClientVersionSettings() {
  try {
    const s = await api('/api/settings/client-version');
    $('clientLatestInput').value = s.latest || '';
    $('clientMinInput').value = s.minSupported || '';
    $('clientDownloadInput').value = s.downloadUrl || '';
    $('clientNotesInput').value = s.notes || '';
    $('clientEnforceToggle').checked = !!s.enforce;
    updateEnforceLabel();
    renderApkStatus(s);
  } catch (err) { toast(err.message, 'error'); }
}

// `apkUploadedAt`/`apkVersion` are informational only — set by a successful
// upload, never edited directly. The "no longer points at it" note catches
// an admin editing Download URL back to an external link after uploading:
// the file stays on disk (nothing deletes it) but the server stops serving
// it, so this is the only place that fact is visible.
function renderApkStatus(s) {
  const status = $('clientApkStatus');
  if (!s.apkUploadedAt) {
    status.textContent = 'No build hosted on this server — Download URL points elsewhere.';
    return;
  }
  const hosted = (s.downloadUrl || '').endsWith('/api/version/download');
  status.textContent = `Hosted build: v${s.apkVersion || '?'} · uploaded ${relativeDate(s.apkUploadedAt)}` +
    (hosted ? '' : ' — Download URL no longer points at it.');
}

function updateEnforceLabel() {
  const on = $('clientEnforceToggle').checked;
  $('clientEnforceLabel').textContent = on
    ? 'On — outdated apps are blocked'
    : 'Off — only suggest updating';
  $('clientEnforceWarning').style.display = on ? '' : 'none';
}

$('clientEnforceToggle').addEventListener('change', updateEnforceLabel);

$('saveClientVersionBtn').addEventListener('click', async () => {
  const minSupported = $('clientMinInput').value.trim();
  const downloadUrl = $('clientDownloadInput').value.trim();
  // Blocking people without telling them where to get the new build is a
  // dead end for the user, so refuse that combination up front.
  if ($('clientEnforceToggle').checked && !minSupported) {
    return toast('Set a minimum supported version before blocking outdated apps.', 'error');
  }
  if ($('clientEnforceToggle').checked && !downloadUrl) {
    return toast('Set a download URL before blocking outdated apps.', 'error');
  }
  try {
    await api('/api/settings/client-version', {
      method: 'PUT',
      body: {
        latest: $('clientLatestInput').value.trim(),
        min_supported: minSupported,
        download_url: downloadUrl,
        notes: $('clientNotesInput').value.trim(),
        enforce: $('clientEnforceToggle').checked,
      },
    });
    toast('App version policy saved.');
  } catch (err) { toast(err.message, 'error'); }
});

$('uploadApkBtn').addEventListener('click', async () => {
  const input = $('clientApkInput');
  const file = input.files[0];
  if (!file) return toast('Choose a .apk file first.', 'error');

  const btn = $('uploadApkBtn');
  btn.disabled = true;
  btn.textContent = 'Uploading…';
  try {
    const form = new FormData();
    form.append('apk', file);
    const res = await apiFetch('/api/settings/client-version/apk', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    $('clientDownloadInput').value = data.downloadUrl || '';
    renderApkStatus(data);
    input.value = '';
    toast('APK uploaded — Download URL updated below.');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Upload APK';
  }
});

// ── Boot ─────────────────────────────────────────────────────
// ── Stats & badges ───────────────────────────────────────────
// GET /api/account/stats is what *awards* badges server-side, so it is fetched
// fresh each time the tab opens rather than cached with the rest of the page.

let statsState = { loaded: false, loading: false, stats: null, badges: [] };

const CATEGORY_LABELS = {
  time:     'Watch time',
  episodes: 'Episodes',
  movies:   'Movies',
  shows:    'Shows',
  streak:   'Streaks',
  library:  'Library',
  ratings:  'Ratings',
  social:   'Social',
  explorer: 'Discovery',
};

function formatWatchTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(s / 3600);
  const mins  = Math.floor((s % 3600) / 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatDay(iso) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}

async function loadStats() {
  if (statsState.loading) return;
  statsState.loading = true;
  if (!statsState.loaded) {
    $('statGrid').innerHTML = '<div class="stat-card stat-card-loading">Loading…</div>';
  }
  try {
    const data = await api('/api/account/stats');
    statsState.stats  = data.stats;
    statsState.badges = data.badges || [];
    statsState.loaded = true;
    renderStats();
    renderBadges();
  } catch (err) {
    $('statGrid').innerHTML = '';
    $('badgeContent').innerHTML =
      `<div class="empty"><div class="empty-icon">${ICON_ALERT}</div><h3>Couldn't Load</h3><p>Failed to load your stats.</p></div>`;
    $('statsSubtitle').textContent = 'Unavailable';
  } finally {
    statsState.loading = false;
  }
}

function renderStats() {
  const s = statsState.stats;
  if (!s) return;

  // Grouped the way they'd be read, not the way they're stored: what you
  // watched, what you finished, what you keep, who you watch with.
  const cards = [
    { label: 'Watch time',        value: formatWatchTime(s.total_watch_seconds), hint: 'Total playback' },
    { label: 'Episodes finished', value: s.episodes_completed },
    { label: 'Movies finished',   value: s.movies_completed },
    { label: 'Shows finished',    value: s.shows_completed, hint: 'Nothing left unfinished' },
    { label: 'Titles started',    value: s.titles_started },
    { label: 'Still watching',    value: s.episodes_in_progress, hint: 'Started, not finished' },
    { label: 'Current streak',    value: `${s.current_streak_days}d`, hint: `Best: ${s.longest_streak_days}d` },
    { label: 'Active days',       value: s.active_days },
    { label: 'In watchlist',      value: s.watchlist_count },
    { label: 'Favorites',         value: s.favorites_count },
    { label: 'Titles rated',      value: s.ratings_count, hint: s.average_rating != null ? `Avg ${s.average_rating}/10` : 'No ratings yet' },
    { label: 'Providers used',    value: s.providers_used, hint: s.top_provider ? `Most: ${providerLabel(s.top_provider)}` : '' },
    { label: 'Followers',         value: s.followers_count, hint: `Following ${s.following_count}` },
    { label: 'Shares sent',       value: s.shares_sent, hint: `${s.reactions_received} reactions received` },
  ];

  $('statGrid').innerHTML = cards.map(c => `
    <div class="stat-card">
      <div class="stat-value">${escapeHtml(String(c.value))}</div>
      <div class="stat-label">${escapeHtml(c.label)}</div>
      ${c.hint ? `<div class="stat-hint">${escapeHtml(c.hint)}</div>` : ''}
    </div>
  `).join('');

  const since = formatDay(s.member_since);
  const last  = s.last_watch_at ? `Last watched ${relativeDate(s.last_watch_at)}` : 'Nothing watched yet';
  $('statsSubtitle').textContent = `Member since ${since} · ${last}`;
}

function renderBadges() {
  const badges = statsState.badges;
  const earnedOnly = $('badgeEarnedOnly').checked;
  const earned = badges.filter(b => b.earned).length;

  $('badgeCount').textContent = String(earned);
  $('badgesSubtitle').textContent = `${earned} of ${badges.length} earned`;

  const visible = earnedOnly ? badges.filter(b => b.earned) : badges;

  if (!visible.length) {
    $('badgeContent').innerHTML = `
      <div class="empty">
        <div class="empty-icon">🏆</div>
        <h3>No Badges Yet</h3>
        <p>Watch, rate and share to start earning them.</p>
      </div>`;
    return;
  }

  // One section per category, tiers in order — the ladder only reads as a
  // ladder if the next one up sits right after the one you just earned.
  const groups = new Map();
  visible.forEach(b => {
    if (!groups.has(b.category)) groups.set(b.category, []);
    groups.get(b.category).push(b);
  });

  $('badgeContent').innerHTML = [...groups.entries()].map(([category, list]) => `
    <div class="badge-group">
      <div class="badge-group-title">${escapeHtml(CATEGORY_LABELS[category] || category)}</div>
      <div class="badge-grid">
        ${list.sort((a, b) => a.tier - b.tier).map(renderBadgeCard).join('')}
      </div>
    </div>
  `).join('');
}

function renderBadgeCard(b) {
  const pct = b.threshold > 0 ? Math.min(100, Math.round((b.progress / b.threshold) * 100)) : 0;
  const meta = b.earned
    ? `Earned ${relativeDate(b.earned_at)}`
    : `${b.progress} / ${b.threshold}`;

  return `
    <div class="badge-card ${b.earned ? 'earned' : 'locked'}" title="${escapeHtml(b.description)}">
      <div class="badge-icon">${b.icon}</div>
      <div class="badge-body">
        <div class="badge-name">${escapeHtml(b.name)}</div>
        <div class="badge-desc">${escapeHtml(b.description)}</div>
        ${b.earned ? '' : `<div class="badge-bar"><span style="width:${pct}%"></span></div>`}
        <div class="badge-meta">${escapeHtml(meta)}</div>
      </div>
    </div>`;
}

$('badgeEarnedOnly').addEventListener('change', renderBadges);

boot();

document.getElementById('logoutLink').addEventListener('click', e => {
  e.preventDefault();
  logout();
});

// Mobile bottom nav: this tab is already active (we're on the account page),
// so it substitutes itself for a Logout button right away.
const bottomNavAccount = document.getElementById('bottomNavAccount');
if (bottomNavAccount) {
  const label = document.getElementById('bottomNavAccountLabel');
  const iconAccount = bottomNavAccount.querySelector('.icon-account');
  const iconLogout = bottomNavAccount.querySelector('.icon-logout');
  bottomNavAccount.classList.add('is-logout');
  iconAccount.style.display = 'none';
  iconLogout.style.display = '';
  label.textContent = 'Logout';
  bottomNavAccount.addEventListener('click', () => logout());
}