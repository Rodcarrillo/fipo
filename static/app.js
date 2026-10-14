/* FIPO - vistas y navegación (SPA con rutas por hash). */
"use strict";

const TYPE_LABEL = { buy: "Acciones", expense: "Gasto", income: "Ingreso", transfer: "Transferencia", refund: "Reembolso", adjustment: "Ajuste", investment: "Inversión", debt_payment: "Pago de deuda" };
const ACC_TYPES = { bank: "Cuenta bancaria", cash: "Efectivo", savings: "Cuenta de ahorro", digital: "Cuenta digital", credit: "Tarjeta de crédito", investment: "Cuenta de inversión", other: "Otra" };
const PERIODS = [["today", "Hoy"], ["week", "Esta semana"], ["month", "Este mes"], ["3months", "Últimos 3 meses"], ["year", "Este año"], ["custom", "Personalizado"]];
const MOV_DEFAULT = { q: "", from: "", to: "", account_id: "", category_id: "", type: "", sort: "date", dir: "desc", page: 1, per_page: 25 };
const NAV_GROUPS = [
  { key: "diario", label: "Dinero diario", icon: "wallet", items: [["movements", "Movimientos", "list"], ["accounts", "Cuentas", "wallet"], ["cards", "Tarjetas", "card"], ["recurring", "Pagos recurrentes", "repeat"], ["receipts", "Comprobantes", "camera"]] },
  { key: "plan", label: "Planeación", icon: "target", items: [["budgets", "Presupuestos", "target"], ["debts", "Deudas", "debt"], ["goals", "Metas", "flag"]] },
  { key: "inversion", label: "Inversión y análisis", icon: "trend", items: [["portfolio", "Portafolio", "trend"], ["analysis", "Análisis", "chart"], ["reports", "Reportes", "file"]] },
  { key: "mas", label: "Más", icon: "grid", items: [["tables", "Tablas", "table"], ["settings", "Configuración", "sliders"]] },
];

const S = {
  user: null, accounts: [], categories: [], currencies: [], timezones: [],
  dash: { period: "month", from: "", to: "" },
  mov: { ...MOV_DEFAULT },
  collapsed: store.get("collapsed", false),
};
const cur = () => (S.user ? S.user.currency : "MXN");
const go = (h) => { if (location.hash === h) route(); else location.hash = h; };
const todayStr = () => { try { return new Intl.DateTimeFormat("en-CA", { timeZone: S.user.timezone }).format(new Date()); } catch { return ymd(new Date()); } };
const accById = (id) => S.accounts.find((a) => a.id === id);
const MOBILE = window.matchMedia("(max-width: 900px)");
MOBILE.addEventListener("change", () => { if (S.user && S.user.onboarded && !$(".overlay")) route(); });  // al girar el teléfono/tablet
// pointerdown (no click): en iPhone tocar una zona "no clicable" no dispara click, y el menú se quedaba abierto
document.addEventListener("pointerdown", (e) => { const d = $("#avatar-drop"); if (d && !d.hidden && !e.target.closest(".avatar-menu")) { d.hidden = true; $("#avatar-btn").setAttribute("aria-expanded", "false"); } });

function applyTheme() {
  // sin sesión (arranque o inicio de sesión) se usa el último tema guardado en este dispositivo
  const t = S.user ? S.user.theme : store.get("theme", ""); if (S.user) store.set("theme", t || "");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  // el navegador (Safari/Chrome) tiñe su propia barra con este color: igual al de la barra de FIPO, para que no se note el corte
  const m = document.getElementById("meta-theme"); if (m) m.setAttribute("content", getComputedStyle(document.documentElement).getPropertyValue("--bar-solid").trim() || "#F7F7F2");
  if (window.fipoSetIcon) window.fipoSetIcon();
}
// línea finita bajo la barra solo cuando hay contenido pasando por debajo (como las apps nativas de iPhone)
window.addEventListener("scroll", () => { const tb = document.querySelector(".topbar"); if (tb) tb.classList.toggle("scrolled", window.scrollY > 4); }, { passive: true });
async function refreshCore() {
  const [a, c] = await Promise.all([api("GET", "/api/accounts"), api("GET", "/api/categories")]);
  S.accounts = a.accounts; S.categories = c.categories;
}
function fieldErrors(form, err) {
  $$(".field.err", form).forEach((f) => { f.classList.remove("err"); const m = $(".msg", f); if (m) m.remove(); });
  const box = $(".form-error", form); if (box) box.remove();
  const target = err.field && $(`[name="${err.field}"]`, form);
  if (target) {
    const f = target.closest(".field"); f.classList.add("err");
    f.insertAdjacentHTML("beforeend", `<span class="msg">${esc(err.message)}</span>`); target.focus();
  } else form.insertAdjacentHTML("afterbegin", `<div class="form-error" role="alert">${esc(err.message)}</div>`);
}
const formData = (form) => Object.fromEntries(new FormData(form).entries());
async function submitForm(form, fn) {
  const btn = $("button[type=submit]", form);
  if (btn.disabled) return;
  btn.disabled = true;
  try { await fn(); } catch (e) { if (e instanceof ApiError) fieldErrors(form, e); else { console.error(e); toast("Error inesperado", "error"); } } finally { btn.disabled = false; }
}
const field = (label, name, attrs = "", value = "", extra = "") =>
  `<div class="field"><label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" value="${esc(value)}" ${attrs}>${extra}</div>`;
// Importe que puede ser negativo: el teclado numérico del iPhone no trae signo «−», así que va un botón ± al lado.
const signedField = (label, name, attrs = "", value = "", extra = "") =>
  `<div class="field"><label for="f-${name}">${label}</label><div class="signed"><button type="button" class="sign-btn ${String(value).trim().startsWith("-") ? "neg" : ""}" data-sign="f-${name}" aria-label="Cambiar a positivo o negativo">±</button><input id="f-${name}" name="${name}" value="${esc(value)}" ${attrs}></div>${extra}</div>`;
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-sign]"); if (!b) return;
  const i = document.getElementById(b.dataset.sign); if (!i) return;
  const v = i.value.trim();
  i.value = /^[-−]/.test(v) ? v.replace(/^[-−]\s*/, "") : "-" + v;
  b.classList.toggle("neg", i.value.startsWith("-"));
  i.dispatchEvent(new Event("input", { bubbles: true }));
});
const PLAN_KINDS = { msi: "Meses sin intereses", mci: "Meses con intereses", diferido: "Saldo diferido" };
const inputCents = (v) => { const n = parseFloat(String(v ?? "").replace(/[,$\s]/g, "")); return isFinite(n) ? Math.round(n * 100) : 0; };

/* =================================================================== AUTH */
function authShell(title, sub, body, links) {
  $("#app").innerHTML = `<main class="auth"><div class="auth-card">
    <div class="brand">${logoWord()}</div><p class="tagline">Finanzas Personales Ordenadas</p>
    <h1>${title}</h1><p class="sub">${sub}</p>${body}<div class="auth-links">${links}</div></div></main>`;
}
function loginView() {
  authShell("Inicia sesión", "Tu dinero, en un solo lugar.", `<form id="f" novalidate>
      ${field("Correo electrónico", "email", 'type="email" autocomplete="email" required')}
      ${field("Contraseña", "password", 'type="password" autocomplete="current-password" required')}
      <button class="btn primary" type="submit">Entrar</button></form>`,
    `<a href="#/forgot">¿Olvidaste tu contraseña?</a><a href="#/register">Crear cuenta</a>`);
  $("#f").addEventListener("submit", (e) => { e.preventDefault(); submitForm(e.target, async () => {
    const r = await api("POST", "/api/auth/login", formData(e.target)); await afterAuth(r.user); }); });
}
function registerView() {
  authShell("Crea tu cuenta", "Cada usuario tiene su propio espacio financiero privado.", `<form id="f" novalidate>
      ${field("Nombre", "name", 'autocomplete="name" required maxlength="80"')}
      ${field("Correo electrónico", "email", 'type="email" autocomplete="email" required')}
      ${field("Contraseña", "password", 'type="password" autocomplete="new-password" minlength="8" required', "", '<span class="muted small">Mínimo 8 caracteres.</span>')}
      <button class="btn primary" type="submit">Crear cuenta</button></form>`,
    `<span class="muted">¿Ya tienes cuenta?</span><a href="#/login">Iniciar sesión</a>`);
  $("#f").addEventListener("submit", (e) => { e.preventDefault(); submitForm(e.target, async () => {
    const r = await api("POST", "/api/auth/register", formData(e.target)); await afterAuth(r.user); }); });
}
function forgotView() {
  authShell("Recupera tu contraseña", "Te enviaremos un enlace para crear una nueva.", `<form id="f" novalidate>
      ${field("Correo electrónico", "email", 'type="email" autocomplete="email" required')}
      <button class="btn primary" type="submit">Enviar enlace</button></form>`, `<a href="#/login">Volver a iniciar sesión</a><span></span>`);
  $("#f").addEventListener("submit", (e) => { e.preventDefault(); submitForm(e.target, async () => {
    const r = await api("POST", "/api/auth/forgot", formData(e.target));
    $("#f").innerHTML = `<div class="note">${r && r.preview ? "En esta vista previa no se envían correos. En la app real recibirás un enlace válido por 1 hora." : "Si el correo está registrado, recibirás un enlace válido por 1 hora. Revisa también tu carpeta de spam."}</div>`; }); });
}
function resetView(token) {
  authShell("Nueva contraseña", "Elige una contraseña segura.", `<form id="f" novalidate>
      ${field("Nueva contraseña", "password", 'type="password" autocomplete="new-password" minlength="8" required')}
      <button class="btn primary" type="submit">Guardar contraseña</button></form>`, `<a href="#/login">Volver a iniciar sesión</a><span></span>`);
  $("#f").addEventListener("submit", (e) => { e.preventDefault(); submitForm(e.target, async () => {
    await api("POST", "/api/auth/reset", { token, password: formData(e.target).password });
    toast("Contraseña actualizada. Ya puedes iniciar sesión."); go("#/login"); }); });
}
async function afterAuth(user) {
  S.user = user; applyTheme();
  const me = await api("GET", "/api/me"); S.currencies = me.currencies; S.timezones = me.timezones; S.emailAvailable = !!me.email_available;
  await refreshCore();
  go(user.onboarded ? "#/dashboard" : "#/onboarding");
}

