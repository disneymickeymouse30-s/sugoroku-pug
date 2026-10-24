/* ============================================================
   sw.js ― オフライン用の保存設定（5つ目のファイル）

   ・ゲームの画面やプログラムを端末に保存して、電波がなくても1台プレイできるようにする
   ・オンライン対戦の通信（Firebase など外部サイト）には一切さわらない
   ・ゲーム本体や設定ファイルは「まずネットから最新を取得 → だめなら保存分」の順。
     そのため firebase-config.js を書き換えたときもすぐ反映される
   ・アイコンなど変わらない物は保存分を優先して速く表示する

   ※ ゲームを更新したら、下の CACHE の名前（日付など）を必ず変えてください。
   ============================================================ */
const CACHE = 'pugtabi-v20-20261024d';

// 最初に保存しておくファイル（1つでも失敗すると保存されないので、実在する物だけ）
const SHELL = [
  './',
  './index.html',
  './firebase-config.js',
  './online.js',
  './manifest.webmanifest',
  './icons/icon-32.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

// 保存しない物（サイトに置く必要もないが、置いてあっても保存しない）
const NO_CACHE = /\/(sw\.js|database\.rules\.json)$/;

// 最新を優先するファイル（ゲーム本体・プログラム・設定）
const FRESH = /(\/|\.html|\.js|\.json|\.webmanifest)$/;

const NET_TIMEOUT = 4000;   // 電波が悪いとき、4秒待っても返事がなければ保存分を使う

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k.startsWith('pugtabi-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }

function putCache(req, res) {
  if (!res || !res.ok || res.type !== 'basic') return;          // 失敗・外部の返事は保存しない
  const cp = res.clone();
  caches.open(CACHE).then(c => c.put(req, cp)).catch(() => {});
}

// ネット優先（だめなら保存分）
function networkFirst(req, fallbackKey) {
  const net = fetch(req).then(res => { putCache(req, res); return res; });
  return Promise.race([net, timeout(NET_TIMEOUT)]).catch(() =>
    caches.match(req, { ignoreSearch: true })
      .then(hit => hit || (fallbackKey ? caches.match(fallbackKey) : null))
      .then(hit => hit || net)
  );
}

// 保存分優先（なければネット）
function cacheFirst(req) {
  return caches.match(req).then(hit => hit || fetch(req).then(res => { putCache(req, res); return res; }));
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;               // 外部（Firebase・Googleなど）は素通り
  if (NO_CACHE.test(url.pathname)) return;
  if (req.mode === 'navigate') { e.respondWith(networkFirst(req, './index.html')); return; }
  if (FRESH.test(url.pathname)) { e.respondWith(networkFirst(req)); return; }
  e.respondWith(cacheFirst(req));
});
