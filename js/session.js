/**
 * BLOCKS — 対局の状態
 *
 * いま何を遊んでいて、どこまで進んでいるかを持つ場所。
 * ここは DOM に触らないので、描画・入力・通信のどこからでも安心して読める。
 */

import {
  canPlace,
  cellsAtAnchor,
  isFirstMove,
  legalMoves,
  variantOf,
} from './rules.js';
import { colorName } from './palette.js';

export const state = {
  mode: null,          // 'solo' | 'local' | 'online'
  game: null,
  myPlayer: 1,         // ひとり／オンラインで自分が受け持つ席
  level: 'normal',     // CPU の強さ
  side: 1,             // ひとりプレーで自分が選んだ手番
  seats: 2,            // 人数（2 または 4）
  cpuSeats: [],        // CPU が受け持つ席
  sel: null,           // { pieceId, oi, anchor }
  selTurn: null,       // 選択がどの手番のものか（手番が変わったら捨てる）
  lastAnchor: null,    // 矢印キーで動かすときの起点
  history: [],         // 待った用（ひとり／対面のみ）
  placeable: null,     // { key, set } 置けるピースの一覧をキャッシュ
  busy: false,         // 送信中はボタンを止める
  online: null,        // { code, token, player, seq, opponentJoined, watcher }
  quitArmed: false,    // 「やめる」の二度押し待ち
};

/* ------------------------------------------------------------------ 保存 */

const ROOM_KEY = 'blocks:room';

const read = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
};
const write = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できなくても続行できる */ }
};

/** 入っている部屋。再読み込みしても元の席に戻れるように控えておく。 */
export const saveRoom = (room) =>
  write(ROOM_KEY, { code: room.code, token: room.token, player: room.player });
export const loadRoom = () => read(ROOM_KEY, null);
export const clearRoom = () => {
  try { localStorage.removeItem(ROOM_KEY); } catch { /* 無視してよい */ }
};

/* ------------------------------------------------------ 状態から導けること */

/** その席を CPU が受け持っているか。 */
export const isCpuSeat = (player) => state.cpuSeats.includes(player);

/** 手元の操作を受け付けてよいか。 */
export function canAct() {
  const g = state.game;
  if (!g || g.status !== 'playing' || state.busy) return false;
  if (state.mode === 'local') return true;
  return g.turn === state.myPlayer;
}

/**
 * 表示名。人数と遊び方で呼び方が変わる。
 * 4 人戦は「先手・後手」では足りないので、その席の色の名前で呼ぶ。
 */
export function labelFor(player) {
  if (player === state.myPlayer && state.mode !== 'local') return 'あなた';
  if (isCpuSeat(player)) {
    return state.seats > 2 ? `CPU（${colorName(player)}）` : 'CPU';
  }
  if (state.seats > 2) return colorName(player);
  if (state.mode === 'local') return player === 1 ? '先手' : '後手';
  return state.mode === 'solo' ? 'CPU' : '相手';
}

/**
 * そのパネルが受け持つプレイヤー。
 * 対面は上下で固定だが、ひとり・オンラインは自分が先手にも後手にもなるので、
 * 組み立てた時点で決め打ちにせず、必要になるたびに今の状態から求める。
 */
export function playerOfPanel(isFar) {
  if (state.mode === 'local') return isFar ? 2 : 1;
  return state.myPlayer;
}

/** 今の手番で置けるピースの一覧。手番ごとに一度だけ計算する。 */
export function placeableSet() {
  const g = state.game;
  const key = `${g.moveCount}:${g.turn}`;
  if (state.placeable && state.placeable.key === key) return state.placeable.set;

  const p = g.turn;
  const moves = legalMoves(variantOf(g), g.board, p, g.hands[p], isFirstMove(g, p));
  const set = new Set(moves.map((m) => m.pieceId));
  state.placeable = { key, set };
  return set;
}

/**
 * 持つピースを持ち替える。
 *
 * 置き場所はあえて決めない。ここで「置ける場所」を先回りして出すと、
 * 手番が来た瞬間から確定できる状態になってしまい、
 * 考えずに「置く」を押すだけで進んでしまう。どこに置くかは打つ人が決める。
 */
export function computeSelection(pieceId) {
  state.selTurn = state.game.turn;
  state.sel = { pieceId, oi: 0, anchor: null };
}

/** 仮置きの見た目。置けない位置でも出して、なぜ置けないか分かるようにする。 */
export function currentGhost() {
  if (!state.sel || !state.sel.anchor || !canAct()) return null;
  const g = state.game;
  const v = variantOf(g);
  const p = g.turn;
  const cells = cellsAtAnchor(v, state.sel.pieceId, state.sel.oi, state.sel.anchor);
  return { cells, valid: canPlace(v, g.board, p, cells, isFirstMove(g, p)), player: p };
}
