import {
  api,
  logout,
  ensureSessionQuietly,
  fetchPublic,
  escapeHtml,
} from "/scripts/auth.js";
import { openShareModal, initShareBadge } from "/scripts/social.js";
// `providerName` on an item is the provider's registry slug ("local"), so it
// is labelled through the shared display-name map rather than printed raw. It
// has to be a slug: it is the same string a client sends back as `?provider=`.
import { getName as providerLabel } from "/scripts/provider-names.js";
import { ICON_FILM } from "/scripts/icons.js";
// The facts a title has, and how each is formatted, live in one place shared
// with the watch page — only the markup differs between them.
import {
  showFacts,
  formatNumber,
  formatDate,
  ageLabel,
  STAT_LABELS,
} from "/scripts/show-meta.js";

// ── Stato watchlist ─────────────────────────────────────────
let wlProvider = "";
let wlShowId = "";
let currentTitle = "";
let inWatchlist = false;
let isFavorite = false;
let userRating = null;
let ratingProvider = "";
let ratingShowId = "";

function renderWlBtn() {
  const btn = document.getElementById("wlBtn");
  if (!btn) return;
  if (inWatchlist) {
    btn.textContent = "✓ In Watchlist";
    btn.style.background = "rgba(70,211,105,0.15)";
    btn.style.borderColor = "rgba(70,211,105,0.4)";
    btn.style.color = "#46d369";
  } else {
    btn.textContent = "＋ Watchlist";
    btn.style.background = "";
    btn.style.borderColor = "";
    btn.style.color = "";
  }
}

async function toggleWatchlist() {
  if (!wlShowId) return;
  const btn = document.getElementById("wlBtn");
  if (btn) btn.disabled = true;

  if (inWatchlist) {
    await api(
      `/api/account/watchlist/${encodeURIComponent(wlProvider)}/${encodeURIComponent(wlShowId)}`,
      { method: "DELETE" },
    );
    inWatchlist = false;
  } else {
    await api(`/api/account/watchlist`, {
      method: "POST",
      body: { provider: wlProvider, show_id: wlShowId },
    });
    inWatchlist = true;
  }

  renderWlBtn();
  if (btn) btn.disabled = false;
}

// ── Carica watchlist per sapere se il titolo è già salvato ──
async function checkWatchlist(provider, showId) {
  const data = await api("/api/account/watchlist");
  if (!data) return; // utente non loggato
  inWatchlist = (data || []).some(
    (i) => i.provider === provider && i.show_id === showId,
  );
  renderWlBtn();
  checkFavorite(wlProvider, showId);
  checkRating(wlProvider, showId);
}

// ── Override loadDetails per iniettare il pulsante ──────────
const _origLoad = window.loadDetails; // salva l'originale
window.loadDetails = undefined; // previene doppio avvio

const providerStorageKey = "streamio.provider";
function appendProvider(url) {
  const p = localStorage.getItem(providerStorageKey) || "";
  if (!p) return url;
  return `${url}${url.includes("?") ? "&" : "?"}provider=${encodeURIComponent(p)}`;
}

const nav = document.getElementById("navbar");
window.addEventListener("scroll", () =>
  nav.classList.toggle("bg", window.scrollY > 40),
);

// ── Rendering dei dettagli estesi ────────────────────────────
// `s.details` is the provider's `ShowDetails` bag (core/models/ShowDetails.ts):
// everything a source publishes that has no flat field on Movie/TvShow. Every
// key is optional and a missing one means "this source doesn't publish it" —
// never a default — so each renderer below drops its row rather than printing
// a placeholder.

function metaRow(key, value) {
  return `<div class="meta-row"><span class="meta-key">${escapeHtml(key)}</span><span class="meta-val">${value}</span></div>`;
}

function textRow(key, value) {
  return value ? metaRow(key, escapeHtml(String(value))) : "";
}

