import { FFmpeg } from "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js";
import { toBlobURL } from "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js";
import {
  api,
  logout,
  getAccessToken,
  getSelfId,
  escapeHtml,
  ensureSessionQuietly,
  fetchPublic,
} from "/scripts/auth.js";
import { openShareModal } from "/scripts/social.js";
// Which facts a title has, and how each is formatted, is shared with the
// details page so the two can't drift apart.
import {
  showFacts,
  formatNumber,
  ageLabel,
  STAT_LABELS,
} from "/scripts/show-meta.js";
import { RoomConnection, roomInviteUrl } from "/scripts/room-sync.js";
// See the note in details.js: `providerName` is a registry slug, not a label.
import { getName as providerLabel } from "/scripts/provider-names.js";
import {
  ICON_CROWN,
  ICON_VOLUME_ON,
  ICON_VOLUME_MUTE,
  ICON_PLAY,
  ICON_PAUSE,
  ICON_REWIND,
  ICON_FAST_FORWARD,
  ICON_SKIP_BACK,
  ICON_SKIP_FORWARD,
  ICON_GAUGE,
  ICON_SUBTITLES,
  ICON_THEATER,
  ICON_SEEK,
  ICON_KEYBOARD,
} from "/scripts/icons.js";

let ff = null;
const providerStorageKey = "streamio.provider";
let currentShowData = null;
let currentServers = [];
let currentEpisodesList = [];
let currentEpisodeIndex = -1;
let autoplayNextEnabled = true;
let currentPlaybackId = "";
let currentPlaybackType = "episode";
let currentHls = null;
let currentBlobUrl = "";
let currentVideoUrl = "";
let isDownloading = false;
let currentEpisodeLabel = "";
// { url, title, subtitles, serverName, serverIndex } — everything about the
// current stream that is frozen at resolve time. Show/episode context is read
// live at cast time instead (see buildCastCustomData).
let castMedia = null;
let currentServerName = "";
let currentServerIndex = 0;
let playerControlsInitialized = false;
let isScrubbing = false; // a progress-bar drag owns the fill until released
// A fresh resolve (bypassing the cached URL) can land on a working stream
// even when the cached one didn't. Capped so a genuinely dead server doesn't
// retry forever.
let streamRetryCount = 0;
const MAX_STREAM_RETRIES = 5;
const NEXT_EP_THRESHOLD = 20; // seconds before end
// How close to the end counts as "finished". Landing inside this tail —
// by watching into it, by skipping credits, or by dragging the bar there —
// means the user is done with the episode: "ended" is not guaranteed to
// fire (HLS.js/Safari can stop a hair short of `duration`, and a seek to
// exactly `duration` often fires nothing at all), and the autosave that
// follows would then write completed:false over a finished episode.
const COMPLETE_TAIL = 5; // seconds
let nextEpPromptShown = false;
// episodeId -> { completed, progress_seconds, duration_seconds }, used to
// mark each episode button watched/in-progress/unwatched.
let episodeProgressMap = new Map();

// currentPlaybackId -> IntroDbMedia|null, populated by loadIntroSegments().
// Avoids re-fetching /api/intro-segments on every seek within an episode.
const introSegmentsCache = new Map();
let currentIntroSegments = null;
let skipSegmentShown = false;
let skipSegmentActive = null; // { type: 'intro'|'recap'|'credits', start, end } (ms)
// The ids/year loadIntroSegments() resolved for currentPlaybackId — reused by
// buildCastCustomData() so the receiver's own /api/intro-segments lookup
// (cast-receiver's docs/protocol.md §5) doesn't have to redo the same TMDB
// title match this tab already did.
let currentIntroDbIds = { tmdbId: null, imdbId: "", year: null };

// Deep-link support for shared clips: /watch?id=...&ep=<episodeId>&t=<seconds>
let deepLinkEpisodeId = null;
let deepLinkTimeSeconds = null;
let deepLinkTimeConsumed = false;
let nextEpAutoplayTimer = null;

// ── Watch party (room sync) state ──
let roomConn = null;
let roomCode = null;
let roomState = null;
let roomMembers = [];
let roomOwnerId = null;
let applyingRemoteState = false; // suppresses re-broadcast while we apply an incoming/initial sync
let pendingRoomPause = false; // set when joining a room whose shared state is paused
let roomEchoGuard = { until: 0, time: null, playing: null };
let roomHeartbeatTimer = null;
let roomHooksInitialized = false;
let roomToastTimer = null;
let roomSelfId = null; // current user's id — resolved lazily to tell owner apart from guests

function maybeShowNextEpPrompt() {
  const player = getPlayer();
  // The receiver shows its own Up Next card on the TV while casting.
  if (isCasting) return;
  if (currentPlaybackType !== "episode") return;
  if (!player.duration || isNaN(player.duration)) return;

  const remaining = player.duration - player.currentTime;
  const nextEp = currentEpisodesList[currentEpisodeIndex + 1];

  if (
    remaining <= NEXT_EP_THRESHOLD &&
    remaining > 0 &&
    nextEp &&
    !nextEpPromptShown
  ) {
    nextEpPromptShown = true;
    showNextEpPrompt(nextEp);
  }

  // hide again if user seeked backwards past the threshold
  if (remaining > NEXT_EP_THRESHOLD && nextEpPromptShown) {
    hideNextEpPrompt();
  }
}

function showNextEpPrompt(nextEp) {
  const prompt = document.getElementById("nextEpPrompt");
  document.getElementById("nextEpLabel").textContent =
    `Next: S${nextEp.seasonNum}E${nextEp.episodeNum}`;
  prompt.classList.add("show");

  // optional: auto-advance after a few seconds if user doesn't interact
  clearTimeout(nextEpAutoplayTimer);
  nextEpAutoplayTimer = setTimeout(() => {
    if (prompt.classList.contains("show")) playNextEpisode();
  }, NEXT_EP_THRESHOLD * 1000);
}

function hideNextEpPrompt() {
  nextEpPromptShown = false;
  clearTimeout(nextEpAutoplayTimer);
  document.getElementById("nextEpPrompt").classList.remove("show");
}

document.getElementById("nextEpBtn").onclick = () => {
  clearTimeout(nextEpAutoplayTimer);
  playNextEpisode();
};
document.getElementById("nextEpCancel").onclick = () => {
  autoplayNextEnabled = false; // user opted out for this session
  hideNextEpPrompt();
};

// ── Skip Intro/Recap/Credits (TheIntroDB) ──
//
// TheIntroDB v3 picks the release version (theatrical, extended, uncensored,
// ...) closest to the duration it is given, so the lookup below is worth
// waiting on the player for — it is fired the moment a stream is handed over,
// when the media element has just been reset and reports no duration at all.
// Bounded: a stream that never reports one (or a live channel, duration
// Infinity) still gets looked up, just without the version hint.
const INTRO_DURATION_WAIT_MS = 15000;

function awaitPlayerDurationMs(player) {
  const read = () =>
    Number.isFinite(player.duration) && player.duration > 0
      ? Math.round(player.duration * 1000)
      : null;

  const known = read();
  if (known) return Promise.resolve(known);

  return new Promise((resolve) => {
    let timer = 0;
    const finish = (value) => {
      clearTimeout(timer);
      player.removeEventListener("loadedmetadata", onChange);
      player.removeEventListener("durationchange", onChange);
      resolve(value);
    };
    const onChange = () => {
      const ms = read();
      if (ms) finish(ms);
    };
    timer = setTimeout(() => finish(null), INTRO_DURATION_WAIT_MS);
    player.addEventListener("loadedmetadata", onChange);
    player.addEventListener("durationchange", onChange);
  });
}

// TheIntroDB is keyed by TMDB/IMDB id. A local title only has one when its
// `imdb_id` was filled in (by hand, or via the admin "fill in from a TMDB id"
// flow) — absent that, there's nothing to look up and the button never
// appears.
async function loadIntroSegments() {
  currentIntroSegments = null;
  currentIntroDbIds = { tmdbId: null, imdbId: "", year: null };
  const cacheKey = currentPlaybackId;
  if (!cacheKey) return;

  if (introSegmentsCache.has(cacheKey)) {
    currentIntroSegments = introSegmentsCache.get(cacheKey);
    return;
  }

  const showId = new URLSearchParams(window.location.search).get("id") || "";
  const provider = localStorage.getItem(providerStorageKey) || "";
  const title = currentShowData?.title || "";
  if (!showId || !provider || !title) {
    introSegmentsCache.set(cacheKey, null);
    return;
  }

  // `local` ids never carry a numeric TMDB id (see LocalProvider.ts's
  // `local-movie-<uuid>`/`local-tv-<uuid>` scheme) — only `imdbId`, when the
  // title has one on file, feeds the lookup below.
  const tmdbId = "";
  const imdbId = currentShowData?.imdbId || "";
  const year = currentShowData?.released
    ? new Date(currentShowData.released).getFullYear()
    : "";
  // Handed to the receiver in buildCastCustomData() as a hint, regardless of
  // whether the fetch below succeeds — it's cheap and saves the receiver's
  // own lookup a redundant TMDB title match on a cache miss.
  currentIntroDbIds = {
    tmdbId: tmdbId ? Number(tmdbId) : null,
    imdbId,
    year: year || null,
  };

  const ep =
    currentPlaybackType === "episode"
      ? currentEpisodesList[currentEpisodeIndex]
      : null;
  if (currentPlaybackType === "episode" && !ep) {
    introSegmentsCache.set(cacheKey, null);
    return;
  }

  // While casting, the local element is never given the source, so waiting on
  // it would only burn the timeout — the skip button is the receiver's job
  // there (it runs its own lookup with the duration it knows).
  const durationMs = isCasting
    ? null
    : await awaitPlayerDurationMs(getPlayer());
  // A different title/episode took over while we waited — that playback has
  // its own call in flight, and this one no longer has anything to fill in.
  if (currentPlaybackId !== cacheKey) return;

  const qs = new URLSearchParams({
    type: currentPlaybackType === "movie" ? "movie" : "tv",
  });
  if (tmdbId) qs.set("tmdbId", tmdbId);
  if (imdbId) qs.set("imdbId", imdbId);
  if (ep) {
    qs.set("season", String(ep.seasonNum));
    qs.set("episode", String(ep.episodeNum));
  }
  if (durationMs) qs.set("durationMs", String(durationMs));

  try {
    const res = await fetchPublic(`/api/intro-segments?${qs.toString()}`);
    const body = await res.json();
    const data = body?.data || null;
    introSegmentsCache.set(cacheKey, data);
    if (currentPlaybackId === cacheKey) currentIntroSegments = data;
  } catch {
    introSegmentsCache.set(cacheKey, null); // fail silent — never blocks playback
  }
}

const SKIP_SEGMENT_LABELS = {
  intro: "Skip Intro",
  recap: "Skip Recap",
  credits: "Skip Credits",
  preview: "Skip Preview",
};

// Segments come from the "theintrodb" npm client, already normalized:
// startMs is always a number (a null start became 0), endMs stays null to
// mean "runs to end of media" — uniform across every segment type, so no
// per-type null handling is needed here.
function findActiveSkipSegment(data, tMs, durMs) {
  const check = (list, type) => {
    for (const seg of list || []) {
      const end = seg.endMs ?? durMs;
      if (tMs >= seg.startMs && tMs < end) {
        return { type, start: seg.startMs, end, runsToEnd: seg.endMs == null };
      }
    }
    return null;
  };
  return (
    check(data.intro, "intro") ||
    check(data.recap, "recap") ||
    check(data.credits, "credits") ||
    check(data.preview, "preview")
  );
}

function maybeShowSkipSegment() {
  if (isCasting || !currentIntroSegments) return;
  const player = getPlayer();
  if (!player.duration || isNaN(player.duration)) return;
  // The next-episode prompt takes priority — the two never render together.
  if (nextEpPromptShown) {
    if (skipSegmentShown) hideSkipSegment();
    return;
  }

  const tMs = player.currentTime * 1000;
  const durMs = player.duration * 1000;
  const match = findActiveSkipSegment(currentIntroSegments, tMs, durMs);

  if (match) {
    if (!skipSegmentShown || skipSegmentActive?.type !== match.type) {
      showSkipSegment(match);
    }
  } else if (skipSegmentShown) {
    hideSkipSegment();
  }
}

function showSkipSegment(match) {
  skipSegmentShown = true;
  skipSegmentActive = match;
  document.getElementById("skipSegmentBtn").textContent =
    SKIP_SEGMENT_LABELS[match.type] || "Skip";
  document.getElementById("skipSegmentPrompt").classList.add("show");
}

function hideSkipSegment() {
  skipSegmentShown = false;
  skipSegmentActive = null;
  document.getElementById("skipSegmentPrompt").classList.remove("show");
}

document.getElementById("skipSegmentBtn").onclick = () => {
  const player = getPlayer();
  if (!skipSegmentActive) return;

  const target = skipSegmentActive.end / 1000;
  // Credits/preview that run to the end of the media — or that leave less than
  // COMPLETE_TAIL after them, which a skip would land in — mean the user is
  // done with what's loaded, so mark it before doing anything else.
  const endsMedia =
    (skipSegmentActive.type === "credits" ||
      skipSegmentActive.type === "preview") &&
    (skipSegmentActive.runsToEnd ||
      (player.duration &&
        !isNaN(player.duration) &&
        player.duration - target <= COMPLETE_TAIL));

  if (endsMedia) {
    hideSkipSegment();
    // Unconditionally, and *before* playNextEpisode(): that call no-ops when
    // the user opted out of autoplay, which used to leave the skip doing
    // nothing at all — episode neither advanced nor marked watched.
    markCurrentPlaybackDone();
    const hasNext =
      currentPlaybackType === "episode" &&
      !!currentEpisodesList[currentEpisodeIndex + 1];
    if (hasNext && autoplayNextEnabled) {
      playNextEpisode();
    } else {
      // Movie, last episode, or autoplay off: park at the end rather than
      // letting the credits keep playing behind a dismissed button.
      player.currentTime = player.duration;
    }
    return;
  }

  player.currentTime = target;
  hideSkipSegment();
};

// Records the current episode/movie as finished. Shared by the natural
// "ended" event, the manual/auto "Next Episode" prompt, and skip-to-end taps
// — every one of those means the user is done with what's currently loaded,
// but only "ended" was marking it, so the others left playback stuck at
// whatever the last 30s autosave happened to catch.
function markCurrentPlaybackDone() {
  if (isCasting) return; // the receiver reports its own progress
  const player = getPlayer();
  if (player._markedDone) return;
  player._markedDone = true;
  saveProgress(true);
}

// True once playback sits inside the final COMPLETE_TAIL seconds. Live/unknown
// durations (Infinity, NaN) are never "finished".
function isEffectivelyFinished(player) {
  const d = player.duration;
  if (!d || isNaN(d) || !isFinite(d)) return false;
  return d - player.currentTime <= COMPLETE_TAIL;
}

/**
 * The rendered button for an episode, or null when it isn't currently in the
 * grid.
 *
 * Addressed by `data-episode-id`, never by position: the grid renders one
 * season (and honours a filter) while `currentEpisodesList` stays the complete
 * list, so DOM index and list index are not the same thing. Everything that
 * used `querySelectorAll(".epbtn")[i]` would highlight the wrong episode — or
 * none — as soon as anything but "all episodes" was on screen.
 */
function episodeButton(episodeId) {
  if (!episodeId) return null;
  return document.querySelector(
    `#episodesGrid .epbtn[data-episode-id="${CSS.escape(episodeId)}"]`,
  );
}

async function playNextEpisode() {
  if (!autoplayNextEnabled) return;
  if (currentPlaybackType !== "episode") return; // i film non hanno "next"
  if (!currentEpisodesList.length || currentEpisodeIndex === -1) return;

  const nextIndex = currentEpisodeIndex + 1;
  const nextEp = currentEpisodesList[nextIndex];
  if (!nextEp) {
    showPlayerMessage("Hai completato tutti gli episodi disponibili.");
    return;
  }

  markCurrentPlaybackDone();

  showPlayerMessage(`Caricamento S${nextEp.seasonNum}E${nextEp.episodeNum}…`);
  await selectEpisodeByData(nextEp, nextIndex, episodeButton(nextEp.id));
}

// Versione condivisa da click manuale + autoplay, per non duplicare la logica
async function selectEpisodeByData(ep, index, btn) {
  currentPlaybackId = ep.id;
  currentPlaybackType = "episode";
  currentEpisodeLabel = `S${ep.seasonNum}E${ep.episodeNum}`;
  currentEpisodeIndex = index;
  renderNowPlaying(ep);

  // Autoplay-next and room sync can both land on an episode the open season or
  // the active filter is hiding; bring it on screen before highlighting it.
  revealEpisode(ep);
  btn = btn || episodeButton(ep.id);

  document
    .querySelectorAll("#episodesGrid .epbtn")
    .forEach((b) => b.classList.remove("active"));
  if (btn) {
    btn.classList.add("active");
    btn.blur();
    btn.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  }

  await loadServersForId(ep.id, "episode");
  if (currentServers.length) {
    const first = document.querySelectorAll("#serversGrid .srvbtn")[0];
    if (first) {
      first.classList.add("active");
      await playServerAt(0, first);
    }
  }
}

async function resumeProgress(episodeId, contentType) {
  try {
    const showId = new URLSearchParams(window.location.search).get("id");

    const entry = await api("/api/account/history/progress/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: localStorage.getItem(providerStorageKey) || "",
        showId,
        episodeId: contentType === "episode" ? episodeId : null,
      }),
    });

    console.log("[resume] looking for", { showId, episodeId, contentType });
    console.log("[resume] found", entry);

    if (entry && entry.progress_seconds > 10 && !entry.completed) {
      return entry.progress_seconds;
    }
  } catch (e) {
    console.error("[resume] error", e);
  }
  return null;
}

