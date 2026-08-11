/**
 * BLOCKS — 描画
 *
 * 盤面と持ちピースの DOM を作る／更新する部分。ゲームの進行や通信は扱わない。
 */

import { N, START, ORIENTATIONS, extent } from './rules.js';

/** CSS の .board の padding と一致させる（座標計算に使う）。 */
const BOARD_PADDING = 7;

/** 盤面の 196 マスを一度だけ作る。以降はクラスの付け替えだけで更新する。 */
export function buildBoard(el) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < N * N; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.i = String(i);
    frag.appendChild(cell);
  }
  el.replaceChildren(frag);
}

const startIndex = (player) => START[player][0] * N + START[player][1];

/**
 * 盤面を現在の状態に合わせて塗り直す。
 * ghost は仮置きのプレビューで、{ cells, valid, player } か null。
 */
export function renderBoard(el, game, ghost) {
  const cells = el.children;
  const startA = startIndex(1);
  const startB = startIndex(2);

  const lastSet = game.lastMove
    ? new Set(game.lastMove.cells.map(([r, c]) => r * N + c))
    : null;
  const ghostSet = ghost ? new Set(ghost.cells.map(([r, c]) => r * N + c)) : null;
  const ghostClass = ghost ? (ghost.valid ? (ghost.player === 1 ? 'ghost-a' : 'ghost-b') : 'ghost-bad') : '';

  for (let i = 0; i < N * N; i++) {
    const owner = game.board[i];
    let cls = 'cell';

    if (owner === 1) cls += ' p1';
    else if (owner === 2) cls += ' p2';
    else if (i === startA) cls += ' start start-a';
    else if (i === startB) cls += ' start start-b';

    if (lastSet && lastSet.has(i)) cls += ' last';
    if (ghostSet && ghostSet.has(i)) cls += ' ' + ghostClass;

    const cell = cells[i];
    if (cell.className !== cls) cell.className = cls;
  }
}

/**
 * 画面座標を盤面のマスに変換する。
 * 盤の外でも少しの範囲なら端のマスに丸めるので、ドラッグが縁で途切れない。
 */
export function cellFromPoint(el, x, y) {
  const rect = el.getBoundingClientRect();
  const slack = 48;
  if (
    x < rect.left - slack || x > rect.right + slack ||
    y < rect.top - slack || y > rect.bottom + slack
  ) return null;

  const inner = rect.width - BOARD_PADDING * 2;
  const clamp = (v) => Math.min(Math.max(v, 0), N - 1);
  const c = clamp(Math.floor((x - rect.left - BOARD_PADDING) / inner * N));
  const r = clamp(Math.floor((y - rect.top - BOARD_PADDING) / inner * N));
  return [r, c];
}

/** 持ちピースのサムネイル（小さなマスを並べただけの図）。 */
export function makeThumb(pieceId, orientationIndex, player) {
  const shape = ORIENTATIONS[pieceId][orientationIndex] || ORIENTATIONS[pieceId][0];
  const [h, w] = extent(shape);
  const filled = new Set(shape.map(([r, c]) => r * w + c));

  const grid = document.createElement('span');
  grid.className = 'tile-grid';
  grid.style.gridTemplateColumns = `repeat(${w}, auto)`;

  const fill = player === 1 ? 'fill-a' : 'fill-b';
  for (let i = 0; i < h * w; i++) {
    const dot = document.createElement('i');
    if (filled.has(i)) dot.className = fill;
    grid.appendChild(dot);
  }
  return grid;
}

/**
 * 持ちピースのカルーセルを組み立て直す。手札が変わったときだけ呼ぶ。
 * （選択が変わるたびに作り直すと、スクロール位置が飛んでしまう）
 * @returns {boolean} 実際に組み直したら true
 */
export function buildTray(el, { hand, player, onTap }) {
  const signature = `${player}|${hand.join(',')}`;
  if (el.dataset.signature === signature) return false;

  const frag = document.createDocumentFragment();
  for (const id of hand) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.dataset.piece = id;
    tile.setAttribute('role', 'option');
    tile.appendChild(makeThumb(id, 0, player));
    tile.addEventListener('click', () => onTap(id));
    frag.appendChild(tile);
  }

  el.replaceChildren(frag);
  el.dataset.signature = signature;
  return true;
}

/** 選択の枠と、置けないピースの表示だけを更新する（組み直しはしない）。 */
export function updateTray(el, { selectedId, orientationIndex, player, placeable }) {
  for (const tile of el.children) {
    const id = tile.dataset.piece;
    const selected = id === selectedId;

    tile.classList.toggle('is-selected', selected);
    tile.setAttribute('aria-selected', String(selected));
    tile.classList.toggle('is-dead', Boolean(placeable) && !placeable.has(id));

    // 選択中のピースだけ今の向きで見せる（回転・反転が手元でも分かる）
    const want = selected ? orientationIndex : 0;
    if (tile.dataset.orientation !== String(want)) {
      tile.dataset.orientation = String(want);
      tile.replaceChildren(makeThumb(id, want, player));
    }
  }
}

/**
 * 中央からの距離で大きさと濃さを連続的に変える。
 * スクロールのたびに呼ばれるので、レイアウトを起こす読み取りは最初の一度だけにしている。
 */
export function updateTrayFocus(el) {
  const center = el.scrollLeft + el.clientWidth / 2;
  const tiles = el.children;

  for (const tile of tiles) {
    const distance = Math.abs(tile.offsetLeft + tile.offsetWidth / 2 - center) / tile.offsetWidth;
    const t = Math.min(distance, 1.6) / 1.6;
    tile.style.transform = `scale(${(1 - 0.36 * t).toFixed(3)})`;
    tile.style.opacity = (1 - 0.6 * t).toFixed(3);
  }
}

/** いま中央にいるピースの ID。 */
export function centeredPiece(el) {
  const center = el.scrollLeft + el.clientWidth / 2;
  let best = null;
  let bestDistance = Infinity;
  for (const tile of el.children) {
    const distance = Math.abs(tile.offsetLeft + tile.offsetWidth / 2 - center);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = tile;
    }
  }
  return best ? best.dataset.piece : null;
}

/** 指定のピースを中央へ送る。 */
export function centerPiece(el, pieceId, smooth = true) {
  const tile = [...el.children].find((t) => t.dataset.piece === pieceId);
  if (!tile) return;
  el.scrollTo({
    left: tile.offsetLeft + tile.offsetWidth / 2 - el.clientWidth / 2,
    behavior: smooth ? 'smooth' : 'auto',
  });
}
