/**
 * BLOCKS — 画面まわりの道具
 *
 * 要素の取り出し、画面の出し分け、短い知らせ。どのモジュールからも使う小物だけ。
 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const screens = $$('.screen');

export function showScreen(id) {
  for (const screen of screens) screen.classList.toggle('is-active', screen.id === id);
}

export const onGameScreen = () => $('#screen-game').classList.contains('is-active');

const toastNode = $('#toast');
let toastTimer = null;

export function toast(message, ms = 2400) {
  toastNode.textContent = message;
  toastNode.classList.add('is-shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastNode.classList.remove('is-shown'), ms);
}