// `override` lets the cast path report progress for a stream playing on a TV,
// where the local <video> is hidden and frozen: it supplies the position,
// duration and episode identity directly and skips the local-player checks.
async function saveProgress(completed = false, override = null) {
  if (!currentShowData) return;

  const playbackId = override?.playbackId || currentPlaybackId;
  if (!playbackId) return;

  let progressSeconds;
  let durationSeconds;

  if (override) {
    progressSeconds = Math.floor(override.positionSeconds || 0);
    durationSeconds = Number.isFinite(override.durationSeconds)
      ? Math.floor(override.durationSeconds)
      : null;
  } else {
    const player = document.getElementById("videoPlayer");
    if (!player || player.style.display === "none") return;
    progressSeconds = Math.floor(player.currentTime);
    durationSeconds =
      player.duration && !isNaN(player.duration)
        ? Math.floor(player.duration)
        : null;
  }

  if (progressSeconds < 3) return; // ignora avvii accidentali

  const showId = new URLSearchParams(window.location.search).get("id") || "";
  const provider = localStorage.getItem(providerStorageKey) || "";
  const isEpisode =
    (override?.contentType || currentPlaybackType) === "episode";
  const episodeLabel = override?.episodeLabel || currentEpisodeLabel;

  const res = await api("/api/account/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider,
      show_id: showId,
      episode_id: isEpisode ? playbackId : null,
      progress_seconds: progressSeconds,
      episode_label: isEpisode ? episodeLabel : null,
      duration_seconds: durationSeconds,
      completed,
    }),
  }).catch(() => {});
  console.log("Progress saved", {
    showId,
    episodeId: playbackId,
    progressSeconds,
    completed,
    casting: !!override,
    response: res,
  });

  if (isEpisode) {
    markEpisodeButtonWatched(
      playbackId,
      completed,
      progressSeconds,
      durationSeconds,
    );
  }
}

// Salva ogni 30 secondi. While casting the local player is frozen, so the cast
// timer (saveCastProgress) owns history instead.
setInterval(() => {
  if (isCasting) return;
  const p = getPlayer();
  if (!p._markedDone && !p.paused) saveProgress(false);
}, 30_000);

document.getElementById("videoPlayer").addEventListener("pause", () => {
  if (isCasting) return;
  if (!getPlayer()._markedDone) saveProgress(false);
});

document.getElementById("videoPlayer").addEventListener("ended", () => {
  // The receiver drives its own next-episode advance while casting; letting
  // the (paused, hidden) local player fire playNextEpisode too would have the
  // two fighting over what plays on the TV.
  if (isCasting) return;
  hideNextEpPrompt();
  markCurrentPlaybackDone(); // covers movies/last-episode too, where playNextEpisode() below no-ops
  playNextEpisode();
});

window.addEventListener("beforeunload", () => {
  if (isCasting) {
    saveCastProgress(false);
    return;
  }
  const p = getPlayer();
  if (!p._markedDone && !p.paused) saveProgress(false);
});

// NAV scroll
window.addEventListener("scroll", () => {
  document
    .getElementById("navbar")
    .classList.toggle("solid", window.scrollY > 10);
});

function appendProvider(url) {
  const provider = localStorage.getItem(providerStorageKey) || "";
  if (!provider) return url;
  return `${url}${url.includes("?") ? "&" : "?"}provider=${encodeURIComponent(provider)}`;
}

// Every API call on this page omits `provider` when it isn't stored, and the
// server then falls back to its default — so playback works fine with an empty
// localStorage and the page never notices. The Chromecast receiver relies on
// the same fallback (canResolve() in the cast-receiver repo requires
// an apiBase and an id, not a provider), but "the server's default" is only
// the right source if it happens to be the one this page is playing: send an
// empty provider and the TV can re-resolve an expired URL against the wrong
// site. Sharing (openShareForCurrent) bails out on it too. Pin it down once
// at page load: the URL param wins (that's what details.js linked us with),
// then whatever is stored, and failing both ask the server which default it
// would have used anyway.
async function ensureActiveProvider() {
  const fromUrl = new URLSearchParams(window.location.search).get("provider");
  if (fromUrl) {
    localStorage.setItem(providerStorageKey, fromUrl);
    return fromUrl;
  }

  const stored = localStorage.getItem(providerStorageKey) || "";
  if (stored) return stored;

  try {
    const res = await fetchPublic("/api/providers");
    const data = await res.json();
    const fallback = data?.default || data?.providers?.[0] || "";
    if (fallback) {
      localStorage.setItem(providerStorageKey, fallback);
      return fallback;
    }
  } catch {
    // Non-fatal: the page still plays, the TV just loses autoplay-next.
  }
  return "";
}

function getPlayer() {
  return document.getElementById("videoPlayer");
}

function cleanupPlayer() {
  clearSubtitleTracks();
  const player = getPlayer();
  if (currentHls) {
    currentHls.destroy();
    currentHls = null;
  }
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = "";
  }
  player.pause();
  player.removeAttribute("src");
  player.load();
  player.style.display = "none";
  const ph = document.getElementById("playerPlaceholder");
  ph.style.display = "flex";
}

function showPlayerMessage(msg) {
  const ph = document.getElementById("playerPlaceholder");
  ph.innerHTML = `<p>${msg}</p>`;
  ph.style.display = "flex";
  getPlayer().style.display = "none";
}

function showPlayer() {
  document.getElementById("playerPlaceholder").style.display = "none";
  getPlayer().style.display = "block";
  initPlayerControls();
  updateMediaSession();
}

function updateProgress() {
  const p = getPlayer();
  if (!p.duration) return;
  // A drag owns the bar until it's released — repainting from currentTime
  // mid-scrub makes the handle snap back to the playhead under the cursor.
  if (isScrubbing) return;
  const pct = (p.currentTime / p.duration) * 100;
  document.getElementById("progressFill").style.width = pct + "%";
  document.getElementById("currentTime").textContent = formatTime(
    p.currentTime,
  );
  document.getElementById("duration").textContent = formatTime(p.duration);
  updateBufferedBar();
}

/**
 * The buffered range ahead of the playhead. Only the range containing the
 * playhead is drawn: after a seek `buffered` holds several disjoint ranges,
 * and painting the last one claims everything between them is downloaded.
 */
function updateBufferedBar() {
  const p = getPlayer();
  const bar = document.getElementById("progressBuffered");
  if (!bar || !p.duration) return;
  let end = 0;
  for (let i = 0; i < p.buffered.length; i++) {
    if (
      p.buffered.start(i) <= p.currentTime &&
      p.buffered.end(i) >= p.currentTime
    ) {
      end = p.buffered.end(i);
      break;
    }
  }
  bar.style.width = `${Math.min((end / p.duration) * 100, 100)}%`;
}

function openShareForCurrent() {
  const player = getPlayer();
  const showId = new URLSearchParams(window.location.search).get("id") || "";
  const provider = localStorage.getItem(providerStorageKey) || "";
  if (!showId || !provider) return;

  const isEpisode = currentPlaybackType === "episode";
  const duration = player.duration;
  const hasDuration = duration && !isNaN(duration) && duration > 0;
  // Seed the slider around the current playback position; the user drags
  // the two handles to adjust it (or switches to "Whole episode") before sending.
  const seedStart = hasDuration
    ? Math.max(0, Math.floor(player.currentTime))
    : undefined;
  const seedEnd = hasDuration
    ? Math.min(Math.floor(duration), (seedStart ?? 0) + 30)
    : undefined;

  openShareModal({
    provider,
    show_id: showId,
    episode_id: isEpisode ? currentPlaybackId : undefined,
    episode_label: isEpisode ? currentEpisodeLabel : undefined,
    duration: hasDuration ? duration : undefined,
    clip_start_seconds: seedStart,
    clip_end_seconds: seedEnd,
    summary: currentShowData?.title
      ? `Sharing "${currentShowData.title}"${isEpisode && currentEpisodeLabel ? ` — ${currentEpisodeLabel}` : ""}`
      : undefined,
  });
}

// ── Player actions ────────────────────────────────────────────────────
// Every one of these is reachable from the control bar *and* from a key, so
// they live at module scope rather than inside initPlayerControls(): the
// shortcut table below is built once, before any stream has been resolved.

const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const VOLUME_STORAGE_KEY = "streamio.player.volume";
const MUTED_STORAGE_KEY = "streamio.player.muted";
const THEATER_STORAGE_KEY = "streamio.player.theater";

/** Seconds → "1:02:03" / "2:03". Movies are hours long; "125:03" is not a time. */
function formatTime(s) {
  if (!isFinite(s) || isNaN(s) || s < 0) return "0:00";
  const total = Math.floor(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/** A finite, seekable duration, or 0 for live/not-yet-loaded media. */
function playerDuration() {
  const d = getPlayer().duration;
  return d && !isNaN(d) && isFinite(d) ? d : 0;
}

function playerSeekTo(seconds) {
  const d = playerDuration();
  if (!d) return;
  getPlayer().currentTime = Math.min(Math.max(seconds, 0), d);
}

function playerSeekBy(delta) {
  const player = getPlayer();
  if (!playerDuration()) return;
  playerSeekTo(player.currentTime + delta);
  showPlayerOsd(
    delta > 0 ? ICON_FAST_FORWARD : ICON_REWIND,
    `${delta > 0 ? "+" : "−"}${Math.abs(delta)}s`,
  );
}

function playerSeekToFraction(fraction) {
  const d = playerDuration();
  if (!d) return;
  playerSeekTo(d * fraction);
  showPlayerOsd(ICON_SEEK, `${Math.round(fraction * 100)}%`);
}

function playerTogglePlayback() {
  const player = getPlayer();
  if (player.paused) {
    player.play()?.catch(() => {});
    showPlayerOsd(ICON_PLAY, "Play");
  } else {
    player.pause();
    showPlayerOsd(ICON_PAUSE, "Pause");
  }
}

function playerSetVolume(volume, announce = true) {
  const player = getPlayer();
  const v = Math.min(Math.max(volume, 0), 1);
  player.volume = v;
  // Nudging the volume up off zero should unmute — otherwise the slider moves
  // and nothing is heard, which reads as a broken player.
  if (v > 0 && player.muted) player.muted = false;
  syncVolumeUI();
  persistVolume();
  if (announce)
    showPlayerOsd(
      v === 0 ? ICON_VOLUME_MUTE : ICON_VOLUME_ON,
      `${Math.round(v * 100)}%`,
    );
}

function playerAdjustVolume(delta) {
  playerSetVolume(getPlayer().volume + delta);
}

function playerToggleMute() {
  const player = getPlayer();
  player.muted = !player.muted;
  syncVolumeUI();
  persistVolume();
  showPlayerOsd(
    player.muted ? ICON_VOLUME_MUTE : ICON_VOLUME_ON,
    player.muted ? "Muted" : "Unmuted",
  );
}

function persistVolume() {
  const player = getPlayer();
  try {
    localStorage.setItem(VOLUME_STORAGE_KEY, String(player.volume));
    localStorage.setItem(MUTED_STORAGE_KEY, player.muted ? "1" : "0");
  } catch {
    /* private mode / storage disabled — volume just won't be remembered */
  }
}

function restoreVolume() {
  const player = getPlayer();
  try {
    const stored = parseFloat(localStorage.getItem(VOLUME_STORAGE_KEY) ?? "");
    if (!isNaN(stored)) player.volume = Math.min(Math.max(stored, 0), 1);
    player.muted = localStorage.getItem(MUTED_STORAGE_KEY) === "1";
  } catch {
    /* ignore */
  }
  syncVolumeUI();
}

/** Slider position + speaker icon, from whatever the media element now holds. */
function syncVolumeUI() {
  const player = getPlayer();
  const slider = document.getElementById("volumeSlider");
  if (slider) slider.value = String(Math.round(player.volume * 100));
  const icon = document.getElementById("volumeBtn")?.querySelector("svg");
  if (!icon) return;
  if (player.muted || player.volume === 0) {
    icon.innerHTML =
      '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line>';
  } else if (player.volume < 0.5) {
    icon.innerHTML =
      '<path d="M3 9v6h4l5 5V4L7 9H3z"></path><path d="M23 9a7 7 0 0 1 0 6"></path>';
  } else {
    icon.innerHTML =
      '<path d="M3 9v6h4l5 5V4L7 9H3z"></path><path d="M23 9a7 7 0 0 1 0 6"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>';
  }
}

function playerSetRate(rate) {
  const player = getPlayer();
  player.playbackRate = Math.min(Math.max(rate, SPEED_STEPS[0]), 2);
  updateSpeedMenu();
  showPlayerOsd(ICON_GAUGE, `${player.playbackRate}×`);
}

/** Steps through SPEED_STEPS so the menu and the keys can never disagree. */
function playerStepRate(direction) {
  const current = getPlayer().playbackRate;
  const idx = SPEED_STEPS.findIndex((s) => Math.abs(s - current) < 0.01);
  const from = idx === -1 ? SPEED_STEPS.indexOf(1) : idx;
  const next =
    SPEED_STEPS[
      Math.min(Math.max(from + direction, 0), SPEED_STEPS.length - 1)
    ];
  playerSetRate(next);
}

function updateSpeedMenu() {
  const list = document.getElementById("speedDropdown");
  if (!list) return;
  const rate = getPlayer().playbackRate;
  if (!list.childElementCount) {
    for (const speed of SPEED_STEPS) {
      const btn = document.createElement("button");
      btn.className = "dropdown-btn speed-chip";
      btn.dataset.speed = String(speed);
      btn.textContent = speed === 1 ? "Normal" : `${speed}×`;
      btn.onclick = () => playerSetRate(speed);
      list.appendChild(btn);
    }
  }
  list.querySelectorAll(".dropdown-btn").forEach((b) => {
    b.classList.toggle(
      "active",
      Math.abs(Number(b.dataset.speed) - rate) < 0.01,
    );
  });
}

function playerToggleFullscreen() {
  const container = document.getElementById("playerContainer");
  if (!document.fullscreenElement)
    container.requestFullscreen().catch(() => {});
  else document.exitFullscreen().catch(() => {});
}

async function playerTogglePip() {
  const player = getPlayer();
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await player.requestPictureInPicture();
  } catch (e) {
    console.warn("PiP failed", e);
  }
}

/**
 * Theater mode widens the player to the viewport and pushes the episode grid
 * below the fold — fullscreen without losing the controls of the page.
 * Persisted because it's a viewing preference, not a per-title one.
 */
function playerToggleTheater(force) {
  const on = force ?? !document.body.classList.contains("theater");
  document.body.classList.toggle("theater", on);
  document.getElementById("theaterBtn")?.classList.toggle("active", on);
  try {
    localStorage.setItem(THEATER_STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (force === undefined)
    showPlayerOsd(ICON_THEATER, on ? "Theater mode" : "Normal size");
}

/** Next entry in the subtitle menu, wrapping back to "Off". */
function playerCycleSubtitles() {
  const dropdown = document.getElementById("subtitleDropdown");
  const buttons = [...dropdown.querySelectorAll(".dropdown-btn")];
  if (!buttons.length) {
    showPlayerOsd(ICON_SUBTITLES, "No subtitles");
    return;
  }
  const activeIdx = buttons.findIndex((b) => b.classList.contains("active"));
  const next = buttons[(activeIdx + 1) % buttons.length];
  next?.click();
  showPlayerOsd(ICON_SUBTITLES, next?.textContent || "Subtitles");
}

/** Same thing the on-screen Skip button does, when one is showing. */
function playerSkipSegment() {
  if (!skipSegmentShown) return;
  document.getElementById("skipSegmentBtn")?.click();
}

/**
 * Explicit episode navigation. Unlike playNextEpisode() this ignores the
 * autoplay-next preference — that setting is about what happens on its own at
 * the end of an episode, not about whether the user may ask for the next one.
 */
async function playerGoEpisode(delta) {
  if (currentPlaybackType !== "episode") return;
  if (!currentEpisodesList.length || currentEpisodeIndex === -1) return;
  const index = currentEpisodeIndex + delta;
  const ep = currentEpisodesList[index];
  if (!ep) {
    showPlayerOsd(
      delta > 0 ? ICON_SKIP_FORWARD : ICON_SKIP_BACK,
      delta > 0 ? "Last episode" : "First episode",
    );
    return;
  }
  if (delta > 0) markCurrentPlaybackDone();
  showPlayerOsd(
    delta > 0 ? ICON_SKIP_FORWARD : ICON_SKIP_BACK,
    `S${ep.seasonNum}E${ep.episodeNum}`,
  );
  await selectEpisodeByData(ep, index, episodeButton(ep.id));
}

/** Escape unwinds one layer at a time, innermost first. */
function playerEscape() {
  const modal = document.getElementById("shortcutsModal");
  const more = document.getElementById("moreDropdown");
  if (modal?.classList.contains("show")) {
    closeShortcuts();
  } else if (more?.classList.contains("show")) {
    more.classList.remove("show");
  } else if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else if (document.body.classList.contains("theater")) {
    playerToggleTheater(false);
  }
}

// ── On-screen feedback ────────────────────────────────────────────────
let playerOsdTimer = null;

/** `icon` is one of the ICON_* SVG constants; `text` is always plain text. */
function showPlayerOsd(icon, text) {
  const osd = document.getElementById("playerOsd");
  if (!osd) return;
  document.getElementById("playerOsdIcon").innerHTML = icon || "";
  document.getElementById("playerOsdText").textContent = text || "";
  osd.classList.add("show");
  clearTimeout(playerOsdTimer);
  playerOsdTimer = setTimeout(() => osd.classList.remove("show"), 900);
}

// ── Keyboard shortcuts ────────────────────────────────────────────────
// One table drives both the handler and the help modal. The modal used to be
// hand-written markup in watch.html and had drifted from the bindings — it
// listed keys that did nothing and omitted keys that worked — so the help is
// now rendered from the same list that binds them and cannot go stale.
//
// `combo` entries are matched against `code` (physical key, layout-independent)
// with an optional `Shift+` prefix; `match` is for the few that can't be
// (`?` is a different physical key on every layout, digits are a range).
// `keys` is only what the modal prints.
const PLAYER_SHORTCUTS = [
  {
    group: "Playback",
    keys: ["Space", "K"],
    combo: ["Space", "KeyK"],
    label: "Play / pause",
    run: playerTogglePlayback,
  },
  {
    group: "Playback",
    keys: ["N"],
    combo: ["KeyN"],
    label: "Next episode",
    run: () => playerGoEpisode(1),
  },
  {
    group: "Playback",
    keys: ["P"],
    combo: ["KeyP"],
    label: "Previous episode",
    run: () => playerGoEpisode(-1),
  },
  {
    group: "Playback",
    keys: ["S"],
    combo: ["KeyS"],
    label: "Skip intro / recap / credits",
    run: playerSkipSegment,
  },
  {
    group: "Seeking",
    keys: ["←"],
    combo: ["ArrowLeft"],
    label: "Back 5 seconds",
    run: () => playerSeekBy(-5),
  },
  {
    group: "Seeking",
    keys: ["→"],
    combo: ["ArrowRight"],
    label: "Forward 5 seconds",
    run: () => playerSeekBy(5),
  },
  {
    group: "Seeking",
    keys: ["J"],
    combo: ["KeyJ"],
    label: "Back 10 seconds",
    run: () => playerSeekBy(-10),
  },
  {
    group: "Seeking",
    keys: ["L"],
    combo: ["KeyL"],
    label: "Forward 10 seconds",
    run: () => playerSeekBy(10),
  },
  {
    group: "Seeking",
    keys: ["Shift + ←"],
    combo: ["Shift+ArrowLeft"],
    label: "Back 30 seconds",
    run: () => playerSeekBy(-30),
  },
  {
    group: "Seeking",
    keys: ["Shift + →"],
    combo: ["Shift+ArrowRight"],
    label: "Forward 30 seconds",
    run: () => playerSeekBy(30),
  },
  {
    group: "Seeking",
    keys: ["Home"],
    combo: ["Home"],
    label: "Jump to the start",
    run: () => playerSeekToFraction(0),
  },
  {
    group: "Seeking",
    keys: ["End"],
    combo: ["End"],
    label: "Jump to the end",
    run: () => playerSeekToFraction(1),
  },
  {
    group: "Seeking",
    keys: ["0 – 9"],
    label: "Jump to 0% – 90%",
    match: (e) => /^(Digit|Numpad)[0-9]$/.test(e.code) && !e.shiftKey,
    run: (e) => playerSeekToFraction(Number(e.code.slice(-1)) / 10),
  },
  {
    group: "Audio",
    keys: ["↑"],
    combo: ["ArrowUp"],
    label: "Volume up",
    run: () => playerAdjustVolume(0.05),
  },
  {
    group: "Audio",
    keys: ["↓"],
    combo: ["ArrowDown"],
    label: "Volume down",
    run: () => playerAdjustVolume(-0.05),
  },
  {
    group: "Audio",
    keys: ["M"],
    combo: ["KeyM"],
    label: "Mute / unmute",
    run: playerToggleMute,
  },
  {
    group: "Audio",
    keys: ["C"],
    combo: ["KeyC"],
    label: "Cycle subtitles",
    run: playerCycleSubtitles,
  },
  {
    group: "Speed",
    keys: [">"],
    combo: ["Period"],
    label: "Speed up",
    run: () => playerStepRate(1),
  },
  {
    group: "Speed",
    keys: ["<"],
    combo: ["Comma"],
    label: "Slow down",
    run: () => playerStepRate(-1),
  },
  {
    group: "Speed",
    keys: ["R"],
    combo: ["KeyR"],
    label: "Reset to normal speed",
    run: () => playerSetRate(1),
  },
  {
    group: "Display",
    keys: ["F"],
    combo: ["KeyF"],
    label: "Fullscreen",
    run: playerToggleFullscreen,
  },
  {
    group: "Display",
    keys: ["T"],
    combo: ["KeyT"],
    label: "Theater mode",
    run: () => playerToggleTheater(),
  },
  {
    group: "Display",
    keys: ["I"],
    combo: ["KeyI"],
    label: "Picture in picture",
    run: playerTogglePip,
  },
  {
    group: "Display",
    keys: ["?"],
    label: "Show / hide this list",
    match: (e) => e.key === "?",
    anytime: true,
    run: toggleShortcuts,
  },
  {
    group: "Display",
    keys: ["Esc"],
    combo: ["Escape"],
    label: "Close menus, leave fullscreen",
    anytime: true,
    run: playerEscape,
  },
];

/** "Shift+KeyL" — modifier prefix plus the physical key. */
function shortcutCombo(e) {
  return `${e.shiftKey ? "Shift+" : ""}${e.code}`;
}

function findShortcut(e) {
  const combo = shortcutCombo(e);
  return PLAYER_SHORTCUTS.find((s) =>
    s.match ? s.match(e) : s.combo?.includes(combo),
  );
}

/** Builds the help modal from PLAYER_SHORTCUTS, grouped in table order. */
function renderShortcutsHelp() {
  const body = document.getElementById("shortcutsBody");
  if (!body || body.childElementCount) return;

  const groups = [];
  for (const shortcut of PLAYER_SHORTCUTS) {
    let group = groups.find((g) => g.name === shortcut.group);
    if (!group) groups.push((group = { name: shortcut.group, items: [] }));
    group.items.push(shortcut);
  }

  for (const group of groups) {
    const section = document.createElement("section");
    section.className = "shortcuts-group";

    const title = document.createElement("h4");
    title.textContent = group.name;
    section.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "shortcuts-grid";
    for (const item of group.items) {
      const row = document.createElement("div");
      row.className = "shortcut-item";
      const keys = document.createElement("span");
      keys.className = "shortcut-keys";
      item.keys.forEach((k, i) => {
        if (i) {
          const sep = document.createElement("span");
          sep.className = "shortcut-sep";
          sep.textContent = "/";
          keys.appendChild(sep);
        }
        const key = document.createElement("span");
        key.className = "key";
        key.textContent = k;
        keys.appendChild(key);
      });
      row.appendChild(keys);
      const label = document.createElement("span");
      label.className = "shortcut-label";
      label.textContent = item.label;
      row.appendChild(label);
      grid.appendChild(row);
    }
    section.appendChild(grid);
    body.appendChild(section);
  }
}

// ── Media Session (OS media keys, lock screen, media hub) ─────────────
// Costs nothing where it isn't supported, and is what makes the hardware
// play/pause key and the browser's own media widget address this player
// instead of doing nothing.
function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const player = getPlayer();
  const showTitle = currentShowData?.title || document.title;
  const artwork = [currentShowData?.poster, currentShowData?.banner]
    .filter(Boolean)
    .map((src) => ({ src }));

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title:
        currentPlaybackType === "episode" && currentEpisodeLabel
          ? `${currentEpisodeLabel} — ${showTitle}`
          : showTitle,
      artist: "Streamio",
      artwork,
    });
  } catch {
    /* MediaMetadata unavailable — the action handlers below still work */
  }

  const handlers = {
    play: () => player.play()?.catch(() => {}),
    pause: () => player.pause(),
    seekbackward: (d) => playerSeekBy(-(d?.seekOffset || 10)),
    seekforward: (d) => playerSeekBy(d?.seekOffset || 10),
    seekto: (d) => d?.seekTime != null && playerSeekTo(d.seekTime),
    previoustrack: () => playerGoEpisode(-1),
    nexttrack: () => playerGoEpisode(1),
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      /* action unsupported by this browser — skip it */
    }
  }
}

