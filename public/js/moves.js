/**
 * BLOCKS — 駒の選び方と向きの変え方
 *
 * どのピースをどこに、どの向きで仮置きしているかを動かす部分。
 * 盤に確定させる（＝手を進める）操作はここには無い。
 */

import { ORIENTATIONS, flippedOrientation, variantOf } from './rules.js';
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
  render();
}

/** 矢印キーで一マスずつ動かす。 */
export function moveAnchor(dr, dc) {
  if (!state.sel || !canAct()) return;

  const size = variantOf(state.game).size;
  const anchor = state.sel.anchor || [Math.floor(size / 2), Math.floor(size / 2)];
  const clamp = (v) => Math.min(Math.max(v, 0), size - 1);
  const next = [clamp(anchor[0] + dr), clamp(anchor[1] + dc)];

  state.sel.anchor = next;
  state.lastAnchor = next;
  updateBoard();
}
