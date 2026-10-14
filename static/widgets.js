/* FIPO · Widgets: página modular (Inicio de widgets) con 9 widgets, tamaños, colores, orden y catálogo.
   Los datos vienen de GET /api/widgets/data (los mismos cálculos de Análisis, presupuestos, metas y portafolio).
   El diseño de cada usuario se guarda en el servidor (/api/widgets/layout) con copia local para abrir al instante. */
"use strict";

Object.assign(ICONS, {
  widgets: "M4 4h7v7H4zM13 4h7v4h-7zM13 11h7v9h-7zM4 14h7v6H4z",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  plane: "M10 14L21 3M21 3l-7 18-3-8-8-3 18-7",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  car: "M5 16v-5l2-5h10l2 5v5M3 16h18M7 19v-3M17 19v-3M7.5 12h9",
  cup: "M5 8h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4zM16 9h2a2 2 0 0 1 0 4h-2M7 3v2M11 3v2",
  check: "M5 12.5l4.5 4.5L19 7.5",
  drag: "M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01",
});

/* ------------------------------------------------------------------ registro de widgets (igual a widgets.py) */
const WG_SIZE_LABEL = { s: "Pequeño", m: "Mediano", l: "Grande" };
const WG_DEFS = {
  quick:      { title: "Nuevo movimiento", desc: "Registra un ingreso, gasto o transferencia con un toque", icon: "plus", sizes: ["s"], opts: [], href: null },
  summary:    { title: "Resumen general", desc: "Saldo total, ingresos, gastos y ahorro del mes", icon: "bars", sizes: ["m", "l"], opts: ["chart", "details"], href: "#/dashboard" },
  portfolio:  { title: "Portafolio", desc: "Valor, rendimiento y ganancia de tus inversiones", icon: "trend", sizes: ["m", "l"], opts: ["chart", "details"], href: "#/portfolio" },
  categories: { title: "Gastos por categoría", desc: "En qué se va tu dinero este mes", icon: "chart", sizes: ["s", "m"], opts: ["chart", "details"], href: "#/analysis" },
  goal:       { title: "Meta de ahorro", desc: "Tu próxima meta con su progreso", icon: "flag", sizes: ["s"], opts: [], href: "#/goals" },
  goals:      { title: "Objetivos", desc: "Hasta 3 metas con su avance", icon: "target", sizes: ["m", "l"], opts: [], href: "#/goals" },
  recent:     { title: "Movimientos recientes", desc: "Tus últimos movimientos", icon: "list", sizes: ["m", "l"], opts: [], href: "#/movements" },
  health:     { title: "Salud financiera", desc: "Tu puntaje y cómo se reparte tu dinero", icon: "leaf", sizes: ["m", "l"], opts: ["chart", "details"], href: "#/analysis" },
  budget:     { title: "Presupuesto", desc: "Cuánto llevas gastado de tu presupuesto del mes", icon: "wallet", sizes: ["s", "m"], opts: ["chart", "details"], href: "#/budgets" },
};
const WG_OPT_LABEL = { chart: "Mostrar gráfico", details: "Mostrar detalles" };

/* Diseño predeterminado: sigue la referencia visual (mezcla de oliva, crema y verde oscuro) */
const WG_DEFAULT = () => ({
  v: 1, mode: "auto", palette: "olive", custom: "",
  items: [
    { id: "health", size: "l", visible: true, palette: "olive" },
    { id: "summary", size: "m", visible: true, palette: "cream" },
    { id: "quick", size: "s", visible: true, palette: "forest" },
    { id: "goal", size: "s", visible: true, palette: "olive" },
    { id: "portfolio", size: "m", visible: true, palette: "forest" },
    { id: "categories", size: "s", visible: true, palette: "cream" },
    { id: "budget", size: "s", visible: true, palette: "cream" },
    { id: "recent", size: "m", visible: true, palette: "cream" },
    { id: "goals", size: "m", visible: true, palette: "forest" },
  ].map((i) => ({ custom: "", opts: {}, ...i })),
});