function initPlayerControls() {
  if (playerControlsInitialized) return;
  playerControlsInitialized = true;
  const player = getPlayer();
  const playBtn = document.getElementById("playBtn");
  const volumeBtn = document.getElementById("volumeBtn");
  const volumeSlider = document.getElementById("volumeSlider");
  const progressBar = document.getElementById("progressBar");
  const fullscreenBtn = document.getElementById("fullscreenBtn");
  const svg = playBtn.querySelector("svg");

  playBtn.onclick = playerTogglePlayback;
  player.onplay = () =>
    (svg.innerHTML =
      '<line x1="6" y1="4" x2="6" y2="20"></line><line x1="18" y1="4" x2="18" y2="20"></line>');
  player.onpause = () =>
    (svg.innerHTML = '<polygon points="5 3 19 12 5 21 5 3"></polygon>');
  player.ondurationchange = updateProgress;
  player.ontimeupdate = () => {
    updateProgress();
    // Reaching the tail is what records completion, not the "ended" event:
    // seeking into the last seconds (skip button, progress-bar drag) often
    // fires no "ended" at all, and closing the tab there saved completed:false.
    if (isEffectivelyFinished(player)) markCurrentPlaybackDone();
    maybeShowNextEpPrompt();
    maybeShowSkipSegment();
  };

  player.addEventListener("progress", updateBufferedBar);
  player.addEventListener("ratechange", updateSpeedMenu);
  // Volume can also change from the OS mixer or a hardware key, which never
  // goes through playerSetVolume — keep the slider honest either way.
  player.addEventListener("volumechange", syncVolumeUI);

  volumeSlider.oninput = (e) => playerSetVolume(e.target.value / 100, false);
  volumeBtn.onclick = playerToggleMute;
  restoreVolume();
  updateSpeedMenu();
  renderShortcutsHelp();
  try {
    if (localStorage.getItem(THEATER_STORAGE_KEY) === "1")
      playerToggleTheater(true);
  } catch {
    /* ignore */
  }

  // ── Scrubbing ──────────────────────────────────────────────────────
  // Pointer events rather than a click handler so a click and a drag are the
  // same gesture: the seek is committed on release, and only the preview
  // moves while the pointer is down (seeking on every move restarts the HLS
  // fetch dozens of times across one drag).
  const progressTooltip = document.getElementById("progressTooltip");

  function positionFromEvent(e) {
    const r = progressBar.getBoundingClientRect();
    return Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
  }

  function previewAt(fraction) {
    const d = playerDuration();
    if (!d) return;
    document.getElementById("progressFill").style.width = fraction * 100 + "%";
    document.getElementById("currentTime").textContent = formatTime(
      fraction * d,
    );
  }

  function showTooltipAt(fraction) {
    const d = playerDuration();
    if (!d) return;
    progressTooltip.textContent = formatTime(fraction * d);
    progressTooltip.style.left = fraction * 100 + "%";
    progressTooltip.classList.add("show");
  }

  progressBar.addEventListener("pointermove", (e) => {
    if (!isScrubbing) showTooltipAt(positionFromEvent(e));
  });
  progressBar.addEventListener("pointerleave", () => {
    if (!isScrubbing) progressTooltip.classList.remove("show");
  });

  progressBar.addEventListener("pointerdown", (e) => {
    if (!playerDuration()) return;
    e.preventDefault();
    isScrubbing = true;
    progressBar.classList.add("scrubbing");
    progressBar.setPointerCapture(e.pointerId);
    const fraction = positionFromEvent(e);
    previewAt(fraction);
    showTooltipAt(fraction);
  });

  progressBar.addEventListener("pointermove", (e) => {
    if (!isScrubbing) return;
    const fraction = positionFromEvent(e);
    previewAt(fraction);
    showTooltipAt(fraction);
  });

  function endScrub(e) {
    if (!isScrubbing) return;
    isScrubbing = false;
    progressBar.classList.remove("scrubbing");
    progressTooltip.classList.remove("show");
    playerSeekTo(positionFromEvent(e) * playerDuration());
    updateProgress();
  }

  progressBar.addEventListener("pointerup", endScrub);
  progressBar.addEventListener("pointercancel", endScrub);

  fullscreenBtn.onclick = playerToggleFullscreen;
  document.getElementById("theaterBtn").onclick = () => playerToggleTheater();
  // Leaving fullscreen with the browser's own Esc/F11 must still un-press the
  // button state theater mode shares with it.
  document.addEventListener("fullscreenchange", () =>
    document
      .getElementById("playerContainer")
      .classList.toggle("is-fullscreen", !!document.fullscreenElement),
  );

  const helpBtn = document.getElementById("helpBtn");
  // Icon prepended here rather than inlined in the markup so the label still
  // reads if this script never runs.
  helpBtn.insertAdjacentHTML("afterbegin", `${ICON_KEYBOARD} `);
  helpBtn.onclick = () => {
    document.getElementById("moreDropdown")?.classList.remove("show");
    showShortcuts();
  };
  document.getElementById("shareBtn").onclick = openShareForCurrent;

  // Quality/subtitles/download/shortcuts live behind one "More" button so
  // they don't crowd out (or get clipped past) the controls people reach
  // for constantly — play, volume, share, watch party, fullscreen.
  const moreBtn = document.getElementById("moreBtn");
  const moreDropdown = document.getElementById("moreDropdown");
  moreBtn.onclick = (e) => {
    e.stopPropagation();
    moreDropdown.classList.toggle("show");
  };
  document.addEventListener("click", (e) => {
    if (!moreDropdown.classList.contains("show")) return;
    if (moreDropdown.contains(e.target) || moreBtn.contains(e.target)) return;
    moreDropdown.classList.remove("show");
  });
  // ── Keyboard ───────────────────────────────────────────────────────
  // Dispatch is table-driven (see PLAYER_SHORTCUTS): the handler and the help
  // modal read the same list, so a binding cannot exist undocumented and the
  // modal cannot list a key that does nothing.
  const KEY_REPEAT_MS = 120;
  let lastKeyAt = 0;

  document.addEventListener("keydown", (e) => {
    // Never claim a browser/OS chord (Ctrl+R, Cmd+L, ...).
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const activeTag = document.activeElement?.tagName;
    if (
      activeTag === "INPUT" ||
      activeTag === "TEXTAREA" ||
      activeTag === "SELECT" ||
      document.activeElement?.isContentEditable
    )
      return;
    // Space/Enter on a focused button is that button's own activation key —
    // an episode card must not toggle playback instead of opening.
    if (
      (activeTag === "BUTTON" || activeTag === "A") &&
      (e.code === "Space" || e.code === "Enter")
    )
      return;

    const shortcut = findShortcut(e);
    if (!shortcut) return;
    // Everything but Esc and the help list needs a player on screen — while
    // casting the local element is hidden and the cast panel owns playback.
    if (!shortcut.anytime && getPlayer().style.display === "none") return;

    e.preventDefault();
    // Held arrow keys fire far faster than a seek can settle; one step per
    // frame-ish keeps a long press smooth instead of queueing dozens of them.
    const now = Date.now();
    if (e.repeat && now - lastKeyAt < KEY_REPEAT_MS) return;
    lastKeyAt = now;

    shortcut.run(e);
    showControlsUI();
  });

  // Picture-in-Picture
  const pipBtn = document.getElementById("pipBtn");
  if (pipBtn) pipBtn.onclick = playerTogglePip;

  // ── Auto-hide controls on inactivity (fullscreen keeps the mouse
  // "hovering" the container forever, so CSS :hover alone never hides them) ──
  const playerContainer = document.getElementById("playerContainer");
  const playerControls = document.getElementById("playerControls");
  const CONTROLS_HIDE_DELAY = 3000;
  // Touch devices have no real hover state — mouseenter/mouseleave fire at
  // most once per tap (if at all), so hover-tracking logic below is skipped
  // for them in favor of an explicit tap-to-toggle handler.
  const isTouchDevice = window.matchMedia(
    "(hover: none), (pointer: coarse)",
  ).matches;
  let controlsHideTimer = null;
  let pointerOverControls = false;

  function showControlsUI() {
    playerContainer.classList.add("show-controls");
    clearTimeout(controlsHideTimer);
    controlsHideTimer = setTimeout(() => {
      if (!player.paused && !pointerOverControls) {
        playerContainer.classList.remove("show-controls");
      }
    }, CONTROLS_HIDE_DELAY);
  }

  function hideControlsUI() {
    clearTimeout(controlsHideTimer);
    playerContainer.classList.remove("show-controls");
  }

  if (!isTouchDevice) {
    // Click the video itself to play/pause. Bound to the <video> element, not
    // the container, so clicks on the controls overlay (which spans the whole
    // container via its gradient) keep doing only what their button says.
    // Touch devices keep tap-to-toggle-controls instead — see the else branch.
    player.addEventListener("click", (e) => {
      e.preventDefault();
      playerTogglePlayback();
      showControlsUI();
    });
    // The two single clicks that precede a double-click toggle playback twice
    // and so cancel out — no need to defer the first one (and add lag to every
    // click-to-pause) just to keep this from fighting them.
    player.addEventListener("dblclick", (e) => {
      e.preventDefault();
      playerToggleFullscreen();
    });
    playerContainer.addEventListener("mousemove", showControlsUI);
    playerContainer.addEventListener("mouseenter", showControlsUI);
    playerContainer.addEventListener("mouseleave", () => {
      clearTimeout(controlsHideTimer);
      if (!player.paused) playerContainer.classList.remove("show-controls");
    });
    playerControls.addEventListener("mouseenter", () => {
      pointerOverControls = true;
      showControlsUI();
    });
    playerControls.addEventListener("mouseleave", () => {
      pointerOverControls = false;
      showControlsUI();
    });
  } else {
    // Tap the video area to toggle controls; taps on the controls
    // themselves are left alone so buttons keep working normally.
    playerContainer.addEventListener("click", (e) => {
      if (playerControls.contains(e.target)) {
        showControlsUI();
        return;
      }
      if (playerContainer.classList.contains("show-controls")) {
        hideControlsUI();
      } else {
        showControlsUI();
      }
    });
  }
  player.addEventListener("pause", () => {
    playerContainer.classList.add("show-controls");
    clearTimeout(controlsHideTimer);
  });
  player.addEventListener("play", showControlsUI);
  showControlsUI();

  // ── Mobile gestures ──
  let lastTap = 0;

  playerContainer.addEventListener("touchend", (e) => {
    const now = Date.now();
    const rect = playerContainer.getBoundingClientRect();
    const x = e.changedTouches[0].clientX - rect.left;
    if (now - lastTap < 300) {
      playerSeekBy(x < rect.width / 2 ? -10 : 10);
    }
    lastTap = now;
  });

  let touchStartY = null,
    startVolume = 1;
  playerContainer.addEventListener("touchstart", (e) => {
    touchStartY = e.touches[0].clientY;
    startVolume = player.volume;
  });
  playerContainer.addEventListener("touchmove", (e) => {
    if (touchStartY === null) return;
    const dy = touchStartY - e.touches[0].clientY;
    const rect = playerContainer.getBoundingClientRect();
    const x = e.touches[0].clientX - rect.left;
    if (x > rect.width / 2) {
      playerSetVolume(startVolume + dy / 200, false);
    }
  });
  playerContainer.addEventListener("touchend", () => {
    touchStartY = null;
  });
}

