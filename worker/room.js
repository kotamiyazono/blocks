/**
 * BLOCKS — 1 部屋分の Durable Object
 *
 * 部屋の状態だけを置き、勝敗・棋譜・プレイヤー情報は保存しない。
 * 同じ部屋への操作はここで直列に処理されるので、同時着手でも盤面が壊れない。
 */

import { DurableObject } from 'cloudflare:workers';
import {
  createGame,
  applyMove,
  canPlace,
  isFirstMove,
  matchesPiece,
  variantOf,
  VARIANTS,
} from '../public/js/rules.js';

const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const FINISHED_TTL_MS = 5 * 60 * 1000;
const CHAT_LIMIT = 140;

const newToken = () => crypto.randomUUID();

class RoomError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const seatNumbers = (room) =>
  Array.from({ length: room.seats }, (_, i) => i + 1);

const filledSeats = (room) =>
  seatNumbers(room).filter((p) => room.tokens[p] || room.cpu.includes(p)).length;

/** クライアントに返す形。他の人のトークンは絶対に含めない。 */
function publicView(room, seq) {
  if (seq !== undefined && seq === room.seq) {
    return { seq: room.seq, unchanged: true };
  }
  return {
    seq: room.seq,
    code: room.code,
    status: room.status,
    seats: room.seats,
    variant: room.variant,
    cpu: room.cpu,
    joined: seatNumbers(room).filter((p) => room.tokens[p]).length,
    hasOpponent: filledSeats(room) >= room.seats,
    game: room.game,
    chat: room.chat,
  };
}

/** その部屋の何番目の席の人か。名乗れなければ 403。 */
function seatOf(room, token) {
  const seat = seatNumbers(room).find((p) => room.tokens[p] === token);
  if (!seat) throw new RoomError(403, 'この対局の参加者として確認できませんでした');
  return seat;
}

/** CPU 席は主催者だけが代わりに動かせる。 */
function mayMoveFor(room, token, turn) {
  if (room.tokens[turn] === token) return true;
  return room.cpu.includes(turn) && room.tokens[1] === token;
}

