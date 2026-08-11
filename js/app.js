/**
 * BLOCKS — アプリ本体
 *
 * 画面遷移と、3 つの遊び方（ひとり / 対面 / オンライン）をひとつの対局ループにまとめる部分。
 * 手の合法性は rules.js、盤面の見た目は view.js、通信は online.js に任せている。
 */

import {
  N,
  START,
  ORIENTATIONS,
  PIECE_SIZE,
  createGame,
  applyMove,
  canPlace,
  isFirstMove,
  legalMoves,
  cellsAtAnchor,
  flippedOrientation,
  orientationIndexOf,
  anchorForCells,
  remainingSquares,
  result,
} from './rules.js';
import { chooseMove } from './ai.js';
import {
  buildBoard,
  renderBoard,
  cellFromPoint,
  buildTray,
  updateTray,
  updateTrayFocus,
  syncTraySpacers,
  centeredPiece,
  centerPiece,
} from './view.js';
import {
  createRoom,
  joinRoom,
  fetchRoom,
  sendMove,
  leaveRoom,
  requestRematch,
  sendChat,
  RoomWatcher,
} from './online.js';

/* ========================================================================
   状態
   ======================================================================== */

const state = {
  mode: null,          // 'solo' | 'local' | 'online'
  game: null,
  myPlayer: 1,         // ひとり／オンラインで自分が持つ色
  level: 'normal',
  sel: null,           // { pieceId, oi, anchor }
  selTurn: null,       // 選択がどの手番のものか（手番が変わったら捨てる）
  lastAnchor: null,    // 次のピースを近くに出すための手がかり
  history: [],         // 待った用（ひとり／対面のみ）
  placeable: null,     // { key, set } 置けるピースの一覧をキャッシュ
  busy: false,         // 送信中はボタンを止める
  online: null,        // { code, token, player, seq, watcher }
  quitArmed: false,
};

const STORAGE_KEY = 'blocks:room';

/* ========================================================================
   DOM
   ======================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const el = {
  screens: $$('.screen'),
  board: $('#board'),
  status: $('#status'),
  panelNear: $('.panel-near'),
  panelFar: $('.panel-far'),
  toast: $('#toast'),
  sheetRules: $('#sheet-rules'),
  sheetResult: $('#sheet-result'),
  undo: $$('.js-undo'),
  quit: $$('.js-quit'),
  inviteUrl: $('#invite-url'),
  onlineError: $('#online-error'),
  joiningNote: $('#joining-note'),
  joiningError: $('#joining-error'),
  joiningBack: $('#btn-joining-back'),
  waitingNote: $('#waiting-note'),
  rematch: $('#btn-rematch'),
  chat: $('#chat'),
  chatInput: $('#chat-input'),
  chatThem: $('#chat-them'),
  chatThemText: $('#chat-them-text'),
  chatThemChip: $('#chat-them-chip'),
  chatMyChip: $('#chat-my-chip'),
};

function showScreen(id) {
  for (const screen of el.screens) screen.classList.toggle('is-active', screen.id === id);
}

let toastTimer = null;
function toast(message, ms = 2400) {
  el.toast.textContent = message;
  el.toast.classList.add('is-shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('is-shown'), ms);
}

/* ========================================================================
   対局のうつわ
   ======================================================================== */

/** いま盤に向かっているプレイヤー（＝手番）。 */
const actor = () => state.game.turn;

/** 手元の操作を受け付けてよいか。 */
function canAct() {
  const g = state.game;
  if (!g || g.status !== 'playing' || state.busy) return false;
  if (state.mode === 'local') return true;
  return g.turn === state.myPlayer;
}

/** 表示名。モードによって呼び方を変える。 */
function labelFor(player) {
  if (state.mode === 'local') return player === 1 ? '先手' : '後手';
  if (player === state.myPlayer) return 'あなた';
  return state.mode === 'solo' ? 'CPU' : '相手';
}

/** 今の手番で置けるピースの一覧。手番ごとに一度だけ計算する。 */
function placeableSet() {
  const g = state.game;
  const key = `${g.moveCount}:${g.turn}`;
  if (state.placeable && state.placeable.key === key) return state.placeable.set;

  const p = g.turn;
  const moves = legalMoves(g.board, p, g.hands[p], isFirstMove(g, p));
  const set = new Set(moves.map((m) => m.pieceId));
  state.placeable = { key, set };
  return set;
}

