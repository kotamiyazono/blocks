/**
 * BLOCKS — ゲームルール
 *
 * 盤面やピースに関する純粋なロジックだけを置く。DOM にも通信にも依存しないので、
 * ブラウザと Cloudflare Worker の両方から同じものを読み込める。
 * オンライン対戦のサーバ側検証もここを使うため、ルールの定義は常にこの一箇所だけ。
 *
 * 2 人戦と 4 人戦では盤の広さも開始点も違うので、その差は VARIANTS にまとめ、
 * 判定する関数はどれも「どの遊び方か」を最初に受け取る形にしてある。
 */

/**
 * 遊び方ごとの盤の決まり。
 * 2 人戦は 14×14 の盤で、少し内側に入った 2 点から広げていく（ブロックス デュオ）。
 * 4 人戦は 20×20 の盤の四隅から。4 人分のピースは合わせて 356 マスあるので、
 * この広さが要る。
 */
export const VARIANTS = {
  duo: {
    id: 'duo',
    players: 2,
    size: 14,
    starts: { 1: [4, 4], 2: [9, 9] },
  },
  four: {
    id: 'four',
    players: 4,
    size: 20,
    // 手番の順に、左上 → 右上 → 右下 → 左下 と時計回り
    starts: { 1: [0, 0], 2: [0, 19], 3: [19, 19], 4: [19, 0] },
  },
};

const DEFAULT_VARIANT = 'duo';

/** 対局から遊び方の決まりを取り出す。 */
export const variantOf = (game) => VARIANTS[game?.variant] || VARIANTS[DEFAULT_VARIANT];

/**
 * 21 種類のピース定義。数字はブロックスの標準セット
 * (1 マス×1、2 マス×1、3 マス×2、4 マス×5、5 マス×12) で合計 89 マス。
 * 座標は [行, 列]。向きは後段で全パターン生成するので、ここでは代表形だけ持つ。
 */
const SHAPES = {
  I1: [[0, 0]],
  I2: [[0, 0], [0, 1]],
  I3: [[0, 0], [0, 1], [0, 2]],
  V3: [[0, 0], [1, 0], [1, 1]],
  I4: [[0, 0], [0, 1], [0, 2], [0, 3]],
  O4: [[0, 0], [0, 1], [1, 0], [1, 1]],
  T4: [[0, 0], [0, 1], [0, 2], [1, 1]],
  L4: [[0, 0], [1, 0], [2, 0], [2, 1]],
  S4: [[0, 1], [0, 2], [1, 0], [1, 1]],
  F5: [[0, 1], [0, 2], [1, 0], [1, 1], [2, 1]],
  I5: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]],
  L5: [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1]],
  N5: [[0, 1], [1, 1], [2, 0], [2, 1], [3, 0]],
  P5: [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0]],
  T5: [[0, 0], [0, 1], [0, 2], [1, 1], [2, 1]],
  U5: [[0, 0], [0, 2], [1, 0], [1, 1], [1, 2]],
  V5: [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]],
  W5: [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2]],
  X5: [[0, 1], [1, 0], [1, 1], [1, 2], [2, 1]],
  Y5: [[0, 1], [1, 0], [1, 1], [2, 1], [3, 1]],
  Z5: [[0, 0], [0, 1], [1, 1], [2, 1], [2, 2]],
};

/** 全ピース ID。手札の初期値でもある。 */
export const PIECE_IDS = Object.freeze(Object.keys(SHAPES));

/** ピース ID → マス数。スコア計算で使う。 */
export const PIECE_SIZE = Object.freeze(
  Object.fromEntries(PIECE_IDS.map((id) => [id, SHAPES[id].length]))
);

/** 全ピースの合計マス数 (= 89)。 */
export const TOTAL_SQUARES = PIECE_IDS.reduce((sum, id) => sum + PIECE_SIZE[id], 0);

