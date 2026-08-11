/**
 * BLOCKS — オンライン対戦の部屋 API
 *
 * 対局中の盤面だけをプライベートな Blob に置き、終わったら消す。
 * 勝敗も棋譜もプレイヤー情報も残さない。部屋は 2 時間触られなければ自動で消える。
 *
 *   POST /api/room?action=create            → 部屋を作る
 *   POST /api/room?action=join   { code }   → 相手として参加する
 *   GET  /api/room?code=..&since=..         → 盤面を取りに行く（ポーリング）
 *   POST /api/room?action=move   { .. }     → 一手打つ（サーバ側でルール検証）
 *   POST /api/room?action=leave  { .. }     → 部屋を消す
 */

import { put, get, del } from '@vercel/blob';
import {
  createGame,
  applyMove,
  canPlace,
  isFirstMove,
  matchesPiece,
} from '../js/rules.js';
import { isColor, partnerFor, firstAvailable, DEFAULT_FIRST } from '../js/palette.js';

/** 見間違えやすい文字（O/0, I/1 など）を外した部屋コード用の英数字。 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

/** 対局中の部屋の寿命。これを過ぎたものは読まれた時点で消す。 */
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
/** 終局後は結果を両者が受け取れるだけの短い猶予だけ残す。 */
const FINISHED_TTL_MS = 5 * 60 * 1000;

const pathFor = (code) => `rooms/${code}.json`;

const randomString = (length, alphabet) => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
};

const newCode = () => randomString(CODE_LENGTH, CODE_ALPHABET);
const newToken = () => randomString(24, 'abcdefghijklmnopqrstuvwxyz0123456789');

/** 部屋を読む。無ければ null。期限切れならその場で消して null 扱いにする。 */
async function readRoom(code) {
  const found = await get(pathFor(code), { access: 'private', useCache: false });
  if (!found || found.statusCode !== 200) return null;

  const text = await new Response(found.stream).text();
  let room;
  try {
    room = JSON.parse(text);
  } catch {
    return null;
  }

  const ttl = room.status === 'finished' ? FINISHED_TTL_MS : ROOM_TTL_MS;
  if (Date.now() - (room.updatedAt || 0) > ttl) {
    await del(pathFor(code)).catch(() => {});
    return null;
  }

  return { room, etag: found.blob.etag };
}

/**
 * 部屋を書き込む。etag を渡すと「読んだときから変わっていなければ書く」になり、
 * 両者の同時着手で盤面が壊れるのを防げる。
 */
async function writeRoom(room, etag) {
  room.seq += 1;
  room.updatedAt = Date.now();
  return put(pathFor(room.code), JSON.stringify(room), {
    access: 'private',
    contentType: 'application/json',
    allowOverwrite: true,
    addRandomSuffix: false,
    ...(etag ? { ifMatch: etag } : {}),
  });
}

/** クライアントに返す形。相手のトークンは絶対に含めない。 */
function publicView(room, seq) {
  if (seq !== undefined && seq === room.seq) {
    return { seq: room.seq, unchanged: true };
  }
  return {
    seq: room.seq,
    code: room.code,
    status: room.status,
    hasOpponent: Boolean(room.tokens[1] && room.tokens[2]),
    game: room.game,
    chat: room.chat || { 1: '', 2: '' },
    colors: room.colors || { 1: DEFAULT_FIRST, 2: partnerFor(DEFAULT_FIRST) },
  };
}

/**
 * 書き込みが相手とぶつかったら、読み直して一度だけやり直す。
 * ひとことは打つたびに書き込むので、着手と重なることがある。
 */
async function writeWithRetry(code, mutate) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const found = await readRoom(code);
    if (!found) return null;
    try {
      const result = mutate(found.room);
      if (result === false) return found.room;
      await writeRoom(found.room, found.etag);
      return found.room;
    } catch (error) {
      if (error && error.name === 'BlobPreconditionFailedError') continue;
      throw error;
    }
  }
  return null;
}

const send = (res, status, body) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(status).send(JSON.stringify(body));
};

const fail = (res, status, message) => send(res, status, { error: message });

export default async function handler(req, res) {
  try {
    const action = req.method === 'GET' ? 'poll' : String(req.query.action || '');
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    switch (action) {
      case 'create':  return await handleCreate(res, body);
      case 'join':   return await handleJoin(res, body);
      case 'poll':   return await handlePoll(res, req.query);
      case 'move':    return await handleMove(res, body);
      case 'say':     return await handleSay(res, body);
      case 'rematch': return await handleRematch(res, body);
      case 'leave':   return await handleLeave(res, body);
      default:        return fail(res, 400, '不正なリクエストです');
    }
  } catch (error) {
    // ifMatch 不一致（同時書き込み）はクライアントが読み直せば回復できる
    if (error && error.name === 'BlobPreconditionFailedError') {
      return fail(res, 409, '盤面が更新されました。読み込み直してください');
    }
    console.error('[room]', error);
    return fail(res, 500, 'サーバ側で問題が起きました');
  }
}

async function handleCreate(res, body) {
  // 万一コードがぶつかったら引き直す
  let code = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = newCode();
    if (!(await readRoom(candidate))) {
      code = candidate;
      break;
    }
  }
  if (!code) return fail(res, 503, '部屋を作れませんでした。もう一度お試しください');

  const token = newToken();
  const hostColor = isColor(body.color) ? body.color : DEFAULT_FIRST;
  const room = {
    code,
    seq: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'waiting',
    tokens: { 1: token, 2: null },
    game: createGame(),
    chat: { 1: '', 2: '' },
    // 参加者が決まるまでは仮の色を入れておき、入ってきたら本人の選んだ色にする
    colors: { 1: hostColor, 2: partnerFor(hostColor) },
  };

  await writeRoom(room, undefined);
  return send(res, 200, { code, token, player: 1, ...publicView(room) });
}

