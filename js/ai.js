/**
 * BLOCKS — CPU の思考
 *
 * 1 手先を読む評価関数型。ブロックスは「大きいピースを早く捌く」「自分の角(展開点)を増やす」
 * 「他の色の角を潰す」の 3 つがほぼ全てなので、その 3 つを重み付けして足している。
 * 探索は 1 手分だけなので、盤面が大きくても一瞬で返る。
 */

import {
  PIECE_SIZE,
  legalMoves,
  anchorCells,
  isFirstMove,
  variantOf,
} from './rules.js';

const WEIGHTS = {
  easy: { size: 45, myMobility: 0, oppMobility: 0, advance: 0, noise: 340 },
  normal: { size: 100, myMobility: 14, oppMobility: 0, advance: 2, noise: 45 },
  hard: { size: 100, myMobility: 18, oppMobility: 14, advance: 4, noise: 10 },
};

/** 盤面を書き換えずに、その手を打った後の盤面を作る。 */
function boardAfter(board, size, player, cells) {
  const next = board.slice();
  for (const [r, c] of cells) next[r * size + c] = player;
  return next;
}

/**
 * 盤の真ん中にどれだけ近づいたか。
 * 隅や端に固まると後半の展開が効かなくなるので、わずかな加点として効かせる。
 */
function advanceScore(cells, size) {
  const middle = (size - 1) / 2;
  let best = Infinity;
  for (const [r, c] of cells) {
    const d = Math.abs(r - middle) + Math.abs(c - middle);
    if (d < best) best = d;
  }
  return -best; // 中央に近いほど高い
}

/**
 * 指し手を選ぶ。打てる手が無ければ null を返す (呼び出し側でパス扱い)。
 */
export function chooseMove(game, player, level = 'normal') {
  const w = WEIGHTS[level] || WEIGHTS.normal;
  const v = variantOf(game);
  const first = isFirstMove(game, player);
  const moves = legalMoves(v, game.board, player, game.hands[player], first);
  if (moves.length === 0) return null;

  // 他の色の展開を邪魔する評価は少し重いので、必要な難易度のときだけ計算する
  const rivals = w.oppMobility !== 0
    ? Object.keys(game.hands).map(Number).filter((p) => p !== player)
    : [];

  let best = null;
  let bestScore = -Infinity;

  for (const move of moves) {
    const after = boardAfter(game.board, v.size, player, move.cells);

    let score = PIECE_SIZE[move.pieceId] * w.size;
    score += anchorCells(v, after, player, false).length * w.myMobility;

    // 他の色の展開点は、人数で割って 1 人あたりの重みが変わらないようにする
    for (const rival of rivals) {
      const rivalFirst = isFirstMove(game, rival);
      score -= anchorCells(v, after, rival, rivalFirst).length * (w.oppMobility / rivals.length);
    }

    score += advanceScore(move.cells, v.size) * w.advance;
    score += Math.random() * w.noise;

    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }

  return best;
}