/** 形を左上詰めにし、順序を正規化する。向きの重複判定に使う。 */
function normalize(cells) {
  let minR = Infinity;
  let minC = Infinity;
  for (const [r, c] of cells) {
    if (r < minR) minR = r;
    if (c < minC) minC = c;
  }
  return cells
    .map(([r, c]) => [r - minR, c - minC])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * ピース ID → 取りうる向きの配列。
 * 90° 回転 4 通り × 裏返し 2 通りを作って重複を除くので、
 * 対称なピースほど向きの数は少なくなる (X5 なら 1 通り、I1 も 1 通り)。
 */
export const ORIENTATIONS = Object.freeze(
  Object.fromEntries(
    PIECE_IDS.map((id) => {
      const seen = new Set();
      const list = [];
      for (let flip = 0; flip < 2; flip++) {
        // flip=0 はそのまま、flip=1 は左右反転から始める
        let cur = flip === 0 ? SHAPES[id] : SHAPES[id].map(([r, c]) => [r, -c]);
        for (let rot = 0; rot < 4; rot++) {
          const shape = normalize(cur);
          const key = JSON.stringify(shape);
          if (!seen.has(key)) {
            seen.add(key);
            list.push(shape);
          }
          cur = cur.map(([r, c]) => [c, -r]); // 90° 回転
        }
      }
      return [id, list];
    })
  )
);

/** ある向きの外接サイズを返す。 */
export function extent(shape) {
  let h = 0;
  let w = 0;
  for (const [r, c] of shape) {
    if (r > h) h = r;
    if (c > w) w = c;
  }
  return [h + 1, w + 1];
}

/** 新しい対局状態を作る。オンライン対戦でもそのまま JSON にできる形にしておく。 */
export function createGame(variantId = DEFAULT_VARIANT) {
  const v = VARIANTS[variantId] || VARIANTS[DEFAULT_VARIANT];
  const hands = {};
  for (let p = 1; p <= v.players; p++) hands[p] = [...PIECE_IDS];

  return {
    variant: v.id,
    board: new Array(v.size * v.size).fill(0), // 0=空き, 1..4=そのプレイヤーの駒
    hands,
    turn: 1,
    lastMove: null,   // { player, pieceId, cells }
    passedBy: [],     // 直前に手がなくて飛ばされたプレイヤー
    status: 'playing', // 'playing' | 'finished'
    moveCount: 0,
  };
}

/** そのプレイヤーがまだ一手も打っていないか (= 次が開始点しばりの一手目か)。 */
export function isFirstMove(game, player) {
  return game.hands[player].length === PIECE_IDS.length;
}

const ORTHOGONAL = [[0, 1], [0, -1], [1, 0], [-1, 0]];
const DIAGONAL = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * 配置が合法かどうか。ブロックスの 3 つの原則をそのまま判定する。
 *   1. 盤内の空きマスであること
 *   2. 自分の駒と辺で接してはいけない
 *   3. 自分の駒と角で接していること (ただし一手目は自分の開始点を覆うこと)
 * 他の色の駒とは辺で接してよい。
 */
export function canPlace(v, board, player, cells, first) {
  const size = v.size;
  const inBounds = (r, c) => r >= 0 && r < size && c >= 0 && c < size;
  let touchesCorner = false;

  for (const [r, c] of cells) {
    if (!inBounds(r, c)) return false;
    if (board[r * size + c] !== 0) return false;

    for (const [dr, dc] of ORTHOGONAL) {
      const rr = r + dr;
      const cc = c + dc;
      if (inBounds(rr, cc) && board[rr * size + cc] === player) return false;
    }

    if (!touchesCorner) {
      for (const [dr, dc] of DIAGONAL) {
        const rr = r + dr;
        const cc = c + dc;
        if (inBounds(rr, cc) && board[rr * size + cc] === player) {
          touchesCorner = true;
          break;
        }
      }
    }
  }

  if (first) {
    const [sr, sc] = v.starts[player];
    return cells.some(([r, c]) => r === sr && c === sc);
  }
  return touchesCorner;
}

/**
 * 次の一手が接点にできるマスの一覧。
 * 合法手は必ずこのいずれかを含むので、全マス総当たりの代わりにここを起点に探索すると
 * 探索量が一桁以上減る。CPU の思考と「打てる手が残っているか」の判定を実用速度に保つための要。
 */
export function anchorCells(v, board, player, first) {
  if (first) return [v.starts[player]];

  const size = v.size;
  const inBounds = (r, c) => r >= 0 && r < size && c >= 0 && c < size;
  const anchors = [];

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r * size + c] !== 0) continue;

      let edgeAdjacent = false;
      for (const [dr, dc] of ORTHOGONAL) {
        const rr = r + dr;
        const cc = c + dc;
        if (inBounds(rr, cc) && board[rr * size + cc] === player) {
          edgeAdjacent = true;
          break;
        }
      }
      if (edgeAdjacent) continue; // 辺で接するマスはそもそも置けない

      for (const [dr, dc] of DIAGONAL) {
        const rr = r + dr;
        const cc = c + dc;
        if (inBounds(rr, cc) && board[rr * size + cc] === player) {
          anchors.push([r, c]);
          break;
        }
      }
    }
  }
  return anchors;
}

