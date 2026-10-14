/* FIPO · service worker: solo recibe los avisos push y abre FIPO al tocarlos.
   No guarda páginas en caché (así nunca verás una versión vieja de FIPO). */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : "" }; }
  // el iPhone exige mostrar SIEMPRE un aviso por cada push
  e.waitUntil(self.registration.showNotification(d.title || "FIPO", {
    body: d.body || "", icon: "/static/icons/icon-192.png", badge: "/static/icons/icon-192.png",
    tag: d.tag || undefined, data: { url: d.url || "/" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        try { await w.navigate(url); } catch { /* algunas versiones no permiten navigate */ }
        return w.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
