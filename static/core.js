/* FIPO - utilidades: API, formato, iconos, gráficas SVG, modales. Sin dependencias. */
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- almacenamiento local (solo conveniencias; puede fallar) ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem("fipo." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("fipo." + k, JSON.stringify(v)); } catch { /* ignorar */ } },
};

/* ---------- API ---------- */
class ApiError extends Error { constructor(msg, status, field) { super(msg); this.status = status; this.field = field; } }
let onUnauthorized = () => {};
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method, credentials: "same-origin",
      headers: { "X-Requested-With": "fipo", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch { throw new ApiError("No se pudo conectar con el servidor. Revisa tu conexión.", 0); }
  let data = null;
  try { data = await res.json(); } catch { /* sin cuerpo */ }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith("/api/auth/")) onUnauthorized();
    throw new ApiError((data && data.error) || "Ocurrió un error inesperado.", res.status, data && data.field);
  }
  return data;
}
const qs = (o) => Object.entries(o).filter(([, v]) => v !== "" && v != null).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

/* ---------- formato ---------- */
let privacy = store.get("privacy", false);
function setPrivacy(v) { privacy = v; store.set("privacy", v); }
const isPrivate = () => privacy;
function money(cents, cur = "MXN", { sign = false, mask = true } = {}) {
  if (privacy && mask) return "•••••";
  let s;
  try { s = new Intl.NumberFormat("es-MX", { style: "currency", currency: cur, currencyDisplay: "narrowSymbol" }).format(Math.abs(cents) / 100); }
  catch { s = (Math.abs(cents) / 100).toFixed(2) + " " + cur; }
  // otra moneda con el mismo signo «$» que tus pesos (p. ej. dólares): se marca para no confundirlas
  const mainCur = typeof S !== "undefined" && S.user ? S.user.currency : "MXN";
  if (cur !== mainCur && s.startsWith("$")) s = (cur === "USD" ? "US" : cur + " ") + s;
  if (cents < 0) return "−" + s;
  return sign && cents > 0 ? "+" + s : s;
}
const initials = (name) => (name || "").trim().split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function fmtDate(iso, opts = { day: "2-digit", month: "short", year: "numeric" }) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("es-MX", opts).format(new Date(y, m - 1, d));
}
const centsToInput = (c) => (c / 100).toFixed(2);

/* ---------- iconos ---------- */
const ICONS = {
  idea: "M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.6 1 2.5h6c0-.9.3-1.8 1-2.5A6 6 0 0 0 12 3z",
  check: "M5 12.5l4.5 4.5L19 7.5",
  leaf: "M5 19c0-8 4-14 15-15-1 11-7 15-15 15zM5 19c3-5 6-8 10-10",
  home: "M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  wallet: "M3 7a2 2 0 0 1 2-2h14v4M3 7v10a2 2 0 0 0 2 2h16V9H5a2 2 0 0 1-2-2zM17 14h.01",
  sliders: "M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M13 4v4M7 10v4M15 16v4",
  plus: "M12 5v14M5 12h14",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  eyeoff: "M3 3l18 18M10.6 6.1A9.7 9.7 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7c1.6 0 3-.4 4.3-1M9.9 9.9a3 3 0 0 0 4.2 4.2",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3",
  download: "M12 3v12M7 10l5 5 5-5M4 21h16",
  upload: "M12 15V3M7 8l5-5 5 5M4 21h16",
  trend: "M3 17l6-6 4 4 8-8M15 7h6v6",
  card: "M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18M7 15h3",
  debt: "M12 3v18M17 7H9.5a2.5 2.5 0 0 0 0 5h5a2.5 2.5 0 0 1 0 5H6",
  target: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 12h.01",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6",
  table: "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18M3 15h18M9 10v11",
  camera: "M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM12 11a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
  flag: "M5 21V4M5 4h11l-2 4 2 4H5",
  grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  edit: "M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  x: "M6 6l12 12M18 6L6 18",
  moon: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  chevron: "M15 6l-6 6 6 6",
  alert: "M12 3l10 18H2L12 3zM12 10v5M12 18h.01",
  swap: "M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7",
  archive: "M3 5h18v4H3zM5 9v10h14V9M10 13h4",
  back: "M19 12H5M11 18l-6-6 6-6",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 7.5h.01",
  calendar: "M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 10h16M8 3v4M16 3v4M9 15h2",
  bars: "M5 20v-5M12 20V9M19 20V4",
  coins: "M12 4c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5",
  cash: "M3 7h18v10H3zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM6 10v.01M18 14v.01",
  arrowup: "M12 19V5M5 12l7-7 7 7",
  arrowdown: "M12 5v14M19 12l-7 7-7-7",
  repeat: "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3",
};
const icon = (n, cls = "") => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[n]}"/></svg>`;