/* ------------------------------------------------------- onboarding */
function onboardingView() {
  const rows = [{ name: "", type: "bank", opening_balance: "" }];
  const draw = () => {
    $("#app").innerHTML = `<main class="auth"><div class="auth-card" style="width:min(100%,520px)">
      <div class="brand">${logoWord()}</div>
      <p class="tagline">Finanzas Personales Ordenadas</p>
      <h1>Hola, ${esc(S.user.name.split(" ")[0])}. Configuremos tu espacio</h1><p class="sub">Solo lo esencial. Todo se puede cambiar después.</p>
      <form id="f" novalidate>
        <div class="field"><label for="f-currency">Moneda principal</label><select id="f-currency" name="currency">
          ${S.currencies.map((c) => `<option ${c === S.user.currency ? "selected" : ""}>${c}</option>`).join("")}</select></div>
        <div class="lbl" style="margin-bottom:.5rem">Tus cuentas iniciales (opcional)</div>
        ${rows.map((r, i) => `<div class="row2" style="grid-template-columns:1.4fr 1fr 1fr auto;align-items:start" data-i="${i}">
          <div class="field"><input placeholder="Nombre (p. ej. Nómina)" data-k="name" value="${esc(r.name)}" aria-label="Nombre de la cuenta"></div>
          <div class="field"><select data-k="type" aria-label="Tipo">${Object.entries(ACC_TYPES).map(([k, v]) => `<option value="${k}" ${r.type === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
          <div class="field"><input placeholder="Saldo actual" inputmode="decimal" data-k="opening_balance" value="${esc(r.opening_balance)}" aria-label="Saldo de apertura"></div>
          <button type="button" class="icon-btn" data-rm="${i}" aria-label="Quitar cuenta">${icon("x")}</button></div>`).join("")}
        <button type="button" class="btn sm" id="add-row" style="margin-bottom:1rem">${icon("plus")} Agregar otra cuenta</button>
        <p class="muted small">Ya creamos categorías comunes de gastos e ingresos. Podrás editarlas en Configuración.</p>
        <button class="btn primary" type="submit">Comenzar</button></form></div></main>`;
    const sync = () => $$("[data-i]").forEach((row) => { const i = +row.dataset.i; $$("[data-k]", row).forEach((el) => { rows[i][el.dataset.k] = el.value; }); });
    $("#add-row").onclick = () => { sync(); rows.push({ name: "", type: "bank", opening_balance: "" }); draw(); };
    $$("[data-rm]").forEach((b) => b.onclick = () => { sync(); rows.splice(+b.dataset.rm, 1); draw(); });
    $("#f").addEventListener("submit", (e) => { e.preventDefault(); sync(); submitForm(e.target, async () => {
      const accounts = rows.filter((r) => r.name.trim()).map((r) => ({ ...r, opening_balance: r.opening_balance || "0" }));
      const r = await api("POST", "/api/onboarding", { currency: $("#f-currency").value, accounts });
      S.user = r.user; await refreshCore(); toast("¡Listo! Tu espacio está configurado."); go("#/dashboard"); }); });
  };
  draw();
}

/* =================================================================== SHELL */
function mountShell(active, title, actions = "") {
  const openGroup = NAV_GROUPS.find((g) => g.items.some(([k]) => k === active));
  const link = (k, l, ic) => `<a href="#/${k}" class="${active === k ? "active" : ""}" ${active === k ? 'aria-current="page"' : ""}>${icon(ic)}<span class="label">${l}</span></a>`;
  const navHtml = link("dashboard", "Inicio", "home") + link("widgets", "Widgets", "widgets") + NAV_GROUPS.map((g) => {
    if (S.collapsed) return `<a href="#/${g.items[0][0]}" class="${g === openGroup ? "active" : ""}" title="${esc(g.label)}">${icon(g.icon)}<span class="label">${esc(g.label)}</span></a>`;
    const isOpen = g === openGroup;
    return `<div class="nav-group ${isOpen ? "open" : ""}"><button type="button" class="nav-group-btn" aria-expanded="${isOpen}">${icon(g.icon)}<span class="label">${esc(g.label)}</span><span class="chev">${icon("chevron")}</span></button>
      <div class="nav-sub" ${isOpen ? "" : "hidden"}>${g.items.map(([k, l, ic]) => link(k, l, ic)).join("")}</div></div>`;
  }).join("");
  $("#app").innerHTML = `<div class="shell ${S.collapsed ? "collapsed" : ""}" id="shell">
    <aside class="side"><a href="#/dashboard" class="brand" aria-label="Ir a Inicio">${logoWord()}${logoMark()}</a>
      <nav class="nav" aria-label="Principal">${navHtml}</nav>
      <div class="spacer"></div>
      <div class="userbox">${esc(S.user.name)}<br>${esc(S.user.email)}</div>
      <nav class="nav"><a href="#" id="collapse">${icon("chevron", S.collapsed ? "" : "")}<span class="label">Contraer menú</span></a><a href="#" id="logout">${icon("logout")}<span class="label">Cerrar sesión</span></a></nav></aside>
    <main class="main"><div class="topbar">${navCount > navBase ? `<button class="icon-btn" id="app-back" title="Regresar a la pantalla anterior" aria-label="Regresar a la pantalla anterior">${icon("back")}</button>` : ""}<h1>${title}</h1>
      ${notifBellHtml()}<button class="icon-btn d-only" id="privacy" title="Ocultar o mostrar montos" aria-label="Ocultar o mostrar montos" aria-pressed="${isPrivate()}">${icon(isPrivate() ? "eyeoff" : "eye")}</button>
      <button class="icon-btn d-only" id="theme" title="Cambiar tema" aria-label="Cambiar tema">${icon(isDark() ? "sun" : "moon")}</button>
      ${actions ? `<div class="top-actions">${actions}</div>` : ""}<button class="btn primary fab-desktop" id="new-tx">${icon("plus")} Nuevo movimiento</button>
      <div class="avatar-menu"><button class="avatar-chip" id="avatar-btn" aria-haspopup="true" aria-expanded="false" aria-label="Cuenta de ${esc(S.user.name)}">${esc(initials(S.user.name))}</button>
        <div class="avatar-drop" id="avatar-drop" hidden>
          <div class="avatar-drop-name">${esc(S.user.name)}</div>
          <button type="button" class="m-only" id="m-privacy">${icon(isPrivate() ? "eye" : "eyeoff")} ${isPrivate() ? "Mostrar montos" : "Ocultar montos"}</button>
          <button type="button" class="m-only" id="m-theme">${icon(isDark() ? "sun" : "moon")} ${isDark() ? "Modo claro" : "Modo oscuro"}</button>
          <a href="#/settings">${icon("sliders")} Editar perfil</a>
          <a href="#" id="avatar-logout">${icon("logout")} Cerrar sesión</a>
        </div></div></div>
      <div id="view"><div class="spinner" aria-label="Cargando"></div></div></main>
    <nav class="bottom" aria-label="Navegación móvil">
      <a href="#/dashboard" class="${active === "dashboard" ? "active" : ""}">${icon("home")}Inicio</a>
      <a href="#/movements" class="${active === "movements" ? "active" : ""}">${icon("list")}Movimientos</a>
      <button class="nav-btn" id="new-tx-m" aria-label="Nuevo movimiento"><span class="plus">${icon("plus")}</span></button>
      <a href="#/accounts" class="${active === "accounts" ? "active" : ""}">${icon("wallet")}Cuentas</a>
      <a href="#/more" class="${active === "more" || !["dashboard", "movements", "accounts"].includes(active) ? "active" : ""}">${icon("grid")}Más</a></nav></div>`;
  $("#logout").onclick = async (e) => { e.preventDefault(); try { await api("POST", "/api/auth/logout"); } catch { /* */ } S.user = null; S.accounts = []; S.categories = []; S.mov = { ...MOV_DEFAULT }; applyTheme(); go("#/login"); };
  const backBtn = $("#app-back"); if (backBtn) backBtn.onclick = () => history.back();
  // En celular la barra de arriba queda fija: los botones propios de la página van justo debajo, fuera de la barra,
  // para que la barra fija no crezca y tape la pantalla.
  if (MOBILE.matches) { const ta = $(".top-actions"); if (ta) $(".topbar").after(ta); }
  $("#collapse").onclick = (e) => { e.preventDefault(); S.collapsed = !S.collapsed; store.set("collapsed", S.collapsed); route(); };
  $$(".nav-group-btn").forEach((b) => b.onclick = () => {
    const grp = b.closest(".nav-group"), willOpen = !grp.classList.contains("open");
    $$(".nav-group").forEach((g) => { g.classList.remove("open"); $(".nav-sub", g).hidden = true; $(".nav-group-btn", g).setAttribute("aria-expanded", "false"); });
    if (willOpen) { grp.classList.add("open"); $(".nav-sub", grp).hidden = false; b.setAttribute("aria-expanded", "true"); }
  });
  const togglePrivacy = () => { setPrivacy(!isPrivate()); route(); };
  const toggleTheme = async () => { try { const r = await api("PATCH", "/api/me", { theme: isDark() ? "light" : "dark" }); S.user = r.user; applyTheme(); route(); } catch (e) { toast(e.message, "error"); } };
  $("#privacy").onclick = togglePrivacy; $("#m-privacy").onclick = togglePrivacy;
  $("#theme").onclick = toggleTheme; $("#m-theme").onclick = toggleTheme;
  const avBtn = $("#avatar-btn"), avDrop = $("#avatar-drop");
  avBtn.onclick = (e) => { e.stopPropagation(); const willOpen = avDrop.hidden; avDrop.hidden = !willOpen; avBtn.setAttribute("aria-expanded", String(willOpen)); };
  $("#avatar-logout").onclick = (e) => { e.preventDefault(); $("#logout").click(); };
  startNotifications();
  const nt = () => txModal(); $("#new-tx").onclick = nt; $("#new-tx-m").onclick = nt;
  return $("#view");
}
const errorBox = (e, retry) => `<div class="empty"><p>${esc(e.message || "No se pudo cargar.")}</p><button class="btn" id="retry">Reintentar</button></div>`;
function withRetry(view, fn) { fn().catch((e) => { if (e.status === 401) return; view.innerHTML = errorBox(e); const b = $("#retry", view); if (b) b.onclick = () => { view.innerHTML = '<div class="spinner"></div>'; withRetry(view, fn); }; }); }

/* =================================================================== DASHBOARD */
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Buenos días" : h < 19 ? "Buenas tardes" : "Buenas noches";
}
/* anillo del puntaje de salud financiera: muestra el valor real recibido (o "—" si no hay datos) */
function scoreRing(health) {
  const R = 50, C = 2 * Math.PI * R, v = health ? Math.max(0, Math.min(100, health.score_100)) : 0, len = (v / 100) * C;
  return `<svg viewBox="0 0 120 120" role="img" aria-label="${health ? health.score_10.toFixed(1) + " de 10" : "Sin datos"}">
    <circle cx="60" cy="60" r="${R}" fill="none" stroke="rgba(255,255,255,.16)" stroke-width="10"/>
    ${health ? `<circle class="arc" cx="60" cy="60" r="${R}" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round" stroke-dasharray="${len} ${C - len}" transform="rotate(-90 60 60)"/>` : ""}
    <text x="60" y="63" text-anchor="middle" class="sh-num">${health ? health.score_10.toFixed(1) : "—"}</text>
    <text x="60" y="82" text-anchor="middle" class="sh-den">de 10</text></svg>`;
}
/* frases cortas sobre dinero e inversión (autor verificado); cambia cada día y al tocarla */
const QUOTES = [
  ["Cuídate de los pequeños gastos; una pequeña fuga hundirá un gran barco.", "Benjamin Franklin"],
  ["El precio es lo que pagas; el valor es lo que obtienes.", "Warren Buffett"],
  ["Regla número 1: nunca pierdas dinero. Regla número 2: nunca olvides la regla número 1.", "Warren Buffett"],
  ["A largo plazo, todos estaremos muertos.", "John Maynard Keynes"],
  ["No existe tal cosa como un almuerzo gratis.", "Milton Friedman"],
  ["En el corto plazo, el mercado es una máquina de votar; en el largo plazo, es una balanza.", "Benjamin Graham"],
  ["El mayor problema del inversionista, e incluso su peor enemigo, probablemente sea él mismo.", "Benjamin Graham"],
  ["Conoce lo que posees y sabe por qué lo posees.", "Peter Lynch"],
  ["La inflación es siempre y en todas partes un fenómeno monetario.", "Milton Friedman"],
  ["Sé temeroso cuando otros son codiciosos, y codicioso cuando otros son temerosos.", "Warren Buffett"],
  ["Nuestro periodo favorito para conservar una inversión es para siempre.", "Warren Buffett"],
  ["El consumo es el único fin y propósito de toda producción.", "Adam Smith"],
];
let quoteIdx = null;
function dailyQuote() {
  if (quoteIdx == null) { const n = new Date(), d0 = new Date(n.getFullYear(), 0, 0); quoteIdx = Math.floor((n - d0) / 864e5) % QUOTES.length; }
  return QUOTES[quoteIdx];
}
const quoteHtml = ([t, a]) => `<blockquote>“${esc(t)}”</blockquote><figcaption>— ${esc(a)}</figcaption>`;
const monthName = (key) => (key ? new Intl.DateTimeFormat("es-MX", { month: "long" }).format(new Date(+key.slice(0, 4), +key.slice(5, 7) - 1, 1)) : "");

/* insight corto arriba a la derecha de una tarjeta: siempre calculado con tus datos, nunca texto fijo */
function insight(text, tone = "") {
  if (!text) return "";
  return `<span class="ins ${tone}" title="${esc(text)}">${icon(tone === "bad" ? "alert" : tone === "ok" ? "check" : "idea")}<span>${esc(text)}</span></span>`;
}
const pctTxt = (x) => (Math.round(x * 10) / 10).toString() + "%";
function heroInsight(h, C) {
  if (!h || !h.income) return "";
  const exp = h.amounts.living, r = exp / h.income;
  if (exp > h.income) return insight(`Gastaste ${money(exp - h.income, C)} más de lo que entró`, "bad");
  if (r <= 0.5) return insight(`Gasto sano: ${pctTxt(r * 100)} del ingreso`, "ok");
  return insight(`Gastas ${pctTxt(r * 100)} del ingreso · meta 50%`, "warn");
}

function dashboardView() {
  const view = mountShell("dashboard", "Inicio");
  const h1 = $(".topbar h1");
  h1.classList.add("greet");
  h1.innerHTML = `${icon(new Date().getHours() < 19 ? "sun" : "moon", "greet-ico")}<span class="greet-txt">${esc(greeting())}, ${esc(S.user.name.split(" ")[0])}</span>`;
  withRetry(view, async () => {
    let [d, health] = await Promise.all([
      api("GET", "/api/dashboard?" + qs(S.dash)),
      api("GET", "/api/health-score").catch(() => null),
    ]);
    const c = d.cards, C = d.currency;
    if (health && health.score_100 == null) health = null;          // sin ingresos en ningún mes: "Sin datos"
    if (!S.accounts.filter((a) => !a.archived).length) {
      view.innerHTML = `<div class="card empty"><h2 style="justify-content:center">Aún no tienes cuentas</h2><p>Crea tu primera cuenta para empezar a registrar movimientos.</p>
        <button class="btn primary" id="e-acc">${icon("plus")} Crear cuenta</button>
        <p class="small" style="margin-top:1rem">¿Prefieres explorar primero? <a href="#" id="e-demo">Cargar datos de demostración</a> (se identifican claramente y puedes borrarlos cuando quieras).</p></div>`;
      $("#e-acc").onclick = () => accountModal(); $("#e-demo").onclick = async (e) => { e.preventDefault(); await loadDemo(); };
      return;
    }
    const chip = ([k, l]) => `<button class="chip ${S.dash.period === k ? "on" : ""}" data-p="${k}">${k === "3months" ? icon("calendar") : k === "custom" ? icon("sliders") : ""}${l}</button>`;
    const chev = icon("chevron", "row-chev");
    const SUM_TITLE = { today: "Resumen de hoy", week: "Resumen semanal", month: "Resumen del mes", "3months": "Resumen de 3 meses", year: "Resumen anual", custom: "Resumen del periodo" };
    const pv = d.previous, pct = pv && pv.expense_change_pct;
    const delta = pct == null ? "" : `<span class="delta ${pct < 0 ? "down" : ""}" title="${esc(pv.label)} (${esc(fmtDate(pv.from, { day: "numeric", month: "short" }))} – ${esc(fmtDate(pv.to, { day: "numeric", month: "short" }))})">${icon("trend")}${pct > 0 ? "+" : ""}${pct.toFixed(2)}%</span>`;
    const sumRow = (k, v, href) => href ? `<a href="${href}"><span>${k}</span><b>${v}</b></a>` : `<div><span>${k}</span><b>${v}</b></div>`;
    const hasDemo = S.accounts.some((a) => a.is_demo);
    const scoreCls = (s100) => s100 == null ? "" : s100 >= 70 ? "ok" : s100 >= 40 ? "mid" : "bad";
    const scoreLabel = (v) => v == null ? "Sin datos suficientes todavía" : v >= 8 ? "Vas muy bien encaminado" : v >= 6 ? "Bien, con algunas áreas de mejora" : v >= 4 ? "Regular, conviene ajustar algo" : "Necesita atención";
    const catTotal = d.categories.reduce((a, k) => a + k.total, 0);
    // ---- insights (todo sale de los datos del periodo)
    const sInc = d.series.reduce((s, x) => s + x.income, 0), sExp = d.series.reduce((s, x) => s + x.expense, 0);
    const insFlow = !sInc && !sExp ? "" : !sInc ? insight("Sin ingresos en el periodo", "warn")
      : sExp > sInc ? insight(`Gastaste ${pctTxt(((sExp - sInc) * 100) / sInc)} más de lo que entró`, "bad")
      : insight(`Te quedó ${pctTxt(((sInc - sExp) * 100) / sInc)} de lo que entró`, "ok");
    const topCat = d.categories[0], topPct = topCat && catTotal ? (topCat.total * 100) / catTotal : 0;
    const insCat = topCat ? insight(`${topCat.name.replace(/^\[DEMO\]\s*/, "")}: ${Math.round(topPct)}% del gasto`, topPct >= 40 ? "warn" : "") : "";
    const dayEnd = d.period.today && d.period.today < d.period.to ? d.period.today : d.period.to;
    const nDays = Math.max(1, Math.round((new Date(dayEnd) - new Date(d.period.from)) / 864e5) + 1);
    const insSum = c.expense ? insight(`${money(Math.round(c.expense / nDays / 100) * 100, C).replace(/\.00$/, "")}/día`) : "";
    const bigTx = d.latest.filter((t) => t.type === "expense" && (!t.currency || t.currency === C)).sort((x, y) => y.amount - x.amount)[0];
    const insTx = bigTx ? insight(`Mayor: ${(bigTx.description || bigTx.category_name || "Gasto").replace(/^\[DEMO\]\s*/, "")} ${money(bigTx.amount, bigTx.currency || C)}`) : "";
    view.innerHTML = `
      ${hasDemo ? `<a class="note row" href="#/settings" id="demo-note">${icon("info", "ico-info")}<span>Tienes datos de <b>demostración</b>. Bórralos en Configuración.</span>${chev}</a>` : ""}
      <section class="card money-hero">
        <div class="mh-top"><span class="mh-k">Tu dinero ${health ? "· " + esc(monthName(health.month)) : "este mes"}</span>${heroInsight(health, C)}</div>
        <figure class="sh-quote" id="sh-quote" role="button" tabindex="0" title="Toca para ver otra frase">${quoteHtml(dailyQuote())}</figure>
        ${health && health.amounts ? `<div class="mh-stats">${[["Gastos", "living"], ["Ahorro", "savings"], ["Inversión", "investments"]].map(([l, k]) => {
            // Ahorro: el saldo de hoy en tus cuentas de ahorro (p. ej. Revolut), como % de todos tus activos
            const sav = k === "savings" && health.has_savings_accounts;
            const v = sav ? health.savings_balance : health.amounts[k];
            const p = sav ? (health.assets_total > 0 ? Math.round((v * 1000) / health.assets_total) / 10 : null) : health.income ? Math.round((v * 1000) / health.income) / 10 : null;
            const n = money(v, C).length;
            return `<div class="mh-stat"><span class="mh-sk">${l}</span><b class="${v < 0 ? "neg" : ""} ${n > 12 ? "xs" : n > 9 ? "sm" : ""}">${esc(money(v, C))}</b>${p != null ? `<small>${p}% ${sav ? "de activos" : "del ingreso"}</small>` : ""}</div>`; }).join("")}</div>
          <div class="mh-foot"><span>Ingresos <b>${esc(money(health.income, C))}</b>${health.has_savings_accounts ? ` · Activos <b>${esc(money(health.assets_total, C))}</b>` : ""}</span><a href="#/analysis">Detalle ${icon("chevron", "rot180")}</a></div>
          ${health.has_savings_accounts ? "" : `<div class="mh-hint"><a href="#/accounts">Marca tu cuenta de ahorro</a> para ver tu ahorro real.</div>`}`
          : `<div class="mh-foot"><span>Registra tus ingresos para ver tu mes.</span></div>`}
      </section>
      <div class="chips" role="group" aria-label="Periodo">${PERIODS.map(chip).join("")}</div>
      ${S.dash.period === "custom" ? `<form class="row2" id="range" style="max-width:420px;align-items:end;margin-bottom:1rem"><div class="field" style="margin:0"><label for="r-from">Desde</label><input type="date" id="r-from" name="from" value="${esc(S.dash.from)}" required></div>
        <div class="field" style="margin:0"><label for="r-to">Hasta</label><input type="date" id="r-to" name="to" value="${esc(S.dash.to)}" required></div><button class="btn sm" type="submit" style="grid-column:1/-1;justify-self:start">Aplicar rango</button></form>` : ""}
      <section class="card sum-card">
        <a class="sum-head" href="#/movements" id="sum-open">${icon("bars")}<span class="grow">${SUM_TITLE[S.dash.period] || "Resumen"}</span>${insSum}${chev}</a>
        <div class="sum-body">
          <div class="k">Gastos totales</div>
          <div class="sum-main"><span class="v">${esc(money(c.expense, C))}</span>${delta}</div>
          <div class="muted small">${esc(fmtDate(d.period.from, { day: "numeric", month: "short" }))} – ${esc(fmtDate(d.period.to, { day: "numeric", month: "short" }))} </div>
          <div class="sum-list">
            ${sumRow("Ingresos", esc(money(c.income, C)))}
            ${sumRow("Balance neto", `<span class="${c.net < 0 ? "neg" : "pos"}">${esc(money(c.net, C, { sign: true }))}</span>`)}
            ${sumRow("Dinero disponible", esc(money(c.available, C)))}
            ${c.card_debt > 0 ? sumRow("Deuda en tarjetas", `<span class="neg">${esc(money(c.card_debt, C))}</span>`, "#/cards") : ""}
            ${c.debts_total > 0 ? sumRow("Deudas", `<span class="neg">${esc(money(c.debts_total, C))}</span>`, "#/debts") : ""}
            ${sumRow("Patrimonio neto", esc(money(c.net_worth, C)), "#/analysis")}
          </div>
        </div>
      </section>
      ${d.alerts.length ? `<div class="alerts ${d.alerts.length > 3 ? "clip" : ""}" id="alerts">${d.alerts.map((a) => a.link ? `<a class="alert ${a.level}" role="alert" href="${esc(a.link)}">${icon("alert")}<span>${esc(a.text)}</span>${chev}</a>` : `<div class="alert ${a.level}" role="alert">${icon("alert")}<span>${esc(a.text)}</span><span></span></div>`).join("")}${d.alerts.length > 3 ? `<button type="button" class="alerts-more" id="alerts-more">Ver ${d.alerts.length - 3} aviso${d.alerts.length - 3 > 1 ? "s" : ""} más</button>` : ""}</div>` : ""}
      ${(d.converted_accounts || []).length ? `<div class="note-min">Incluye cuentas en ${esc([...new Set(d.converted_accounts.map((a) => a.currency))].join(", "))} · ${(d.fx || []).map((f) => `1 ${esc(f.currency)} = ${esc(f.rate.toFixed(2))} ${esc(d.currency)}`).join(", ")}</div>` : ""}
      ${d.excluded_accounts.length ? `<a class="note-min" href="#/accounts">Sin tipo de cambio: ${esc(d.excluded_accounts.map((a) => a.name).join(", "))} no se suma${d.excluded_accounts.length > 1 ? "n" : ""}.</a>` : ""}
      <div class="grid two">
        <section class="card"><h2>Ingresos vs. gastos ${insFlow}</h2><div class="key key-sm"><span><i class="dot" style="background:var(--income)"></i>Ingresos</span><span><i class="dot" style="background:var(--expense)"></i>Gastos</span></div>
          ${d.series.some((s) => s.income || s.expense) ? barChart(d.series, d.series_unit, C) : `<div class="empty">Sin movimientos en este periodo.</div>`}</section>
        <section class="card"><h2>Gastos por categoría ${insCat}</h2>
          ${d.categories.length ? donut(d.categories, C) + `<div class="legend">${d.categories.map((k, i) => `<button data-cat="${k.id ?? ""}" ${k.id ? "" : "disabled"}><i class="dot" style="background:${PALETTE[i % PALETTE.length]}"></i><span class="nm">${esc(k.name)}</span><span class="am">${esc(money(k.total, C))}</span><span class="pc">${catTotal ? Math.round(k.total / catTotal * 100) : 0}%</span></button>`).join("")}</div>` : `<div class="empty">Sin gastos en este periodo.</div>`}</section>
      </div>
      <section class="card" style="margin-top:1rem"><h2><a href="#/movements" class="h2-link">Últimos movimientos ${icon("chevron", "rot180")}</a> ${insTx}</h2>
        ${d.latest.length ? txRows(d.latest) : `<div class="empty">Aún no hay movimientos. Usa “Nuevo movimiento” para registrar el primero.</div>`}</section>`;
    const dn = $("#demo-note", view); if (dn) dn.onclick = () => { settingsTab = "datos"; };
    const sq = $("#sh-quote", view);
    if (sq) { const next = () => { quoteIdx = (quoteIdx + 1) % QUOTES.length; sq.innerHTML = quoteHtml(QUOTES[quoteIdx]); };
      sq.onclick = next; sq.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); next(); } }; }
    const am = $("#alerts-more", view); if (am) am.onclick = () => { $("#alerts", view).classList.remove("clip"); am.remove(); };
    $("#sum-open", view).onclick = (e) => { e.preventDefault(); S.mov = { ...MOV_DEFAULT, from: d.period.from, to: d.period.to }; go("#/movements"); };
    $$(".chip", view).forEach((b) => b.onclick = () => { S.dash.period = b.dataset.p; if (b.dataset.p !== "custom") dashboardView(); else dashboardView(); });
    const rf = $("#range", view);
    if (rf) rf.onsubmit = (e) => { e.preventDefault(); const f = formData(rf); if (!f.from || !f.to) return toast("Elige ambas fechas.", "error"); S.dash.from = f.from; S.dash.to = f.to; dashboardView(); };
    $$("rect.bar", view).forEach((r) => r.onclick = () => { S.mov = { ...MOV_DEFAULT, from: r.dataset.from, to: r.dataset.to }; go("#/movements"); });
    $$(".legend button[data-cat]", view).forEach((b) => b.onclick = () => { if (!b.dataset.cat) return; S.mov = { ...MOV_DEFAULT, category_id: b.dataset.cat, from: d.period.from, to: d.period.to }; go("#/movements"); });
    bindTxRows(view);
  });
}
async function loadDemo() {
  try { await api("POST", "/api/demo"); await refreshCore(); toast("Datos de demostración cargados."); route(); } catch (e) { toast(e.message, "error"); }
}

/* =================================================================== MOVIMIENTOS (lista) */
function amountCell(t) {
  const c = t.account_currency;
  if (t.type === "transfer") return `<span>${esc(money(t.amount, c))}</span>`;
  const pos = t.type === "income" || t.type === "refund" || (t.type === "adjustment" && t.amount > 0);
  return `<span class="${pos ? "pos" : "neg"}">${esc(money(pos ? Math.abs(t.amount) : -Math.abs(t.amount), c, { sign: true }))}</span>`;
}
const TX_ICON = { expense: "arrowdown", income: "arrowup", refund: "arrowup", transfer: "swap", adjustment: "sliders" };
function txRows(list) {
  return `<div class="tx-head" role="row"><span>Fecha</span><span>Descripción</span><span>Categoría</span><span>Cuenta</span><span>Tipo</span><span class="right">Importe</span></div>` +
    list.map((t) => `<div class="tx-row" role="button" tabindex="0" data-tx="${t.id}">
      <span class="c-date small">${esc(fmtDate(t.date, { day: "2-digit", month: "short" }))}</span>
      <span class="desc"><span class="tx-ico ${t.type}">${icon(TX_ICON[t.type] || "wallet")}</span><span class="desc-txt"><b>${esc(t.description || (t.type === "transfer" ? "Transferencia" : TYPE_LABEL[t.type]))}</b>${t.plan_kind ? `<span class="badge plan">${t.plan_months} ${t.plan_kind === "msi" ? "MSI" : "meses"}</span>` : ""}${t.recurring ? `<span class="badge plan">${icon("repeat")}</span>` : ""}${t.is_demo ? '<span class="badge demo">DEMO</span>' : ""}</span></span>
      <span class="c-cat ellip">${esc(t.category_name || (t.type === "transfer" ? "—" : "Sin categoría"))}</span>
      <span class="c-acc ellip">${esc(t.account_name)}${t.to_account_name ? " → " + esc(t.to_account_name) : ""}</span>
      <span class="c-type"><span class="badge ${t.type}">${TYPE_LABEL[t.type]}</span></span>
      <span class="amt">${amountCell(t)}</span>
      <span class="tx-mobile">${esc(fmtDate(t.date, { day: "2-digit", month: "short" }))} · ${esc(t.category_name || TYPE_LABEL[t.type])} · ${esc(t.account_name)}${t.to_account_name ? " → " + esc(t.to_account_name) : ""}</span></div>`).join("");
}
function bindTxRows(root, onChange) {
  $$("[data-tx]", root).forEach((r) => {
    const open = () => txDetail(+r.dataset.tx);
    r.onclick = open; r.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
  });
}

function movementsView() {
  const view = mountShell("movements", "Movimientos");
  const f = S.mov;
  const accOpts = S.accounts.map((a) => `<option value="${a.id}" ${String(f.account_id) === String(a.id) ? "selected" : ""}>${esc(a.name)}</option>`).join("");
  const catOpts = S.categories.map((c) => `<option value="${c.id}" ${String(f.category_id) === String(c.id) ? "selected" : ""}>${esc(c.name)}${c.kind === "income" ? " (ingreso)" : ""}</option>`).join("");
  view.innerHTML = `<div class="card">
    <div class="filters" role="search">
      <div class="field"><label for="m-q" class="lbl">Buscar</label><input id="m-q" type="search" placeholder="Descripción, notas, etiquetas…" value="${esc(f.q)}"></div>
      <div class="field"><label for="m-from">Desde</label><input id="m-from" type="date" value="${esc(f.from)}"></div>
      <div class="field"><label for="m-to">Hasta</label><input id="m-to" type="date" value="${esc(f.to)}"></div>
      <div class="field"><label for="m-acc">Cuenta</label><select id="m-acc"><option value="">Todas</option>${accOpts}</select></div>
      <div class="field"><label for="m-cat">Categoría</label><select id="m-cat"><option value="">Todas</option>${catOpts}</select></div>
      <div class="field"><label for="m-type">Tipo</label><select id="m-type"><option value="">Todos</option>${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${f.type === k ? "selected" : ""}>${v}</option>`).join("")}</select></div>
    </div>
    <div style="display:flex;gap:.5rem;justify-content:space-between;flex-wrap:wrap;margin-bottom:.4rem">
      <button class="btn sm ghost" id="m-clear">Limpiar filtros</button><a class="btn sm" id="m-csv" href="#">${icon("download")} Exportar CSV</a></div>
    <div id="tx-list"><div class="spinner"></div></div></div>`;
  const bind = (id, key, ev = "change") => $(id).addEventListener(ev, (e) => { f[key] = e.target.value; f.page = 1; loadList(); });
  let t; $("#m-q").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value; f.page = 1; loadList(); }, 250); });
  bind("#m-from", "from"); bind("#m-to", "to"); bind("#m-acc", "account_id"); bind("#m-cat", "category_id"); bind("#m-type", "type");
  $("#m-clear").onclick = () => { S.mov = { ...MOV_DEFAULT }; movementsView(); };
  const filterQs = () => qs({ q: f.q, from: f.from, to: f.to, account_id: f.account_id, category_id: f.category_id, type: f.type, sort: f.sort, dir: f.dir });
  $("#m-csv").onclick = (e) => { e.preventDefault(); downloadFile("/api/transactions.csv?" + filterQs()); };

  async function loadList() {
    const box = $("#tx-list");
    try {
      const d = await api("GET", "/api/transactions?" + qs({ ...f }));
      const pages = Math.max(1, Math.ceil(d.total / d.per_page));
      if (f.page > pages) { f.page = pages; return loadList(); }
      const arrow = (k) => (f.sort === k ? (f.dir === "asc" ? " ↑" : " ↓") : "");
      const head = `<div class="tx-head"><button data-s="date">Fecha${arrow("date")}</button><button data-s="description">Descripción${arrow("description")}</button><button data-s="category">Categoría${arrow("category")}</button><button data-s="account">Cuenta${arrow("account")}</button><button data-s="type">Tipo${arrow("type")}</button><button data-s="amount" class="right">Importe${arrow("amount")}</button></div>`;
      box.innerHTML = d.total ? `${head}${txRows(d.transactions).replace(/^<div class="tx-head".*?<\/div>/, "")}
        <div class="pager"><span class="muted small">${d.total} movimientos · página ${f.page} de ${pages}</span><span>
        <button class="btn sm" id="pg-prev" ${f.page <= 1 ? "disabled" : ""}>Anterior</button> <button class="btn sm" id="pg-next" ${f.page >= pages ? "disabled" : ""}>Siguiente</button></span></div>`
        : `<div class="empty">No hay movimientos con estos filtros.</div>`;
      $$("[data-s]", box).forEach((b) => b.onclick = () => { const k = b.dataset.s; if (f.sort === k) f.dir = f.dir === "asc" ? "desc" : "asc"; else { f.sort = k; f.dir = k === "date" || k === "amount" ? "desc" : "asc"; } f.page = 1; loadList(); });
      const pv = $("#pg-prev", box), nx = $("#pg-next", box);
      if (pv) pv.onclick = () => { f.page--; loadList(); }; if (nx) nx.onclick = () => { f.page++; loadList(); };
      bindTxRows(box);
    } catch (e) { if (e.status !== 401) { box.innerHTML = errorBox(e); $("#retry", box).onclick = loadList; } }
  }
  loadList();
}

