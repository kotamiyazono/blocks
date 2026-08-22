/**
 * BLOCKS — 指とキーボード
 *
 * 持ちピースのカルーセル、盤の上のなぞり／タップ／長押し、PC 用のキー操作。
 *
 * 盤の上の決まりごと:
 *   駒の外をさわる → その場へ駒を移す（そのままなぞって微調整できる）
 *   駒をなぞる     → 駒を動かす
 *   駒をタップ     → 回転
 *   駒を長押し     → 反転
 *   帯をなぞる     → 駒を相対移動
 */

import { cellFromPoint, centeredPiece, centerPiece, updateTrayFocus } from './view.js';
import { variantOf } from './rules.js';
import { state, canAct, currentGhost } from './session.js';
import { $, $$, onGameScreen, toast } from './ui.js';
import {
  setTrayTapHandler,
  trayOfPanel,
  padOfPanel,
  playerOfTray,
} from './render.js';
import { selectPiece, rotateSelection, flipSelection, moveAnchor, setAnchor, clearSelection } from './moves.js';

/** タップと長押しの境目。これを超えて押し続けたら反転とみなす。 */
const LONG_PRESS_MS = 420;
/** これだけ動いたら「なぞっている」と判断する。 */
const DRAG_SLOP = 8;

const board = $('#board');

/** 対局を進めるための処理は持ち主から渡してもらう。 */
let actions = { place: () => {}, undo: () => {} };

export function initInput(handlers) {
  actions = handlers;
  setTrayTapHandler(tapPiece);
  for (const isFar of [false, true]) setupCarousel(trayOfPanel(isFar));
  setupTrackpads();
  setupBoard();
  setupKeyboard();
  setupPlaceButtons();
}

/* ==========================================================================
   持ちピースのカルーセル
   真ん中に来たものがそのまま選択になる。スクロールが止まったところで確定する。
   ========================================================================== */

function setupCarousel(tray) {
  let frame = null;
  let settle = null;

  // こちらから送った分のスクロールで選択を上書きしないための目印。
  // 指が触れた時点で「本人が動かしている」と判断して外す。
  const handOver = () => { delete tray.dataset.autoScroll; };
  tray.addEventListener('pointerdown', handOver, { passive: true });
  tray.addEventListener('wheel', handOver, { passive: true });

  tray.addEventListener('scroll', () => {
    // 大きさと濃さは指の動きにそのまま追従させる
    if (frame === null) {
      frame = requestAnimationFrame(() => {
        frame = null;
        updateTrayFocus(tray);
      });
    }
    // 止まったところで選択を確定する
    clearTimeout(settle);
    settle = setTimeout(() => {
      if (tray.dataset.autoScroll) return; // こちらから送った分は選択に触れない
      if (!state.game || state.game.turn !== playerOfTray(tray) || !canAct()) return;
      const id = centeredPiece(tray);
      if (!id || (state.sel && state.sel.pieceId === id)) return;
      selectPiece(id);
    }, 110);
  }, { passive: true });

  // 真ん中のピースはタップで回転、長押しで反転
  attachRotateGestures(tray, {
    find: (event) => event.target.closest('.tile'),
    accept: (tile) => Boolean(state.sel) && tile.dataset.piece === state.sel.pieceId,
  });
}

/** カルーセルのピースをつつく。真ん中のものなら回転、そうでなければ真ん中へ送る。 */
function tapPiece(tray, pieceId) {
  if (!canAct() || state.game.turn !== playerOfTray(tray)) {
    toast(state.mode === 'solo' ? 'CPU の番です' : '相手の番です');
    return;
  }
  if (state.sel && state.sel.pieceId === pieceId) return; // 回転はジェスチャ側で処理する

  // スクロールの到着を待たずにその場で選ぶ（待たされる感じを無くす）
  tray.dataset.autoScroll = '1';
  centerPiece(tray, pieceId);
  selectPiece(pieceId);
}

/* ==========================================================================
   タップ＝回転 / 長押し＝反転
   押しっぱなしを先に判定するので、回転のタップに待ち時間が入らない。
   ========================================================================== */

function attachRotateGestures(root, { find, accept }) {
  let press = null;

  root.addEventListener('pointerdown', (event) => {
    if (!canAct()) return;
    if (press) {
      clearTimeout(press.timer);
      press = null;
    }
    const hit = find(event);
    if (!hit || !accept(hit)) return;

    press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      fired: false,
      timer: setTimeout(() => {
        if (!press || press.moved) return;
        press.fired = true;
        flipSelection();
      }, LONG_PRESS_MS),
    };
  });

  root.addEventListener('pointermove', (event) => {
    if (!press || event.pointerId !== press.id || press.moved) return;
    if (!canAct() || !state.sel) {
      clearTimeout(press.timer);
      press = null;
      return;
    }
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_SLOP) return;
    press.moved = true;
    clearTimeout(press.timer);
  });

  const finish = (event) => {
    if (!press || event.pointerId !== press.id) return;
    clearTimeout(press.timer);
    const { moved, fired } = press;
    press = null;
    if (!moved && !fired) rotateSelection();
  };

  root.addEventListener('pointerup', finish);
  root.addEventListener('pointercancel', finish);
  root.addEventListener('lostpointercapture', finish);
}

