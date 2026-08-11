/**
 * BLOCKS — 駒の色
 *
 * 色は見た目だけの話なので、ゲームの進行には一切関わらせない。
 * スタイル側は --p1 〜 --p4 という変数だけを見ているので、
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

/** 何も選ばなかったときの席ごとの色。 */
const SEAT_DEFAULTS = Object.freeze(['grape', 'tangerine', 'azure', 'moss']);

export const DEFAULT_FIRST = SEAT_DEFAULTS[0];
const MAX_SEATS = 4;

export const isColor = (id) => Object.prototype.hasOwnProperty.call(PALETTE, id);
export const colorName = (id) => (isColor(id) ? PALETTE[id].name : '');

const defaultFor = (seat) => SEAT_DEFAULTS[(seat - 1) % SEAT_DEFAULTS.length];

/** 既に使われている色を避けて 1 つ選ぶ。 */
export function firstAvailable(taken = []) {
  const used = new Set(taken.filter(Boolean));
  return COLOR_IDS.find((id) => !used.has(id)) || DEFAULT_FIRST;
}

/** その色と組み合わせる、2 人戦での相手側の既定色。 */
export function partnerFor(id) {
  return firstAvailable([id]);
}

/** 人数分の色を、重ならないように埋める。 */
export function fillColors(chosen, players) {
  const colors = {};
  const taken = [];
  for (let seat = 1; seat <= players; seat++) {
    const wanted = chosen?.[seat];
    const id = isColor(wanted) && !taken.includes(wanted)
      ? wanted
      : (!taken.includes(defaultFor(seat)) ? defaultFor(seat) : firstAvailable(taken));
    colors[seat] = id;
    taken.push(id);
  }
  return colors;
}

/** 席ごとの色を画面全体に反映する。 */
export function applyColors(colors) {
  const style = document.body.style;
  for (let seat = 1; seat <= MAX_SEATS; seat++) {
    const id = isColor(colors?.[seat]) ? colors[seat] : defaultFor(seat);
    const c = PALETTE[id];
    style.setProperty(`--p${seat}`, c.base);
    style.setProperty(`--p${seat}-hi`, c.hi);
    style.setProperty(`--p${seat}-dp`, c.dp);
  }
}

/**
 * 色見本の並びを作る。taken に入っている色は他の人が使っているので選べない。
 */
export function buildSwatches(container, { selected, taken = [], onPick }) {
  const blocked = new Set(taken.filter(Boolean));
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

    if (blocked.has(id) && id !== selected) {
      swatch.disabled = true;
      swatch.title = '他の人が使っています';
    } else {
      swatch.addEventListener('click', () => onPick(id));
    }
    frag.appendChild(swatch);
  }

  container.replaceChildren(frag);
}
