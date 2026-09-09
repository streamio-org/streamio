import { api, logout } from '/scripts/auth.js';
import { groupFamilies, getLanguageLabel } from '/scripts/provider-names.js';
import { ICON_ALERT, ICON_RADIO } from '/scripts/icons.js';

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

let providers = [];

// Same probe account.js's admin tab uses: there's no admin flag on the user
// object, so a 403 from an admin-gated endpoint is the only signal. Here it
// gates the whole page, not just a tab, since a non-admin has no reason to
// land here at all.
//
// Returns 'yes' | 'no' | 'unknown'. The third case matters: this used to be a
// bare `catch` returning false, so a transient 503 while the server couldn't
// reach the database bounced a real admin back to /account as though they had
// been denied. 'unknown' keeps them here and says what happened.
async function checkAdminAccess() {
  try {
    await api('/api/settings/sync');
    return 'yes';
  } catch (err) {
    if (err?.status === 403) return 'no';
    return 'unknown';
  }
}

async function boot() {
  const access = await checkAdminAccess();

  if (access === 'no') {
    window.location.href = '/account';
    return;
  }

  if (access === 'unknown') {
    $('providersContent').innerHTML =
      `<div class="empty"><div class="empty-icon">${ICON_ALERT}</div>` +
      `<h3>Couldn't Check Access</h3>` +
      `<p>The server didn't answer. This isn't a permission problem — reload to try again.</p></div>`;
    return;
  }

  loadProviders();
}

async function loadProviders() {
  try {
    providers = await api('/api/settings/providers');
    renderProviders();
  } catch (err) {
    $('providersContent').innerHTML = `<div class="empty"><div class="empty-icon">${ICON_ALERT}</div><h3>Couldn't Load</h3><p>${err.message || 'Failed to load providers.'}</p></div>`;
  }
}

function renderProviders() {
  if (!providers.length) {
    $('providersContent').innerHTML = `
      <div class="empty">
        <div class="empty-icon">${ICON_RADIO}</div>
        <h3>No Providers</h3>
        <p>No content sources are registered on this server.</p>
      </div>`;
    return;
  }

  const families = groupFamilies(providers);
  const bySlug = new Map(providers.map(p => [p.name, p]));

  $('providersContent').innerHTML = families.map(family => `
    <div class="card">
      <div class="card-title">${family.displayName}</div>
      <div class="section-sub" style="margin-bottom:12px;">${family.description}</div>
      <div class="pref-grid">
        ${family.languages.map(lang => {
          const p = bySlug.get(lang.slug);
          const disabled = p?.disabled === true;
          return `
          <div class="pref-row">
            <div class="pref-info">
              <div class="pref-key">${lang.label || getLanguageLabel(lang.code)}</div>
              <div class="pref-desc">${lang.slug}</div>
            </div>
            <div class="pref-actions">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                <input type="checkbox" data-toggle-slug="${lang.slug}" ${!disabled ? 'checked' : ''} />
                <span data-toggle-label="${lang.slug}" style="font-size:0.85rem;">${disabled ? 'Disabled' : 'Enabled'}</span>
              </label>
              <button class="btn btn-ghost btn-sm" data-clear-cache="${lang.slug}">Clear Cache</button>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`).join('');

  document.querySelectorAll('[data-toggle-slug]').forEach(input => {
    input.addEventListener('change', async () => {
      const slug = input.dataset.toggleSlug;
      const disabled = !input.checked;
      try {
        await api(`/api/settings/providers/${slug}`, { method: 'PUT', body: { disabled } });
        const p = bySlug.get(slug);
        if (p) p.disabled = disabled;
        document.querySelector(`[data-toggle-label="${slug}"]`).textContent = disabled ? 'Disabled' : 'Enabled';
        toast(disabled ? `${slug} disabled.` : `${slug} enabled.`);
      } catch (err) {
        input.checked = !input.checked;
        toast(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-clear-cache]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const slug = btn.dataset.clearCache;
      try {
        const result = await api(`/api/settings/providers/${slug}/clear-cache`, { method: 'POST' });
        toast(`Cleared ${result.keysDeleted} cache ${result.keysDeleted === 1 ? 'entry' : 'entries'} for ${slug}.`);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });
}

boot();

document.getElementById('logoutLink').addEventListener('click', e => {
  e.preventDefault();
  logout();
});