/** 仮置きの見た目。置けない位置でも赤く出して、なぜ置けないか分かるようにする。 */
function currentGhost() {
  if (!state.sel || !state.sel.anchor || !canAct()) return null;
  const p = actor();
  const cells = cellsAtAnchor(state.sel.pieceId, state.sel.oi, state.sel.anchor);
  return { cells, valid: canPlace(state.game.board, p, cells, isFirstMove(state.game, p)), player: p };
}

/* ========================================================================
   描画
   ======================================================================== */

function render() {
  const g = state.game;
  if (!g) return;

  // 手番が変わったら選びかけのピースは捨てる
  if (state.selTurn !== null && state.selTurn !== g.turn) {
    state.sel = null;
    state.selTurn = null;
  }

  buildPanels();
  // カルーセルは常に真ん中のピースを選んでいる状態にする
  if (!state.sel && canAct()) {
    const id = centeredPiece(activeTray());
    if (id) computeSelection(id);
  }
  paintPanels();

  renderStatus();
  updateBoard();
}

/** いま手番のプレイヤーが使っているカルーセル。 */
function activeTray() {
  const useFar = state.mode === 'local' && state.game.turn === 2;
  return $('.tray', useFar ? el.panelFar : el.panelNear);
}

/** 表示するパネルと、それぞれが並べる手札を決める。 */
function panelList() {
  return state.mode === 'local'
    ? [{ node: el.panelNear, player: 1 }, { node: el.panelFar, player: 2 }]
    : [{ node: el.panelNear, player: state.myPlayer }];
}

