/**
 * BLOCKS — オンライン対戦の段取り
 *
 * 部屋を作る・招待する・参加する・盤面を見に行く・ひとことを流す、までを受け持つ。
 * 対局そのものの進め方は知らないので、始める／終わるといった節目は
 * 起動時に渡してもらった手続きに任せている。
 */

import {
  createRoom,
  joinRoom,
  startRoom,
  fetchRoom,
  sendMove,
  sendChat,
  leaveRoom,
  requestRematch,
  RoomWatcher,
} from './online.js';
import { chooseMove } from './ai.js';

import { state, labelFor, saveRoom, loadRoom, clearRoom } from './session.js';
import { $, showScreen, onGameScreen, toast } from './ui.js';
import { render, updateBoard } from './render.js';

const el = {
  inviteUrl: $('#invite-url'),
  onlineError: $('#online-error'),
  joiningNote: $('#joining-note'),
  joiningError: $('#joining-error'),
  joiningBack: $('#btn-joining-back'),
  joiningDots: $('#joining-dots'),
  createRoom: $('#btn-create-room'),
  seatCount: $('#seat-count'),
  startNow: $('#btn-start-now'),
  chat: $('#chat'),
  chatInput: $('#chat-input'),
  chatThemRows: $('#chat-them-rows'),
  chatMyChip: $('#chat-my-chip'),
};

/** 対局の節目は持ち主に任せる。 */
let hooks = {
  beginGame: () => {},
  goHome: () => {},
  showResult: () => {},
  notifyPass: () => {},
  hideResult: () => {},
};

export function initRoom(handlers) {
  hooks = handlers;
  wireButtons();
  wireChat();
}

const inviteUrlFor = (code) => `${location.origin}${location.pathname}#${code}`;

/* ==========================================================================
   盤面を見に行き続ける
   ========================================================================== */

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
      hooks.goHome();
    },
  });
  state.online.watcher = watcher;
  watcher.start();
}

export function stopWatcher() {
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
  if (!onGameScreen()) {
    if (data.status === 'waiting') {
      paintWaiting(data);
      return; // まだ人が揃っていない
    }
    startOnlineGame(data);
    toast(data.seats > 2 ? '対局がはじまります' : '相手が参加しました');
    return;
  }

  const previous = state.game;
  if (previous && previous.status === 'finished' && data.game.status === 'playing') {
    hooks.hideResult();
    startOnlineGame(data);
    toast('もう一局はじまります');
    return;
  }

  // ひとことだけが動いたときに、選びかけのピースまで捨ててしまわないようにする
  const advanced = !previous
    || previous.moveCount !== data.game.moveCount
    || previous.turn !== data.game.turn
    || previous.status !== data.game.status;

  state.game = data.game;
  state.cpuSeats = data.cpu || [];
  if (advanced) {
    state.placeable = null;
    state.sel = null;
    state.selTurn = null;
  }

  renderChat(data.chat);
  render();

  if (!advanced) return;
  if (data.game.status === 'finished') {
    hooks.showResult();
    return;
  }
  hooks.notifyPass(data.game.passedBy);
  runCpuSeatIfHost();
}

const startOnlineGame = (data) => hooks.beginGame('online', {
  game: data.game,
  myPlayer: state.online.player,
  cpuSeats: data.cpu || [],
});

/** 相手待ちの画面に、埋まった席と主催者向けの開始ボタンを出す。 */
function paintWaiting(data) {
  const seats = data.seats || 2;
  const joined = data.joined || 1;
  const iAmHost = state.online?.player === 1;

  el.seatCount.hidden = seats <= 2;
  el.seatCount.textContent = `${joined} / ${seats} 人`;

  el.startNow.hidden = !iAmHost || joined >= seats;
  el.startNow.disabled = false;
}

const rememberSeat = (data) => {
  state.online = {
    code: data.code,
    token: data.token,
    player: data.player,
    seq: data.seq,
    opponentJoined: Boolean(data.hasOpponent),
    watcher: null,
  };
  state.myPlayer = data.player;
  saveRoom(state.online);
};

/* ==========================================================================
   CPU が受け持つ席
   サーバには常時動く仕組みが無いので、部屋を作った人の端末が代わりに考える。
   ========================================================================== */

let cpuTimer = null;

export function runCpuSeatIfHost() {
  clearTimeout(cpuTimer);
  if (!state.online || state.online.player !== 1) return; // 主催者だけが回す

  cpuTimer = setTimeout(async () => {
    const g = state.game;
    if (!g || g.status !== 'playing') return;
    if (!state.cpuSeats.includes(g.turn)) return;
    if (state.busy) return;

    const move = chooseMove(g, g.turn, 'normal');
    if (!move) return;

    try {
      onRoomUpdate(await sendMove(state.online.code, state.online.token, move.pieceId, move.cells));
    } catch {
      /* 失敗しても次のポーリングで状況を取り直す */
    }
  }, 700);
}

/* ==========================================================================
   一手を送る
   ========================================================================== */

