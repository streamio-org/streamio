import {
  api,
  ensureSessionQuietly,
  fetchPublic,
  parseShowKey,
} from "/scripts/auth.js";
import { initShareBadge } from "/scripts/social.js";
import { groupFamilies, getName } from "/scripts/provider-names.js";
import { ICON_FILM, ICON_CALENDAR } from "/scripts/icons.js";
import { showMeta, isSeries } from "/scripts/show-meta.js";

// ── Helpers ──────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const providerKey = "streamio.provider";
let activeProvider = localStorage.getItem(providerKey) || "";
// Sources grouped by family — each carries the languages it is available in.
let providerFamilies = [];
let heroItems = [];
let heroIdx = 0;
let heroTimer = null;
let toastTimer;
let showCache = {};
// Marks a show the server refused as 18+ — distinct from null, which means the
// lookup merely failed.
const GATED = Symbol("gated");

function toast(msg, type = "success") {
  const t = $("toast");
  t.className = "show";
  $("toastMsg").textContent = msg;
  t.querySelector(".toast-dot").style.background =
    type === "success" ? "#46d369" : "#e50914";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.className = "";
  }, 3000);
}

function appendProvider(url) {
  if (!activeProvider) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}provider=${encodeURIComponent(activeProvider)}`;
}

function relativeDate(d) {
  const diff = Date.now() - new Date(d).getTime();
  const h = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (h < 24) return `${h}h ago`;
  return `${days}d ago`;
}

function scrollRail(btn, dir) {
  const rail = btn.closest(".rail-wrap").querySelector(".rail");
  rail.scrollBy({ left: dir * 320, behavior: "smooth" });
}
window.scrollRail = scrollRail;

// ── Nav: go solid on scroll ──────────────────────────────────
window.addEventListener(
  "scroll",
  () => {
    $("mainNav").classList.toggle("solid", window.scrollY > 60);
  },
  { passive: true },
);

function featThumbError(img) {
  const fallback = img.dataset.fallback;
  if (fallback && img.src !== fallback) {
    img.src = fallback;
  } else {
    img.style.display = "none";
    const thumb = img.closest(".feat-thumb");
    if (thumb) {
      const ph = document.createElement("div");
      ph.className = "feat-thumb-placeholder";
      ph.innerHTML = ICON_FILM;
      thumb.insertBefore(ph, thumb.firstChild);
    }
  }
}
window.featThumbError = featThumbError;

// ── Provider chips ────────────────────────────────────────────
async function initProviders() {
  let providers = ["default"];
  let serverDefault = "";
  let catalog = [];
  try {
    const res = await fetchPublic("/api/providers");
    const json = await res.json();
    if (Array.isArray(json.providers) && json.providers.length) {
      providers = json.providers;
    }
    if (Array.isArray(json.catalog)) catalog = json.catalog;
    serverDefault = typeof json.default === "string" ? json.default : "";
  } catch {
    /* fall back to default */
  }

  // Restore saved provider only if it's still valid
  if (activeProvider && !providers.includes(activeProvider)) {
    activeProvider = "";
  }

  // "No provider" was never a real state: the API just falls back to its own
  // default, so the page looked identical while every link it built omitted
  // `provider=` — and anything reading that link back (Chromecast autoplay,
  // watchlist, share) got an empty string instead of a source name. Name the
  // default explicitly instead of leaving it implicit.
  if (!activeProvider && serverDefault && providers.includes(serverDefault)) {
    activeProvider = serverDefault;
  }
  if (!activeProvider && providers.length && providers[0] !== "default") {
    activeProvider = providers[0];
  }

  if (activeProvider) localStorage.setItem(providerKey, activeProvider);
  else localStorage.removeItem(providerKey);

  // The catalog is flat, one entry per language; an install that predates it
  // gives only bare names, which group into one single-language family each.
  providerFamilies = groupFamilies(
    catalog.length ? catalog : providers.map((name) => ({ name })),
  );

  renderProviderPicker();
}

/** The family the active provider belongs to, if any. */
function activeFamily() {
  return (
    providerFamilies.find((f) =>
      f.languages.some((l) => l.slug === activeProvider),
    ) || null
  );
}

function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

/**
 * The source list is a popover behind one trigger rather than a chip per
 * source: there are more sources than fit across the bar, and the flat row of
 * chips wrapped out of its fixed height instead of staying on one line.
 */
function renderProviderPicker() {
  const family = activeFamily();
  const lang = family?.languages.find((l) => l.slug === activeProvider);

  $("providerTriggerName").textContent =
    family?.displayName || activeProvider || "Select a source";
  // Only worth showing when the source has more than one language — otherwise
  // it is a constant next to a constant.
  $("providerTriggerLang").textContent =
    family && family.languages.length > 1 ? lang?.label || "" : "";

  $("providerMenu").innerHTML = providerFamilies
    .map((f) => {
      const active = f.id === family?.id;
      const langs =
        f.languages.length > 1 ? `${f.languages.length} languages` : "";
      // Selecting a source keeps the language already chosen within it, so
      // coming back to a family doesn't silently reset it to the default.
      const target =
        f.languages.find((l) => l.slug === activeProvider) || f.languages[0];

      return `
