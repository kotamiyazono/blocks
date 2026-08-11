/**
 * BLOCKS — オンライン対戦のクライアント
 *
 * サーバとのやりとりと、盤面を取りに行く間隔の調整だけを持つ。
 * 相手の手が来たら間隔を詰め、動きが無い時間が続いたら緩める。
 * 画面が裏に回っている間は止めるので、無駄な通信もしない。
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
  try {
    payload = await response.json();
  } catch {
    /* 本文が読めないケースはステータスだけで判断する */
  }

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

export const createRoom = () => post('create');
export const joinRoom = (code) => post('join', { code });
export const sendMove = (code, token, pieceId, cells) => post('move', { code, token, pieceId, cells });
export const leaveRoom = (code, token) => post('leave', { code, token });
export const requestRematch = (code, token) => post('rematch', { code, token });
export const sendChat = (code, token, text) => post('say', { code, token, text });

export const fetchRoom = (code, since) => {
  const params = new URLSearchParams({ code });
  if (since !== undefined) params.set('since', String(since));
  return request(`${ENDPOINT}?${params}`, { method: 'GET' });
};

/** 相手の手が来ていないか見に行き続ける。 */
export class RoomWatcher {
  #timer = null;
  #stopped = true;
  #misses = 0;
  #quietSince = 0;
  #hurryUntil = 0;

  /**
   * @param {object} options
   * @param {() => string} options.code            部屋コード
   * @param {() => number} options.since           手元が知っている最新の seq
   * @param {(data) => void} options.onUpdate      盤面が進んだとき
   * @param {(error) => void} options.onError      続けて失敗したとき
   */
  constructor(options) {
    this.options = options;
    this.onVisibility = () => {
      if (document.visibilityState === 'visible' && !this.#stopped) this.#schedule(0);
    };
  }

  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#misses = 0;
    this.#quietSince = Date.now();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.#schedule(0);
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#timer = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  /**
   * やりとりが続いている間だけ間隔を詰める。
   * ひとことを打ち合っている最中は文字が流れて見えるように、いちばん短くする。
   */
  #interval() {
    if (Date.now() < this.#hurryUntil) return 550;
    const quiet = Date.now() - this.#quietSince;
    if (quiet < 20_000) return 1200;
    if (quiet < 60_000) return 2500;
    return 6000;
  }

  /** しばらく見に行く間隔を詰める（会話中に使う）。 */
  hurry(ms = 12_000) {
    this.#hurryUntil = Date.now() + ms;
    if (!this.#stopped) this.#schedule(0);
  }

  #schedule(delay) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#tick(), delay);
  }

  async #tick() {
    if (this.#stopped) return;
    if (document.visibilityState === 'hidden') {
      this.#schedule(4000);
      return;
    }

    try {
      const data = await fetchRoom(this.options.code(), this.options.since());
      this.#misses = 0;
      if (!data.unchanged) {
        this.#quietSince = Date.now();
        this.options.onUpdate(data);
      }
    } catch (error) {
      // 部屋が消えていたら待っても回復しないので、すぐ知らせる
      if (error.status === 404) {
        this.stop();
        this.options.onError(error);
        return;
      }
      // 一時的な失敗は数回まで黙って見送る
      if (++this.#misses >= 4) {
        this.#misses = 0;
        this.options.onError(error);
      }
    }

    if (!this.#stopped) this.#schedule(this.#interval());
  }
}
