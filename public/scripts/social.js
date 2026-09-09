/**
 * social.js — shared follow/share/reaction UI helpers for Streamio
 *
 * Used by account.js (Social tab), details.js (Share button on a show),
 * and watch.js (Share button on the player, for clips).
 */
import { api, getAccessToken, escapeHtml } from '/scripts/auth.js';

export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

// ── Unread-share notification badge ──────────────────────────
// Shown on the "Account" nav link(s) and the account page's Social tab.
function setBadgeCount(el, count) {
  let badge = el.querySelector('.notif-badge');
  if (count > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'notif-badge';
      badge.style.cssText =
        'display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;margin-left:6px;border-radius:8px;background:#e50914;color:#fff;font-size:0.65rem;font-weight:700;line-height:1;vertical-align:middle;';
      el.appendChild(badge);
    }
    badge.textContent = count > 9 ? '9+' : String(count);
  } else if (badge) {
    badge.remove();
  }
}

/** Re-fetches the unread count and updates any badge(s) present on the current page. */
export async function refreshShareBadge() {
  if (!getAccessToken()) return;
  try {
    const { count } = await api('/api/social/shares/unread-count');
    document.querySelectorAll('a[href="/account"]').forEach((el) => setBadgeCount(el, count));
    const socialTab = document.querySelector('.tab-btn[data-tab="social"]');
    if (socialTab) setBadgeCount(socialTab, count);
  } catch {
    /* not logged in / transient error — leave badge as-is */
  }
}

let shareBadgePollStarted = false;
/** Call once per page: shows the badge now and keeps it fresh while the tab is open. */
export function initShareBadge() {
  refreshShareBadge();
  if (shareBadgePollStarted) return;
  shareBadgePollStarted = true;
  setInterval(refreshShareBadge, 45000);
}

// ── Share modal ──────────────────────────────────────────────
let shareModalEl = null;
let selectedRecipients = new Map(); // id -> display name
let searchDebounce;
// Set fresh each time the modal opens; read back when the user hits Send.
let clipContext = { active: false, duration: 0 };

function ensureClipSliderStyle() {
  if (document.getElementById('socialClipStyle')) return;
  const style = document.createElement('style');
  style.id = 'socialClipStyle';
  style.textContent = `
    .clip-range-input { -webkit-appearance:none; appearance:none; background:transparent; pointer-events:none; position:absolute; left:0; top:8px; width:100%; margin:0; }
    .clip-range-input::-webkit-slider-runnable-track { height:3px; background:rgba(255,255,255,0.15); border-radius:2px; }
    .clip-range-input::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; pointer-events:auto; width:15px; height:15px; border-radius:50%; background:var(--red,#e50914); cursor:pointer; margin-top:-6px; box-shadow:0 0 0 3px rgba(0,0,0,0.5); }
    .clip-range-input::-moz-range-track { height:3px; background:rgba(255,255,255,0.15); border-radius:2px; }
    .clip-range-input::-moz-range-thumb { pointer-events:auto; width:15px; height:15px; border-radius:50%; background:var(--red,#e50914); cursor:pointer; border:none; }
  `;
  document.head.appendChild(style);
}

