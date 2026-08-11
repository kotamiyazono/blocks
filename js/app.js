/**
 * BLOCKS — 対局の進行と画面のつなぎ
 *
 * 3 つの遊び方（ひとり / 対面 / オンライン）をひとつの対局ループにまとめ、
 * 画面の行き来を配線する。役割はそれぞれ別のファイルに分けてある。
 *
 *   rules.js    ルール（サーバも同じものを読む）
 *   ai.js       CPU の思考
 *   palette.js  駒の色
 *   session.js  今の対局の状態
 *   view.js     盤と持ちピースの描画
 *   render.js   状態を画面に映す
 *   moves.js    駒の選択と向き
 *   input.js    指とキーボード
 *   online.js   通信
 *   room.js     オンライン対戦の段取り
 */

import { applyMove, canPlace, cellsAtAnchor, createGame, isFirstMove, result } from './rules.js';
import { chooseMove } from './ai.js';
import { applyColors, buildSwatches, partnerFor } from './palette.js';
import { buildBoard } from './view.js';
import {
  state,
  choice,
  canAct,
  labelFor,
  rememberMyColor,
  rememberLocalColors,
} from './session.js';
import { $, $$, showScreen, toast } from './ui.js';
import { render } from './render.js';
import { initInput } from './input.js';
import {
  initRoom,
  enterByCode,
  placeOnline,
  prepareChat,
  rematchOnline,
  closeRoom,
  stopWatcher,
} from './room.js';

const sheetRules = $('#sheet-rules');
const sheetResult = $('#sheet-result');
const rematchButton = $('#btn-rematch');
const board = $('#board');

/* ========================================================================
   対局の開始
   ======================================================================== */

function beginGame(mode, options = {}) {
  clearTimeout(cpuTimer);

  state.mode = mode;
  // 色は見た目だけの話なので、盤を組む前に当てておけば以降どこにも影響しない
  applyColors(options.colors?.[1], options.colors?.[2]);

  state.game = options.game || createGame();
  state.myPlayer = options.myPlayer || 1;
  state.sel = null;
  state.selTurn = null;
  state.lastAnchor = null;
  state.history = [];
  state.placeable = null;
  state.busy = false;
  state.quitArmed = false;

  document.body.classList.remove('mode-solo', 'mode-local', 'mode-online');
  document.body.classList.add(`mode-${mode}`);

  prepareChat(mode, state.myPlayer);
  buildBoard(board);
  hideResult();
  showScreen('screen-game');
  render();

  if (mode === 'solo' && state.game.turn !== state.myPlayer) scheduleCpu();
}

/* ========================================================================
   一手を進める
   ======================================================================== */

async function placeSelection() {
  if (!canAct() || !state.sel || !state.sel.anchor) return;

  const g = state.game;
  const p = g.turn;
  const cells = cellsAtAnchor(state.sel.pieceId, state.sel.oi, state.sel.anchor);
  if (!canPlace(g.board, p, cells, isFirstMove(g, p))) return;

  state.lastAnchor = state.sel.anchor;

  if (state.mode === 'online') {
    await placeOnline(state.sel.pieceId, cells);
  } else {
    state.history.push(structuredClone(g));
    commit(applyMove(g, p, state.sel.pieceId, cells));
  }
}

/** 適用後の共通処理。飛ばされた側への知らせと、CPU の手番送りをここに集約する。 */
function commit(next) {
  state.game = next;
  state.sel = null;
  state.selTurn = null;
  render();

  if (next.status === 'finished') {
    showResult();
    return;
  }
  if (next.passedBy) notifyPass(next.passedBy);
  if (state.mode === 'solo' && next.turn !== state.myPlayer) scheduleCpu();
}

/** 置ける場所が無くて手番を飛ばされた人がいることを知らせる。 */
function notifyPass(skipped) {
  const mine = state.mode !== 'local' && skipped === state.myPlayer;
  toast(mine
    ? 'あなたは置ける場所が無いので飛ばされました'
    : `${labelFor(skipped)}は置ける場所が無いので飛ばされました`);
}

let cpuTimer = null;

function scheduleCpu() {
  clearTimeout(cpuTimer);
  cpuTimer = setTimeout(() => {
    const g = state.game;
    if (!g || g.status !== 'playing' || state.mode !== 'solo') return;
    if (g.turn === state.myPlayer) return;

    const move = chooseMove(g, g.turn, state.level);
    if (!move) return; // applyMove がパスを扱うのでここには来ない想定
    commit(applyMove(g, g.turn, move.pieceId, move.cells));
  }, 520);
}

function undo() {
  if (state.mode === 'online' || state.history.length === 0) return;
  clearTimeout(cpuTimer);

  state.game = state.history.pop();
  state.sel = null;
  state.selTurn = null;
  state.placeable = null;
  hideResult();
  render();
  toast('一手もどしました');
}

/* ========================================================================
   結果
   ======================================================================== */

const hideResult = () => { sheetResult.hidden = true; };