/**
 * 合法手を列挙する。`limit` を渡すとその数で打ち切る (存在確認だけしたいとき用)。
 * 同じ配置が複数の接点から見つかることがあるので、占有マスの組で重複を除く。
 */
export function legalMoves(v, board, player, hand, first, limit = Infinity) {
  const anchors = anchorCells(v, board, player, first);
  if (anchors.length === 0) return [];

  const size = v.size;
  const moves = [];
  const seen = new Set();

  for (const [ar, ac] of anchors) {
    for (const id of hand) {
      for (const shape of ORIENTATIONS[id]) {
        // 形のどのマスを接点に重ねるかを総当たりする
        for (const [or, oc] of shape) {
          const dr = ar - or;
          const dc = ac - oc;
          const cells = shape.map(([r, c]) => [r + dr, c + dc]);
          if (!canPlace(v, board, player, cells, first)) continue;

          const key = id + ':' + cells.map(([r, c]) => r * size + c).sort((a, b) => a - b).join(',');
          if (seen.has(key)) continue;
          seen.add(key);

          moves.push({ pieceId: id, cells });
          if (moves.length >= limit) return moves;
        }
      }
    }
  }
  return moves;
}

/** 打てる手が 1 つでも残っているか。 */
export function hasLegalMove(v, board, player, hand, first) {
  if (hand.length === 0) return false;
  return legalMoves(v, board, player, hand, first, 1).length > 0;
}

/**
 * 一手を適用して新しい状態を返す (元の状態は変更しない)。
 * 打てる人がいなくなった順に手番を飛ばし、全員が打てなくなった時点で終局にする。
 */
export function applyMove(game, player, pieceId, cells) {
  const v = variantOf(game);
  const size = v.size;

  const next = {
    variant: game.variant,
    board: game.board.slice(),
    hands: Object.fromEntries(Object.entries(game.hands).map(([p, h]) => [p, [...h]])),
    turn: game.turn,
    lastMove: { player, pieceId, cells: cells.map(([r, c]) => [r, c]) },
    passedBy: [],
    status: 'playing',
    moveCount: game.moveCount + 1,
  };

  for (const [r, c] of cells) next.board[r * size + c] = player;
  next.hands[player] = next.hands[player].filter((id) => id !== pieceId);

  const canMove = (p) =>
    hasLegalMove(v, next.board, p, next.hands[p], isFirstMove(next, p));

  // 手番の順に次の打てる人を探す。飛ばした人は控えておいて知らせる
  const skipped = [];
  let following = 0;
  for (let step = 1; step < v.players; step++) {
    const p = ((player - 1 + step) % v.players) + 1;
    if (canMove(p)) {
      following = p;
      break;
    }
    skipped.push(p);
  }

  // 誰も打てないなら、自分が続けられるかを見る
  if (!following && canMove(player)) following = player;

  if (following) {
    next.turn = following;
    next.passedBy = skipped;
  } else {
    next.status = 'finished';
  }

  return next;
}

/** 手札に残っているマス数。少ないほど良い。 */
export function remainingSquares(game, player) {
  return game.hands[player].reduce((sum, id) => sum + PIECE_SIZE[id], 0);
}