// Quality
// The active row is decided by `manualLevel`, never `currentLevel`: in auto
// mode hls.js reports the level ABR is *currently playing* there, so reading
// it made the highlight hop between rows on every bitrate switch and never
// sat on "Auto". Buttons carry their level in `data-level` because row 0 is
// Auto — matching a level against the DOM position highlighted the row below
// the one that was picked.
function updateQualityMenu() {
  if (!currentHls) return;
  const d = document.getElementById("qualityDropdown");
  d.innerHTML = "";

  const addBtn = (level, label) => {
    const btn = document.createElement("button");
    btn.className = "dropdown-btn";
    btn.dataset.level = String(level);
    btn.textContent = label;
    btn.onclick = () => {
      currentHls.currentLevel = level;
      updateQualityStyle();
    };
    d.appendChild(btn);
    return btn;
  };

  addBtn(-1, "Auto");

  // Highest first, the way every other player lists them. Safe now that the
  // level index travels in `data-level` rather than the row's position.
  const levels = currentHls.levels
    .map((level, idx) => ({ level, idx }))
    .sort(
      (a, b) =>
        (b.level.height || 0) - (a.level.height || 0) ||
        (b.level.bitrate || 0) - (a.level.bitrate || 0),
    );

  // Two renditions can share a height and differ only in bitrate; without the
  // suffix they render as two identical rows and picking one looks random.
  const heightCount = new Map();
  for (const { level } of levels)
    heightCount.set(level.height, (heightCount.get(level.height) || 0) + 1);

  for (const { level, idx } of levels) {
    let label = level.height ? `${level.height}p` : `Level ${idx}`;
    if (level.height && heightCount.get(level.height) > 1 && level.bitrate)
      label += ` (${Math.round(level.bitrate / 1000)} kbps)`;
    addBtn(idx, label);
  }

  updateQualityStyle();
}

function updateQualityStyle() {
  if (!currentHls) return;
  const manual = currentHls.manualLevel;
  const auto = manual === -1;
  const playing = currentHls.currentLevel;
  document.querySelectorAll("#qualityDropdown .dropdown-btn").forEach((b) => {
    const level = Number(b.dataset.level);
    b.classList.toggle("active", level === manual);
    // In auto mode, say which rendition it settled on instead of leaving the
    // menu looking like nothing is selected.
    if (level === -1) {
      const lvl = auto && playing >= 0 ? currentHls.levels[playing] : null;
      b.textContent = lvl && lvl.height ? `Auto (${lvl.height}p)` : "Auto";
    }
  });
}

// Download
// MP4 is the only download offered: the raw .m3u8 was a text file pointing at
// signed segment URLs that expire within minutes, and the segment-zip variant
// called a `createZip` that does not exist in this file.
async function downloadVideo() {
  if (isDownloading) return;
  isDownloading = true;
  document.getElementById("downloadToast").classList.add("show");
  try {
    await downloadMP4();
  } catch (err) {
    alert("Download failed: " + err.message);
  } finally {
    isDownloading = false;
  }
}

function closeDownloadToast() {
  document.getElementById("downloadToast").classList.remove("show");
}

function resolveManifestUrl() {
  if (currentHls?.url) return currentHls.url;
  if (currentVideoUrl) return currentVideoUrl;
  return null;
}

function setDownloadProgress(text, pct) {
  const status = document.getElementById("downloadStatus");
  const bar = document.getElementById("downloadBarFill");
  if (status) status.textContent = text;
  if (bar && pct != null) {
    bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  }
}

