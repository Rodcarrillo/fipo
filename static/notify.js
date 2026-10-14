/* Avisos dentro de FIPO: campana, centro de notificaciones y precios objetivo. */
ICONS.bell = "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0";

let notifTimer = null;
const NOTIF_EVERY = 60000;
const notifBellHtml = () => `<button class="icon-btn bell" id="bell" title="Avisos" aria-label="Avisos">${icon("bell")}<span class="badge-n" id="bell-n" hidden>0</span></button>`;

function setBell(n) {
  const b = $("#bell-n"); if (!b) return;
  b.textContent = n > 99 ? "99+" : n; b.hidden = !n;
  const bell = $("#bell"); if (bell) bell.setAttribute("aria-label", n ? `Avisos (${n} sin leer)` : "Avisos");
}

async function pollNotifications(first = false) {
  if (!S.user) return;
  let r;
  try { r = await api("GET", "/api/notifications"); } catch { return; }
  S.notif = r; setBell(r.unread);
  const last = store.get("notif.toasted." + S.user.id, 0);
  const fresh = r.items.filter((i) => !i.read_at && i.id > last).reverse();
  fresh.slice(-3).forEach((i) => toast(i.title + " · " + i.body, i.kind === "price_low" ? "error" : "ok"));
  if (fresh.length) {
    store.set("notif.toasted." + S.user.id, Math.max(...fresh.map((i) => i.id)));
    if (window.Notification && Notification.permission === "granted" && !PUSH.active) {   // con push activo ya llega por el teléfono
      fresh.slice(-3).forEach((i) => { try { new Notification(i.title, { body: i.body }); } catch { /* */ } });
    }
  }
  if ($("#notif-list")) drawNotifList();
}

function startNotifications() {
  const bell = $("#bell"); if (!bell) return;
  bell.onclick = openNotifications;
  if (S.notif) setBell(S.notif.unread);
  clearInterval(notifTimer);
  notifTimer = setInterval(() => { if (!document.hidden) pollNotifications(); }, NOTIF_EVERY);
  pollNotifications(true);
  pushSync();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.user) pollNotifications(); });

const NOTIF_KIND = { card_due: "Tarjeta", recurring: "Cargo recurrente", price_high: "Precio objetivo", price_low: "Precio límite", watch_report: "Reporte" };

function drawNotifList() {
  const box = $("#notif-list"); if (!box) return;
  const items = (S.notif && S.notif.items) || [];
  box.innerHTML = items.length ? items.map((i) => `<div class="notif ${i.read_at ? "" : "unread"}" data-id="${i.id}">
      <button class="notif-main" data-open="${i.id}"><span class="badge">${esc(NOTIF_KIND[i.kind] || "Aviso")}</span>
        <b>${esc(i.title)}</b><span class="muted small">${esc(i.body)}</span><span class="muted small">${esc(fmtStamp(i.created_at.replace(" ", "T") + "Z"))}</span></button>
      <button class="icon-btn" data-rm="${i.id}" aria-label="Quitar aviso">${icon("x")}</button></div>`).join("")
    : '<div class="empty"><p>No tienes avisos. Aquí verás los recordatorios de pago de tus tarjetas y cuando un activo llegue a tu precio objetivo.</p></div>';
  $$("[data-open]", box).forEach((b) => b.onclick = async () => {
    const it = items.find((x) => x.id === +b.dataset.open);
    try { if (!it.read_at) await api("POST", "/api/notifications/read", { ids: [it.id] }); } catch { /* */ }
    if (notifModal) notifModal.close();
    await pollNotifications(); if (it.link) go(it.link);
  });
  $$("[data-rm]", box).forEach((b) => b.onclick = async () => { try { await api("DELETE", "/api/notifications/" + b.dataset.rm); await pollNotifications(); } catch (e) { toast(e.message, "error"); } });
}