/* ==========================================================================
   盤の上
   ========================================================================== */

function setupBoard() {
  let drag = null;

  board.addEventListener('pointerdown', (event) => {
    if (!canAct() || !state.sel) return;

    const rc = cellFromPoint(board, event.clientX, event.clientY, variantOf(state.game).size);
    if (!rc) return;
    event.preventDefault();
    // 指が盤の外に出ても追い続ける。捕捉できない環境でも操作自体は成立する
    try { board.setPointerCapture(event.pointerId); } catch { /* 続行してよい */ }

    const ghost = currentGhost();
    const onGhost = Boolean(ghost && ghost.cells.some(([r, c]) => r === rc[0] && c === rc[1]));

    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      onGhost,
      flipped: false,
      timer: onGhost
        ? setTimeout(() => {
            if (!drag || drag.moved) return;
            drag.flipped = true;
            flipSelection();
          }, LONG_PRESS_MS)
        : null,
    };

    // 駒の外を触ったときは待たせずその場へ持ってくる
    if (!onGhost) setAnchor(rc);
  });

  board.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id || !canAct() || !state.sel) return;

    if (!drag.moved) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_SLOP) return;
      drag.moved = true;
      clearTimeout(drag.timer);
    }

    const rc = cellFromPoint(board, event.clientX, event.clientY, variantOf(state.game).size);
    if (rc) setAnchor(rc);
  });

  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    clearTimeout(drag.timer);
    const { moved, onGhost, flipped } = drag;
    drag = null;
    if (!moved && !flipped && onGhost) rotateSelection();
  };

  board.addEventListener('pointerup', endDrag);
  board.addEventListener('pointercancel', endDrag);
}

/* ==========================================================================
   相対移動の帯
   ========================================================================== */

function setupTrackpads() {
  for (const isFar of [false, true]) setupTrackpad(padOfPanel(isFar));
}

function setupTrackpad(pad) {
  let drag = null;

  attachRotateGestures(pad, {
    find: () => pad,
    accept: () => Boolean(state.sel),
  });

  pad.addEventListener('pointerdown', (event) => {
    if (!canAct() || !state.sel) return;
    if (drag) {
      drag = null;
      pad.classList.remove('is-active');
    }
    event.preventDefault();
    try { pad.setPointerCapture(event.pointerId); } catch { /* 続行してよい */ }
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      ax: 0,
      ay: 0,
      step: (board.getBoundingClientRect().width + parseFloat(getComputedStyle(board).columnGap))
        / variantOf(state.game).size,
    };
    pad.classList.add('is-active');
  });

  pad.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!canAct() || !state.sel) {
      drag = null;
      pad.classList.remove('is-active');
      return;
    }
    drag.ax += event.clientX - drag.x;
    drag.ay += event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!state.sel.anchor) return;
    const dc = Math.trunc(drag.ax / drag.step);
    const dr = Math.trunc(drag.ay / drag.step);
    if (!dr && !dc) return;
    drag.ax -= dc * drag.step;
    drag.ay -= dr * drag.step;
    moveAnchor(dr, dc);
  });

  const end = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
    pad.classList.remove('is-active');
  };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
  pad.addEventListener('lostpointercapture', end);
}

/* ==========================================================================
   キーボード（PC で遊ぶとき用）
   ========================================================================== */

function setupKeyboard() {
  const keys = {
    ArrowUp: () => moveAnchor(-1, 0),
    ArrowDown: () => moveAnchor(1, 0),
    ArrowLeft: () => moveAnchor(0, -1),
    ArrowRight: () => moveAnchor(0, 1),
    r: rotateSelection,
    f: flipSelection,
    Enter: () => actions.place(),
    ' ': () => actions.place(),
    z: () => actions.undo(),
    Escape: clearSelection,
  };

  document.addEventListener('keydown', (event) => {
    if (!onGameScreen()) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // ひとことを打っている最中は、盤の操作キーとして横取りしない
    if (event.target instanceof HTMLInputElement) return;

    const handler = keys[event.key] || keys[event.key.toLowerCase()];
    if (!handler) return;
    event.preventDefault();
    handler();
  });
}

/* ==========================================================================
   「置く」（手前・向かい側どちらのパネルからでも同じ処理）
   ========================================================================== */

function setupPlaceButtons() {
  for (const panel of $$('.panel')) {
    panel.addEventListener('click', (event) => {
      if (event.target.closest('.ctl-place')) actions.place();
    });
  }
}