/**
 * 最終結果。残りマスが少ない順に並べ、いちばん少ない人が勝ち。
 * 同じ数で並んだ場合は winner を 0 にして引き分け扱いにする。
 */
export function result(game) {
  const v = variantOf(game);
  const remaining = {};
  for (let p = 1; p <= v.players; p++) remaining[p] = remainingSquares(game, p);

  const ranking = Object.keys(remaining)
    .map(Number)
    .sort((a, b) => remaining[a] - remaining[b]);

  const best = remaining[ranking[0]];
  const leaders = ranking.filter((p) => remaining[p] === best);

  return { remaining, ranking, winner: leaders.length === 1 ? leaders[0] : 0, leaders };
}

/**
 * 盤上でピースが占めるマスを求める。anchor は指で触れている位置で、
 * 形の中心がそこに来るように置き、はみ出す場合は盤内に収める。
 */
export function cellsAtAnchor(v, pieceId, orientationIndex, anchor) {
  const shape = ORIENTATIONS[pieceId][orientationIndex];
  const [h, w] = extent(shape);
  const r0 = Math.min(Math.max(anchor[0] - Math.floor((h - 1) / 2), 0), v.size - h);
  const c0 = Math.min(Math.max(anchor[1] - Math.floor((w - 1) / 2), 0), v.size - w);
  return shape.map(([r, c]) => [r + r0, c + c0]);
}

/** 仮置きの駒を dr/dc マスだけずらした先の anchor を返す。 */
export function nudgeAnchor(v, pieceId, orientationIndex, anchor, dr, dc) {
  const clamp = (x) => Math.min(Math.max(x, 0), v.size - 1);
  const next = [clamp(anchor[0] + dr), clamp(anchor[1] + dc)];
  return anchorForCells(cellsAtAnchor(v, pieceId, orientationIndex, next));
}

/**
 * 与えられたマスの組が、そのピースを回転・反転して得られる形と一致するか。
 * オンライン対戦でクライアントから送られてきた着手をサーバ側で検証するために使う。
 */
export function matchesPiece(v, pieceId, cells) {
  const list = ORIENTATIONS[pieceId];
  if (!list) return false;
  if (!Array.isArray(cells) || cells.length !== PIECE_SIZE[pieceId]) return false;

  for (const cell of cells) {
    if (!Array.isArray(cell) || cell.length !== 2) return false;
    const [r, c] = cell;
    if (!Number.isInteger(r) || !Number.isInteger(c)) return false;
    if (r < 0 || r >= v.size || c < 0 || c >= v.size) return false;
  }

  // 同じマスが重複していないこと
  if (new Set(cells.map(([r, c]) => r * v.size + c)).size !== cells.length) return false;

  const key = JSON.stringify(normalize(cells));
  return list.some((shape) => JSON.stringify(shape) === key);
}

/** 盤上のマスの組が、そのピースのどの向きにあたるかを返す。無ければ -1。 */
export function orientationIndexOf(pieceId, cells) {
  const key = JSON.stringify(normalize(cells));
  return ORIENTATIONS[pieceId].findIndex((shape) => JSON.stringify(shape) === key);
}

/**
 * cellsAtAnchor の逆算。既に決まっている配置を、同じ結果になる anchor に変換する。
 */
export function anchorForCells(cells) {
  let minR = Infinity, minC = Infinity, maxR = -1, maxC = -1;
  for (const [r, c] of cells) {
    if (r < minR) minR = r;
    if (c < minC) minC = c;
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  return [
    minR + Math.floor((maxR - minR) / 2),
    minC + Math.floor((maxC - minC) / 2),
  ];
}

/** 今の向きを左右反転した向きの番号を返す。見つからなければ今のまま。 */
export function flippedOrientation(pieceId, orientationIndex) {
  const list = ORIENTATIONS[pieceId];
  const shape = list[orientationIndex];
  const maxC = Math.max(...shape.map(([, c]) => c));
  const target = JSON.stringify(normalize(shape.map(([r, c]) => [r, maxC - c])));
  const found = list.findIndex((o) => JSON.stringify(o) === target);
  return found >= 0 ? found : orientationIndex;
}