let notifModal = null;
/* ---------- avisos push: llegan al teléfono aunque FIPO esté cerrada ---------- */
const PUSH = { ok: "serviceWorker" in navigator && "PushManager" in window && "Notification" in window, info: null, active: false, synced: false };
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
const b64ToBytes = (b) => { const s = atob((b + "=".repeat((4 - (b.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
async function pushReg() { return navigator.serviceWorker.getRegistration("/").then((r) => r || navigator.serviceWorker.register("/sw.js", { scope: "/" })); }
async function pushSub() { if (!PUSH.ok) return null; try { const r = await pushReg(); return r ? await r.pushManager.getSubscription() : null; } catch { return null; } }
const deviceName = () => (isIOS() ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android" : "Computadora") + (isStandalone() ? " (app)" : "");
/* al abrir FIPO: si este dispositivo ya tenía avisos, se le recuerda al servidor (por si cambió la suscripción) */
async function pushSync() {
  if (PUSH.synced || window.FIPO_PREVIEW || !PUSH.ok || !S.user) return; PUSH.synced = true;
  try { const sub = await pushSub(); PUSH.active = !!sub && Notification.permission === "granted";
    if (PUSH.active) await api("POST", "/api/push/subscribe", { ...sub.toJSON(), device: deviceName() }); } catch { /* sin conexión: se reintenta al volver a abrir */ }
}
async function drawPushBox(box) {
  if (!box) return;
  const say = (html) => { box.innerHTML = html; };
  if (window.FIPO_PREVIEW) return say('<p class="muted small">En la app instalada (con servidor) puedes activar aquí los avisos en tu teléfono, que llegan aunque FIPO esté cerrada. En esta vista previa no hay servidor que los envíe.</p>');
  if (isIOS() && !isStandalone()) return say('<p class="small"><b>Para recibir avisos con FIPO cerrada:</b> agrega FIPO a tu pantalla de inicio (en Safari: Compartir → «Agregar a inicio») y ábrela desde ese ícono. Ahí aparecerá el botón para activarlos. Necesitas iOS 16.4 o más nuevo.</p>');
  if (!PUSH.ok) return say('<p class="muted small">Este navegador no permite avisos push. En iPhone funcionan con FIPO agregada a la pantalla de inicio (iOS 16.4 o más nuevo).</p>');
  if (Notification.permission === "denied") return say(`<p class="small">Los avisos de FIPO están bloqueados en este dispositivo. Para activarlos: <b>${isIOS() ? "Ajustes del iPhone → Notificaciones → FIPO → Permitir notificaciones" : "permite las notificaciones de este sitio en la configuración del navegador"}</b>, y vuelve aquí.</p>`);
  let info; try { info = PUSH.info = await api("GET", "/api/push"); } catch (e) { return say(`<p class="muted small">${esc(e.message)}</p>`); }
  const sub = await pushSub(); PUSH.active = !!sub && Notification.permission === "granted";
  const last = info.cron.last_run, fresh = last && (Date.now() - new Date(last.replace(" ", "T") + "Z").getTime()) < 3 * 3600e3;
  const cronHtml = fresh ? `<p class="muted small" style="margin:.5rem 0 0">Revisión automática funcionando · última: ${esc(fmtStamp(last.replace(" ", "T") + "Z"))}</p>`
    : `<details class="push-cron" ${PUSH.active ? "open" : ""}><summary class="small"><b>Falta un paso único</b> para que los avisos lleguen con FIPO cerrada</summary>
      <p class="small">El plan gratis de PythonAnywhere no puede despertar a FIPO solo. Un servicio gratuito lo hace por ti:</p>
      <ol class="small"><li>Entra a <b>cron-job.org</b> y crea una cuenta gratis.</li><li>«Create cronjob» → en <b>URL</b> pega esta dirección:</li></ol>
      <div class="signed"><input id="cron-url" readonly value="${esc(info.cron.url)}"><button type="button" class="btn sm" id="cron-copy">Copiar</button></div>
      <ol class="small" start="3"><li>En <b>Execution schedule</b> elige <b>Every 30 minutes</b> y guarda.</li></ol>
      <p class="muted small">Esa dirección solo revisa pagos, cargos recurrentes y precios; no muestra ningún dato. ${last ? "Última revisión: " + esc(fmtStamp(last.replace(" ", "T") + "Z")) + "." : "Todavía no se ha ejecutado."}</p></details>`;
  say(PUSH.active
    ? `<p class="small" style="margin:0 0 .6rem"><b>Avisos activados en este dispositivo.</b> Te llegan aunque FIPO esté cerrada.</p>
       <div style="display:flex;gap:.5rem;flex-wrap:wrap"><button type="button" class="btn sm" id="push-test">Enviar aviso de prueba</button><button type="button" class="btn sm ghost" id="push-off">Desactivar aquí</button></div>${cronHtml}`
    : `<p class="small" style="margin:0 0 .6rem">Recibe en este dispositivo los recordatorios de pago, cargos recurrentes y precios objetivo <b>aunque FIPO esté cerrada</b>.</p>
       <button type="button" class="btn primary sm" id="push-on">${icon("bell")} Activar avisos en este dispositivo</button>${cronHtml}`);
  const on = $("#push-on", box);
  if (on) on.onclick = async () => {
    on.disabled = true;
    try {
      const perm = await Notification.requestPermission();          // primero, directo del toque (lo exige el iPhone)
      if (perm !== "granted") { toast("No se activaron: el permiso de avisos no se concedió.", "error"); return drawPushBox(box); }
      const reg = await pushReg(); await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(info.public_key) });
      await api("POST", "/api/push/subscribe", { ...sub.toJSON(), device: deviceName() });
      PUSH.active = true; toast("Avisos activados en este dispositivo.");
    } catch (e) { toast(e.message || "No se pudieron activar los avisos.", "error"); }
    drawPushBox(box);
  };
  const t = $("#push-test", box);
  if (t) t.onclick = async () => { t.disabled = true; try { await api("POST", "/api/push/test"); toast("Aviso de prueba enviado. Debe llegarte en unos segundos."); } catch (e) { toast(e.message, "error"); } t.disabled = false; };
  const off = $("#push-off", box);
  if (off) off.onclick = async () => { try { const s = await pushSub(); if (s) { await api("POST", "/api/push/unsubscribe", { endpoint: s.endpoint }); await s.unsubscribe(); } PUSH.active = false; toast("Avisos desactivados en este dispositivo."); } catch (e) { toast(e.message, "error"); } drawPushBox(box); };
  const cp = $("#cron-copy", box);
  if (cp) cp.onclick = async () => { const i = $("#cron-url", box); try { await navigator.clipboard.writeText(i.value); toast("Dirección copiada."); } catch { i.select(); toast("Selecciónala y cópiala."); } };
}

function openNotifications() {
  notifModal = openModal("Avisos", `<div id="notif-modal">
    <section class="push-box" id="push-box"><div class="spinner" style="margin:.5rem auto"></div></section>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.8rem"><button class="btn sm" id="n-all">Marcar todo como leído</button><button class="btn sm" id="n-clear">Quitar los leídos</button></div>
    <div class="field" style="margin:.2rem 0 .8rem"><label style="display:flex;gap:.5rem;align-items:center"><input type="checkbox" id="n-mail" ${S.user.notify_email ? "checked" : ""} ${S.emailAvailable ? "" : "disabled"}> Recibir también por correo (${esc(S.user.email)})</label>
      <span class="muted small">${S.emailAvailable ? "Así el aviso te llega aunque FIPO esté cerrado: recordatorios de pago de tarjeta y precios objetivo." : "Este servidor no tiene correo configurado (FIPO_SMTP_HOST); usa los avisos en tu teléfono de arriba."}</span></div>
    <div id="notif-list"></div></div>`, {
    wide: true,
    onMount: (el) => {
      drawNotifList();
      drawPushBox($("#push-box", el));
      $("#n-all", el).onclick = async () => { try { await api("POST", "/api/notifications/read", { all: true }); await pollNotifications(); } catch (e) { toast(e.message, "error"); } };
      $("#n-clear", el).onclick = async () => { try { await api("DELETE", "/api/notifications"); await pollNotifications(); } catch (e) { toast(e.message, "error"); } };
      const mail = $("#n-mail", el); mail.onchange = async () => {
        try { const r = await api("PATCH", "/api/me", { notify_email: mail.checked }); S.user = r.user; toast(mail.checked ? "Recibirás los avisos también por correo." : "Avisos por correo desactivados."); }
        catch (e) { mail.checked = !mail.checked; toast(e.message, "error"); } };
    } });
  pollNotifications();
}

/* ---------- precios objetivo (Portafolio) ---------- */
function targetCard(sym, p, al) {
  const cur = p.currency, fmt = (v) => esc(money(Math.round(v * 100), cur));
  const state = !al ? "" : !al.active ? '<span class="badge">en pausa</span>' : al.upper_hit || al.lower_hit ? '<span class="badge warn">alcanzado</span>' : '<span class="badge">vigilando</span>';
  return `<section class="card" style="margin-bottom:1rem" id="targets"><h2>Precios objetivo ${state}</h2>
    ${al ? `<div class="grid stats" style="margin:.2rem 0 .8rem"><div><div class="k muted small">Límite inferior</div><b>${al.lower != null ? fmt(al.lower) : "—"}</b></div>
        <div><div class="k muted small">Objetivo superior</div><b>${al.upper != null ? fmt(al.upper) : "—"}</b></div></div>
      <p class="muted small">Te avisamos una vez al tocar un límite.</p>`
      : '<p class="muted small">Pon un precio mínimo y/o máximo y te avisamos.</p>'}
    <div style="display:flex;gap:.5rem;flex-wrap:wrap"><button class="btn sm primary" id="t-edit">${al ? "Editar" : "Poner objetivos"}</button>
      ${al ? `<button class="btn sm" id="t-toggle">${al.active ? "Pausar" : "Reactivar"}</button><button class="btn sm" id="t-del">Quitar</button>` : ""}</div></section>`;
}

function bindTargets(sym, p, al) {
  const reload = () => route();
  $("#t-edit").onclick = () => {
    const m = openModal("Precios objetivo · " + sym, `<form id="t-f" novalidate><p class="muted small">Precio actual: <b>${p.price != null ? esc(money(Math.round(p.price * 100), p.currency)) : "sin precio"}</b>. Deja vacío el límite que no quieras usar.</p>
      ${field("Límite inferior (" + p.currency + ")", "lower", 'inputmode="decimal"', al && al.lower != null ? al.lower : "")}
      ${field("Objetivo superior (" + p.currency + ")", "upper", 'inputmode="decimal"', al && al.upper != null ? al.upper : "")}
      <footer><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" type="submit">Guardar</button></footer></form>`, {
      onMount: (el) => { $("#t-f", el).onsubmit = (e) => { e.preventDefault(); submitForm(e.target, async () => {
        const d = formData(e.target); await api("PUT", "/api/price-alerts", { symbol: sym, lower: d.lower, upper: d.upper, active: al ? al.active : true });
        m.close(); toast("Objetivos guardados."); await pollNotifications(); reload(); }); }; } });
  };
  const tg = $("#t-toggle"); if (tg) tg.onclick = async () => { try { await api("PUT", "/api/price-alerts", { symbol: sym, lower: al.lower, upper: al.upper, active: !al.active }); reload(); } catch (e) { toast(e.message, "error"); } };
  const td = $("#t-del"); if (td) td.onclick = async () => { try { await api("DELETE", "/api/price-alerts/" + encodeURIComponent(sym)); toast("Objetivos quitados."); reload(); } catch (e) { toast(e.message, "error"); } };
}