async function downloadMP4() {
  const manifestUrl = resolveManifestUrl();

  if (!manifestUrl) {
    alert("No video loaded");
    return;
  }

  const title = (
    document.getElementById("contentTitle").textContent || "video"
  ).replace(/\s+/g, "_");

  document.getElementById("downloadToast").classList.add("show");

  try {
    setDownloadProgress("Analyzing stream...", 0);

    const blob = await downloadHLSYTDLP(manifestUrl, title);

    setDownloadProgress("Done", 100);

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${title}.mp4`;
    a.click();
  } catch (e) {
    console.error(e);
    setDownloadProgress("Error: " + e.message, null);
  }
}

const MAX_CONCURRENT = 8;
const MAX_RETRIES = 3;

async function downloadHLSYTDLP(manifestUrl, title) {
  const res = await fetch(manifestUrl);
  const text = await res.text();

  const baseUrl = manifestUrl.substring(0, manifestUrl.lastIndexOf("/") + 1);

  // =====================
  // MASTER CHECK
  // =====================
  let videoUrl = manifestUrl;
  const isMaster = text.includes("#EXT-X-STREAM-INF");

  if (isMaster) {
    const variants = parseMaster(text, baseUrl);
    videoUrl = variants[0].url;
  }

  // =====================
  // MEDIA PARSE
  // =====================
  const mediaText = await (await fetch(videoUrl)).text();
  const mediaBase = videoUrl.substring(0, videoUrl.lastIndexOf("/") + 1);

  const { segments, key } = parseMedia(mediaText, mediaBase);

  console.log(`Segments: ${segments.length}`);
  console.log(`AES key:`, key);

  // =====================
  // DOWNLOAD VIDEO SEGMENTS
  // =====================
  // #EXT-X-MEDIA:TYPE=AUDIO lives in the master playlist (alongside
  // #EXT-X-STREAM-INF), not in the chosen video variant's segment playlist.
  const audioLine = isMaster
    ? text
        .split("\n")
        .find((l) => l.includes("EXT-X-MEDIA") && l.includes("TYPE=AUDIO"))
    : null;
  const videoShare = audioLine ? 60 : 85;

  setDownloadProgress(`Downloading video segments (0/${segments.length})`, 0);
  const videoData = await downloadSegments(segments, key, (done, total) => {
    setDownloadProgress(
      `Downloading video segments (${done}/${total})`,
      (done / total) * videoShare,
    );
  });

  // =====================
  // OPTIONAL AUDIO (if separate playlist exists)
  // =====================
  let audioData = null;

  if (audioLine) {
    try {
      const audioUrl = new URL(
        audioLine.split('URI="')[1].split('"')[0],
        baseUrl,
      ).href;

      const audioText = await (await fetch(audioUrl)).text();
      const audioParsed = parseMedia(audioText, audioUrl);

      setDownloadProgress(
        `Downloading audio segments (0/${audioParsed.segments.length})`,
        videoShare,
      );
      audioData = await downloadSegments(
        audioParsed.segments,
        audioParsed.key,
        (done, total) => {
          setDownloadProgress(
            `Downloading audio segments (${done}/${total})`,
            videoShare + (done / total) * (85 - videoShare),
          );
        },
      );
    } catch (e) {
      console.warn("Audio failed:", e);
    }
  }

  // =====================
  // CONCATENATE SEGMENT BYTES
  // =====================
  const videoFlat = concatUint8Arrays(videoData);
  const audioFlat = audioData ? concatUint8Arrays(audioData) : null;

  // =====================
  // MERGE
  // =====================
  setDownloadProgress("Merging with ffmpeg...", 85);
  const blob = await mergeFFmpeg(videoFlat, audioFlat, title, (frac) => {
    setDownloadProgress(
      `Merging with ffmpeg... ${Math.round(frac * 100)}%`,
      85 + frac * 13,
    );
  });

  return blob;
}

async function getFFmpeg() {
  if (ff) return ff;
  ff = new FFmpeg();

  ff.on("log", ({ message }) => console.log("[ffmpeg]", message));

  const baseURL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";
  await ff.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
    // Must be a real same-origin URL (not a blob: URL) — worker.js has its own
    // relative imports ("./const.js", "./errors.js") that fail to resolve
    // against an opaque blob: base, which silently hangs load()/exec() forever.
    classWorkerURL: new URL(
      "/scripts/vendor/ffmpeg/worker.js",
      window.location.href,
    ).href,
  });

  return ff;
}

async function mergeFFmpeg(video, audio, title, onProgress) {
  const ff = await getFFmpeg();

  const progressHandler = ({ progress }) => {
    if (Number.isFinite(progress))
      onProgress?.(Math.min(1, Math.max(0, progress)));
  };
  ff.on("progress", progressHandler);

  try {
    await ff.writeFile("video.ts", video);
    if (audio) await ff.writeFile("audio.ts", audio);

    const args = audio
      ? ["-i", "video.ts", "-i", "audio.ts", "-c", "copy", `${title}.mp4`]
      : ["-i", "video.ts", "-c", "copy", `${title}.mp4`];

    await ff.exec(args);

    const data = await ff.readFile(`${title}.mp4`);
    return new Blob([data.buffer], { type: "video/mp4" });
  } finally {
    ff.off("progress", progressHandler);
  }
}

function concatUint8Arrays(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

async function downloadSegments(segments, key, onProgress) {
  let aesKeyBytes = null;
  let aesIV = null;

  if (key) {
    const res = await fetchWithRetry(key.url);
    aesKeyBytes = new Uint8Array(await res.arrayBuffer());

    if (key.iv) {
      const hex = key.iv.padStart(32, "0");
      aesIV = new Uint8Array(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));
    }
  }

  return pool(
    MAX_CONCURRENT,
    segments,
    async (url, idx) => {
      const res = await fetchWithRetry(url);
      const buf = await res.arrayBuffer();

      if (aesKeyBytes) {
        const iv =
          aesIV ??
          new Uint8Array(16).fill(0).map((_, i) => (i === 15 ? idx : 0));
        return decryptAES128(buf, aesKeyBytes, iv);
      }

      return new Uint8Array(buf);
    },
    onProgress,
  );
}

async function decryptAES128(data, keyBytes, iv) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  );
  // IV: sequenza del segmento (0, 1, 2...) su 16 byte, oppure dall'#EXT-X-KEY
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv },
    key,
    data,
  );
  return new Uint8Array(decrypted);
}

function parseMedia(text, baseUrl) {
  const lines = text.split("\n");

  let key = null;
  const segments = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith("#EXT-X-KEY")) {
      const uri = line.match(/URI="(.+?)"/)?.[1];
      const ivHex = line.match(/IV=0x([0-9a-fA-F]+)/)?.[1];
      if (uri) {
        key = { url: new URL(uri, baseUrl).href, iv: ivHex || null };
      }
    }

    if (line && !line.startsWith("#")) {
      segments.push(new URL(line, baseUrl).href);
    }
  }

  return { segments, key };
}

function parseMaster(text, baseUrl) {
  const lines = text.split("\n");

  const variants = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("#EXT-X-STREAM-INF")) {
      const url = lines[i + 1]?.trim();
      const bandwidth = lines[i].match(/BANDWIDTH=(\d+)/)?.[1] || 0;

      if (url) {
        variants.push({
          url: new URL(url, baseUrl).href,
          bandwidth: Number(bandwidth),
        });
      }
    }
  }

  return variants.sort((a, b) => b.bandwidth - a.bandwidth);
}

async function pool(limit, items, fn, onProgress) {
  const results = [];
  let i = 0;
  let done = 0;

  const workers = new Array(limit).fill(null).map(async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
      done++;
      onProgress?.(done, items.length);
    }
  });

  await Promise.all(workers);
  return results;
}

async function fetchWithRetry(url, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status);
      return r;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((res) => setTimeout(res, 300 * (i + 1)));
    }
  }
}

async function getAESKey(keyUrl) {
  const res = await fetchWithRetry(keyUrl);
  return new Uint8Array(await res.arrayBuffer());
}

// Shortcuts
function showShortcuts() {
  renderShortcutsHelp();
  document.getElementById("modalOverlay").classList.add("show");
  document.getElementById("shortcutsModal").classList.add("show");
}
function closeShortcuts() {
  document.getElementById("modalOverlay").classList.remove("show");
  document.getElementById("shortcutsModal").classList.remove("show");
}
function toggleShortcuts() {
  document.getElementById("shortcutsModal").classList.contains("show")
    ? closeShortcuts()
    : showShortcuts();
}

// Stream helpers
function decodeManifestSource(source) {
  if (!source) return "";
  if (source.startsWith("data:")) {
    const ci = source.indexOf(",");
    if (ci === -1) return "";
    const meta = source.slice(0, ci),
      payload = source.slice(ci + 1);
    if (meta.includes(";base64")) return atob(payload);
    return decodeURIComponent(payload);
  }
  return source.trim();
}

// A resolved stream could point at a plain http:// host. When the page itself
// is served over https (Cloudflare Tunnel, ddns, ...) the browser blocks that
// as mixed content before hls.js ever sees it. Route it back through our own
// server, which fetches it and re-serves it (and every child segment/variant
// it rewrites) over the page's own https origin instead.
//
// `local`'s own stream URLs are same-origin and carry no headers, so neither
// check below ever fires for them today — this stays generic infra for any
// resolved stream that needs it, per the cross-cutting invariant in
// CLAUDE.md ("A resolved stream carrying `headers` must be proxied").
function needsSourceProxy(url, payload) {
  if (location.protocol === "https:" && /^http:\/\//i.test(url)) return true;

  // The resolver attaching headers to a stream means the upstream demands a
  // Referer/Origin (or sec-fetch-*) that this page cannot set on a cross-origin
  // request — those are forbidden header names in fetch/XHR. Only a
  // server-side fetch can send them, so the presence of headers *is* the
  // signal to proxy.
  try {
    if (payload && payload.headers && Object.keys(payload.headers).length > 0) {
      return true;
    }
  } catch {
    /* not proxied */
  }

  return false;
}

function proxyInsecureSource(url, payload) {
  if (!needsSourceProxy(url, payload)) return url;

  // A resolver that asked for a specific Referer gets it forwarded: the
  // proxy's default (the media host's own origin) is refused outright by some
  // CDNs.
  const referer = readRefererHeader(payload);
  const ref = referer ? "ref=" + encodeURIComponent(referer) + "&" : "";

  return "/api/cast-proxy?direct=1&" + ref + "url=" + encodeURIComponent(url);
}

/** The payload's Referer header, whatever case the resolver spelled it in. */
function readRefererHeader(payload) {
  const headers = payload && payload.headers;
  if (!headers || typeof headers !== "object") return "";

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "referer" && /^https?:\/\//i.test(value || "")) {
      return value;
    }
  }
  return "";
}

function buildPlayableUrl(payload) {
  const source = payload?.playlistUrl || payload?.source || payload?.url || "";
  if (!source) return "";
  if (source.startsWith("#EXTM3U")) {
    const blob = new Blob([source], { type: "application/vnd.apple.mpegurl" });
    currentBlobUrl = URL.createObjectURL(blob);
    return currentBlobUrl;
  }
  if (source.startsWith("data:")) {
    const manifest = decodeManifestSource(source);
    if (manifest.startsWith("#EXTM3U")) {
      const blob = new Blob([manifest], {
        type: "application/vnd.apple.mpegurl",
      });
      currentBlobUrl = URL.createObjectURL(blob);
      return currentBlobUrl;
    }
    return manifest;
  }
  return proxyInsecureSource(source, payload);
}

function clearSubtitleTracks() {
  const player = getPlayer();
  [...player.querySelectorAll("track")].forEach((t) => t.remove());
}

function addSubtitleTrack(sub, isDefault = false) {
  const player = getPlayer();
  const track = document.createElement("track");
  track.kind = "subtitles";
  track.label = sub.label || sub.lang || "Subtitle";
  track.srclang = sub.lang || "en";
  track.src = sub.url || sub.file || sub.src;
  if (isDefault) track.default = true;
  player.appendChild(track);
}

function updateSubtitleMenu() {
  const player = getPlayer();
  const btn = document.getElementById("subtitleBtn");
  const dropdown = document.getElementById("subtitleDropdown");
  dropdown.innerHTML = "";

  const textTracks = [...player.textTracks];
  // Also fold in HLS-native subtitle tracks if present
  const hlsSubs = currentHls?.subtitleTracks || [];

  if (!textTracks.length && !hlsSubs.length) {
    btn.style.display = "none";
    return;
  }
  btn.style.display = "block"; // #subtitleBtn is now the "Subtitles" section wrapper, not an icon button

  const offBtn = document.createElement("button");
  offBtn.className = "dropdown-btn";
  offBtn.textContent = "Off";
  offBtn.onclick = () => {
    textTracks.forEach((t) => (t.mode = "hidden"));
    if (currentHls) currentHls.subtitleTrack = -1;
    updateSubtitleStyle(-1);
  };
  dropdown.appendChild(offBtn);

  // Native <track> elements (from stream.subtitles payload)
  textTracks.forEach((t, idx) => {
    const b = document.createElement("button");
    b.className = "dropdown-btn" + (t.mode === "showing" ? " active" : "");
    b.textContent = t.label || t.language || `Track ${idx + 1}`;
    b.onclick = () => {
      textTracks.forEach((tt) => (tt.mode = "hidden"));
      t.mode = "showing";
      updateSubtitleStyle(idx);
    };
    dropdown.appendChild(b);
  });

  // HLS-embedded subtitle renditions (WebVTT playlists inside the manifest)
  hlsSubs.forEach((t, idx) => {
    const b = document.createElement("button");
    b.className =
      "dropdown-btn" + (currentHls.subtitleTrack === idx ? " active" : "");
    b.textContent = t.name || t.lang || `Sub ${idx + 1}`;
    b.onclick = () => {
      currentHls.subtitleTrack = idx;
      currentHls.subtitleDisplay = true;
      updateSubtitleStyle(idx, true);
    };
    dropdown.appendChild(b);
  });
}

function updateSubtitleStyle(activeIdx, isHls = false) {
  const dropdown = document.getElementById("subtitleDropdown");
  const buttons = [...dropdown.querySelectorAll(".dropdown-btn")];
  buttons.forEach((b, i) => b.classList.remove("active"));
  // index 0 is "Off"
  if (activeIdx >= 0) {
    const offset = isHls
      ? dropdown.querySelectorAll(".dropdown-btn").length -
        (currentHls?.subtitleTracks?.length || 0)
      : 1;
    buttons[offset + activeIdx]?.classList.add("active");
  } else {
    buttons[0]?.classList.add("active");
  }
}

// Seeks to a shared clip's start time (once per page load) if the URL asked
// for one; otherwise falls back to resuming from watch history as before.
async function applyStartPosition(player) {
  if (deepLinkTimeSeconds != null && !deepLinkTimeConsumed) {
    deepLinkTimeConsumed = true;
    player.currentTime = deepLinkTimeSeconds;
    return;
  }
  const resume = await resumeProgress(currentPlaybackId, currentPlaybackType);
  if (resume) player.currentTime = resume;
}

function playResolvedStream(stream) {
  cleanupPlayer();
  getPlayer()._markedDone = false;
  hideSkipSegment();
  loadIntroSegments(); // fire-and-forget — must never delay stream start
  const rawSource = stream?.playlistUrl || stream?.source || stream?.url || "";
  // Cast can only play a publicly reachable http(s) HLS URL — blob:/data:
  // manifests are local-only, so casting stays disabled for those.
  setCastMedia(rawSource.startsWith("http") ? rawSource : "", stream);

  // Already casting: this resolve was an episode/server change made from the
  // page, so it belongs on the TV, not in the local (hidden) player.
  if (isCasting) {
    const session = castContext?.getCurrentSession();
    if (session) {
      loadCastMedia(session);
      showPlayerMessage(`Playing on ${castDeviceName || "your TV"}`);
      return;
    }
  }

  const url = buildPlayableUrl(stream);
  if (!url) {
    showPlayerMessage("Stream not available");
    return;
  }
  currentVideoUrl = url;
  showPlayer();
  const player = getPlayer();

  // A room joined in a paused state should stay paused through the initial
  // autoplay this function (and its HLS MANIFEST_PARSED handler) triggers.
  if (pendingRoomPause) {
    pendingRoomPause = false;
    player.addEventListener("playing", () => player.pause(), { once: true });
  }

  clearSubtitleTracks();
  const subs = stream?.subtitles || stream?.captions || [];
  if (Array.isArray(subs) && subs.length) {
    subs.forEach((s, i) => addSubtitleTrack(s, i === 0));
  }

  const headers =
    stream?.headers && typeof stream.headers === "object" ? stream.headers : {};
  // user-agent/cookie/referer/origin are all "forbidden" headers a browser
  // won't let XHR override anyway — filtering them here just avoids the
  // "Refused to set unsafe header" console spam; it isn't what makes
  // playback work (that's proxyInsecureSource() above for http-only sources).
  const safeHeaders = Object.fromEntries(
    Object.entries(headers)
      .filter(
        ([k]) =>
          !["user-agent", "cookie", "referer", "origin"].includes(
            k.toLowerCase(),
          ),
      )
      .map(([k, v]) => [k, String(v)]),
  );

  // Not every resolved stream is HLS — a plain progressive MP4 can't be
  // loaded by hls.js and plays straight off the <video> element instead.
  const isProgressive =
    url.startsWith("http") &&
    !/\.m3u8(\?|$)/i.test(url) &&
    (/^video\//i.test(stream?.type || "") ||
      /\.(mp4|m4v|webm|mov)(\?|$)/i.test(url));

  if (isProgressive) {
    player.src = url;
    player.play().catch(() => {});
    player.addEventListener(
      "loadedmetadata",
      async () => {
        updateSubtitleMenu();
        await applyStartPosition(player);
        player.play().catch(() => {});
      },
      { once: true },
    );
    return;
  }

  if (window.Hls && Hls.isSupported()) {
    // Tuned for the proxy hop, not a direct CDN. Every fragment travels
    // browser -> (reverse proxy, if any) -> server -> upstream CDN, and
    // /api/cast-proxy cannot send a byte until the CDN answers it, so
    // time-to-first-byte here is the *sum* of that chain. hls.js's default
    // ~10s TTFB budget expires against a merely sluggish upstream: the
    // symptom is a fragLoadTimeOut with `loaded: 0` (nothing arrived at all,
    // as opposed to a slow-but-progressing download), four of them in a row,
    // then a fatal error -> retryCurrentStream() -> reload -> the same
    // congested path again. Each pass leaves an orphan buffer range behind.
    //
    // lowLatencyMode is deliberately OFF: it is an LL-HLS setting, buys
    // nothing on VOD, and biases hls.js toward smaller buffers and tighter
    // stall tolerances — the opposite of what a high-latency hop needs.
    currentHls = new Hls({
      enableWorker: true,
      // Build a deeper cushion (default 30s) so one slow fragment is absorbed
      // instead of starving the playhead.
      maxBufferLength: 60,
      fragLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 30000,
          maxLoadTimeMs: 120000,
          timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
          errorRetry: {
            maxNumRetry: 6,
            retryDelayMs: 1000,
            maxRetryDelayMs: 8000,
          },
        },
      },
      // AES keys go through the same proxy as the segments. A key that times
      // out makes every already-buffered fragment undecryptable, so it gets
      // the same budget rather than the stricter default.
      keyLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 30000,
          maxLoadTimeMs: 120000,
          timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
          errorRetry: {
            maxNumRetry: 8,
            retryDelayMs: 1000,
            maxRetryDelayMs: 8000,
          },
        },
      },
      xhrSetup: (xhr) => {
        for (const [k, v] of Object.entries(safeHeaders))
          xhr.setRequestHeader(k, v);
      },
    });
    currentHls.loadSource(url);
    currentHls.attachMedia(player);
    currentHls.on(Hls.Events.MANIFEST_PARSED, async () => {
      streamRetryCount = 0;
      updateQualityMenu();
      updateSubtitleMenu();
      player.play().catch(() => {});
      await applyStartPosition(player);
      player.play().catch(() => {});
    });
    // Levels can be pruned after a load error, and the Auto row shows the
    // rendition ABR settled on — both need the menu redrawn.
    currentHls.on(Hls.Events.LEVEL_SWITCHED, updateQualityStyle);
    currentHls.on(Hls.Events.LEVELS_UPDATED, updateQualityMenu);
    currentHls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, updateSubtitleMenu);
    currentHls.on(Hls.Events.ERROR, (_, d) => {
      console.error("HLS error", d);
      if (d.fatal) retryCurrentStream();
    });
    return;
  }
  if (player.canPlayType("application/vnd.apple.mpegurl")) {
    player.src = url;
    player.play().catch(() => {});
    player.addEventListener(
      "loadedmetadata",
      async () => {
        updateSubtitleMenu();
        await applyStartPosition(player);
      },
      { once: true },
    );
    return;
  }
  showPlayerMessage("Browser does not support HLS");
}

// ============================================================================
//  GOOGLE CAST  (CAF sender → custom Streamio receiver app, id configured
//  server-side via CAST_RECEIVER_APP_ID, see /api/cast-config)
// ----------------------------------------------------------------------------
//  The Chromecast plays the raw upstream HLS URL through the server-side
//  /api/cast-proxy, which rewrites the manifest so every child segment is
//  fetched back through the same proxy (CORS + upstream Referer headers).
//  Both this base and the server-side rewriter MUST agree on the public
//  "/streamio" path prefix, otherwise the master manifest loads but every
//  segment 404s → connects to the TV, video never starts.
// ============================================================================
// Fetched from the server on init (see /api/cast-config) — server is the
// source of truth for its own public base URL (APP_URL) and receiver app id
// (CAST_RECEIVER_APP_ID).
let CAST_PROXY_BASE = null;
let CAST_RECEIVER_APP_ID = null;
let CAST_API_BASE = null; // absolute origin the receiver calls the API on

// The shared Streamio receiver, used when /api/cast-config can't be read.
// Safe to hardcode because that deployment is install-agnostic — it is handed
// apiBase/castProxyBase in customData on every LOAD — so one receiver serves
// every install. Kept in sync with CAST_RECEIVER_APP_ID's default in
// routes/content.router.ts.
const STREAMIO_RECEIVER_APP_ID = "BF64D6B2";

// The receiver talks back over this namespace: it tells us when it advanced an
// episode by itself, and we drive the control panel from its STATE messages.
const CAST_NS = "urn:x-cast:com.streamio.control";

let castContext = null;
let castButton = null;
let castSession = null;
let remotePlayer = null;
let remoteController = null;

let isCasting = false;
let castDeviceName = "";
let castProgressTimer = null;
// Identity of what's on the TV. Diverges from currentPlaybackId once the
// receiver advances an episode on its own, which is exactly why history has to
// be written against these and not the page's own state.
let castEpisodeId = "";
let castEpisodeLabel = "";
let castContentType = "episode";
let castRemoteState = null;

// Called by cast_sender.js once the Cast framework has loaded.
window["__onGCastApiAvailable"] = (isAvailable) => {
  if (isAvailable) initCast();
};

async function initCast() {
  try {
    const res = await fetch("/api/cast-config");
    const data = await res.json();
    CAST_PROXY_BASE = data.castProxyBase;
    CAST_RECEIVER_APP_ID = data.castReceiverAppId;
    // The receiver has no page origin to resolve relative URLs against, so it
    // needs the same absolute public base the proxy prefix is built from.
    CAST_API_BASE = String(CAST_PROXY_BASE || "").split("/api/cast-proxy")[0];
  } catch (err) {
    console.error("[cast] failed to fetch cast config:", err);
  }

  castButton = document.getElementById("castBtn");
  castContext = cast.framework.CastContext.getInstance();

  castContext.setOptions({
    // Never fall back to DEFAULT_MEDIA_RECEIVER_APP_ID: it mishandles the
    // demuxed audio/video HLS these providers emit, so a failed cast-config
    // fetch would turn into "casts, then plays wrong" instead of an error.
    receiverApplicationId: CAST_RECEIVER_APP_ID || STREAMIO_RECEIVER_APP_ID,
    autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    resumeSavedSession: true,
  });

  // Show/hide + highlight the button as devices appear and connect.
  castContext.addEventListener(
    cast.framework.CastContextEventType.CAST_STATE_CHANGED,
    (e) => reflectCastState(e.castState),
  );
  reflectCastState(castContext.getCastState());

  // When a session becomes active (user just picked a device), push the
  // currently selected stream to it.
  castContext.addEventListener(
    cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
    (e) => {
      const S = cast.framework.SessionState;
      if (
        e.sessionState === S.SESSION_STARTED ||
        e.sessionState === S.SESSION_RESUMED
      ) {
        onCastSessionStarted(castContext.getCurrentSession());
      } else if (e.sessionState === S.SESSION_ENDED) {
        onCastSessionEnded();
      }
    },
  );

  setupRemotePlayer();
  setupCastPanel();

  if (castButton) castButton.onclick = onCastButtonClick;
}

function reflectCastState(state) {
  if (!castButton) return;
  const CS = cast.framework.CastState;
  castButton.style.display =
    state === CS.NO_DEVICES_AVAILABLE ? "none" : "flex";
  castButton.style.color = state === CS.CONNECTED ? "var(--red)" : "";
}

// Record the raw HLS source of the stream currently loaded in the player.
// Passing "" (blob:/data: manifests) disables casting for that stream.
function setCastMedia(rawUrl, stream = null) {
  castMedia = rawUrl
    ? {
        url: rawUrl,
        title:
          document.getElementById("contentTitle")?.textContent?.trim() ||
          "Streamio",
        subtitles: (stream && (stream.subtitles || stream.captions)) || [],
        type: (stream && stream.type) || "",
        // The receiver plays through the same proxy, so it needs the same
        // Referer override the local player uses (see proxyInsecureSource).
        referer: readRefererHeader(stream),
        serverName: currentServerName,
        serverIndex: currentServerIndex,
      }
    : null;
}

function onCastButtonClick() {
  // Connected already: the button toggles the control panel rather than
  // re-loading what's already playing.
  if (isCasting) {
    toggleCastPanel();
    return;
  }

  if (!castMedia) {
    alert("Select a server and start playback before casting.");
    return;
  }

  const session = castContext.getCurrentSession();
  if (session) {
    onCastSessionStarted(session);
    return;
  }

  // Not connected: open the device chooser. requestSession() must be the
  // first async call inside the click handler or the browser blocks the
  // Presentation API. When the user picks a device SESSION_STARTED fires
  // and onCastSessionStarted() runs from the listener above.
  castContext.requestSession().catch((err) => {
    if (err !== "cancel") console.error("[cast] requestSession failed:", err);
  });
}

// ── Session lifecycle ───────────────────────────────────────────────────────

function onCastSessionStarted(session) {
  if (!session) return;
  castSession = session;
  isCasting = true;
  castDeviceName = session.getCastDevice()?.friendlyName || "your TV";

  // The page becomes a remote: the local player stops so two copies of the
  // same stream aren't being pulled at once.
  const player = getPlayer();
  player.pause();
  document.getElementById("playerContainer")?.classList.add("casting");

  session.addMessageListener(CAST_NS, (_ns, message) => {
    let payload;
    try {
      payload = typeof message === "string" ? JSON.parse(message) : message;
    } catch {
      return;
    }
    onReceiverMessage(payload);
  });

  loadCastMedia(session);
  sendToReceiver({ type: "HELLO", v: 1 });
  openCastPanel();
  startCastProgressTimer();

  if (roomConn) {
    showRoomToast("Watch party sync pauses while casting");
  }
}

function onCastSessionEnded() {
  if (!isCasting) return;
  saveCastProgress(false);
  stopCastProgressTimer();

  isCasting = false;
  castSession = null;
  castRemoteState = null;
  document.getElementById("playerContainer")?.classList.remove("casting");
  document.getElementById("castPanel")?.classList.remove("show");

  // Hand the position back to the local player, but leave it paused — nobody
  // wants audio suddenly coming out of the laptop.
  const player = getPlayer();
  const pos = remotePlayer?.currentTime;
  if (Number.isFinite(pos) && pos > 0 && player.readyState > 0) {
    player.currentTime = pos;
  }
  showPlayerMessage("Casting stopped");
}

// ── Load ────────────────────────────────────────────────────────────────────

// Everything the receiver needs to render a real UI, keep playing after this
// tab is gone, and re-resolve a stream whose URL has expired. Read live at load
// time (not at resolve time) so it reflects the episode actually being cast.
//
// This contract is shared with the Flutter client; the receiver degrades
// field-by-field, so adding to it never requires a coordinated release.
//
// tmdbId/imdbId/year are hints for the receiver's own Skip Intro/Recap/
// Credits/Preview lookup (cast-receiver's docs/protocol.md §5) — it fetches
// /api/intro-segments itself, the same way it fetches its own episode queue,
// so the feature keeps working for an episode the receiver advanced to on
// its own after this tab is closed. loadIntroSegments() already resolves
// these for the local button; reused here rather than recomputed.
function buildCastCustomData() {
  const showId = new URLSearchParams(window.location.search).get("id") || "";
  const isEpisode = currentPlaybackType === "episode";
  const show = currentShowData || {};

  return {
    v: 1,
    apiBase: CAST_API_BASE || location.origin,
    castProxyBase: CAST_PROXY_BASE,
    provider: localStorage.getItem(providerStorageKey) || "",
    contentType: currentPlaybackType,

    showId,
    tmdbId: currentIntroDbIds.tmdbId,
    imdbId: currentIntroDbIds.imdbId,
    year: currentIntroDbIds.year,
    showTitle: show.title || castMedia?.title || "Streamio",
    description: show.overview || "",
    poster: show.poster || "",
    backdrop: show.banner || show.poster || "",

    seasonId: "",
    seasonNumber: isEpisode
      ? Number(currentEpisodesList[currentEpisodeIndex]?.seasonNum) || null
      : null,
    episodeId: isEpisode ? currentPlaybackId : "",
    episodeNumber: isEpisode
      ? Number(currentEpisodesList[currentEpisodeIndex]?.episodeNum) || null
      : null,
    episodeTitle: isEpisode
      ? currentEpisodesList[currentEpisodeIndex]?.title || ""
      : "",
    episodeLabel: isEpisode ? currentEpisodeLabel : "",
    durationSeconds: Number.isFinite(getPlayer()?.duration)
      ? Math.floor(getPlayer().duration)
      : show.runtime
        ? show.runtime * 60
        : null,

    serverName: castMedia?.serverName || currentServerName,
    serverIndex: castMedia?.serverIndex ?? currentServerIndex,

    subtitles: castSubtitleList(),

    // Ids only — ~40 bytes each, so even a 300-episode show stays well inside
    // the Cast message budget. Saves the receiver a round of API calls; it
    // fetches the list itself if this is absent.
    episodes: currentEpisodesList.slice(0, 500).map((ep) => ({
      id: ep.id,
      s: ep.seasonNum,
      e: ep.episodeNum,
      t: ep.title,
    })),
    episodeIndex: currentEpisodeIndex,
    autoplayNext: autoplayNextEnabled,
    upNextSeconds: NEXT_EP_THRESHOLD,
  };
}

// Subtitle URLs must go through /api/cast-proxy: upstream VTT is often plain
// http (mixed content on an https receiver) and carries no CORS header, either
// of which makes CAF drop the track silently.
function castSubtitleList() {
  const subs = castMedia?.subtitles || [];
  return subs
    .map((s) => {
      const raw = s.url || s.file || s.src || "";
      if (!raw) return null;
      return {
        label: s.label || s.lang || "Subtitle",
        lang: s.lang || "und",
        url: castProxyUrl(raw),
        default: !!(s.default || s.initialDefault),
      };
    })
    .filter(Boolean);
}

function buildCastTracks(subs) {
  const tracks = [];
  subs.forEach((s, i) => {
    // Track ids must be unique positive integers — 0 is not a valid
    // activeTrackId.
    const t = new chrome.cast.media.Track(
      i + 1,
      chrome.cast.media.TrackType.TEXT,
    );
    t.trackContentId = s.url;
    t.trackContentType = "text/vtt";
    t.subtype = chrome.cast.media.TextTrackType.SUBTITLES;
    t.name = s.label;
    t.language = s.lang;
    tracks.push(t);
  });
  return tracks;
}

// Even though the receiver draws its own UI, MediaInformation.metadata is what
// Google Assistant ("what's playing") and the phone's media notification read.
function buildCastMetadata(customData) {
  const images = [];
  const art = customData.poster || customData.backdrop;
  if (art) images.push(new chrome.cast.Image(art));

  if (customData.contentType === "episode") {
    const md = new chrome.cast.media.TvShowMediaMetadata();
    md.seriesTitle = customData.showTitle;
    md.title =
      customData.episodeTitle ||
      customData.episodeLabel ||
      customData.showTitle;
    if (customData.seasonNumber) md.season = customData.seasonNumber;
    if (customData.episodeNumber) md.episode = customData.episodeNumber;
    if (images.length) md.images = images;
    return md;
  }

  const md = new chrome.cast.media.MovieMediaMetadata();
  md.title = customData.showTitle;
  if (customData.description)
    md.subtitle = customData.description.slice(0, 120);
  if (images.length) md.images = images;
  return md;
}

// The receiver's proxy base, with the current stream's Referer override folded
// in when its resolver asked for one. `CAST_PROXY_BASE` ends in "url=", so the
// extra param goes in ahead of it.
function castProxyUrl(rawUrl) {
  const ref = castMedia?.referer
    ? "ref=" + encodeURIComponent(castMedia.referer) + "&"
    : "";
  return (
    CAST_PROXY_BASE.replace(/url=$/, ref + "url=") + encodeURIComponent(rawUrl)
  );
}

function loadCastMedia(session) {
  if (!castMedia || !CAST_PROXY_BASE) return;

  const customData = buildCastCustomData();
  const proxied = castProxyUrl(castMedia.url);
  const isProgressive = /^video\//i.test(castMedia.type || "");
  const mediaInfo = new chrome.cast.media.MediaInfo(
    proxied,
    isProgressive ? castMedia.type : "application/x-mpegurl",
  );
  mediaInfo.streamType = chrome.cast.media.StreamType.BUFFERED;
  mediaInfo.metadata = buildCastMetadata(customData);

  const tracks = buildCastTracks(customData.subtitles);
  if (tracks.length) mediaInfo.tracks = tracks;

  // Declare the MPEG-2 TS segment formats. A demuxed stream (separate audio +
  // video renditions) can't be auto-detected by the Chromecast and otherwise
  // fails with error 315 (HLS_SEGMENT_PARSING). Set here as well as in the
  // receiver so the hint ships even if the receiver code is cached.
  if (!isProgressive) {
    mediaInfo.hlsSegmentFormat = chrome.cast.media.HlsSegmentFormat?.TS;
    mediaInfo.hlsVideoSegmentFormat =
      chrome.cast.media.HlsVideoSegmentFormat?.MPEG2_TS;
  }
  mediaInfo.customData = customData;

  const request = new chrome.cast.media.LoadRequest(mediaInfo);
  const localTime = getPlayer()?.currentTime;
  request.currentTime =
    Number.isFinite(localTime) && localTime > 0 ? Math.floor(localTime) : 0;
  request.autoplay = true;
  request.customData = customData;

  const defaultTrack = customData.subtitles.findIndex((s) => s.default);
  if (defaultTrack !== -1) request.activeTrackIds = [defaultTrack + 1];

  castEpisodeId = customData.episodeId || customData.showId;
  castEpisodeLabel = customData.episodeLabel;
  castContentType = customData.contentType;

  session.loadMedia(request).then(
    () => {
      console.log("[cast] loadMedia OK");
      renderCastPanel();
    },
    (err) => console.error("[cast] loadMedia error:", err),
  );
}

// ── Remote player ───────────────────────────────────────────────────────────

function setupRemotePlayer() {
  remotePlayer = new cast.framework.RemotePlayer();
  remoteController = new cast.framework.RemotePlayerController(remotePlayer);
  const E = cast.framework.RemotePlayerEventType;

  [
    E.IS_CONNECTED_CHANGED,
    E.CURRENT_TIME_CHANGED,
    E.DURATION_CHANGED,
    E.IS_PAUSED_CHANGED,
    E.VOLUME_LEVEL_CHANGED,
    E.IS_MUTED_CHANGED,
    E.MEDIA_INFO_CHANGED,
    E.PLAYER_STATE_CHANGED,
  ].forEach((evt) =>
    remoteController.addEventListener(evt, () => renderCastPanel()),
  );
}

// ── Receiver messages ───────────────────────────────────────────────────────

function sendToReceiver(payload) {
  if (!castSession) return;
  try {
    castSession.sendMessage(CAST_NS, payload);
  } catch (err) {
    console.warn("[cast] sendMessage failed", err);
  }
}

// Every message is advisory: a device may be running an older receiver out of
// its cache and never send any of these.
function onReceiverMessage(payload) {
  if (!payload || typeof payload !== "object") return;

  if (payload.type === "STATE") {
    castRemoteState = payload;
    renderCastPanel();
    return;
  }

  if (payload.type === "EPISODE_CHANGED") {
    // The receiver advanced by itself. Close out the episode that just
    // finished, then re-point history at the new one.
    saveCastProgress(true);
    castEpisodeId = payload.episodeId || castEpisodeId;
    castEpisodeLabel = payload.episodeLabel || "";
    castContentType = "episode";

    const idx = currentEpisodesList.findIndex(
      (e) => e.id === payload.episodeId,
    );
    if (idx !== -1) {
      currentEpisodeIndex = idx;
      currentPlaybackId = payload.episodeId;
      currentEpisodeLabel = castEpisodeLabel;
      document.querySelectorAll("#episodesGrid .epbtn").forEach((b) => {
        b.classList.toggle("active", b.dataset.episodeId === payload.episodeId);
      });
    }
    renderCastPanel();
    return;
  }

  if (payload.type === "RECOVERING") {
    showPlayerMessage(`Reconnecting the stream on ${castDeviceName}…`);
    return;
  }

  if (payload.type === "ERROR") {
    showPlayerMessage(`Cast error: ${payload.message || "playback failed"}`);
  }
}

// ── Progress reporting while casting ────────────────────────────────────────
//
// Note this only runs while the page is open. Close the tab and history stops
// advancing: the receiver has no access token and cannot write it itself.
function startCastProgressTimer() {
  stopCastProgressTimer();
  castProgressTimer = setInterval(() => {
    if (!isCasting || !remotePlayer || remotePlayer.isPaused) return;
    saveCastProgress(false);
  }, 30_000);
}

function stopCastProgressTimer() {
  if (castProgressTimer) clearInterval(castProgressTimer);
  castProgressTimer = null;
}

function saveCastProgress(completed) {
  if (!isCasting || !remotePlayer) return;
  saveProgress(completed, {
    positionSeconds: remotePlayer.currentTime,
    durationSeconds: remotePlayer.duration,
    playbackId: castEpisodeId,
    episodeLabel: castEpisodeLabel,
    contentType: castContentType,
  });
}

// ── Control panel ───────────────────────────────────────────────────────────

function setupCastPanel() {
  const $ = (id) => document.getElementById(id);

  $("castPanelClose")?.addEventListener("click", () =>
    $("castPanel").classList.remove("show"),
  );
  $("castPlayBtn")?.addEventListener("click", () =>
    remoteController?.playOrPause(),
  );
  $("castMuteBtn")?.addEventListener("click", () =>
    remoteController?.muteOrUnmute(),
  );
  $("castVolume")?.addEventListener("input", (e) => {
    if (!remotePlayer) return;
    remotePlayer.volumeLevel = Number(e.target.value) / 100;
    remoteController.setVolumeLevel();
  });
  $("castBar")?.addEventListener("click", (e) => {
    if (!remotePlayer || !remotePlayer.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    remotePlayer.currentTime =
      ((e.clientX - rect.left) / rect.width) * remotePlayer.duration;
    remoteController.seek();
  });
  $("castBack10Btn")?.addEventListener("click", () => castSeekBy(-10));
  $("castFwd10Btn")?.addEventListener("click", () => castSeekBy(10));
  $("castPrevBtn")?.addEventListener("click", () =>
    sendToReceiver({ type: "PLAY_EPISODE", index: currentEpisodeIndex - 1 }),
  );
  $("castNextBtn")?.addEventListener("click", () =>
    sendToReceiver({ type: "PLAY_NEXT_NOW" }),
  );
  $("castSkipSegmentBtn")?.addEventListener("click", () =>
    sendToReceiver({ type: "SKIP_SEGMENT_NOW" }),
  );
  $("castAutoplayNext")?.addEventListener("change", (e) => {
    autoplayNextEnabled = e.target.checked;
    sendToReceiver({ type: "SET_AUTOPLAY", enabled: autoplayNextEnabled });
  });
  $("castEpisodeSelect")?.addEventListener("change", (e) => {
    const index = Number(e.target.value);
    if (Number.isFinite(index) && index >= 0) {
      sendToReceiver({ type: "PLAY_EPISODE", index });
    }
  });
  $("castSubtitleSelect")?.addEventListener("change", (e) => {
    sendToReceiver({ type: "SET_SUBTITLE", trackId: Number(e.target.value) });
  });
  $("castAudioSelect")?.addEventListener("change", (e) => {
    sendToReceiver({
      type: "SET_AUDIO_TRACK",
      trackId: Number(e.target.value),
    });
  });
  $("castDisconnectBtn")?.addEventListener("click", () => {
    castContext?.endCurrentSession(true);
  });
}

/**
 * Skip by `seconds` on the receiver; negative rewinds.
 *
 * Off the RemotePlayer's own clock rather than the last STATE, which is only
 * broadcast every 5s — computing from a stale position would skip by up to
 * fifteen seconds.
 */
function castSeekBy(seconds) {
  if (!remotePlayer || !remoteController || !remotePlayer.duration) return;
  const target = (remotePlayer.currentTime || 0) + seconds;
  remotePlayer.currentTime = Math.max(
    0,
    Math.min(target, remotePlayer.duration),
  );
  remoteController.seek();
}

function toggleCastPanel() {
  const panel = document.getElementById("castPanel");
  if (!panel) return;
  panel.classList.toggle("show");
  if (panel.classList.contains("show")) renderCastPanel();
}

function openCastPanel() {
  document.getElementById("castPanel")?.classList.add("show");
  renderCastPanel();
}

function renderCastPanel() {
  const panel = document.getElementById("castPanel");
  if (!panel || !panel.classList.contains("show")) return;
  const $ = (id) => document.getElementById(id);

  $("castDeviceName").textContent = `Casting to ${castDeviceName || "TV"}`;
  $("castNowTitle").textContent =
    castRemoteState?.showTitle || currentShowData?.title || "Streamio";
  $("castNowSub").textContent = [
    castRemoteState?.episodeLabel || castEpisodeLabel,
    castRemoteState?.episodeTitle,
  ]
    .filter(Boolean)
    .join(" · ");

  const poster = currentShowData?.poster || "";
  const posterEl = $("castNowPoster");
  if (poster) {
    posterEl.src = poster;
    posterEl.style.display = "";
  } else {
    posterEl.style.display = "none";
  }

  const cur = remotePlayer?.currentTime || 0;
  const dur = remotePlayer?.duration || 0;
  $("castBarFill").style.width = dur ? `${(cur / dur) * 100}%` : "0%";
  $("castElapsed").textContent = castClock(cur);
  $("castDuration").textContent = castClock(dur);
  $("castPlayBtn").innerHTML = remotePlayer?.isPaused ? ICON_PLAY : ICON_PAUSE;
  $("castMuteBtn").innerHTML = remotePlayer?.isMuted
    ? ICON_VOLUME_MUTE
    : ICON_VOLUME_ON;

  const vol = $("castVolume");
  if (document.activeElement !== vol) {
    vol.value = Math.round((remotePlayer?.volumeLevel ?? 1) * 100);
  }

  $("castAutoplayNext").checked = autoplayNextEnabled;

  const skipBtn = $("castSkipSegmentBtn");
  const skipSegment = castRemoteState?.skipSegment;
  skipBtn.hidden = !skipSegment;
  if (skipSegment) skipBtn.textContent = skipSegment.label || "Skip";

  const epSelect = $("castEpisodeSelect");
  epSelect.style.display = currentEpisodesList.length ? "" : "none";
  if (
    currentEpisodesList.length &&
    epSelect.dataset.count !== String(currentEpisodesList.length)
  ) {
    epSelect.dataset.count = String(currentEpisodesList.length);
    epSelect.innerHTML = currentEpisodesList
      .map(
        (ep, i) =>
          `<option value="${i}">S${ep.seasonNum}E${ep.episodeNum} — ${escapeHtml(ep.title || "Episode")}</option>`,
      )
      .join("");
  }
  if (currentEpisodeIndex >= 0) epSelect.value = String(currentEpisodeIndex);

  const subSelect = $("castSubtitleSelect");
  const tracks = castRemoteState?.subtitleTracks || [];
  subSelect.style.display = tracks.length ? "" : "none";
  if (tracks.length && subSelect.dataset.count !== String(tracks.length)) {
    subSelect.dataset.count = String(tracks.length);
    subSelect.innerHTML =
      `<option value="-1">Subtitles off</option>` +
      tracks
        .map(
          (t) =>
            `<option value="${t.id}">${escapeHtml(t.name || t.lang)}</option>`,
        )
        .join("");
  }
  if (castRemoteState?.activeTrackId != null) {
    subSelect.value = String(castRemoteState.activeTrackId);
  }

  // Audio renditions live inside the HLS manifest rather than in the tracks
  // the sender declared, so the receiver reads them back from CAF and an empty
  // list is a normal answer — on some devices/streams its JS layer can't see
  // them at all, and an older receiver doesn't send the field. Either way the
  // picker stays hidden: an empty one reads as a broken control, an absent one
  // reads as a stream with a single language.
  const audioSelect = $("castAudioSelect");
  const audio = castRemoteState?.audioTracks || [];
  audioSelect.hidden = audio.length < 2;
  if (audio.length && audioSelect.dataset.count !== String(audio.length)) {
    audioSelect.dataset.count = String(audio.length);
    audioSelect.innerHTML = audio
      .map(
        (t) =>
          `<option value="${t.id}">${escapeHtml(t.name || t.lang)}</option>`,
      )
      .join("");
  }
  if (castRemoteState?.activeAudioTrackId > 0) {
    audioSelect.value = String(castRemoteState.activeAudioTrackId);
  }
}

// Kept as a name of its own because the cast panel calls it in a dozen places;
// formatTime() has grown the hour component this used to exist for.
function castClock(seconds) {
  return formatTime(Math.max(0, seconds || 0));
}

// ============================================================================
//  WATCH PARTY (room sync)
// ----------------------------------------------------------------------------
//  Any member's play/pause/seek/episode-or-server change is sent to the
//  server (services/room-socket.service.ts) and rebroadcast to everyone
//  else in the room, who apply it locally. `applyingRemoteState` and
//  `roomEchoGuard` exist to stop a client from re-broadcasting a change
//  it just received (which would otherwise ping-pong forever), and to
//  ignore the native 'seeked'/'play'/'pause' events that firing
//  player.currentTime/.play()/.pause() themselves trigger.
// ============================================================================

// Different providers use different ids for the "same" show/episode, so
// everyone in a room needs to be browsing under the room's provider — not
// whatever they last had selected on this device — or content lookups will
// 404 or resolve to the wrong title.
function syncProviderFromRoom(provider) {
  if (!provider) return;
  if (localStorage.getItem(providerStorageKey) !== provider) {
    localStorage.setItem(providerStorageKey, provider);
  }
}

async function ensureRoomSelfId() {
  roomSelfId = await getSelfId();
  return roomSelfId;
}

function showRoomToast(msg) {
  const el = document.getElementById("roomToast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(roomToastTimer);
  roomToastTimer = setTimeout(() => el.classList.remove("show"), 3500);
}

function armEchoGuard(time, playing) {
  roomEchoGuard = { until: Date.now() + 2500, time, playing };
}

function shouldSuppressEcho(kind, value) {
  if (Date.now() > roomEchoGuard.until) return false;
  if (kind === "seek")
    return (
      roomEchoGuard.time != null && Math.abs(value - roomEchoGuard.time) < 1.5
    );
  if (kind === "play") return roomEchoGuard.playing === value;
  return false;
}

// These hooks listen on the local <video>, which is paused and frozen while
// casting — so every event they'd fire would describe a player nobody is
// watching. Room sync therefore stands down for the duration of the cast
// session rather than broadcasting garbage; a real cast-aware watch party is
// separate work.
function setupRoomPlaybackHooks() {
  if (roomHooksInitialized) return;
  roomHooksInitialized = true;
  const player = getPlayer();

  player.addEventListener("play", () => {
    if (isCasting) return;
    if (!roomConn || applyingRemoteState || shouldSuppressEcho("play", true))
      return;
    roomConn.sendState({ playing: true, positionSeconds: player.currentTime });
  });
  player.addEventListener("pause", () => {
    if (isCasting) return;
    if (!roomConn || applyingRemoteState || shouldSuppressEcho("play", false))
      return;
    roomConn.sendState({ playing: false, positionSeconds: player.currentTime });
  });
  player.addEventListener("seeked", () => {
    if (isCasting) return;
    if (
      !roomConn ||
      applyingRemoteState ||
      shouldSuppressEcho("seek", player.currentTime)
    )
      return;
    roomConn.sendState({
      positionSeconds: player.currentTime,
      playing: !player.paused,
    });
  });
}

// Broadcast that *this* client just switched to a new episode/server. Called
// from playServerAt() for every successful stream resolution; suppressed
// while applyingRemoteState so we don't echo back a change we just received.
function broadcastRoomContentChange() {
  if (!roomConn || applyingRemoteState) return;
  const showId = new URLSearchParams(window.location.search).get("id") || "";
  const provider = localStorage.getItem(providerStorageKey) || "";
  const isEpisode = currentPlaybackType === "episode";
  roomConn.sendState({
    provider,
    showId,
    episodeId: isEpisode ? currentPlaybackId : null,
    episodeLabel: isEpisode ? currentEpisodeLabel : null,
    contentType: currentPlaybackType,
    playing: true,
    positionSeconds: 0,
  });
}

// Applies an incoming (or the room's initial) shared state: navigates to the
// right episode/server if needed, then syncs currentTime/play-pause once the
// new stream is ready.
async function applyRoomState(state) {
  if (!state) return;
  roomState = state;
  const isEpisode = state.contentType === "episode";
  const targetId = isEpisode ? state.episodeId : state.showId;
  const sameContent =
    targetId &&
    currentPlaybackId === targetId &&
    currentPlaybackType === state.contentType;

  const syncTimeAndPlayback = () => {
    const player = getPlayer();
    armEchoGuard(state.positionSeconds, state.playing);
    if (
      Number.isFinite(state.positionSeconds) &&
      Math.abs(player.currentTime - state.positionSeconds) > 2
    ) {
      player.currentTime = state.positionSeconds;
    }
    if (state.playing && player.paused) player.play().catch(() => {});
    else if (!state.playing && !player.paused) player.pause();
  };

  if (sameContent) {
    applyingRemoteState = true;
    syncTimeAndPlayback();
    setTimeout(() => {
      applyingRemoteState = false;
    }, 400);
    return;
  }

  if (!targetId) return;
  syncProviderFromRoom(state.provider);
  applyingRemoteState = true;
  try {
    if (isEpisode) {
      const idx = currentEpisodesList.findIndex((e) => e.id === targetId);
      if (idx === -1) return; // not this show / episode list not loaded yet
      await selectEpisodeByData(
        currentEpisodesList[idx],
        idx,
        episodeButton(targetId),
      );
    } else {
      await loadServersForId(state.showId, "movie");
      if (currentServers.length) {
        const first = document.querySelectorAll("#serversGrid .srvbtn")[0];
        if (first) {
          first.classList.add("active");
          await playServerAt(0, first);
        }
      }
    }
    const player = getPlayer();
    player.addEventListener("loadedmetadata", syncTimeAndPlayback, {
      once: true,
    });
  } finally {
    setTimeout(() => {
      applyingRemoteState = false;
    }, 600);
  }
}

function renderRoomPanel() {
  const body = document.getElementById("roomPanelBody");
  const btn = document.getElementById("roomBtn");
  if (!body) return;

  if (!roomCode) {
    btn?.classList.remove("active");
    body.innerHTML = `
      <p class="room-hint">Start a watch party to watch this title in sync with friends — everyone's play, pause, seek and episode changes stay in step.</p>
      <button class="room-btn" id="roomStartBtn">Start Watch Party</button>
      <p class="room-hint">Got a code? <a href="/rooms" style="color:var(--red)">Join a watch party</a>.</p>
    `;
    const startBtn = document.getElementById("roomStartBtn");
    if (startBtn) startBtn.onclick = startWatchParty;
    return;
  }

  btn?.classList.add("active");
  const isOwner = Boolean(
    roomSelfId && roomOwnerId && roomSelfId === roomOwnerId,
  );
  const invite = roomInviteUrl(
    roomCode,
    new URLSearchParams(window.location.search).get("id") || "",
    localStorage.getItem(providerStorageKey) || "",
  );
  body.innerHTML = `
    <div class="room-code-row">
      <span class="room-code">${escapeHtml(roomCode)}</span>
      <button class="room-btn room-copy-btn" id="roomCopyCodeBtn">Copy</button>
    </div>
    <button class="room-btn outline" id="roomCopyLinkBtn">Copy invite link</button>
    <div class="room-members">
      <div class="room-members-title">${roomMembers.length} watching</div>
      ${roomMembers
        .map(
          (m) => `
        <div class="room-member">
          <div class="room-member-avatar">${
            m.avatar_url
              ? `<img src="${escapeHtml(m.avatar_url)}">`
              : escapeHtml(
                  (m.display_name || "?").trim().charAt(0).toUpperCase() || "?",
                )
          }</div>
          <span class="room-member-name">${escapeHtml(m.display_name || "Member")}${m.id === roomSelfId ? " (you)" : ""}</span>
          ${m.is_owner ? `<span class="room-member-crown" title="Host">${ICON_CROWN}</span>` : ""}
        </div>`,
        )
        .join("")}
    </div>
    <button class="room-btn outline" id="roomLeaveBtn" style="margin-top:18px;">Leave Watch Party</button>
    ${isOwner ? '<button class="room-btn danger" id="roomCloseBtn">Close Watch Party</button>' : ""}
  `;
  document.getElementById("roomCopyCodeBtn").onclick = () => {
    navigator.clipboard?.writeText(roomCode);
    showRoomToast("Code copied.");
  };
  document.getElementById("roomCopyLinkBtn").onclick = () => {
    navigator.clipboard?.writeText(invite);
    showRoomToast("Invite link copied.");
  };
  document.getElementById("roomLeaveBtn").onclick = leaveWatchParty;
  if (isOwner)
    document.getElementById("roomCloseBtn").onclick = closeWatchParty;
}

function setRoomUrlParam(code) {
  const url = new URL(window.location.href);
  if (code) url.searchParams.set("room", code);
  else url.searchParams.delete("room");
  history.replaceState(null, "", url);
}

function connectRoom() {
  roomConn?.close();
  roomConn = new RoomConnection(roomCode);
  roomConn.on("state", (msg) => {
    roomMembers = msg.members;
    roomOwnerId = msg.ownerId;
    renderRoomPanel();
    applyRoomState(msg.state);
  });
  roomConn.on("state_update", (msg) => {
    applyRoomState(msg.state);
  });
  roomConn.on("presence", (msg) => {
    roomMembers = msg.members;
    roomOwnerId = msg.ownerId;
    renderRoomPanel();
  });
  roomConn.on("closed", () => {
    showRoomToast("The watch party was closed.");
    roomConn = null;
    roomCode = null;
    roomState = null;
    roomMembers = [];
    roomOwnerId = null;
    clearInterval(roomHeartbeatTimer);
    setRoomUrlParam(null);
    renderRoomPanel();
  });
  roomConn.on("error", (msg) => showRoomToast(msg?.message || "Room error."));
  roomConn.connect();
  setupRoomPlaybackHooks();

  clearInterval(roomHeartbeatTimer);
  roomHeartbeatTimer = setInterval(() => {
    const player = getPlayer();
    if (roomConn && !player.paused && !applyingRemoteState) {
      roomConn.sendState({
        playing: true,
        positionSeconds: player.currentTime,
      });
    }
  }, 6000);
}

async function startWatchParty() {
  const showId = new URLSearchParams(window.location.search).get("id");
  const provider = localStorage.getItem(providerStorageKey) || "";
  if (!showId) return;
  try {
    const room = await api("/api/rooms", {
      method: "POST",
      body: {
        provider,
        show_id: showId,
        episode_id:
          currentPlaybackType === "episode" ? currentPlaybackId : null,
        episode_label:
          currentPlaybackType === "episode" ? currentEpisodeLabel : null,
        content_type: currentPlaybackType === "episode" ? "episode" : "movie",
      },
    });
    roomCode = room.code;
    roomOwnerId = room.ownerId;
    roomMembers = room.members;
    roomState = room.state;
    roomSelfId = room.ownerId; // we just created it — no need to ask who we are
    setRoomUrlParam(roomCode);
    connectRoom();
    renderRoomPanel();
    document.getElementById("roomPanel")?.classList.add("show");
    showRoomToast("Watch party started — share the code!");
  } catch (err) {
    showRoomToast("Could not start watch party: " + err.message);
  }
}

async function leaveWatchParty() {
  if (!roomCode) return;
  const code = roomCode;
  try {
    await api(`/api/rooms/${encodeURIComponent(code)}/leave`, {
      method: "POST",
    });
  } catch {
    /* best-effort */
  }
  roomConn?.close();
  roomConn = null;
  roomCode = null;
  roomState = null;
  roomMembers = [];
  roomOwnerId = null;
  clearInterval(roomHeartbeatTimer);
  setRoomUrlParam(null);
  renderRoomPanel();
  showRoomToast("Left the watch party.");
}

// Owner-only: ends the party for everyone (deletes the room), as opposed to
// leaveWatchParty() which just removes the current user and hands ownership
// on to whoever's left.
async function closeWatchParty() {
  if (!roomCode) return;
  if (!window.confirm("Close this watch party for everyone?")) return;
  const code = roomCode;
  try {
    await api(`/api/rooms/${encodeURIComponent(code)}`, { method: "DELETE" });
  } catch (err) {
    showRoomToast("Could not close watch party: " + err.message);
    return;
  }
  roomConn?.close();
  roomConn = null;
  roomCode = null;
  roomState = null;
  roomMembers = [];
  roomOwnerId = null;
  clearInterval(roomHeartbeatTimer);
  setRoomUrlParam(null);
  renderRoomPanel();
  showRoomToast("Watch party closed.");
}

// Joins (or reconnects to) the room named by ?room=CODE, if present. Called
// early in loadWatchPage() so deepLinkEpisodeId/deepLinkTimeSeconds can be
// primed from the room's shared state before the normal episode/server
// auto-selection runs — avoiding a flash of the wrong episode.
async function initRoomJoin() {
  const code = new URLSearchParams(window.location.search).get("room");
  if (!code) return;

  if (!getAccessToken()) {
    showRoomToast("Log in to join the watch party.");
    return;
  }

  try {
    let room = await api(`/api/rooms/${encodeURIComponent(code)}`).catch(
      () => null,
    );
    if (!room || !room.isMember) {
      room = await api(`/api/rooms/${encodeURIComponent(code)}/join`, {
        method: "POST",
      });
    }

    roomCode = room.code;
    roomOwnerId = room.ownerId;
    roomMembers = room.members;
    roomState = room.state;
    syncProviderFromRoom(room.state.provider);
    ensureRoomSelfId().then(() => renderRoomPanel());

    if (room.state.contentType === "episode" && room.state.episodeId) {
      deepLinkEpisodeId = room.state.episodeId;
    }
    deepLinkTimeSeconds = room.state.positionSeconds || 0;
    pendingRoomPause = !room.state.playing;

    // Guard the initial auto-select/autoplay below so it doesn't re-broadcast
    // the state we just received as if it were a local change; released at
    // the end of loadWatchPage() once that initial load has settled.
    applyingRemoteState = true;

    connectRoom();
    renderRoomPanel();
  } catch (err) {
    showRoomToast(
      "Could not join watch party: " + (err?.message || "room not found"),
    );
  }
}

// ── MAIN LOAD ──
async function loadWatchPage() {
  const params = new URLSearchParams(window.location.search);
  const showId = params.get("id");
  deepLinkEpisodeId = params.get("ep") || null;
  const tParam = params.get("t");
  deepLinkTimeSeconds =
    tParam !== null && !isNaN(parseInt(tParam, 10))
      ? parseInt(tParam, 10)
      : null;
  deepLinkTimeConsumed = false;

  // Before anything reads the stored provider — and before initRoomJoin(),
  // whose syncProviderFromRoom() must be allowed to override it.
  await ensureActiveProvider();

  // May override deepLinkEpisodeId/deepLinkTimeSeconds above with the room's
  // shared state, and sets applyingRemoteState so the auto-select below
  // doesn't broadcast itself back to the room as a "local" change.
  await initRoomJoin();

  if (!showId) {
    document.getElementById("contentTitle").textContent = "No content selected";
    document.getElementById("errorMsg").innerHTML =
      '<div class="error-msg">Please select a title from the catalog.</div>';
    showPlayerMessage("No content selected");
    return;
  }

  // Update back button
  document.getElementById("backBtn").href =
    `/details?id=${encodeURIComponent(showId)}`;

  try {
    const res = await fetchPublic(
      appendProvider(`/api/shows/${encodeURIComponent(showId)}`),
    );
    const data = await res.json();
    if (res.status === 403) {
      throw new Error(
        'This title is flagged 18+. Enable "adult_content" on your account to watch it.',
      );
    }
    if (!res.ok || !data.data) throw new Error("Show not found");

    currentShowData = data.data;
    document.title = `${currentShowData.title || "Watch"} — Streamio`;
    document.getElementById("contentTitle").textContent =
      currentShowData.title || "Untitled";

    renderShowHeader(currentShowData);

    if (currentShowData.seasons?.length > 0) {
      await renderEpisodes();
    } else {
      document.getElementById("episodesSection").style.display = "none";
      showPlayerMessage("Select a server below");
      await loadServersForId(showId, "movie");
      if (currentServers.length) {
        const first = document.querySelectorAll("#serversGrid .srvbtn")[0];
        if (first) {
          first.classList.add("active");
          await playServerAt(0, first);
        }
      }
    }
  } catch (err) {
    document.getElementById("errorMsg").innerHTML =
      `<div class="error-msg">Error: ${err.message}</div>`;
    showPlayerMessage("Error loading content");
  } finally {
    // Release the join-time broadcast guard now that the initial
    // episode/server auto-selection (if any) has settled.
    if (roomCode) applyingRemoteState = false;
  }
}

// Fetches every episode's watch-progress row for the current show in one
// call, so episode buttons can be marked watched/in-progress without one
// request per episode. Guests / errors just leave every button unmarked.
async function loadEpisodeProgressMap() {
  episodeProgressMap = new Map();
  if (!getAccessToken()) return;
  try {
    const showId = new URLSearchParams(window.location.search).get("id");
    const provider = localStorage.getItem(providerStorageKey) || "";
    if (!showId || !provider) return;
    const rows = await api(
      `/api/account/history/progress/${encodeURIComponent(provider)}/${encodeURIComponent(showId)}`,
    );
    if (Array.isArray(rows)) {
      rows.forEach((row) => episodeProgressMap.set(row.episode_id, row));
    }
  } catch (e) {
    console.warn("[episodeProgress] failed to load", e);
  }
}

// "completed" (fully watched), "in-progress" (started, not finished) or ""
// (never watched) — kept in sync with the same >10s threshold resumeProgress
// uses to decide whether a resume prompt is worth showing.
function episodeStateClass(episodeId) {
  const entry = episodeProgressMap.get(episodeId);
  if (!entry) return "";
  if (entry.completed) return "completed";
  if (entry.progress_seconds > 10) return "in-progress";
  return "";
}

function applyEpisodeButtonProgressBar(episodeId) {
  const entry = episodeProgressMap.get(episodeId);
  const btn = document.querySelector(
    `#episodesGrid .epbtn[data-episode-id="${CSS.escape(episodeId)}"]`,
  );
  if (!btn) return;
  const bar = btn.querySelector(".epbtn-progress");
  if (!bar) return;
  if (entry && !entry.completed && entry.duration_seconds > 0) {
    const pct = Math.min(
      100,
      Math.round((entry.progress_seconds / entry.duration_seconds) * 100),
    );
    bar.style.width = `${pct}%`;
  } else {
    bar.style.width = "";
  }
}

