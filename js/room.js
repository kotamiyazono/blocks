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
  fetchRoom,
  sendMove,
  sendChat,
  leaveRoom,
  requestRematch,
  RoomWatcher,
} from './online.js';
import {
  applyColors,
  buildSwatches,
  firstAvailable,
  DEFAULT_FIRST,
} from './palette.js';
import {
  state,
  choice,
  rememberMyColor,
  saveRoom,
  loadRoom,
  clearRoom,
} from './session.js';
import { $, showScreen, onGameScreen, toast } from './ui.js';
import { render, updateBoard } from './render.js';

const el = {
  inviteUrl: $('#invite-url'),
  onlineError: $('#online-error'),
  joiningNote: $('#joining-note'),
  joiningError: $('#joining-error'),
  joiningBack: $('#btn-joining-back'),
  joiningColor: $('#joining-color'),
  joiningDots: $('#joining-dots'),
  joinStart: $('#btn-join-start'),
  createRoom: $('#btn-create-room'),
  chat: $('#chat'),
  chatInput: $('#chat-input'),
  chatThem: $('#chat-them'),
  chatThemText: $('#chat-them-text'),
  chatThemChip: $('#chat-them-chip'),
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
    if (data.status === 'waiting') return; // まだ相手が来ていない
    startOnlineGame(data);
    toast('相手が参加しました');
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
  if (advanced) {
    state.placeable = null;
    state.sel = null;
    state.selTurn = null;
  }

  renderChat(data.chat);
  render();

  if (!advanced) return;
  if (data.game.status === 'finished') hooks.showResult();
  else if (data.game.passedBy) hooks.notifyPass(data.game.passedBy);
}

const startOnlineGame = (data) => hooks.beginGame('online', {
  game: data.game,
  myPlayer: state.online.player,
  colors: data.colors,
});

const rememberSeat = (data, opponentJoined) => {
  state.online = {
    code: data.code,
    token: data.token,
    player: data.player,
    seq: data.seq,
    opponentJoined,
    watcher: null,
  };
  state.myPlayer = data.player;
  saveRoom(state.online);
};

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

const CHAT_PLACEHOLDER = '相手のひとこと';

let chatTimer = null;
let chatPending = null;

/**
 * 相手の行を今の内容に合わせる。自分の入力欄には触らない。
 * 空でも行そのものは残す。消すと高さが変わって盤面が伸び縮みしてしまう。
 */
function renderChat(chat) {
  if (!chat || !state.online) return;
  const theirs = (chat[state.myPlayer === 1 ? 2 : 1] || '').trim();

  if (theirs !== (el.chatThem.dataset.text || '')) {
    el.chatThem.dataset.text = theirs;
    // 相手が打ち込んでいる間は見に行く間隔を詰めて、文字が流れて見えるようにする
    if (state.online.watcher) state.online.watcher.hurry();
  }

  el.chatThem.classList.toggle('is-empty', theirs.length === 0);
  el.chatThemText.textContent = theirs || CHAT_PLACEHOLDER;
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
export function prepareChat(mode, myPlayer) {
  clearTimeout(chatTimer);
  chatPending = null;
  el.chatInput.value = '';
  el.chatThem.dataset.text = '';
  el.chatThem.classList.add('is-empty');
  el.chatThemText.textContent = CHAT_PLACEHOLDER;

  el.chat.hidden = mode !== 'online';
  if (mode !== 'online') return;
  el.chatMyChip.className = `chip chip-${myPlayer === 1 ? 'a' : 'b'}`;
  el.chatThemChip.className = `chip chip-${myPlayer === 1 ? 'b' : 'a'}`;
}

/* ==========================================================================
   部屋を作る・招待する
   ========================================================================== */

function wireButtons() {
  el.createRoom.addEventListener('click', async () => {
    el.createRoom.disabled = true;
    el.onlineError.textContent = '';

    try {
      const data = await createRoom(choice.mine);
      rememberSeat(data, false);
      applyColors(data.colors?.[1], data.colors?.[2]); // 待ち画面の色も自分の選んだ色に

      el.inviteUrl.value = inviteUrlFor(data.code);
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

  el.joinStart.addEventListener('click', joinPendingRoom);
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

/** URL のうしろに付いた部屋コードから入る。再読み込みなら元の席に戻す。 */
export async function enterByCode(code) {
  showScreen('screen-joining');
  el.joiningError.textContent = '';
  el.joiningBack.hidden = true;
  el.joinStart.hidden = true;
  el.joiningColor.hidden = true;
  el.joiningDots.hidden = false;
  el.joiningNote.textContent = '部屋を確かめています…';

  if (await resumeSeat(code)) return;

  // 相手が使っている色を確かめてから、自分の色を選んでもらう
  let hostColor;
  try {
    const room = await fetchRoom(code);
    if (room.status !== 'waiting' || room.hasOpponent) {
      throw new Error('この部屋はもう対戦がはじまっています');
    }
    hostColor = room.colors?.[1] || DEFAULT_FIRST;
  } catch (error) {
    showJoinError(error.message);
    return;
  }

  // 相手の色と同じものを選んでいたら、空いている色にずらしておく
  if (choice.mine === hostColor) rememberMyColor(firstAvailable(hostColor));

  const paint = () => buildSwatches($('#join-colors'), {
    selected: choice.mine,
    taken: hostColor,
    onPick: (picked) => { rememberMyColor(picked); paint(); },
  });
  paint();

  el.joiningDots.hidden = true;
  el.joiningNote.textContent = '相手が待っています。色を選んではじめてください。';
  el.joiningColor.hidden = false;
  el.joinStart.hidden = false;
  el.joinStart.disabled = false;
  state.pendingJoin = code;
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
      applyColors(data.colors?.[1], data.colors?.[2]);
      el.inviteUrl.value = inviteUrlFor(code);
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

async function joinPendingRoom() {
  const code = state.pendingJoin;
  if (!code) return;

  el.joinStart.disabled = true;
  el.joiningError.textContent = '';

  try {
    const data = await joinRoom(code, choice.mine);
    rememberSeat(data, true);
    state.pendingJoin = null;
    startOnlineGame(data);
    startWatcher();
  } catch (error) {
    el.joiningError.textContent = error.message;
    el.joinStart.disabled = false;
    if (error.status === 409 || error.status === 404) {
      el.joinStart.hidden = true;
      el.joiningColor.hidden = true;
      el.joiningBack.hidden = false;
    }
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
