import { api, logout, escapeHtml, getAccessToken, refreshAccessToken } from '/scripts/auth.js';
import { ICON_ALERT, ICON_FILM } from '/scripts/icons.js';

const BASE = '/api/admin/local-provider';
const $ = id => document.getElementById(id);

let toastTimer;
function toast(msg, type = 'success') {
  const t = $('toast');
  t.className = 'show ' + type;
  $('toastMsg').textContent = msg;
  t.querySelector('.toast-dot').style.background = type === 'success' ? '#46d369' : '#e50914';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3500);
}

function openModal(id) { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function year(dateStr) {
  const y = String(dateStr ?? '').slice(0, 4);
  return /^\d{4}$/.test(y) ? y : '';
}

// ── State ───────────────────────────────────────────────────────

let titles = [];
let detail = null;                     // the title currently open in the sheet
const activeUploads = new Map();       // slotKey -> { loaded, total, cancelled, xhr, uploadId, name }
const pollers = new Map();             // fileId -> interval handle

const slotKeyFor = (kind, id) => `${kind}:${id}`;

// ── Auth / boot ─────────────────────────────────────────────────

// Same probe admin-providers.js uses: there's no admin flag on the user
// object, so a 403 from an admin-gated endpoint is the only signal.
// 'unknown' (a transient failure) keeps a real admin on the page rather than
// bouncing them to /account.
async function checkAdminAccess() {
  try {
    titles = await api(`${BASE}/titles`);
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
    $('titlesContent').innerHTML =
      `<div class="empty"><div class="empty-icon">${ICON_ALERT}</div>` +
      `<h3>Couldn't Check Access</h3>` +
      `<p>The server didn't answer. This isn't a permission problem — reload to try again.</p></div>`;
    return;
  }

  render();
}

async function loadTitles() {
  try {
    titles = await api(`${BASE}/titles`);
    render();
  } catch (err) {
    $('titlesContent').innerHTML =
      `<div class="empty"><div class="empty-icon">${ICON_ALERT}</div>` +
      `<h3>Couldn't Load</h3><p>${escapeHtml(err.message)}</p></div>`;
  }
}

// ── Grid ────────────────────────────────────────────────────────

/** One title's headline state: a movie's own file, or a show's episodes
 *  rolled up. Returns the pill class plus its label. */
function titleState(t) {
  if (t.media_type === 'movie') {
    switch (t.file_status) {
      case 'ready':       return { cls: 'ready',   label: 'Ready' };
      case 'transcoding': return { cls: 'working', label: 'Processing' };
      case 'pending':     return { cls: 'working', label: 'Queued' };
      case 'failed':      return { cls: 'failed',  label: 'Failed' };
      default:            return { cls: 'none',    label: 'No file' };
    }
  }
  const total = t.episode_count ?? 0;
  const ready = t.episode_ready ?? 0;
  if (!total) return { cls: 'none', label: 'No episodes' };
  if (t.episode_failed) return { cls: 'failed', label: `${ready}/${total} ready` };
  if (t.episode_working) return { cls: 'working', label: `${ready}/${total} ready` };
  if (ready === total) return { cls: 'ready', label: `${total} episode${total === 1 ? '' : 's'}` };
  return { cls: 'none', label: `${ready}/${total} ready` };
}

function renderStats() {
  const el = $('libStats');
  if (!titles.length) { el.hidden = true; return; }

  const movies = titles.filter(t => t.media_type === 'movie').length;
  const shows = titles.length - movies;
  const working = titles.filter(t => titleState(t).cls === 'working').length;
  const failed = titles.filter(t => titleState(t).cls === 'failed').length;

  const chips = [
    { num: movies, label: movies === 1 ? 'Movie' : 'Movies' },
    { num: shows, label: shows === 1 ? 'Show' : 'Shows' },
  ];
  if (working) chips.push({ num: working, label: 'Processing', cls: 'busy' });
  if (failed) chips.push({ num: failed, label: 'Needs attention', cls: 'bad' });

  el.hidden = false;
  el.innerHTML = chips.map(c => `
    <div class="stat">
      <span class="stat-num ${c.cls || ''}">${c.num}</span>
      <span class="stat-label">${escapeHtml(c.label)}</span>
    </div>`).join('');
}

function render() {
  renderStats();

  if (!titles.length) {
    $('titlesContent').innerHTML = `
      <div class="empty">
        <div class="empty-icon">${ICON_FILM}</div>
        <h3>Nothing Here Yet</h3>
        <p>Add a movie or a show, then upload the video file for it.</p>
      </div>`;
    return;
  }

  $('titlesContent').innerHTML = `<div class="lib-grid">${titles.map(t => {
    const state = titleState(t);
    const meta = [t.media_type === 'movie' ? 'Movie' : 'Show', year(t.released)].filter(Boolean).join(' · ');
    return `
      <button class="lib-card" data-open="${t.id}" type="button">
        <div class="lib-poster">
          ${t.poster
            ? `<img src="${escapeHtml(t.poster)}" alt="" loading="lazy" />`
            : `<div class="lib-poster-empty">${ICON_FILM}</div>`}
          <span class="lib-kind">${t.media_type === 'movie' ? 'Movie' : 'TV'}</span>
          <span class="pill ${state.cls}">${escapeHtml(state.label)}</span>
        </div>
        <div>
          <div class="lib-card-title">${escapeHtml(t.title)}</div>
          <div class="lib-card-meta">${escapeHtml(meta)}</div>
        </div>
      </button>`;
  }).join('')}</div>`;

  document.querySelectorAll('[data-open]').forEach(card => {
    card.addEventListener('click', () => openDetail(card.dataset.open));
  });
}

// ── Detail sheet ────────────────────────────────────────────────

async function openDetail(id) {
  $('detailContent').innerHTML = `<div class="empty"><div class="spinner" style="margin:0 auto;"></div></div>`;
  openModal('detailModal');
  await loadDetail(id);
}

async function loadDetail(id) {
  try {
    detail = await api(`${BASE}/titles/${id}`);
    renderDetail();
  } catch (err) {
    $('detailContent').innerHTML =
      `<div class="empty"><div class="empty-icon">${ICON_ALERT}</div><h3>Couldn't Load</h3><p>${escapeHtml(err.message)}</p></div>`;
  }
}

/** Re-reads the open title from the server and redraws the sheet — used
 *  after anything that changes its files or episodes. */
async function refreshDetail() {
  if (!detail) return;
  try {
    detail = await api(`${BASE}/titles/${detail.id}`);
    renderDetail();
  } catch { /* the sheet keeps what it has; the toast already said why */ }
}

function renderDetail() {
  const t = detail;
  if (!t) return;

  const meta = [
    t.media_type === 'movie' ? 'Movie' : 'TV Show',
    year(t.released),
    t.runtime ? `${t.runtime} min` : '',
    t.tmdb_id ? `TMDB ${t.tmdb_id}` : '',
  ].filter(Boolean);

  $('detailContent').innerHTML = `
    <div class="detail-head">
      <div class="detail-poster">
        ${t.poster ? `<img src="${escapeHtml(t.poster)}" alt="" />` : `<div class="lib-poster-empty">${ICON_FILM}</div>`}
      </div>
      <div style="min-width:0;flex:1;">
        <div class="detail-title">${escapeHtml(t.title)}</div>
        <div class="detail-meta">${meta.map(m => escapeHtml(m)).join(' · ')}</div>
        ${t.overview ? `<div class="detail-overview">${escapeHtml(t.overview)}</div>` : ''}
      </div>
    </div>
    <div class="detail-body">${t.media_type === 'movie' ? movieBodyHtml(t) : showBodyHtml(t)}</div>`;

  wireDetail();
  resumePolling();
}

function movieBodyHtml(t) {
  const key = slotKeyFor('movie', t.id);
  const hasSomething = activeUploads.has(key) || t.file_id;
  return hasSomething
    ? slotHtml(key, 'Video file', fileOf(t))
    : dropzoneHtml(key);
}

function showBodyHtml(t) {
  const seasons = t.seasons || [];
  return `
    <div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
      <button class="btn btn-ghost btn-sm" data-add-season="${t.id}">+ Add Season</button>
    </div>
    ${seasons.length === 0
      ? `<div class="hint-row">No seasons yet — add one to start uploading episodes.</div>`
      : seasons.map(s => `
        <div class="season">
          <div class="season-head">
            <span class="season-name">Season ${s.number}${s.name ? ` · ${escapeHtml(s.name)}` : ''}</span>
            <button class="btn btn-ghost btn-sm" data-add-episode="${s.id}">+ Episode</button>
          </div>
          ${(s.episodes || []).length === 0
            ? `<div class="hint-row">No episodes in this season yet.</div>`
            : `<div class="ep-list">${s.episodes.map(e => slotHtml(
                slotKeyFor('episode', e.id),
                `<span class="ep-num">E${String(e.number).padStart(2, '0')}</span>${escapeHtml(e.title || 'Untitled')}`,
                fileOf(e),
                true,
              )).join('')}</div>`}
        </div>`).join('')}`;
}

const fileOf = row => ({
  id: row.file_id,
  status: row.file_status,
  error: row.file_error,
  duration: row.duration_seconds,
});

function dropzoneHtml(key) {
  return `
    <label class="dropzone" data-drop="${key}">
      <input type="file" hidden accept="video/*,.mkv,.ts,.m2ts,.vob,.divx" data-upload="${key}" />
      <div class="dropzone-title">Drop a video file here, or click to choose</div>
      <div class="dropzone-sub">Any format ffmpeg can read — mp4, mkv, avi, mov and the rest. It's converted for streaming after upload.</div>
    </label>`;
}

/**
 * One file's row. Rendered from the server's view of the file *unless* an
 * upload for this slot is in flight, in which case the live byte counter
 * wins — a re-render mid-upload (adding an episode, say) must not wipe the
 * progress bar.
 */
function slotHtml(key, label, file, inline = false) {
  const up = activeUploads.get(key);
  let pill, actions = '', progress = '', errorHtml = '', sub = '';

  if (up) {
    const pct = up.total ? Math.round((up.loaded / up.total) * 100) : 0;
    pill = `<span class="pill working" data-slot-pill>Uploading</span>`;
    actions = `<button class="btn btn-ghost btn-sm" data-cancel="${key}">Cancel</button>`;
    progress = progressHtml(pct, `Uploading ${pct}%`, `${formatBytes(up.loaded)} / ${formatBytes(up.total)}`);
    sub = escapeHtml(up.name);
  } else if (!file.id) {
    pill = `<span class="pill none" data-slot-pill>No file</span>`;
    actions = uploadButtonHtml(key, 'Upload');
  } else if (file.status === 'ready') {
    pill = `<span class="pill ready" data-slot-pill>Ready</span>`;
    actions = uploadButtonHtml(key, 'Replace');
    sub = formatDuration(file.duration);
  } else if (file.status === 'failed') {
    pill = `<span class="pill failed" data-slot-pill>Failed</span>`;
    actions = `<button class="btn btn-ghost btn-sm" data-retry="${file.id}">Retry</button>${uploadButtonHtml(key, 'Replace')}`;
    errorHtml = file.error ? `<div class="slot-error">${escapeHtml(file.error)}</div>` : '';
  } else {
    const queued = file.status === 'pending';
    pill = `<span class="pill working" data-slot-pill>${queued ? 'Queued' : 'Processing'}</span>`;
    progress = queued
      ? progressHtml(null, 'Waiting for the encoder', '')
      : progressHtml(null, 'Processing', '');
  }

  return `
    <div class="slot" data-slot="${key}" data-file-id="${file.id || ''}" ${inline ? '' : 'style="margin-top:4px;"'}>
      <div class="slot-row">
        <div class="slot-label">${label}${sub ? `<div class="slot-sub" data-slot-sub>${sub}</div>` : '<div class="slot-sub" data-slot-sub hidden></div>'}</div>
        ${pill}
        <div class="slot-actions">${actions}</div>
      </div>
      <div class="slot-progress" ${progress ? '' : 'hidden'}>${progress || progressHtml(0, '', '')}</div>
      ${errorHtml}
    </div>`;
}

function uploadButtonHtml(key, label) {
  return `
    <label class="btn btn-ghost btn-sm" style="cursor:pointer;margin:0;">
      ${label}
      <input type="file" hidden accept="video/*,.mkv,.ts,.m2ts,.vob,.divx" data-upload="${key}" />
    </label>`;
}

/** `percent === null` draws the indeterminate bar (the encoder hasn't
 *  reported a position yet, or the job is still queued). */
function progressHtml(percent, label, detailText) {
  const indeterminate = percent === null;
  return `
    <div class="progress ${indeterminate ? 'indeterminate' : ''}">
      <div class="progress-fill" style="width:${indeterminate ? '' : `${percent}%`}"></div>
    </div>
    <div class="progress-meta">
      <span data-progress-label>${escapeHtml(label)}</span>
      <span data-progress-detail>${escapeHtml(detailText)}</span>
    </div>`;
}

function slotEl(key) {
  return document.querySelector(`[data-slot="${key}"]`);
}

/** Patches one slot's bar in place — called several times a second during an
 *  upload, so it never re-renders the sheet. */
function paintProgress(key, { percent, label, detailText, pillClass, pillText }) {
  const el = slotEl(key);
  if (!el) return;

  const wrap = el.querySelector('.slot-progress');
  const bar = el.querySelector('.progress');
  const fill = el.querySelector('.progress-fill');
  if (wrap && bar && fill) {
    wrap.hidden = false;
    if (percent === null) {
      bar.classList.add('indeterminate');
      fill.style.width = '';
    } else {
      bar.classList.remove('indeterminate');
      fill.style.width = `${percent}%`;
    }
  }
  const labelEl = el.querySelector('[data-progress-label]');
  if (labelEl && label !== undefined) labelEl.textContent = label;
  const detailEl = el.querySelector('[data-progress-detail]');
  if (detailEl && detailText !== undefined) detailEl.textContent = detailText;

  const pill = el.querySelector('[data-slot-pill]');
  if (pill && pillText) {
    pill.className = `pill ${pillClass}`;
    pill.setAttribute('data-slot-pill', '');
    pill.textContent = pillText;
  }
}

// ── Chunked upload ──────────────────────────────────────────────
//
// The file goes up in fixed-size chunks rather than one big multipart POST.
// A Cloudflare Tunnel (or similar proxy) in front of an install resets any
// request body over ~100MB, which a movie always is — the browser sees
// ERR_CONNECTION_RESET and the server
// never sees the request at all. Chunks also mean an interrupted transfer
// costs one chunk instead of the whole file, and the access token can be
// refreshed halfway through an upload that outlives it.

async function authToken() {
  const token = getAccessToken() || await refreshAccessToken();
  if (!token) throw new Error('Not signed in.');
  return token;
}

function sendChunk(ctrl, uploadId, offset, blob, token, onLoaded) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    ctrl.xhr = xhr;
    xhr.open('POST', `${BASE}/uploads/${uploadId}/chunk?offset=${offset}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.onprogress = e => { if (e.lengthComputable) onLoaded(e.loaded); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* empty body */ }
      if (xhr.status >= 200 && xhr.status < 300) { resolve(data); return; }
      const err = new Error(data.error || `HTTP ${xhr.status}`);
      err.status = xhr.status;
      err.data = data;
      reject(err);
    };
    xhr.onerror = () => reject(Object.assign(new Error('Connection lost.'), { status: 0 }));
    xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled.'), { cancelled: true }));
    xhr.send(blob);
  });
}

async function sendChunkWithRetry(ctrl, uploadId, offset, blob, onLoaded) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (ctrl.cancelled) throw Object.assign(new Error('Upload cancelled.'), { cancelled: true });
    try {
      return await sendChunk(ctrl, uploadId, offset, blob, await authToken(), onLoaded);
    } catch (err) {
      if (err.cancelled) throw err;
      lastErr = err;
      // The access token expired mid-upload: refresh and re-send this chunk
      // only — the whole point of chunking.
      if (err.status === 401) { await refreshAccessToken(); continue; }
      // The server knows better than we do how much it actually holds.
      if (err.status === 409 && typeof err.data?.received === 'number') return err.data;
      // A rejected/absent session won't start working on a retry.
      if (err.status === 400 || err.status === 404) throw err;
      await sleep(700 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function startUpload(key, targetKind, targetId, file) {
  if (activeUploads.has(key)) return;

  const ctrl = { loaded: 0, total: file.size, cancelled: false, xhr: null, uploadId: null, name: file.name };
  activeUploads.set(key, ctrl);
  renderDetail();

  const paint = loaded => {
    ctrl.loaded = Math.min(loaded, file.size);
    const pct = file.size ? Math.round((ctrl.loaded / file.size) * 100) : 0;
    paintProgress(key, {
      percent: pct,
      label: `Uploading ${pct}%`,
      detailText: `${formatBytes(ctrl.loaded)} / ${formatBytes(file.size)}`,
      pillClass: 'working',
      pillText: 'Uploading',
    });
  };

  try {
    const session = await api(`${BASE}/uploads`, {
      method: 'POST',
      body: { targetKind, targetId, filename: file.name, size: file.size },
    });
    ctrl.uploadId = session.uploadId;

    let offset = 0;
    let stalls = 0;
    while (offset < file.size) {
      if (ctrl.cancelled) throw Object.assign(new Error('Upload cancelled.'), { cancelled: true });

      const end = Math.min(offset + session.chunkSize, file.size);
      const base = offset;
      const result = await sendChunkWithRetry(
        ctrl, session.uploadId, offset, file.slice(offset, end),
        loaded => paint(base + loaded),
      );

      const received = typeof result.received === 'number' ? result.received : end;
      // A resync that doesn't move is the only way this loop could spin.
      if (received <= offset && ++stalls > 4) {
        throw new Error('Upload stalled — try again.');
      }
      if (received > offset) stalls = 0;
      offset = received;
      paint(offset);
    }

    const done = await api(`${BASE}/uploads/${session.uploadId}/complete`, { method: 'POST' });
    activeUploads.delete(key);
    toast('Uploaded — converting for streaming now.');
    await refreshDetail();
    pollFile(done.fileId, key);
    loadTitles();
  } catch (err) {
    activeUploads.delete(key);
    if (ctrl.uploadId) {
      api(`${BASE}/uploads/${ctrl.uploadId}`, { method: 'DELETE' }).catch(() => {});
    }
    toast(err.cancelled ? 'Upload cancelled.' : (err.message || 'Upload failed.'), err.cancelled ? 'success' : 'error');
    renderDetail();
  }
}

function cancelUpload(key) {
  const ctrl = activeUploads.get(key);
  if (!ctrl) return;
  ctrl.cancelled = true;
  if (ctrl.xhr) ctrl.xhr.abort();
}

// ── Transcode polling ───────────────────────────────────────────

/** Follows one file until it stops being pending/transcoding, painting the
 *  encoder's own percentage into that slot as it goes. */
function pollFile(fileId, key) {
  if (!fileId || pollers.has(fileId)) return;

  const handle = setInterval(async () => {
    let file;
    try {
      file = await api(`${BASE}/files/${fileId}/status`);
    } catch {
      clearInterval(handle);
      pollers.delete(fileId);
      return;
    }

    if (file.status === 'pending' || file.status === 'transcoding') {
      const queued = file.status === 'pending';
      const pct = typeof file.progress === 'number' ? file.progress : null;
      paintProgress(key, {
        percent: queued ? null : pct,
        label: queued ? 'Waiting for the encoder' : (pct === null ? 'Processing' : `Processing ${pct}%`),
        detailText: '',
        pillClass: 'working',
        pillText: queued ? 'Queued' : 'Processing',
      });
      return;
    }

    clearInterval(handle);
    pollers.delete(fileId);
    if (file.status === 'ready') toast('Ready to play.');
    else if (file.status === 'failed') toast('Conversion failed — see the error on the file.', 'error');
    await refreshDetail();
    loadTitles();
  }, 3000);

  pollers.set(fileId, handle);
}

/** After any re-render, pick up polling for every file the sheet shows as
 *  still working — including ones started before this page was opened. */
function resumePolling() {
  document.querySelectorAll('.slot[data-file-id]').forEach(el => {
    const fileId = el.dataset.fileId;
    const key = el.dataset.slot;
    if (!fileId) return;
    const pillText = el.querySelector('[data-slot-pill]')?.textContent?.trim();
    if (pillText === 'Queued' || pillText === 'Processing') pollFile(fileId, key);
  });
}

// ── Detail wiring ───────────────────────────────────────────────

function wireDetail() {
  document.querySelectorAll('[data-upload]').forEach(input => {
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      const [kind, id] = input.dataset.upload.split(':');
      startUpload(input.dataset.upload, kind, id, file);
    });
  });

  document.querySelectorAll('[data-drop]').forEach(zone => {
    ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => {
      e.preventDefault();
      zone.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => {
      e.preventDefault();
      zone.classList.remove('dragover');
    }));
    zone.addEventListener('drop', e => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const [kind, id] = zone.dataset.drop.split(':');
      startUpload(zone.dataset.drop, kind, id, file);
    });
  });

  document.querySelectorAll('[data-cancel]').forEach(btn => {
    btn.addEventListener('click', () => cancelUpload(btn.dataset.cancel));
  });

  document.querySelectorAll('[data-retry]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const fileId = btn.dataset.retry;
      const key = btn.closest('.slot')?.dataset.slot;
      try {
        await api(`${BASE}/files/${fileId}/retry`, { method: 'POST' });
        toast('Queued again.');
        await refreshDetail();
        pollFile(fileId, key);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-add-season]').forEach(btn => {
    btn.addEventListener('click', () => {
      const used = new Set((detail?.seasons || []).map(s => s.number));
      let next = 1;
      while (used.has(next)) next++;
      $('seasonNumberInput').value = String(next);
      $('seasonNameInput').value = '';
      openModal('seasonModal');
    });
  });

  document.querySelectorAll('[data-add-episode]').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingEpisodeSeasonId = btn.dataset.addEpisode;
      const season = (detail?.seasons || []).find(s => s.id === pendingEpisodeSeasonId);
      const used = new Set((season?.episodes || []).map(e => e.number));
      let next = 1;
      while (used.has(next)) next++;
      $('episodeNumberInput').value = String(next);
      $('episodeTitleInput').value = '';
      openModal('episodeModal');
    });
  });
}

// ── Add title ───────────────────────────────────────────────────

let pendingMediaType = 'movie';

function openTitleModal(mediaType) {
  pendingMediaType = mediaType;
  $('titleModalTitle').textContent = mediaType === 'movie' ? 'Add Movie' : 'Add Show';
  $('titleTmdbHint').textContent = mediaType === 'movie'
    ? 'Fills in title, overview, poster and genres.'
    : 'Fills in the show and pre-creates every season and episode.';
  $('titleTmdbInput').value = '';
  $('titleNameInput').value = '';
  openModal('titleModal');
}

$('addMovieBtn').addEventListener('click', () => openTitleModal('movie'));
$('addShowBtn').addEventListener('click', () => openTitleModal('tv'));
$('cancelTitleBtn').addEventListener('click', () => closeModal('titleModal'));

$('saveTitleBtn').addEventListener('click', async () => {
  const btn = $('saveTitleBtn');
  const tmdbId = $('titleTmdbInput').value.trim();
  const title = $('titleNameInput').value.trim();
  if (!tmdbId && !title) {
    toast('Give a TMDB id or a title.', 'error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    const created = await api(`${BASE}/titles`, {
      method: 'POST',
      body: { mediaType: pendingMediaType, title: title || undefined, tmdbId: tmdbId || undefined },
    });
    closeModal('titleModal');
    toast('Added.');
    await loadTitles();
    openDetail(created.id);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create';
  }
});

// ── Detail actions ──────────────────────────────────────────────

$('closeDetailBtn').addEventListener('click', () => {
  closeModal('detailModal');
  detail = null;
});

$('deleteTitleBtn').addEventListener('click', async () => {
  if (!detail) return;
  if (!confirm(`Delete "${detail.title}"? Its uploaded video files go too.`)) return;
  try {
    await api(`${BASE}/titles/${detail.id}`, { method: 'DELETE' });
    closeModal('detailModal');
    detail = null;
    toast('Deleted.');
    loadTitles();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ── Seasons / episodes ──────────────────────────────────────────

let pendingEpisodeSeasonId = null;

$('cancelSeasonBtn').addEventListener('click', () => closeModal('seasonModal'));
$('saveSeasonBtn').addEventListener('click', async () => {
  const number = Number($('seasonNumberInput').value);
  if (!Number.isFinite(number) || number < 0) {
    toast('Season number is required.', 'error');
    return;
  }
  try {
    await api(`${BASE}/titles/${detail.id}/seasons`, {
      method: 'POST',
      body: { number, name: $('seasonNameInput').value.trim() || undefined },
    });
    closeModal('seasonModal');
    toast('Season added.');
    await refreshDetail();
    loadTitles();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('cancelEpisodeBtn').addEventListener('click', () => closeModal('episodeModal'));
$('saveEpisodeBtn').addEventListener('click', async () => {
  const number = Number($('episodeNumberInput').value);
  if (!Number.isFinite(number) || number < 1) {
    toast('Episode number is required.', 'error');
    return;
  }
  try {
    await api(`${BASE}/seasons/${pendingEpisodeSeasonId}/episodes`, {
      method: 'POST',
      body: { number, title: $('episodeTitleInput').value.trim() || undefined },
    });
    closeModal('episodeModal');
    toast('Episode added.');
    await refreshDetail();
    loadTitles();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// Closing the sheet by clicking the backdrop, but never while a file is
// going up — the upload keeps running, and losing the bar looks like a
// crash.
$('detailModal').addEventListener('click', e => {
  if (e.target === $('detailModal') && activeUploads.size === 0) {
    closeModal('detailModal');
    detail = null;
  }
});

// A tab closed mid-upload leaves a partial file server-side; the sweeper
// clears it eventually, but the warning gives the admin the chance not to.
window.addEventListener('beforeunload', e => {
  if (activeUploads.size) {
    e.preventDefault();
    e.returnValue = '';
  }
});

boot();

$('logoutLink').addEventListener('click', e => {
  e.preventDefault();
  logout();
});