/* ------------------------------------------------------------------ colores (claro / oscuro) */
const WG_PAL = {
  olive:  { name: "Verde oliva",   sw: "#4E5738", light: { bg: "#4E5738", bg2: "#69724F", ink: "#F4F2E8", soft: "#D7DCC5", accent: "#D8F5B0", tone: "dark" }, dark: { bg: "#3D4432", bg2: "#4B5339", ink: "#F1EFE4", soft: "#C8CDB6", accent: "#D0DAB5", tone: "dark" } },
  forest: { name: "Verde oscuro",  sw: "#1E2A1D", light: { bg: "#1E2A1D", bg2: "#2C3B29", ink: "#F1EFE4", soft: "#B9C4A8", accent: "#CFE7A6", tone: "dark" }, dark: { bg: "#141B14", bg2: "#1D281C", ink: "#EDEBDF", soft: "#AEB89E", accent: "#C3D9A0", tone: "dark" } },
  cream:  { name: "Crema / Beige", sw: "#F1EEE2", light: { bg: "#FDFCF8", bg2: "#F2F0E6", ink: "#2E3326", soft: "#6E7362", accent: "#5E6B42", tone: "light" }, dark: { bg: "#30342B", bg2: "#383D31", ink: "#EDEBDF", soft: "#B4B8A6", accent: "#BAC79B", tone: "dark" } },
  black:  { name: "Negro",         sw: "#171915", light: { bg: "#171915", bg2: "#272A22", ink: "#F4F2E8", soft: "#A9ACA0", accent: "#D8F5B0", tone: "dark" }, dark: { bg: "#0E0F0C", bg2: "#1A1C16", ink: "#EFEDE2", soft: "#9EA196", accent: "#CFE7A6", tone: "dark" } },
  blue:   { name: "Azul suave",    sw: "#5F7DA3", light: { bg: "#5F7DA3", bg2: "#7893B5", ink: "#F7FAFD", soft: "#DDE7F2", accent: "#FFFFFF", tone: "dark" }, dark: { bg: "#34465E", bg2: "#415673", ink: "#EAF1F8", soft: "#B9C9DB", accent: "#C9DCF0", tone: "dark" } },
  purple: { name: "Morado suave",  sw: "#7F79B0", light: { bg: "#7F79B0", bg2: "#968FC4", ink: "#FAF9FE", soft: "#E3E0F3", accent: "#FFFFFF", tone: "dark" }, dark: { bg: "#46435F", bg2: "#544F73", ink: "#EFEDFA", soft: "#C3BFDD", accent: "#D6D1F2", tone: "dark" } },
  pink:   { name: "Rosa suave",    sw: "#F4D6D6", light: { bg: "#F6DCDC", bg2: "#FBEAEA", ink: "#4A2C2C", soft: "#8A6060", accent: "#A9464F", tone: "light" }, dark: { bg: "#4B3438", bg2: "#583D42", ink: "#F8E6E6", soft: "#D3B2B6", accent: "#F0A9B2", tone: "dark" } },
  gray:   { name: "Gris",          sw: "#E2E3DE", light: { bg: "#E6E7E2", bg2: "#F1F2EE", ink: "#2C2F29", soft: "#666A60", accent: "#4F5448", tone: "light" }, dark: { bg: "#3A3C37", bg2: "#444640", ink: "#ECEDE7", soft: "#B3B6AC", accent: "#D5D9CC", tone: "dark" } },
};
const WG_PAL_ORDER = ["olive", "forest", "cream", "black", "blue", "purple", "pink", "gray", "custom"];
const wgHex = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const wgToHex = (r) => "#" + r.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const wgMix = (a, b, t) => { const x = wgHex(a), y = wgHex(b); return wgToHex(x.map((v, i) => v + (y[i] - v) * t)); };
const wgLum = (h) => { const c = wgHex(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
function wgFromHex(hex, dark) {
  const base = /^#[0-9a-f]{6}$/i.test(hex) ? hex : "#5E6B42", bg = dark ? wgMix(base, "#000000", 0.35) : base;
  const tone = wgLum(bg) < 0.28 ? "dark" : "light", ink = tone === "dark" ? "#F6F4EA" : "#262A22";
  return { bg, bg2: tone === "dark" ? wgMix(bg, "#FFFFFF", 0.1) : wgMix(bg, "#FFFFFF", 0.35), ink, soft: wgMix(ink, bg, 0.3),
    accent: tone === "dark" ? wgMix(base, "#FFFFFF", 0.75) : wgMix(base, "#000000", 0.45), tone };
}
/* El color cambia fondo, acento, bordes, iconos, gráficos, botones y barras; los estados (bien / atención / alerta) conservan tonos con contraste */
function wgStyle(palKey, custom, mode) {
  const dark = mode === "dark" || (mode === "auto" && isDark());
  const t = palKey === "custom" ? wgFromHex(custom, dark) : WG_PAL[palKey || "olive"][dark ? "dark" : "light"];
  const d = t.tone === "dark";
  const v = { bg: t.bg, bg2: t.bg2, ink: t.ink, soft: t.soft, accent: t.accent, track: d ? "rgba(255,255,255,.18)" : "rgba(0,0,0,.09)",
    line: d ? "rgba(255,255,255,.14)" : "rgba(0,0,0,.08)", good: d ? "#D8F5B0" : "#4B6532", warn: d ? "#FFE08A" : "#8A650B", bad: d ? "#FFC2B8" : "#B8493A" };
  return { tone: t.tone, css: Object.entries(v).map(([k, x]) => `--w-${k}:${x}`).join(";") };
}

/* ------------------------------------------------------------------ estado */
const WG = { layout: null, data: null, edit: false, saveTimer: null };
function wgNormalize(l) {                       // completa lo que falte (widgets nuevos) sin perder lo guardado
  const def = WG_DEFAULT(), base = l && Array.isArray(l.items) ? l : def, known = new Set(base.items.map((i) => i.id));
  const items = base.items.filter((i) => WG_DEFS[i.id]).map((i) => ({ custom: "", opts: {}, palette: null, visible: true, ...i, size: WG_DEFS[i.id].sizes.includes(i.size) ? i.size : WG_DEFS[i.id].sizes[0] }));
  def.items.filter((i) => !known.has(i.id)).forEach((i) => items.push({ ...i, visible: false }));      // los nuevos quedan disponibles, sin imponerlos
  return { v: 1, mode: base.mode || "auto", palette: base.palette || "olive", custom: base.custom || "", items };
}
async function wgLoadLayout() {
  let server = null;
  try { server = (await api("GET", "/api/widgets/layout")).layout; } catch { /* sin conexión: se usa la copia local */ }
  const local = store.get("wgLayout", null);
  WG.layout = wgNormalize(server || local);
  if (!server && local) wgSave(true);
}
function wgSave(now = false) {
  store.set("wgLayout", WG.layout);
  clearTimeout(WG.saveTimer);
  const send = () => api("PUT", "/api/widgets/layout", WG.layout).catch((e) => toast("No se pudo guardar el diseño: " + e.message, "error"));
  if (now) send(); else WG.saveTimer = setTimeout(send, 500);
}
const wgItem = (id) => WG.layout.items.find((i) => i.id === id);
const wgThemeOf = (it) => it.palette ? wgStyle(it.palette, it.custom || WG.layout.custom, WG.layout.mode) : wgStyle(WG.layout.palette, WG.layout.custom, WG.layout.mode);

/* ------------------------------------------------------------------ piezas gráficas (SVG ligero, sin librerías) */
const wgPct = (p) => (p == null ? "—" : (p > 0 ? "+" : "") + p.toFixed(2) + "%");
const wgM = (c, o) => money(c, WG.data ? WG.data.currency : cur(), o);
function wgSpark(vals, h = 56) {
  if (!vals || vals.length < 2) return "";
  const w = 200, pad = 4, mn = Math.min(...vals), mx = Math.max(...vals), sp = mx - mn || 1;
  const p = vals.map((v, i) => [pad + ((w - 2 * pad) * i) / (vals.length - 1), pad + (h - 2 * pad) * (1 - (v - mn) / sp)]);
  let d = `M${p[0][0].toFixed(1)} ${p[0][1].toFixed(1)}`;
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i - 1] || p[i], b = p[i], c = p[i + 1], e = p[i + 2] || c;
    d += ` C${(b[0] + (c[0] - a[0]) / 6).toFixed(1)} ${(b[1] + (c[1] - a[1]) / 6).toFixed(1)} ${(c[0] - (e[0] - b[0]) / 6).toFixed(1)} ${(c[1] - (e[1] - b[1]) / 6).toFixed(1)} ${c[0].toFixed(1)} ${c[1].toFixed(1)}`;
  }
  return `<svg class="wg-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path class="wg-area" d="${d} L${w - pad} ${h} L${pad} ${h} Z"/><path class="wg-line" d="${d}"/></svg>`;
}
function wgRing(score10, label = "de 10") {
  const R = 50, C = 2 * Math.PI * R, v = score10 == null ? 0 : Math.max(0, Math.min(10, score10)) / 10, len = v * C;
  return `<svg class="wg-ring" viewBox="0 0 120 120" role="img" aria-label="${score10 == null ? "Sin datos" : score10.toFixed(1) + " de 10"}">
    <circle cx="60" cy="60" r="${R}" fill="none" stroke="var(--w-track)" stroke-width="9"/>
    ${score10 == null ? "" : `<circle class="wg-arc" cx="60" cy="60" r="${R}" fill="none" stroke="var(--w-accent)" stroke-width="9" stroke-linecap="round" stroke-dasharray="${len} ${C - len}" transform="rotate(-90 60 60)"/>`}
    <text x="60" y="62" text-anchor="middle" class="wg-ring-n">${score10 == null ? "—" : score10.toFixed(1)}</text><text x="60" y="81" text-anchor="middle" class="wg-ring-d">${label}</text></svg>`;
}
const WG_SHADES = [1, 0.7, 0.46, 0.26];
function wgDonut(parts) {                       // parts: [{pct}], suma 100
  let off = 25, segs = "";
  parts.forEach((p, i) => { if (p.pct > 0) segs += `<circle cx="21" cy="21" r="15.9155" fill="none" stroke="var(--w-accent)" stroke-opacity="${WG_SHADES[i] ?? 0.2}" stroke-width="5.2" stroke-dasharray="${Math.max(0, p.pct - 0.8)} ${100 - Math.max(0, p.pct - 0.8)}" stroke-dashoffset="${off}"/>`; off -= p.pct; });
  return `<svg class="wg-donut" viewBox="0 0 42 42" role="img" aria-label="Gastos por categoría"><circle cx="21" cy="21" r="15.9155" fill="none" stroke="var(--w-track)" stroke-width="5.2"/>${segs}</svg>`;
}
const wgBar = (pct, cls = "") => `<i class="wg-track" role="progressbar" aria-valuenow="${Math.round(Math.max(0, Math.min(100, pct)))}" aria-valuemin="0" aria-valuemax="100"><b class="${cls}" style="width:${Math.max(0, Math.min(100, pct))}%"></b></i>`;
const wgFoot = (label, href) => `<div class="wg-foot"><span class="wg-brand">${icon("leaf")}FIPO</span>${label ? `<span class="wg-more">${esc(label)} ${icon("chevron", "rot180")}</span>` : `<span class="wg-more">${icon("chevron", "rot180")}</span>`}</div>`;
function wgGoalIcon(name) {
  const n = (name || "").toLowerCase();
  return /viaj|vacac|trip|vuelo/.test(n) ? "plane" : /casa|hogar|depa|vivien|renta/.test(n) ? "home" : /emerg|fondo|colch|ahorro/.test(n) ? "shield" : /auto|carro|coche|moto/.test(n) ? "car" : "flag";
}
function wgTxIcon(t) {
  const n = ((t.category_name || "") + " " + (t.description || "")).toLowerCase();
  if (t.type === "transfer") return "swap";
  if (/caf[eé]|comida|aliment|restaur|super/.test(n)) return "cup";
  if (/transp|uber|taxi|gasolina|auto|did[i]/.test(n)) return "car";
  if (/vivien|renta|casa|hogar|servic/.test(n)) return "home";
  return t.type === "income" || t.type === "refund" ? "arrowup" : "arrowdown";
}
function wgDay(iso) {
  const t = todayStr(); if (iso === t) return "Hoy";
  const [y, m, d] = t.split("-").map(Number); if (iso === ymd(new Date(y, m - 1, d - 1))) return "Ayer";
  return fmtDate(iso, { day: "numeric", month: "short" });
}
const wgScoreLabel = (v) => v == null ? "Sin datos suficientes todavía" : v >= 8 ? "Vas muy bien encaminado" : v >= 6 ? "Bien, con algunas áreas de mejora" : v >= 4 ? "Regular, conviene ajustar algo" : "Necesita atención";
const wgEmpty = (msg, cta, href) => `<div class="wg-empty"><p>${esc(msg)}</p>${cta ? `<a class="wg-cta" href="${esc(href)}" data-stop>${esc(cta)}</a>` : ""}</div>`;