function showResult() {
  // オンラインでは相手が「もう一局」を選んだのを受け取りたいので、見に行くのは止めない
  const scores = result(state.game);

  for (const row of $$('#sheet-result .result-row')) {
    const player = Number(row.dataset.player);
    $('.result-name', row).textContent = labelFor(player);
    $('.result-num', row).textContent = String(scores[player]);
    row.classList.toggle('is-winner', scores.winner === player);
  }

  const badge = $('#result-badge');
  const title = $('#result-title');

  if (state.mode === 'local') {
    badge.textContent = scores.winner === 0 ? 'DRAW' : 'WIN';
    badge.classList.toggle('is-win', scores.winner !== 0);
    title.textContent = scores.winner === 0 ? '引き分け' : `${labelFor(scores.winner)}の勝ち`;
  } else {
    const won = scores.winner === state.myPlayer;
    badge.textContent = scores.winner === 0 ? 'DRAW' : won ? 'YOU WIN' : 'YOU LOSE';
    badge.classList.toggle('is-win', won);
    title.textContent = scores.winner === 0 ? '引き分け' : won ? 'あなたの勝ち' : 'あなたの負け';
  }

  rematchButton.textContent = state.mode === 'online' ? 'もう一局さそう' : 'もう一度';
  sheetResult.hidden = false;
}

rematchButton.addEventListener('click', async () => {
  hideResult();

  if (state.mode === 'solo') {
    beginGame('solo', { myPlayer: state.myPlayer, colors: soloColors() });
    return;
  }
  if (state.mode === 'local') {
    beginGame('local', { colors: { ...choice.local } });
    return;
  }

  rematchButton.disabled = true;
  try {
    await rematchOnline();
    toast('相手にも新しい盤面が届きます');
  } catch (error) {
    toast(error.message);
    sheetResult.hidden = false;
  }
  rematchButton.disabled = false;
});

async function goHome() {
  clearTimeout(cpuTimer);
  stopWatcher();

  if (state.mode === 'online' && state.online) await closeRoom();

  state.game = null;
  state.mode = null;
  hideResult();
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  showScreen('screen-home');
}

/* ========================================================================
   はじめる前の設定
   ======================================================================== */

/** ひとりプレーの色。自分が選んだ色を自分の側に、CPU にはそれと違う色を当てる。 */
function soloColors() {
  const cpuColor = partnerFor(choice.mine);
  return state.side === 1
    ? { 1: choice.mine, 2: cpuColor }
    : { 1: cpuColor, 2: choice.mine };
}

/** 段組みの選択（CPU の強さ・手番）。押されたものだけを点ける。 */
function wireSegmented(id, key, parse = String) {
  $(id).addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (!button) return;
    state[key] = parse(button.dataset.value);
    for (const other of $$(`${id} button`)) {
      const on = other === button;
      other.classList.toggle('is-on', on);
      other.setAttribute('aria-checked', String(on));
    }
  });
}

wireSegmented('#level-picker', 'level');
wireSegmented('#side-picker', 'side', Number);

/** 自分の色を選ぶ見本（ひとり・オンライン共通）。 */
function renderMyColorPickers() {
  for (const id of ['#solo-colors', '#online-colors']) {
    buildSwatches($(id), {
      selected: choice.mine,
      onPick: (picked) => {
        rememberMyColor(picked);
        renderMyColorPickers();
      },
    });
  }
}

/** 対面での先手・後手の色。同じ色を選んだら入れ替える。 */
function renderLocalColorPickers() {
  for (const player of [1, 2]) {
    buildSwatches($(`#local-colors-${player}`), {
      selected: choice.local[player],
      onPick: (picked) => {
        const other = player === 1 ? 2 : 1;
        if (choice.local[other] === picked) choice.local[other] = choice.local[player];
        choice.local[player] = picked;
        rememberLocalColors();
        renderLocalColorPickers();
      },
    });
  }
}

$('#btn-solo-start').addEventListener('click', () => {
  beginGame('solo', { myPlayer: state.side, colors: soloColors() });
});

$('#btn-local-start').addEventListener('click', () => {
  beginGame('local', { colors: { ...choice.local } });
});

/* ========================================================================
   画面まわりの配線
   ======================================================================== */

for (const button of $$('[data-mode]')) {
  button.addEventListener('click', () => {
    const mode = button.dataset.mode;
    if (mode === 'local') {
      renderLocalColorPickers();
      showScreen('screen-local');
    } else {
      renderMyColorPickers();
      showScreen(mode === 'solo' ? 'screen-solo' : 'screen-online');
    }
  });
}

for (const button of $$('[data-back]')) {
  button.addEventListener('click', () => showScreen('screen-home'));
}

$('#btn-rules').addEventListener('click', () => { sheetRules.hidden = false; });
for (const button of $$('[data-close-sheet]')) {
  button.addEventListener('click', () => { sheetRules.hidden = true; });
}
sheetRules.addEventListener('click', (event) => {
  if (event.target === sheetRules) sheetRules.hidden = true;
});

$('#btn-home').addEventListener('click', goHome);
for (const button of $$('.js-undo')) button.addEventListener('click', undo);

// 誤って対局を終わらせないよう、二度押しで確定させる
for (const button of $$('.js-quit')) {
  button.addEventListener('click', () => {
    if (!state.quitArmed) {
      state.quitArmed = true;
      toast('もう一度押すと対局を終わります');
      setTimeout(() => { state.quitArmed = false; }, 3000);
      return;
    }
    goHome();
  });
}

/* ========================================================================
   起動
   ======================================================================== */

initInput({ place: placeSelection, undo });
initRoom({ beginGame, goHome, showResult, notifyPass, hideResult });

// ホームの印も前回選んだ色で出す
applyColors(choice.mine, partnerFor(choice.mine));

const invited = location.hash.replace('#', '').trim().toUpperCase();
if (/^[A-Z0-9]{4}$/.test(invited)) enterByCode(invited);
else showScreen('screen-home');
