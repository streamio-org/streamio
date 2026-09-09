import { api, getAccessToken, getSelfId, escapeHtml } from "/scripts/auth.js";
import { ICON_CROWN } from "/scripts/icons.js";

function watchUrl(room) {
  const params = new URLSearchParams({ id: room.state.showId, room: room.code });
  if (room.state.provider) params.set("provider", room.state.provider);
  return `/watch?${params.toString()}`;
}

async function titleFor(room) {
  try {
    const res = await fetch(
      `/api/shows/${encodeURIComponent(room.state.showId)}?provider=${encodeURIComponent(room.state.provider)}`,
    );
    const data = await res.json();
    return data?.data?.title || room.state.showId;
  } catch {
    return room.state.showId;
  }
}

async function loadMyRooms() {
  const list = document.getElementById("myRoomsList");
  if (!getAccessToken()) {
    list.innerHTML = '<div class="empty">Log in to see your watch parties.</div>';
    return;
  }

  try {
    const rooms = await api("/api/rooms/mine");
    if (!rooms.length) {
      list.innerHTML = '<div class="empty">No active watch parties yet.</div>';
      return;
    }

    const [titles, selfId] = await Promise.all([Promise.all(rooms.map(titleFor)), getSelfId()]);

    list.innerHTML = rooms
      .map((room, i) => {
        const sub =
          room.state.contentType === "episode" && room.state.episodeLabel
            ? `${room.state.episodeLabel} · ${room.members.length} watching`
            : `${room.members.length} watching`;
        const isOwner = selfId && room.ownerId === selfId;
        return `
          <div class="room-item">
            <a class="room-item-link" href="${watchUrl(room)}">
              <span class="room-item-code">${room.code}</span>
              <span class="room-item-info">
                <div class="room-item-title">${escapeHtml(titles[i])}${isOwner ? ` <span class="room-item-crown" title="Host">${ICON_CROWN}</span>` : ""}</div>
                <div class="room-item-sub">${escapeHtml(sub)}</div>
              </span>
            </a>
            ${isOwner ? `<button class="room-item-close" data-code="${escapeHtml(room.code)}" title="Close watch party">✕</button>` : ""}
          </div>`;
      })
      .join("");

    list.querySelectorAll(".room-item-close").forEach((btn) => {
      btn.addEventListener("click", () => closeRoom(btn.dataset.code));
    });
  } catch (err) {
    list.innerHTML = `<div class="empty">Could not load watch parties: ${escapeHtml(err.message)}</div>`;
  }
}

async function closeRoom(code) {
  if (!window.confirm("Close this watch party for everyone?")) return;
  try {
    await api(`/api/rooms/${encodeURIComponent(code)}`, { method: "DELETE" });
    loadMyRooms();
  } catch (err) {
    alert(`Could not close watch party: ${err.message}`);
  }
}

async function joinByCode() {
  const input = document.getElementById("codeInput");
  const errorEl = document.getElementById("joinError");
  const btn = document.getElementById("joinBtn");
  const code = input.value.trim().toUpperCase();
  errorEl.textContent = "";

  if (!code) return;
  if (!getAccessToken()) {
    errorEl.textContent = "Log in first to join a watch party.";
    return;
  }

  btn.disabled = true;
  try {
    const room = await api(`/api/rooms/${encodeURIComponent(code)}/join`, { method: "POST" });
    window.location.href = watchUrl(room);
  } catch (err) {
    errorEl.textContent = err.message === "Room not found." ? "No watch party with that code." : err.message;
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("joinBtn").addEventListener("click", joinByCode);
document.getElementById("codeInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinByCode();
});
document.getElementById("codeInput").addEventListener("input", (e) => {
  e.target.value = e.target.value.toUpperCase();
});

loadMyRooms();
