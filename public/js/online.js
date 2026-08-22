/**
 * BLOCKS — オンライン対戦の通信
 *
 * 部屋の作成と参加だけ HTTP で行い、対局中は Durable Object の
 * Hibernation WebSocket から状態を受け取る。
 */

const ENDPOINT = '/api/room';

async function request(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    const error = new Error('通信できませんでした。電波の状況を確かめてください');
    error.offline = true;
    throw error;
  }

  let payload = null;
  try { payload = await response.json(); } catch { /* ステータスだけで判断する */ }
  if (!response.ok) {
    const error = new Error((payload && payload.error) || '通信に失敗しました');
    error.status = response.status;
    throw error;
  }
  return payload;
}

const post = (action, body) =>
  request(`${ENDPOINT}?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

export const createRoom = (seats) => post('create', { seats });
export const joinRoom = (code) => post('join', { code });

const terminalClose = (code) => code >= 4000 && code < 5000;

export class RoomSocket {
  #ws = null;
  #retry = 0;
  #timer = null;
  #keepalive = null;
  #closed = false;

  constructor({ code, token, onState, onChat, onError, onClosed }) {
    this.code = code;
    this.token = token;
    this.onState = onState;
    this.onChat = onChat;
    this.onError = onError;
    this.onClosed = onClosed;
    this.onVisibility = () => {
      if (document.visibilityState === 'visible' && !this.isOpen) this.#connect(true);
    };
    this.onOnline = () => {
      if (!this.isOpen) this.#connect(true);
    };
  }

  open() {
    if (this.#closed) return;
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('online', this.onOnline);
    this.#connect(true);
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    clearInterval(this.#keepalive);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('online', this.onOnline);
    this.#ws?.close();
    this.#ws = null;
  }

  send(message) {
    if (!this.isOpen) return false;
    this.#ws.send(typeof message === 'string' ? message : JSON.stringify(message));
    return true;
  }

  get isOpen() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  #connect(immediate = false) {
    if (this.#closed || this.#ws?.readyState === WebSocket.OPEN
      || this.#ws?.readyState === WebSocket.CONNECTING) return;
    clearTimeout(this.#timer);
    this.#timer = null;
    if (!immediate) {
      const base = Math.min(6400, 400 * 2 ** this.#retry++);
      const delay = base * (0.8 + Math.random() * 0.4);
      this.#timer = setTimeout(() => this.#connect(true), delay);
      return;
    }

    const url = new URL('/api/socket', location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('code', this.code);
    url.searchParams.set('token', this.token);
    const ws = new WebSocket(url);
    this.#ws = ws;

    ws.addEventListener('open', () => {
      this.#retry = 0;
      clearInterval(this.#keepalive);
      this.#keepalive = setInterval(() => this.send('.'), 45_000);
    });
    ws.addEventListener('message', (event) => {
      if (event.data === '.') return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.t === 'state') this.onState?.(message);
      else if (message.t === 'chat') this.onChat?.(message);
      else if (message.t === 'error') this.onError?.(new Error(message.message));
    });
    ws.addEventListener('error', () => this.#scheduleReconnect());
    ws.addEventListener('close', (event) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      clearInterval(this.#keepalive);
      if (this.#closed) return;
      if (terminalClose(event.code)) {
        this.#closed = true;
        this.onClosed?.(event);
        return;
      }
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    if (this.#closed || this.#timer || this.isOpen) return;
    this.#connect(false);
  }
}