export class Room extends DurableObject {
  #room = null;

  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.#room = (await ctx.storage.get('room')) ?? null;
    });
  }

  /** Worker からの唯一の入口。例外は HTTP 相当の形に畳んで返す。 */
  async call(action, body = {}) {
    try {
      switch (action) {
        case 'create':  return await this.#create(body);
        case 'join':    return await this.#join(body);
        case 'poll':    return await this.#poll(body);
        case 'start':   return await this.#start(body);
        case 'move':    return await this.#move(body);
        case 'say':     return await this.#say(body);
        case 'rematch': return await this.#rematch(body);
        case 'leave':   return await this.#leave(body);
        default:        throw new RoomError(400, '不正なリクエストです');
      }
    } catch (error) {
      if (error instanceof RoomError) {
        return { status: error.status, body: { error: error.message } };
      }
      console.error('[room]', error);
      return { status: 500, body: { error: 'サーバ側で問題が起きました' } };
    }
  }

  /** 期限切れ。部屋ごと消える。 */
  async alarm() {
    this.#room = null;
    await this.ctx.storage.deleteAll();
  }

  #requireRoom() {
    if (!this.#room) throw new RoomError(404, 'この部屋は閉じました');
    return this.#room;
  }

  async #save() {
    this.#room.seq += 1;
    await this.ctx.storage.put('room', this.#room);
    const ttl = this.#room.status === 'finished' ? FINISHED_TTL_MS : ROOM_TTL_MS;
    await this.ctx.storage.setAlarm(Date.now() + ttl);
  }

  /**
   * mutate は全チェックを終えてから書き換えを始め、始めたら throw しない。
   * 途中で throw すると this.#room を直接書き換えているため、メモリ上の部屋だけが壊れる。
   */
  async #update(mutate) {
    const room = this.#requireRoom();
    if (mutate(room) !== false) await this.#save();
    return room;
  }

  async #create(body) {
    if (this.#room) throw new RoomError(409, '部屋コードが既に使われています');

    const seats = body.seats === 4 ? 4 : 2;
    const variant = seats === 4 ? VARIANTS.four.id : VARIANTS.duo.id;
    const token = newToken();
    const tokens = {};
    const chat = {};
    for (let p = 1; p <= seats; p++) { tokens[p] = null; chat[p] = ''; }
    tokens[1] = token;

    this.#room = {
      code: body.code,
      seq: 0,
      status: 'waiting',
      seats,
      variant,
      cpu: [],
      tokens,
      game: createGame(variant),
      chat,
    };
    await this.#save();
    return { status: 200, body: { code: body.code, token, player: 1, ...publicView(this.#room) } };
  }

  async #join(body) {
    const token = newToken();
    let seat = 0;
    const room = await this.#update((r) => {
      if (r.status === 'finished') throw new RoomError(409, 'この対局は終わっています');
      seat = seatNumbers(r).find((p) => !r.tokens[p] && !r.cpu.includes(p)) || 0;
      if (!seat) throw new RoomError(409, 'この部屋はもう席が埋まっています');
      r.tokens[seat] = token;
      if (filledSeats(r) >= r.seats) r.status = 'playing';
    });
    return { status: 200, body: { code: body.code, token, player: seat, ...publicView(room) } };
  }

  /** 主催者が、空いている席を CPU に任せて始める。 */
  async #start(body) {
    const token = String(body.token || '');
    const room = await this.#update((r) => {
      if (r.tokens[1] !== token) throw new RoomError(403, '部屋を作った人だけが始められます');
      if (r.status === 'playing') return false;
      if (r.status !== 'waiting') throw new RoomError(409, 'この部屋は始められません');
      r.cpu = seatNumbers(r).filter((p) => !r.tokens[p]);
      r.status = 'playing';
    });
    return { status: 200, body: publicView(room) };
  }

  async #poll(body) {
    const room = this.#requireRoom();
    const since = body.since === undefined ? undefined : Number(body.since);
    return { status: 200, body: publicView(room, Number.isFinite(since) ? since : undefined) };
  }

  async #move(body) {
    const { token, pieceId, cells } = body;
    const room = await this.#update((r) => {
      if (r.status !== 'playing') throw new RoomError(409, 'この対局は進行中ではありません');

      seatOf(r, String(token || '')); // 参加者かどうかをまず確かめる
      const player = r.game.turn;
      if (!mayMoveFor(r, String(token || ''), player)) {
        throw new RoomError(409, 'あなたの手番ではありません');
      }

      // ここから先はクライアントを信用せず、ルールを一から確かめる
      const v = variantOf(r.game);
      if (!r.game.hands[player].includes(pieceId)) {
        throw new RoomError(400, 'そのピースは手元にありません');
      }
      if (!matchesPiece(v, pieceId, cells)) {
        throw new RoomError(400, 'そのピースの形と一致しません');
      }
      if (!canPlace(v, r.game.board, player, cells, isFirstMove(r.game, player))) {
        throw new RoomError(400, 'そこには置けません');
      }

      r.game = applyMove(r.game, player, pieceId, cells);
      if (r.game.status === 'finished') r.status = 'finished';
    });
    return { status: 200, body: publicView(room) };
  }

  /** ひとことの現在地を書き換える。履歴は持たない。 */
  async #say(body) {
    const token = String(body.token || '');
    const text = String(body.text ?? '')
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .slice(0, CHAT_LIMIT);
    const room = await this.#update((r) => {
      const player = seatOf(r, token);
      if (r.chat[player] === text) return false;
      r.chat[player] = text;
    });
    return { status: 200, body: publicView(room) };
  }

  /** 同じ相手ともう一局。前局の内容はどこにも残さない。 */
  async #rematch(body) {
    const token = String(body.token || '');
    const room = await this.#update((r) => {
      seatOf(r, token);
      if (r.status === 'playing') return false;
      r.game = createGame(r.variant);
      for (const p of seatNumbers(r)) r.chat[p] = '';
      r.status = 'playing';
    });
    return { status: 200, body: publicView(room) };
  }

  async #leave(body) {
    if (!this.#room) return { status: 200, body: { ok: true } };
    seatOf(this.#room, String(body.token || ''));
    this.#room = null;
    await this.ctx.storage.deleteAll();
    return { status: 200, body: { ok: true } };
  }
}