/** 手札が変わったときだけカルーセルを組み直す。 */
function buildPanels() {
  const g = state.game;
  el.panelFar.hidden = state.mode !== 'local';

  for (const { node, player } of panelList()) {
    const tray = $('.tray', node);
    setupCarousel(tray, player);

    const hadContent = Boolean(tray.dataset.signature);
    const scrollBefore = tray.scrollLeft;

    const rebuilt = buildTray(tray, {
      hand: g.hands[player],
      player,
      onTap: (id) => tapPiece(tray, player, id),
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

/** 選択の枠・置けないピースの色抜き・中央からの距離に応じた大きさを反映する。 */
function paintPanels() {
  const g = state.game;

  for (const { node, player } of panelList()) {
    const mine = g.turn === player && canAct();
    node.classList.toggle('is-idle', !mine);

    const tray = $('.tray', node);
    syncTraySpacers(tray); // 画面の向きやモードで幅が変わっても端まで送れるように
    updateTray(tray, {
      selectedId: mine && state.sel ? state.sel.pieceId : null,
      orientationIndex: state.sel ? state.sel.oi : 0,
      player,
      placeable: mine ? placeableSet() : null,
    });
    updateTrayFocus(tray);
  }

  const canUndo = state.mode !== 'online' && state.history.length > 0;
  for (const button of el.undo) button.hidden = !canUndo;
}

function renderStatus() {
  const g = state.game;

  if (g.status === 'finished') {
    el.status.textContent = '対局終了';
    return;
  }

  if (state.mode === 'online' && state.online && !state.online.opponentJoined) {
    el.status.textContent = '相手の参加を待っています…';
    return;
  }

  if (!canAct()) {
    el.status.textContent = state.mode === 'solo' ? 'CPU が考えています…' : '相手が考えています…';
    return;
  }

  const who = state.mode === 'local' ? `<b>${labelFor(g.turn)}の番</b>` : '<b>あなたの番</b>';

  // 回転と反転にボタンを置いていないので、やり方は常に添えておく
  let hint;
  if (state.sel && !placeableSet().has(state.sel.pieceId)) {
    hint = 'このピースは今は置けません';
  } else if (isFirstMove(g, g.turn)) {
    hint = '印を覆うように置く ・ タップで回転';
  } else {
    hint = '駒をタップで回転・長押しで反転';
  }
  el.status.innerHTML = `${who} ・ ${hint}`;
}

/** 盤面と「置く」ボタンだけを更新する。ドラッグ中はこれだけを回す。 */
function updateBoard() {
  const ghost = currentGhost();
  renderBoard(el.board, state.game, ghost);

  // 「置く」は手番のパネルのものだけを生かす
  const ready = Boolean(ghost && ghost.valid) && !state.busy;
  for (const { node, player } of panelList()) {
    const mine = state.game.turn === player && canAct();
    $('.ctl-place', node).disabled = !(mine && ready);
  }
}

/* ========================================================================
   操作
   ======================================================================== */

/**
 * 選ばれたピースを、置ける場所のうち直前に触っていた位置のいちばん近くに出す。
 * 画面の更新はしないので、呼んだ側で render() する。
 */
function computeSelection(pieceId) {
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

function selectPiece(pieceId) {
  if (!canAct()) return;
  computeSelection(pieceId);
  render();
}

/**
 * 向きをひとつ進める。回転 4 通りのあとに反転した 4 通りが続くので、
 * タップを繰り返すだけで取りうる向きを全部見られる。
 */
function rotateSelection() {
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
function flipSelection() {
  if (!state.sel || !canAct()) return;
  const flipped = flippedOrientation(state.sel.pieceId, state.sel.oi);
  if (flipped === state.sel.oi) {
    toast('このピースは裏返しても同じ形です');
    return;
  }
  state.sel.oi = flipped;
  render();
}

/* ========================================================================
   持ちピースのカルーセル
   真ん中に来たものがそのまま選択になる。スクロールが止まったところで確定する。
   ======================================================================== */

const carouselReady = new WeakSet();

function setupCarousel(tray, player) {
  if (carouselReady.has(tray)) return;
  carouselReady.add(tray);

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
      if (!state.game || state.game.turn !== player || !canAct()) return;
      const id = centeredPiece(tray);
      if (!id || (state.sel && state.sel.pieceId === id)) return;
      selectPiece(id);
    }, 110);
  }, { passive: true });

  // 真ん中のピースはタップで回転、長押しで反転
  attachRotateGestures(tray, {
    target: (event) => event.target.closest('.tile'),
    accept: (tile) => Boolean(state.sel) && tile.dataset.piece === state.sel.pieceId,
  });
}

/** カルーセルのピースをつつく。真ん中のものなら回転、そうでなければ真ん中へ送る。 */
function tapPiece(tray, player, pieceId) {
  if (!canAct() || state.game.turn !== player) {
    toast(state.mode === 'solo' ? 'CPU の番です' : '相手の番です');
    return;
  }
  if (state.sel && state.sel.pieceId === pieceId) return; // 回転はジェスチャ側で処理する
  // スクロールの到着を待たずにその場で選ぶ（待たされる感じを無くす）
  tray.dataset.autoScroll = '1';
  centerPiece(tray, pieceId);
  selectPiece(pieceId);
}

/**
 * 「動かさずに離したら回転」「押したままなら反転」を共通で付ける。
 * 押しっぱなしを先に判定するので、回転のタップに待ち時間が入らない。
 */
const LONG_PRESS_MS = 420;

function attachRotateGestures(root, { target, accept }) {
  let press = null;

  root.addEventListener('pointerdown', (event) => {
    if (!canAct()) return;
    const hit = target(event);
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
    if (!press || event.pointerId !== press.id) return;
    if (!press.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) >= 8) {
      press.moved = true;
      clearTimeout(press.timer);
    }
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
}

function moveAnchor(dr, dc) {
  if (!state.sel || !canAct()) return;
  const anchor = state.sel.anchor || [Math.floor(N / 2), Math.floor(N / 2)];
  const r = Math.min(Math.max(anchor[0] + dr, 0), N - 1);
  const c = Math.min(Math.max(anchor[1] + dc, 0), N - 1);
  state.sel.anchor = [r, c];
  state.lastAnchor = [r, c];
  updateBoard();
}

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
    state.history.push(snapshot(g));
    commit(applyMove(g, p, state.sel.pieceId, cells), p);
  }
}

/** 適用後の共通処理。飛ばされた側への知らせと、CPU の手番送りをここに集約する。 */
function commit(next, mover) {
  state.game = next;
  state.sel = null;
  state.selTurn = null;
  render();

  if (next.status === 'finished') {
    showResult();
    return;
  }

  if (next.passedBy) notifyPass(next.passedBy);

  if (state.mode === 'solo' && next.turn !== state.myPlayer) {
    scheduleCpu();
  }
}

/** 置ける場所が無くて手番を飛ばされた人がいることを知らせる。 */
function notifyPass(skipped) {
  const mine = state.mode !== 'local' && skipped === state.myPlayer;
  toast(mine
    ? 'あなたは置ける場所が無いので飛ばされました'
    : `${labelFor(skipped)}は置ける場所が無いので飛ばされました`);
}

function snapshot(game) {
  return JSON.parse(JSON.stringify(game));
}

let cpuTimer = null;
function scheduleCpu() {
  clearTimeout(cpuTimer);
  cpuTimer = setTimeout(() => {
    const g = state.game;
    if (!g || g.status !== 'playing' || state.mode !== 'solo') return;
    const cpu = g.turn;
    if (cpu === state.myPlayer) return;

    const move = chooseMove(g, cpu, state.level);
    if (!move) return; // applyMove がパスを扱うのでここには来ない想定
    commit(applyMove(g, cpu, move.pieceId, move.cells), cpu);
  }, 520);
}

function undo() {
  if (state.mode === 'online' || state.history.length === 0) return;
  clearTimeout(cpuTimer);
  state.game = state.history.pop();
  state.sel = null;
  state.selTurn = null;
  state.placeable = null;
  el.sheetResult.hidden = true;
  render();
  toast('一手もどしました');
}

/* ========================================================================
   盤面のポインタ操作
   ======================================================================== */

/**
 * 盤の上の操作。
 *   駒の外をさわる      → その場へ駒を移す（そのままなぞって微調整できる）
 *   駒をなぞる          → 駒を動かす
 *   駒をタップ          → 回転
 *   駒を長押し          → 反転
 */
let drag = null;

const moveGhostTo = (rc) => {
  state.sel.anchor = rc;
  state.lastAnchor = rc;
  updateBoard();
};

el.board.addEventListener('pointerdown', (event) => {
  if (!canAct() || !state.sel) return;

  const rc = cellFromPoint(el.board, event.clientX, event.clientY);
  if (!rc) return;
  event.preventDefault();
  // 指が盤の外に出ても追い続ける。捕捉できない環境でも操作自体は成立する
  try { el.board.setPointerCapture(event.pointerId); } catch { /* 続行してよい */ }

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
  if (!onGhost) moveGhostTo(rc);
});

el.board.addEventListener('pointermove', (event) => {
  if (!drag || event.pointerId !== drag.id || !canAct() || !state.sel) return;

  if (!drag.moved) {
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
    drag.moved = true;
    clearTimeout(drag.timer);
  }

  const rc = cellFromPoint(el.board, event.clientX, event.clientY);
  if (rc) moveGhostTo(rc);
});

function endDrag(event) {
  if (!drag || event.pointerId !== drag.id) return;
  clearTimeout(drag.timer);
  const { moved, onGhost, flipped } = drag;
  drag = null;
  if (!moved && !flipped && onGhost) rotateSelection();
}

el.board.addEventListener('pointerup', endDrag);
el.board.addEventListener('pointercancel', endDrag);

/* ---- キーボード（PC で遊ぶとき用） ---- */
document.addEventListener('keydown', (event) => {
  if (!$('#screen-game').classList.contains('is-active')) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  // ひとことを打っている最中は、盤の操作キーとして横取りしない
  if (event.target instanceof HTMLInputElement) return;

  const keys = {
    ArrowUp: () => moveAnchor(-1, 0),
    ArrowDown: () => moveAnchor(1, 0),
    ArrowLeft: () => moveAnchor(0, -1),
    ArrowRight: () => moveAnchor(0, 1),
    r: rotateSelection,
    R: rotateSelection,
    f: flipSelection,
    F: flipSelection,
    Enter: placeSelection,
    ' ': placeSelection,
    z: undo,
    Z: undo,
    Escape: () => { state.sel = null; state.selTurn = null; render(); },
  };

  const handler = keys[event.key];
  if (!handler) return;
  event.preventDefault();
  handler();
});

/* ---- 「置く」（手前・向かい側どちらのパネルからでも同じ処理） ---- */
for (const panel of [el.panelNear, el.panelFar]) {
  panel.addEventListener('click', (event) => {
    if (event.target.closest('.ctl-place')) placeSelection();
  });
}

/* ========================================================================
   ゲームの開始
   ======================================================================== */

function beginGame(mode, options = {}) {
  clearTimeout(cpuTimer);
  state.mode = mode;
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

  // ひとことはオンライン対戦のときだけ
  resetChat();
  el.chat.hidden = mode !== 'online';
  if (mode === 'online') {
    el.chatMyChip.className = `chip chip-${state.myPlayer === 1 ? 'a' : 'b'}`;
    el.chatThemChip.className = `chip chip-${state.myPlayer === 1 ? 'b' : 'a'}`;
  }

  buildBoard(el.board);
  el.sheetResult.hidden = true;
  showScreen('screen-game');
  render();

  if (mode === 'solo' && state.game.turn !== state.myPlayer) scheduleCpu();
}

/* ---- ひとりで遊ぶ ---- */
$('#level-picker').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-level]');
  if (!button) return;
  state.level = button.dataset.level;
  for (const other of $$('#level-picker button')) {
    const on = other === button;
    other.classList.toggle('is-on', on);
    other.setAttribute('aria-checked', String(on));
  }
});

