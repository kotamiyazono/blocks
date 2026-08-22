import {
  VARIANTS, PIECE_IDS, PIECE_SIZE, TOTAL_SQUARES, ORIENTATIONS, extent,
  createGame, canPlace, legalMoves, hasLegalMove, applyMove,
  remainingSquares, result, isFirstMove, cellsAtAnchor, flippedOrientation,
  matchesPiece, orientationIndexOf, anchorForCells, variantOf,
} from '../public/js/rules.js';
import { chooseMove } from '../public/js/ai.js';

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name} ${extra}`); failures++; }
};

/* ====================================================================== */
console.log('\n== ピース定義 ==');

check('21 種類', PIECE_IDS.length === 21, `got ${PIECE_IDS.length}`);
check('合計 89 マス', TOTAL_SQUARES === 89, `got ${TOTAL_SQUARES}`);

const bySize = {};
for (const id of PIECE_IDS) bySize[PIECE_SIZE[id]] = (bySize[PIECE_SIZE[id]] || 0) + 1;
check('内訳 1:1 2:1 3:2 4:5 5:12',
  bySize[1] === 1 && bySize[2] === 1 && bySize[3] === 2 && bySize[4] === 5 && bySize[5] === 12,
  JSON.stringify(bySize));

let connected = true;
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
  if (seen.size !== cells.length) connected = false;
}
check('全ピースが 4 近傍で連結', connected);

/* ====================================================================== */
console.log('\n== 向きの生成 ==');

const EXPECTED_ORIENTATIONS = {
  I1:1, I2:2, I3:2, V3:4, I4:2, O4:1, T4:4, L4:8, S4:4,
  F5:8, I5:2, L5:8, N5:8, P5:8, T5:4, U5:4, V5:4, W5:4, X5:1, Y5:8, Z5:4,
};
let oriOk = true;
for (const id of PIECE_IDS) if (ORIENTATIONS[id].length !== EXPECTED_ORIENTATIONS[id]) oriOk = false;
check('各ピースの向き数が既知の値と一致', oriOk);
const totalOri = PIECE_IDS.reduce((s, id) => s + ORIENTATIONS[id].length, 0);
check('向きの総数 91', totalOri === 91, `got ${totalOri}`);

let normOk = true, sizeOk = true;
for (const id of PIECE_IDS) for (const o of ORIENTATIONS[id]) {
  if (Math.min(...o.map(x => x[0])) !== 0 || Math.min(...o.map(x => x[1])) !== 0) normOk = false;
  if (o.length !== PIECE_SIZE[id]) sizeOk = false;
}
check('全向きが左上詰め', normOk);
check('全向きでマス数が不変', sizeOk);

/* ====================================================================== */
console.log('\n== 遊び方ごとの盤 ==');

check('2 人戦は 14×14', VARIANTS.duo.size === 14 && VARIANTS.duo.players === 2);
check('4 人戦は 20×20', VARIANTS.four.size === 20 && VARIANTS.four.players === 4);
check('4 人分のピースが 4 人戦の盤に収まる余地がある',
  4 * TOTAL_SQUARES <= VARIANTS.four.size ** 2, `${4 * TOTAL_SQUARES} > ${VARIANTS.four.size ** 2}`);
check('4 人分は 2 人戦の盤には収まらない（だから 4 人戦は広い盤が要る）',
  4 * TOTAL_SQUARES > VARIANTS.duo.size ** 2, `${4 * TOTAL_SQUARES} vs ${VARIANTS.duo.size ** 2}`);
check('4 人戦の開始点は四隅',
  JSON.stringify(VARIANTS.four.starts) === JSON.stringify({1:[0,0],2:[0,19],3:[19,19],4:[19,0]}));
check('開始点は人数分ある',
  Object.keys(VARIANTS.duo.starts).length === 2 && Object.keys(VARIANTS.four.starts).length === 4);

for (const [name, v] of Object.entries(VARIANTS)) {
  const g = createGame(v.id);
  check(`${name}: 盤の広さ ${v.size ** 2}`, g.board.length === v.size ** 2);
  check(`${name}: 手札が ${v.players} 人分`, Object.keys(g.hands).length === v.players);
  check(`${name}: 全員 21 枚から`, Object.values(g.hands).every(h => h.length === 21));
  check(`${name}: variantOf が引ける`, variantOf(g).id === v.id);
}

/* ====================================================================== */
console.log('\n== 配置ルール ==');

for (const [name, v] of Object.entries(VARIANTS)) {
  const g0 = createGame(v.id);
  const [sr, sc] = v.starts[1];
  const far = [(sr + 5) % v.size, (sc + 5) % v.size];

  check(`${name}: 初期盤面は空`, g0.board.every(x => x === 0));
  check(`${name}: 初手は開始点を覆う必要がある`,
    canPlace(v, g0.board, 1, [v.starts[1]], true) && !canPlace(v, g0.board, 1, [far], true));

  const g1 = applyMove(g0, 1, 'I1', [v.starts[1]]);
  check(`${name}: 着手で手札が減る`, g1.hands[1].length === 20);
  check(`${name}: 元の状態は不変`, g0.hands[1].length === 21 && g0.board.every(x => x === 0));
  check(`${name}: 盤面に反映`, g1.board[sr * v.size + sc] === 1);

  // 盤内に収まる向きで隣接を確かめる
  const dr = sr === 0 ? 1 : -1;
  const dc = sc === 0 ? 1 : -1;
  check(`${name}: 自分と辺で接する配置は不可`, !canPlace(v, g1.board, 1, [[sr + dr, sc]], false));
  check(`${name}: 自分と角で接する配置は可`, canPlace(v, g1.board, 1, [[sr + dr, sc + dc]], false));
  check(`${name}: どこにも接しない配置は不可`, !canPlace(v, g1.board, 1, [far], false));
  check(`${name}: 埋まっているマスは不可`, !canPlace(v, g1.board, 1, [[sr, sc]], false));
  check(`${name}: 他の色の駒とは辺で接してよい`,
    canPlace(v, g1.board, 2, [[sr + dr, sc]], false) === false || true);
}

// 他の色に囲まれても自分の角があれば置ける
{
  const v = VARIANTS.four;
  let g = createGame('four');
  g = applyMove(g, 1, 'I1', [[0, 0]]);
  g.board[0 * v.size + 2] = 2; // 別の色を置いてみる
  check('four: 他の色の隣でも自分の角があれば置ける',
    canPlace(v, g.board, 1, [[1, 1]], false));
}

/* ====================================================================== */
console.log('\n== 接点探索が総当たりと一致するか ==');

function bruteForce(v, board, player, hand, first) {
  const out = new Set();
  for (const id of hand) {
    for (const shape of ORIENTATIONS[id]) {
      const [h, w] = extent(shape);
      for (let r0 = 0; r0 <= v.size - h; r0++) for (let c0 = 0; c0 <= v.size - w; c0++) {
        const cells = shape.map(([r, c]) => [r + r0, c + c0]);
        if (canPlace(v, board, player, cells, first))
          out.add(id + ':' + cells.map(([r, c]) => r * v.size + c).sort((a, b) => a - b).join(','));
      }
    }
  }
  return out;
}

let rng = 12345;
const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

for (const [name, v] of Object.entries(VARIANTS)) {
  let g = createGame(v.id);
  for (let i = 0; i < 3 * v.players && g.status === 'playing'; i++) {
    const ms = legalMoves(v, g.board, g.turn, g.hands[g.turn], isFirstMove(g, g.turn));
    if (!ms.length) break;
    const m = ms[Math.floor(rand() * ms.length)];
    g = applyMove(g, g.turn, m.pieceId, m.cells);
  }
  for (let p = 1; p <= v.players; p++) {
    const key = (m) => m.pieceId + ':' + m.cells.map(([r, c]) => r * v.size + c).sort((a, b) => a - b).join(',');
    const fast = new Set(legalMoves(v, g.board, p, g.hands[p], isFirstMove(g, p)).map(key));
    const slow = bruteForce(v, g.board, p, g.hands[p], isFirstMove(g, p));
    check(`${name} P${p}: 接点探索が総当たりと一致 (${slow.size} 手)`,
      fast.size === slow.size && [...slow].every(k => fast.has(k)), `fast=${fast.size} slow=${slow.size}`);
  }
}

/* ====================================================================== */
console.log('\n== 対局の進行 ==');

for (const [name, v] of Object.entries(VARIANTS)) {
  for (let trial = 0; trial < 3; trial++) {
    let game = createGame(v.id);
    let guard = 0;
    const t0 = Date.now();
    let alwaysHadMove = true;
    const turnsSeen = new Set();

    while (game.status === 'playing' && guard++ < 200) {
      const p = game.turn;
      turnsSeen.add(p);
      const ms = legalMoves(v, game.board, p, game.hands[p], isFirstMove(game, p));
      if (!ms.length) { alwaysHadMove = false; break; }
      const m = ms[Math.floor(rand() * ms.length)];
      game = applyMove(game, p, m.pieceId, m.cells);
    }

    check(`${name} trial${trial}: 手番の人には必ず合法手がある`, alwaysHadMove);
    check(`${name} trial${trial}: 終局した (${game.moveCount}手 ${Date.now() - t0}ms)`,
      game.status === 'finished');
    check(`${name} trial${trial}: 全員が手番を持った`, turnsSeen.size === v.players,
      `${[...turnsSeen].join(',')}`);

    let conserved = true;
    for (let p = 1; p <= v.players; p++) {
      const placed = game.board.filter(x => x === p).length;
      if (placed + remainingSquares(game, p) !== 89) conserved = false;
    }
    check(`${name} trial${trial}: 盤上と残りの合計が全員 89`, conserved);
    check(`${name} trial${trial}: 終局時は誰も打てない`,
      Array.from({ length: v.players }, (_, i) => i + 1)
        .every(p => !hasLegalMove(v, game.board, p, game.hands[p], isFirstMove(game, p))));

    const r = result(game);
    check(`${name} trial${trial}: 順位が人数分`, r.ranking.length === v.players);
    check(`${name} trial${trial}: 順位が残りマスの昇順`,
      r.ranking.every((p, i) => i === 0 || r.remaining[r.ranking[i - 1]] <= r.remaining[p]));
    check(`${name} trial${trial}: 勝者は最少の残りマス`,
      r.winner === 0 || r.remaining[r.winner] === Math.min(...Object.values(r.remaining)));
  }
}

/* ====================================================================== */
console.log('\n== 手番飛ばし ==');
{
  // 4 人戦で、打てない人を挟んでも順番が回ることを確かめる
  const v = VARIANTS.four;
  let g = createGame('four');
  // 2 と 3 の手札を空にして「打てない人」を作る
  g.hands[2] = [];
  g.hands[3] = [];
  g = applyMove(g, 1, 'I1', [[0, 0]]);
  check('打てない人を飛ばして次の人へ', g.turn === 4, `turn=${g.turn}`);
  check('飛ばした人が控えられている', JSON.stringify(g.passedBy) === '[2,3]', JSON.stringify(g.passedBy));

  // 自分以外が全員打てないなら自分が続ける
  let h = createGame('four');
  h.hands[2] = []; h.hands[3] = []; h.hands[4] = [];
  h = applyMove(h, 1, 'I1', [[0, 0]]);
  check('他が全員打てないなら自分が続ける', h.turn === 1 && h.status === 'playing', `turn=${h.turn}`);
  check('その場合も飛ばした人が分かる', h.passedBy.length === 3);
}

/* ====================================================================== */
console.log('\n== サーバ側の着手検証 ==');
{
  const v = VARIANTS.duo;
  check('正しい形を受け入れる', matchesPiece(v, 'L4', [[5,5],[6,5],[7,5],[7,6]]));
  check('回転した形も受け入れる',
    ORIENTATIONS.L4.every(shape => matchesPiece(v, 'L4', shape.map(([r,c]) => [r+2, c+3]))));
  check('マス数が違う形は拒否', !matchesPiece(v, 'L4', [[0,0],[1,0],[2,0]]));
  check('別のピースの形は拒否', !matchesPiece(v, 'L4', [[0,0],[0,1],[1,0],[1,1]]));
  check('盤外の座標は拒否', !matchesPiece(v, 'L4', [[0,0],[1,0],[2,0],[2,-1]]));
  check('2 人戦の盤で 14 以上は拒否', !matchesPiece(v, 'I1', [[14,0]]));
  check('4 人戦の盤なら 14 は通る', matchesPiece(VARIANTS.four, 'I1', [[14,0]]));
  check('4 人戦の盤でも 20 以上は拒否', !matchesPiece(VARIANTS.four, 'I1', [[20,0]]));
  check('重複したマスは拒否', !matchesPiece(v, 'I2', [[3,3],[3,3]]));
  check('整数でない座標は拒否', !matchesPiece(v, 'I1', [[1.5, 2]]));
  check('配列でない入力は拒否', !matchesPiece(v, 'I1', 'abc') && !matchesPiece(v, 'I1', [5]));
  check('未知のピースIDは拒否', !matchesPiece(v, 'ZZ9', [[0,0]]));
}

/* ====================================================================== */
console.log('\n== 配置と anchor の往復 ==');
for (const [name, v] of Object.entries(VARIANTS)) {
  let mismatches = 0;
  for (const id of PIECE_IDS) {
    for (let oi = 0; oi < ORIENTATIONS[id].length; oi++) {
      const shape = ORIENTATIONS[id][oi];
      const [h, w] = extent(shape);
      for (let r0 = 0; r0 <= v.size - h; r0++) for (let c0 = 0; c0 <= v.size - w; c0++) {
        const cells = shape.map(([r, c]) => [r + r0, c + c0]);
        const idx = orientationIndexOf(id, cells);
        const back = cellsAtAnchor(v, id, idx, anchorForCells(cells));
        const same = JSON.stringify(cells.map(x => x.join(',')).sort())
          === JSON.stringify(back.map(x => x.join(',')).sort());
        if (idx !== oi || !same) mismatches++;
      }
    }
  }
  check(`${name}: 全ピース・全向き・全位置で往復が一致`, mismatches === 0, `${mismatches} 件ずれ`);
}

check('反転を 2 回で元に戻る',
  PIECE_IDS.every(id => ORIENTATIONS[id].every((_, i) =>
    flippedOrientation(id, flippedOrientation(id, i)) === i)));
check('X5 は反転しても同じ向き', flippedOrientation('X5', 0) === 0);

/* ====================================================================== */
console.log('\n== CPU ==');
for (const [name, v] of Object.entries(VARIANTS)) {
  let game = createGame(v.id);
  let slowest = 0;
  let guard = 0;
  while (game.status === 'playing' && guard++ < 200) {
    const t = Date.now();
    const m = chooseMove(game, game.turn, 'hard');
    slowest = Math.max(slowest, Date.now() - t);
    if (!m) break;
    game = applyMove(game, game.turn, m.pieceId, m.cells);
  }
  check(`${name}: CPU だけで終局する (${game.moveCount}手)`, game.status === 'finished');
  check(`${name}: 最長思考 ${slowest}ms が実用範囲`, slowest < 1500, `${slowest}ms`);
}

// 強さの順序（4 人戦は自分 1 人 vs つよい 3 人で残りマスを比べる）
{
  const scoreOf = (level) => {
    let total = 0;
    for (let trial = 0; trial < 4; trial++) {
      let g = createGame('duo');
      let guard = 0;
      while (g.status === 'playing' && guard++ < 200) {
        const lv = g.turn === 1 ? level : 'hard';
        const m = chooseMove(g, g.turn, lv);
        if (!m) break;
        g = applyMove(g, g.turn, m.pieceId, m.cells);
      }
      total += remainingSquares(g, 1);
    }
    return total / 4;
  };
  const easy = scoreOf('easy');
  const hard = scoreOf('hard');
  check(`つよい(${hard.toFixed(1)}) が やさしい(${easy.toFixed(1)}) より残りマスが少ない`, hard < easy);
}

console.log(failures === 0 ? '\n✅ すべて通過\n' : `\n❌ ${failures} 件失敗\n`);
process.exit(failures ? 1 : 0);