function ensureShareModal() {
  if (shareModalEl) return shareModalEl;
  ensureClipSliderStyle();

  const el = document.createElement('div');
  el.id = 'socialShareModal';
  el.style.cssText =
    'position:fixed;inset:0;z-index:300;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.7);';
  el.innerHTML = `
    <div style="background:var(--surface,#1f1f1f);border:1px solid var(--border,rgba(255,255,255,0.08));border-radius:10px;padding:28px;width:380px;max-width:92vw;max-height:86vh;overflow-y:auto;">
      <div style="font-family:'Bebas Neue',sans-serif;font-size:1.5rem;letter-spacing:0.06em;margin-bottom:16px;color:var(--text,#fff);">Share</div>
      <div id="socialShareSummary" style="font-size:0.82rem;color:var(--muted,#b3b3b3);margin-bottom:14px;"></div>

      <div id="socialClipSection" style="display:none;margin-bottom:16px;padding:12px;border:1px solid var(--border,rgba(255,255,255,.08));border-radius:8px;">
        <div style="display:flex;gap:16px;margin-bottom:12px;font-size:0.8rem;color:var(--text,#fff);">
          <label style="cursor:pointer;display:flex;align-items:center;gap:6px;">
            <input type="radio" name="socialClipMode" id="socialClipModeClip" value="clip" checked> Share a clip
          </label>
          <label style="cursor:pointer;display:flex;align-items:center;gap:6px;">
            <input type="radio" name="socialClipMode" id="socialClipModeFull" value="full"> Whole episode
          </label>
        </div>
        <div id="socialClipSliderWrap" style="position:relative;height:24px;">
          <input type="range" id="clipStartRange" class="clip-range-input" min="0" max="100" step="1" value="0">
          <input type="range" id="clipEndRange" class="clip-range-input" min="0" max="100" step="1" value="30">
        </div>
        <div id="socialClipLabel" style="text-align:center;font-size:0.78rem;color:var(--muted,#b3b3b3);margin-top:4px;"></div>
      </div>

      <input id="socialShareSearch" type="text" placeholder="Search people by name…"
        style="width:100%;padding:10px 12px;border-radius:6px;border:1px solid var(--border,rgba(255,255,255,.08));background:var(--surface2,#2a2a2a);color:var(--text,#fff);font-size:0.9rem;margin-bottom:8px;box-sizing:border-box;">
      <div id="socialShareResults" style="max-height:140px;overflow-y:auto;margin-bottom:8px;"></div>
      <div id="socialShareChips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;"></div>
      <textarea id="socialShareMessage" placeholder="Add a message (optional)"
        style="width:100%;min-height:60px;padding:10px 12px;border-radius:6px;border:1px solid var(--border,rgba(255,255,255,.08));background:var(--surface2,#2a2a2a);color:var(--text,#fff);font-size:0.85rem;resize:vertical;margin-bottom:12px;box-sizing:border-box;"></textarea>
      <div id="socialShareError" style="color:var(--red,#e50914);font-size:0.8rem;margin-bottom:8px;display:none;"></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button id="socialShareCancel" style="background:none;border:1px solid var(--border,rgba(255,255,255,.08));color:var(--muted,#b3b3b3);padding:9px 16px;border-radius:6px;cursor:pointer;">Cancel</button>
        <button id="socialShareSubmit" style="background:var(--red,#e50914);border:none;color:#fff;padding:9px 18px;border-radius:6px;cursor:pointer;font-weight:600;">Send</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => { if (e.target === el) closeShareModal(); });
  shareModalEl = el;
  return el;
}

function formatClipTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const MIN_CLIP_GAP_SECONDS = 3;

function setupClipSlider(duration, initialStart, initialEnd) {
  const section = document.getElementById('socialClipSection');
  const sliderWrap = document.getElementById('socialClipSliderWrap');
  const label = document.getElementById('socialClipLabel');
  const startRange = document.getElementById('clipStartRange');
  const endRange = document.getElementById('clipEndRange');
  const clipModeRadio = document.getElementById('socialClipModeClip');
  const fullModeRadio = document.getElementById('socialClipModeFull');

  const dur = Math.max(MIN_CLIP_GAP_SECONDS, Math.floor(duration));
  const start = Math.min(Math.max(0, Math.floor(initialStart ?? 0)), dur - MIN_CLIP_GAP_SECONDS);
  const end = Math.min(Math.max(start + MIN_CLIP_GAP_SECONDS, Math.floor(initialEnd ?? start + 30)), dur);

  [startRange, endRange].forEach((r) => { r.min = 0; r.max = dur; });
  startRange.value = start;
  endRange.value = end;

  function updateLabel() {
    label.textContent = `Clip: ${formatClipTime(startRange.value)} – ${formatClipTime(endRange.value)}`;
  }
  startRange.oninput = () => {
    if (+startRange.value > +endRange.value - MIN_CLIP_GAP_SECONDS) {
      startRange.value = Math.max(0, +endRange.value - MIN_CLIP_GAP_SECONDS);
    }
    updateLabel();
  };
  endRange.oninput = () => {
    if (+endRange.value < +startRange.value + MIN_CLIP_GAP_SECONDS) {
      endRange.value = Math.min(dur, +startRange.value + MIN_CLIP_GAP_SECONDS);
    }
    updateLabel();
  };
  updateLabel();

  function applyMode() {
    const wholeEpisode = fullModeRadio.checked;
    sliderWrap.style.display = wholeEpisode ? 'none' : 'block';
    label.style.display = wholeEpisode ? 'none' : 'block';
  }
  clipModeRadio.checked = true;
  clipModeRadio.onchange = applyMode;
  fullModeRadio.onchange = applyMode;
  applyMode();

  section.style.display = 'block';
  clipContext = { active: true, duration: dur };
}

function closeShareModal() {
  if (shareModalEl) shareModalEl.style.display = 'none';
}

function renderChips() {
  const wrap = document.getElementById('socialShareChips');
  wrap.innerHTML = [...selectedRecipients.entries()]
    .map(
      ([id, name]) => `
    <span data-id="${escapeHtml(id)}" style="background:var(--surface3,#333);border-radius:20px;padding:4px 10px;font-size:0.78rem;display:inline-flex;align-items:center;gap:6px;color:var(--text,#fff);">
      ${escapeHtml(name)} <span data-remove="${escapeHtml(id)}" style="cursor:pointer;opacity:0.7;">✕</span>
    </span>`
    )
    .join('');
  wrap.querySelectorAll('[data-remove]').forEach((x) => {
    x.addEventListener('click', () => {
      selectedRecipients.delete(x.dataset.remove);
      renderChips();
    });
  });
}

function renderResults(users) {
  const wrap = document.getElementById('socialShareResults');
  if (!users.length) {
    wrap.innerHTML = '';
    return;
  }
  // Display names come from other users' profiles — raw here would be stored
  // XSS in a page that holds the viewer's access token.
  wrap.innerHTML = users
    .map(
      (u) => `
    <div data-id="${escapeHtml(u.id)}" data-name="${escapeHtml(u.display_name || 'User')}"
      class="social-result-row"
      style="padding:7px 8px;border-radius:6px;cursor:pointer;font-size:0.85rem;color:var(--text,#fff);">
      ${escapeHtml(u.display_name || 'User')}
    </div>`
    )
    .join('');
  wrap.querySelectorAll('.social-result-row').forEach((row) => {
    row.addEventListener('mouseenter', () => (row.style.background = 'var(--surface2,#2a2a2a)'));
    row.addEventListener('mouseleave', () => (row.style.background = ''));
    row.addEventListener('click', () => {
      selectedRecipients.set(row.dataset.id, row.dataset.name);
      renderChips();
      document.getElementById('socialShareSearch').value = '';
      wrap.innerHTML = '';
    });
  });
}

/**
 * Opens the share modal.
 *
 * @param {object} content - { provider, show_id, episode_id?, episode_label?, clip_start_seconds?, clip_end_seconds?, duration?, summary? }
 *   Pass `duration` (total seconds of the episode/movie) to show the clip-range
 *   slider; omit it to share the content as a whole (e.g. from the details page).
 * @param {function} [onShared] - called after a successful share
 */
export function openShareModal(content, onShared) {
  const el = ensureShareModal();
  selectedRecipients = new Map();
  renderChips();
  document.getElementById('socialShareResults').innerHTML = '';
  document.getElementById('socialShareSearch').value = '';
  document.getElementById('socialShareMessage').value = '';
  document.getElementById('socialShareSummary').textContent = content.summary || '';
  document.getElementById('socialShareError').style.display = 'none';

  clipContext = { active: false, duration: 0 };
  if (typeof content.duration === 'number' && content.duration > MIN_CLIP_GAP_SECONDS) {
    setupClipSlider(content.duration, content.clip_start_seconds, content.clip_end_seconds);
  } else {
    document.getElementById('socialClipSection').style.display = 'none';
  }

  el.style.display = 'flex';

  const searchInput = document.getElementById('socialShareSearch');
  searchInput.oninput = () => {
    clearTimeout(searchDebounce);
    const q = searchInput.value.trim();
    if (!q) {
      document.getElementById('socialShareResults').innerHTML = '';
      return;
    }
    searchDebounce = setTimeout(async () => {
      try {
        const users = await api(`/api/social/users/search?q=${encodeURIComponent(q)}`);
        renderResults(users.filter((u) => !selectedRecipients.has(u.id)));
      } catch {
        /* ignore transient search errors */
      }
    }, 250);
  };

  document.getElementById('socialShareCancel').onclick = closeShareModal;
  document.getElementById('socialShareSubmit').onclick = async () => {
    const errEl = document.getElementById('socialShareError');
    errEl.style.display = 'none';
    if (selectedRecipients.size === 0) {
      errEl.textContent = 'Pick at least one person to share with.';
      errEl.style.display = 'block';
      return;
    }
    const btn = document.getElementById('socialShareSubmit');
    btn.disabled = true;
    btn.textContent = 'Sending…';

    let clipStartSeconds, clipEndSeconds;
    if (clipContext.active && document.getElementById('socialClipModeClip').checked) {
      clipStartSeconds = parseInt(document.getElementById('clipStartRange').value, 10);
      clipEndSeconds = parseInt(document.getElementById('clipEndRange').value, 10);
    }

    try {
      await api('/api/social/shares', {
        method: 'POST',
        body: {
          provider: content.provider,
          show_id: content.show_id,
          episode_id: content.episode_id ?? undefined,
          episode_label: content.episode_label ?? undefined,
          clip_start_seconds: clipStartSeconds,
          clip_end_seconds: clipEndSeconds,
          message: document.getElementById('socialShareMessage').value.trim() || undefined,
          recipient_ids: [...selectedRecipients.keys()],
        },
      });
      closeShareModal();
      if (typeof onShared === 'function') onShared();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send';
    }
  };
}

// ── Reactions ────────────────────────────────────────────────

export function renderReactionBar(shareId, reactions, myUserId) {
  const mine = (reactions || []).find((r) => r.user.id === myUserId);
  const counts = {};
  (reactions || []).forEach((r) => (counts[r.emoji] = (counts[r.emoji] || 0) + 1));
  return `<div class="reaction-bar" data-share="${shareId}">${REACTIONS.map(
    (emoji) => `
    <button type="button" class="reaction-btn${mine?.emoji === emoji ? ' active' : ''}" data-emoji="${emoji}" data-share="${shareId}">
      ${emoji}${counts[emoji] ? `<span class="reaction-count">${counts[emoji]}</span>` : ''}
    </button>`
  ).join('')}</div>`;
}

/** Wires click handlers on all `.reaction-btn` elements within `container`. */
export function attachReactionHandlers(container, onChanged) {
  container.querySelectorAll('.reaction-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const shareId = btn.dataset.share;
      const emoji = btn.dataset.emoji;
      const wasActive = btn.classList.contains('active');
      btn.disabled = true;
      try {
        if (wasActive) {
          await api(`/api/social/shares/${shareId}/reaction`, { method: 'DELETE' });
        } else {
          await api(`/api/social/shares/${shareId}/reaction`, { method: 'PUT', body: { emoji } });
        }
        if (typeof onChanged === 'function') await onChanged(shareId);
      } catch (err) {
        console.error(err);
      } finally {
        btn.disabled = false;
      }
    });
  });
}
