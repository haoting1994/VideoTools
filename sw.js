// 讓剪輯軟體可以安裝成 App，並把處理引擎存在電腦裡，下次開啟更快、離線也能剪片
const VERSION = 'v2';
const SHELL = `shell-${VERSION}`;
const VENDOR = `vendor-${VERSION}`;

const SHELL_FILES = [
  './', './index.html', './style.css', './whisper-worker.js', './manifest.webmanifest',
  './js/app.js', './js/state.js', './js/media.js', './js/preview.js', './js/compose.js', './js/timeline.js', './js/subtitles.js', './js/export.js',
  './icons/icon-192.png', './icons/icon-512.png',
];
const VENDOR_FILES = [
  './vendor/ffmpeg/index.js', './vendor/ffmpeg/classes.js', './vendor/ffmpeg/const.js', './vendor/ffmpeg/errors.js',
  './vendor/ffmpeg/types.js', './vendor/ffmpeg/utils.js', './vendor/ffmpeg/worker.js',
  './vendor/util/index.js', './vendor/util/const.js', './vendor/util/errors.js', './vendor/util/types.js',
  './vendor/opencc/cn2t.js', './vendor/mediabunny.min.mjs',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    await (await caches.open(SHELL)).addAll(SHELL_FILES);
    await (await caches.open(VENDOR)).addAll(VENDOR_FILES);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== VENDOR) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // 只處理自己網站的檔案；Hugging Face 模型與 CDN 由辨識程式自己快取
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  if (url.pathname.includes('/vendor/')) {
    // 處理引擎：很大、不常變，優先用電腦裡的
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VENDOR).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  // 頁面與程式：優先抓最新版，沒有網路時才用存起來的
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true })));
});