async function handleJoin(res, body) {
  const code = String(body.code || '').toUpperCase();
  if (code.length !== CODE_LENGTH) return fail(res, 400, '部屋コードが正しくありません');

  const found = await readRoom(code);
  if (!found) return fail(res, 404, 'この部屋は見つかりませんでした。時間が経って閉じたのかもしれません');

  const { room, etag } = found;

  // 既に 2 人そろっている部屋には入れない
  if (room.tokens[2]) return fail(res, 409, 'この部屋はもう対戦がはじまっています');

  const token = newToken();
  room.tokens[2] = token;
  room.status = 'playing';

  // 参加者の色。相手と同じ色は取れないので、その場合は空いている色にずらす
  if (!room.colors) room.colors = { 1: DEFAULT_FIRST, 2: partnerFor(DEFAULT_FIRST) };
  const wanted = isColor(body.color) ? body.color : partnerFor(room.colors[1]);
  room.colors[2] = wanted === room.colors[1] ? firstAvailable(room.colors[1]) : wanted;

  await writeRoom(room, etag);
  return send(res, 200, { code, token, player: 2, ...publicView(room) });
}

async function handlePoll(res, query) {
  const code = String(query.code || '').toUpperCase();
  if (code.length !== CODE_LENGTH) return fail(res, 400, '部屋コードが正しくありません');

  const found = await readRoom(code);
  if (!found) return fail(res, 404, 'この部屋は閉じました');

  const since = query.since === undefined ? undefined : Number(query.since);
  return send(res, 200, publicView(found.room, Number.isFinite(since) ? since : undefined));
}

async function handleMove(res, body) {
  const code = String(body.code || '').toUpperCase();
  const token = String(body.token || '');
  const pieceId = String(body.pieceId || '');
  const cells = body.cells;

  const found = await readRoom(code);
  if (!found) return fail(res, 404, 'この部屋は閉じました');

  const { room, etag } = found;
  if (room.status !== 'playing') return fail(res, 409, 'この対局は進行中ではありません');

  // 名乗ったトークンがどちらのプレイヤーのものか
  const player = room.tokens[1] === token ? 1 : room.tokens[2] === token ? 2 : 0;
  if (!player) return fail(res, 403, 'この対局の参加者として確認できませんでした');
  if (room.game.turn !== player) return fail(res, 409, 'あなたの手番ではありません');

  // ここから先はクライアントを信用せず、ルールを一から確かめる
  if (!room.game.hands[player].includes(pieceId)) {
    return fail(res, 400, 'そのピースは手元にありません');
  }
  if (!matchesPiece(pieceId, cells)) {
    return fail(res, 400, 'そのピースの形と一致しません');
  }
  if (!canPlace(room.game.board, player, cells, isFirstMove(room.game, player))) {
    return fail(res, 400, 'そこには置けません');
  }

  room.game = applyMove(room.game, player, pieceId, cells);
  if (room.game.status === 'finished') room.status = 'finished';

  await writeRoom(room, etag);
  return send(res, 200, publicView(room));
}

/** ひとことの現在地を書き換える。履歴は持たず、部屋と一緒に消える。 */
const CHAT_LIMIT = 140;

async function handleSay(res, body) {
  const code = String(body.code || '').toUpperCase();
  const token = String(body.token || '');
  // 改行や制御文字は 1 行表示が壊れるので落とす
  const text = String(body.text ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .slice(0, CHAT_LIMIT);

  if (code.length !== CODE_LENGTH) return fail(res, 400, '部屋コードが正しくありません');

  const room = await writeWithRetry(code, (r) => {
    const player = r.tokens[1] === token ? 1 : r.tokens[2] === token ? 2 : 0;
    if (!player) {
      const error = new Error('forbidden');
      error.forbidden = true;
      throw error;
    }
    if (!r.chat) r.chat = { 1: '', 2: '' };
    if (r.chat[player] === text) return false; // 変わっていないなら書かない
    r.chat[player] = text;
  }).catch((error) => {
    if (error && error.forbidden) return 'forbidden';
    throw error;
  });

  if (room === 'forbidden') return fail(res, 403, 'この対局の参加者として確認できませんでした');
  if (!room) return fail(res, 404, 'この部屋は閉じました');
  return send(res, 200, publicView(room));
}

/** 同じ相手ともう一局。盤面を新しくするだけで、前局の内容はどこにも残さない。 */
async function handleRematch(res, body) {
  const code = String(body.code || '').toUpperCase();
  const token = String(body.token || '');

  const found = await readRoom(code);
  if (!found) return fail(res, 404, 'この部屋は閉じました');

  const { room, etag } = found;
  if (room.tokens[1] !== token && room.tokens[2] !== token) {
    return fail(res, 403, 'この対局の参加者として確認できませんでした');
  }
  // 相手が先に押していた場合は、その新しい盤面をそのまま使う
  if (room.status === 'playing') return send(res, 200, publicView(room));

  room.game = createGame();
  room.status = 'playing';

  await writeRoom(room, etag);
  return send(res, 200, publicView(room));
}

async function handleLeave(res, body) {
  const code = String(body.code || '').toUpperCase();
  const token = String(body.token || '');
  if (code.length !== CODE_LENGTH) return fail(res, 400, '部屋コードが正しくありません');

  const found = await readRoom(code);
  if (!found) return send(res, 200, { ok: true }); // すでに無いなら何もしなくていい

  const { room } = found;
  const isMember = room.tokens[1] === token || room.tokens[2] === token;
  if (!isMember) return fail(res, 403, 'この対局の参加者として確認できませんでした');

  await del(pathFor(code)).catch(() => {});
  return send(res, 200, { ok: true });
}
