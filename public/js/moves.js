/**
 * BLOCKS — 駒の選び方と向きの変え方
 *
 * どのピースをどこに、どの向きで仮置きしているかを動かす部分。
 * 盤に確定させる（＝手を進める）操作はここには無い。
 */

import { ORIENTATIONS, flippedOrientation, nudgeAnchor, variantOf } from './rules.js';
import { state, canAct, computeSelection } from './session.js';
import { toast } from './ui.js';
import { render, updateBoard } from './render.js';

export function selectPiece(pieceId) {
  if (!canAct()) return;
  computeSelection(pieceId);
  render();
}

export function clearSelection() {
  state.sel = null;
  state.selTurn = null;
  render();
}

/**
 * 向きをひとつ進める。回転 4 通りのあとに反転した 4 通りが続くので、
 * タップを繰り返すだけで取りうる向きを全部見られる。
 */
export function rotateSelection() {
  if (!state.sel || !canAct()) return;

  const orientations = ORIENTATIONS[state.sel.pieceId].length;
  if (orientations <= 1) {
    toast('このピースは向きがひとつだけです');
    return;
  }
  state.sel.oi = (state.sel.oi + 1) % orientations;
  normalizeAnchor();
  render();
}

/** 長押しの近道。左右反転した向きへ一足飛びに移る。 */
export function flipSelection() {
  if (!state.sel || !canAct()) return;

  const flipped = flippedOrientation(state.sel.pieceId, state.sel.oi);
  if (flipped === state.sel.oi) {
    toast('このピースは裏返しても同じ形です');
    return;
  }
  state.sel.oi = flipped;
  normalizeAnchor();
  render();
}

function normalizeAnchor() {
  if (!state.sel.anchor) return;
  const v = variantOf(state.game);
  state.sel.anchor = nudgeAnchor(v, state.sel.pieceId, state.sel.oi, state.sel.anchor, 0, 0);
}

function applyAnchor(from, dr, dc) {
  const first = !state.sel.anchor;
  const v = variantOf(state.game);
  const next = nudgeAnchor(v, state.sel.pieceId, state.sel.oi, from, dr, dc);
  state.sel.anchor = next;
  if (first) render();
  else updateBoard();
}

/** 盤をタップして仮置きの位置を決める。 */
export function setAnchor(rc) {
  if (state.sel && canAct()) applyAnchor(rc, 0, 0);
}

/** 矢印キーとトラックパッドで一マスずつ動かす。 */
export function moveAnchor(dr, dc) {
  if (!state.sel || !canAct()) return;

  const size = variantOf(state.game).size;
  applyAnchor(state.sel.anchor || [Math.floor(size / 2), Math.floor(size / 2)], dr, dc);
}
