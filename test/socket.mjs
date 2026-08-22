export const wsBase = (base) => base.replace(/^http/, 'ws');

const queues = new WeakMap();
const closes = new WeakMap();

const queueFor = (ws) => {
  if (queues.has(ws)) return queues.get(ws);
  const queue = [];
  queues.set(ws, queue);
  ws.addEventListener('message', (event) => {
    try { queue.push(JSON.parse(event.data)); } catch { queue.push(event.data); }
  });
  ws.addEventListener('close', (event) => {
    closes.set(ws, { code: event.code, reason: event.reason });
  }, { once: true });
  return queue;
};

export function connect(base, code, token) {
  const url = new URL('/api/socket', wsBase(base));
  url.searchParams.set('code', code);
  url.searchParams.set('token', token);
  const ws = new WebSocket(url);
  queueFor(ws);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket 接続がタイムアウトしました')), 8000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket 接続に失敗しました')); }, { once: true });
  });
}

export const collect = (ws) => queueFor(ws);

export function waitFor(ws, predicate, ms = 8000) {
  const queue = queueFor(ws);
  const found = queue.findIndex(predicate);
  if (found >= 0) return Promise.resolve(queue.splice(found, 1)[0]);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error('WebSocket メッセージがタイムアウトしました'));
    }, ms);
    const onMessage = () => {
      const index = queue.findIndex(predicate);
      if (index < 0) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      resolve(queue.splice(index, 1)[0]);
    };
    ws.addEventListener('message', onMessage);
  });
}

export function waitClose(ws, ms = 8000) {
  queueFor(ws);
  if (closes.has(ws)) return Promise.resolve(closes.get(ws));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket close がタイムアウトしました')), ms);
    ws.addEventListener('close', (event) => {
      clearTimeout(timer);
      resolve({ code: event.code, reason: event.reason });
    }, { once: true });
  });
}
