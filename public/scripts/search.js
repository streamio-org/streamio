import { ensureSessionQuietly, fetchPublic, escapeHtml } from '/scripts/auth.js';
import { showMeta, isSeries } from '/scripts/show-meta.js';
import { groupFamilies } from '/scripts/provider-names.js';
import { ICON_FILM, ICON_SEARCH, ICON_INBOX, ICON_ALERT } from '/scripts/icons.js';

const providerStorageKey = 'streamio.provider';
const recentKey = 'streamio.recentSearches';

const $ = (id) => document.getElementById(id);

/**
 * Page state. `mode` decides which endpoint the next fetch hits — a text query
 * and a genre browse are different requests, not filters layered on one, so
 * picking one clears the other.
 */
const state = {
    provider: localStorage.getItem(providerStorageKey) || '',
    query: '',
    genre: null,      // { id, name }
    mode: 'idle',     // idle | search | genre
    page: 1,
    items: [],
    type: 'all',      // all | movie | tv
    sort: 'relevance',
    loading: false,
    exhausted: false,
};

let genreCatalogue = [];
// Sources grouped by family — each carries the languages it is available in.
let providerFamilies = [];

// -----------------------
// URL / STORAGE
// -----------------------

function buildUrl(path, params = {}) {
    const search = new URLSearchParams();
    if (state.provider) search.set('provider', state.provider);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
            search.set(key, value);
        }
    }
    const qs = search.toString();
    return qs ? `${path}?${qs}` : path;
}

/** Keeps the address bar shareable without adding a history entry per keystroke. */
function syncUrl() {
    const params = new URLSearchParams();
    if (state.query) params.set('q', state.query);
    if (state.genre) params.set('genre', state.genre.id);
    if (state.provider) params.set('provider', state.provider);

    const qs = params.toString();
    history.replaceState(null, '', qs ? `/search?${qs}` : '/search');
}

function readRecent() {
    try {
        const parsed = JSON.parse(localStorage.getItem(recentKey) || '[]');
        return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : [];
    } catch {
        return [];
    }
}

function rememberSearch(query) {
    const recent = [query, ...readRecent().filter((q) => q !== query)].slice(0, 8);
    try {
        localStorage.setItem(recentKey, JSON.stringify(recent));
    } catch {
        // A full or blocked storage costs the history, not the search.
    }
}

// -----------------------
// RENDERING
// -----------------------

function renderCard(item) {
    const poster = item.poster || '';
    const title = escapeHtml(item.title || 'Unknown');
    const rating = item.rating
        ? `<div class="card-rating"><span class="star">★</span>${Number(item.rating).toFixed(1)}</div>`
        : '';
    const kind = isSeries(item) ? 'Series' : 'Movie';
    const meta = escapeHtml(showMeta(item));
    const overlayMeta = escapeHtml(showMeta(item, 2));

    const href = `/details?id=${encodeURIComponent(item.id)}${
        state.provider ? `&provider=${encodeURIComponent(state.provider)}` : ''
    }`;

    return `
    <a href="${href}" class="card">
        <div class="card-poster" style="${poster ? `background-image:url('${escapeHtml(poster)}')` : ''}">
        ${poster ? '' : '<div class="card-poster-bg"></div>'}
        ${rating}
        <div class="card-kind">${kind}</div>
        <div class="card-overlay"></div>
        <div class="card-info">
            <div class="card-play">▶</div>
            <div class="card-title">${title}</div>
            ${overlayMeta ? `<div class="card-meta">${overlayMeta}</div>` : ''}
        </div>
        </div>
        <div class="card-body">
        <div class="card-body-title">${title}</div>
        ${meta ? `<div class="card-body-meta">${meta}</div>` : ''}
        </div>
    </a>
    `;
}

function stateBox(icon, title, detail = '') {
    return `<div class="state-box"><div class="icon">${icon}</div><strong>${escapeHtml(title)}</strong>${escapeHtml(detail)}</div>`;
}

/**
 * `entries` are `{ name, displayName, adult, family, language, languages }`.
 * The server supplies those via the `catalog` field so a provider added
 * server-side is labelled without a client release; `provider-names.js` stays
 * the fallback for an install that predates it.
 *
 * The catalog is flat — one entry per language variant — so it is grouped into
 * one chip per source here, with the languages on a second row. Each language
 * is still its own provider slug on the wire; picking one is the same
 * operation as picking a source.
 */
