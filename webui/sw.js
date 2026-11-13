const CACHE = "campus-app-v5";
const ASSETS = ["/", "/index.html", "/app.js?v=__ASSET_VERSION__", "/chat-stream.js", "/styles.css?v=__ASSET_VERSION__", "/manifest.webmanifest", "/icons/icon.svg"];
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});
// 网络优先：本机应用升级后必须立刻生效，离线时才回落到缓存。
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // 绝不缓存接口与跨源请求：对话与令牌必须实时。
  if (request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/"))
    return;
  event.respondWith(
    // 导航请求绕开 HTTP 缓存，避免升级后仍拿到旧 HTML（旧 HTML 会引用旧资源版本）。
    fetch(request, request.mode === "navigate" ? { cache: "no-store" } : undefined)
      .then((response) => {
        if (response.ok && response.type === "basic")
          void caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
        return response;
      })
      .catch(() =>
        caches
          .match(request)
          .then((cached) =>
            cached ||
            (request.mode === "navigate"
              ? caches.match("/index.html").then((page) => page || Response.error())
              : Response.error()),
          ),
      ),
  );
});
