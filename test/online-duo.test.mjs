/**
 * BLOCKS — オンライン対戦（2 人戦）の通し検証
 *
 * 実際に動いているサーバへ本物のリクエストを投げる。
 * ルールの検証（rules.test.mjs）と違い、部屋の作成・参加・着手の権限・終局まで、
 * 通信をまたいだ振る舞いを確かめるためのもの。
 */
import { VARIANTS, legalMoves, isFirstMove } from '../public/js/rules.js';
const V = VARIANTS.duo;

// 既定は本番。別の環境に向けるときは BLOCKS_URL を指定する
const BASE = process.env.BLOCKS_URL || 'https://blocks.superblue.app';
let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(cond ? `  ok   ${name}` : `  FAIL ${name} ${extra}`);
  if (!cond) failures++;
};

const post = async (action, body) => {
  const res = await fetch(`${BASE}/api/room?action=${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const get = async (code, since) => {
  const q = new URLSearchParams({ code });
  if (since !== undefined) q.set('since', String(since));
  const res = await fetch(`${BASE}/api/room?${q}`);
  return { status: res.status, data: await res.json().catch(() => null) };
};

console.log('\n== 部屋の作成と参加 ==');
const created = await post('create');
check('部屋を作れる', created.status === 200 && created.data.code, JSON.stringify(created.data).slice(0,120));
const code = created.data.code;
const hostToken = created.data.token;
check('作成直後は waiting', created.data.status === 'waiting');
check('作成直後は相手なし', created.data.hasOpponent === false);
check('作成者は先手', created.data.player === 1);

const peek = await get(code);
check('作る前を知らない相手でも部屋を読める', peek.status === 200 && peek.data.status === 'waiting');

const badJoin = await post('join', { code: 'ZZZZ' });
check('存在しない部屋には入れない', badJoin.status === 404, `status ${badJoin.status}`);

const joined = await post('join', { code });
check('相手として参加できる', joined.status === 200 && joined.data.player === 2, JSON.stringify(joined.data).slice(0,120));
const guestToken = joined.data.token;
check('参加すると playing になる', joined.data.status === 'playing');
check('参加すると相手ありになる', joined.data.hasOpponent === true);

const third = await post('join', { code });
check('3人目は入れない', third.status === 409, `status ${third.status}`);

console.log('\n== ポーリング ==');
const same = await get(code, joined.data.seq);
check('変化が無ければ unchanged で返る', same.data.unchanged === true, JSON.stringify(same.data));
const older = await get(code, 0);
check('古い seq を渡せば盤面が返る', Boolean(older.data.game));

console.log('\n== 着手とサーバ側の検証 ==');
let game = joined.data.game;
const firstMove = legalMoves(V, game.board, 1, game.hands[1], true)
  .find(m => m.pieceId === 'I5');

const wrongTurn = await post('move', { code, token: guestToken, pieceId: firstMove.pieceId, cells: firstMove.cells });
check('手番でない側の着手は拒否', wrongTurn.status === 409, `status ${wrongTurn.status} ${wrongTurn.data?.error}`);

const noToken = await post('move', { code, token: 'deadbeef', pieceId: firstMove.pieceId, cells: firstMove.cells });
check('参加者でない者の着手は拒否', noToken.status === 403, `status ${noToken.status}`);

const badShape = await post('move', { code, token: hostToken, pieceId: 'I5', cells: [[4,4],[4,5],[4,6]] });
check('ピースの形と違う着手は拒否', badShape.status === 400, `status ${badShape.status} ${badShape.data?.error}`);

const offBoard = await post('move', { code, token: hostToken, pieceId: 'I5', cells: [[0,-1],[0,0],[0,1],[0,2],[0,3]] });
check('盤外を含む着手は拒否', offBoard.status === 400, `status ${offBoard.status}`);

const notFirst = await post('move', { code, token: hostToken, pieceId: 'I5', cells: [[0,0],[0,1],[0,2],[0,3],[0,4]] });
check('開始点を覆わない初手は拒否', notFirst.status === 400, `status ${notFirst.status} ${notFirst.data?.error}`);

const notInHand = await post('move', { code, token: hostToken, pieceId: 'NOPE', cells: firstMove.cells });
check('持っていないピースは拒否', notInHand.status === 400, `status ${notInHand.status}`);

const ok = await post('move', { code, token: hostToken, pieceId: firstMove.pieceId, cells: firstMove.cells });
check('正しい着手は通る', ok.status === 200 && ok.data.game.turn === 2, JSON.stringify(ok.data?.error || ok.data.game?.turn));
check('着手で seq が進む', ok.data.seq > joined.data.seq);
check('着手で手札が減る', ok.data.game.hands[1].length === 20);
check('盤面に反映される', firstMove.cells.every(([r,c]) => ok.data.game.board[r*14+c] === 1));

console.log('\n== 同時着手 ==');
const raceCreated = await post('create');
const raceCode = raceCreated.data.code;
const raceJoined = await post('join', { code: raceCode });
const beforeRace = raceJoined;
const moveBody = { code: raceCode, token: raceCreated.data.token, pieceId: firstMove.pieceId, cells: firstMove.cells };
const [raceA, raceB] = await Promise.all([post('move', moveBody), post('move', moveBody)]);
const statuses = [raceA.status, raceB.status].sort((a, b) => a - b);
check('同じ手を同時に送ると 200 は 1 本、敗者は 409', statuses[0] === 200 && statuses[1] === 409 && [raceA, raceB].some(r => r.data?.error === 'あなたの手番ではありません'), JSON.stringify(statuses));
const afterRace = await get(raceCode, 0);
check('同時着手で seq は 1 だけ進み手番が進む', afterRace.data.seq === beforeRace.data.seq + 1 && afterRace.data.game.turn === 2);
const beforeCount = beforeRace.data.game.board.filter((v) => v === 1).length;
const afterCount = afterRace.data.game.board.filter((v) => v === 1).length;
check('同時着手でピースのマスが重複しない', afterCount - beforeCount === firstMove.cells.length);
await post('leave', { code: raceCode, token: raceCreated.data.token });

console.log('\n== 対局を最後まで進める ==');
game = ok.data.game;
const tokens = { 1: hostToken, 2: guestToken };
let moves = 1;
let lastSeq = ok.data.seq;
while (game.status === 'playing' && moves < 100) {
  const p = game.turn;
  const list = legalMoves(V, game.board, p, game.hands[p], isFirstMove(game, p));
  if (!list.length) { check('手番なのに合法手が無い', false); break; }
  // 大きいピースから捌いて手数を抑える
  list.sort((a, b) => b.cells.length - a.cells.length);
  const m = list[0];
  const res = await post('move', { code, token: tokens[p], pieceId: m.pieceId, cells: m.cells });
  if (res.status !== 200) { check(`${moves}手目が通らない`, false, `${res.status} ${res.data?.error}`); break; }
  check(`${moves}手目 seq が単調増加`, res.data.seq > lastSeq, `${res.data.seq} <= ${lastSeq}`);
  lastSeq = res.data.seq;
  game = res.data.game;
  moves++;
}
check(`終局した (${moves}手)`, game.status === 'finished', `status=${game.status}`);

const afterEnd = await get(code, 0);
check('終局後も結果を読める', afterEnd.status === 200 && afterEnd.data.status === 'finished');

const moveAfterEnd = await post('move', { code, token: hostToken, pieceId: 'I1', cells: [[0,0]] });
check('終局後の着手は拒否', moveAfterEnd.status === 409, `status ${moveAfterEnd.status}`);

console.log('\n== 再戦と後片付け ==');
const rematch = await post('rematch', { code, token: guestToken });
check('再戦できる', rematch.status === 200 && rematch.data.status === 'playing', JSON.stringify(rematch.data?.error));
check('再戦で盤面が新しくなる', rematch.data.game.board.every(v => v === 0));
check('再戦で手札が戻る', rematch.data.game.hands[1].length === 21 && rematch.data.game.hands[2].length === 21);

const outsiderLeave = await post('leave', { code, token: 'nope' });
check('参加者でない者は部屋を消せない', outsiderLeave.status === 403, `status ${outsiderLeave.status}`);

const left = await post('leave', { code, token: hostToken });
check('参加者は部屋を消せる', left.status === 200);

const gone = await get(code);
check('消したあとは読めない', gone.status === 404, `status ${gone.status}`);

const leaveAgain = await post('leave', { code, token: hostToken });
check('もう無い部屋を消しても失敗しない', leaveAgain.status === 200);

console.log(failures === 0 ? '\n✅ すべて通過\n' : `\n❌ ${failures} 件失敗\n`);
process.exit(failures ? 1 : 0);
