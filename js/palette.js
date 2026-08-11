/**
 * BLOCKS — 駒の色
 *
 * 色は見た目だけの話なので、ゲームの進行には一切関わらせない。
 * スタイル側は全部 --a / --b という変数だけを見ているので、
 * ここで変数を差し替えれば盤も持ちピースも結果画面も一度に変わる。
 *
 * サーバ側も色の妥当性を確かめるためにこのファイルを読む。
 * そのため、読み込んだだけで DOM に触るようなことはしていない。
 */

const PALETTE = {
  grape:     { name: 'むらさき',   base: '124 58 237',  hi: '167 139 250', dp: '91 33 182' },
  tangerine: { name: 'オレンジ',   base: '234 88 12',   hi: '251 146 60',  dp: '154 52 18' },
  azure:     { name: 'ブルー',     base: '37 99 235',   hi: '96 165 250',  dp: '30 64 175' },
  moss:      { name: 'グリーン',   base: '22 163 74',   hi: '74 222 128',  dp: '21 105 47' },
  blossom:   { name: 'ピンク',     base: '219 39 119',  hi: '244 114 182', dp: '157 23 77' },
  lagoon:    { name: 'ターコイズ', base: '13 148 136',  hi: '45 212 191',  dp: '15 94 88' },
};

const COLOR_IDS = Object.freeze(Object.keys(PALETTE));

export const DEFAULT_FIRST = 'grape';
const DEFAULT_SECOND = 'tangerine';

export const isColor = (id) => Object.prototype.hasOwnProperty.call(PALETTE, id);

const safe = (id, fallback) => (isColor(id) ? id : fallback);

/** その色と組み合わせる相手側の既定色。 */
export function partnerFor(id) {
  return id === DEFAULT_SECOND ? DEFAULT_FIRST : DEFAULT_SECOND;
}

/** 使えない色を避けて 1 つ選ぶ。 */
export function firstAvailable(taken) {
  return COLOR_IDS.find((id) => id !== taken) || DEFAULT_FIRST;
}

/** 先手・後手の色を画面全体に反映する。 */
export function applyColors(firstId, secondId) {
  const a = PALETTE[safe(firstId, DEFAULT_FIRST)];
  const b = PALETTE[safe(secondId, DEFAULT_SECOND)];
  const style = document.body.style;

  style.setProperty('--a', a.base);
  style.setProperty('--a-hi', a.hi);
  style.setProperty('--a-dp', a.dp);
  style.setProperty('--b', b.base);
  style.setProperty('--b-hi', b.hi);
  style.setProperty('--b-dp', b.dp);
}

/**
 * 色見本の並びを作る。taken に渡した色は相手が使っているので選べない。
 */
export function buildSwatches(container, { selected, taken, onPick }) {
  const frag = document.createDocumentFragment();

  for (const id of COLOR_IDS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'swatch' + (id === selected ? ' is-on' : '');
    swatch.dataset.color = id;
    swatch.style.setProperty('--sw', PALETTE[id].base);
    swatch.style.setProperty('--sw-hi', PALETTE[id].hi);
    swatch.style.setProperty('--sw-dp', PALETTE[id].dp);
    swatch.setAttribute('aria-label', PALETTE[id].name);
    swatch.setAttribute('aria-pressed', String(id === selected));

    if (taken && id === taken) {
      swatch.disabled = true;
      swatch.title = '相手が使っています';
    } else {
      swatch.addEventListener('click', () => onPick(id));
    }
    frag.appendChild(swatch);
  }

  container.replaceChildren(frag);
}