/* =================================================================== DETALLE Y FORMULARIO DE MOVIMIENTO */
async function txDetail(id) {
  let t;
  try { t = (await api("GET", "/api/transactions/" + id)).transaction; } catch (e) { return toast(e.message, "error"); }
  const c = t.account_currency;
  const rows = [["Tipo", `<span class="badge ${t.type}">${TYPE_LABEL[t.type]}</span>${t.is_demo ? '<span class="badge demo">DEMO</span>' : ""}`],
    ["Importe", amountCell(t)], ["Fecha", esc(fmtDate(t.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" }))],
    ["Cuenta", esc(t.account_name)]];
  if (t.type === "transfer") { rows.push(["Cuenta destino", esc(t.to_account_name)]); if (t.to_amount !== t.amount) rows.push(["Importe recibido", esc(money(t.to_amount, accById(t.to_account_id)?.currency || c))]); }
  if (t.type !== "transfer" && t.type !== "adjustment") rows.push(["Categoría", esc(t.category_name || "Sin categoría")]);
  if (t.description) rows.push(["Descripción", esc(t.description)]);
  if (t.payment_method) rows.push(["Método de pago", esc(t.payment_method)]);
  if (t.tags) rows.push(["Etiquetas", t.tags.split(",").map((x) => `<span class="badge">${esc(x)}</span>`).join(" ")]);
  if (t.notes) rows.push(["Notas", esc(t.notes).replace(/\n/g, "<br>")]);
  if (t.recurring) rows.push(["Recurrente", "Sí"]);
  rows.push(["Registrado", esc(t.created_at)]);
  let rcs = []; try { rcs = (await api("GET", "/api/receipts?tx_id=" + t.id)).receipts; } catch { /* sin comprobantes */ }
  rows.push(["Comprobantes", `${rcs.map((r) => `<a href="/api/receipts/${r.id}/file" target="_blank" rel="noopener"><img class="rc-thumb" src="/api/receipts/${r.id}/file" alt="Comprobante"></a>`).join("")}<label class="btn sm" style="cursor:pointer">${icon("camera")} Adjuntar<input type="file" id="d-rc" accept="image/jpeg,image/png,image/webp" hidden></label>`]);
  const m = openModal("Detalle del movimiento", `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    <footer><button class="btn danger" id="d-del">${icon("trash")} Eliminar</button><button class="btn primary" id="d-edit">${icon("edit")} Editar</button></footer>`, {
    onMount: (el, close) => {
      $("#d-edit", el).onclick = () => { close(); txModal(t); };
      $("#d-rc", el).onchange = async (ev) => { const f = ev.target.files[0]; if (!f) return; try { const r = await scanReceipt(f); await api("POST", `/api/receipts/${r.receipt.id}/link`, { tx_id: t.id }); close(); toast("Comprobante adjuntado."); txDetail(t.id); } catch (e) { toast(e.message, "error"); } };
      $("#d-del", el).onclick = async () => {
        if (!(await confirmDialog("¿Eliminar movimiento?", "Los saldos, gráficas y reportes se recalcularán. Esta acción no se puede deshacer."))) return;
        try { await api("DELETE", "/api/transactions/" + t.id); close(); await refreshCore(); toast("Movimiento eliminado."); route(); } catch (e) { toast(e.message, "error"); }
      };
    } });
}

function categoryOptions(kind, existingCatId) {
  const list = S.categories.filter((c) => c.kind === kind && (!c.archived || existingCatId === c.id));
  const byId = Object.fromEntries(list.map((c) => [c.id, c]));
  const out = [];
  list.filter((c) => !c.parent_id || !byId[c.parent_id]).forEach((p) => { out.push([p.id, p.name]); list.filter((c) => c.parent_id === p.id).forEach((ch) => out.push([ch.id, `${p.name} › ${ch.name}`])); });
  return out;
}
/* Ver el monto en la moneda de la cuenta o en tu moneda principal (solo si la cuenta es de otra moneda). */
const fxCache = { at: 0, data: null };
async function loadFx() {
  if (fxCache.data && Date.now() - fxCache.at < 300000) return fxCache.data;
  try { fxCache.data = await api("GET", "/api/fx"); fxCache.at = Date.now(); } catch { /* sin tipo de cambio: se muestra solo la moneda de la cuenta */ }
  return fxCache.data;
}
function fxBoxHtml(acc, cents, label, extraLine = "") {
  const main = S.user.currency, fx = fxCache.data, info = fx && acc && acc.currency !== main ? fx.rates[acc.currency] : null;
  if (!acc) return "";
  if (acc.currency === main) return `${esc(label)} <b>${esc(money(cents, acc.currency, { mask: false }))}</b>${extraLine}`;
  const view = store.get("fxView", "account") === "main" && info ? "main" : "account";
  const shown = view === "main" ? money(Math.round(cents * info.rate), main, { mask: false }) : money(cents, acc.currency, { mask: false });
  const chips = info ? `<span class="seg seg-sm fx-seg" style="display:inline-grid;margin:0 0 0 .5rem;vertical-align:middle">${[["account", acc.currency], ["main", main]].map(([k, l]) => `<button type="button" data-fxview="${k}" class="${view === k ? "on" : ""}">${esc(l)}</button>`).join("")}</span>` : "";
  const rate = info ? ` · 1 ${esc(acc.currency)} = ${esc(info.rate.toFixed(2))} ${esc(main)}${info.source === "manual" ? " (el de tu hoja)" : ""}` : ` · sin tipo de cambio disponible por ahora`;
  return `${esc(label)} <b>${esc(shown)}</b>${chips}<div class="muted small" style="margin-top:.25rem">${extraLine ? extraLine + " · " : ""}Cuenta en ${esc(acc.currency)}${rate}</div>`;
}

/* conversión entre tu moneda principal y las de tus cuentas (con los tipos de cambio de /api/fx) */
const fxToMain = (cur) => (cur === S.user.currency ? 1 : fxCache.data && fxCache.data.rates[cur] ? fxCache.data.rates[cur].rate : null);
const fxConvert = (cents, from, to) => { const a = fxToMain(from), b = fxToMain(to); return a && b ? Math.round((cents * a) / b) : null; };
function fxOptions(accCur) {                     // la moneda de la cuenta primero, luego las demás con tipo de cambio
  const fx = fxCache.data; if (!fx) return [accCur];
  const all = [S.user.currency, ...Object.keys(fx.rates).filter((k) => fx.rates[k])];
  return [accCur, ...all.filter((k) => k !== accCur && fxToMain(k) && fxToMain(accCur))];
}

function txModal(existing = null, preset = {}) {
  const isAdj = existing && existing.type === "adjustment";
  const st = { type: existing ? existing.type : preset.type || "expense" };
  const active = S.accounts.filter((a) => !a.archived || (existing && (existing.account_id === a.id || existing.to_account_id === a.id)));
  if (!active.length) { toast("Primero crea una cuenta para registrar movimientos.", "error"); return go("#/accounts"); }
  const lastAcc = existing ? existing.account_id : preset.account_id || store.get("lastAccount", active[0].id);
  const catList = (kind) => categoryOptions(kind, existing ? existing.category_id : null);
  const SEG_IC = { expense: "arrowdown", income: "arrowup", transfer: "swap", refund: "repeat", buy: "trend" }, SEG_SHORT = { transfer: "Transferir" };
  const segHtml = () => `<div class="seg seg-tx ${existing ? "" : "seg-5"}" role="tablist" aria-label="Tipo de movimiento">${(existing ? ["expense", "income", "transfer", "refund"] : ["expense", "income", "transfer", "refund", "buy"]).map((k) => `<button type="button" role="tab" data-t="${k}" class="${st.type === k ? "on" : ""}" aria-selected="${st.type === k}" aria-label="${TYPE_LABEL[k]}">${icon(SEG_IC[k])}<span class="l-full">${TYPE_LABEL[k]}</span><span class="l-short">${SEG_SHORT[k] || TYPE_LABEL[k]}</span></button>`).join("")}</div>`;
  /* Compra de acciones desde + Movimiento: se guarda como operación de compra en el Portafolio y descuenta
     el efectivo de la cuenta elegida (no cuenta como gasto). */
  const drawBuy = (v) => {
    const accs = active.filter((a) => a.type !== "credit");
    if (!accs.length) { toast("Necesitas una cuenta (no tarjeta) para pagar la compra.", "error"); st.type = "expense"; return draw({}); }
    const main = S.user.currency, lastBuy = store.get("lastBuyAccount", null);
    const want = v.symbol !== undefined ? v.account_id : lastBuy;          // la cuenta de Gasto/Ingreso no se arrastra a Acciones
    const pick = accs.find((a) => String(a.id) === String(want)) || accs.find((a) => a.type === "investment" && a.currency !== main) || accs.find((a) => a.type === "investment") || accs[0];
    body.innerHTML = `<form id="tx-f" novalidate>${segHtml()}
      <div class="row2">${field("Símbolo", "symbol", 'required maxlength="20" placeholder="AAPL, VOO, BTC-USD" autocapitalize="characters"', v.symbol ?? "")}${sel("asset_type", "Tipo de activo", Object.entries(ASSET_LABEL), v.asset_type || "stock")}</div>
      <div class="row2">${field("Cantidad", "quantity", 'inputmode="decimal" placeholder="0" autocomplete="off" required', v.quantity ?? "")}${field("Precio por unidad", "price", 'inputmode="decimal" placeholder="0.00" autocomplete="off" required', v.price ?? "")}</div>
      <div class="row2">${field("Comisión", "fee", 'inputmode="decimal" placeholder="Opcional" autocomplete="off"', v.fee ?? "")}${field("Fecha", "date", 'type="date" required', v.date ?? todayStr())}</div>
      <div class="field"><label for="f-account_id">Pagar desde la cuenta</label><select id="f-account_id" name="account_id">${accs.map((a) => `<option value="${a.id}" ${a.id === pick.id ? "selected" : ""}>${esc(a.name)} (${a.currency})</option>`).join("")}</select></div>
      <div id="conv-wrap"></div>
      <div class="note" id="fx-box"></div>
      ${field("Notas", "notes", 'maxlength="500"', v.notes ?? "")}
      <p class="muted small">Va a tu Portafolio y descuenta la cuenta. No cuenta como gasto.</p>
      <footer><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" type="submit">Registrar compra</button></footer></form>`;
    const form = $("#tx-f", body), box = $("#fx-box", form);
    const snapshot = () => formData(form);
    /* Paso previo opcional: comprar dólares con pesos (transferencia interna entre tus cuentas, p. ej. Smart Cash → cuenta USD) */
    const convWrap = $("#conv-wrap", form);
    const convOn = () => !!(form.elements.convert && form.elements.convert.checked);
    const convAmounts = () => ({ out: inputCents(form.elements.conv_out ? form.elements.conv_out.value : ""), inn: inputCents(form.elements.conv_in ? form.elements.conv_in.value : "") });
    const drawConv = () => {
      const a = accById(+form.elements.account_id.value), opts = a && a.currency !== S.user.currency ? accs.filter((x) => x.currency === S.user.currency) : [];
      const keep = { on: convOn(), from: form.elements.from_account_id ? form.elements.from_account_id.value : "", out: form.elements.conv_out ? form.elements.conv_out.value : "", inn: form.elements.conv_in ? form.elements.conv_in.value : "" };
      if (!opts.length) { convWrap.innerHTML = ""; return; }
      const from = opts.find((x) => String(x.id) === String(keep.from || store.get("lastConvFrom", ""))) || opts.find((x) => x.type === "investment") || opts[0];
      convWrap.innerHTML = `<label class="check" style="margin-bottom:.7rem"><input type="checkbox" name="convert" ${keep.on ? "checked" : ""}> Antes cambié ${esc(from.currency)} → ${esc(a.currency)}</label>
        <div id="conv-box" class="inst-box ${keep.on ? "" : "hidden"}">
          <div class="field"><label for="f-from_account_id">Salió de la cuenta</label><select id="f-from_account_id" name="from_account_id">${opts.map((x) => `<option value="${x.id}" ${x.id === from.id ? "selected" : ""}>${esc(x.name)} (${x.currency})</option>`).join("")}</select></div>
          <div class="row2"><div class="field"><label for="f-conv_out">Importe que salió <span class="muted" id="conv-out-cur">(${esc(from.currency)})</span></label><input id="f-conv_out" name="conv_out" inputmode="decimal" placeholder="0.00" autocomplete="off" value="${esc(keep.out)}"></div>
            <div class="field"><label for="f-conv_in">Importe que llegó (${esc(a.currency)})</label><input id="f-conv_in" name="conv_in" inputmode="decimal" placeholder="0.00" autocomplete="off" value="${esc(keep.inn)}"></div></div>
          <p class="muted small" id="conv-hint"></p></div>`;
      form.elements.convert.onchange = () => {
        $("#conv-box", form).classList.toggle("hidden", !convOn());
        if (convOn() && !form.elements.conv_in.value && total()) {          // sugerencia: justo lo que cuesta la compra, al tipo de cambio de hoy
          form.elements.conv_in.value = centsToInput(total());
          const info = fxCache.data && fxCache.data.rates[a.currency], fr = accById(+form.elements.from_account_id.value);
          if (info && fr && fr.currency === S.user.currency) form.elements.conv_out.value = centsToInput(Math.round(total() * info.rate));
        }
        render();
      };
      form.elements.from_account_id.onchange = () => { drawConv(); render(); };
    };
    let inCur = null;                                   // moneda en la que escribes precio y comisión (null = la de la cuenta)
    const typedTotal = () => { const q = parseFloat(String(form.elements.quantity.value).replace(/[,\s]/g, "")), p = parseFloat(String(form.elements.price.value).replace(/[,$\s]/g, "")); return (isFinite(q) && isFinite(p) ? Math.round(q * p * 100) : 0) + inputCents(form.elements.fee.value); };
    const curIn = () => { const a = accById(+form.elements.account_id.value); return inCur && a && inCur !== a.currency ? inCur : null; };
    const total = () => { const t = typedTotal(), a = accById(+form.elements.account_id.value), ic = curIn(); return ic ? (fxConvert(t, ic, a.currency) || 0) : t; };   // siempre en la moneda de la cuenta
    const render = () => {
      const a = accById(+form.elements.account_id.value), t = total(), cv = convOn() ? convAmounts() : { out: 0, inn: 0 };
      const after = a ? a.balance + cv.inn - t : 0;
      const hint = $("#conv-hint", form);
      if (hint) {
        const fr = accById(+(form.elements.from_account_id || {}).value), main = S.user.currency;
        let r = "";
        if (fr && a && cv.out && cv.inn) {
          if (fr.currency === main) r = `1 ${a.currency} = ${(cv.out / cv.inn).toFixed(2)} ${main} · `;
          else if (a.currency === main) r = `1 ${fr.currency} = ${(cv.inn / cv.out).toFixed(2)} ${main} · `;
        }
        hint.innerHTML = fr ? `${esc(r)}${esc(fr.name)} queda en <b class="${fr.balance - cv.out < 0 ? "neg" : ""}">${esc(money(fr.balance - cv.out, fr.currency, { mask: false }))}</b>` : "";
      }
      // en qué moneda escribes precio y comisión: la de la cuenta o la otra (MXN ⇄ USD); se guarda convertido a la de la cuenta
      const opts = a ? fxOptions(a.currency) : [];
      if (!opts.includes(inCur)) inCur = a ? a.currency : null;
      const ic = curIn(), shownCur = ic || (a && a.currency), main = S.user.currency;
      const lp = form.querySelector('label[for="f-price"]'), lf = form.querySelector('label[for="f-fee"]');
      if (lp) lp.textContent = opts.length > 1 ? `Precio por unidad (${shownCur})` : "Precio por unidad";
      if (lf) lf.textContent = opts.length > 1 ? `Comisión (${shownCur})` : "Comisión";
      const other = opts.find((x) => x !== a.currency), eq = other && t ? fxConvert(t, a.currency, other) : null;
      const fc = [a && a.currency, other].find((x) => x && x !== main), r = fc ? fxToMain(fc) : null;
      box.innerHTML = !a ? "" : `${opts.length > 1 ? `<div class="fx-in" style="margin-bottom:.4rem"><span>Precio en</span><span class="seg seg-sm fx-seg">${opts.map((k) => `<button type="button" data-incur="${k}" class="${k === inCur ? "on" : ""}">${esc(k)}</button>`).join("")}</span></div>` : ""}
        Total de la compra: <b>${esc(money(t, a.currency, { mask: false }))}</b>${eq != null ? ` <span class="muted">≈ ${esc(money(eq, other, { mask: false }))}</span>` : ""}
        <div class="muted small" style="margin-top:.25rem">Saldo después: <span class="${after < 0 ? "neg" : ""}">${esc(money(after, a.currency, { mask: false }))}</span>${r ? ` · 1 ${esc(fc)} = ${esc(r.toFixed(2))} ${esc(main)}` : ""}</div>`;
      $$("[data-incur]", box).forEach((b) => b.onclick = () => { inCur = b.dataset.incur; render(); form.elements.price.focus(); });
    };
    drawConv();
    form.addEventListener("input", render); form.elements.account_id.addEventListener("change", () => { drawConv(); render(); }); render();
    loadFx().then(render);
    $$(".seg button", form).forEach((b) => b.onclick = () => { const d = snapshot(); st.type = b.dataset.t; draw(d); });
    form.onsubmit = (e) => { e.preventDefault(); submitForm(form, async () => {
      const d = snapshot(), acc = accById(+d.account_id), ic = curIn();
      if (ic) {                                          // escribiste precio/comisión en otra moneda: se guardan en la de la cuenta
        const ra = fxToMain(ic), rb = fxToMain(acc.currency), k = ra && rb ? ra / rb : null;
        if (!k) throw new ApiError("No hay tipo de cambio para convertir el precio. Escríbelo en " + acc.currency + ".", 400, "price");
        const pr = parseFloat(String(d.price).replace(/[,$\s]/g, ""));
        const note = `Capturado en ${ic}: precio ${d.price}${d.fee ? ", comisión " + d.fee : ""}`;
        if (isFinite(pr)) d.price = (pr * k).toFixed(6).replace(/\.?0+$/, "");
        if (d.fee) d.fee = centsToInput(fxConvert(inputCents(d.fee), ic, acc.currency));
        d.notes = d.notes ? d.notes + " · " + note : note;
      }
      const op = { kind: "buy", symbol: String(d.symbol || "").trim().toUpperCase(), asset_type: d.asset_type, quantity: d.quantity, price: d.price, fee: d.fee, date: d.date, account_id: d.account_id, currency: acc.currency, notes: d.notes };
      const conv = convOn();
      if (conv) {
        const from = accById(+d.from_account_id); store.set("lastConvFrom", from.id);
        await api("POST", "/api/transactions", { type: "transfer", account_id: from.id, to_account_id: acc.id, amount: d.conv_out, to_amount: d.conv_in, date: d.date,
          description: `Compra de ${acc.currency} (${from.currency} → ${acc.currency})`, notes: `Conversión previa a la compra de ${op.symbol}` });
      }
      try { await api("POST", "/api/portfolio/ops", op); }
      catch (e) {
        if (!conv) throw e;
        await refreshCore(); route();                                   // la conversión ya quedó guardada: se refleja en las dos cuentas
        throw new ApiError("La conversión de divisas sí se guardó, pero la compra no: " + e.message + " Registra la compra otra vez desde Acciones sin marcar la conversión.", 400);
      }
      store.set("lastBuyAccount", +d.account_id);
      modal.close(); await refreshCore(); toast(conv ? "Conversión y compra registradas." : "Compra registrada en tu portafolio."); route(); }); };
    const sym = form.elements.symbol; if (sym && !existing) sym.focus();
  };
  const draw = (keep) => {
    const v = { ...keep };
    if (st.type === "buy" && !existing) return drawBuy(v);
    const kind = st.type === "income" ? "income" : "expense";
    const accOpt = (sel, skip) => active.filter((a) => a.id !== skip).map((a) => `<option value="${a.id}" ${String(sel) === String(a.id) ? "selected" : ""}>${esc(a.name)} (${a.currency})</option>`).join("");
    const cats = catList(kind);
    body.innerHTML = `<form id="tx-f" novalidate>
      ${isAdj ? `<div class="note">Ajuste de saldo: negativo resta, positivo suma.</div>` :
        segHtml()}
      <div class="row2">${(isAdj ? signedField : field)("Importe", "amount", 'inputmode="decimal" placeholder="0.00" autocomplete="off" required', v.amount ?? "")}
        ${field("Fecha", "date", 'type="date" required', v.date ?? todayStr())}</div>
      <div class="field"><label for="f-account_id">${st.type === "transfer" ? "Cuenta de origen" : "Cuenta"}</label><select id="f-account_id" name="account_id">${accOpt(v.account_id ?? lastAcc)}</select></div>
      <div class="note hidden" id="fx-box"></div>
      ${st.type === "expense" && !isAdj ? `<div id="inst-box" class="inst-box hidden">
        <div class="lbl" style="margin-bottom:.35rem">Forma de pago con tarjeta</div>
        <div class="seg seg-sm" id="inst-seg">${[["", "Una sola exhibición"], ["msi", "Meses sin intereses"], ["mci", "Con intereses"]].map(([k, l]) => `<button type="button" data-inst="${k}" class="${(v.inst_kind || "") === k ? "on" : ""}">${l}</button>`).join("")}</div>
        <input type="hidden" name="inst_kind" value="${esc(v.inst_kind || "")}">
        <div id="inst-detail" class="${v.inst_kind ? "" : "hidden"}"><div class="row2">
          <div class="field"><label for="f-inst_months">Meses</label><select id="f-inst_months" name="inst_months">${[...new Set([3, 6, 9, 10, 12, 13, 15, 18, 24, 36, 48, +v.inst_months || 12])].sort((x, y) => x - y).map((n) => `<option ${String(v.inst_months || 12) === String(n) ? "selected" : ""}>${n}</option>`).join("")}</select></div>
          <div class="field ${v.inst_kind === "mci" ? "" : "hidden"}" id="inst-monthly-wrap"><label for="f-inst_monthly">Mensualidad (con intereses)</label><input id="f-inst_monthly" name="inst_monthly" inputmode="decimal" placeholder="0.00" value="${esc(v.inst_monthly || "")}"></div></div>
          <p class="muted small" id="inst-hint"></p></div></div>` : ""}
      ${st.type === "transfer" ? `<div class="field"><label for="f-to_account_id">Cuenta de destino</label><select id="f-to_account_id" name="to_account_id">${accOpt(v.to_account_id ?? "", +(v.account_id ?? lastAcc))}</select></div>
        <div class="field hidden" id="to-amt-wrap"><label for="f-to_amount">Importe que recibe la cuenta destino</label><input id="f-to_amount" name="to_amount" inputmode="decimal" value="${esc(v.to_amount ?? "")}"><span class="muted small" id="to-amt-hint"></span></div>` : ""}
      ${st.type === "income" || st.type === "expense" || st.type === "refund" ? `<div class="field"><label for="f-category_id">Categoría</label><select id="f-category_id" name="category_id"><option value="">Sin categoría</option>
        ${cats.map(([id, n]) => `<option value="${id}" ${String(v.category_id ?? "") === String(id) ? "selected" : ""}>${esc(n)}</option>`).join("")}<option value="__new__">+ Nueva categoría…</option></select></div>` : ""}
      ${field("Descripción", "description", 'maxlength="200" placeholder="¿En qué fue?"', v.description ?? "")}
      <details ${v.payment_method || v.tags || v.notes || v.recurring ? "open" : ""} style="margin-bottom:.9rem"><summary class="muted" style="cursor:pointer;margin-bottom:.7rem">Más detalles</summary>
        ${field("Método de pago", "payment_method", 'maxlength="60" placeholder="Efectivo, débito, transferencia…"', v.payment_method ?? "")}
        ${field("Etiquetas", "tags", 'placeholder="Separadas por comas"', v.tags ?? "")}
        <div class="field"><label for="f-notes">Notas</label><textarea id="f-notes" name="notes" rows="2" maxlength="2000">${esc(v.notes ?? "")}</textarea></div>
        ${!existing && st.type === "expense" ? `<label class="check"><input type="checkbox" name="repeat_monthly" ${v.repeat_monthly ? "checked" : ""}> Repetir este cargo cada mes (FIPO lo registra solo)</label>` : ""}</details>
      <footer><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" type="submit">${existing ? "Guardar cambios" : "Guardar movimiento"}</button></footer></form>`;
    const form = $("#tx-f", body);
    const snapshot = () => { const d = formData(form); d.repeat_monthly = form.elements.repeat_monthly ? form.elements.repeat_monthly.checked : false; return d; };
    // moneda en la que escribes el importe: la de la cuenta o la otra (MXN ⇄ USD). Se guarda convertido a la moneda de la cuenta.
    const fxb = $("#fx-box", form);
    let inCur = null;                                               // null = moneda de la cuenta
    const fxRender = () => {
      const a = accById(+form.elements.account_id.value), c = Math.abs(inputCents(form.elements.amount.value));
      const opts = isAdj || !a ? [] : fxOptions(a.currency);
      const lab = form.querySelector('label[for="f-amount"]');
      if (opts.length < 2) { inCur = null; fxb.classList.add("hidden"); if (lab) lab.textContent = "Importe"; return; }
      if (!opts.includes(inCur)) inCur = a.currency;
      fxb.classList.remove("hidden");
      if (lab) lab.textContent = `Importe (${inCur})`;
      const other = inCur !== a.currency ? a.currency : opts.find((x) => x !== a.currency);
      const conv = c ? fxConvert(c, inCur, other) : null, main = S.user.currency, fc = [inCur, other].find((x) => x !== main) || other, r = fxToMain(fc);
      fxb.innerHTML = `<div class="fx-in"><span>Escribir en</span><span class="seg seg-sm fx-seg">${opts.map((k) => `<button type="button" data-incur="${k}" class="${k === inCur ? "on" : ""}">${esc(k)}</button>`).join("")}</span></div>
        ${c ? `<div style="margin-top:.35rem">${inCur !== a.currency ? `Se guardan <b>${esc(money(conv, a.currency, { mask: false }))}</b> en la cuenta` : `≈ <b>${esc(money(conv, other, { mask: false }))}</b>`}</div>` : ""}
        ${r ? `<div class="muted small" style="margin-top:.2rem">1 ${esc(fc)} = ${esc(r.toFixed(2))} ${esc(main)}</div>` : ""}`;
      $$("[data-incur]", fxb).forEach((b) => b.onclick = () => { inCur = b.dataset.incur; fxRender(); form.elements.amount.focus(); });
    };
    form.addEventListener("input", fxRender); form.elements.account_id.addEventListener("change", fxRender); fxRender(); loadFx().then(fxRender);
    form._inCur = () => { const a = accById(+form.elements.account_id.value); return inCur && a && inCur !== a.currency ? inCur : null; };
    // compras a meses: solo si pagas un gasto con tarjeta de crédito
    const ib = $("#inst-box", form);
    const instSync = () => {
      if (!ib) return;
      const a = accById(+form.elements.account_id.value), isCard = !!(a && a.type === "credit");
      ib.classList.toggle("hidden", !isCard);
      const k = form.elements.inst_kind.value, n = +form.elements.inst_months.value, amt = inputCents(form.elements.amount.value);
      $("#inst-detail", form).classList.toggle("hidden", !k || !isCard);
      $("#inst-monthly-wrap", form).classList.toggle("hidden", k !== "mci");
      const hint = $("#inst-hint", form);
      if (!isCard || !k) { hint.textContent = ""; return; }
      if (!a.cut_day) { hint.innerHTML = '<span class="neg">Esta tarjeta no tiene día de corte; agrégalo en Cuentas para comprar a meses.</span>'; return; }
      const monthly = k === "msi" ? Math.round(amt / n) : inputCents(form.elements.inst_monthly.value);
      const dt = form.elements.date.value || todayStr(), [y, mo, dd] = dt.split("-").map(Number);
      let cy = y, cm = mo; const cutOf = (yy, mm) => { const last = new Date(yy, mm, 0).getDate(); return `${yy}-${pad(mm)}-${pad(Math.min(a.cut_day, last))}`; };
      if (cutOf(cy, cm) <= dt) { cm += 1; if (cm > 12) { cm = 1; cy += 1; } }
      hint.innerHTML = amt ? `${n} mensualidades de <b>${esc(money(monthly, a.currency, { mask: false }))}</b>${k === "mci" && monthly ? ` (intereses totales ≈ ${esc(money(Math.max(0, monthly * n - amt), a.currency, { mask: false }))})` : ""} · la primera entra en tu corte del ${esc(fmtDate(cutOf(cy, cm), { day: "numeric", month: "short" }))}. Tu deuda sube por el total, pero en el pago del mes solo cuenta la mensualidad.` : "Escribe el importe total de la compra.";
    };
    if (ib) {
      $$("#inst-seg button", form).forEach((b) => b.onclick = () => { $$("#inst-seg button", form).forEach((x) => x.classList.toggle("on", x === b)); form.elements.inst_kind.value = b.dataset.inst; instSync(); });
      form.elements.account_id.addEventListener("change", instSync);
      form.addEventListener("input", instSync); form.elements.inst_months.addEventListener("change", instSync); instSync();
    }
    $$(".seg:not(#inst-seg) button", form).forEach((b) => b.onclick = () => { const d = snapshot(); delete d.category_id; st.type = b.dataset.t; draw(d); });
    const toWrap = $("#to-amt-wrap", form);
    const checkCur = () => {
      if (!toWrap) return;
      const a = accById(+form.elements.account_id.value), b = accById(+form.elements.to_account_id.value);
      const diff = a && b && a.currency !== b.currency;
      toWrap.classList.toggle("hidden", !diff);
      if (diff) {
        const o = inputCents(form.elements.amount.value), i = inputCents(form.elements.to_amount.value), main = S.user.currency;
        let r = "";
        if (o && i) { if (a.currency === main) r = ` Tipo de cambio: 1 ${b.currency} = ${(o / i).toFixed(4)} ${main}.`; else if (b.currency === main) r = ` Tipo de cambio: 1 ${a.currency} = ${(i / o).toFixed(4)} ${main}.`; }
        $("#to-amt-hint", form).textContent = `Monedas distintas: ${a.currency} → ${b.currency}. Indica cuánto recibe ${b.name}.${r}`;
      }
    };
    form.addEventListener("input", () => { if (toWrap) checkCur(); });
    if (toWrap) { form.elements.account_id.onchange = () => { const d = snapshot(); draw(d); }; form.elements.to_account_id.onchange = checkCur; checkCur(); }
    const cs = form.elements.category_id;
    if (cs) cs.onchange = () => { if (cs.value === "__new__") { cs.value = ""; categoryModal(kind, async (newId) => { const d = snapshot(); d.category_id = String(newId); draw(d); }); } };
    form.onsubmit = (e) => { e.preventDefault(); submitForm(form, async () => {
      const d = snapshot(); d.type = st.type;
      const acc = accById(+d.account_id), repeat = d.repeat_monthly;
      const ic = form._inCur && form._inCur();
      if (ic) {                                        // escribiste el importe en otra moneda: se guarda en la de la cuenta
        const typed = inputCents(d.amount), conv = fxConvert(Math.abs(typed), ic, acc.currency);
        if (conv == null) throw new ApiError("No hay tipo de cambio para convertir el importe. Escríbelo en " + acc.currency + ".", 400, "amount");
        d.amount = centsToInput(typed < 0 ? -conv : conv);
        const fc = ic !== S.user.currency ? ic : acc.currency;
        const note = `Capturado como ${money(Math.abs(typed), ic, { mask: false })} (1 ${fc} = ${fxToMain(fc).toFixed(2)} ${S.user.currency})`;
        if ("notes" in d) d.notes = d.notes ? d.notes + " · " + note : note;
      }
      if (ib && acc && acc.type === "credit" && st.type === "expense") d.installments = d.inst_kind ? { kind: d.inst_kind, months: d.inst_months, monthly_amount: d.inst_monthly } : null;
      ["inst_kind", "inst_months", "inst_monthly", "repeat_monthly"].forEach((k) => delete d[k]);
      if (existing && existing.recurring) d.recurring = true;
      if (repeat) d.recurring = true;
      const path = existing ? "/api/transactions/" + existing.id : "/api/transactions";
      const saved = await api(existing ? "PUT" : "POST", path, d);
      if (repeat && !existing) {
        // el siguiente cargo: mismo día del mes, el primero que caiga después de hoy (no se inventan cargos pasados)
        const [yy, mm, dd] = d.date.split("-").map(Number); let y = yy, m = mm;
        const on = () => { const last = new Date(y, m, 0).getDate(); return `${y}-${pad(m)}-${pad(Math.min(dd, last))}`; };
        do { m += 1; if (m > 12) { m = 1; y += 1; } } while (on() <= todayStr());
        try { await api("POST", "/api/recurring", { description: d.description || "Cargo recurrente", amount: d.amount, account_id: d.account_id, category_id: d.category_id, frequency: "monthly", next_date: on() }); }
        catch (e) { toast("El movimiento se guardó, pero no se pudo programar la repetición: " + e.message, "error"); }
      }
      if (preset.receipt_id && !existing) { try { await api("POST", `/api/receipts/${preset.receipt_id}/link`, { tx_id: saved.transaction.id }); } catch { /* el movimiento ya se guardó */ } }
      store.set("lastAccount", +d.account_id);
      modal.close(); await refreshCore(); toast(existing ? "Movimiento actualizado." : "Movimiento guardado."); route(); }); };
    const amt = form.elements.amount; if (amt && !existing) amt.focus();
  };
  const modal = openModal(existing ? "Editar movimiento" : "Nuevo movimiento", `<div id="tx-body"></div>`);
  const body = $("#tx-body", modal.el);
  draw(existing ? {
    amount: centsToInput(existing.amount), date: existing.date, account_id: existing.account_id, to_account_id: existing.to_account_id,
    to_amount: existing.to_amount != null ? centsToInput(existing.to_amount) : "", category_id: existing.category_id ?? "", description: existing.description,
    payment_method: existing.payment_method, tags: existing.tags, notes: existing.notes, recurring: existing.recurring,
    inst_kind: existing.plan_kind === "diferido" ? "mci" : existing.plan_kind || "", inst_months: existing.plan_months || "", inst_monthly: existing.plan_monthly && existing.plan_kind !== "msi" ? centsToInput(existing.plan_monthly) : "" } : { ...preset });
}

function categoryModal(kind, done, parents = true) {
  const roots = S.categories.filter((c) => c.kind === kind && !c.parent_id && !c.archived);
  const m = openModal("Nueva categoría", `<form id="c-f" novalidate>
    <div class="seg"><button type="button" data-k="expense" class="${kind === "expense" ? "on" : ""}">Gasto</button><button type="button" data-k="income" class="${kind === "income" ? "on" : ""}">Ingreso</button></div>
    ${field("Nombre", "name", 'maxlength="60" required')}
    <div class="field"><label for="f-parent_id">Subcategoría de (opcional)</label><select id="f-parent_id" name="parent_id"></select></div>
    <footer><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" type="submit">Crear categoría</button></footer></form>`, {
    onMount: (el) => {
      const fill = () => { const rs = S.categories.filter((c) => c.kind === kind && !c.parent_id && !c.archived); $("#f-parent_id", el).innerHTML = `<option value="">Ninguna (categoría principal)</option>` + rs.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join(""); };
      fill();
      $$(".seg button", el).forEach((b) => b.onclick = () => { kind = b.dataset.k; $$(".seg button", el).forEach((x) => x.classList.toggle("on", x === b)); fill(); });
      $("#c-f", el).onsubmit = (e) => { e.preventDefault(); submitForm(e.target, async () => {
        const d = formData(e.target); const r = await api("POST", "/api/categories", { name: d.name, kind, parent_id: d.parent_id || null });
        await refreshCore(); m.close(); toast("Categoría creada."); done && done(r.category.id); }); };
    } });
}

/* =================================================================== CUENTAS */
function accountModal(acc = null, preset = {}) {
  const m = openModal(acc ? "Editar cuenta" : "Nueva cuenta", `<form id="a-f" novalidate>
    ${field("Nombre", "name", 'maxlength="80" required placeholder="Nómina BBVA, Efectivo…"', acc?.name ?? "")}
    ${field("Institución financiera", "institution", 'maxlength="80"', acc?.institution ?? "")}
    <div class="row2"><div class="field"><label for="f-type">Tipo</label><select id="f-type" name="type">${Object.entries(ACC_TYPES).map(([k, v]) => `<option value="${k}" ${(acc?.type ?? preset.type ?? "bank") === k ? "selected" : ""}>${v}</option>`).join("")}</select><small class="muted" id="type-hint"></small></div>
      <div class="field"><label for="f-currency">Moneda</label><select id="f-currency" name="currency">${S.currencies.map((c) => `<option ${(acc?.currency ?? cur()) === c ? "selected" : ""}>${c}</option>`).join("")}</select></div></div>
    <div class="row2"><div id="ob-box">${acc ? "" : signedField("Saldo inicial", "opening_balance", 'inputmode="decimal" placeholder="0.00"', "")}</div>
      ${field("Fecha de apertura", "opened_on", 'type="date" required', acc?.opened_on ?? todayStr())}</div>
    <div id="credit-box" class="hidden"><div class="row2">${field("Límite de crédito", "credit_limit", 'inputmode="decimal" placeholder="0.00"', acc && acc.credit_limit ? centsToInput(acc.credit_limit) : "")}
      ${field("Día de corte", "cut_day", 'inputmode="numeric" placeholder="1-31"', acc?.cut_day || "")}</div>${field("Día límite de pago", "due_day", 'inputmode="numeric" placeholder="1-31"', acc?.due_day || "")}
      ${acc ? `<p class="muted small">Las compras a meses de esta tarjeta se ven y se agregan en <a href="#/cards">Tarjetas</a>.</p>` : `<section class="debt-box">
        <h3>¿Cuánto debes hoy en esta tarjeta?</h3>
        <p class="muted small">En positivo, como en tu estado de cuenta.</p>
        ${field("Saldo sin meses (compras normales del periodo)", "owed_now", 'inputmode="decimal" placeholder="0.00"', "")}
        <div id="plans-list"></div>
        <button type="button" class="btn sm" id="add-plan">${icon("plus")} Agregar compra a meses o saldo diferido</button>
        <div class="debt-total" id="debt-total"></div></section>`}</div>
    ${field("Avisar si el saldo baja de", "low_balance_alert", 'inputmode="decimal" placeholder="0 = sin aviso"', acc && acc.low_balance_alert ? centsToInput(acc.low_balance_alert) : "")}
    ${acc ? `<p class="muted small">Para corregir el saldo usa «Ajustar saldo».</p>` : ""}
    <footer><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" type="submit">${acc ? "Guardar" : "Crear cuenta"}</button></footer></form>`, {
    onMount: (el) => { const ty = $("#f-type", el), cb = $("#credit-box", el), ob = $("#ob-box", el), lb = $("#f-low_balance_alert", el).closest(".field");
      const hint = $("#type-hint", el), HINT = { savings: "Lo que le transfieras cuenta como tu Ahorro del mes en Inicio.", investment: "Lo que le transfieras cuenta como tu Inversión del mes en Inicio." };
      const sync = () => { const cr = ty.value === "credit"; cb.classList.toggle("hidden", !cr); lb.classList.toggle("hidden", cr); ob.classList.toggle("hidden", cr); hint.textContent = HINT[ty.value] || ""; }; ty.onchange = sync; sync();
      const plans = [];                      // planes a meses que ya traes (solo al dar de alta una tarjeta)
      const list = $("#plans-list", el);
      const readPlans = () => $$("[data-plan]", el).forEach((row) => { const i = +row.dataset.plan; $$("[data-k]", row).forEach((x) => { plans[i][x.dataset.k] = x.value; }); });
      const total = () => {
        if (!$("#debt-total", el)) return;
        readPlans();
        const owed = inputCents($("#f-owed_now", el).value);
        const inPlans = plans.reduce((s, p) => s + (p.kind !== "msi" && p.principal_remaining ? inputCents(p.principal_remaining) : inputCents(p.monthly_amount) * (+p.months_remaining || 0)), 0);
        $("#debt-total", el).innerHTML = `Deuda total: <b>${esc(money(owed + inPlans, $("#f-currency", el).value, { mask: false }))}</b>${inPlans ? ` <span class="muted">· a meses ${esc(money(inPlans, $("#f-currency", el).value, { mask: false }))}</span>` : ""}`;
      };
      const drawPlans = () => {
        if (!list) return;
        list.innerHTML = plans.map((p, i) => `<div class="plan-edit" data-plan="${i}">
          <div class="plan-edit-head"><select data-k="kind" name="plans.${i}.kind" aria-label="Tipo">${Object.entries(PLAN_KINDS).map(([k, l]) => `<option value="${k}" ${p.kind === k ? "selected" : ""}>${l}</option>`).join("")}</select>
            <button type="button" class="icon-btn" data-rm-plan="${i}" aria-label="Quitar">${icon("x")}</button></div>
          <div class="field"><input data-k="description" name="plans.${i}.description" maxlength="80" placeholder="¿Qué compraste? (opcional)" value="${esc(p.description || "")}" aria-label="Descripción"></div>
          <div class="row3"><div class="field"><label>Mensualidad</label><input data-k="monthly_amount" name="plans.${i}.monthly_amount" inputmode="decimal" placeholder="0.00" value="${esc(p.monthly_amount || "")}"></div>
            <div class="field"><label>Meses que faltan</label><input data-k="months_remaining" name="plans.${i}.months_remaining" inputmode="numeric" placeholder="4" value="${esc(p.months_remaining || "")}"></div>
            <div class="field"><label>De cuántos</label><input data-k="months_total" name="plans.${i}.months_total" inputmode="numeric" placeholder="12" value="${esc(p.months_total || "")}"></div></div>
          ${p.kind !== "msi" ? `<div class="row2"><div class="field"><label>Saldo pendiente del plan</label><input data-k="principal_remaining" name="plans.${i}.principal_remaining" inputmode="decimal" placeholder="Opcional" value="${esc(p.principal_remaining || "")}"></div>
            <div class="field"><label>Tasa anual %</label><input data-k="interest_rate" name="plans.${i}.interest_rate" inputmode="decimal" placeholder="Opcional" value="${esc(p.interest_rate || "")}"></div></div>
            <p class="muted small">Viene en tu estado de cuenta. Si no lo tienes, déjalo vacío.</p>` : ""}</div>`).join("");
        $$("[data-k='kind']", list).forEach((x) => x.onchange = () => { readPlans(); drawPlans(); });
        $$("[data-rm-plan]", list).forEach((b) => b.onclick = () => { readPlans(); plans.splice(+b.dataset.rmPlan, 1); drawPlans(); });
        total();
      };
      const ap = $("#add-plan", el); if (ap) ap.onclick = () => { readPlans(); plans.push({ kind: "msi" }); drawPlans(); const last = $$("[data-plan]", el).pop(); if (last) $("[data-k='monthly_amount']", last).focus(); };
      el.addEventListener("input", total); if ($("#f-currency", el)) $("#f-currency", el).addEventListener("change", total); total();
      $("#a-f", el).onsubmit = (e) => { e.preventDefault(); submitForm(e.target, async () => {
      const d = formData(e.target);
      Object.keys(d).filter((k) => k.startsWith("plans.")).forEach((k) => delete d[k]);
      if (!acc && d.type === "credit") { readPlans(); d.plans = plans.map((p) => ({ ...p })); delete d.opening_balance; d.owed_now = d.owed_now || "0"; }
      const r = acc ? await api("PATCH", "/api/accounts/" + acc.id, d) : await api("POST", "/api/accounts", d);
      m.close(); await refreshCore(); toast(acc ? "Cuenta actualizada." : "Cuenta creada."); if (!acc) go("#/accounts/" + r.account.id); else route(); }); }; } });
}

/* cuentas de inversión: el total es efectivo + acciones ligadas (mismo dinero que ves en Portafolio, sin duplicar) */
const accTotal = (a) => (a.total_value != null ? a.total_value : a.balance);
function accSub(a) {
  const parts = [];
  if (a.holdings_positions) parts.push(`Efectivo ${esc(money(a.balance, a.currency))} · Acciones ${esc(money(a.holdings_value, a.currency))}`);
  if (a.currency !== cur()) parts.push(a.total_value_main != null ? `≈ ${esc(money(a.total_value_main, cur()))}` : a.currency);
  else if (!a.holdings_positions) parts.push(a.currency);
  return parts.join(" · ");
}
function accountsView() {
  const view = mountShell("accounts", "Cuentas", `<button class="btn" id="acc-new">${icon("plus")} Nueva cuenta</button>`);
  $("#acc-new").onclick = () => accountModal();
  withRetry(view, async () => {
    await refreshCore();
    const act = S.accounts.filter((a) => !a.archived), arch = S.accounts.filter((a) => a.archived);
    const card = (a) => `<article class="card acc ${a.archived ? "archived" : ""}" tabindex="0" role="link" data-acc="${a.id}">
      <div class="muted small">${esc(ACC_TYPES[a.type])}${a.institution ? " · " + esc(a.institution) : ""}${a.is_demo ? ' <span class="badge demo">DEMO</span>' : ""}</div>
      <h3 style="margin-top:.2rem">${esc(a.name)}</h3><div class="bal ${accTotal(a) < 0 ? "neg" : ""}">${esc(money(accTotal(a), a.currency))}</div>
      <div class="muted small">${accSub(a)}${a.archived ? " · archivada" : ""}</div></article>`;
    const totals = {}; let mainAll = 0, allConv = true;
    act.filter((a) => a.type !== "credit").forEach((a) => { totals[a.currency] = (totals[a.currency] || 0) + accTotal(a); if (a.total_value_main == null) allConv = false; else mainAll += a.total_value_main; });
    view.innerHTML = act.length || arch.length ? `
      ${Object.keys(totals).length ? `<p class="muted">Total activo: ${Object.entries(totals).map(([c, v]) => `<b>${esc(money(v, c))}</b>`).join(" · ")}${Object.keys(totals).length > 1 && allConv ? ` · en total ≈ <b>${esc(money(mainAll, cur()))}</b>` : ""}</p>` : ""}
      <div class="grid acc-grid">${act.map(card).join("")}</div>
      ${arch.length ? `<h2 style="margin:1.6rem 0 .8rem">Archivadas</h2><div class="grid acc-grid">${arch.map(card).join("")}</div>` : ""}`
      : `<div class="card empty"><p>Aún no tienes cuentas.</p><button class="btn primary" id="e-new">${icon("plus")} Crear mi primera cuenta</button></div>`;
    const en = $("#e-new", view); if (en) en.onclick = () => accountModal();
    $$("[data-acc]", view).forEach((el) => { const open = () => go("#/accounts/" + el.dataset.acc); el.onclick = open; el.onkeydown = (e) => { if (e.key === "Enter") open(); }; });
  });
}

function accountDetailView(id) {
  const view = mountShell("accounts", "Cuenta");
  withRetry(view, async () => {
    const h = await api("GET", "/api/accounts/" + id);
    const a = h.account;
    $(".topbar h1").innerHTML = `<button class="icon-btn" id="back" aria-label="Volver">${icon("back")}</button> ${esc(a.name)}`;
    $("#back").onclick = () => go("#/accounts");
    view.innerHTML = `<div class="card" style="margin-bottom:1rem"><div class="muted small">${esc(ACC_TYPES[a.type])}${a.institution ? " · " + esc(a.institution) : ""} · ${a.currency}</div>
      <div class="v ${accTotal(a) < 0 ? "neg" : ""}" style="font-size:2rem;font-weight:500;margin:.3rem 0">${esc(money(accTotal(a), a.currency))}</div>
      ${a.holdings_positions || (a.currency !== cur() && a.total_value_main != null) ? `<div class="small" style="margin-bottom:.2rem">${accSub(a)}${a.holdings_positions ? ` · <a href="#/portfolio">ver acciones</a>` : ""}</div>` : ""}
      <div class="muted small">Saldo inicial ${esc(money(a.opening_balance, a.currency))} · abierta el ${esc(fmtDate(a.opened_on))}${a.archived ? " · <b>archivada</b>" : ""}</div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:1rem">
        ${a.archived ? "" : `<button class="btn primary sm" id="a-tx">${icon("plus")} Movimiento</button>`}
        <button class="btn sm" id="a-edit">${icon("edit")} Editar</button>
        <button class="btn sm" id="a-adj">Ajustar saldo</button>
        ${a.archived ? "" : `<button class="btn sm" id="a-imp">${icon("upload")} Importar estado de cuenta</button>`}
        <button class="btn sm" id="a-arch">${icon("archive")} ${a.archived ? "Restaurar" : "Archivar"}</button>
        <button class="btn sm danger" id="a-del">${icon("trash")} Eliminar</button></div></div>
      <section class="card" style="margin-bottom:1rem"><h2>Evolución del saldo</h2>${lineChart(h.series, a.currency)}</section>
      <section class="card"><h2>Movimientos de esta cuenta</h2>${h.transactions.length ? h.transactions.map((t) => `<div class="tx-row" style="grid-template-columns:70px minmax(0,1fr) auto" role="button" tabindex="0" ${t.debt_id ? `data-debt="${t.debt_id}"` : t.op ? `data-sym="${esc(t.symbol)}"` : `data-tx="${t.id}"`}>
        <span class="small">${esc(fmtDate(t.date, { day: "2-digit", month: "short" }))}</span>
        <span class="desc"><b>${esc(t.description || TYPE_LABEL[t.type])}</b><span class="muted small">${TYPE_LABEL[t.type]}${t.type === "transfer" ? (t.account_id === a.id ? " → " + esc(t.to_account_name) : " ← " + esc(t.account_name)) : t.category_name ? " · " + esc(t.category_name) : ""}</span></span>
        <span class="amt ${t.effect >= 0 ? "pos" : "neg"}">${esc(money(t.effect, a.currency, { sign: true }))}</span></div>`).join("") : `<div class="empty">Esta cuenta aún no tiene movimientos.</div>`}</section>`;
    bindTxRows(view);
    $$("[data-sym]", view).forEach((r) => { const open = () => go("#/portfolio/" + encodeURIComponent(r.dataset.sym)); r.onclick = open; r.onkeydown = (e) => { if (e.key === "Enter") open(); }; });
    $$("[data-debt]", view).forEach((r) => { const open = () => go("#/debts/" + r.dataset.debt); r.onclick = open; r.onkeydown = (e) => { if (e.key === "Enter") open(); }; });
    const t = $("#a-tx", view); if (t) t.onclick = () => txModal(null, { account_id: a.id });
    $("#a-edit").onclick = () => accountModal(a);
    const ai = $("#a-imp", view); if (ai) ai.onclick = () => importModal(a.id);
    $("#a-adj").onclick = () => {
      const m = openModal("Ajustar saldo", `<form id="adj-f" novalidate><p class="muted small">Escribe el saldo real de hoy. La diferencia se registra como ajuste.</p>
        ${a.type === "credit" ? signedField("Lo que debes hoy", "owe", 'inputmode="decimal" required', centsToInput(Math.max(0, -a.balance)), '<span class="muted small">En positivo. Saldo a favor: usa ±.</span>')
          : signedField("Saldo real actual", "new_balance", 'inputmode="decimal" required', centsToInput(a.balance), '<span class="muted small">Si está en números rojos, toca ± para ponerlo en negativo.</span>')}${field("Fecha", "date", 'type="date"', todayStr())}${field("Nota", "note", 'maxlength="500" placeholder="Motivo del ajuste"')}
        <footer><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" type="submit">Registrar ajuste</button></footer></form>`, {
        onMount: (el) => { $("#adj-f", el).onsubmit = (e) => { e.preventDefault(); submitForm(e.target, async () => { const d = formData(e.target);
          if (a.type === "credit") { const v = String(d.owe || "").trim(); d.new_balance = /^[-−]/.test(v) ? v.replace(/^[-−]\s*/, "") : "-" + v; delete d.owe; }
          await api("POST", `/api/accounts/${a.id}/adjust`, d); m.close(); await refreshCore(); toast("Ajuste registrado."); route(); }); }; } });
    };
    $("#a-arch").onclick = async () => {
      if (!a.archived && a.balance !== 0 && !(await confirmDialog("¿Archivar cuenta?", `La cuenta aún tiene un saldo de ${money(a.balance, a.currency, { mask: false })}. Seguirá en tu historial pero no aparecerá al registrar movimientos ni en los totales.`, "Archivar"))) return;
      try { await api("PATCH", "/api/accounts/" + a.id, { archived: !a.archived }); await refreshCore(); toast(a.archived ? "Cuenta restaurada." : "Cuenta archivada."); route(); } catch (e) { toast(e.message, "error"); }
    };
    $("#a-del").onclick = async () => {
      if (!(await confirmDialog("¿Eliminar cuenta?", "Solo se pueden eliminar cuentas sin movimientos. Esta acción no se puede deshacer."))) return;
      try { await api("DELETE", "/api/accounts/" + a.id); await refreshCore(); toast("Cuenta eliminada."); go("#/accounts"); } catch (e) { toast(e.message, "error"); }
    };
  });
}

/* =================================================================== CONFIGURACIÓN */
let settingsTab = "perfil";
function settingsView() {
  const view = mountShell("settings", "Configuración");
  const tabs = [["perfil", "Perfil"], ["categorias", "Categorías"], ["seguridad", "Seguridad"], ["datos", "Datos"]];
  const draw = async () => {
    view.innerHTML = `<div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" class="${settingsTab === k ? "on" : ""}" data-tab="${k}">${l}</button>`).join("")}</div><div id="tab"></div>`;
    $$("[data-tab]", view).forEach((b) => b.onclick = () => { settingsTab = b.dataset.tab; draw(); });
    const tab = $("#tab", view);
    if (settingsTab === "perfil") {
      tab.innerHTML = `<form class="card" id="p-f" style="max-width:520px" novalidate>${field("Nombre", "name", 'required maxlength="80"', S.user.name)}
        <div class="field"><label>Correo electrónico</label><input value="${esc(S.user.email)}" disabled></div>
        <div class="field"><label for="f-currency">Moneda principal</label><select id="f-currency" name="currency">${S.currencies.map((c) => `<option ${S.user.currency === c ? "selected" : ""}>${c}</option>`).join("")}</select>
          <span class="muted small">Los totales del inicio suman solo las cuentas en esta moneda.</span></div>
        <div class="field"><label for="f-timezone">Zona horaria</label><input id="f-timezone" name="timezone" list="tzs" value="${esc(S.user.timezone)}"><datalist id="tzs">${S.timezones.map((z) => `<option value="${esc(z)}">`).join("")}</datalist></div>
        <div class="field"><label for="f-theme">Tema</label><select id="f-theme" name="theme"><option value="light" ${!isDark() ? "selected" : ""}>Claro</option><option value="dark" ${isDark() ? "selected" : ""}>Oscuro</option></select></div>
        <button class="btn primary" type="submit">Guardar cambios</button></form>
        <section class="card icon-pick" style="max-width:520px;margin-top:1rem"><h2>Ícono de la app</h2>
          <div class="icon-opts">${[["", "Automático", "Según el modo claro u oscuro al agregarla"], ["light", "Día", "Blanco y verde"], ["dark", "Noche", "Verde y negro"]].map(([k, l, d]) =>
            `<button type="button" class="icon-opt ${store.get("icon", "") === k ? "on" : ""}" data-icon="${k}">${k ? `<img src="${k === "dark" ? "/static/icons/apple-touch-icon-dark.png?v=4" : "/static/icons/apple-touch-icon.png?v=4"}" alt="">` : `<span class="icon-duo"><img src="/static/icons/apple-touch-icon.png?v=4" alt=""><img src="/static/icons/apple-touch-icon-dark.png?v=4" alt=""></span>`}<b>${l}</b><span class="muted small">${d}</span></button>`).join("")}</div>
          <p class="muted small" style="margin:.7rem 0 0">El iPhone guarda el ícono cuando agregas FIPO a tu pantalla de inicio y no lo cambia solo. Para ver el nuevo: mantén presionado el ícono → «Eliminar app» (no borra tus datos) y vuelve a agregarla desde Safari (Compartir → «Agregar a inicio»).</p></section>`;
      $$("[data-icon]", tab).forEach((b) => b.onclick = () => { store.set("icon", b.dataset.icon); if (window.fipoSetIcon) window.fipoSetIcon(); $$("[data-icon]", tab).forEach((x) => x.classList.toggle("on", x === b)); toast("Ícono elegido. Vuelve a agregar FIPO a tu pantalla de inicio para verlo."); });
      $("#p-f").onsubmit = (e) => { e.preventDefault(); submitForm(e.target, async () => { const r = await api("PATCH", "/api/me", formData(e.target)); S.user = r.user; applyTheme(); toast("Perfil actualizado."); route(); }); };
    } else if (settingsTab === "categorias") {
      await refreshCore();
      const list = (kind, title) => {
        const cs = S.categories.filter((c) => c.kind === kind);
        const roots = cs.filter((c) => !c.parent_id || !cs.find((p) => p.id === c.parent_id));
        const row = (c, sub) => `<div class="list-row" style="${sub ? "padding-left:1.4rem" : ""}"><span class="grow ${c.archived ? "muted" : ""}">${sub ? "› " : ""}${esc(c.name)}${c.is_demo ? ' <span class="badge demo">DEMO</span>' : ""}${c.archived ? " (archivada)" : ""}<span class="muted small"> · ${c.uses} mov.</span></span>
          <button class="btn sm ghost" data-ren="${c.id}" aria-label="Renombrar">${icon("edit")}</button><button class="btn sm ghost" data-arc="${c.id}" aria-label="${c.archived ? "Restaurar" : "Archivar"}">${icon("archive")}</button>
          <button class="btn sm ghost danger" data-del="${c.id}" aria-label="Eliminar">${icon("trash")}</button></div>`;
        return `<section class="card"><h2>${title}<button class="btn sm" data-new="${kind}">${icon("plus")} Nueva</button></h2>${roots.map((p) => row(p, false) + cs.filter((c) => c.parent_id === p.id).map((c) => row(c, true)).join("")).join("") || '<div class="empty">Sin categorías.</div>'}</section>`;
      };
      tab.innerHTML = `<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))">${list("expense", "Categorías de gasto")}${list("income", "Categorías de ingreso")}</div>`;
      $$("[data-new]", tab).forEach((b) => b.onclick = () => categoryModal(b.dataset.new, draw));
      $$("[data-ren]", tab).forEach((b) => b.onclick = () => { const c = S.categories.find((x) => x.id === +b.dataset.ren);
        const m = openModal("Renombrar categoría", `<form id="rn" novalidate>${field("Nombre", "name", 'maxlength="60" required', c.name)}<footer><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" type="submit">Guardar</button></footer></form>`, {
          onMount: (el) => { $("#rn", el).onsubmit = (e) => { e.preventDefault(); submitForm(e.target, async () => { await api("PATCH", "/api/categories/" + c.id, { name: formData(e.target).name }); m.close(); await draw(); toast("Categoría renombrada."); }); }; } }); });
      $$("[data-arc]", tab).forEach((b) => b.onclick = async () => { const c = S.categories.find((x) => x.id === +b.dataset.arc); try { await api("PATCH", "/api/categories/" + c.id, { archived: !c.archived }); await draw(); } catch (e) { toast(e.message, "error"); } });
      $$("[data-del]", tab).forEach((b) => b.onclick = async () => { const c = S.categories.find((x) => x.id === +b.dataset.del);
        if (!(await confirmDialog("¿Eliminar categoría?", c.uses ? "Esta categoría tiene movimientos; el servidor no permitirá eliminarla, pero puedes archivarla." : `Se eliminará «${c.name}».`))) return;
        try { await api("DELETE", "/api/categories/" + c.id); await draw(); toast("Categoría eliminada."); } catch (e) { toast(e.message, "error"); } });
    } else if (settingsTab === "seguridad") {
      tab.innerHTML = `<form class="card" id="pw-f" style="max-width:520px" novalidate><h2>Cambiar contraseña</h2>
        ${field("Contraseña actual", "current", 'type="password" autocomplete="current-password" required')}${field("Nueva contraseña", "password", 'type="password" autocomplete="new-password" minlength="8" required')}
        <p class="muted small">Al cambiarla se cerrarán tus sesiones abiertas en otros dispositivos.</p><button class="btn primary" type="submit">Actualizar contraseña</button></form>`;
      $("#pw-f").onsubmit = (e) => { e.preventDefault(); submitForm(e.target, async () => { await api("POST", "/api/me/password", formData(e.target)); e.target.reset(); toast("Contraseña actualizada."); }); };
    } else {
      const hasDemo = S.accounts.some((a) => a.is_demo) || S.categories.some((c) => c.is_demo);
      await refreshCore();
      tab.innerHTML = `<div class="grid" style="max-width:640px">
        <section class="card"><h2>Cargar mis datos</h2><p class="muted">Da de alta de una vez tus cuentas, tarjetas (con sus compras a meses) e inversiones desde un archivo de carga de FIPO (.json). Antes de guardar verás exactamente cómo quedará todo.</p>
          <label class="btn primary" style="cursor:pointer">${icon("upload")} Elegir archivo…<input type="file" id="restore-file" accept=".json,application/json" hidden></label></section>
        <section class="card"><h2>Exportar mis datos</h2><p class="muted">Descarga todas tus cuentas, categorías y movimientos.</p>
          <button class="btn" data-dl="/api/export.json">${icon("download")} Todo en JSON</button> <button class="btn" data-dl="/api/transactions.csv">${icon("download")} Movimientos en CSV</button></section>
        <section class="card"><h2>Importar estado de cuenta</h2><p class="muted">Sube el CSV, Excel o PDF de tu banco y vuelca sus movimientos a una cuenta, con revisión previa.</p><button class="btn primary" id="imp-open">${icon("upload")} Importar archivo…</button><div id="imp-hist"></div></section>
        <section class="card"><h2>Datos de demostración</h2><p class="muted">Cuentas, categorías y movimientos de ejemplo, marcados como <b>[DEMO]</b> y separados de tu información. Al borrarlos no se toca nada de lo tuyo.</p>
          ${S.accounts.some((a) => a.is_demo) ? `<button class="btn danger" id="demo-del">Eliminar datos de demostración</button>` : `<button class="btn" id="demo-load">Cargar datos de demostración</button>`}</section>
        <section class="card"><h2>Eliminar mi cuenta</h2><p class="muted">Borra tu perfil y todos tus datos de forma permanente.</p><button class="btn danger" id="acc-del">Eliminar mi cuenta…</button></section></div>`;
      $("#imp-open", tab).onclick = () => importModal();
      $("#restore-file", tab).onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) restoreModal(f); };
      importsHistory($("#imp-hist", tab), draw).catch(() => {});
      $$("[data-dl]", tab).forEach((b) => b.onclick = () => downloadFile(b.dataset.dl));
      const dl = $("#demo-load", tab); if (dl) dl.onclick = async () => { await loadDemo(); };
      const dd = $("#demo-del", tab); if (dd) dd.onclick = async () => { if (!(await confirmDialog("¿Eliminar datos de demostración?", "Solo se borran los elementos marcados como DEMO.", "Eliminar"))) return;
        try { await api("DELETE", "/api/demo"); await refreshCore(); toast("Datos de demostración eliminados."); draw(); } catch (e) { toast(e.message, "error"); } };
      $("#acc-del", tab).onclick = () => { const m = openModal("Eliminar mi cuenta", `<form id="dm" novalidate><p>Esta acción es permanente. Confirma con tu contraseña.</p>${field("Contraseña", "password", 'type="password" required autocomplete="current-password"')}
        <footer><button type="button" class="btn" data-close>Cancelar</button><button class="btn danger" type="submit">Eliminar todo</button></footer></form>`, {
        onMount: (el) => { $("#dm", el).onsubmit = (e) => { e.preventDefault(); submitForm(e.target, async () => { await api("DELETE", "/api/me", formData(e.target)); m.close(); S.user = null; applyTheme(); toast("Tu cuenta fue eliminada."); go("#/register"); }); }; } }); };
    }
  };
  draw();
}