// Live-updates one episode button's watched state right after a progress
// save, so finishing an episode marks it complete without a page reload.
function markEpisodeButtonWatched(
  episodeId,
  completed,
  progressSeconds,
  durationSeconds,
) {
  episodeProgressMap.set(episodeId, {
    episode_id: episodeId,
    completed,
    progress_seconds: progressSeconds,
    duration_seconds: durationSeconds,
  });
  const btn = document.querySelector(
    `#episodesGrid .epbtn[data-episode-id="${CSS.escape(episodeId)}"]`,
  );
  if (btn) {
    btn.classList.remove("completed", "in-progress");
    const cls = episodeStateClass(episodeId);
    if (cls) btn.classList.add(cls);
  }
  applyEpisodeButtonProgressBar(episodeId);
}

/**
 * Title block and meta strip for the show being watched.
 *
 * The facts come from the shared `showFacts` list (public/scripts/show-meta.js),
 * so this page and the details page never drift apart on what a title has or
 * how a date is formatted. The old hand-written list read
 * `currentShowData.releaseDate`, a field that does not exist on the model —
 * the "Released" chip therefore never rendered once.
 */
function renderShowHeader(show) {
  const d = show.details || {};

  const badges = [
    show.providerName
      ? `<span class="content-badge cb-red">${escapeHtml(providerLabel(show.providerName))}</span>`
      : "",
    show.rating
      ? `<span class="content-badge cb-yellow">★ ${escapeHtml(String(show.rating))}${
          d.stats?.votes ? escapeHtml(` (${formatNumber(d.stats.votes)})`) : ""
        }</span>`
      : "",
    d.contentType
      ? `<span class="content-badge cb-outline">${escapeHtml(d.contentType)}</span>`
      : "",
    show.quality
      ? `<span class="content-badge cb-outline">${escapeHtml(show.quality)}</span>`
      : "",
    d.status
      ? `<span class="content-badge cb-outline">${escapeHtml(d.status)}</span>`
      : "",
    ageLabel(d.ageRating)
      ? `<span class="content-badge cb-red">${escapeHtml(ageLabel(d.ageRating))}</span>`
      : "",
    d.audio?.dubIta ? `<span class="content-badge cb-outline">ITA</span>` : "",
    d.audio?.subIta
      ? `<span class="content-badge cb-outline">SUB ITA</span>`
      : "",
  ]
    .filter(Boolean)
    .join("");
  document.getElementById("contentBadges").innerHTML = badges;

  // Original/alternative titles, where they differ from the one displayed.
  const alternatives = [d.originalTitle, ...(d.alternativeTitles || [])].filter(
    (t) => t && t !== show.title,
  );
  const subtitle = document.getElementById("contentSubtitle");
  subtitle.textContent = [...new Set(alternatives)].join(" · ");
  subtitle.hidden = !subtitle.textContent;

  const overview = document.getElementById("contentOverview");
  overview.textContent = show.overview || "";
  overview.hidden = !overview.textContent;

  const links = (d.externalLinks || []).filter(
    (l) => l && l.url && /^https?:\/\//.test(l.url),
  );
  const linksEl = document.getElementById("contentLinks");
  linksEl.innerHTML = links
    .map(
      (l) =>
        `<a class="content-link" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
          l.label || l.url,
        )}</a>`,
    )
    .join("");
  linksEl.hidden = !links.length;

  const chips = [
    show.rating ? { l: "Voto", v: `★ ${show.rating}` } : null,
    show.providerName
      ? { l: "Provider", v: providerLabel(show.providerName) }
      : null,
    ...showFacts(show).map((f) => ({ l: f.label, v: f.value })),
    show.genres?.length
      ? {
          l: "Generi",
          v: show.genres
            .map((g) => g.name)
            .slice(0, 3)
            .join(", "),
        }
      : null,
    ...Object.entries(STAT_LABELS)
      .map(([key, label]) => {
        const value = formatNumber(d.stats?.[key]);
        return value ? { l: label, v: value } : null;
      })
      .filter(Boolean),
  ].filter(Boolean);

  document.getElementById("contentMeta").innerHTML = chips
    .map(
      (c) => `
        <div class="meta-chip">
        <div class="mc-label">${escapeHtml(c.l)}</div>
        <div class="mc-val">${escapeHtml(String(c.v))}</div>
        </div>
    `,
    )
    .join("");
}

