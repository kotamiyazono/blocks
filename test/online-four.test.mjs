/**
 * BLOCKS — オンライン対戦（4 人戦）の通し検証
 *
 * 実際に動いているサーバへ本物のリクエストを投げる。
 * ルールの検証（rules.test.mjs）と違い、部屋の作成・参加・着手の権限・終局まで、
 * 通信をまたいだ振る舞いを確かめるためのもの。
 */
import { VARIANTS, legalMoves, isFirstMove } from '../public/js/rules.js';

// 既定は本番。別の環境に向けるときは BLOCKS_URL を指定する
const BASE = process.env.BLOCKS_URL || 'https://blocks.kotamiyazono.workers.dev';
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok   ${name}` : `  FAIL ${name} ${extra}`);
  if (!cond) failures++;
};
const post = async (action, body) => {
  const res = await fetch(`${BASE}/api/room?action=${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const get = async (code) => {
  const res = await fetch(`${BASE}/api/room?code=${code}`);
  return { status: res.status, data: await res.json().catch(() => null) };
};

console.log('\n== 4 人部屋を作って埋める ==');
const created = await post('create', { seats: 4 });
check('4 人部屋を作れる', created.status === 200 && created.data.seats === 4, JSON.stringify(created.data).slice(0,120));
const code = created.data.code;
const tokens = { 1: created.data.token };
check('盤が 20×20 になる', created.data.game.board.length === 400);
check('遊び方が four', created.data.game.variant === 'four');
check('手札が 4 人分', Object.keys(created.data.game.hands).length === 4);
check('作った直後は待機', created.data.status === 'waiting' && created.data.joined === 1);

const j2 = await post('join', { code });
check('2 人目が席 2 に入る', j2.status === 200 && j2.data.player === 2, JSON.stringify(j2.data?.error));
tokens[2] = j2.data.token;
check('2 人では まだ待機', j2.data.status === 'waiting' && j2.data.joined === 2);

const j3 = await post('join', { code }); // わざと同じ色
check('3 人目が席 3 に入る', j3.status === 200 && j3.data.player === 3);
tokens[3] = j3.data.token;

const j4 = await post('join', { code });
check('4 人目が席 4 に入る', j4.status === 200 && j4.data.player === 4);
tokens[4] = j4.data.token;
check('4 人揃うと playing になる', j4.data.status === 'playing', j4.data.status);

const j5 = await post('join', { code });
check('5 人目は入れない', j5.status === 409, `status ${j5.status}`);

console.log('\n== 4 人で最後まで打つ ==');
const v = VARIANTS.four;
let game = j4.data.game;
let moves = 0;
let lastSeq = j4.data.seq;
const turnsSeen = new Set();

while (game.status === 'playing' && moves < 120) {
  const p = game.turn;
  turnsSeen.add(p);
  const list = legalMoves(v, game.board, p, game.hands[p], isFirstMove(game, p));
  if (!list.length) { check(`${moves}手目: 手番なのに合法手が無い`, false); break; }
  list.sort((a, b) => b.cells.length - a.cells.length);
  const m = list[0];
  const res = await post('move', { code, token: tokens[p], pieceId: m.pieceId, cells: m.cells });
  if (res.status !== 200) { check(`${moves}手目が通らない`, false, `${res.status} ${res.data?.error}`); break; }
  if (res.data.seq <= lastSeq) { check(`${moves}手目 seq が進んでいない`, false); break; }
  lastSeq = res.data.seq;
  game = res.data.game;
  moves++;
}
check(`終局した (${moves}手)`, game.status === 'finished', `status=${game.status}`);
check('4 人全員が手番を持った', turnsSeen.size === 4, [...turnsSeen].join(','));
check('4 色すべてが盤に出ている',
  [1,2,3,4].every(p => game.board.filter(x => x === p).length > 0),
  JSON.stringify([1,2,3,4].map(p => game.board.filter(x => x === p).length)));

console.log('\n== 手番でない人は打てない ==');
const wrong = await post('move', { code, token: tokens[1], pieceId: 'I1', cells: [[0,0]] });
check('終局後は打てない', wrong.status === 409, `status ${wrong.status}`);

console.log('\n== 後片付け ==');
await post('leave', { code, token: tokens[1] });
check('消したあとは読めない', (await get(code)).status === 404);

console.log('\n== 空席を CPU で埋めて始める ==');
const solo = await post('create', { seats: 4 });
const c2 = solo.data.code;
const t = solo.data.token;
const guest = await post('join', { code: c2 });
check('1 人参加した時点ではまだ待機', guest.data.status === 'waiting' && guest.data.joined === 2);

const notHost = await post('start', { code: c2, token: guest.data.token });
check('主催者以外は始められない', notHost.status === 403, `status ${notHost.status}`);

const started = await post('start', { code: c2, token: t });
check('主催者は始められる', started.status === 200 && started.data.status === 'playing', JSON.stringify(started.data?.error));
check('空いていた席が CPU になる', JSON.stringify(started.data.cpu) === '[3,4]', JSON.stringify(started.data.cpu));

// 主催者は CPU 席の代打ちができる
let g2 = started.data.game;
const first = legalMoves(v, g2.board, 1, g2.hands[1], true)[0];
const m1 = await post('move', { code: c2, token: t, pieceId: first.pieceId, cells: first.cells });
check('主催者が自分の手を打てる', m1.status === 200, JSON.stringify(m1.data?.error));
g2 = m1.data.game;
const second = legalMoves(v, g2.board, 2, g2.hands[2], true)[0];
const m2 = await post('move', { code: c2, token: guest.data.token, pieceId: second.pieceId, cells: second.cells });
check('参加者が自分の手を打てる', m2.status === 200, JSON.stringify(m2.data?.error));
g2 = m2.data.game;
check('次は CPU の席 3', g2.turn === 3, `turn=${g2.turn}`);

const third = legalMoves(v, g2.board, 3, g2.hands[3], true)[0];
const byGuest = await post('move', { code: c2, token: guest.data.token, pieceId: third.pieceId, cells: third.cells });
check('参加者は CPU 席を代打ちできない', byGuest.status === 409, `status ${byGuest.status}`);
const byHost = await post('move', { code: c2, token: t, pieceId: third.pieceId, cells: third.cells });
check('主催者は CPU 席を代打ちできる', byHost.status === 200, JSON.stringify(byHost.data?.error));

await post('leave', { code: c2, token: t });

console.log(failures === 0 ? '\n✅ すべて通過\n' : `\n❌ ${failures} 件失敗\n`);
process.exit(failures ? 1 : 0);