/* «Cargar mis datos»: primero una prueba sin guardar (el servidor calcula todo y lo deshace), luego confirmar */
async function restoreModal(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast("Ese archivo no es un archivo de carga de FIPO (.json).", "error"); }
  let r;
  try { r = await api("POST", "/api/restore", { data, dry_run: true }); } catch (e) { return toast(e.message, "error"); }
  const m = (v, c) => esc(money(v, c, { mask: false }));
  const T = { bank: "Cuenta bancaria", digital: "Cuenta digital", cash: "Efectivo", savings: "Ahorro", investment: "Inversión", other: "Otra", credit: "Tarjeta de crédito" };
  const cardsH = r.accounts.filter((a) => a.type === "credit"), inv = r.accounts.filter((a) => a.type === "investment"), rest = r.accounts.filter((a) => a.type !== "credit" && a.type !== "investment");
  const body = `<p class="muted small">Así quedará. Todavía no se ha guardado nada.</p>
    <h3 class="rs-h">Cuentas</h3><div class="sum-list rs">${rest.map((a) => `<div><span>${esc(a.name)} <small class="muted">· ${T[a.type] || a.type}</small></span><b>${m(a.balance, a.currency)}</b></div>`).join("")}</div>
    ${inv.length ? `<h3 class="rs-h">Inversiones</h3><div class="sum-list rs">${inv.map((a) => `<div><span>${esc(a.name)}${a.positions ? ` <small class="muted">· efectivo ${m(a.balance, a.currency)} + ${a.positions} acciones ${m(a.holdings_value, a.currency)}</small>` : ""}</span><b>${m(a.balance + (a.holdings_value || 0), a.currency)}</b></div>`).join("")}</div>` : ""}
    ${cardsH.length ? `<h3 class="rs-h">Tarjetas de crédito</h3>${cardsH.map((a) => `<div class="rs-card"><div class="sum-list rs">
      <div><span><b>${esc(a.name)}</b></span><b class="neg">${m(a.debt, a.currency)}</b></div>
      <div><span>Pago del mes${a.due ? " · vence " + esc(fmtDate(a.due, { day: "numeric", month: "short" })) : ""}</span><b>${m(a.to_pay || 0, a.currency)}</b></div>
      <div><span>A meses (aún no se cobra)</span><b>${m(a.deferred, a.currency)}</b></div>
      <div><span>Disponible de ${m(a.limit, a.currency)}</span><b>${m(a.available, a.currency)}</b></div>
      ${a.plans.map((p) => `<div><span>· ${esc(p.description)}: ${p.left} × ${m(p.monthly, a.currency)}</span><small class="muted">próximo ${esc(fmtDate(p.next, { day: "numeric", month: "short", year: "2-digit" }))}</small></div>`).join("")}</div></div>`).join("")}` : ""}
    ${r.warnings.length ? `<div class="note" style="margin-top:.8rem">${r.warnings.map(esc).join("<br>")}</div>` : ""}
    <footer><button type="button" class="btn" data-close>Cancelar</button><button type="button" class="btn primary" id="rs-ok">Confirmar y guardar</button></footer>`;
  const md = openModal("Cargar mis datos", body, { wide: true, onMount: (el) => {
    $("#rs-ok", el).onclick = async (e) => {
      e.target.disabled = true;
      try { await api("POST", "/api/restore", { data, dry_run: false }); md.close(); await refreshCore(); toast("¡Listo! Tus datos quedaron cargados."); go("#/dashboard"); }
      catch (er) { e.target.disabled = false; toast(er.message, "error"); }
    }; } });
}

