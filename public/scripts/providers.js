import { ensureSessionQuietly, fetchPublic } from "/scripts/auth.js";
import { getName, groupFamilies } from "/scripts/provider-names.js";

const KEY = "streamio.provider";
let current = localStorage.getItem(KEY) || "";
let allProviders = [];
let families = [];

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2500);
}

/** The language of `family` that is selected right now, if any. */
function activeLanguage(family) {
  return family.languages.find((l) => l.slug === current) || null;
}

/** What clicking the card itself should select: the current language, else the first. */
function targetSlug(family) {
  return (activeLanguage(family) || family.languages[0]).slug;
}

/** The active source's own label, language included when it has more than one. */
function currentLabel() {
  for (const family of families) {
    const language = activeLanguage(family);
    if (!language) continue;

    return family.languages.length > 1
      ? `${family.displayName} · ${language.label}`
      : family.displayName;
  }

  return getName(current);
}

function render() {
  const banner = document.getElementById("activeBanner");
  if (current) {
    banner.style.display = "flex";
    document.getElementById("activeName").textContent = currentLabel();
  } else {
    banner.style.display = "none";
  }

  const list = document.getElementById("providerList");
  if (!families.length) {
    list.innerHTML = '<p class="empty">No providers found.</p>';
    return;
  }

  list.innerHTML = families
    .map((family, i) => {
      const language = activeLanguage(family);
      const isActive = Boolean(language);

      // A source available in one language shows no selector at all, so nothing
      // changes visually for the ones that have always had just the one.
      const languages =
        family.languages.length > 1
          ? `<div class="provider-langs">
              ${family.languages
                .map(
                  (l) => `
                <button class="lang-btn${l.slug === current ? " active" : ""}"
                    data-slug="${escapeHtml(l.slug)}">${escapeHtml(l.label)}</button>`,
                )
                .join("")}
            </div>`
          : "";

      return `
        <div class="provider-card${isActive ? " active" : ""}" style="animation-delay:${i * 0.06}s"
            data-slug="${escapeHtml(targetSlug(family))}">
        <div class="provider-info">
            <div class="provider-name">
            ${escapeHtml(family.displayName)}
            ${family.adult ? '<span class="adult-chip">18+</span>' : ""}
            ${isActive ? '<span class="active-chip">Active</span>' : ""}
            </div>
            <div class="provider-sub">${escapeHtml(family.description)}</div>
            ${languages}
        </div>
        <button class="switch-btn${isActive ? " active" : ""}" data-slug="${escapeHtml(targetSlug(family))}">
            ${isActive ? "✓ Active" : "Switch"}
        </button>
        </div>
    `;
    })
    .join("");
}

function switchTo(slug) {
  if (!slug || slug === current) return;
  current = slug;
  localStorage.setItem(KEY, slug);
  render();
  showToast(`Switched to ${currentLabel()}`);
}

async function load() {
  try {
    const res = await fetchPublic("/api/providers/");
    const data = await res.json();
    allProviders = data.providers || [];

    // The server drops a provider the visitor may no longer use (18+ turned
    // off, signed out), so a stale selection has to go with it.
    if (current && !allProviders.includes(current)) {
      current = "";
      localStorage.removeItem(KEY);
    }

    // `catalog` is flat, one entry per language; an install that predates it
    // gives us only the bare names, which group into one family each.
    families = groupFamilies(
      data.catalog?.length ? data.catalog : allProviders.map((name) => ({ name })),
    );

    render();
  } catch (err) {
    document.getElementById("providerList").innerHTML =
      `<p class="empty">Error: ${escapeHtml(err.message)}</p>`;
  }
}

// Delegated rather than inline `onclick`: the markup is re-rendered on every
// switch, and a slug interpolated into an HTML attribute is one quoting
// mistake away from breaking the card it belongs to.
document.getElementById("providerList").addEventListener("click", (e) => {
  const target = e.target.closest("[data-slug]");
  if (target) switchTo(target.dataset.slug);
});

// Which providers the server lists depends on who is asking.
await ensureSessionQuietly();

load();
import("/scripts/social.js").then((m) => m.initShareBadge());