/** Badges above the title: format, quality, maturity, audio tracks. */
function renderBadges(s) {
  const d = s.details || {};
  const badges = [];

  if (s.providerName) {
    badges.push(`<span class="badge badge-red">${escapeHtml(providerLabel(s.providerName))}</span>`);
  }
  if (s.rating) {
    const votes = d.stats?.votes ? ` (${formatNumber(d.stats.votes)})` : "";
    badges.push(`<span class="badge badge-rating">★ ${escapeHtml(String(s.rating))}${escapeHtml(votes)}</span>`);
  }
  if (d.contentType) badges.push(`<span class="badge badge-outline">${escapeHtml(d.contentType)}</span>`);
  if (s.quality) badges.push(`<span class="badge badge-outline">${escapeHtml(s.quality)}</span>`);
  if (d.status) badges.push(`<span class="badge badge-soft">${escapeHtml(d.status)}</span>`);
  // A number is an age (SC's `age`), a string is a certificate — both print as-is.
  const age = ageLabel(d.ageRating);
  if (age) badges.push(`<span class="badge badge-age">${escapeHtml(age)}</span>`);
  if (d.audio?.dubIta) badges.push(`<span class="badge badge-soft">ITA</span>`);
  if (d.audio?.subIta) badges.push(`<span class="badge badge-soft">SUB ITA</span>`);

  return badges.join("");
}

/** The line under the title: original and alternative titles the source lists. */
function renderSubtitle(s) {
  const d = s.details || {};
  const titles = [d.originalTitle, ...(d.alternativeTitles || [])]
    .filter((t) => t && t !== s.title);
  const unique = [...new Set(titles)];
  if (!unique.length) return "";
  return `<p class="detail-subtitle">${escapeHtml(unique.join(" · "))}</p>`;
}

function renderGenres(s) {
  // Most providers ship the id the browse wants, but some parse genre names off
  // the detail page without one — those link by name instead, and /search
  // resolves the name against that provider's own genre catalogue.
  const genreProvider = s.provider || localStorage.getItem(providerStorageKey) || "";
  const providerParam = genreProvider ? `&provider=${encodeURIComponent(genreProvider)}` : "";

  const tags = (s.genres || [])
    .filter((g) => g && g.name)
    .map((g) => {
      const target = g.id
        ? `genre=${encodeURIComponent(g.id)}`
        : `genreName=${encodeURIComponent(g.name)}`;
      return `<a class="genre-tag" href="/search?${target}${providerParam}">${escapeHtml(g.name)}</a>`;
    })
    .join("");

  return tags || null;
}

