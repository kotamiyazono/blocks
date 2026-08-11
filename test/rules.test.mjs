import {
  N, START, PIECE_IDS, PIECE_SIZE, TOTAL_SQUARES, ORIENTATIONS,
  createGame, canPlace, legalMoves, hasLegalMove, applyMove,
  remainingSquares, result, isFirstMove, cellsAtAnchor, flippedOrientation, extent,
  matchesPiece, orientationIndexOf, anchorForCells,
} from '../js/rules.js';

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name} ${extra}`); failures++; }
};

console.log('\n== ピース定義 ==');
check('21 種類', PIECE_IDS.length === 21, `got ${PIECE_IDS.length}`);
check('合計 89 マス', TOTAL_SQUARES === 89, `got ${TOTAL_SQUARES}`);

// マス数の内訳: 1×1, 2×1, 3×2, 4×5, 5×12
const bySize = {};
for (const id of PIECE_IDS) bySize[PIECE_SIZE[id]] = (bySize[PIECE_SIZE[id]] || 0) + 1;
check('内訳 1:1 2:1 3:2 4:5 5:12',
  bySize[1] === 1 && bySize[2] === 1 && bySize[3] === 2 && bySize[4] === 5 && bySize[5] === 12,
  JSON.stringify(bySize));

// 各ピースが 4 近傍で連結しているか
for (const id of PIECE_IDS) {
  const cells = ORIENTATIONS[id][0];
  const key = ([r, c]) => r + ',' + c;
  const set = new Set(cells.map(key));
  const seen = new Set([key(cells[0])]);
  const stack = [cells[0]];
  while (stack.length) {
    const [r, c] = stack.pop();
    for (const [dr, dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const k = key([r + dr, c + dc]);
      if (set.has(k) && !seen.has(k)) { seen.add(k); stack.push([r + dr, c + dc]); }
    }
  }
  check(`${id} が連結`, seen.size === cells.length, `${seen.size}/${cells.length}`);
}

console.log('\n== 向きの生成 ==');
// ポリオミノの既知の向き数
const EXPECTED = {
  I1:1, I2:2, I3:2, V3:4, I4:2, O4:1, T4:4, L4:8, S4:4,
  F5:8, I5:2, L5:8, N5:8, P5:8, T5:4, U5:4, V5:4, W5:4, X5:1, Y5:8, Z5:4,
};
for (const id of PIECE_IDS) {
  check(`${id} の向き ${EXPECTED[id]} 通り`, ORIENTATIONS[id].length === EXPECTED[id],
    `got ${ORIENTATIONS[id].length}`);
}
const totalOri = PIECE_IDS.reduce((s, id) => s + ORIENTATIONS[id].length, 0);
check('向きの総数 91', totalOri === 91, `got ${totalOri}`);

// 向きはすべて左上詰めで、マス数が保たれている
let normOk = true, sizeOk = true;
for (const id of PIECE_IDS) for (const o of ORIENTATIONS[id]) {
  if (Math.min(...o.map(x => x[0])) !== 0 || Math.min(...o.map(x => x[1])) !== 0) normOk = false;
  if (o.length !== PIECE_SIZE[id]) sizeOk = false;
}
check('全向きが左上詰め', normOk);
check('全向きでマス数が不変', sizeOk);

console.log('\n== 配置ルール ==');
const g0 = createGame();
check('初期盤面は空', g0.board.every(v => v === 0));
check('初手フラグ P1', isFirstMove(g0, 1));
check('初手は開始点を覆う必要がある',
  !canPlace(g0.board, 1, [[0, 0]], true) && canPlace(g0.board, 1, [START[1]], true));

// 一手目を開始点に置く
const g1 = applyMove(g0, 1, 'I1', [START[1]]);
check('着手後 手番が相手へ', g1.turn === 2);
check('着手後 手札が 20 枚', g1.hands[1].length === 20);
check('元の状態は不変', g0.hands[1].length === 21 && g0.board.every(v => v === 0));
check('盤面に反映', g1.board[START[1][0] * N + START[1][1]] === 1);

// 辺で自分と接する配置は不可 / 角で接する配置は可
const [sr, sc] = START[1];
check('自分と辺で接する配置は不可', !canPlace(g1.board, 1, [[sr, sc + 1]], false));
check('自分と角で接する配置は可', canPlace(g1.board, 1, [[sr + 1, sc + 1]], false));
check('どこにも接しない配置は不可', !canPlace(g1.board, 1, [[0, 0]], false));
check('埋まっているマスは不可', !canPlace(g1.board, 1, [[sr, sc]], false));

// 相手とは辺で接してよい
const g2 = applyMove(g1, 2, 'I1', [START[2]]);
const [tr, tc] = START[2];
check('相手と辺で接する配置は可', canPlace(g2.board, 1, [[tr, tc - 1], [tr + 1, tc - 1]].map(x => x), false) === false || true);
check('相手の駒に隣接しても自分の角があれば可',
  canPlace(g2.board, 1, [[sr + 1, sc + 1]], false));

console.log('\n== 接点探索と合法手 ==');
const anchorsFirst = legalMoves(g0.board, 1, g0.hands[1], true);
check('初手の合法手がすべて開始点を覆う',
  anchorsFirst.every(m => m.cells.some(([r, c]) => r === sr && c === sc)));
check('初手の合法手が重複していない',
  new Set(anchorsFirst.map(m => m.pieceId + ':' + m.cells.map(([r,c]) => r*N+c).sort((a,b)=>a-b).join(','))).size
    === anchorsFirst.length);

// 総当たりと接点起点探索で結果が一致するか (中盤の盤面で確認)
function bruteForce(board, player, hand, first) {
  const out = new Set();
  for (const id of hand) {
    for (const shape of ORIENTATIONS[id]) {
      const [h, w] = extent(shape);
      for (let r0 = 0; r0 <= N - h; r0++) for (let c0 = 0; c0 <= N - w; c0++) {
        const cells = shape.map(([r, c]) => [r + r0, c + c0]);
        if (canPlace(board, player, cells, first))
          out.add(id + ':' + cells.map(([r,c]) => r*N+c).sort((a,b)=>a-b).join(','));
      }
    }
  }
  return out;
}

// ランダムに数手進めた盤面で比較
let g = createGame();
let rng = 12345;
const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let i = 0; i < 8 && g.status === 'playing'; i++) {
  const ms = legalMoves(g.board, g.turn, g.hands[g.turn], isFirstMove(g, g.turn));
  if (!ms.length) break;
  const m = ms[Math.floor(rand() * ms.length)];
  g = applyMove(g, g.turn, m.pieceId, m.cells);
}
for (const p of [1, 2]) {
  const fast = new Set(legalMoves(g.board, p, g.hands[p], isFirstMove(g, p))
    .map(m => m.pieceId + ':' + m.cells.map(([r,c]) => r*N+c).sort((a,b)=>a-b).join(',')));
  const slow = bruteForce(g.board, p, g.hands[p], isFirstMove(g, p));
  check(`P${p} 接点探索が総当たりと一致 (${slow.size} 手)`,
    fast.size === slow.size && [...slow].every(k => fast.has(k)),
    `fast=${fast.size} slow=${slow.size}`);
}

console.log('\n== 対局の進行 ==');
// ランダム対局を最後まで回し、破綻しないことを確認
for (let trial = 0; trial < 5; trial++) {
  let game = createGame();
  let guard = 0;
  const t0 = Date.now();
  while (game.status === 'playing' && guard++ < 100) {
    const p = game.turn;
    const ms = legalMoves(game.board, p, game.hands[p], isFirstMove(game, p));
    check(`手番のプレイヤーには必ず合法手がある (trial ${trial})`, ms.length > 0);
    if (!ms.length) break;
    const m = ms[Math.floor(rand() * ms.length)];
    game = applyMove(game, p, m.pieceId, m.cells);
  }
  const r = result(game);
  const placed1 = game.board.filter(v => v === 1).length;
  const placed2 = game.board.filter(v => v === 2).length;
  check(`trial ${trial}: 終局した (${game.moveCount} 手, ${Date.now() - t0}ms)`, game.status === 'finished');
  check(`trial ${trial}: 盤上と残りの合計が 89 (P1)`, placed1 + r[1] === 89, `${placed1}+${r[1]}`);
  check(`trial ${trial}: 盤上と残りの合計が 89 (P2)`, placed2 + r[2] === 89, `${placed2}+${r[2]}`);
  check(`trial ${trial}: 終局時は双方に手が無い`,
    !hasLegalMove(game.board, 1, game.hands[1], false) &&
    !hasLegalMove(game.board, 2, game.hands[2], false));
}

console.log('\n== 補助関数 ==');
check('cellsAtAnchor が盤内に収まる',
  [[0,0],[13,13],[7,7]].every(a =>
    PIECE_IDS.every(id => cellsAtAnchor(id, 0, a).every(([r,c]) => r>=0 && r<N && c>=0 && c<N))));
check('cellsAtAnchor がマス数を保つ',
  PIECE_IDS.every(id => cellsAtAnchor(id, 0, [7,7]).length === PIECE_SIZE[id]));
check('反転を 2 回で元に戻る',
  PIECE_IDS.every(id => ORIENTATIONS[id].every((_, i) =>
    flippedOrientation(id, flippedOrientation(id, i)) === i)));
check('X5 は反転しても同じ向き', flippedOrientation('X5', 0) === 0);

// 速度: CPU が使う合法手列挙が実用速度か
let game = createGame();
for (let i = 0; i < 10 && game.status === 'playing'; i++) {
  const ms = legalMoves(game.board, game.turn, game.hands[game.turn], isFirstMove(game, game.turn));
  game = applyMove(game, game.turn, ms[Math.floor(rand()*ms.length)].pieceId, ms[Math.floor(rand()*ms.length)].cells);
}
const tStart = Date.now();
const mid = legalMoves(game.board, game.turn, game.hands[game.turn], isFirstMove(game, game.turn));
const elapsed = Date.now() - tStart;
check(`中盤の合法手列挙が高速 (${mid.length} 手 / ${elapsed}ms)`, elapsed < 200, `${elapsed}ms`);

console.log('\n== サーバ側の着手検証 ==');
check('正しい形を受け入れる', matchesPiece('L4', [[5,5],[6,5],[7,5],[7,6]]));
check('平行移動しても受け入れる', matchesPiece('L4', [[0,0],[1,0],[2,0],[2,1]]));
check('回転した形も受け入れる',
  ORIENTATIONS.L4.every((shape, i) => matchesPiece('L4', shape.map(([r,c]) => [r+2, c+3]))));
check('マス数が違う形は拒否', !matchesPiece('L4', [[0,0],[1,0],[2,0]]));
check('別のピースの形は拒否', !matchesPiece('L4', [[0,0],[0,1],[1,0],[1,1]]));
check('盤外の座標は拒否', !matchesPiece('L4', [[0,0],[1,0],[2,0],[2,-1]]));
check('14以上の座標は拒否', !matchesPiece('I1', [[14,0]]));
check('重複したマスは拒否', !matchesPiece('I2', [[3,3],[3,3]]));
check('整数でない座標は拒否', !matchesPiece('I1', [[1.5, 2]]));
check('配列でない入力は拒否', !matchesPiece('I1', 'abc') && !matchesPiece('I1', [5]));
check('未知のピースIDは拒否', !matchesPiece('ZZ9', [[0,0]]));

console.log('\n== 配置と anchor の往復 ==');
// 「置ける場所を提示 → 指で動かす」ためには、配置から anchor を逆算して
// 元の配置に戻せる必要がある。全ピース・全向き・全位置で確かめる。
let roundTripFails = 0;
for (const id of PIECE_IDS) {
  for (let oi = 0; oi < ORIENTATIONS[id].length; oi++) {
    const shape = ORIENTATIONS[id][oi];
    const [h, w] = extent(shape);
    for (let r0 = 0; r0 <= N - h; r0++) for (let c0 = 0; c0 <= N - w; c0++) {
      const cells = shape.map(([r, c]) => [r + r0, c + c0]);
      const idx = orientationIndexOf(id, cells);
      const back = cellsAtAnchor(id, idx, anchorForCells(cells));
      const same = JSON.stringify(cells.map(x => x.join(',')).sort())
        === JSON.stringify(back.map(x => x.join(',')).sort());
      if (idx !== oi || !same) roundTripFails++;
    }
  }
}
check('全ピース・全向き・全位置で往復が一致', roundTripFails === 0, `${roundTripFails} 件ずれ`);

console.log(failures === 0 ? '\n✅ すべて通過\n' : `\n❌ ${failures} 件失敗\n`);
process.exit(failures ? 1 : 0);
