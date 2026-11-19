/* 时光账本 · Service Worker
 *
 * 策略：网络优先 + 断网回落缓存。
 * 之前用「缓存优先」是为了省流量，结果每次改版手机上要等很久才更新；
 * 这个应用总共 100KB 左右，网络优先几乎无感，换来「刷新就是最新」。
 *
 * 改代码后把 CACHE 版本号 +1。
 */
var CACHE = 'timelog-v7';

var ASSETS = [
  './',
  'index.html',
  'css/app.css',
  'js/db.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(ASSETS).catch(function () { /* 个别文件缺失不阻塞安装 */ });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (event) {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

function save(req, res) {
  if (!res || !res.ok) return;
  var copy = res.clone();
  caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 页面导航：绕过 HTTP 缓存直取网络，断网才回落
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req, { cache: 'no-store' })
        .then(function (res) { save(req, res); return res; })
        .catch(function () {
          return caches.match(req).then(function (hit) {
            return hit || caches.match('index.html') || caches.match('./');
          });
        })
    );
    return;
  }

  // 静态资源：同样网络优先，失败回落缓存
  event.respondWith(
    fetch(req, { cache: 'no-store' })
      .then(function (res) {
        save(req, res);
        return res;
      })
      .catch(function () {
        return caches.match(req).then(function (hit) {
          if (hit) return hit;
          return new Response('', { status: 504, statusText: 'offline' });
        });
      })
  );
});