/* ------------------------------------------------------------------ widgets (cada uno recibe datos reales, tamaño y opciones) */
const WG_RENDER = {
  quick(d, size) {
    return `<div class="wg-quick"><span class="wg-plus">${icon("plus")}</span><span class="wg-quick-t">Nuevo<br>movimiento</span></div>${wgFoot("")}`;
  },
  summary(d, size, o) {
    const b = d.balance, m = d.month, big = size === "l", chart = o.chart !== false, det = o.details !== false;
    const chg = b.change_pct == null ? "" : `<span class="wg-chg ${b.change_pct < 0 ? "neg" : ""}">${icon("trend")}${wgPct(b.change_pct)}</span>`;
    const kv = (k, v, cls = "") => `<div class="wg-kv"><span>${k}</span><b class="${cls}">${esc(wgM(v))}</b></div>`;
    return `<div class="wg-h">${big ? `<span class="wg-ico">${icon("bars")}</span><span>Resumen general</span>` : ""}</div>
      <div class="wg-top"><div><div class="wg-k">Saldo total</div><div class="wg-v">${esc(wgM(b.value))}</div>${chg}</div>${chart ? wgSpark(b.series, big ? 70 : 52) : ""}</div>
      ${det ? `<div class="wg-kvs">${kv("Ingresos", m.income)}${kv("Gastos", m.expense)}${kv("Ahorro", m.savings, m.savings < 0 ? "neg" : "")}</div>` : ""}
      ${wgFoot(big ? "Ver detalle" : "")}`;
  },
  portfolio(d, size, o) {
    const p = d.portfolio, big = size === "l";
    if (!p) return `<div class="wg-h"><span class="wg-ico">${icon("trend")}</span><span>Portafolio</span></div>${wgEmpty("Tu portafolio está vacío", "Agregar inversión +", "#/portfolio")}${wgFoot("")}`;
    const chart = o.chart !== false, det = o.details !== false, pos = p.positions.slice(0, big ? 10 : 7);
    const mx = Math.max(1, ...pos.map((x) => Math.abs(x.pct || 0)));
    const hasLine = chart && p.series && p.series.length > 2;
    const bars = chart && !hasLine && pos.length ? `<div class="wg-bars" aria-label="Rendimiento por activo">${pos.map((x) => `<span class="wg-bcol" title="${esc(x.symbol)} ${wgPct(x.pct)}"><i class="${(x.pct || 0) < 0 ? "neg" : ""}" style="height:${Math.max(8, Math.round((Math.abs(x.pct || 0) / mx) * 100))}%"></i>${big ? `<em>${esc(x.symbol.slice(0, 6))}</em>` : ""}</span>`).join("")}</div>` : "";
    const kv = (k, v, cls = "") => `<div class="wg-kv"><span>${k}</span><b class="${cls}">${v}</b></div>`;
    const gcls = (p.gain || 0) < 0 ? "neg" : "pos";
    return `<div class="wg-h"><span class="wg-ico">${icon("trend")}</span><span>Portafolio</span></div>
      <div class="wg-top ${hasLine ? "bgline" : ""}">${hasLine ? wgSpark(p.series, big ? 90 : 70) : ""}<div class="wg-topt"><div class="wg-k">${big ? "Valor actual" : "Valor"}</div><div class="wg-v">${esc(wgM(p.value))}</div><span class="wg-chg ${(p.gain_pct || 0) < 0 ? "neg" : ""}">${icon("trend")}${wgPct(p.gain_pct)}</span></div>${hasLine ? "" : bars}</div>
      ${det ? `<div class="wg-kvs">${big ? kv("Rendimiento total", wgPct(p.gain_pct), gcls) + kv("Ganancia", esc(wgM(p.gain, { sign: true })), gcls) + kv("Aporte", esc(wgM(p.cost))) :
        kv("Rendimiento", wgPct(p.gain_pct), gcls) + kv("Ganancia", esc(wgM(p.gain, { sign: true })), gcls) + kv("Hoy", esc(wgM(p.day_change, { sign: true })), p.day_change < 0 ? "neg" : "")}</div>` : ""}
      ${wgFoot("Ver portafolio")}`;
  },
  categories(d, size, o) {
    const c = d.categories, big = size === "m", det = o.details !== false, chart = o.chart !== false;
    if (!c.spent) return `<div class="wg-h"><span class="wg-ico">${icon("chart")}</span><span>Gastos</span></div>${wgEmpty("Aún no hay gastos este mes")}${wgFoot("")}`;
    const rows = [...c.items.map((i) => ({ name: i.name.replace(/^\[DEMO\]\s*/, ""), amount: i.amount })), ...(c.others > 0 ? [{ name: "Otros", amount: c.others }] : [])]
      .map((r) => ({ ...r, pct: Math.round((r.amount * 100) / c.spent) }));
    const sum = rows.reduce((s, r) => s + r.pct, 0); if (rows.length && sum !== 100) rows[0].pct += 100 - sum;       // que siempre sumen 100
    const legend = det ? `<ul class="wg-legend">${rows.map((r, i) => `<li><i style="opacity:${WG_SHADES[i] ?? 0.2}"></i><span>${esc(r.name)}</span><b>${r.pct}%</b></li>`).join("")}</ul>` : "";
    return `<div class="wg-split ${big ? "" : "col"}">${chart ? wgDonut(rows) : ""}${legend}</div>
      <div class="wg-sum"><span class="wg-k">Gastos este mes</span><b>${esc(wgM(c.spent))}</b></div>`;
  },
  goal(d) {
    const g = d.goals.items.find((x) => x.id === d.goals.next_id);
    if (!g) return `<div class="wg-h"><span class="wg-ico">${icon("flag")}</span><span>Meta de ahorro</span></div>${wgEmpty("Aún no tienes metas", "Crear meta +", "#/goals")}${wgFoot("")}`;
    return `<div class="wg-h"><span>Meta de ahorro</span><span class="wg-ico r">${icon("target")}</span></div>
      <div class="wg-goal-name">${esc(g.name.replace(/^\[DEMO\]\s*/, ""))}</div><div class="wg-v sm">${esc(wgM(g.saved))}</div><div class="wg-sub">de ${esc(wgM(g.target))}</div>
      <div class="wg-barrow">${wgBar(g.pct)}<b>${Math.round(g.pct)}%</b></div>${wgFoot("")}`;
  },
  goals(d, size) {
    const items = d.goals.items.filter((g) => !g.done).slice(0, 3), big = size === "l";
    if (!items.length) return `<div class="wg-h"><span class="wg-ico">${icon("target")}</span><span>Mis objetivos</span></div>${wgEmpty(d.goals.items.length ? "¡Completaste todas tus metas!" : "Aún no tienes metas", "Crear meta +", "#/goals")}${wgFoot("")}`;
    const nm = (g) => g.name.replace(/^\[DEMO\]\s*/, "");
    const body = big ? `<div class="wg-rings">${items.map((g) => `<div class="wg-gring" data-href="#/goals/${g.id}"><svg viewBox="0 0 42 42"><circle cx="21" cy="21" r="16" fill="none" stroke="var(--w-track)" stroke-width="3.4"/><circle class="wg-arc" cx="21" cy="21" r="16" fill="none" stroke="var(--w-accent)" stroke-width="3.4" stroke-linecap="round" stroke-dasharray="${(g.pct / 100) * 100.53} 100.53" transform="rotate(-90 21 21)"/><text x="21" y="24" text-anchor="middle">${Math.round(g.pct)}%</text></svg><b>${esc(nm(g))}</b><span>${esc(wgM(g.saved, { mask: true }))} / ${esc(wgM(g.target))}</span></div>`).join("")}</div>` :
      `<div class="wg-goalrows">${items.map((g) => `<div class="wg-grow" data-href="#/goals/${g.id}"><span class="wg-gi">${icon(wgGoalIcon(g.name))}</span><div class="grow"><div class="wg-grow-t"><b>${esc(nm(g))}</b><span>${Math.round(g.pct)}%</span></div>${wgBar(g.pct)}<small>${esc(wgM(g.saved))} / ${esc(wgM(g.target))}</small></div></div>`).join("")}</div>`;
    return `<div class="wg-h"><span class="wg-ico">${icon("target")}</span><span>Mis objetivos</span></div>${body}${wgFoot("Ver todos")}`;
  },
  recent(d, size) {
    const n = size === "l" ? 6 : 4, rows = d.recent.slice(0, n);
    const sign = (t) => (t.type === "expense" ? "−" : t.type === "income" || t.type === "refund" ? "+" : "");
    return `<div class="wg-h"><span class="wg-ico">${icon("list")}</span><span>Movimientos recientes</span><a class="wg-more top" href="#/movements" data-stop>Ver todos ${icon("chevron", "rot180")}</a></div>
      ${rows.length ? `<div class="wg-tx">${rows.map((t) => `<div class="wg-txr" role="button" tabindex="0" data-wtx="${t.id}"><span class="wg-ti">${icon(wgTxIcon(t))}</span>
        <span class="wg-tn"><b>${esc((t.description || (t.type === "transfer" ? "Transferencia" : TYPE_LABEL[t.type])).replace(/^\[DEMO\]\s*/, ""))}</b><small>${esc((t.category_name || TYPE_LABEL[t.type]).replace(/^\[DEMO\]\s*/, ""))}</small></span>
        <span class="wg-ta ${t.type === "expense" ? "" : t.type === "transfer" ? "" : "pos"}"><b>${sign(t)}${esc(money(t.amount, t.currency))}</b><small>${esc(wgDay(t.date))}</small></span></div>`).join("")}</div>` : wgEmpty("Aún no hay movimientos")}`;
  },
  health(d, size, o) {
    const h = d.health, big = size === "l", det = o.details !== false, chart = o.chart !== false;
    const s10 = h ? h.score_10 : null;
    const row = (l, k) => { const b = h.breakdown[k], v = Math.max(0, Math.min(100, (b.points / (100 / 3)) * 100)); return `<div class="wg-hrow"><span>${l}<em>${b.actual_pct}% · meta ${b.target_pct}%</em></span>${wgBar(v, b.bonus ? "plus" : v < 60 ? "low" : "")}</div>`; };
    return `<div class="wg-hl"><div class="wg-h"><span class="wg-ico">${icon("leaf")}</span><span>SALUD FINANCIERA</span></div>
        <div class="wg-hs">${s10 == null ? "—" : s10.toFixed(1)}<small> / 10</small></div><div class="wg-hmsg">${esc(wgScoreLabel(s10))}</div>
        ${det && h ? `<div class="wg-hrows">${row("Vida / Gastos", "living")}${row("Ahorro", "savings")}${row("Inversión", "investments")}</div>` : ""}
        ${big && h ? `<div class="wg-sub">Con tus ingresos de ${esc(h.month)}</div>` : ""}</div>
      ${chart ? `<div class="wg-hr">${wgRing(s10, s10 != null && s10 > 10 ? "con plus" : "de 10")}</div>` : ""}<div class="wg-hfoot">${wgFoot("Ver detalle")}</div>`;
  },
  budget(d, size, o) {
    const b = d.budget, big = size === "m", det = o.details !== false, chart = o.chart !== false;
    if (!b) return `<div class="wg-h"><span class="wg-ico">${icon("wallet")}</span><span>Presupuesto</span></div>${wgEmpty("Aún no defines tu presupuesto", "Crear presupuesto +", "#/budgets")}${wgFoot("")}`;
    const st = b.status, cls = st === "over" ? "bad" : st === "warn" ? "mid" : "";
    return `<div class="wg-h"><span class="wg-ico">${icon("wallet")}</span><span>Presupuesto mensual</span></div>
      <div class="wg-v ${big ? "" : "sm"}">${esc(wgM(b.amount))}</div>
      <div class="wg-budrow"><span>Gastado <b>${esc(wgM(b.spent))}</b></span><b>${Math.round(b.pct)}%</b></div>${chart ? wgBar(b.pct, cls) : ""}
      ${det ? `<div class="wg-budrow ${b.remaining < 0 ? "bad" : ""}"><span>${b.remaining < 0 ? "Excedido" : "Disponible"}</span><b>${esc(wgM(Math.abs(b.remaining)))}</b></div>` : ""}
      ${st !== "ok" ? `<div class="wg-note ${st}">${st === "over" ? "Has superado tu presupuesto" : "Estás cerca de tu límite"}</div>` : ""}${wgFoot("")}`;
  },
};