// ── Episodi: dati completi, non solo l'etichetta ──────────────
// The episodes endpoint returns a full `Episode` (core/models/Episode.ts):
// title, thumbnail, plot, runtime, quality, dub/sub flags. The grid used to
// keep four fields and print "S1E1"; these helpers keep the rest so the card
// and the now-playing panel have something to show.

/** API episode → the shape the grid, autoplay and the cast payload all read. */
function toEpisodeCard(ep, season) {
  return {
    id: ep.id || `s${season.number}-e${ep.number}`,
    seasonId: season.id,
    title: ep.title || "Episode",
    seasonNum: season.number || "?",
    episodeNum: ep.number || "?",
    poster: ep.poster || null,
    overview: ep.overview || null,
    runtime: ep.runtime || null,
    quality: ep.quality || null,
    dubIta: ep.dubIta ?? null,
    subIta: ep.subIta ?? null,
    released: ep.released || null,
  };
}

/**
 * A title worth printing next to the number. Providers that have no per-episode
 * title fall back to the number itself ("1") or a generic "Episode", and
 * repeating "S1E1 · 1" reads as a bug — those collapse to nothing instead.
 */
function episodeTitle(ep) {
  const title = (ep.title || "").trim();
  if (!title) return "";
  if (title === "Episode") return "";
  if (String(ep.episodeNum) === title) return "";
  if (
    new RegExp(`^(episodio|episode|ep\\\\.?)\\\\s*${ep.episodeNum}$`, "i").test(
      title,
    )
  )
    return "";
  return title;
}