<button type="button" class="provider-option${active ? " active" : ""}"
    role="option" aria-selected="${active}" data-prov="${escapeHtml(target.slug)}">
  <span class="provider-option-main">
    <span class="provider-option-name">${escapeHtml(f.displayName)}${
      f.adult ? ' <span class="chip-badge">18+</span>' : ""
    }</span>
    <span class="provider-option-desc">${escapeHtml(f.description || "")}</span>
  </span>
  ${langs ? `<span class="provider-option-langs">${langs}</span>` : ""}
  <span class="provider-option-check">${active ? "✓" : ""}</span>
</button>`;
    })
    .join("");

  $("providerMenu")
    .querySelectorAll(".provider-option")
    .forEach((opt) => {
      // Picking the source already selected is a no-op rather than a toggle:
      // there is no "no provider" state to go back to — the API would just
      // fall back to its own default while every link on the page dropped the
      // `provider=` it stamps into watchlist/share/Chromecast payloads.
      opt.addEventListener("click", () => {
        selectProvider(opt.dataset.prov);
        closeProviderMenu();
      });
    });

  renderLanguageChips();
}

function openProviderMenu() {
  $("providerMenu").hidden = false;
  $("providerTrigger").setAttribute("aria-expanded", "true");
}

function closeProviderMenu() {
  $("providerMenu").hidden = true;
  $("providerTrigger").setAttribute("aria-expanded", "false");
}

$("providerTrigger").addEventListener("click", (e) => {
  e.stopPropagation();
  if ($("providerMenu").hidden) openProviderMenu();
  else closeProviderMenu();
});
document.addEventListener("click", (e) => {
  if (!$("providerSelect").contains(e.target)) closeProviderMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeProviderMenu();
});

/**
 * A second row, shown only when the selected source exists in more than one
 * language. Language is not a separate axis on the wire — each language is its
 * own provider slug — so picking one is the same operation as picking a source.
 */
function renderLanguageChips() {
  const row = $("providerLangChips");
  if (!row) return;

  const family = activeFamily();
  if (!family || family.languages.length < 2) {
    row.innerHTML = "";
    row.style.display = "none";
    return;
  }

  row.style.display = "";
  row.innerHTML = family.languages
    .map(
      (l) => `
<button class="provider-chip lang${l.slug === activeProvider ? " active" : ""}"
    data-prov="${l.slug}">${l.label}</button>
