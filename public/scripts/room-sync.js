/**
 * room-sync.js — WebSocket client for watch-party rooms.
 *
 * Talks to the /ws/rooms/:code endpoint set up in server.ts
 * (services/room-socket.service.ts on the server side). Auth token is
 * passed as a query param since the WebSocket constructor can't set
 * custom headers.
 */
import { getAccessToken } from "/scripts/auth.js";

export class RoomConnection {
  constructor(code) {
    this.code = code.toUpperCase();
    this.ws = null;
    this.listeners = { state: [], state_update: [], presence: [], closed: [], error: [], open: [] };
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._manuallyClosed = false;
  }

  on(event, cb) {
    (this.listeners[event] ||= []).push(cb);
    return this;
  }

  _emit(event, payload) {
    for (const cb of this.listeners[event] || []) cb(payload);
  }

  connect() {
    this._manuallyClosed = false;
    const token = getAccessToken();
    if (!token) {
      this._emit("error", { message: "Not authenticated" });
      return this;
    }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws/rooms/${encodeURIComponent(this.code)}?token=${encodeURIComponent(token)}`;

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this._reconnectAttempts = 0;
      this._emit("open");
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg?.type) this._emit(msg.type, msg);
    };
    ws.onclose = () => {
      if (this._manuallyClosed) return;
      this._scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose fires right after; reconnect handled there */
    };

    return this;
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    const delay = Math.min(1000 * 2 ** this._reconnectAttempts, 15000);
    this._reconnectAttempts++;
    this._reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** payload: any subset of { provider, showId, episodeId, episodeLabel, contentType, playing, positionSeconds } */
  sendState(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "state", payload }));
    }
  }

  close() {
    this._manuallyClosed = true;
    clearTimeout(this._reconnectTimer);
    this.ws?.close();
  }
}

export function roomInviteUrl(code, showId, provider) {
  const params = new URLSearchParams({ id: showId, room: code });
  if (provider) params.set("provider", provider);
  return `${location.origin}/watch?${params.toString()}`;
}
