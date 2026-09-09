import { ensureSessionQuietly, fetchPublic, escapeHtml } from '/scripts/auth.js';
import { showMeta, isSeries } from '/scripts/show-meta.js';

const providerStorageKey = 'streamio.provider';

function appendProvider(url) {
    const provider = localStorage.getItem(providerStorageKey) || '';
    if (!provider) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}provider=${encodeURIComponent(provider)}`;
}

function scrollCarousel(dir) {
    const c = document.getElementById('featuredCarousel');
    c.scrollBy({ left: dir * 300, behavior: 'smooth' });
}

/* Cerca la categoria "in evidenza" per nome (case-insensitive).
    Parole chiave riconosciute: evidenza, featured, highlights, spotlight, in evidenza */
function isFeaturedCategory(name) {
    if (!name) return false;
    const n = name.toLowerCase();
    return n.includes('evidenza') || n.includes('featured') || n.includes('highlight') || n.includes('spotlight');
}

function renderFeatCard(item) {
    const banner = item.banner || '';
    const poster = item.poster || '';
    const primary = banner || poster;
    const fallbackAttr = (banner && poster) ? ` data-fallback="${poster}"` : '';
    const rating = item.rating ? `<div class="feat-card-rating">★ ${item.rating}</div>` : '';
    const kind = isSeries(item) ? 'Series' : 'Movie';
    const thumbContent = primary
    ? `<img class="feat-card-img" src="${primary}"${fallbackAttr} alt="" onerror="featImgError(this)">`
    : '<div class="feat-card-thumb-bg"></div>';
    const meta = showMeta(item, 4);

    return `
    <a href="/details?id=${encodeURIComponent(item.id)}" class="feat-card">
        <div class="feat-card-thumb">
        ${thumbContent}
        ${rating}
        <div class="feat-badge">${kind}</div>
        <div class="feat-card-overlay"></div>
        </div>
        <div class="feat-card-body">
        <div class="feat-card-title">${escapeHtml(item.title || 'Unknown')}</div>
        ${meta ? `<div class="feat-card-meta">${escapeHtml(meta)}</div>` : ''}
        </div>
    </a>
    `;
}

function featImgError(img) {
    const fallback = img.dataset.fallback;
    if (fallback && img.src !== fallback) {
    img.src = fallback;
    } else {
    img.style.display = 'none';
    const thumb = img.closest('.feat-card-thumb');
    if (thumb) {
        const bg = document.createElement('div');
        bg.className = 'feat-card-thumb-bg';
        thumb.insertBefore(bg, thumb.firstChild);
    }
    }
}

function renderCard(item) {
    const poster = item.poster || '';
    const rating = item.rating ? `<div class="card-rating"><span class="star">★</span>${escapeHtml(String(item.rating))}</div>` : '';
    const genre = item.genres && item.genres.length > 0 ? `<div class="card-genre">${escapeHtml(item.genres[0].name)}</div>` : '';
    const kind = isSeries(item) ? 'Series' : 'Movie';
    // The overlay sits over the poster and has less room than the body line.
    const meta = showMeta(item);
    const overlayMeta = showMeta(item, 2);
    return `
    <a href="/details?id=${encodeURIComponent(item.id)}" class="card">
        <div class="card-poster" style="${poster ? `background-image:url('${poster}')` : ''}">
        ${poster ? '' : '<div class="card-poster-bg"></div>'}
        ${rating}
        <div class="card-kind">${kind}</div>
        <div class="card-overlay"></div>
        <div class="card-info">
            <div class="card-play">▶</div>
            <div class="card-title">${escapeHtml(item.title || 'Unknown')}</div>
            ${overlayMeta ? `<div class="card-meta">${escapeHtml(overlayMeta)}</div>` : ''}
            ${genre}
        </div>
        </div>
        <div class="card-body">
        <div class="card-body-title">${escapeHtml(item.title || 'Unknown')}</div>
        ${meta ? `<div class="card-body-meta">${escapeHtml(meta)}</div>` : ''}
        </div>
    </a>
    `;
}

async function loadCatalog() {
    try {
    const res = await fetchPublic(appendProvider('/api/home'));
    const data = await res.json();
    const content = document.getElementById('catalogContent');

    if (!data.data || data.data.length === 0) {
        content.innerHTML = '<div class="empty">No categories available for this provider.</div>';
        return;
    }

    // Separa la categoria "in evidenza" dalle categorie normali
    const featuredCategory = data.data.find(function(c) { return isFeaturedCategory(c.name); });
    const regularCategories = data.data.filter(function(c) { return !isFeaturedCategory(c.name); });

    // Popola il carousel solo se esiste la categoria dedicata
    if (featuredCategory && featuredCategory.list && featuredCategory.list.length > 0) {
        document.getElementById('featuredTitle').textContent = featuredCategory.name;
        document.getElementById('featuredCarousel').innerHTML = featuredCategory.list.map(renderFeatCard).join('');
        document.getElementById('featuredSection').style.display = 'block';
    }

    // Renderizza le categorie restanti come griglie
    content.innerHTML = regularCategories.map(function(category) {
        const items = category.list || [];
        if (!items.length) return '';
        return `
        <div class="category">
            <div class="category-header">
            <h2 class="category-title">${category.name || 'Unnamed'}</h2>
            <span class="category-count">${items.length}</span>
            </div>
            <div class="grid">${items.map(renderCard).join('')}</div>
        </div>
        `;
    }).join('') || '<div class="empty">No items found.</div>';

    } catch (err) {
    document.getElementById('catalogContent').innerHTML = `<div class="empty">Error loading catalog: ${err.message}</div>`;
    }
}

// Inline onclick handlers in catalog.html need this on the global scope, which
// a module doesn't get for free.
window.scrollCarousel = scrollCarousel;

// What the catalogue contains depends on who is asking (18+ preference).
await ensureSessionQuietly();

loadCatalog();
import('/scripts/social.js').then((m) => m.initShareBadge());