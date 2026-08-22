/**
 * BLOCKS — オンライン対戦の段取り
 *
 * 部屋を作る・招待する・参加する・盤面を同期する・ひとことを流す、までを受け持つ。
 * 対局そのものの進め方は知らないので、始める／終わるといった節目は
 * 起動時に渡してもらった手続きに任せている。
 */

import {
  createRoom,
  joinRoom,
  RoomSocket,
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
   WebSocket 接続
   ========================================================================== */

function connect() {
  disconnect();
  const socket = new RoomSocket({
    code: state.online.code,
    token: state.online.token,
    onState: onRoomUpdate,
    onChat: renderChatMessage,
    onError: (error) => {
      state.busy = false;
      el.startNow.disabled = false;
      toast(error.message);
      render();
    },
    onClosed: (event) => {
      if (state.game?.status === 'finished') return;
      toast(event.code === 4403 ? 'この対局の参加者として確認できませんでした' : '部屋が閉じました');
      hooks.goHome();
    },
  });
  state.online.socket = socket;
  socket.open();
}

export function disconnect() {
  state.online?.socket?.close();
  if (state.online) state.online.socket = null;
}

/** サーバから受け取った部屋の状態を画面に反映する。 */
function onRoomUpdate(data) {
  clearTimeout(moveTimer);
  if (!state.online) return;

  state.busy = false;
  state.online.opponentJoined = Boolean(data.hasOpponent);

  // 盤面がまだ組み立てられていない画面（相手待ち・参加中）にいる場合
  if (!onGameScreen()) {
    if (data.status === 'waiting') {
      paintWaiting(data);
      return; // まだ人が揃っていない
    }
    startOnlineGame(data);
    if (data.seats > 2 || state.online.player === 1) {
      toast(data.seats > 2 ? '対局がはじまります' : '相手が参加しました');
    }
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

const startOnlineGame = (data) => {
  hooks.beginGame('online', {
    game: data.game,
    myPlayer: state.online.player,
    cpuSeats: data.cpu || [],
  });
  renderChat(data.chat);
};

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
    opponentJoined: false,
    socket: null,
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

    state.online.socket.send({ t: 'move', pieceId: move.pieceId, cells: move.cells });
  }, 700);
}

/* ==========================================================================
   一手を送る
   ========================================================================== */

let moveTimer = null;

export function placeOnline(pieceId, cells) {
  state.busy = true;
  updateBoard();
  clearTimeout(moveTimer);
  if (!state.online.socket.send({ t: 'move', pieceId, cells })) {
    state.busy = false;
    toast('接続中です。もう一度お試しください');
    render();
    return;
  }
  moveTimer = setTimeout(() => {
    state.busy = false;
    render();
  }, 5000);
}

/* ==========================================================================
   ひとこと
   送信という区切りを持たず、打っている文字がそのまま相手に流れていく。
   ========================================================================== */

let chatTimer = null;
let chatPending = null;
let lastSentChat = null;

/**
 * 相手の行を今の内容に合わせる。自分の入力欄には触らない。
 * 空でも行そのものは残す。消すと高さが変わって盤面が伸び縮みしてしまう。
 */
function renderChat(chat) {
  if (!chat || !state.online) return;

  for (const row of el.chatThemRows.children) {
    const seat = Number(row.dataset.seat);
    const text = (chat[seat] || '').trim();

    row.classList.toggle('is-empty', text.length === 0);
    // 何も言っていない席は、誰の行なのかが分かるように名前を薄く出しておく
    row.querySelector('span').textContent = text || labelFor(seat);
  }

}

function renderChatMessage({ seat, text }) {
  const row = [...el.chatThemRows.children].find((item) => Number(item.dataset.seat) === seat);
  if (!row) return;
  const value = text.trim();
  row.classList.toggle('is-empty', value.length === 0);
  row.querySelector('span').textContent = value || labelFor(seat);
}

function wireChat() {
  el.chatInput.addEventListener('input', () => {
    if (state.mode !== 'online' || !state.online) return;
    chatPending = el.chatInput.value;
    clearTimeout(chatTimer);
    chatTimer = setTimeout(flushChat, 120);
  });

  el.chatInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    el.chatInput.blur(); // 送信という区切りは無いので、キーボードを下げるだけ
  });
}

function flushChat() {
  if (!state.online || chatPending === null) return;
  const text = chatPending;
  chatPending = null;
  if (text === lastSentChat) return;
  if (state.online.socket.send({ t: 'say', text })) lastSentChat = text;
}

/** 対局の開始時に、ひとこと欄を出すか下げるかを決める。 */
/**
 * 対局の開始時に、ひとこと欄を組み直す。
 * 相手ひとりにつき 1 行。CPU の席は喋らないので行を作らない。
 */
export function prepareChat(mode, myPlayer) {
  clearTimeout(chatTimer);
  chatPending = null;
  lastSentChat = null;
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
      const data = await createRoom(state.seatChoice);
      rememberSeat(data);

      el.inviteUrl.value = inviteUrlFor(data.code);
      paintWaiting({ seats: state.seatChoice, joined: 1 });
      showScreen('screen-waiting');
      connect();
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
    if (!state.online.socket.send({ t: 'start' })) {
      toast('接続中です。もう一度お試しください');
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

  if (resumeSeat(code)) return;

  try {
    const data = await joinRoom(code);
    rememberSeat(data);
    el.inviteUrl.value = inviteUrlFor(code);
    showScreen('screen-waiting');
    connect();
  } catch (error) {
    showJoinError(error.message);
  }
}

/** すでにこの部屋の参加者なら、入り直さずに続きから。 */
function resumeSeat(code) {
  const saved = loadRoom();
  if (!saved || saved.code !== code) return false;

  state.online = { ...saved, opponentJoined: false, socket: null };
  state.myPlayer = saved.player;
  el.inviteUrl.value = inviteUrlFor(code);
  showScreen('screen-waiting');
  connect();
  return true;
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
export function rematchOnline() {
  if (!state.online.socket.send({ t: 'rematch' })) {
    throw new Error('接続中です。もう一度お試しください');
  }
}

/** 部屋から出る。盤面はもう要らないので消してもらう。 */
export async function closeRoom() {
  if (state.online) {
    state.online.socket?.send({ t: 'leave' });
    disconnect();
  }
  clearRoom();
  state.online = null;
}
