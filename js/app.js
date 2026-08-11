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

import {
  VARIANTS, applyMove, canPlace, cellsAtAnchor, createGame,
  isFirstMove, result, variantOf,
} from './rules.js';
import { chooseMove } from './ai.js';
import { buildBoard } from './view.js';
import { state, canAct, labelFor, isCpuSeat } from './session.js';
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
  runCpuSeatIfHost,
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
  state.game = options.game || createGame(options.variant);
  state.seats = variantOf(state.game).players;
  state.cpuSeats = options.cpuSeats || [];
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
  buildBoard(board, variantOf(state.game));
  hideResult();
  showScreen('screen-game');
  render();

  maybeRunCpu();
}

/** CPU が受け持つ席の番になっていたら、少し間を置いて打たせる。 */
function maybeRunCpu() {
  const g = state.game;
  if (!g || g.status !== 'playing') return;
  if (!isCpuSeat(g.turn)) return;

  if (state.mode === 'solo') scheduleCpu();
  else if (state.mode === 'online') runCpuSeatIfHost();
}

/* ========================================================================
   一手を進める
   ======================================================================== */

async function placeSelection() {
  if (!canAct() || !state.sel || !state.sel.anchor) return;

  const g = state.game;
  const v = variantOf(g);
  const p = g.turn;
  const cells = cellsAtAnchor(v, state.sel.pieceId, state.sel.oi, state.sel.anchor);
  if (!canPlace(v, g.board, p, cells, isFirstMove(g, p))) return;

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
  notifyPass(next.passedBy);
  maybeRunCpu();
}

/** 置ける場所が無くて手番を飛ばされた人がいることを知らせる。 */
function notifyPass(skipped) {
  if (!skipped || skipped.length === 0) return;

  if (skipped.includes(state.myPlayer) && state.mode !== 'local') {
    toast('あなたは置ける場所が無いので飛ばされました');
    return;
  }
  const names = skipped.map(labelFor).join('・');
  toast(`${names}は置ける場所が無いので飛ばされました`);
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

  // 残りマスの少ない順に並べる。人数が変わるので毎回組み立て直す
  const rows = document.createDocumentFragment();
  for (const player of scores.ranking) {
    const row = document.createElement('div');
    row.className = 'result-row' + (scores.leaders.includes(player) ? ' is-winner' : '');

    const chip = document.createElement('i');
    chip.className = `chip seat-${player}`;
    const name = document.createElement('span');
    name.className = 'result-name';
    name.textContent = labelFor(player);
    const num = document.createElement('b');
    num.textContent = String(scores.remaining[player]);

    row.append(chip, name, num);
    rows.appendChild(row);
  }
  $('#result-rows').replaceChildren(rows);

  const badge = $('#result-badge');
  const title = $('#result-title');
  const draw = scores.winner === 0;

  if (state.mode === 'local') {
    badge.textContent = draw ? 'DRAW' : 'WIN';
    badge.classList.toggle('is-win', !draw);
    title.textContent = draw ? '引き分け' : `${labelFor(scores.winner)}の勝ち`;
  } else {
    const won = scores.winner === state.myPlayer;
    badge.textContent = draw ? 'DRAW' : won ? 'YOU WIN' : 'YOU LOSE';
    badge.classList.toggle('is-win', won);
    if (draw) title.textContent = '引き分け';
    else if (won) title.textContent = 'あなたの勝ち';
    else title.textContent = state.seats > 2
      ? `${scores.ranking.indexOf(state.myPlayer) + 1}位（${labelFor(scores.winner)}の勝ち）`
      : 'あなたの負け';
  }

  rematchButton.textContent = state.mode === 'online' ? 'もう一局さそう' : 'もう一度';
  sheetResult.hidden = false;
}

rematchButton.addEventListener('click', async () => {
  hideResult();

  if (state.mode === 'solo') {
    beginGame('solo', soloSetup());
    return;
  }
  if (state.mode === 'local') {
    beginGame('local');
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

/** ひとりプレーの設定。4 人戦のときは自分が先手で、残り 3 席を CPU が持つ。 */
function soloSetup() {
  const seats = state.seats === 4 ? 4 : 2;
  const mySeat = seats === 4 ? 1 : state.side;
  const cpuSeats = [];
  for (let p = 1; p <= seats; p++) if (p !== mySeat) cpuSeats.push(p);

  return {
    variant: seats === 4 ? VARIANTS.four.id : VARIANTS.duo.id,
    myPlayer: mySeat,
    cpuSeats,
  };
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
wireSegmented('#solo-seats', 'seats', Number);
wireSegmented('#online-seats', 'seats', Number);

/** 手番を選べるのは 2 人戦のときだけ（4 人戦は自分が先手で固定）。 */
function syncSeatFields() {
  $('#side-field').hidden = state.seats !== 2;
}
for (const id of ['#solo-seats', '#online-seats']) {
  $(id).addEventListener('click', syncSeatFields);
}

/** 人数の選択を今の状態に合わせて塗り直す（画面を開き直したとき用）。 */
function paintSeatPickers() {
  for (const id of ['#solo-seats', '#online-seats']) {
    for (const button of $$(`${id} button`)) {
      const on = Number(button.dataset.value) === state.seats;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-checked', String(on));
    }
  }
  syncSeatFields();
}

$('#btn-solo-start').addEventListener('click', () => {
  beginGame('solo', soloSetup());
});

/* ========================================================================
   画面まわりの配線
   ======================================================================== */

for (const button of $$('[data-mode]')) {
  button.addEventListener('click', () => {
    const mode = button.dataset.mode;
    if (mode === 'local') {
      beginGame('local');
      toast('端末を机に置いて、向かい合わせに座ってください', 4000);
    } else {
      paintSeatPickers();
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

const invited = location.hash.replace('#', '').trim().toUpperCase();
if (/^[A-Z0-9]{4}$/.test(invited)) enterByCode(invited);
else showScreen('screen-home');