/* ------------------------------------------------------------------ tarjeta de widget */
function wgCard(it, { preview = false } = {}) {
  const def = WG_DEFS[it.id], th = wgThemeOf(it), o = it.opts || {};
  const href = def.href, interactive = !preview;
  let body; try { body = WG_RENDER[it.id](WG.data, it.size, o); } catch (e) { console.error(e); body = wgEmpty("No se pudo mostrar este widget"); }
  const ctl = !interactive ? "" : `<span class="wg-grip" title="Arrastra para reordenar">${icon("drag")}</span><button type="button" class="wg-menu-btn" data-wmenu="${it.id}" aria-label="Opciones de ${esc(def.title)}" aria-haspopup="true">${icon("dots")}</button>`;
  return `<section class="wg wg-${it.size} wg-w-${it.id}" data-wid="${it.id}" data-tone="${th.tone}" style="${th.css}" ${interactive && (href || it.id === "quick") ? `role="link" tabindex="0" aria-label="${esc(def.title)}"` : ""} ${interactive && href ? `data-href="${href}"` : ""} ${interactive && it.id === "quick" ? 'data-quick="1"' : ""} ${interactive && WG.edit && !MOBILE.matches ? 'draggable="true"' : ""}>${ctl}${body}</section>`;
}

/* ------------------------------------------------------------------ página */
function widgetsView() {
  const view = mountShell("widgets", "Widgets", `<button class="btn" id="wg-custom" aria-pressed="false">${icon("sliders")} <span id="wg-custom-t">Personalizar dashboard</span></button>`);
  withRetry(view, async () => {
    const [data] = await Promise.all([api("GET", "/api/widgets/data"), wgLoadLayout()]);
    WG.data = data; WG.edit = false;
    wgDraw(view);
  });
}
function wgDraw(view) {
  const L = WG.layout, vis = L.items.filter((i) => i.visible), hidden = L.items.filter((i) => !i.visible);
  const btn = $("#wg-custom"); if (btn) { btn.setAttribute("aria-pressed", String(WG.edit)); $("#wg-custom-t").textContent = WG.edit ? "Listo" : "Personalizar dashboard"; btn.classList.toggle("primary", WG.edit); btn.onclick = () => { WG.edit = !WG.edit; wgDraw(view); }; }
  const hr = new Date().getHours(), greet = hr < 12 ? "Buenos días" : hr < 19 ? "Buenas tardes" : "Buenas noches";
  const bar = !WG.edit ? "" : `<div class="wg-bar" role="toolbar" aria-label="Personalizar dashboard">
    <div class="wg-bar-g"><span class="lbl">Color de los widgets</span><div class="wg-swatches">${WG_PAL_ORDER.map((k) => `<button type="button" class="wg-sw ${k === "custom" ? "custom" : ""} ${L.palette === k ? "on" : ""}" data-gpal="${k}" title="${k === "custom" ? "Personalizado" : WG_PAL[k].name}" aria-label="${k === "custom" ? "Personalizado" : WG_PAL[k].name}" style="background:${k === "custom" ? (L.custom || "conic-gradient(#e9826f,#e8c46a,#9aa67c,#6b8fb3,#9a93c4,#e9826f)") : WG_PAL[k].sw}"></button>`).join("")}${L.palette === "custom" ? `<input type="color" id="wg-gcustom" value="${esc(L.custom || "#5E6B42")}" aria-label="Elegir color">` : ""}</div></div>
    <div class="wg-bar-g"><span class="lbl">Apariencia</span><div class="seg seg-sm">${[["auto", "Automático"], ["light", "Claro"], ["dark", "Oscuro"]].map(([k, l]) => `<button type="button" data-gmode="${k}" class="${L.mode === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
    <div class="wg-bar-a"><button type="button" class="btn sm" id="wg-add">${icon("plus")} Agregar widget</button><button type="button" class="btn sm ghost" id="wg-reset">Restaurar</button></div></div>`;
  view.innerHTML = `<div class="wg-page ${WG.edit ? "wg-edit" : ""}">
    <p class="wg-greet"><b>${greet}, ${esc((S.user.name || "").split(" ")[0])}</b><span>Tu información financiera, siempre a la vista.</span></p>${bar}
    ${vis.length ? `<div class="wg-grid" id="wg-grid">${vis.map((i) => wgCard(i)).join("")}</div>` :
      `<div class="card empty"><h2 style="justify-content:center">No tienes widgets en tu dashboard</h2><p>Agrega los que quieras desde “Agregar widget”.</p><button class="btn primary" id="wg-add2">${icon("plus")} Agregar widget</button></div>`}
    ${hidden.length && !WG.edit ? `<p class="muted small wg-hidden-note">${hidden.length} widget${hidden.length > 1 ? "s" : ""} oculto${hidden.length > 1 ? "s" : ""} · <a href="#" id="wg-show-store">Ver catálogo</a></p>` : ""}
    <section class="card wg-ios" id="wg-ios"></section></div>`;
  wgBind(view); wgIosPanel($("#wg-ios", view));
}

function wgBind(view) {
  const L = WG.layout, grid = $("#wg-grid", view);
  const change = () => { wgSave(); wgDraw(view); };
  const openAdd = () => wgStore(() => wgDraw(view));
  const a1 = $("#wg-add", view), a2 = $("#wg-add2", view), a3 = $("#wg-show-store", view);
  if (a1) a1.onclick = openAdd; if (a2) a2.onclick = openAdd; if (a3) a3.onclick = (e) => { e.preventDefault(); openAdd(); };
  const rs = $("#wg-reset", view); if (rs) rs.onclick = async () => { if (!(await confirmDialog("Restaurar widgets", "Se volverá al diseño predeterminado: se pierden el orden, tamaños y colores que elegiste.", "Restaurar"))) return; WG.layout = wgNormalize(WG_DEFAULT()); wgSave(true); wgDraw(view); toast("Diseño restaurado."); };
  $$("[data-gpal]", view).forEach((b) => b.onclick = () => { L.palette = b.dataset.gpal; if (L.palette === "custom" && !L.custom) L.custom = "#5E6B42"; L.items.forEach((i) => { i.palette = null; i.custom = ""; }); change(); });
  const gc = $("#wg-gcustom", view); if (gc) gc.oninput = () => { L.custom = gc.value; wgSave(); $$(".wg", view).forEach((el) => { const it = wgItem(el.dataset.wid), th = wgThemeOf(it); el.style.cssText = th.css; el.dataset.tone = th.tone; }); const sw = $('[data-gpal="custom"]', view); if (sw) sw.style.background = gc.value; };
  $$("[data-gmode]", view).forEach((b) => b.onclick = () => { L.mode = b.dataset.gmode; change(); });
  if (!grid) return;
  const openCard = (el) => {
    if (WG.edit) return;
    if (el.dataset.quick) return txModal();
    if (el.dataset.href) go(el.dataset.href);
  };
  grid.addEventListener("click", (e) => {
    const mb = e.target.closest("[data-wmenu]"); if (mb) { e.stopPropagation(); return wgMenu(mb, view); }
    if (e.target.closest("[data-stop]")) return;                           // enlaces propios (Ver todos, Agregar…) navegan solos
    const tx = e.target.closest("[data-wtx]"); if (tx && !WG.edit) { e.stopPropagation(); return txDetail(+tx.dataset.wtx); }
    const inner = e.target.closest("[data-href]"); const card = e.target.closest(".wg"); if (!card) return;
    if (inner && inner !== card && !WG.edit) return go(inner.dataset.href);
    openCard(card);
  });
  grid.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tx = e.target.closest("[data-wtx]"); if (tx && !WG.edit) { e.preventDefault(); return txDetail(+tx.dataset.wtx); }
    const card = e.target.closest(".wg"); if (card && e.target === card) { e.preventDefault(); openCard(card); }
  });
  // pulsación larga en el celular: entra a personalizar
  let lp = null;
  grid.addEventListener("pointerdown", (e) => { if (e.pointerType !== "touch" || WG.edit) return; lp = setTimeout(() => { lp = null; WG.edit = true; wgDraw(view); }, 650); });
  ["pointerup", "pointermove", "pointercancel", "scroll"].forEach((ev) => grid.addEventListener(ev, () => { if (lp) { clearTimeout(lp); lp = null; } }, { passive: true }));
  // arrastrar para reordenar (computadora)
  if (WG.edit && !MOBILE.matches) {
    let from = null;
    grid.addEventListener("dragstart", (e) => { const c = e.target.closest(".wg"); if (!c) return; from = c.dataset.wid; c.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", from); } catch { /* */ } });
    grid.addEventListener("dragend", () => { from = null; $$(".wg", grid).forEach((c) => c.classList.remove("dragging", "over")); });
    grid.addEventListener("dragover", (e) => { if (!from) return; const c = e.target.closest(".wg"); if (!c || c.dataset.wid === from) return; e.preventDefault(); $$(".wg", grid).forEach((x) => x.classList.toggle("over", x === c)); });
    grid.addEventListener("drop", (e) => { if (!from) return; const c = e.target.closest(".wg"); if (!c || c.dataset.wid === from) return; e.preventDefault(); wgMove(from, c.dataset.wid); change(); });
  }
}
function wgMove(id, beforeId) {                  // id pasa a ocupar el lugar de beforeId (entre los visibles)
  const items = WG.layout.items, i = items.findIndex((x) => x.id === id), [it] = items.splice(i, 1), j = items.findIndex((x) => x.id === beforeId);
  items.splice(i < j + 1 && i <= j ? j + 1 : j, 0, it);
}
function wgShift(id, dir) {                      // mover antes / después entre los visibles (útil en pantalla táctil)
  const items = WG.layout.items, vis = items.filter((x) => x.visible), k = vis.findIndex((x) => x.id === id), t = vis[k + dir]; if (!t) return false;
  const a = items.findIndex((x) => x.id === id), b = items.findIndex((x) => x.id === t.id); [items[a], items[b]] = [items[b], items[a]]; return true;
}

/* menú ••• (flota fuera de la tarjeta para no recortarse) */
let wgPop = null;
function wgMenuClose() { if (wgPop) { wgPop.remove(); wgPop = null; document.removeEventListener("pointerdown", wgOutside, true); document.removeEventListener("keydown", wgEsc); } }
const wgOutside = (e) => { if (wgPop && !wgPop.contains(e.target) && !e.target.closest("[data-wmenu]")) wgMenuClose(); };
const wgEsc = (e) => { if (e.key === "Escape") wgMenuClose(); };
function wgMenu(btn, view) {
  const had = wgPop && wgPop.dataset.for === btn.dataset.wmenu; wgMenuClose(); if (had) return;
  const id = btn.dataset.wmenu, def = WG_DEFS[id], it = wgItem(id), vis = WG.layout.items.filter((x) => x.visible), k = vis.findIndex((x) => x.id === id);
  const redraw = () => { wgMenuClose(); wgSave(); wgDraw(view); };
  const pop = document.createElement("div"); pop.className = "wg-pop"; pop.dataset.for = id; pop.setAttribute("role", "menu");
  pop.innerHTML = `<button role="menuitem" data-m="edit">${icon("edit")} Editar</button><button role="menuitem" data-m="color">${icon("leaf")} Cambiar color</button>
    ${def.sizes.length > 1 ? `<div class="wg-pop-sz" role="group" aria-label="Cambiar tamaño"><span>Tamaño</span>${def.sizes.map((s) => `<button data-sz="${s}" class="${it.size === s ? "on" : ""}">${WG_SIZE_LABEL[s].slice(0, 1)}<small>${WG_SIZE_LABEL[s]}</small></button>`).join("")}</div>` : ""}
    <div class="wg-pop-mv"><button data-m="prev" ${k <= 0 ? "disabled" : ""}>${icon("chevron")} Antes</button><button data-m="next" ${k >= vis.length - 1 ? "disabled" : ""}>Después ${icon("chevron", "rot180")}</button></div>
    <button role="menuitem" data-m="hide">${icon("eyeoff")} Ocultar</button>`;
  document.body.appendChild(pop); wgPop = pop;
  const r = btn.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.right - pw)) + "px";
  pop.style.top = (r.bottom + ph + 12 > window.innerHeight ? Math.max(8, r.top - ph - 6) : r.bottom + 6) + "px";
  pop.onclick = (e) => {
    const b = e.target.closest("button"); if (!b || b.disabled) return;
    if (b.dataset.sz) { it.size = b.dataset.sz; return redraw(); }
    const m = b.dataset.m;
    if (m === "hide") { it.visible = false; toast(`«${def.title}» oculto. Puedes volver a agregarlo desde el catálogo.`); return redraw(); }
    if (m === "prev" || m === "next") { wgShift(id, m === "prev" ? -1 : 1); return redraw(); }
    wgMenuClose(); wgConfig(id, { focus: m === "color" ? "color" : "", done: () => { wgSave(); wgDraw(view); } });
  };
  document.addEventListener("pointerdown", wgOutside, true); document.addEventListener("keydown", wgEsc);
  const f = $("button", pop); if (f) f.focus();
}

/* ------------------------------------------------------------------ editar widget (con vista previa en vivo) */
function wgSwatches(sel, custom) {
  return `<button type="button" class="wg-sw inherit ${sel == null ? "on" : ""}" data-pal="" title="Igual que los demás" aria-label="Igual que los demás">${icon("check")}</button>` +
    WG_PAL_ORDER.map((k) => `<button type="button" class="wg-sw ${k === "custom" ? "custom" : ""} ${sel === k ? "on" : ""}" data-pal="${k}" title="${k === "custom" ? "Personalizado" : WG_PAL[k].name}" aria-label="${k === "custom" ? "Personalizado" : WG_PAL[k].name}" style="background:${k === "custom" ? (custom || "conic-gradient(#e9826f,#e8c46a,#9aa67c,#6b8fb3,#9a93c4,#e9826f)") : WG_PAL[k].sw}"></button>`).join("");
}
function wgConfig(id, { adding = false, focus = "", done = () => {} } = {}) {
  const def = WG_DEFS[id], real = wgItem(id), draft = { ...real, opts: { ...(real.opts || {}) }, visible: true };
  if (adding) draft.size = real.size;
  const m = openModal(adding ? `Agregar «${def.title}»` : `Editar «${def.title}»`, `<div id="wgc"></div>`, { wide: true });
  const root = $("#wgc", m.el);
  const draw = () => {
    root.innerHTML = `<div class="wg-prev"><div class="wg-grid prev wg-prev-${draft.size}">${wgCard(draft, { preview: true })}</div></div>
      ${def.sizes.length > 1 ? `<div class="lbl">Tamaño</div><div class="seg" id="wgc-sz">${def.sizes.map((s) => `<button type="button" data-s="${s}" class="${draft.size === s ? "on" : ""}">${WG_SIZE_LABEL[s]}</button>`).join("")}</div>` : ""}
      <div class="lbl" id="wgc-color">Color</div><div class="wg-swatches wide">${wgSwatches(draft.palette, draft.custom)}${draft.palette === "custom" ? `<input type="color" id="wgc-custom" value="${esc(draft.custom || WG.layout.custom || "#5E6B42")}" aria-label="Elegir color">` : ""}</div>
      ${def.opts.length ? `<div class="lbl" style="margin-top:.9rem">Información mostrada</div>${def.opts.map((k) => `<label class="check"><input type="checkbox" data-o="${k}" ${draft.opts[k] !== false ? "checked" : ""}> ${WG_OPT_LABEL[k]}</label>`).join("")}` : ""}
      <footer><button type="button" class="btn" data-close>Cancelar</button><button type="button" class="btn primary" id="wgc-ok">${adding ? "Agregar al dashboard" : "Guardar"}</button></footer>`;
    $$("#wgc-sz button", root).forEach((b) => b.onclick = () => { draft.size = b.dataset.s; draw(); });
    $$("[data-pal]", root).forEach((b) => b.onclick = () => { draft.palette = b.dataset.pal || null; if (draft.palette === "custom" && !draft.custom) draft.custom = WG.layout.custom || "#5E6B42"; draw(); });
    const cc = $("#wgc-custom", root); if (cc) cc.oninput = () => { draft.custom = cc.value; const el = $(".wg", root); const th = wgThemeOf(draft); el.style.cssText = th.css; el.dataset.tone = th.tone; };
    $$("[data-o]", root).forEach((c) => c.onchange = () => { draft.opts[c.dataset.o] = c.checked; draw(); });
    $("#wgc-ok", root).onclick = () => { Object.assign(real, { size: draft.size, palette: draft.palette, custom: draft.custom || "", opts: draft.opts, visible: true }); m.close(); done(); };
    if (focus === "color") { const c = $("#wgc-color", root); if (c) c.scrollIntoView({ block: "center" }); focus = ""; }
  };
  draw();
}

/* ejecuta fn una vez cuando el modal se cierra (por cualquier vía: Listo, X, fuera o Esc) */
function wgOnGone(m, fn) {
  const obs = new MutationObserver(() => { if (!m.el.isConnected) { obs.disconnect(); if (location.hash === "#/widgets") fn(); } });
  obs.observe(document.getElementById("modal-root"), { childList: true });
}

/* ------------------------------------------------------------------ catálogo: "Widgets" (tus widgets / disponibles) */
function wgStore(done) {
  const m = openModal("Widgets", `<div id="wgs"></div>`, { wide: true });
  const root = $("#wgs", m.el);
  const draw = () => {
    const mine = WG.layout.items.filter((i) => i.visible), avail = WG.layout.items.filter((i) => !i.visible);
    const row = (it, on) => { const d = WG_DEFS[it.id]; return `<div class="wgs-row"><span class="wgs-ic">${icon(d.icon)}</span><div class="grow"><b>${on ? '<span class="wgs-ok">✓</span> ' : ""}${esc(d.title)}</b><div class="muted small">${esc(d.desc)} · ${d.sizes.map((s) => WG_SIZE_LABEL[s]).join(" / ")}</div></div>
      ${on ? `<button class="btn sm" data-edit="${it.id}">Editar</button><button class="btn sm ghost" data-del="${it.id}">Quitar</button>` : `<button class="btn sm primary" data-add="${it.id}">${icon("plus")} Agregar</button>`}</div>`; };
    root.innerHTML = `<div class="lbl">Tus widgets</div>${mine.length ? mine.map((i) => row(i, true)).join("") : `<p class="muted small">Todavía no tienes widgets.</p>`}
      <div class="lbl" style="margin-top:1rem">Disponibles</div>${avail.length ? avail.map((i) => row(i, false)).join("") : `<p class="muted small">Ya tienes todos los widgets en tu dashboard.</p>`}
      <footer><button type="button" class="btn primary" data-close>Listo</button></footer>`;
    $$("[data-del]", root).forEach((b) => b.onclick = () => { wgItem(b.dataset.del).visible = false; wgSave(); draw(); });
    $$("[data-edit]", root).forEach((b) => b.onclick = () => wgConfig(b.dataset.edit, { done: () => { wgSave(); draw(); } }));
    $$("[data-add]", root).forEach((b) => b.onclick = () => wgConfig(b.dataset.add, { adding: true, done: () => { const it = wgItem(b.dataset.add), items = WG.layout.items; items.splice(items.indexOf(it), 1); items.unshift(it); wgSave(); draw(); } }));
  };
  draw();
  wgOnGone(m, done);
}

/* ------------------------------------------------------------------ iPhone: qué es posible como PWA y qué no */
function wgIosPanel(box) {
  box.innerHTML = `<h2>${icon("widgets")} Widgets en la pantalla de inicio del iPhone</h2>
    <div class="grid two even wg-ios-cols">
      <div><h3>Lo que sí hace FIPO (PWA)</h3><ul class="wg-ul"><li>La página <b>Widgets</b> de arriba, con tus datos reales, colores y diseño guardado en tu cuenta.</li><li>Agregar FIPO a la pantalla de inicio y abrirla a pantalla completa.</li><li>Avisos push con la app cerrada (ya incluidos).</li></ul></div>
      <div><h3>Lo que una PWA no puede</h3><ul class="wg-ul"><li>Crear widgets en la <b>pantalla de inicio o de bloqueo</b> de iOS: Apple solo lo permite a apps nativas (WidgetKit, con Xcode y cuenta de desarrollador de pago).</li></ul></div></div>
    <p class="muted small">Alternativa <b>gratis</b>: la app <b>Scriptable</b> dibuja un widget real en tu pantalla de inicio leyendo un enlace privado de solo lectura de FIPO. Ese mismo enlace (<code>/api/widgets/public</code>) es la base para conectar después una app nativa.</p>
    <div id="wg-ios-body"><div class="spinner"></div></div>`;
  const body = $("#wg-ios-body", box);
  const draw = async () => {
    let st = { has_token: false }; try { st = await api("GET", "/api/widgets/token"); } catch { /* */ }
    body.innerHTML = st.has_token ? `<div class="note">Tienes un enlace activo (creado ${esc((st.created_at || "").slice(0, 10))}). Por seguridad no se vuelve a mostrar: si lo perdiste, genera uno nuevo (el anterior deja de funcionar).</div>
      <div class="wg-ios-a"><button class="btn" id="wg-tk-new">Generar enlace nuevo</button><button class="btn danger" id="wg-tk-del">Revocar enlace</button></div>` :
      `<div class="wg-ios-a"><button class="btn primary" id="wg-tk-new">Crear enlace privado para mi iPhone</button></div>`;
    $("#wg-tk-new", body).onclick = async () => {
      try { const r = await api("POST", "/api/widgets/token"); wgShowToken(r.token, draw); } catch (e) { toast(e.message, "error"); }
    };
    const del = $("#wg-tk-del", body); if (del) del.onclick = async () => { if (!(await confirmDialog("Revocar enlace", "Tus widgets de iPhone dejarán de actualizarse hasta que generes un enlace nuevo.", "Revocar"))) return; try { await api("DELETE", "/api/widgets/token"); toast("Enlace revocado."); draw(); } catch (e) { toast(e.message, "error"); } };
  };
  draw();
}
async function wgShowToken(token, after) {
  const url = location.origin + "/api/widgets/public?token=" + token;
  let script = "";
  try { script = (await (await fetch("/static/fipo-loader.js?t=" + Date.now(), { cache: "no-store" })).text()).replace('"__FIPO_URL__"', JSON.stringify(url)); } catch { script = ""; }
  const m = openModal("Widget para iPhone (Scriptable)", `<div class="note">Este enlace da acceso <b>de solo lectura</b> a tus cifras. Se muestra una sola vez; no lo compartas.</div>
    <ol class="wg-ul ol"><li>Instala <b>Scriptable</b> desde la App Store (gratis).</li><li>Toca <b>Copiar script</b>, abre Scriptable, crea un script nuevo (+) y pégalo. Guárdalo con el nombre “FIPO”. <b>Si ya tenías uno, borra todo su contenido y pega este</b>: es la última vez, porque este script baja solo el diseño más reciente.</li>
    <li>En la pantalla de inicio: mantén presionado → <b>+</b> → Scriptable → elige tamaño → toca el widget → <b>Script: FIPO</b>. En “Parameter” escribe <code>summary</code>, <code>portfolio</code>, <code>health</code>, <code>budget</code>, <code>goal</code>, <code>goals</code>, <code>categories</code>, <code>recent</code> o <code>quick</code> (nuevo movimiento). Se ven con los mismos colores que elijas aquí.</li></ol>
    <div class="field"><label for="wg-url">Enlace privado</label><input id="wg-url" readonly value="${esc(url)}"></div>
    <div class="wg-ios-a"><button class="btn primary" id="wg-copy-script" ${script ? "" : "disabled"}>Copiar script</button><button class="btn" id="wg-copy-url">Copiar solo el enlace</button></div>
    <p class="muted small">El widget se actualiza cuando iOS lo decide (normalmente cada 15–60 min). Si tu FIPO está en PythonAnywhere gratis, cada consulta usa un poco de tus 100 s de CPU al día: es poco, pero por eso no se actualiza más seguido.</p>
    <footer><button class="btn primary" data-close>Listo</button></footer>`, { wide: true });
  const copy = async (txt, ok) => { try { await navigator.clipboard.writeText(txt); toast(ok); } catch { const el = $("#wg-url", m.el); el.value = txt; el.select(); toast("Selecciona y copia el texto.", "error"); } };
  $("#wg-copy-script", m.el).onclick = () => copy(script, "Script copiado.");
  $("#wg-copy-url", m.el).onclick = () => copy(url, "Enlace copiado.");
  wgOnGone(m, after);
}

/* la apariencia "Automática" sigue al sistema: si cambia mientras la página está abierta, se vuelve a pintar */
try { window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (location.hash === "#/widgets" && S.user && WG.layout && WG.layout.mode === "auto" && !$(".overlay")) { const v = $("#view"); if (v && WG.data) wgDraw(v); } }); } catch { /* */ }