function renderProviders(entries) {
    providerFamilies = groupFamilies(entries);

    $('providerChips').innerHTML = providerFamilies
        .map((family) => {
            const active = family.languages.some((l) => l.slug === state.provider);
            // Keep the language already chosen within this source rather than
            // resetting to its default when coming back to it.
            const target =
                family.languages.find((l) => l.slug === state.provider) || family.languages[0];

            return `<button class="chip${active ? ' active' : ''}" data-provider="${escapeHtml(target.slug)}">
                ${escapeHtml(family.displayName)}${family.adult ? ' <span class="chip-badge">18+</span>' : ''}
            </button>`;
        })
        .join('');

    $('providerChips')
        .querySelectorAll('.chip')
        .forEach((chip) =>
            chip.addEventListener('click', () => selectProvider(chip.dataset.provider))
        );

    renderProviderLanguages();
}

/** Second row, only for a source available in more than one language. */
function renderProviderLanguages() {
    const row = $('providerLangChips');
    if (!row) return;

    const family = providerFamilies.find((f) =>
        f.languages.some((l) => l.slug === state.provider)
    );

    if (!family || family.languages.length < 2) {
        row.innerHTML = '';
        row.style.display = 'none';
        return;
    }

    row.style.display = '';
    row.innerHTML = family.languages
        .map(
            (l) => `<button class="chip lang${l.slug === state.provider ? ' active' : ''}"
                data-provider="${escapeHtml(l.slug)}">${escapeHtml(l.label)}</button>`
        )
        .join('');

    row
        .querySelectorAll('.chip')
        .forEach((chip) =>
            chip.addEventListener('click', () => selectProvider(chip.dataset.provider))
        );
}

function renderGenres() {
    const row = $('genreChips');

    if (!genreCatalogue.length) {
        $('genreSection').style.display = 'none';
        return;
    }

    $('genreSection').style.display = '';
    row.innerHTML = genreCatalogue
        .map(
            (g) => `<button class="chip genre-chip${state.genre?.id === g.id ? ' active' : ''}"
                data-genre="${escapeHtml(String(g.id))}">${escapeHtml(g.name)}</button>`
        )
        .join('');

    row.querySelectorAll('.genre-chip').forEach((chip) =>
        chip.addEventListener('click', () => {
            const genre = genreCatalogue.find((g) => String(g.id) === chip.dataset.genre);
            // Clicking the active genre clears it, which is the only way back
            // to the landing state without emptying the search box too.
            selectGenre(state.genre?.id === chip.dataset.genre ? null : genre);
        })
    );
}

function renderRecent() {
    const recent = readRecent();
    const box = $('recentSection');

    if (!recent.length) {
        box.style.display = 'none';
        return;
    }

    box.style.display = '';
    $('recentChips').innerHTML = recent
        .map((q) => `<button class="chip" data-query="${escapeHtml(q)}">${escapeHtml(q)}</button>`)
        .join('');

    $('recentChips')
        .querySelectorAll('.chip')
        .forEach((chip) =>
            chip.addEventListener('click', () => {
                $('searchInput').value = chip.dataset.query;
                runSearch(chip.dataset.query);
            })
        );
}

/** Type filter and sort are applied client-side, over what's been loaded. */
function visibleItems() {
    let items = state.items;

    if (state.type === 'movie') items = items.filter((i) => !isSeries(i));
    if (state.type === 'tv') items = items.filter(isSeries);

    if (state.sort === 'title') {
        items = [...items].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    } else if (state.sort === 'rating') {
        items = [...items].sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0));
    } else if (state.sort === 'year') {
        items = [...items].sort((a, b) => (Number(year(b)) || 0) - (Number(year(a)) || 0));
    }

    return items;
}

