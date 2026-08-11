/**
 * BLOCKS — オンライン対戦の部屋 API
 *
 * 対局中の盤面だけをプライベートな Blob に置き、終わったら消す。
 * 勝敗も棋譜もプレイヤー情報も残さない。部屋は 2 時間触られなければ自動で消える。
 *
 *   POST /api/room?action=create  { color }        → 部屋を作る
 *   POST /api/room?action=join    { code, color }  → 相手として参加する
 *   GET  /api/room?code=..&since=..                → 盤面を取りに行く（ポーリング）
 *   POST /api/room?action=move    { .. }           → 一手打つ（サーバ側でルール検証）
 *   POST /api/room?action=say     { .. }           → ひとことを書き換える
 *   POST /api/room?action=rematch { .. }           → もう一局
 *   POST /api/room?action=leave   { .. }           → 部屋を消す
 */

import { put, get, del, BlobPreconditionFailedError } from '@vercel/blob';
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
const CHAT_LIMIT = 140;

/** 対局中の部屋の寿命。これを過ぎたものは読まれた時点で消す。 */
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
/** 終局後は結果を両者が受け取れるだけの短い猶予だけ残す。 */
const FINISHED_TTL_MS = 5 * 60 * 1000;

const pathFor = (code) => `rooms/${code}.json`;

/** 呼び出し側にそのまま返したい失敗。 */
class RoomError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * 「読んだときから変わっていた」ことによる書き込み失敗かどうか。
 * SDK が投げる例外は name が当てにならないので、型と文面の両方で確かめる。
 */
const isConflict = (error) =>
  error instanceof BlobPreconditionFailedError ||
  error?.name === 'BlobPreconditionFailedError' ||
  /precondition/i.test(error?.message || '');

/**
 * ETag から弱い印（W/）を外す。
 * 盤面は手が進むほど大きくなり、ある大きさを超えると転送時に圧縮される。
 * すると読み取りの ETag が W/"..." という弱い形になるが、条件付き書き込みの
 * ifMatch は強い形しか受け付けない。そのままでは中盤から必ず書けなくなる。
 */
const strongEtag = (etag) => (typeof etag === 'string' ? etag.replace(/^W\//, '') : etag);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 置き場所そのものが一時的に応じなかっただけの失敗か。
 * 保管サービスは稀に 500 を返したり詰まったりする。少し待てば通ることが多いので、
 * こちらの言い分（手番違いなど）と区別して数回だけやり直す。
 */
const isTransient = (error) =>
  !isConflict(error) &&
  /50\d|rate.?limit|fetch failed|network|timeout|unavailable|socket/i.test(error?.message || '');

/** 一過性の失敗なら少し待って繰り返す。 */
async function resilient(operation) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransient(error)) throw error;
      lastError = error;
      await sleep(150 * (attempt + 1));
    }
  }
  throw lastError;
}

const randomString = (length, alphabet) => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
};

const newCode = () => randomString(CODE_LENGTH, CODE_ALPHABET);
const newToken = () => randomString(24, 'abcdefghijklmnopqrstuvwxyz0123456789');

const requireCode = (value) => {
  const code = String(value || '').toUpperCase();
  if (code.length !== CODE_LENGTH) throw new RoomError(400, '部屋コードが正しくありません');
  return code;
};

/* ========================================================================
   保管
   ======================================================================== */

/** 部屋を読む。無ければ null。期限切れならその場で消して無かったことにする。 */
async function readRoom(code) {
  const found = await resilient(() => get(pathFor(code), { access: 'private', useCache: false }));
  if (!found || found.statusCode !== 200) return null;

  let room;
  try {
    room = JSON.parse(await new Response(found.stream).text());
  } catch {
    return null;
  }

  const ttl = room.status === 'finished' ? FINISHED_TTL_MS : ROOM_TTL_MS;
  if (Date.now() - (room.updatedAt || 0) > ttl) {
    await del(pathFor(code)).catch(() => {});
    return null;
  }

  return { room, etag: strongEtag(found.blob.etag) };
}

/**
 * 部屋を書き込む。etag を渡すと「読んだときから変わっていなければ書く」になり、
 * 両者の同時着手で盤面が壊れるのを防げる。
 */
async function writeRoom(room, etag) {
  room.seq += 1;
  room.updatedAt = Date.now();
  // ifMatch を付けているので、やり直しで同じ手が二重に入ることはない
  return resilient(() => put(pathFor(room.code), JSON.stringify(room), {
    access: 'private',
    contentType: 'application/json',
    allowOverwrite: true,
    addRandomSuffix: false,
    ...(etag ? { ifMatch: etag } : {}),
  }));
}

/** mutate がこれを返したら、中身が変わっていないので書き込まない。 */
const UNCHANGED = Symbol('unchanged');

/**
 * 読んで、書き換えて、書く。
 * 途中で相手に先を越されたら読み直してやり直すので、
 * 判断（手番かどうかなど）は必ず最新の盤面に対して行われる。
 */
async function updateRoom(code, mutate) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const found = await readRoom(code);
    if (!found) throw new RoomError(404, 'この部屋は閉じました');

    const outcome = mutate(found.room);
    if (outcome === UNCHANGED) return found.room;

    try {
      await writeRoom(found.room, found.etag);
      return found.room;
    } catch (error) {
      if (isConflict(error)) continue; // 割り込まれた。読み直してやり直す
      throw error;
    }
  }
  throw new RoomError(409, '操作が重なりました。もう一度お試しください');
}