`,
    )
    .join("");

  row
    .querySelectorAll(".provider-chip")
    .forEach((chip) =>
      chip.addEventListener("click", () => selectProvider(chip.dataset.prov)),
    );
}

function selectProvider(prov) {
  if (!prov || prov === activeProvider) return;

  activeProvider = prov;
  localStorage.setItem(providerKey, activeProvider);

  renderProviderPicker();

  // Sync to server (best-effort, don't block UI)
  fetchPublic("/api/providers/current", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: activeProvider }),
  }).catch(() => {});

  // Continue Watching is deliberately *not* reloaded: it spans every source,
  // so switching the browsing provider doesn't change what's in it.
  loadHome();
}

// ── Hero ─────────────────────────────────────────────────────
function buildHero(items) {
  heroItems = items.slice(0, 5);
  heroIdx = 0;
  clearInterval(heroTimer);
  renderHeroSlide(0);
  renderHeroDots();
  heroTimer = setInterval(() => {
    heroIdx = (heroIdx + 1) % heroItems.length;
    renderHeroSlide(heroIdx);
    updateHeroDots();
  }, 7000);
}

function renderHeroSlide(idx) {
  const item = heroItems[idx];
  if (!item) return;

  const banner = item.banner || "";
  const poster = item.poster || "";
  const primary = banner || poster;
  const bgImg = $("heroBgImg");

  // Rimuovi img precedente se c'è
  const oldImg = bgImg.querySelector("img");
  if (oldImg) oldImg.remove();

  if (primary) {
    const img = document.createElement("img");
    img.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity 0.8s ease;";
    if (banner && poster) img.dataset.fallback = poster;
    img.onerror = function () {
      if (this.dataset.fallback && this.src !== this.dataset.fallback) {
        this.src = this.dataset.fallback;
      } else {
        this.style.opacity = "0";
      }
    };
    img.onload = function () {
      this.style.opacity = "1";
    };
    img.src = primary;
    bgImg.appendChild(img);
    bgImg.style.opacity = "1";
  } else {
    bgImg.style.opacity = "0";
  }

  $("heroBadge").textContent =
    item.genres && item.genres[0] ? `${item.genres[0].name}` : "Trending Now";
  $("heroTitle").textContent = item.title || "Unknown";

  const rating = item.rating
    ? `<span class="hero-meta-item"><span class="hero-rating">★ ${item.rating}</span></span>`
    : "";
  const runtime = item.runtime
    ? `<span class="hero-meta-item">⏱ ${item.runtime} min</span>`
    : "";
  const year = item.year
    ? `<span class="hero-meta-item">${ICON_CALENDAR} ${item.year}</span>`
    : "";
  $("heroMeta").innerHTML = `${rating}${runtime}${year}`;

  $("heroDesc").textContent = item.description || item.overview || "";
  $("heroActions").innerHTML = `
        <a href="/details?id=${encodeURIComponent(item.id)}${activeProvider ? "&provider=" + encodeURIComponent(activeProvider) : ""}" class="btn btn-primary">▶ Watch Now</a>
        <button class="btn btn-secondary" onclick="addToWatchlist('${item.id}')">+ Watchlist</button>
    `;

  const content = $("heroContent");
  content.classList.remove("loaded");
  requestAnimationFrame(() => {
    content.classList.add("loaded");
  });
}

function renderHeroDots() {
  $("heroDots").innerHTML = heroItems
    .map(
      (_, i) =>
        `<button class="hero-dot${i === 0 ? " active" : ""}" data-i="${i}"></button>`,
    )
    .join("");
  $("heroDots")
    .querySelectorAll(".hero-dot")
    .forEach((dot) => {
      dot.addEventListener("click", () => {
        heroIdx = parseInt(dot.dataset.i);
        renderHeroSlide(heroIdx);
        updateHeroDots();
        clearInterval(heroTimer);
        heroTimer = setInterval(() => {
          heroIdx = (heroIdx + 1) % heroItems.length;
          renderHeroSlide(heroIdx);
          updateHeroDots();
        }, 7000);
      });
    });
}

function updateHeroDots() {
  document.querySelectorAll(".hero-dot").forEach((d, i) => {
    d.classList.toggle("active", i === heroIdx);
  });
}

async function addToWatchlist(showId) {
  if (!activeProvider) {
    toast("Select a provider first.", "error");
    return;
  }
  try {
    await api("/api/account/watchlist", {
      method: "POST",
      body: { provider: activeProvider, show_id: showId },
    });
    toast("Added to watchlist! ✓");
  } catch (e) {
    // Likely not logged in — silently redirect
    window.location.href = "/login?redirect=/";
  }
}
window.addToWatchlist = addToWatchlist;

// ── Rows ─────────────────────────────────────────────────────
function isFeatured(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  return (
    n.includes("evidenza") ||
    n.includes("featured") ||
    n.includes("highlight") ||
    n.includes("spotlight") ||
    n.includes("trending")
  );
}

function renderPortraitCard(item, provider) {
  const poster = item.poster || "";
  const rating = item.rating
    ? `<div class="card-rating"><span class="star">★</span>${item.rating}</div>`
    : "";
  const kind = isSeries(item) ? "Series" : "Movie";
  const prov = provider || activeProvider;
  // The overlay sits over the poster and has less room than the body line.
  const meta = showMeta(item);
  const overlayMeta = showMeta(item, 2);
  return `
    <a href="/details?id=${encodeURIComponent(item.id)}${prov ? "&provider=" + encodeURIComponent(prov) : ""}" class="card">
    <div class="card-poster" style="${poster ? `background-image:url('${poster}')` : ""}">
        ${!poster ? `<div class="card-poster-placeholder">${ICON_FILM}</div>` : ""}
        ${rating}
        <div class="card-kind">${kind}</div>
        <div class="card-overlay"></div>
        <div class="card-info">
        <div class="card-play">▶</div>
        <div class="card-title">${escapeHtml(item.title || "Unknown")}</div>
        ${overlayMeta ? `<div class="card-meta">${escapeHtml(overlayMeta)}</div>` : ""}
        </div>
    </div>
    <div class="card-body">
        <div class="card-body-title">${escapeHtml(item.title || "Unknown")}</div>
        ${meta ? `<div class="card-body-meta">${escapeHtml(meta)}</div>` : ""}
    </div>
    </a>`;
}

function renderFeatCard(item, provider) {
  const banner = item.banner || "";
  const poster = item.poster || "";
  const primary = banner || poster;
  const fallbackAttr = banner && poster ? ` data-fallback="${poster}"` : "";
  const rating = item.rating
    ? `<div class="feat-thumb-rating">★ ${item.rating}</div>`
    : "";
  const kind = isSeries(item) ? "Series" : "Movie";
  const prov = provider || activeProvider;
  const thumbContent = primary
    ? `<img class="feat-thumb-img" src="${primary}"${fallbackAttr} alt="" onerror="featThumbError(this)">`
    : `<div class="feat-thumb-placeholder">${ICON_FILM}</div>`;
  const featMeta = showMeta(item, 4);

  return `
    <a href="/details?id=${encodeURIComponent(item.id)}${prov ? "&provider=" + encodeURIComponent(prov) : ""}" class="feat-card">
    <div class="feat-thumb">
        ${thumbContent}
        ${rating}
        <div class="feat-thumb-kind">${kind}</div>
        <div class="feat-thumb-overlay"></div>
    </div>
    <div class="feat-body">
        <div class="feat-title">${escapeHtml(item.title || "Unknown")}</div>
        ${featMeta ? `<div class="feat-meta">${escapeHtml(featMeta)}</div>` : ""}
    </div>
    </a>`;
}

function renderRow(category, idx) {
  const items = category.list || [];
  if (!items.length) return "";
  const isWide = isFeatured(category.name);
  const cards = items
    .map((item) => (isWide ? renderFeatCard(item) : renderPortraitCard(item)))
    .join("");
  return `
    <div class="row">
    <div class="row-header">
        <div class="row-left">
        <div class="row-title">${category.name || "Unnamed"}</div>
        <span class="row-count">${items.length}</span>
        </div>
        <a href="/catalog${activeProvider ? "?provider=" + encodeURIComponent(activeProvider) : ""}" class="row-see-all">See all →</a>
    </div>
    <div class="rail-wrap">
        <button class="rail-btn prev" onclick="scrollRail(this,-3)">‹</button>
        <div class="rail">${cards}</div>
        <button class="rail-btn next" onclick="scrollRail(this,3)">›</button>
    </div>
    </div>`;
}

/**
 * Short label for a provider slug. The catalog is the source of truth for what
 * a source is called — the local table is only a fallback for a slug this
 * install's catalog doesn't list (a history row saved before it was added, or
 * one behind a gate that is currently closed).
 */
function providerLabel(slug) {
  for (const family of providerFamilies) {
    const lang = family.languages.find((l) => l.slug === slug);
    if (!lang) continue;
    // The code, not the label: this goes on a 160px poster, and
    // "Pluto TV · United States" is truncated to uselessness there.
    return family.languages.length > 1 && lang.code
      ? `${family.displayName} · ${lang.code.toUpperCase()}`
      : family.displayName;
  }
  return getName(slug);
}

// ── Continue Watching ─────────────────────────────────────────
async function loadContinueWatching() {
  try {
    // Filter server-side: asking for the plain history and dropping the
    // completed rows here means a page of recently-finished titles eats the
    // whole limit and older in-progress ones never make it back.
    // Deliberately unfiltered by provider: "keep watching" is a property of
    // the viewer, not of whichever source they happen to be browsing — scoping
    // it to the active provider hid everything they had started elsewhere and
    // emptied the row entirely whenever they switched.
    const params = new URLSearchParams({
      completed: "false",
      limit: "100",
      offset: "0",
    });
    const items = await api(`/api/account/history/search?${params}`);
    if (!items || !items.length) return;

    // One card per title: watching several episodes of a show leaves a row per
    // episode, and rows come back newest-first, so the first one wins.
    const seen = new Set();
    const inProgress = items.filter((h) => {
      const key = `${h.provider}:${h.show_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (!inProgress.length) {
      $("continueRow").style.display = "none";
      return;
    }

    const uniqueShowIds = [
      ...new Set(inProgress.map((i) => `${i.provider}:${i.show_id}`)),
    ];
    await Promise.all(
      uniqueShowIds.map(async (key) => {
        if (showCache[key]) return;
        const { provider, showId } = parseShowKey(key);
        try {
          const data = await api(
            `/api/shows/${encodeURIComponent(showId)}?provider=${encodeURIComponent(provider)}`,
          );
          showCache[key] = data.data ?? data;
        } catch (err) {
          // A refusal is permanent, not a failed lookup: the row is 18+ and the
          // viewer's preference is off, so it must drop out rather than render
          // as a bare show_id with no poster.
          showCache[key] = err.message === "Adult content disabled" ? GATED : null;
        }
      }),
    );

    const cards = inProgress
      .filter((h) => showCache[`${h.provider}:${h.show_id}`] !== GATED)
      .map((h) => {
        const show = showCache[`${h.provider}:${h.show_id}`];
        const pct =
          h.progress_seconds > 0 && h.duration_seconds > 0
            ? Math.min(100, (h.progress_seconds / h.duration_seconds) * 100)
            : 0;
        // A movie has no episode at all, which the row shows more often now
        // that it isn't scoped to one provider.
        const epLabel =
          h.episode_label ?? (h.episode_id ? `Ep. ${h.episode_id}` : "Resume");

        // Costruisce un oggetto compatibile con renderPortraitCard
        const cardItem = {
          id: h.show_id,
          title: show?.title ?? h.show_id,
          poster: show?.poster ?? show?.posterUrl ?? "",
          rating: show?.rating ?? null,
          runtime: show?.runtime ?? null,
          genres: show?.genres ?? [],
        };

        // Wrap della card portrait con progress bar sovrapposta
        // The row spans every source, so each card says which one it came
        // from — clicking it switches the active provider to match.
        return `
        <a class="card continue-card" data-provider="${escapeHtml(h.provider)}" data-show-id="${escapeHtml(h.show_id)}" data-episode-id="${escapeHtml(h.episode_id ?? "")}" data-progress="${h.progress_seconds ?? ""}">
            <div class="card-poster" style="background-image:url('${cardItem.poster}')">
                <div class="card-provider">${escapeHtml(providerLabel(h.provider))}</div>
                <div class="card-rating"><span class="star">★</span>${cardItem.rating ? cardItem.rating.toFixed(1) : "N/A"}</div>
                <div class="card-overlay"></div>
                <div class="card-info">
                <div class="card-play">▶</div>
                <div class="card-title">${cardItem.title}</div>
                <div class="card-meta">${epLabel}${cardItem.runtime ? ` · ${cardItem.runtime} min` : ""}</div>
                </div>
                ${pct > 0 ? `<div class="card-progress"><span style="width:${pct.toFixed(1)}%"></span></div>` : ""}
            </div>
            <div class="card-body">
                <div class="card-body-title">${cardItem.title}</div>
                <div class="card-body-meta">${epLabel}</div>
            </div>
        </a>`;
      })
      .join("");

    $("continueRail").innerHTML = cards;
    $("continueRow").style.display = "block";

    document.querySelectorAll(".continue-card").forEach((card) => {
      card.addEventListener("click", () => {
        const provider = card.dataset.provider;
        const showId = card.dataset.showId;
        const episodeId = card.dataset.episodeId;
        const progress = card.dataset.progress;
        localStorage.setItem(providerKey, provider);
        const params = new URLSearchParams({ id: showId, provider });
        if (episodeId) params.set("ep", episodeId);
        if (progress) params.set("t", progress);
        window.location.href = `/watch?${params.toString()}`;
      });
    });
  } catch {
    // Not logged in or no history — skip silently
  }
}

