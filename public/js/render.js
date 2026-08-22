/**
 * BLOCKS — 画面の組み立て
 *
 * 今の状態を見て、盤・持ちピース・下の一文を今あるべき姿にする。
 * 状態を変えることはしないので、どこから何度呼んでも結果は同じ。
 */

import { PIECE_SIZE, isFirstMove } from './rules.js';
import {
  buildTray,
  updateTray,
  updateTrayFocus,
  syncTraySpacers,
  centerPiece,
  centeredPiece,
  renderBoard,
} from './view.js';
import {
  state,
  canAct,
  labelFor,
  placeableSet,
  currentGhost,
  playerOfPanel,
  computeSelection,
} from './session.js';
import { $, $$ } from './ui.js';

const board = $('#board');
const statusLine = $('#status');
const panelNear = $('.panel-near');
const panelFar = $('.panel-far');

/** 持ちピースをつついたときの受け口。入力側が起動時に差し込む。 */
let onTrayTap = () => {};
export const setTrayTapHandler = (fn) => { onTrayTap = fn; };

/** 表示するパネルと、それぞれが並べる手札。 */
function panelList() {
  return state.mode === 'local'
    ? [{ node: panelNear, player: 1 }, { node: panelFar, player: 2 }]
    : [{ node: panelNear, player: state.myPlayer }];
}

/** いま手番のプレイヤーが使っているカルーセル。 */
function activeTray() {
  const useFar = state.mode === 'local' && state.game.turn === 2;
  return $('.tray', useFar ? panelFar : panelNear);
}

export const trayOfPanel = (isFar) => $('.tray', isFar ? panelFar : panelNear);

export function render() {
  const g = state.game;
  if (!g) return;

  // 手番が変わったら選びかけのピースは捨てる
  if (state.selTurn !== null && state.selTurn !== g.turn) {
    state.sel = null;
    state.selTurn = null;
  }

  buildPanels();

  // カルーセルは常に真ん中のピースを選んでいる状態にする。
  // 並べ直したあとでないと「真ん中」が求まらないので、この順番で行う。
  if (!state.sel && canAct()) {
    const id = centeredPiece(activeTray());
    if (id) computeSelection(id);
  }

  paintPanels();
  renderStatus();
  updateBoard();
}

/** 手札が変わったときだけカルーセルを組み直す。 */
function buildPanels() {
  const g = state.game;
  panelFar.hidden = state.mode !== 'local';

  for (const { node, player } of panelList()) {
    const tray = $('.tray', node);
    const hadContent = Boolean(tray.dataset.signature);
    const scrollBefore = tray.scrollLeft;

    const rebuilt = buildTray(tray, {
      hand: g.hands[player],
      player,
      onTap: (id) => onTrayTap(tray, id),
    });
    if (!rebuilt) continue;

    if (hadContent) {
      // 置いたピースが抜けた分だけ隣が寄ってくる。位置を保つと流れが途切れない
      tray.scrollLeft = scrollBefore;
    } else {
      // 最初は大きいピースから捌くのが定石なので、いちばん大きいものを真ん中に
      const largest = [...g.hands[player]].sort((a, b) => PIECE_SIZE[b] - PIECE_SIZE[a])[0];
      if (largest) {
        tray.dataset.autoScroll = '1';
        centerPiece(tray, largest, false);
      }
    }
  }
}

/** 選択の枠・置けないピースの色抜き・中央からの距離に応じた大きさ。 */
function paintPanels() {
  const g = state.game;

  for (const { node, player } of panelList()) {
    const mine = g.turn === player && canAct();
    node.classList.toggle('is-idle', !mine);

    const tray = $('.tray', node);
    syncTraySpacers(tray); // 画面の幅が変わっても端まで送れるように
    updateTray(tray, {
      selectedId: mine && state.sel ? state.sel.pieceId : null,
      orientationIndex: state.sel ? state.sel.oi : 0,
      player,
      placeable: mine ? placeableSet() : null,
    });
    updateTrayFocus(tray);
  }

  const canUndo = state.mode !== 'online' && state.history.length > 0;
  for (const button of $$('.js-undo')) button.hidden = !canUndo;
}

function renderStatus() {
  const g = state.game;

  if (g.status === 'finished') {
    statusLine.textContent = '対局終了';
    return;
  }
  if (state.mode === 'online' && state.online && !state.online.opponentJoined) {
    statusLine.textContent = '相手の参加を待っています…';
    return;
  }
  if (!canAct()) {
    statusLine.textContent = `${labelFor(g.turn)}が考えています…`;
    return;
  }

  const who = state.mode === 'local'
    ? `<b>${labelFor(g.turn)}の番</b>`
    : '<b>あなたの番</b>';

  // 回転と反転にボタンを置いていないので、やり方は常に添えておく
  let hint;
  if (state.sel && !placeableSet().has(state.sel.pieceId)) {
    hint = 'このピースは今は置けません';
  } else if (!state.sel || !state.sel.anchor) {
    hint = isFirstMove(g, g.turn)
      ? '自分の色の印を覆うように盤をタップ'
      : '盤をタップして置く場所を決めます';
  } else {
    hint = '駒をタップで回転・長押しで反転';
  }
  statusLine.innerHTML = `${who} ・ ${hint}`;
}

/** 盤と「置く」だけを更新する。なぞっている間はこれだけを回す。 */
export function updateBoard() {
  const ghost = currentGhost();
  renderBoard(board, state.game, ghost);

  // 「置く」は手番のパネルのものだけを生かす
  const ready = Boolean(ghost && ghost.valid) && !state.busy;
  for (const { node, player } of panelList()) {
    const mine = state.game.turn === player && canAct();
    $('.ctl-place', node).disabled = !(mine && ready);
  }
}

/** そのトレイが誰のものか。手番の切り替えで変わるので、その都度求める。 */
export const playerOfTray = (tray) => playerOfPanel(Boolean(tray.closest('.panel-far')));