/* =================================================================== ROUTER */
let navCount = 0, navBase = 0;  // cambios reales de pantalla (hashchange); el botón «atrás» sale cuando navCount > navBase
function route() {
  $$(".overlay").forEach((o) => o.remove());
  const [, page, arg] = (location.hash || "").split("/");
  const authPages = ["login", "register", "forgot", "reset"];
  if (!S.user) {
    if (page === "register") return registerView();
    if (page === "forgot") return forgotView();
    if (page === "reset" && arg) return resetView(arg);
    return loginView();
  }
  if (!S.user.onboarded) return onboardingView();
  if (!page || authPages.includes(page) || page === "onboarding") return go("#/dashboard");
  if (page === "dashboard") return dashboardView();
  if (page === "movements") return movementsView();
  if (page === "accounts") return arg ? accountDetailView(+arg) : accountsView();
  if (page === "portfolio") return portfolioView(arg);
  if (page === "widgets") return widgetsView();
  if (page === "new") { history.replaceState(null, "", "#/movements"); movementsView(); return txModal(); }   // enlace directo (widget del iPhone): abre «Nuevo movimiento»
  if (page === "more") return moreView();
  if (page === "cards") return cardsView();
  if (page === "recurring") return recurringView();
  if (page === "debts") return debtsView(arg ? +arg : null);
  if (page === "budgets") return budgetsView();
  if (page === "analysis") return analysisView();
  if (page === "reports") return reportsView();
  if (page === "goals") return goalsView(arg ? +arg : null);
  if (page === "tables") return tablesView(arg ? +arg : null);
  if (page === "receipts") return receiptsView();
  if (page === "settings") return settingsView();
  return go("#/dashboard");
}