export async function placeOnline(pieceId, cells) {
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

/* ==========================================================================
   ひとこと
   送信という区切りを持たず、打っている文字がそのまま相手に流れていく。
   ========================================================================== */

let chatTimer = null;
let chatPending = null;
let lastChat = {};

/**
 * 相手の行を今の内容に合わせる。自分の入力欄には触らない。
 * 空でも行そのものは残す。消すと高さが変わって盤面が伸び縮みしてしまう。
 */
function renderChat(chat) {
  if (!chat || !state.online) return;

  let someoneTyped = false;
  for (const row of el.chatThemRows.children) {
    const seat = Number(row.dataset.seat);
    const text = (chat[seat] || '').trim();

    if (text !== (lastChat[seat] || '')) someoneTyped = true;
    lastChat[seat] = text;

    row.classList.toggle('is-empty', text.length === 0);
    // 何も言っていない席は、誰の行なのかが分かるように名前を薄く出しておく
    row.querySelector('span').textContent = text || labelFor(seat);
  }

  // 誰かが打ち込んでいる間は見に行く間隔を詰めて、文字が流れて見えるようにする
  if (someoneTyped && state.online.watcher) state.online.watcher.hurry();
}

function wireChat() {
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
}

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

/** 対局の開始時に、ひとこと欄を出すか下げるかを決める。 */
/**
 * 対局の開始時に、ひとこと欄を組み直す。
 * 相手ひとりにつき 1 行。CPU の席は喋らないので行を作らない。
 */
export function prepareChat(mode, myPlayer) {
  clearTimeout(chatTimer);
  chatPending = null;
  lastChat = {};
  el.chatInput.value = '';

  el.chat.hidden = mode !== 'online';
  if (mode !== 'online') return;

  el.chatMyChip.className = `chip seat-${myPlayer}`;

  const rows = document.createDocumentFragment();
  for (let seat = 1; seat <= state.seats; seat++) {
    if (seat === myPlayer || state.cpuSeats.includes(seat)) continue;

    const row = document.createElement('p');
    row.className = 'chat-line chat-them is-empty';
    row.dataset.seat = String(seat);

    const chip = document.createElement('i');
    chip.className = `chip seat-${seat}`;
    const text = document.createElement('span');
    text.textContent = labelFor(seat);

    row.append(chip, text);
    rows.appendChild(row);
  }
  el.chatThemRows.replaceChildren(rows);
}

/* ==========================================================================
   部屋を作る・招待する
   ========================================================================== */

function wireButtons() {
  el.createRoom.addEventListener('click', async () => {
    el.createRoom.disabled = true;
    el.onlineError.textContent = '';

    try {
      const data = await createRoom(state.seats);
      rememberSeat(data);

      el.inviteUrl.value = inviteUrlFor(data.code);
      paintWaiting(data);
      showScreen('screen-waiting');
      startWatcher();
    } catch (error) {
      el.onlineError.textContent = error.message;
    }
    el.createRoom.disabled = false;
  });

  // 招待の受け渡し。共有シートが使える端末ではそれを優先する
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

  $('#btn-cancel-room').addEventListener('click', async () => {
    await closeRoom();
    showScreen('screen-home');
  });

  el.startNow.addEventListener('click', async () => {
    el.startNow.disabled = true;
    try {
      onRoomUpdate(await startRoom(state.online.code, state.online.token));
    } catch (error) {
      toast(error.message);
      el.startNow.disabled = false;
    }
  });
}

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

/* ==========================================================================
   招待から入る
   ========================================================================== */

/**
 * URL のうしろに付いた部屋コードから入る。再読み込みなら元の席に戻す。
 * 色は席で決まっているので、開いたらそのまま席につく。
 */
export async function enterByCode(code) {
  showScreen('screen-joining');
  el.joiningError.textContent = '';
  el.joiningBack.hidden = true;
  el.joiningDots.hidden = false;
  el.joiningNote.textContent = '部屋に入っています…';

  if (await resumeSeat(code)) return;

  try {
    const data = await joinRoom(code);
    rememberSeat(data);

    if (data.status === 'waiting') {
      // 4 人戦でまだ揃っていない。他の人を待つ
      el.inviteUrl.value = inviteUrlFor(code);
      paintWaiting(data);
      showScreen('screen-waiting');
    } else {
      startOnlineGame(data);
    }
    startWatcher();
  } catch (error) {
    showJoinError(error.message);
  }
}

/** すでにこの部屋の参加者なら、入り直さずに続きから。 */
async function resumeSeat(code) {
  const saved = loadRoom();
  if (!saved || saved.code !== code) return false;

  try {
    const data = await fetchRoom(code);
    state.online = { ...saved, seq: data.seq, opponentJoined: Boolean(data.hasOpponent), watcher: null };
    state.myPlayer = saved.player;

    if (data.status === 'waiting') {
      el.inviteUrl.value = inviteUrlFor(code);
      paintWaiting(data);
      showScreen('screen-waiting');
    } else {
      startOnlineGame(data);
    }
    startWatcher();
    return true;
  } catch {
    return false; // 続きから入れなければ、新規参加として扱う
  }
}

function showJoinError(message) {
  el.joiningDots.hidden = true;
  el.joiningNote.textContent = '';
  el.joiningError.textContent = message;
  el.joiningBack.hidden = false;
}

/* ==========================================================================
   もう一局・後片付け
   ========================================================================== */

/** 同じ相手ともう一局。相手の画面にも新しい盤面が届く。 */
export async function rematchOnline() {
  const data = await requestRematch(state.online.code, state.online.token);
  state.online.seq = data.seq;
  startOnlineGame(data);
  startWatcher();
}

/** 部屋から出る。盤面はもう要らないので消してもらう。 */
export async function closeRoom() {
  stopWatcher();
  if (state.online) {
    await leaveRoom(state.online.code, state.online.token).catch(() => {});
  }
  clearRoom();
  state.online = null;
}