/* fila tipo tarjeta: ícono en círculo, etiqueta, valor y nota; con enlace muestra chevron */
function statRow(ic, k, v, n = "", cls = "", href = "") {
  const inner = `<span class="ico">${icon(ic)}</span><span><div class="k">${esc(k)}</div><div class="v ${cls}">${esc(v)}</div>${n ? `<div class="n">${esc(n)}</div>` : ""}</span>`;
  return href ? `<a class="stat-row" href="${esc(href)}">${inner}${icon("chevron", "row-chev")}</a>` : `<div class="stat-row">${inner}<span></span></div>`;
}

/* ---------- avisos y modales ---------- */
function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = "toast " + (kind === "error" ? "error" : "");
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? 6000 : 3200);
}

let modalStack = [];
function openModal(title, bodyHtml, { onMount, wide } = {}) {
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}" ${wide ? 'style="width:min(100%,640px)"' : ""}>
    <header><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Cerrar">${icon("x")}</button></header>${bodyHtml}</div>`;
  const prevFocus = document.activeElement;
  const close = () => { ov.remove(); modalStack = modalStack.filter((m) => m !== api_); document.removeEventListener("keydown", onKey); prevFocus && prevFocus.focus && prevFocus.focus(); };
  const api_ = { el: ov, close };
  const onKey = (e) => { if (e.key === "Escape" && modalStack[modalStack.length - 1] === api_) close(); };
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
  ov.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); });
  document.addEventListener("keydown", onKey);
  $("#modal-root").appendChild(ov);
  modalStack.push(api_);
  const first = $("input:not([type=hidden]), select, textarea", ov);
  if (first) first.focus();
  if (onMount) onMount(ov, close);
  return api_;
}

function confirmDialog(title, text, okLabel = "Eliminar") {
  return new Promise((resolve) => {
    const m = openModal(title, `<p>${esc(text)}</p><footer><button class="btn" data-close>Cancelar</button><button class="btn danger" id="cf-ok">${esc(okLabel)}</button></footer>`,
      { onMount: (el) => { $("#cf-ok", el).addEventListener("click", () => { resolve(true); m.close(); }); } });
    m.el.addEventListener("click", (e) => { if (e.target.closest("[data-close]") || e.target === m.el) resolve(false); });
  });
}

