/**
 * BLOCKS — 対局の状態
 *
 * いま何を遊んでいて、どこまで進んでいるかを持つ場所。
 * ここは DOM に触らないので、描画・入力・通信のどこからでも安心して読める。
 */

import {
  START,
  anchorForCells,
  canPlace,
  cellsAtAnchor,
  isFirstMove,
  legalMoves,
  orientationIndexOf,
} from './rules.js';
import { DEFAULT_FIRST, isColor, partnerFor } from './palette.js';

export const state = {
  mode: null,          // 'solo' | 'local' | 'online'
  game: null,
  myPlayer: 1,         // ひとり／オンラインで自分が受け持つ側
  level: 'normal',     // CPU の強さ
  side: 1,             // ひとりプレーで自分が選んだ手番
  sel: null,           // { pieceId, oi, anchor }
  selTurn: null,       // 選択がどの手番のものか（手番が変わったら捨てる）
  lastAnchor: null,    // 次のピースを近くに出すための手がかり
  history: [],         // 待った用（ひとり／対面のみ）
  placeable: null,     // { key, set } 置けるピースの一覧をキャッシュ
  busy: false,         // 送信中はボタンを止める
  online: null,        // { code, token, player, seq, opponentJoined, watcher }
  pendingJoin: null,   // 色を選んでもらっている最中の部屋コード
  quitArmed: false,    // 「やめる」の二度押し待ち
};

/* ------------------------------------------------------------------ 保存 */

const ROOM_KEY = 'blocks:room';
const COLOR_KEY = 'blocks:color';        // ひとり・オンラインで使う自分の色
const LOCAL_COLOR_KEY = 'blocks:colors'; // 対面での先手・後手の色

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

/** 選んだ色の控え。次に遊ぶときはここから始まる。 */
export const choice = {
  mine: (() => {
    const saved = read(COLOR_KEY, null);
    return isColor(saved) ? saved : DEFAULT_FIRST;
  })(),
  local: (() => {
    const saved = read(LOCAL_COLOR_KEY, null) || {};
    const first = isColor(saved[1]) ? saved[1] : DEFAULT_FIRST;
    const second = isColor(saved[2]) && saved[2] !== first ? saved[2] : partnerFor(first);
    return { 1: first, 2: second };
  })(),
};

export const rememberMyColor = (id) => { choice.mine = id; write(COLOR_KEY, id); };
export const rememberLocalColors = () => write(LOCAL_COLOR_KEY, choice.local);

/** 入っている部屋。再読み込みしても元の席に戻れるように控えておく。 */
export const saveRoom = (room) =>
  write(ROOM_KEY, { code: room.code, token: room.token, player: room.player });
export const loadRoom = () => read(ROOM_KEY, null);
export const clearRoom = () => {
  try { localStorage.removeItem(ROOM_KEY); } catch { /* 無視してよい */ }
};

/* ------------------------------------------------------ 状態から導けること */

/** 手元の操作を受け付けてよいか。 */
export function canAct() {
  const g = state.game;
  if (!g || g.status !== 'playing' || state.busy) return false;
  if (state.mode === 'local') return true;
  return g.turn === state.myPlayer;
}

/** 表示名。モードによって呼び方を変える。 */
export function labelFor(player) {
  if (state.mode === 'local') return player === 1 ? '先手' : '後手';
  if (player === state.myPlayer) return 'あなた';
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
  const moves = legalMoves(g.board, p, g.hands[p], isFirstMove(g, p));
  const set = new Set(moves.map((m) => m.pieceId));
  state.placeable = { key, set };
  return set;
}

/**
 * 選ばれたピースを、置ける場所のうち直前に触っていた位置のいちばん近くに出す。
 * 画面には触らないので、呼んだ側で描き直す。
 */
export function computeSelection(pieceId) {
  const g = state.game;
  const p = g.turn;
  const moves = legalMoves(g.board, p, [pieceId], isFirstMove(g, p));
  state.selTurn = p;

  if (moves.length === 0) {
    state.sel = { pieceId, oi: 0, anchor: null };
    return;
  }

  const ref = state.lastAnchor || (g.lastMove ? anchorForCells(g.lastMove.cells) : START[p]);
  let best = moves[0];
  let bestDistance = Infinity;
  for (const move of moves) {
    const [r, c] = anchorForCells(move.cells);
    const distance = Math.abs(r - ref[0]) + Math.abs(c - ref[1]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = move;
    }
  }

  state.sel = {
    pieceId,
    oi: orientationIndexOf(pieceId, best.cells),
    anchor: anchorForCells(best.cells),
  };
}

/** 仮置きの見た目。置けない位置でも出して、なぜ置けないか分かるようにする。 */
export function currentGhost() {
  if (!state.sel || !state.sel.anchor || !canAct()) return null;
  const g = state.game;
  const p = g.turn;
  const cells = cellsAtAnchor(state.sel.pieceId, state.sel.oi, state.sel.anchor);
  return { cells, valid: canPlace(g.board, p, cells, isFirstMove(g, p)), player: p };
}
