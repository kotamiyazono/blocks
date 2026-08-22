/**
 * BLOCKS — Worker の受け口
 *
 * 静的ファイルは assets に任せ、部屋 API だけを Durable Object に渡す。
 */

import { Room } from './room.js';

export { Room };

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

const randomString = (length, alphabet) => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
};

const newCode = () => randomString(CODE_LENGTH, CODE_ALPHABET);

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const requireCode = (value) => {
  const code = String(value || '').toUpperCase();
  if (code.length !== CODE_LENGTH) throw new RequestError(400, '部屋コードが正しくありません');
  return code;
};

const json = (body, status) => Response.json(body, {
  status,
  headers: { 'Cache-Control': 'no-store, max-age=0' },
});

async function callRoom(env, code, action, body) {
  const result = await env.ROOM.getByName(code).call(action, { ...body, code });
  return json(result.body, result.status);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/room') return new Response('Not found', { status: 404 });

    let body = {};
    if (request.method === 'POST') {
      try {
        body = await request.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
      } catch {
        return json({ error: '不正なリクエストです' }, 400);
      }
    } else if (request.method !== 'GET') {
      return json({ error: '不正なリクエストです' }, 400);
    }

    const action = request.method === 'GET' ? 'poll' : String(url.searchParams.get('action') || '');
    try {
      if (action === 'create') {
        for (let attempt = 0; attempt < 6; attempt++) {
          const code = newCode();
          const result = await env.ROOM.getByName(code).call('create', { ...body, code });
          if (result.status !== 409) return json(result.body, result.status);
        }
        return json({ error: '部屋を作れませんでした。もう一度お試しください' }, 503);
      }

      const code = requireCode(request.method === 'GET'
        ? url.searchParams.get('code')
        : body.code);
      return await callRoom(env, code, action, request.method === 'GET'
        ? { since: url.searchParams.get('since') ?? undefined }
        : body);
    } catch (error) {
      if (error instanceof RequestError) {
        return json({ error: error.message }, error.status);
      }
      console.error('[room]', error);
      return json({ error: 'サーバ側で問題が起きました' }, 500);
    }
  },
};