/* ---------- gráficas SVG (los datos siempre vienen del servidor) ---------- */
const PALETTE = ["#556B2F", "#F4C95D", "#FF8A7A", "#6B8FB3", "#8FA46B", "#2E3A24", "#C9B88A", "#9CA3AF"];
function niceMax(v) {
  if (v <= 0) return 100;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
const compact = (c) => { const v = c / 100; return new Intl.NumberFormat("es-MX", { notation: "compact", maximumFractionDigits: 1 }).format(v); };

function barChart(series, unit, cur) {
  const W = 640, H = 240, L = 44, R = 8, T = 10, B = 26;
  const max = niceMax(Math.max(...series.flatMap((s) => [s.income, s.expense]), 0));
  const iw = W - L - R, ih = H - T - B, n = series.length;
  const gw = iw / n, bw = Math.max(2, Math.min(22, gw / 2.6));
  const y = (v) => T + ih - (v / max) * ih;
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    g += `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text x="${L - 6}" y="${yy + 3}" text-anchor="end">${privacy ? "" : compact(v)}</text>`;
  }
  const every = Math.ceil(n / 8);
  let bars = "";
  series.forEach((s, i) => {
    const cx = L + gw * i + gw / 2;
    const label = unit === "month" ? fmtDate(s.key + "-01", { month: "short", year: "2-digit" }) : fmtDate(s.key, { day: "numeric", month: "short" });
    const range = unit === "month" ? [s.key + "-01", ymd(new Date(+s.key.slice(0, 4), +s.key.slice(5, 7), 0))] : [s.key, s.key];
    const tip = `${label}: ingresos ${money(s.income, cur)} · gastos ${money(s.expense, cur)}`;
    bars += `<g><title>${esc(tip)}</title>`;
    if (s.income > 0) bars += `<rect class="bar" data-from="${range[0]}" data-to="${range[1]}" x="${cx - bw - 1}" y="${y(s.income)}" width="${bw}" height="${Math.max(1, T + ih - y(s.income))}" rx="3" fill="var(--income)"/>`;
    if (s.expense > 0) bars += `<rect class="bar" data-from="${range[0]}" data-to="${range[1]}" x="${cx + 1}" y="${y(s.expense)}" width="${bw}" height="${Math.max(1, T + ih - y(s.expense))}" rx="3" fill="var(--expense)"/>`;
    bars += `</g>`;
    if (i % every === 0) bars += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${esc(label)}</text>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Ingresos frente a gastos">${g}${bars}</svg>`;
}

function donut(items, cur) {
  const total = items.reduce((a, b) => a + b.total, 0);
  const R = 70, C = 2 * Math.PI * R;
  let off = 0, arcs = "";
  items.forEach((it, i) => {
    const len = (it.total / total) * C;
    arcs += `<circle r="${R}" cx="100" cy="100" fill="none" stroke="${PALETTE[i % PALETTE.length]}" stroke-width="26" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 100 100)"><title>${esc(it.name)}: ${esc(money(it.total, cur))}</title></circle>`;
    off += len;
  });
  return `<svg class="chart" style="max-width:220px;margin:0 auto" viewBox="0 0 200 200" role="img" aria-label="Gastos por categoría">${arcs}
    <text x="100" y="96" text-anchor="middle" style="font-size:10px">Total</text>
    <text x="100" y="114" text-anchor="middle" style="font-size:14px;font-weight:700;fill:var(--ink)">${esc(privacy ? "•••••" : compact(total))}</text></svg>`;
}

/* anillo de progreso pequeño (metas): dibuja el % real recibido, nunca un valor inventado */
function progressRing(pct, size = 56, cls = "") {
  const p = Math.max(0, Math.min(100, pct)), R = 22, C = 2 * Math.PI * R;
  const len = (p / 100) * C;
  const col = p >= 100 ? "var(--income)" : "var(--olive-700)";
  return `<svg class="goal-ring ${cls}" width="${size}" height="${size}" viewBox="0 0 56 56" role="img" aria-label="${Math.round(p)}% completado">
    <circle cx="28" cy="28" r="${R}" fill="none" stroke="var(--sage-soft)" stroke-width="6"/>
    <circle cx="28" cy="28" r="${R}" fill="none" stroke="${col}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${len} ${C - len}" transform="rotate(-90 28 28)"/>
    <text x="28" y="32" text-anchor="middle" style="font-size:12px">${Math.round(p)}%</text></svg>`;
}

function lineChart(points, cur, label = "Evolución del saldo") {
  const W = 640, H = 220, L = 46, R = 10, T = 10, B = 24;
  const vals = points.map((p) => p.balance);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) { max += 100; min -= 100; }
  const pad_ = (max - min) * 0.1; min -= pad_; max += pad_;
  let t0 = new Date(points[0].date).getTime(), t1 = new Date(points[points.length - 1].date).getTime();
  if (t1 - t0 < 86400000 * 6) { const mid = (t0 + t1) / 2; t0 = mid - 86400000 * 3; t1 = mid + 86400000 * 3; }   // pocos días: se amplía el eje
  const x = (d) => L + ((new Date(d).getTime() - t0) / (t1 - t0)) * (W - L - R);
  const y = (v) => T + (H - T - B) * (1 - (v - min) / (max - min));
  // saldo escalonado: se mantiene hasta el siguiente movimiento y hasta hoy
  let d = `M ${L} ${y(points[0].balance)} L ${x(points[0].date)} ${y(points[0].balance)}`;
  for (let i = 1; i < points.length; i++) d += ` L ${x(points[i].date)} ${y(points[i - 1].balance)} L ${x(points[i].date)} ${y(points[i].balance)}`;
  d += ` L ${W - R} ${y(points[points.length - 1].balance)}`;
  const area = d + ` L ${W - R} ${H - B} L ${L} ${H - B} Z`;
  let g = "";
  for (let i = 0; i <= 3; i++) { const v = min + ((max - min) / 3) * i; g += `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${privacy ? "" : compact(v)}</text>`; }
  const dots = points.map((p) => `<circle cx="${x(p.date)}" cy="${y(p.balance)}" r="3" fill="var(--olive-700)"><title>${esc(fmtDate(p.date))}: ${esc(money(p.balance, cur))}</title></circle>`).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${g}
    <path d="${area}" fill="var(--sage)" opacity=".28"/><path d="${d}" fill="none" stroke="var(--olive-700)" stroke-width="2.2" stroke-linejoin="round"/>${points.length <= 60 ? dots : ""}
    <text x="${L}" y="${H - 6}">${esc(fmtDate(points[0].date))}</text>${points.length > 1 && points[0].date !== points[points.length - 1].date ? `<text x="${W - R}" y="${H - 6}" text-anchor="end">${esc(fmtDate(points[points.length - 1].date))}</text>` : ""}</svg>`;
}

/* ---------- tema y descargas (la vista previa web sobrescribe downloadFile) ---------- */
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  if (t) return t === "dark";
  try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch { return false; }
};
let downloadFile = (url) => { location.href = url; };

/* ---------- logo FIPO (SVG propio, sin fuentes externas) ---------- */
function logoWord() {
  return `<svg class="logo-word" viewBox="0 0 316 110" role="img" aria-label="FIPO" fill="currentColor">
    <g stroke="currentColor" stroke-width="4" stroke-linejoin="round">
      <path d="M4 5H66V27H28V44H60V66H28V105H4Z"/><path d="M84 5H108V105H84Z"/>
      <path fill-rule="evenodd" d="M128 5H168a34 34 0 0 1 0 68H152V105H128ZM152 27V51H166a12 12 0 0 0 0-24Z"/></g>
    <circle class="o-disc" cx="262" cy="55" r="50"/>
    <path class="o-leaf" d="M246 76C242 52 256 36 282 33C285 58 270 74 246 76Z"/>
    <path class="o-vein" d="M247 74C256 62 266 50 276 40" fill="none" stroke-width="3" stroke-linecap="round"/></svg>`;
}
function logoMark() {
  return `<svg class="logo-mark" viewBox="0 0 100 100" role="img" aria-label="FIPO"><circle cx="50" cy="50" r="50" fill="#D7E0C3"/>
    <path d="M34 71C30 47 44 31 70 28C73 53 58 69 34 71Z" fill="#2E3A24"/><path d="M35 69C44 57 54 45 64 35" fill="none" stroke="#D7E0C3" stroke-width="3" stroke-linecap="round"/></svg>`;
}