let soloSide = 1;
$('#side-picker').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-side]');
  if (!button) return;
  soloSide = Number(button.dataset.side);
  for (const other of $$('#side-picker button')) {
    const on = other === button;
    other.classList.toggle('is-on', on);
    other.setAttribute('aria-checked', String(on));
  }
});

$('#btn-solo-start').addEventListener('click', () => {
  beginGame('solo', { myPlayer: soloSide });
});

/* ========================================================================
   オンライン対戦
   ======================================================================== */

const saveRoom = (room) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      code: room.code, token: room.token, player: room.player,
    }));
  } catch { /* プライベートブラウズなどで保存できなくても続行できる */ }
};

const loadRoom = () => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    return null;
  }
};

const clearRoom = () => {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* 無視してよい */ }
};

const inviteUrlFor = (code) => `${location.origin}${location.pathname}#${code}`;

function startWatcher() {
  stopWatcher();
  const watcher = new RoomWatcher({
    code: () => state.online.code,
    since: () => state.online.seq,
    onUpdate: onRoomUpdate,
    onError: (error) => {
      if (error.status !== 404) {
        toast(error.message);
        return;
      }
      // 対局が終わったあとの部屋は時間で消える。結果を読んでいる最中に
      // 邪魔をしたくないので、その場合は黙って見に行くのをやめる。
      if (state.game && state.game.status === 'finished') return;
      toast('部屋が閉じました');
      goHome();
    },
  });
  state.online.watcher = watcher;
  watcher.start();
}