function renderResults() {
    const area = $('resultsArea');

    if (state.mode === 'idle') {
        area.innerHTML = stateBox(
            ICON_FILM,
            'Start browsing',
            genreCatalogue.length
                ? 'Search for a title, or pick a genre above'
                : 'Type a title above and press Search'
        );
        $('filterBar').style.display = 'none';
        $('loadMoreWrap').style.display = 'none';
        return;
    }

    if (state.loading && !state.items.length) {
        area.innerHTML = `<div class="state-box"><div class="icon spinning">⏳</div><strong>Loading…</strong></div>`;
        $('filterBar').style.display = 'none';
        $('loadMoreWrap').style.display = 'none';
        return;
    }

    if (!state.items.length) {
        area.innerHTML = stateBox(
            ICON_SEARCH,
            'No results',
            state.mode === 'genre'
                ? `Nothing in ${state.genre?.name ?? 'this genre'}`
                : `Nothing matched "${state.query}"`
        );
        $('filterBar').style.display = 'none';
        $('loadMoreWrap').style.display = 'none';
        return;
    }

    const items = visibleItems();
    const heading =
        state.mode === 'genre' ? state.genre?.name || 'Genre' : `Results for "${state.query}"`;

    $('filterBar').style.display = '';
    $('resultsTitle').textContent = heading;
    $('resultsCount').textContent = `${items.length} title${items.length !== 1 ? 's' : ''}${
        items.length !== state.items.length ? ` of ${state.items.length}` : ''
    }`;

    area.innerHTML = items.length
        ? `<div class="results-grid">${items.map(renderCard).join('')}</div>`
        : stateBox(ICON_INBOX, 'Nothing to show', 'No loaded titles match this filter');

    $('loadMoreWrap').style.display = state.exhausted ? 'none' : '';
    $('loadMoreBtn').disabled = state.loading;
    $('loadMoreBtn').textContent = state.loading ? 'Loading…' : 'Load more';
}

// -----------------------
// DATA
// -----------------------

async function loadProviders() {
    try {
        const res = await fetchPublic('/api/providers');
        const json = await res.json();

        const entries = Array.isArray(json.catalog) && json.catalog.length
            ? json.catalog
            : (Array.isArray(json.providers) ? json.providers : []).map((name) => ({ name }));

        // A saved provider the server no longer lists (e.g. an 18+ one after
        // the preference was turned off) must not stay selected.
        if (state.provider && !entries.some((e) => e.name === state.provider)) {
            state.provider = '';
            localStorage.removeItem(providerStorageKey);
        }

        renderProviders(entries);
    } catch {
        $('providerChips').innerHTML = '';
    }
}

async function loadGenres() {
    genreCatalogue = [];

    try {
        const res = await fetchPublic(buildUrl('/api/genres'));
        const json = await res.json();
        if (res.ok && Array.isArray(json.data)) {
            genreCatalogue = json.data.filter((g) => g && g.id != null && g.name);
        }
    } catch {
        // A provider whose genre catalogue can't be reached just shows none.
    }

    renderGenres();
}

async function fetchPage(page) {
    if (state.mode === 'search') {
        const res = await fetchPublic(buildUrl('/api/search', { query: state.query, page }));
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Search failed');
        return Array.isArray(json.data) ? json.data : [];
    }

    const res = await fetchPublic(
        buildUrl(`/api/genres/${encodeURIComponent(state.genre.id)}`, { page })
    );
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Could not load genre');

    // The genre's own name is only known server-side, so adopt it once loaded.
    if (json.data?.name) state.genre = { ...state.genre, name: json.data.name };

    return Array.isArray(json.data?.shows) ? json.data.shows : [];
}

async function load({ append = false } = {}) {
    if (state.mode === 'idle' || state.loading) return;

    state.loading = true;
    if (!append) {
        state.page = 1;
        state.items = [];
        state.exhausted = false;
    }
    renderResults();

    try {
        const items = await fetchPage(state.page);

        // Providers page by fixed-size batches and just return fewer (or an
        // echo of the last page) at the end, so an empty page is the only
        // reliable end-of-results signal.
        if (!items.length) {
            state.exhausted = true;
        } else {
            const seen = new Set(state.items.map((i) => i.id));
            const fresh = items.filter((i) => i?.id && !seen.has(i.id));
            if (!fresh.length) state.exhausted = true;
            state.items = state.items.concat(fresh);
        }
    } catch (err) {
        state.loading = false;
        state.exhausted = true;
        $('resultsArea').innerHTML = stateBox(ICON_ALERT, 'Error', err.message);
        $('filterBar').style.display = 'none';
        $('loadMoreWrap').style.display = 'none';
        return;
    }

    state.loading = false;
    renderResults();
}