// ── Main load ─────────────────────────────────────────────────
async function loadHome() {
  // Reset
  $("dynamicRows").innerHTML = `
    <div class="row" id="skelRow1">
    <div class="skel" style="height:22px;width:200px;border-radius:3px;margin-bottom:18px;"></div>
    <div class="rail">
        <div class="skel skel-portrait"></div><div class="skel skel-portrait"></div>
        <div class="skel skel-portrait"></div><div class="skel skel-portrait"></div>
        <div class="skel skel-portrait"></div><div class="skel skel-portrait"></div>
    </div>
    </div>
    <div class="row" id="skelRow2">
    <div class="skel" style="height:22px;width:160px;border-radius:3px;margin-bottom:18px;"></div>
    <div class="rail">
        <div class="skel skel-landscape"></div><div class="skel skel-landscape"></div>
        <div class="skel skel-landscape"></div><div class="skel skel-landscape"></div>
    </div>
    </div>`;

  try {
    const res = await fetchPublic(appendProvider("/api/home"));
    const json = await res.json();
    const categories = json.data || [];

    if (!categories.length) {
      $("dynamicRows").innerHTML =
        '<div class="empty-row">No content available for this provider.</div>';
      $("heroTitle").textContent = "Welcome to Streamio";
      $("heroDesc").textContent = "Select a provider above to get started.";
      $("heroActions").innerHTML =
        `<a href="/providers" class="btn btn-primary">Browse Providers</a>`;
      $("heroContent").classList.add("loaded");
      return;
    }

    // Hero: use first category's first item
    const featCat = categories.find((c) => isFeatured(c.name)) || categories[0];
    if (featCat && featCat.list && featCat.list.length) {
      buildHero(featCat.list);
    } else {
      $("heroTitle").textContent = "Welcome to Streamio";
      $("heroDesc").textContent = "Your unified streaming platform.";
      $("heroActions").innerHTML =
        `<a href="/catalog" class="btn btn-primary">Browse Catalog</a>`;
      $("heroContent").classList.add("loaded");
    }

    // Rows
    const sorted = [
      ...categories.filter((c) => isFeatured(c.name)),
      ...categories.filter((c) => !isFeatured(c.name)),
    ];
    $("dynamicRows").innerHTML = sorted
      .map((cat, i) => renderRow(cat, i))
      .join("");
  } catch (err) {
    $("dynamicRows").innerHTML =
      `<div class="empty-row">Failed to load content: ${err.message}</div>`;
  }
}

// ── Init ──────────────────────────────────────────────────────
// The session is restored first: what the content endpoints return depends on
// who is asking (18+ preference), and a fresh tab has no access token yet even
// when the refresh cookie is valid.
await ensureSessionQuietly();

// Awaited, not fired alongside the loads below: it settles which provider is
// active, and every card those loads render stamps that name into its link.
// Racing it means the first paint can still produce provider-less links.
await initProviders();

loadHome();
loadContinueWatching();
initShareBadge();