function stopWatcher() {
  if (state.online && state.online.watcher) {
    state.online.watcher.stop();
    state.online.watcher = null;
  }
}

/** サーバから受け取った部屋の状態を画面に反映する。 */
function onRoomUpdate(data) {
  if (!state.online || data.unchanged) return;

  state.online.seq = data.seq;
  state.online.opponentJoined = Boolean(data.hasOpponent);

  // 盤面がまだ組み立てられていない画面（相手待ち・参加中）にいる場合
  if (!$('#screen-game').classList.contains('is-active')) {
    if (data.status === 'waiting') return; // まだ相手が来ていない
    beginGame('online', { game: data.game, myPlayer: state.online.player });
    toast('相手が参加しました');
    return;
  }

  const previous = state.game;
  const rematchStarted = previous
    && previous.status === 'finished'
    && data.game.status === 'playing';

  if (rematchStarted) {
    el.sheetResult.hidden = true;
    beginGame('online', { game: data.game, myPlayer: state.online.player });
    toast('もう一局はじまります');
    return;
  }

  // ひとことだけが動いたときに、選びかけのピースまで捨ててしまわないようにする
  const advanced = !previous
    || previous.moveCount !== data.game.moveCount
    || previous.turn !== data.game.turn
    || previous.status !== data.game.status;

  state.game = data.game;
  if (advanced) {
    state.placeable = null;
    state.sel = null;
    state.selTurn = null;
  }

  renderChat(data.chat);
  render();

  if (!advanced) return;
  if (data.game.status === 'finished') showResult();
  else if (data.game.passedBy) notifyPass(data.game.passedBy);
}