onUnauthorized = () => { if (S.user) { S.user = null; toast("Tu sesión expiró. Inicia sesión de nuevo.", "error"); go("#/login"); } };
window.addEventListener("hashchange", () => { navCount++; route(); window.scrollTo(0, 0); });  // cada pantalla nueva empieza arriba

/* Compu ↔ celular: si editaste algo en el otro dispositivo y vuelves a esta pestaña, se recargan los datos
   (salvo que tengas un formulario abierto o estés escribiendo, para no borrarte nada). */
let hiddenAt = 0;
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
  if (!S.user || !S.user.onboarded || !hiddenAt || Date.now() - hiddenAt < 15000) return;
  const a = document.activeElement;
  if ($(".overlay") || (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
  try { await refreshCore(); } catch { return; }
  route();
});
/* Pantalla de carga: se quita cuando la primera pantalla ya tiene sus datos (no por tiempo fijo).
   Mínimo ~700 ms desde que se abrió la app para que no parpadee; máximo 6 s por si algo tarda de más. */
(function splashController() {
  const el = document.getElementById("splash"); if (!el) return;
  const MIN = 700, MAX = 6000; let done = false;
  const hide = () => {
    if (done) return; done = true; mo.disconnect();
    setTimeout(() => {
      el.classList.add("out");
      setTimeout(() => el.remove(), 420);
    }, Math.max(0, MIN - performance.now()));
  };
  const ready = () => {
    const app = document.getElementById("app"); if (!app || !app.firstElementChild) return false;
    const view = document.getElementById("view");
    return !view || !view.querySelector(":scope > .spinner");          // Inicio (o la pantalla abierta) ya pintó sus datos
  };
  const mo = new MutationObserver(() => { if (ready()) hide(); });
  mo.observe(document.getElementById("app"), { childList: true, subtree: true });
  setTimeout(hide, MAX);
})();

(async function boot() {
  applyTheme();
  try {
    const me = await api("GET", "/api/me");
    S.user = me.user; S.currencies = me.currencies; S.timezones = me.timezones; S.emailAvailable = !!me.email_available;
    applyTheme(); await refreshCore();
  } catch (e) { S.user = null; }
  if (!location.hash || location.hash === "#") { navBase = 1; location.hash = S.user ? "#/dashboard" : "#/login"; } else route();
})();