/* ========================================================================
   受け答え
   ======================================================================== */

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

const send = (res, status, body) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(status).send(JSON.stringify(body));
};

/** その部屋の参加者としてどちらの側か。名乗れなければ 403。 */
function seatOf(room, token) {
  const player = room.tokens[1] === token ? 1 : room.tokens[2] === token ? 2 : 0;
  if (!player) throw new RoomError(403, 'この対局の参加者として確認できませんでした');
  return player;
}

export default async function handler(req, res) {
  try {
    const action = req.method === 'GET' ? 'poll' : String(req.query.action || '');
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    switch (action) {
      case 'create':  return await handleCreate(res, body);
      case 'join':    return await handleJoin(res, body);
      case 'poll':    return await handlePoll(res, req.query);
      case 'move':    return await handleMove(res, body);
      case 'say':     return await handleSay(res, body);
      case 'rematch': return await handleRematch(res, body);
      case 'leave':   return await handleLeave(res, body);
      default:        throw new RoomError(400, '不正なリクエストです');
    }
  } catch (error) {
    if (error instanceof RoomError) return send(res, error.status, { error: error.message });
    if (isConflict(error)) {
      return send(res, 409, { error: '盤面が更新されました。読み込み直してください' });
    }
    console.error('[room]', error);
    return send(res, 500, { error: 'サーバ側で問題が起きました' });
  }
}

/* ========================================================================
   それぞれの操作
   ======================================================================== */

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
  if (!code) throw new RoomError(503, '部屋を作れませんでした。もう一度お試しください');

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
  const code = requireCode(body.code);
  const token = newToken();

  const room = await updateRoom(code, (r) => {
    // 既に 2 人そろっている部屋には入れない
    if (r.tokens[2]) throw new RoomError(409, 'この部屋はもう対戦がはじまっています');

    r.tokens[2] = token;
    r.status = 'playing';

    // 相手と同じ色は取れないので、その場合は空いている色にずらす
    if (!r.colors) r.colors = { 1: DEFAULT_FIRST, 2: partnerFor(DEFAULT_FIRST) };
    const wanted = isColor(body.color) ? body.color : partnerFor(r.colors[1]);
    r.colors[2] = wanted === r.colors[1] ? firstAvailable(r.colors[1]) : wanted;
  });

  return send(res, 200, { code, token, player: 2, ...publicView(room) });
}

async function handlePoll(res, query) {
  const code = requireCode(query.code);
  const found = await readRoom(code);
  if (!found) throw new RoomError(404, 'この部屋は閉じました');

  const since = query.since === undefined ? undefined : Number(query.since);
  return send(res, 200, publicView(found.room, Number.isFinite(since) ? since : undefined));
}

async function handleMove(res, body) {
  const code = requireCode(body.code);
  const { token, pieceId, cells } = body;

  const room = await updateRoom(code, (r) => {
    if (r.status !== 'playing') throw new RoomError(409, 'この対局は進行中ではありません');

    const player = seatOf(r, String(token || ''));
    if (r.game.turn !== player) throw new RoomError(409, 'あなたの手番ではありません');

    // ここから先はクライアントを信用せず、ルールを一から確かめる
    if (!r.game.hands[player].includes(pieceId)) {
      throw new RoomError(400, 'そのピースは手元にありません');
    }
    if (!matchesPiece(pieceId, cells)) {
      throw new RoomError(400, 'そのピースの形と一致しません');
    }
    if (!canPlace(r.game.board, player, cells, isFirstMove(r.game, player))) {
      throw new RoomError(400, 'そこには置けません');
    }

    r.game = applyMove(r.game, player, pieceId, cells);
    if (r.game.status === 'finished') r.status = 'finished';
  });

  return send(res, 200, publicView(room));
}

/** ひとことの現在地を書き換える。履歴は持たず、部屋と一緒に消える。 */
async function handleSay(res, body) {
  const code = requireCode(body.code);
  const token = String(body.token || '');
  // 改行や制御文字は 1 行表示が壊れるので落とす
  const text = String(body.text ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .slice(0, CHAT_LIMIT);

  const room = await updateRoom(code, (r) => {
    const player = seatOf(r, token);
    if (!r.chat) r.chat = { 1: '', 2: '' };
    if (r.chat[player] === text) return UNCHANGED; // 変わっていないなら書かない
    r.chat[player] = text;
  });

  return send(res, 200, publicView(room));
}

/** 同じ相手ともう一局。盤面を新しくするだけで、前局の内容はどこにも残さない。 */
async function handleRematch(res, body) {
  const code = requireCode(body.code);
  const token = String(body.token || '');

  const room = await updateRoom(code, (r) => {
    seatOf(r, token);
    // 相手が先に押していた場合は、その新しい盤面をそのまま使う
    if (r.status === 'playing') return UNCHANGED;

    r.game = createGame();
    r.chat = { 1: '', 2: '' };
    r.status = 'playing';
  });

  return send(res, 200, publicView(room));
}

async function handleLeave(res, body) {
  const code = requireCode(body.code);
  const token = String(body.token || '');

  const found = await readRoom(code);
  if (!found) return send(res, 200, { ok: true }); // すでに無いなら何もしなくていい

  seatOf(found.room, token);
  await del(pathFor(code)).catch(() => {});
  return send(res, 200, { ok: true });
}