/* ---- ひとこと ---- */

/** 相手の行を今の内容に合わせる。自分の入力欄には触らない。 */
function renderChat(chat) {
  if (!chat || !state.online) return;
  const theirs = (chat[state.myPlayer === 1 ? 2 : 1] || '').trim();

  if (theirs !== el.chatThemText.textContent) {
    el.chatThemText.textContent = theirs;
    // 相手が打ち込んでいる間は見に行く間隔を詰めて、文字が流れて見えるようにする
    if (state.online.watcher) state.online.watcher.hurry();
  }
  el.chatThem.hidden = theirs.length === 0;
}

let chatTimer = null;
let chatPending = null;

el.chatInput.addEventListener('input', () => {
  if (state.mode !== 'online' || !state.online) return;
  chatPending = el.chatInput.value;
  if (state.online.watcher) state.online.watcher.hurry();
  clearTimeout(chatTimer);
  chatTimer = setTimeout(flushChat, 350);
});

el.chatInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  el.chatInput.blur(); // 送信という区切りは無いので、キーボードを下げるだけ
});

async function flushChat() {
  if (!state.online || chatPending === null) return;
  const text = chatPending;
  chatPending = null;
  try {
    onRoomUpdate(await sendChat(state.online.code, state.online.token, text));
  } catch {
    /* 届かなくても次に打った文字と一緒に送られる */
  }
}

function resetChat() {
  clearTimeout(chatTimer);
  chatPending = null;
  el.chatInput.value = '';
  el.chatThemText.textContent = '';
  el.chatThem.hidden = true;
}

async function placeOnline(pieceId, cells) {
  state.busy = true;
  updateBoard();

  try {
    const data = await sendMove(state.online.code, state.online.token, pieceId, cells);
    state.busy = false;
    onRoomUpdate(data);
  } catch (error) {
    state.busy = false;
    toast(error.message);

    // 盤面がずれている可能性があるので取り直す
    if (error.status === 409 || error.status === 400) {
      try {
        onRoomUpdate(await fetchRoom(state.online.code));
      } catch { /* 取り直しにも失敗したら次のポーリングに任せる */ }
    }
    render();
  }
}

$('#btn-create-room').addEventListener('click', async () => {
  const button = $('#btn-create-room');
  button.disabled = true;
  el.onlineError.textContent = '';

  try {
    const data = await createRoom();
    state.online = {
      code: data.code,
      token: data.token,
      player: data.player,
      seq: data.seq,
      opponentJoined: false,
      watcher: null,
    };
    state.myPlayer = data.player;
    saveRoom(state.online);

    el.inviteUrl.value = inviteUrlFor(data.code);
    showScreen('screen-waiting');
    startWatcher();
  } catch (error) {
    el.onlineError.textContent = error.message;
  }
  button.disabled = false;
});

/** 招待の受け渡し。共有シートが使える端末ではそれを優先する。 */
$('#btn-share').addEventListener('click', async () => {
  const url = inviteUrlFor(state.online.code);
  if (navigator.share) {
    try {
      await navigator.share({ title: 'BLOCKS', text: 'BLOCKS で対戦しませんか', url });
      return;
    } catch { /* 共有をやめただけなので何もしない */ }
  }
  copyInvite();
});

$('#btn-copy').addEventListener('click', copyInvite);

async function copyInvite() {
  const url = inviteUrlFor(state.online.code);
  try {
    await navigator.clipboard.writeText(url);
    toast('招待URLをコピーしました');
  } catch {
    el.inviteUrl.hidden = false;
    el.inviteUrl.value = url;
    el.inviteUrl.focus();
    el.inviteUrl.select();
    toast('表示された URL を長押しでコピーしてください', 4000);
  }
}

$('#btn-cancel-room').addEventListener('click', async () => {
  stopWatcher();
  if (state.online) {
    await leaveRoom(state.online.code, state.online.token).catch(() => {});
  }
  clearRoom();
  state.online = null;
  showScreen('screen-home');
});