/** Per-episode facts, which can differ from the show's (a late dub, one SD episode). */
function episodeBadges(ep) {
  return [
    ep.runtime ? `${ep.runtime} min` : "",
    ep.quality || "",
    ep.dubIta ? "ITA" : "",
    ep.subIta ? "SUB ITA" : "",
  ].filter(Boolean);
}

/**
 * One episode card.
 *
 * Deliberately still a `button.epbtn` carrying `data-episode-id` and an
 * `.epbtn-progress` child: selection, the watched/in-progress classes, the
 * progress bar and autoplay-next all address episodes through those, and
 * renaming them here would quietly break every one of them.
 */
function renderEpisodeCard(ep) {
  const label = `S${ep.seasonNum}E${ep.episodeNum}`;
  const title = episodeTitle(ep);
  const badges = episodeBadges(ep);

  const thumb = ep.poster
    ? `<img class="epcard-thumb-img" src="${escapeHtml(ep.poster)}" alt="" loading="lazy" onerror="this.remove()">`
    : `<span class="epcard-thumb-num">${escapeHtml(String(ep.episodeNum))}</span>`;

  return `
    <button class="epbtn epcard ${episodeStateClass(ep.id)}"
            data-episode-id="${escapeHtml(ep.id)}"
            onclick="selectEpisode(this, '${encodeURIComponent(ep.id)}', '${escapeHtml(label)}')">
      <span class="epcard-thumb">${thumb}</span>
      <span class="epcard-body">
        <span class="epbtn-label">${escapeHtml(label)}</span>
        ${title ? `<span class="epcard-title">${escapeHtml(title)}</span>` : ""}
        ${badges.length ? `<span class="epcard-badges">${escapeHtml(badges.join(" · "))}</span>` : ""}
        ${ep.overview ? `<span class="epcard-overview">${escapeHtml(ep.overview)}</span>` : ""}
      </span>
      <span class="epbtn-progress"></span>
    </button>`;
}

/**
 * Compact form of the same button: the number alone. Keeps `epbtn`,
 * `data-episode-id` and `.epbtn-progress` so selection, progress and
 * autoplay-next work identically in both densities — the details are still
 * one click away in the now-playing panel, and the card view is a toggle.
 */
function renderEpisodeChip(ep) {
  const label = `S${ep.seasonNum}E${ep.episodeNum}`;
  const title = episodeTitle(ep);

  return `
    <button class="epbtn epchip ${episodeStateClass(ep.id)}"
            data-episode-id="${escapeHtml(ep.id)}"
            title="${escapeHtml(title ? `${label} · ${title}` : label)}"
            onclick="selectEpisode(this, '${encodeURIComponent(ep.id)}', '${escapeHtml(label)}')">
      <span class="epbtn-label">${escapeHtml(String(ep.episodeNum))}</span>
      <span class="epbtn-progress"></span>
    </button>`;
}

/**
 * The "now playing" block above the grid — the selected episode's thumbnail,
 * title and plot, which the grid card can only show clipped.
 * Hidden entirely when the provider gives nothing beyond a number.
 */
function renderNowPlaying(ep) {
  const panel = document.getElementById("nowPlaying");
  if (!panel) return;

  if (!ep) {
    panel.hidden = true;
    return;
  }

  const title = episodeTitle(ep);
  const badges = episodeBadges(ep);

  // A bare number with no title, plot or thumbnail is already fully conveyed
  // by the highlighted card in the grid; a panel repeating it is noise.
  if (!title && !ep.overview && !ep.poster && !badges.length) {
    panel.hidden = true;
    return;
  }

  const thumb = document.getElementById("nowPlayingThumb");
  if (ep.poster) {
    thumb.src = ep.poster;
    thumb.hidden = false;
  } else {
    thumb.removeAttribute("src");
    thumb.hidden = true;
  }

  document.getElementById("nowPlayingLabel").textContent =
    `S${ep.seasonNum}E${ep.episodeNum}`;
  document.getElementById("nowPlayingTitle").textContent = title;
  document.getElementById("nowPlayingBadges").textContent = badges.join(" · ");
  document.getElementById("nowPlayingOverview").textContent = ep.overview || "";
  panel.hidden = false;
}

// ── Navigazione episodi ──────────────────────────────────────
// `currentEpisodesList` is always the complete list — autoplay-next, the room
// sync and the cast payload all index into it. What the nav changes is only
// which slice is *rendered*, which is why every DOM lookup goes through
// `episodeButton()` rather than a position.

// A show with more episodes than this is unusable as one flat list of rich
// cards, so it opens compact. The user's choice wins from then on.
const COMPACT_THRESHOLD = 60;

const episodeView = {
  /** Season id currently shown, or "all". */
  seasonId: "all",
  /** Free-text filter: an episode number, or words from the title. */
  query: "",
  /** Dense number grid instead of full cards. */
  compact: false,
};

/** The episodes the current season/filter selection puts on screen. */
function visibleEpisodes() {
  const query = episodeView.query.trim().toLowerCase();

  return currentEpisodesList.filter((ep) => {
    if (episodeView.seasonId !== "all" && ep.seasonId !== episodeView.seasonId)
      return false;
    if (!query) return true;

    // A bare number matches the episode number exactly, so typing "7" in a
    // 1000-episode show doesn't return every episode containing a 7.
    if (/^\d+$/.test(query)) {
      return (
        String(ep.episodeNum) === query ||
        `s${ep.seasonNum}e${ep.episodeNum}`.includes(query)
      );
    }

    return (
      (ep.title || "").toLowerCase().includes(query) ||
      `s${ep.seasonNum}e${ep.episodeNum}`.toLowerCase().includes(query)
    );
  });
}

/** Season/block tabs, plus "Tutti" — only worth showing for more than one. */
function renderSeasonTabs() {
  const container = document.getElementById("episodeSeasons");
  const seasons = currentShowData.seasons || [];

  if (seasons.length < 2) {
    container.innerHTML = "";
    return;
  }

  const counts = new Map();
  for (const ep of currentEpisodesList) {
    counts.set(ep.seasonId, (counts.get(ep.seasonId) || 0) + 1);
  }

  const tab = (id, label, count) => `
    <button type="button" class="season-tab ${episodeView.seasonId === id ? "active" : ""}"
            data-season-id="${escapeHtml(id)}">
      ${escapeHtml(label)}${count ? `<span class="season-tab-count">${count}</span>` : ""}
    </button>`;

  container.innerHTML = [
    tab("all", "Tutti", currentEpisodesList.length),
    ...seasons
      .filter((s) => counts.get(s.id))
      .map((s) =>
        tab(
          s.id,
          // Range-tab providers already label these "1-120"; real seasons
          // usually have no name at all.
          s.title || (s.number ? `Stagione ${s.number}` : "Episodi"),
          counts.get(s.id),
        ),
      ),
  ].join("");
}

/**
 * Renders the visible slice and restores the selection/progress state on it.
 * Called on every nav change, so it must be cheap enough for a 1000-episode
 * show — which is exactly why it renders a slice rather than everything.
 */
function renderEpisodeGrid() {
  const grid = document.getElementById("episodesGrid");
  const empty = document.getElementById("episodeEmpty");
  const episodes = visibleEpisodes();

  grid.className = episodeView.compact
    ? "episode-list compact"
    : "episode-list";
  grid.innerHTML = episodes
    .map((ep) =>
      episodeView.compact ? renderEpisodeChip(ep) : renderEpisodeCard(ep),
    )
    .join("");

  empty.hidden = episodes.length > 0;

  // The progress bars and the active highlight live on the buttons, so both
  // have to be re-applied to the freshly rendered ones.
  episodes.forEach((ep) => applyEpisodeButtonProgressBar(ep.id));

  const current = currentEpisodesList[currentEpisodeIndex];
  if (current) episodeButton(current.id)?.classList.add("active");

  renderSeasonTabs();

  const density = document.getElementById("episodeDensity");
  density.textContent = episodeView.compact ? "Dettagli" : "Compatta";
  density.setAttribute("aria-pressed", String(episodeView.compact));

  document.getElementById("episodeNav").hidden =
    currentEpisodesList.length < 2 &&
    (currentShowData.seasons || []).length < 2;
}

/**
 * Makes sure an episode is on screen before it is highlighted — autoplay-next
 * and a room sync can land on one the current season/filter hides, and a
 * selection nobody can see reads as the page having lost track.
 */
function revealEpisode(ep) {
  if (!ep || episodeButton(ep.id)) return;

  episodeView.query = "";
  const filter = document.getElementById("episodeFilter");
  if (filter) filter.value = "";

  if (episodeView.seasonId !== "all" && ep.seasonId !== episodeView.seasonId) {
    episodeView.seasonId = ep.seasonId;
  }

  renderEpisodeGrid();
}

function initEpisodeNav() {
  const nav = document.getElementById("episodeNav");
  if (!nav || nav.dataset.wired) return;
  nav.dataset.wired = "1";

  document.getElementById("episodeSeasons").addEventListener("click", (e) => {
    const tab = e.target.closest(".season-tab");
    if (!tab) return;
    episodeView.seasonId = tab.dataset.seasonId;
    renderEpisodeGrid();
  });

  document.getElementById("episodeFilter").addEventListener("input", (e) => {
    episodeView.query = e.target.value;
    // A query is meant to search the whole show, not the open season.
    if (episodeView.query.trim()) episodeView.seasonId = "all";
    renderEpisodeGrid();
  });

  document.getElementById("episodeDensity").addEventListener("click", () => {
    episodeView.compact = !episodeView.compact;
    renderEpisodeGrid();
  });
}

async function renderEpisodes() {
  if (!currentShowData.seasons) return;
  document.getElementById("episodesSection").style.display = "block";
  const grid = document.getElementById("episodesGrid");
  const episodes = [];
  showPlayerMessage("Loading episodes…");

  try {
    for (const season of currentShowData.seasons) {
      try {
        const res = await fetchPublic(
          appendProvider(
            `/api/seasons/${encodeURIComponent(season.id)}/episodes`,
          ),
        );
        const data = await res.json();
        if (res.ok && Array.isArray(data.data)) {
          // Providers return title, thumbnail, plot, runtime and quality per
          // episode (see core/models/Episode.ts). All of it used to be dropped
          // here, so the grid could only ever print "S1E1".
          data.data.forEach((ep) => episodes.push(toEpisodeCard(ep, season)));
        }
      } catch (e) {
        console.warn(e);
      }
    }

    // Fallback
    if (!episodes.length) {
      currentShowData.seasons.forEach((season) => {
        season.episodes?.forEach((ep) =>
          episodes.push(toEpisodeCard(ep, season)),
        );
      });
    }

    if (!episodes.length) {
      grid.innerHTML =
        '<p style="color:var(--muted);font-size:0.88rem;">No episodes available.</p>';
      showPlayerMessage("No episodes available");
      return;
    }

    currentEpisodesList = episodes;
    await loadEpisodeProgressMap();

    showPlayerMessage("Select an episode");
    initEpisodeNav();
    // Long runs open as a dense number grid; the cards are one click away.
    episodeView.compact = episodes.length > COMPACT_THRESHOLD;
    episodeView.seasonId = "all";
    episodeView.query = "";
    renderEpisodeGrid();

    let targetIndex = 0;
    if (deepLinkEpisodeId) {
      const idx = episodes.findIndex((e) => e.id === deepLinkEpisodeId);
      if (idx !== -1) targetIndex = idx;
    } else {
      // No episode specified: resume at the first one not marked completed,
      // rather than always restarting from S1E1.
      const idx = episodes.findIndex(
        (e) => !episodeProgressMap.get(e.id)?.completed,
      );
      if (idx !== -1) targetIndex = idx;
    }
    const targetEp = episodes[targetIndex];
    if (targetEp) {
      currentEpisodeIndex = targetIndex;
      // Resuming mid-run can land outside the open season, so scope the grid to
      // it before asking for its button.
      revealEpisode(targetEp);
      const targetBtn = episodeButton(targetEp.id);
      if (targetBtn) {
        targetBtn.classList.add("active");
        targetBtn.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      currentEpisodeLabel = `S${targetEp.seasonNum}E${targetEp.episodeNum}`;
      // This is the third place an episode becomes the current one (the other
      // two are a click and autoplay-next), and the only one that runs on load.
      renderNowPlaying(targetEp);
      await loadServersForId(targetEp.id, "episode");
      if (currentServers.length) {
        const firstSrv = document.querySelectorAll("#serversGrid .srvbtn")[0];
        if (firstSrv) {
          firstSrv.classList.add("active");
          await playServerAt(0, firstSrv);
        }
      }
    }
  } catch (err) {
    grid.innerHTML =
      '<p style="color:#ff6b6b;font-size:0.88rem;">Error loading episodes</p>';
    showPlayerMessage("Error loading episodes");
  }
}

async function selectEpisode(btn, episodeId, label) {
  const id = decodeURIComponent(episodeId);
  currentPlaybackId = id;
  currentPlaybackType = "episode";
  currentEpisodeLabel = label;

  const idx = currentEpisodesList.findIndex((e) => e.id === id);
  if (idx !== -1) currentEpisodeIndex = idx;
  renderNowPlaying(currentEpisodesList[currentEpisodeIndex]);

  showPlayerMessage(`Loading ${label}…`);
  document
    .querySelectorAll("#episodesGrid .epbtn")
    .forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  btn.blur();
  await loadServersForId(id, "episode");
  if (currentServers.length) {
    const first = document.querySelectorAll("#serversGrid .srvbtn")[0];
    if (first) {
      first.classList.add("active");
      await playServerAt(0, first);
    }
  }
}

async function loadServersForId(contentId, contentType) {
  currentPlaybackId = contentId;
  currentPlaybackType = contentType;
  try {
    const res = await fetchPublic(
      appendProvider(
        `/api/episodes/${encodeURIComponent(contentId)}/servers?contentType=${contentType}`,
      ),
    );
    const data = await res.json();
    if (!res.ok || !data.data) throw new Error("No servers");
    currentServers = Array.isArray(data.data) ? data.data : [];
    const grid = document.getElementById("serversGrid");
    if (!currentServers.length) {
      grid.innerHTML =
        '<p style="color:var(--muted);font-size:0.88rem;">No servers available.</p>';
      showPlayerMessage("No servers available");
      return;
    }
    showPlayerMessage("Select a server to play");
    grid.innerHTML = currentServers
      .map(
        (s, i) => `
        <button class="srvbtn" onclick="playServer(this, ${i})">
        ${s.name || s.server || "Server " + (i + 1)}
        </button>
    `,
      )
      .join("");
  } catch (err) {
    document.getElementById("serversGrid").innerHTML =
      `<p style="color:#ff6b6b;font-size:0.88rem;">Error: ${err.message}</p>`;
    showPlayerMessage("Error loading servers");
  }
}

async function playServerAt(index, btn = null, fresh = false) {
  const server = currentServers[index];
  if (!server) return;
  // A retry re-plays the same server with `fresh: true`; any other call is a
  // fresh user/autoplay action and should start the retry budget over.
  if (!fresh) streamRetryCount = 0;
  // Remembered so the receiver can pick the same server when it resolves the
  // next episode (or re-resolves an expired stream) on its own.
  currentServerIndex = index;
  currentServerName = server.name || server.server || "";
  document
    .querySelectorAll("#serversGrid .srvbtn")
    .forEach((b) => b.classList.remove("active"));
  if (btn) {
    btn.classList.add("active");
    btn.blur();
  }
  showPlayerMessage(
    `Resolving stream from ${server.name || server.server || "server"}…`,
  );
  try {
    const freshParam = fresh ? "&fresh=1" : "";
    const res = await fetchPublic(
      appendProvider(
        `/api/episodes/${encodeURIComponent(currentPlaybackId)}/video?contentType=${currentPlaybackType}${freshParam}`,
      ),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server }),
      },
    );
    const payload = await res.json();
    if (!res.ok || !payload.data)
      throw new Error(payload.error || `HTTP ${res.status}`);
    playResolvedStream(payload.data);
    broadcastRoomContentChange();
  } catch (err) {
    showPlayerMessage(`Error: ${err.message}`);
  }
}

/**
 * Re-resolves the current server bypassing the cached URL and swaps hls.js
 * onto the new source. Used when playback fatally errors — a fresh resolve
 * can land on a working stream even when the cached one didn't.
 */
function retryCurrentStream() {
  if (streamRetryCount >= MAX_STREAM_RETRIES) {
    showPlayerMessage("Stream unavailable after several attempts");
    return;
  }
  streamRetryCount++;
  const delay = Math.min(1000 * 2 ** (streamRetryCount - 1), 8000);
  showPlayerMessage(
    `Stream failed, retrying (${streamRetryCount}/${MAX_STREAM_RETRIES})…`,
  );
  setTimeout(() => {
    playServerAt(currentServerIndex, null, true);
  }, delay);
}

async function playServer(btn, index) {
  await playServerAt(index, btn);
}

// Expose to global scope for inline onclick handlers
window.selectEpisode = selectEpisode;
window.playServer = playServer;
window.downloadVideo = downloadVideo;
window.closeDownloadToast = closeDownloadToast;
window.closeShortcuts = closeShortcuts;

document.getElementById("roomBtn").onclick = () => {
  const panel = document.getElementById("roomPanel");
  panel.classList.toggle("show");
  if (panel.classList.contains("show")) renderRoomPanel();
};
document.getElementById("roomPanelClose").onclick = () => {
  document.getElementById("roomPanel").classList.remove("show");
};
renderRoomPanel();
setupRoomPlaybackHooks();

// Playback of an 18+ title depends on the viewer's preference, so the server
// has to know who is asking before the first content request goes out.
await ensureSessionQuietly();

loadWatchPage();
