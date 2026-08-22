/** BLOCKS — オンライン対戦（4 人戦）の WebSocket 通し検証 */

import { VARIANTS, legalMoves, isFirstMove } from '../public/js/rules.js';
import { connect, waitFor, waitClose } from './socket.mjs';

const BASE = process.env.BLOCKS_URL || 'https://blocks.superblue.app';
const V = VARIANTS.four;
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok   ${name}` : `  FAIL ${name} ${extra}`);
  if (!cond) failures++;
};
const post = async (action, body) => {
  const res = await fetch(`${BASE}/api/room?action=${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const send = (ws, message) => ws.send(JSON.stringify(message));
const stateMessage = (ws) => waitFor(ws, (message) => message.t === 'state');
const errorMessage = (ws) => waitFor(ws, (message) => message.t === 'error');

console.log('\n== 4 人部屋を作って埋める ==');
const created = await post('create', { seats: 4 });
check('4 人部屋を作れる', created.status === 200 && created.data.player === 1);
const code = created.data.code;
const tokens = { 1: created.data.token };
const sockets = [];
const initialStates = [];
const host = await connect(BASE, code, tokens[1]);
sockets.push(host);
check('作成直後の state は waiting', (await stateMessage(host)).status === 'waiting');

for (let player = 2; player <= 4; player++) {
  const joined = await post('join', { code });
  check(`${player} 人目が席 ${player} に入る`, joined.status === 200 && joined.data.player === player);
  tokens[player] = joined.data.token;
  const ws = await connect(BASE, code, tokens[player]);
  sockets.push(ws);
  initialStates.push(await stateMessage(ws));
}
// 席 4 は揃った後に接続するので初期 state、席 1〜3 は join 時の push を受け取る。
const startedStates = await Promise.all(sockets.map((ws, index) => index === sockets.length - 1
  ? Promise.resolve(initialStates[index - 1])
  : waitFor(ws, (message) => message.t === 'state' && message.status === 'playing')));
check('4 人揃うと全員へ playing が push される', startedStates.every((s) => s.status === 'playing'));

console.log('\n== 4 人で最後まで打つ ==');
let game = startedStates[0].game;
let moves = 0;
const turnsSeen = new Set();
while (game.status === 'playing' && moves < 120) {
  const p = game.turn;
  turnsSeen.add(p);
  const list = legalMoves(V, game.board, p, game.hands[p], isFirstMove(game, p));
  if (!list.length) { check(`${moves}手目: 手番なのに合法手が無い`, false); break; }
  list.sort((a, b) => b.cells.length - a.cells.length);
  const move = list[0];
  send(sockets[p - 1], { t: 'move', pieceId: move.pieceId, cells: move.cells });
  const states = await Promise.all(sockets.map((ws) => waitFor(ws, (message) =>
    message.t === 'state' && message.game.moveCount > game.moveCount)));
  game = states[0].game;
  check(`${moves + 1}手目が全員へ push される`, states.every((s) => s.game.moveCount === game.moveCount));
  moves++;
}
check(`終局した (${moves}手)`, game.status === 'finished', `status=${game.status}`);
check('4 人全員が手番を持った', turnsSeen.size === 4, [...turnsSeen].join(','));
check('4 色すべてが盤に出ている',
  [1, 2, 3, 4].every((p) => game.board.filter((x) => x === p).length > 0));

send(host, { t: 'move', pieceId: 'I1', cells: [[0, 0]] });
check('終局後の着手は error', (await errorMessage(host)).message === 'この対局は進行中ではありません');

console.log('\n== 後片付け ==');
const closes = sockets.map((ws) => waitClose(ws));
send(host, { t: 'leave' });
check('leave で全 socket が 4404', (await Promise.all(closes)).every((close) => close.code === 4404));

console.log('\n== 空席を CPU で埋めて始める ==');
const solo = await post('create', { seats: 4 });
const cpuCode = solo.data.code;
const cpuHost = await connect(BASE, cpuCode, solo.data.token);
await stateMessage(cpuHost);
const cpuGuest = await post('join', { code: cpuCode });
const cpuGuestSocket = await connect(BASE, cpuCode, cpuGuest.data.token);
await stateMessage(cpuGuestSocket);
const waiting = await stateMessage(cpuHost);
check('2 人参加では waiting のまま', waiting.status === 'waiting');

send(cpuGuestSocket, { t: 'start' });
check('参加者の start は error', (await errorMessage(cpuGuestSocket)).message === '部屋を作った人だけが始められます');
send(cpuHost, { t: 'start' });
const cpuStarted = await stateMessage(cpuHost);
await stateMessage(cpuGuestSocket);
check('主催者は始められる', cpuStarted.status === 'playing');
check('空席が CPU になる', JSON.stringify(cpuStarted.cpu) === '[3,4]');

let cpuGame = cpuStarted.game;
const first = legalMoves(V, cpuGame.board, 1, cpuGame.hands[1], true)[0];
send(cpuHost, { t: 'move', pieceId: first.pieceId, cells: first.cells });
cpuGame = (await stateMessage(cpuHost)).game;
await stateMessage(cpuGuestSocket);
const second = legalMoves(V, cpuGame.board, 2, cpuGame.hands[2], true)[0];
send(cpuGuestSocket, { t: 'move', pieceId: second.pieceId, cells: second.cells });
cpuGame = (await stateMessage(cpuHost)).game;
await stateMessage(cpuGuestSocket);
check('次は CPU の席 3', cpuGame.turn === 3);
const third = legalMoves(V, cpuGame.board, 3, cpuGame.hands[3], true)[0];
send(cpuGuestSocket, { t: 'move', pieceId: third.pieceId, cells: third.cells });
check('参加者は CPU 席を代打ちできない', (await errorMessage(cpuGuestSocket)).message === 'あなたの手番ではありません');
send(cpuHost, { t: 'move', pieceId: third.pieceId, cells: third.cells });
check('主催者は CPU 席を代打ちできる', (await stateMessage(cpuHost)).game.turn !== 3);
await stateMessage(cpuGuestSocket);
cpuHost.close(); cpuGuestSocket.close();

console.log(failures === 0 ? '\n✅ すべて通過\n' : `\n❌ ${failures} 件失敗\n`);
process.exit(failures ? 1 : 0);
