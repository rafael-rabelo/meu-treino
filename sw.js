// Meu Treino — service worker
// 1) Guarda o app no celular para abrir mesmo sem internet.
// 2) Mostra o treino numa notificação (o Galaxy Watch espelha) e agenda o fim do
//    descanso aqui, para a vibração chegar mesmo com o celular bloqueado.
const CACHE = 'meu-treino-v3';
const SHELL = ['./', 'index.html', 'styles.css', 'parser.js', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/badge-96.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Rede primeiro para o próprio app (pega atualizações), cache quando estiver offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});

// ---------------- Notificações do treino ----------------
const TAG = 'mt-treino';
let gen = 0;          // invalida descansos anteriores
let resting = false;
let lastEx = null;    // último estado do exercício enviado pelo app

const fmt = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const hhmm = (t) => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function show(title, body, opts) {
  return self.registration.showNotification(title, Object.assign({
    body, tag: TAG, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png',
    renotify: false, silent: true, requireInteraction: true,
  }, opts || {}));
}

function showEx(n, alert) {
  if (!n) return Promise.resolve();
  const actions = n.actionTitle ? [{ action: 'set', title: n.actionTitle }] : [];
  return show(alert ? '⏰ Fim do descanso · ' + n.title : n.title, n.body, {
    actions, data: { kind: 'ex', n },
    silent: !alert, renotify: !!alert, vibrate: alert ? [500, 150, 500, 150, 500] : undefined,
  });
}

async function startRest(sec, label, after) {
  const my = ++gen;
  resting = true;
  if (after) lastEx = after;
  const end = Date.now() + sec * 1000;
  await show('Descanso · ' + fmt(sec), (label ? label + '\n' : '') + 'Termina às ' + hhmm(end), {
    actions: [{ action: 'skip', title: 'Pular descanso' }], data: { kind: 'rest' }, timestamp: end,
  });
  await sleep(end - Date.now());
  if (gen !== my) return;                 // descanso cancelado ou substituído
  resting = false;
  await showEx(lastEx || { title: 'Meu Treino', body: label || 'Próxima série', actionTitle: '' }, true);
}

async function toClients(msg) {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  list.forEach((c) => c.postMessage(msg));
  return list.length;
}

self.addEventListener('message', (e) => {
  const m = e.data || {};
  if (m.type === 'show') {
    lastEx = m.n;
    if (!resting) e.waitUntil(showEx(m.n, false));
  } else if (m.type === 'rest') {
    e.waitUntil(startRest(m.sec, m.label, m.after));
  } else if (m.type === 'cancelRest') {
    gen++; resting = false;
    e.waitUntil(showEx(lastEx, false));
  } else if (m.type === 'clear') {
    gen++; resting = false; lastEx = null;
    e.waitUntil(self.registration.getNotifications({ tag: TAG }).then((ns) => ns.forEach((n) => n.close())));
  } else if (m.type === 'test') {
    e.waitUntil(sleep(5000).then(() => show('Meu Treino · teste', 'Se você está lendo isto no relógio, está tudo certo! ⌚', {
      tag: 'mt-test', silent: false, renotify: true, requireInteraction: false, vibrate: [400, 150, 400],
    })));
  }
});

self.addEventListener('notificationclick', (e) => {
  const d = e.notification.data || {};
  if (e.action === 'set' && d.n) {
    const n = d.n, at = Date.now();
    e.waitUntil((async () => {
      await toClients({ type: 'watchSet', at });
      // Começa o descanso já aqui, caso o app esteja em segundo plano; o app depois corrige.
      if (n.restAfterSet > 0) await startRest(n.restAfterSet, n.restLabel, null);
      else await show('✓ Registrado', n.restLabel || 'Próximo exercício', { data: { kind: 'info' } });
    })());
  } else if (e.action === 'skip') {
    gen++; resting = false;
    e.waitUntil(toClients({ type: 'watchSkip' }).then(() => showEx(lastEx, false)));
  } else {
    e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      if (list.length) return list[0].focus();
      return self.clients.openWindow('./');
    }));
  }
});