/** URL のうしろに付いた部屋コードから参加する。再読み込みなら元の席に戻す。 */
async function enterByCode(code) {
  showScreen('screen-joining');
  el.joiningError.textContent = '';
  el.joiningBack.hidden = true;
  el.joiningNote.textContent = '部屋に参加しています…';

  const saved = loadRoom();

  // すでにこの部屋の参加者なら、入り直さずに続きから
  if (saved && saved.code === code) {
    try {
      const data = await fetchRoom(code);
      state.online = { ...saved, seq: -1, opponentJoined: Boolean(data.hasOpponent), watcher: null };
      state.myPlayer = saved.player;

      if (data.status === 'waiting') {
        el.inviteUrl.value = inviteUrlFor(code);
        showScreen('screen-waiting');
        state.online.seq = data.seq;
        startWatcher();
      } else {
        beginGame('online', { game: data.game, myPlayer: saved.player });
        state.online.seq = data.seq;
        startWatcher();
      }
      return;
    } catch { /* 続きから入れなければ、新規参加として扱う */ }
  }

  try {
    const data = await joinRoom(code);
    state.online = {
      code: data.code,
      token: data.token,
      player: data.player,
      seq: data.seq,
      opponentJoined: true,
      watcher: null,
    };
    state.myPlayer = data.player;
    saveRoom(state.online);

    beginGame('online', { game: data.game, myPlayer: data.player });
    startWatcher();
  } catch (error) {
    el.joiningNote.textContent = '';
    el.joiningError.textContent = error.message;
    el.joiningBack.hidden = false;
  }
}

/* ========================================================================
   結果
   ======================================================================== */

function showResult() {
  // オンラインでは相手が「もう一局」を選んだのを受け取りたいので、見に行くのは止めない
  const g = state.game;
  const scores = result(g);

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

  el.rematch.textContent = state.mode === 'online' ? 'もう一局さそう' : 'もう一度';
  el.sheetResult.hidden = false;
}

el.rematch.addEventListener('click', async () => {
  el.sheetResult.hidden = true;

  if (state.mode === 'solo') {
    beginGame('solo', { myPlayer: state.myPlayer });
  } else if (state.mode === 'local') {
    beginGame('local');
  } else {
    el.rematch.disabled = true;
    try {
      const data = await requestRematch(state.online.code, state.online.token);
      state.online.seq = data.seq;
      beginGame('online', { game: data.game, myPlayer: state.online.player });
      startWatcher();
      toast('相手にも新しい盤面が届きます');
    } catch (error) {
      toast(error.message);
      el.sheetResult.hidden = false;
    }
    el.rematch.disabled = false;
  }
});

$('#btn-home').addEventListener('click', goHome);

async function goHome() {
  clearTimeout(cpuTimer);
  stopWatcher();

  if (state.mode === 'online' && state.online) {
    // 対局が終わっているなら盤面はもう要らないので消しておく
    leaveRoom(state.online.code, state.online.token).catch(() => {});
    clearRoom();
  }

  state.online = null;
  state.game = null;
  state.mode = null;
  el.sheetResult.hidden = true;
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  showScreen('screen-home');
}

/* ========================================================================
   画面まわりの細かい配線
   ======================================================================== */

for (const button of $$('[data-mode]')) {
  button.addEventListener('click', () => {
    const mode = button.dataset.mode;
    if (mode === 'solo') showScreen('screen-solo');
    else if (mode === 'local') beginGame('local');
    else showScreen('screen-online');
  });
}

for (const button of $$('[data-back]')) {
  button.addEventListener('click', () => showScreen('screen-home'));
}

$('#btn-rules').addEventListener('click', () => { el.sheetRules.hidden = false; });
for (const button of $$('[data-close-sheet]')) {
  button.addEventListener('click', () => { el.sheetRules.hidden = true; });
}
el.sheetRules.addEventListener('click', (event) => {
  if (event.target === el.sheetRules) el.sheetRules.hidden = true;
});

for (const button of el.undo) button.addEventListener('click', undo);

// 誤って対局を終わらせないよう、二度押しで確定させる
for (const button of el.quit) {
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

function boot() {
  const code = location.hash.replace('#', '').trim().toUpperCase();
  if (/^[A-Z0-9]{4}$/.test(code)) {
    enterByCode(code);
  } else {
    showScreen('screen-home');
  }
}

boot();