// -----------------------
// ACTIONS
// -----------------------

function selectProvider(provider) {
    if (state.provider === provider) return;

    state.provider = provider;
    localStorage.setItem(providerStorageKey, provider);

    // Genres and results are both provider-scoped: a genre id from one site
    // means nothing on another, so the browse resets rather than carries over.
    state.genre = null;
    if (state.mode === 'genre') {
        state.mode = 'idle';
        state.items = [];
    }

    syncUrl();
    loadProviders();
    loadGenres();

    if (state.mode === 'search') load();
    else renderResults();
}

function selectGenre(genre) {
    state.genre = genre || null;
    state.mode = genre ? 'genre' : state.query ? 'search' : 'idle';

    if (genre) {
        // A genre browse replaces the text search rather than filtering it —
        // the providers expose the two as separate listings, not one query.
        state.query = '';
        $('searchInput').value = '';
    }

    syncUrl();
    renderGenres();

    if (state.mode === 'idle') {
        state.items = [];
        renderResults();
    } else {
        load();
    }
}

function runSearch(raw) {
    const query = (raw ?? $('searchInput').value).trim();

    if (!query) {
        state.query = '';
        state.mode = state.genre ? 'genre' : 'idle';
        state.items = [];
        syncUrl();
        renderResults();
        return;
    }

    state.query = query;
    state.mode = 'search';
    state.genre = null;

    rememberSearch(query);
    renderGenres();
    renderRecent();
    syncUrl();
    load();
}

// -----------------------
// WIRING
// -----------------------

let debounce;
$('searchInput').addEventListener('input', () => {
    clearTimeout(debounce);
    const value = $('searchInput').value.trim();

    // One character matches nearly everything upstream and makes a request per
    // keystroke worth of noise; below two, wait for Enter or the button.
    if (value.length < 2) return;

    debounce = setTimeout(() => runSearch(), 450);
});

$('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        clearTimeout(debounce);
        runSearch();
    }
});

$('searchBtn').addEventListener('click', () => {
    clearTimeout(debounce);
    runSearch();
});

$('loadMoreBtn').addEventListener('click', () => {
    state.page += 1;
    load({ append: true });
});

document.querySelectorAll('[data-type]').forEach((btn) =>
    btn.addEventListener('click', () => {
        state.type = btn.dataset.type;
        document
            .querySelectorAll('[data-type]')
            .forEach((b) => b.classList.toggle('active', b === btn));
        renderResults();
    })
);

$('sortSelect').addEventListener('change', () => {
    state.sort = $('sortSelect').value;
    renderResults();
});

// -----------------------
// BOOT
// -----------------------

// Results are filtered per user (18+ preference), so the session has to be
// restored before the first query — and before the provider list, which hides
// adult providers from anyone without the preference.
await ensureSessionQuietly();

const params = new URLSearchParams(location.search);
const initialProvider = params.get('provider');
if (initialProvider) {
    state.provider = initialProvider;
    localStorage.setItem(providerStorageKey, initialProvider);
}

await loadProviders();
await loadGenres();
renderRecent();

const initialQuery = params.get('q');
const initialGenre = params.get('genre');
const initialGenreName = params.get('genreName');

if (initialQuery) {
    $('searchInput').value = initialQuery;
    runSearch(initialQuery);
} else if (initialGenre) {
    const known = genreCatalogue.find((g) => String(g.id) === initialGenre);
    // A deep link can name a genre the catalogue hasn't got (another provider,
    // or a renamed one) — browse it anyway and let the server supply the name.
    selectGenre(known || { id: initialGenre, name: '' });
} else if (initialGenreName) {
    // The detail page links by name when the provider parsed the genre off the
    // title without an id. The id exists in the provider's genre catalogue,
    // so match it there; a name with no match at all is worth more as a text
    // search than as an empty browse.
    const wanted = initialGenreName.trim().toLowerCase();
    const known = genreCatalogue.find((g) => g.name.trim().toLowerCase() === wanted);
    if (known) {
        selectGenre(known);
    } else {
        $('searchInput').value = initialGenreName;
        runSearch(initialGenreName);
    }
} else {
    renderResults();
    $('searchInput').focus();
}

import('/scripts/social.js').then((m) => m.initShareBadge());