function renderMetaTable(s) {
  const d = s.details || {};

  const stats = Object.entries(STAT_LABELS)
    .map(([key, label]) => {
      const value = formatNumber(d.stats?.[key]);
      return value ? `<span class="stat-chip"><b>${escapeHtml(value)}</b> ${escapeHtml(label)}</span>` : "";
    })
    .filter(Boolean)
    .join("");

  const keywords = (d.keywords || [])
    .filter(Boolean)
    .map((k) => `<span class="keyword-tag">${escapeHtml(k)}</span>`)
    .join("");

  const links = (d.externalLinks || [])
    .filter((l) => l && l.url && /^https?:\/\//.test(l.url))
    .map((l) => `<a class="ext-tag" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.label || l.url)}</a>`)
    .join("");

  const genres = renderGenres(s);

  const rows = [
    textRow("Titolo", s.title),
    s.rating ? metaRow("Voto", `★ ${escapeHtml(String(s.rating))}`) : "",
    // Everything the source published, in the shared order.
    ...showFacts(s).map((f) => textRow(f.label, f.value)),
    s.providerName ? textRow("Provider", providerLabel(s.providerName)) : "",
    genres ? metaRow("Generi", genres) : "",
    keywords ? metaRow("Tag", `<span class="tag-wrap">${keywords}</span>`) : "",
    stats ? metaRow("Statistiche", `<span class="tag-wrap">${stats}</span>`) : "",
    links ? metaRow("Link", `<span class="tag-wrap">${links}</span>`) : "",
  ]
    .filter(Boolean)
    .join("");

  return `<div class="meta-table">${rows || '<div class="meta-row"><span class="meta-val" style="color:var(--muted)">No additional info</span></div>'}</div>`;
}

/**
 * Cast and crew. Names come from the source; photos are whatever TMDB matched,
 * so a person with no match still gets a card with their initials.
 * Built as DOM rather than markup because the fallback used to be an inline
 * `onerror` with a provider-supplied string interpolated into it.
 */
function renderCast(s) {
  const people = [
    ...(s.directors || []).map((p) => ({ ...p, role: "Regia" })),
    ...(s.cast || []).map((p) => ({ ...p, role: "Cast" })),
  ].filter((p) => p && p.name);

  const rail = document.getElementById("castRail");
  if (!people.length) return;

  rail.replaceChildren(
    ...people.map((p) => {
      const card = document.createElement("div");
      card.className = "person-card";

      const avatar = document.createElement("div");
      avatar.className = "person-avatar";

      if (p.image) {
        const img = document.createElement("img");
        img.src = p.image;
        img.alt = "";
        img.loading = "lazy";
        img.addEventListener("error", () => {
          img.remove();
          avatar.textContent = p.name.slice(0, 1).toUpperCase();
        });
        avatar.appendChild(img);
      } else {
        avatar.textContent = p.name.slice(0, 1).toUpperCase();
      }

      const name = document.createElement("div");
      name.className = "person-name";
      name.textContent = p.name;

      const role = document.createElement("div");
      role.className = "person-role";
      role.textContent = p.role;

      card.append(avatar, name, role);
      return card;
    }),
  );

  document.getElementById("castSection").style.display = "block";
}

/**
 * Seasons, where the source lists them. Informational only: `/watch` picks the
 * season from its own selector and takes no season parameter, so linking each
 * card at the player would be a link that silently ignores which one was clicked.
 */
function renderSeasons(s) {
  const seasons = (s.seasons || []).filter((season) => season && season.id);
  if (!seasons.length) return;

  document.getElementById("seasonList").innerHTML = seasons
    .map((season) => {
      const label = season.title || (season.number ? `Stagione ${season.number}` : "Episodi");
      const meta = [
        season.episodeCount ? `${season.episodeCount} episodi` : "",
        formatDate(season.released) || "",
      ]
        .filter(Boolean)
        .join(" · ");

      return `
        <div class="season-card">
          <div class="season-name">${escapeHtml(label)}</div>
          ${meta ? `<div class="season-meta">${escapeHtml(meta)}</div>` : ""}
          ${season.overview ? `<p class="season-overview">${escapeHtml(season.overview)}</p>` : ""}
        </div>`;
    })
    .join("");

  document.getElementById("seasonsSection").style.display = "block";
}

async function loadDetails() {
  const params = new URLSearchParams(window.location.search);
  const showId = params.get("id");
  const provider = params.get("provider");
  if (provider) localStorage.setItem(providerStorageKey, provider);

  if (!showId) {
    document.getElementById("backdropSection").innerHTML = `
        <div class="empty-state">
        <h2>No Show Selected</h2>
        <p>Please select a show from the catalog.</p>
        <a href="/catalog" style="color:var(--red);text-decoration:none;margin-top:20px;font-weight:600;">Browse Catalog →</a>
        </div>`;
    return;
  }

  try {
    const res = await fetchPublic(
      appendProvider(`/api/shows/${encodeURIComponent(showId)}`),
    );
    const data = await res.json();

    if (res.status === 403) {
      document.getElementById("backdropSection").innerHTML =
        `<div class="empty-state"><h2>Not Available</h2><p>This title is flagged 18+. Enable <code>adult_content</code> on your account to view it.</p>
         <a href="/account" style="color:var(--red);text-decoration:none;margin-top:20px;font-weight:600;">Go to Preferences →</a></div>`;
      return;
    }

    if (!res.ok || !data.data) {
      document.getElementById("backdropSection").innerHTML =
        `<div class="empty-state"><h2>Not Found</h2><p>This show could not be found.</p></div>`;
      return;
    }

    const s = data.data;
    document.title = `${s.title || "Details"} — Streamio`;

    // Salva per watchlist
    wlProvider = s.provider || localStorage.getItem(providerStorageKey) || "";
    wlShowId = showId;
    currentTitle = s.title || "";

    // Backdrop (uguale all'originale + pulsante watchlist nella cta-row)
    const bannerPrimary = s.banner || s.poster || "";
    const bannerFallback = s.banner && s.poster ? s.poster : "";
    document.getElementById("backdropSection").innerHTML = `
        <div class="backdrop">
        ${bannerPrimary ? `<img id="backdropImg" src="${bannerPrimary}" ${bannerFallback ? `data-fallback="${bannerFallback}"` : ""} alt="" onerror="window._bdErr(this)">` : ""}
        <div class="backdrop-gradient"></div>
        <div class="backdrop-content">
            <div class="badge-row">${renderBadges(s)}</div>
            <h1 class="detail-title">${escapeHtml(s.title || "Unknown")}</h1>
            ${renderSubtitle(s)}
            <p class="detail-overview">${escapeHtml(s.overview || "No description available.")}</p>
            <div class="cta-row">
                <a href="/watch?id=${encodeURIComponent(s.id)}&provider=${encodeURIComponent(s.provider || localStorage.getItem(providerStorageKey) || "")}" class="btn-play">▶ &nbsp;Play</a>
                <button id="wlBtn" class="btn-more" onclick="window._toggleWl()" style="border:1px solid rgba(255,255,255,0.25);cursor:pointer;">
                    ＋ Watchlist
                </button>
                <button id="favBtn" class="btn-more" onclick="window._toggleFav()" style="border:1px solid rgba(255,255,255,0.25);cursor:pointer;">
                    ♡ Preferiti
                </button>
                <button id="ratingBtn" class="btn-more" onclick="window._openRating()" style="border:1px solid rgba(255,255,255,0.25);cursor:pointer;">
                    ☆ Vota
                </button>
                <button id="shareBtn" class="btn-more" onclick="window._openShare()" style="border:1px solid rgba(255,255,255,0.25);cursor:pointer;">
                    Share
                </button>
                <button id="watchPartyBtn" class="btn-more" onclick="window._startWatchParty()" style="border:1px solid rgba(255,255,255,0.25);cursor:pointer;">
                    Watch Party
                </button>
                ${s.trailer ? `<a href="${escapeHtml(s.trailer)}" target="_blank" rel="noopener noreferrer" class="btn-more">▶ &nbsp;Trailer</a>` : ""}
                <a href="/catalog" class="btn-more">← &nbsp;Back</a>
            </div>
        </div>
        </div>
    `;

    // Esponi toggle globalmente (il pulsante usa onclick inline)
    window._toggleWl = toggleWatchlist;

    window._bdErr = function (img) {
      const fallback = img.dataset.fallback;
      if (fallback && img.src !== fallback) {
        img.src = fallback;
      } else {
        img.remove();
      }
    };

    // Controlla se già in watchlist (silenzioso se non loggato)
    checkWatchlist(wlProvider, showId);

    document.getElementById("detailsMeta").innerHTML = renderMetaTable(s);
    document.getElementById("detailsPanel").style.display = "grid";
    renderCast(s);
    renderSeasons(s);
    renderRecommendations(s.recommendations);
  } catch (err) {
    document.getElementById("backdropSection").innerHTML =
      `<div class="empty-state"><h2>Error</h2><p>${err.message}</p></div>`;
  }
}

function renderRecommendations(recommendations) {
  if (!recommendations || recommendations.length === 0) return;

  const grid = document.getElementById("recGrid");
  grid.innerHTML = recommendations
    .map((r) => {
      const url = `/details?id=${encodeURIComponent(r.id)}&provider=${encodeURIComponent(r.provider || localStorage.getItem(providerStorageKey) || "")}`;
      const img = r.poster
        ? `<img src="${escapeHtml(r.poster)}" alt="${escapeHtml(r.title || "")}" loading="lazy">`
        : `<div class="rec-card-placeholder">${ICON_FILM}</div>`;
      const rating = r.rating
        ? `<div class="rec-card-rating">★ ${escapeHtml(String(r.rating))}</div>`
        : "";
      const year = r.released ? String(r.released).slice(0, 4) : "";
      const type = r.details?.contentType || "";
      const sub = [type, year].filter(Boolean).join(" · ");
      return `
        <a href="${url}" class="rec-card">
        ${img}
        <div class="rec-card-info">
            <div class="rec-card-title">${escapeHtml(r.title || "Unknown")}</div>
            ${sub ? `<div class="rec-card-sub">${escapeHtml(sub)}</div>` : ""}
            ${rating}
        </div>
        </a>`;
    })
    .join("");

  document.getElementById("recommendationsSection").style.display = "block";
}
function renderFavBtn() {
  const btn = document.getElementById("favBtn");
  if (!btn) return;
  if (isFavorite) {
    btn.textContent = "♥ Favorito";
    btn.style.background = "rgba(229,9,20,0.15)";
    btn.style.borderColor = "rgba(229,9,20,0.4)";
    btn.style.color = "var(--red)";
  } else {
    btn.textContent = "♡ Preferiti";
    btn.style.background = "";
    btn.style.borderColor = "";
    btn.style.color = "";
  }
}

async function toggleFavorite() {
  if (!wlShowId) return;
  const btn = document.getElementById("favBtn");
  if (btn) btn.disabled = true;
  if (isFavorite) {
    await api(
      `/api/account/favorites/${encodeURIComponent(wlProvider)}/${encodeURIComponent(wlShowId)}`,
      { method: "DELETE" },
    );
    isFavorite = false;
  } else {
    await api("/api/account/favorites", {
      method: "POST",
      body: { provider: wlProvider, show_id: wlShowId },
    });
    isFavorite = true;
  }
  renderFavBtn();
  if (btn) btn.disabled = false;
}

async function checkFavorite(provider, showId) {
  const data = await api(
    `/api/account/favorites/${encodeURIComponent(provider)}/${encodeURIComponent(showId)}`,
  );
  if (!data) return;
  isFavorite = data.favorite === true;
  renderFavBtn();
}

function renderRatingBtn() {
  const btn = document.getElementById("ratingBtn");
  if (!btn) return;
  btn.textContent = userRating ? `★ ${userRating}/10` : "☆ Vota";
  btn.style.background = userRating ? "rgba(245,197,24,0.15)" : "";
  btn.style.borderColor = userRating ? "rgba(245,197,24,0.4)" : "";
  btn.style.color = userRating ? "#f5c518" : "";
}

async function checkRating(provider, showId) {
  const data = await api(
    `/api/account/ratings/${encodeURIComponent(provider)}/${encodeURIComponent(showId)}`,
  );
  if (!data) return;
  userRating = data.rating ?? null;
  renderRatingBtn();
}

async function submitRating(value) {
  const n = parseInt(value);
  if (!n || n < 1 || n > 10) return;
  await api(
    `/api/account/ratings/${encodeURIComponent(wlProvider)}/${encodeURIComponent(wlShowId)}`,
    {
      method: "PUT",
      body: { rating: n },
    },
  );
  userRating = n;
  renderRatingBtn();
  document.getElementById("ratingModal")?.remove();
}

function openRatingModal() {
  document.getElementById("ratingModal")?.remove();
  const modal = document.createElement("div");
  modal.id = "ratingModal";
  modal.style.cssText =
    "position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);";
  modal.innerHTML = `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:32px 28px;min-width:300px;text-align:center;">
            <div style="font-family:'Bebas Neue',sans-serif;font-size:1.6rem;letter-spacing:0.06em;margin-bottom:20px;">Il tuo voto</div>
            <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-bottom:24px;">
                ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
                  .map(
                    (n) => `
                    <button onclick="window._submitRating(${n})" style="
                        width:40px;height:40px;border-radius:5px;border:1px solid var(--border);
                        background:${userRating === n ? "rgba(245,197,24,0.2)" : "var(--surface2)"};
                        color:${userRating === n ? "#f5c518" : "var(--text)"};
                        font-weight:700;cursor:pointer;font-size:0.9rem;
                        border-color:${userRating === n ? "rgba(245,197,24,0.5)" : "var(--border)"};
                    ">${n}</button>
                `,
                  )
                  .join("")}
            </div>
            ${userRating ? `<button onclick="window._deleteRating()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:0.82rem;text-decoration:underline;margin-bottom:12px;">Rimuovi voto</button><br>` : ""}
            <button onclick="document.getElementById('ratingModal').remove()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:0.85rem;margin-top:4px;">Annulla</button>
        </div>
    `;
  document.body.appendChild(modal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
}

async function deleteRating() {
  await api(
    `/api/account/ratings/${encodeURIComponent(wlProvider)}/${encodeURIComponent(wlShowId)}`,
    { method: "DELETE" },
  );
  userRating = null;
  renderRatingBtn();
  document.getElementById("ratingModal")?.remove();
}

window._toggleFav = toggleFavorite;
window._openRating = openRatingModal;
window._submitRating = submitRating;
window._deleteRating = deleteRating;
window._openShare = () =>
  openShareModal({
    provider: wlProvider,
    show_id: wlShowId,
    summary: currentTitle ? `Sharing "${currentTitle}"` : undefined,
  });

window._startWatchParty = async () => {
  if (!wlShowId) return;
  const btn = document.getElementById("watchPartyBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Starting…";
  }
  try {
    const room = await api("/api/rooms", {
      method: "POST",
      body: { provider: wlProvider, show_id: wlShowId },
    });
    const params = new URLSearchParams({ id: wlShowId, room: room.code });
    if (wlProvider) params.set("provider", wlProvider);
    window.location.href = `/watch?${params.toString()}`;
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Watch Party";
    }
    alert(
      err.message === "Not authenticated"
        ? "Log in to start a watch party."
        : `Could not start watch party: ${err.message}`,
    );
  }
};

// A title can be 18+-gated, so the server has to know who is asking.
await ensureSessionQuietly();

loadDetails();
initShareBadge();
