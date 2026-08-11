/**
 * BLOCKS — CPU の思考
 *
 * 1 手先を読む評価関数型。ブロックスは「大きいピースを早く捌く」「自分の角(展開点)を増やす」
 * 「相手の角を潰す」の 3 つがほぼ全てなので、その 3 つを重み付けして足している。
 * 探索は 1 手分だけなので、盤面が大きくても一瞬で返る。
 */

import {
  N,
  START,
  PIECE_SIZE,
  legalMoves,
  anchorCells,
  isFirstMove,
} from './rules.js';

/** 難易度。ラベルは UI からそのまま使う。 */
export const LEVELS = {
  easy: { id: 'easy', label: 'やさしい' },
  normal: { id: 'normal', label: 'ふつう' },
  hard: { id: 'hard', label: 'つよい' },
};

const WEIGHTS = {
  easy: { size: 45, myMobility: 0, oppMobility: 0, advance: 0, noise: 340 },
  normal: { size: 100, myMobility: 14, oppMobility: 0, advance: 2, noise: 45 },
  hard: { size: 100, myMobility: 18, oppMobility: 14, advance: 4, noise: 10 },
};

/** 盤面を書き換えずに、その手を打った後の盤面を作る。 */
function boardAfter(board, player, cells) {
  const next = board.slice();
  for (const [r, c] of cells) next[r * N + c] = player;
  return next;
}

/**
 * 相手の開始点にどれだけ近づいたか。
 * 序盤に中央へ張り出すほど後半の展開が効くので、わずかな加点として効かせる。
 */
function advanceScore(cells, player) {
  const [tr, tc] = START[player === 1 ? 2 : 1];
  let best = Infinity;
  for (const [r, c] of cells) {
    const d = Math.abs(r - tr) + Math.abs(c - tc);
    if (d < best) best = d;
  }
  return -best; // 近いほど高い
}

/**
 * 指し手を選ぶ。打てる手が無ければ null を返す (呼び出し側でパス扱い)。
 */
export function chooseMove(game, player, level = 'normal') {
  const w = WEIGHTS[level] || WEIGHTS.normal;
  const first = isFirstMove(game, player);
  const moves = legalMoves(game.board, player, game.hands[player], first);
  if (moves.length === 0) return null;

  const opponent = player === 1 ? 2 : 1;
  const opponentFirst = isFirstMove(game, opponent);

  // 相手の展開点を数えるのは少し重いので、必要な難易度のときだけ計算する
  const wantsOpponent = w.oppMobility !== 0;

  let best = null;
  let bestScore = -Infinity;

  for (const move of moves) {
    const after = boardAfter(game.board, player, move.cells);

    let score = PIECE_SIZE[move.pieceId] * w.size;
    score += anchorCells(after, player, false).length * w.myMobility;
    if (wantsOpponent) {
      score -= anchorCells(after, opponent, opponentFirst).length * w.oppMobility;
    }
    score += advanceScore(move.cells, player) * w.advance;
    score += Math.random() * w.noise;

    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }

  return best;
}
