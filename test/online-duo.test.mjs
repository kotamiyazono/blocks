/** BLOCKS — オンライン対戦（2 人戦）の WebSocket 通し検証 */

import { VARIANTS, legalMoves, isFirstMove } from '../public/js/rules.js';
import { connect, waitFor, waitClose, collect } from './socket.mjs';

const BASE = process.env.BLOCKS_URL || 'https://blocks.superblue.app';
const V = VARIANTS.duo;
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stateMessage = (ws) => waitFor(ws, (message) => message.t === 'state');
const errorMessage = (ws) => waitFor(ws, (message) => message.t === 'error');

console.log('\n== 部屋の作成と WebSocket 接続 ==');
const created = await post('create');
check('部屋を作れる', created.status === 200 && created.data.code);
const code = created.data.code;
const hostToken = created.data.token;
let host = await connect(BASE, code, hostToken);
const initial = await stateMessage(host);
check('接続直後に state が届く', initial.status === 'waiting' && initial.player === undefined);
check('state に盤面が含まれる', initial.game.board.length === 196);

const bad = await connect(BASE, code, 'deadbeef');
const badClose = await waitClose(bad);
check('偽トークンは 4403 で閉じる', badClose.code === 4403, JSON.stringify(badClose));
check('断った接続は部屋の状態を受け取らない', collect(bad).length === 0);
const missing = await connect(BASE, 'ZZZZ', 'deadbeef');
const missingClose = await waitClose(missing);
check('無い部屋は 4404 で閉じる', missingClose.code === 4404, JSON.stringify(missingClose));

const joined = await post('join', { code });
check('相手として参加できる', joined.status === 200 && joined.data.player === 2);
const guest = await connect(BASE, code, joined.data.token);
const guestInitial = await stateMessage(guest);
const hostPlaying = await stateMessage(host);
check('参加で双方に playing が push される', guestInitial.status === 'playing' && hostPlaying.status === 'playing');
check('ゲストへホストのトークンを送らない', JSON.stringify(guestInitial).includes(hostToken) === false);

console.log('\n== push・chat・サーバ側の検証 ==');
send(host, { t: 'say', text: 'こんにちは' });
const chat = await waitFor(guest, (message) => message.t === 'chat');
await sleep(150);
check('chat は相手だけに届く', chat.seat === 1 && chat.text === 'こんにちは');
check('chat は送信者にエコーしない', collect(host).length === 0);

host.send('.');
await sleep(150);
check("'.' では state を送らない", !collect(host).some((message) => message.t === 'state'));

let game = guestInitial.game;
const firstMove = legalMoves(V, game.board, 1, game.hands[1], true).find((m) => m.pieceId === 'I5');
send(guest, { t: 'move', pieceId: firstMove.pieceId, cells: firstMove.cells });
check('手番でない側の着手は error', (await errorMessage(guest)).message === 'あなたの手番ではありません');
await sleep(150);
check('拒否では host に state が来ない', !collect(host).some((message) => message.t === 'state'));

for (const [name, pieceId, cells, message] of [
  ['形違い', 'I5', [[4, 4], [4, 5], [4, 6]], 'そのピースの形と一致しません'],
  ['盤外（形の検証で弾かれる）', 'I5', [[0, -1], [0, 0], [0, 1], [0, 2], [0, 3]], 'そのピースの形と一致しません'],
  ['開始点違い', 'I5', [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]], 'そこには置けません'],
  ['非所持', 'NOPE', firstMove.cells, 'そのピースは手元にありません'],
]) {
  send(host, { t: 'move', pieceId, cells });
  check(`${name}は error`, (await errorMessage(host)).message === message);
}

send(host, { t: 'move', pieceId: firstMove.pieceId, cells: firstMove.cells });
const afterFirst = await stateMessage(host);
await stateMessage(guest);
check('正しい着手は双方へ state', afterFirst.game.turn === 2 && afterFirst.game.moveCount === 1);
game = afterFirst.game;

host.close();
const reconnectedHost = await connect(BASE, code, hostToken);
const reconnectedState = await stateMessage(reconnectedHost);
check('再接続で最新 state が届く', JSON.stringify(reconnectedState.game) === JSON.stringify(game));
// 再接続後もそのまま対局を続けられるよう、ソケットを host として引き継ぐ。
host = reconnectedHost;

console.log('\n== 同時着手の直列性 ==');
const raceCreated = await post('create');
const raceJoined = await post('join', { code: raceCreated.data.code });
const raceA = await connect(BASE, raceCreated.data.code, raceCreated.data.token);
const raceB = await connect(BASE, raceCreated.data.code, raceCreated.data.token);
const raceGuest = await connect(BASE, raceCreated.data.code, raceJoined.data.token);
await Promise.all([stateMessage(raceA), stateMessage(raceB), stateMessage(raceGuest)]);
// create の初期盤から合法な初手を求める
const raceInitial = legalMoves(V, Array(196).fill(0), 1, game.hands[1], true)[0];
send(raceA, { t: 'move', pieceId: raceInitial.pieceId, cells: raceInitial.cells });
send(raceB, { t: 'move', pieceId: raceInitial.pieceId, cells: raceInitial.cells });
await sleep(300);
const raceMessages = [...collect(raceA), ...collect(raceB), ...collect(raceGuest)];
check('同じ手の state broadcast は 1 回', raceMessages.filter((m) => m.t === 'state').length === 3);
check('同じ手の敗者は error 1 通', raceMessages.filter((m) => m.t === 'error').length === 1);
check('同時着手で手番は 1 つだけ進む', raceMessages.filter((m) => m.t === 'state')[0]?.game.turn === 2);
raceA.close(); raceB.close(); raceGuest.close();

console.log('\n== 終局・再戦・後片付け ==');
let moves = 1;
while (game.status === 'playing' && moves < 100) {
  const p = game.turn;
  const list = legalMoves(V, game.board, p, game.hands[p], isFirstMove(game, p));
  if (!list.length) { check('手番なのに合法手が無い', false); break; }
  list.sort((a, b) => b.cells.length - a.cells.length);
  const move = list[0];
  const sender = p === 1 ? host : guest;
  send(sender, { t: 'move', pieceId: move.pieceId, cells: move.cells });
  const [nextHost, nextGuest] = await Promise.all([stateMessage(host), stateMessage(guest)]);
  game = nextHost.game;
  check(`${moves}手目が push される`, nextGuest.game.moveCount === game.moveCount);
  moves++;
}
check(`終局した (${moves}手)`, game.status === 'finished');
send(host, { t: 'move', pieceId: 'I1', cells: [[0, 0]] });
check('終局後の着手は error', (await errorMessage(host)).message === 'この対局は進行中ではありません');

send(guest, { t: 'rematch' });
const rematch = await stateMessage(host);
await stateMessage(guest);
check('再戦で空の盤が push される', rematch.status === 'playing' && rematch.game.board.every((v) => v === 0));

const closedHost = waitClose(host);
const closedGuest = waitClose(guest);
send(host, { t: 'leave' });
check('leave は全員を 4404 で閉じる',
  (await Promise.all([closedHost, closedGuest])).every((c) => c.code === 4404 && c.reason));
const reconnect = await connect(BASE, code, hostToken);
check('閉じた部屋への再接続も 4404', (await waitClose(reconnect)).code === 4404);

console.log(failures === 0 ? '\n✅ すべて通過\n' : `\n❌ ${failures} 件失敗\n`);
process.exit(failures ? 1 : 0);
