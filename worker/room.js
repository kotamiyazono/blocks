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
function publicView(room, chat) {
  return {
    code: room.code,
    status: room.status,
    seats: room.seats,
    variant: room.variant,
    cpu: room.cpu,
    joined: seatNumbers(room).filter((p) => room.tokens[p]).length,
    hasOpponent: filledSeats(room) >= room.seats,
    game: room.game,
    chat,
  };
}

/** CPU 席は主催者だけが代わりに動かせる。 */
function mayMoveFor(room, seat, turn) {
  if (seat === turn) return true;
  return room.cpu.includes(turn) && seat === 1;
}

export class Room extends DurableObject {
  #room = null;
  #chat = {};

  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('.', '.'));
    ctx.blockConcurrencyWhile(async () => {
      this.#room = (await ctx.storage.get('room')) ?? null;
    });
  }

  /** Worker からの唯一の入口。例外は HTTP 相当の形に畳んで返す。 */
  async call(action, body = {}) {
    try {
      switch (action) {
        case 'create':  return await this.#create(body);
        case 'join': {
          const result = await this.#join(body);
          this.#broadcast({ t: 'state', ...this.#view() });
          return result;
        }
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

  async fetch(request) {
    const { 0: client, 1: server } = new WebSocketPair();
    const token = new URL(request.url).searchParams.get('token') || '';

    /**
     * WebSocket の受け口。席を確かめてから hibernation 側に渡す。
     *
     * 断る接続だけは標準の accept() を使う。ctx.acceptWebSocket() で受けたソケットを
     * 101 を返す前に close しても、閉じフレームがクライアント側で完了せず接続が
     * 宙吊りになる（実測）。断るだけの接続は hibernation に登録しないほうが、
     * getWebSockets() にも残らず broadcast の対象にもならない。
     */
    const seat = this.#room
      && seatNumbers(this.#room).find((p) => this.#room.tokens[p] === token);
    if (!seat) {
      const [code, message] = this.#room
        ? [4403, 'この対局の参加者として確認できませんでした']
        : [4404, 'この部屋は閉じました'];
      server.accept();
      server.close(code, message);
      return new Response(null, { status: 101, webSocket: client });
    }

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ seat });
    server.send(JSON.stringify({ t: 'state', ...this.#view() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      try { ws.send(JSON.stringify({ t: 'error', message: '不正なメッセージです' })); } catch { /* close 直後は応答を捨てる */ }
      return;
    }

    const seat = ws.deserializeAttachment()?.seat;
    if (!seat) return;

    try {
      switch (message?.t) {
        case 'move':
          await this.#move(message, seat);
          this.#broadcast({ t: 'state', ...this.#view() });
          break;
        case 'say': {
          const text = this.#say(message, seat);
          if (text !== null) {
            this.#broadcast({ t: 'chat', seat, text }, ws);
          }
          break;
        }
        case 'start':
          await this.#start(seat);
          this.#broadcast({ t: 'state', ...this.#view() });
          break;
        case 'rematch':
          await this.#rematch(seat);
          this.#broadcast({ t: 'state', ...this.#view() });
          break;
        case 'leave':
          await this.#leave(seat);
          break;
        default:
          throw new RoomError(400, '不正なメッセージです');
      }
    } catch (error) {
      if (error instanceof RoomError) {
        try { ws.send(JSON.stringify({ t: 'error', message: error.message })); } catch { /* close 直後は応答を捨てる */ }
        return;
      }
      console.error('[room]', error);
      try { ws.send(JSON.stringify({ t: 'error', message: 'サーバ側で問題が起きました' })); } catch { /* close 直後は応答を捨てる */ }
    }
  }

  /** 期限切れ。部屋ごと消える。 */
  async alarm() {
    await this.#closeRoom('この部屋は閉じました');
  }

  #requireRoom() {
    if (!this.#room) throw new RoomError(404, 'この部屋は閉じました');
    return this.#room;
  }

  async #save() {
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
  }

  async #create(body) {
    if (this.#room) throw new RoomError(409, '部屋コードが既に使われています');

    const seats = body.seats === 4 ? 4 : 2;
    const variant = seats === 4 ? VARIANTS.four.id : VARIANTS.duo.id;
    const token = newToken();
    const tokens = {};
    for (let p = 1; p <= seats; p++) tokens[p] = null;
    tokens[1] = token;

    this.#room = {
      code: body.code,
      status: 'waiting',
      seats,
      variant,
      cpu: [],
      tokens,
      game: createGame(variant),
    };
    this.#chat = {};
    await this.#save();
    return { status: 200, body: { code: body.code, token, player: 1 } };
  }

  async #join(body) {
    const token = newToken();
    let seat = 0;
    await this.#update((r) => {
      if (r.status === 'finished') throw new RoomError(409, 'この対局は終わっています');
      seat = seatNumbers(r).find((p) => !r.tokens[p] && !r.cpu.includes(p)) || 0;
      if (!seat) throw new RoomError(409, 'この部屋はもう席が埋まっています');
      r.tokens[seat] = token;
      if (filledSeats(r) >= r.seats) r.status = 'playing';
    });
    return { status: 200, body: { code: body.code, token, player: seat } };
  }

  /** 主催者が、空いている席を CPU に任せて始める。 */
  async #start(seat) {
    await this.#update((r) => {
      if (seat !== 1) throw new RoomError(403, '部屋を作った人だけが始められます');
      if (r.status === 'playing') return false;
      if (r.status !== 'waiting') throw new RoomError(409, 'この部屋は始められません');
      r.cpu = seatNumbers(r).filter((p) => !r.tokens[p]);
      r.status = 'playing';
    });
  }

  async #move(body, seat) {
    await this.#update((r) => {
      if (r.status !== 'playing') throw new RoomError(409, 'この対局は進行中ではありません');

      const player = r.game.turn;
      if (!mayMoveFor(r, seat, player)) {
        throw new RoomError(409, 'あなたの手番ではありません');
      }

      // ここから先はクライアントを信用せず、ルールを一から確かめる
      const v = variantOf(r.game);
      if (!r.game.hands[player].includes(body.pieceId)) {
        throw new RoomError(400, 'そのピースは手元にありません');
      }
      if (!matchesPiece(v, body.pieceId, body.cells)) {
        throw new RoomError(400, 'そのピースの形と一致しません');
      }
      if (!canPlace(v, r.game.board, player, body.cells, isFirstMove(r.game, player))) {
        throw new RoomError(400, 'そこには置けません');
      }

      r.game = applyMove(r.game, player, body.pieceId, body.cells);
      if (r.game.status === 'finished') r.status = 'finished';
    });
  }

  /** ひとことの現在地を書き換える。履歴は持たない。 */
  #say(body, seat) {
    this.#requireRoom();
    const text = String(body.text ?? '')
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .slice(0, CHAT_LIMIT);
    if ((this.#chat[seat] || '') === text) return null;
    this.#chat[seat] = text;
    return text;
  }

  /** 同じ相手ともう一局。前局の内容はどこにも残さない。 */
  async #rematch(seat) {
    await this.#update((r) => {
      if (!seatNumbers(r).includes(seat)) {
        throw new RoomError(403, 'この対局の参加者として確認できませんでした');
      }
      if (r.status === 'playing') return false;
      r.game = createGame(r.variant);
      this.#chat = {};
      r.status = 'playing';
    });
  }

  async #leave(seat) {
    this.#requireRoom();
    if (!seatNumbers(this.#room).includes(seat)) {
      throw new RoomError(403, 'この対局の参加者として確認できませんでした');
    }
    await this.#closeRoom('この部屋は閉じました');
  }

  #view() {
    const chat = Object.fromEntries(seatNumbers(this.#room).map((p) => [p, this.#chat[p] || '']));
    return publicView(this.#room, chat);
  }

  #broadcast(message, except) {
    const raw = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(raw); } catch { /* close 直後の席は飛ばして配信を続ける */ }
    }
  }

  async #closeRoom(message) {
    if (!this.#room) {
      await this.ctx.storage.deleteAll();
      return;
    }
    this.#room = null;
    this.#chat = {};
    // closed は送らない。close code と reason で同じ情報が確実に届き、クライアントも読まない。
    for (const ws of this.ctx.getWebSockets()) ws.close(4404, message);
    await this.ctx.storage.deleteAll();
  }
}
