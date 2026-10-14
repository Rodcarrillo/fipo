// FIPO · widgets para la pantalla de inicio del iPhone (app gratuita "Scriptable").
// Dibujan lo mismo que la página Widgets de FIPO: mismos colores (los que elegiste en la web), líneas, anillos y barras.
// FIPO te lo entrega ya con tu enlace privado de SOLO LECTURA; no lo compartas.
// Parámetro del widget: summary | portfolio | health | budget | goal | goals | categories | recent | quick
const URL_FIPO = typeof FIPO_URL !== "undefined" ? FIPO_URL : "__FIPO_URL__";   // el cargador (fipo-loader.js) pasa FIPO_URL

/* ------------------------------------------------------------------ colores (igual que static/widgets.js) */
const PAL = {
  olive:  { light: { bg: "#4E5738", bg2: "#69724F", ink: "#F4F2E8", soft: "#D7DCC5", accent: "#D8F5B0", tone: "dark" }, dark: { bg: "#3D4432", bg2: "#4B5339", ink: "#F1EFE4", soft: "#C8CDB6", accent: "#D0DAB5", tone: "dark" } },
  forest: { light: { bg: "#1E2A1D", bg2: "#2C3B29", ink: "#F1EFE4", soft: "#B9C4A8", accent: "#CFE7A6", tone: "dark" }, dark: { bg: "#141B14", bg2: "#1D281C", ink: "#EDEBDF", soft: "#AEB89E", accent: "#C3D9A0", tone: "dark" } },
  cream:  { light: { bg: "#FDFCF8", bg2: "#F2F0E6", ink: "#2E3326", soft: "#6E7362", accent: "#5E6B42", tone: "light" }, dark: { bg: "#30342B", bg2: "#383D31", ink: "#EDEBDF", soft: "#B4B8A6", accent: "#BAC79B", tone: "dark" } },
  black:  { light: { bg: "#171915", bg2: "#272A22", ink: "#F4F2E8", soft: "#A9ACA0", accent: "#D8F5B0", tone: "dark" }, dark: { bg: "#0E0F0C", bg2: "#1A1C16", ink: "#EFEDE2", soft: "#9EA196", accent: "#CFE7A6", tone: "dark" } },
  blue:   { light: { bg: "#5F7DA3", bg2: "#7893B5", ink: "#F7FAFD", soft: "#DDE7F2", accent: "#FFFFFF", tone: "dark" }, dark: { bg: "#34465E", bg2: "#415673", ink: "#EAF1F8", soft: "#B9C9DB", accent: "#C9DCF0", tone: "dark" } },
  purple: { light: { bg: "#7F79B0", bg2: "#968FC4", ink: "#FAF9FE", soft: "#E3E0F3", accent: "#FFFFFF", tone: "dark" }, dark: { bg: "#46435F", bg2: "#544F73", ink: "#EFEDFA", soft: "#C3BFDD", accent: "#D6D1F2", tone: "dark" } },
  pink:   { light: { bg: "#F6DCDC", bg2: "#FBEAEA", ink: "#4A2C2C", soft: "#8A6060", accent: "#A9464F", tone: "light" }, dark: { bg: "#4B3438", bg2: "#583D42", ink: "#F8E6E6", soft: "#D3B2B6", accent: "#F0A9B2", tone: "dark" } },
  gray:   { light: { bg: "#E6E7E2", bg2: "#F1F2EE", ink: "#2C2F29", soft: "#666A60", accent: "#4F5448", tone: "light" }, dark: { bg: "#3A3C37", bg2: "#444640", ink: "#ECEDE7", soft: "#B3B6AC", accent: "#D5D9CC", tone: "dark" } },
};
// colores predeterminados de cada widget (si no has personalizado nada en la web)
const DEFAULT_PAL = { health: "olive", summary: "cream", quick: "forest", goal: "olive", portfolio: "forest", categories: "cream", budget: "cream", recent: "cream", goals: "forest" };

const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbHex = (r) => "#" + r.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => { const x = hexRgb(a), y = hexRgb(b); return rgbHex(x.map((v, i) => v + (y[i] - v) * t)); };
const lum = (h) => { const c = hexRgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
function fromHex(hex, dark) {
  const base = /^#[0-9a-f]{6}$/i.test(hex || "") ? hex : "#5E6B42", bg = dark ? mix(base, "#000000", 0.35) : base;
  const tone = lum(bg) < 0.28 ? "dark" : "light", ink = tone === "dark" ? "#F6F4EA" : "#262A22";
  return { bg, bg2: tone === "dark" ? mix(bg, "#FFFFFF", 0.1) : mix(bg, "#FFFFFF", 0.35), ink, soft: mix(ink, bg, 0.3), accent: tone === "dark" ? mix(base, "#FFFFFF", 0.75) : mix(base, "#000000", 0.45), tone };
}
function themeFor(id, layout) {
  const L = layout || {}, mode = L.mode || "auto";
  const dark = mode === "dark" || (mode === "auto" && Device.isUsingDarkAppearance());
  const it = (L.items || []).find((x) => x.id === id) || {};
  const key = it.palette || L.palette || DEFAULT_PAL[id] || "olive";
  const custom = it.palette === "custom" ? (it.custom || L.custom) : L.custom;
  const t = key === "custom" ? fromHex(custom, dark) : (PAL[key] || PAL.olive)[dark ? "dark" : "light"];
  const d = t.tone === "dark";
  return Object.assign({}, t, { track: d ? ["#FFFFFF", 0.18] : ["#000000", 0.09], line: d ? ["#FFFFFF", 0.14] : ["#000000", 0.08],
    good: d ? "#D8F5B0" : "#4B6532", warn: d ? "#FFE08A" : "#8A650B", bad: d ? "#FFC2B8" : "#B8493A" });
}

/* ------------------------------------------------------------------ tamaño real del widget en este iPhone */
function widgetSize(family) {
  const h = Device.screenSize().height, w = Device.screenSize().width, tall = Math.max(h, w);
  const T = { 932: [170, 364, 382], 926: [170, 364, 382], 896: [169, 360, 379], 852: [158, 338, 354], 844: [158, 338, 354], 812: [155, 329, 345], 736: [157, 348, 357], 667: [148, 321, 324], 568: [141, 292, 311] };
  const r = T[Math.round(tall)] || [158, 338, 354];
  return family === "small" ? new Size(r[0], r[0]) : family === "large" ? new Size(r[1], r[2]) : new Size(r[1], r[0]);
}

/* ------------------------------------------------------------------ dibujo */
const SYM = { MXN: "$", USD: "$", CAD: "$", EUR: "€", GBP: "£" };
function money(cents, cur, sign) {
  const v = Math.abs(cents) / 100, s = v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = (SYM[cur] || cur + " ") + s;
  return (cents < 0 ? "−" : sign && cents > 0 ? "+" : "") + body;
}
const pct = (p) => (p == null ? "—" : (p > 0 ? "+" : "") + p.toFixed(2) + "%");
const clean = (s) => String(s || "").replace(/^\[DEMO\]\s*/, "");
const cut = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)).trim() + "…" : s);
const fitSize = (str, maxW, base) => Math.min(base, maxW / (0.56 * Math.max(1, String(str).length)));

class Cv {
  constructor(size, th) {
    this.W = size.width; this.H = size.height; this.th = th;
    this.c = new DrawContext(); this.c.size = size; this.c.opaque = false; this.c.respectScreenScale = true;
    this.pad = this.W < 200 ? 14 : 16;
  }
  col(c, a) { return Array.isArray(c) ? new Color(c[0], c[1]) : new Color(c, a == null ? 1 : a); }
  text(str, x, y, o) {
    o = o || {}; const size = o.size || 12, c = this.c;
    c.setFont(o.font === "b" ? Font.boldSystemFont(size) : o.font === "h" ? Font.heavySystemFont(size) : o.font === "s" ? Font.semiboldSystemFont(size) : o.font === "m" ? Font.mediumSystemFont(size) : Font.systemFont(size));
    c.setTextColor(this.col(o.color || this.th.ink, o.alpha));
    const w = o.w || this.W - x - this.pad;
    if (o.align === "r") c.setTextAlignedRight(); else if (o.align === "c") c.setTextAlignedCenter(); else c.setTextAlignedLeft();
    c.drawTextInRect(String(str), new Rect(x, y, w, size * 1.35));
  }
  rrect(x, y, w, h, r, color, a) { const p = new Path(); p.addRoundedRect(new Rect(x, y, w, h), Math.min(r, h / 2, w / 2), Math.min(r, h / 2, w / 2)); this.c.addPath(p); this.c.setFillColor(this.col(color, a)); this.c.fillPath(); }
  dot(cx, cy, r, color, a) { this.c.setFillColor(this.col(color, a)); this.c.fillEllipse(new Rect(cx - r, cy - r, 2 * r, 2 * r)); }
  stroke(pts, w, color, a) { if (pts.length < 2) return; const p = new Path(); p.move(new Point(pts[0][0], pts[0][1])); for (let i = 1; i < pts.length; i++) p.addLine(new Point(pts[i][0], pts[i][1])); this.c.addPath(p); this.c.setStrokeColor(this.col(color, a)); this.c.setLineWidth(w); this.c.strokePath(); }
  hline(x1, x2, y, color) { this.rrect(x1, y, x2 - x1, 1, 0.5, color); }
  bar(x, y, w, h, p, color) { this.rrect(x, y, w, h, h / 2, this.th.track[0], this.th.track[1]); const f = Math.max(0, Math.min(100, p)) / 100 * w; if (f > 0) this.rrect(x, y, Math.max(h, f), h, h / 2, color || this.th.accent); }
  arc(cx, cy, r, f0, f1, w, color, a) {         // f en vueltas (0 = arriba, sentido horario)
    const n = Math.max(2, Math.ceil((f1 - f0) * 90)), pts = [];
    for (let i = 0; i <= n; i++) { const t = (f0 + ((f1 - f0) * i) / n) * 2 * Math.PI - Math.PI / 2; pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
    this.stroke(pts, w, color, a);
  }
  ring(cx, cy, r, f, w, color) {
    this.arc(cx, cy, r, 0, 0.9999, w, this.th.track[0], this.th.track[1]);
    if (f > 0.004) { this.arc(cx, cy, r, 0, Math.min(f, 0.9999), w, color || this.th.accent); const t = f * 2 * Math.PI - Math.PI / 2; this.dot(cx, cy - r, w / 2, color || this.th.accent); this.dot(cx + r * Math.cos(t), cy + r * Math.sin(t), w / 2, color || this.th.accent); }
  }
  line(vals, x, y, w, h, area, alpha) {         // curva suave (+ área opcional)
    if (!vals || vals.length < 2) return;
    const mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals), sp = mx - mn || 1, c = this.c, a = this.th.accent;
    const P = vals.map((v, i) => [x + (w * i) / (vals.length - 1), y + 3 + (h - 6) * (1 - (v - mn) / sp)]);
    const path = (close) => {
      const p = new Path(); p.move(new Point(P[0][0], P[0][1]));
      for (let i = 0; i < P.length - 1; i++) {
        const A = P[i - 1] || P[i], B = P[i], C = P[i + 1], E = P[i + 2] || C;
        p.addCurve(new Point(C[0], C[1]), new Point(B[0] + (C[0] - A[0]) / 6, B[1] + (C[1] - A[1]) / 6), new Point(C[0] - (E[0] - B[0]) / 6, C[1] - (E[1] - B[1]) / 6));
      }
      if (close) { p.addLine(new Point(x + w, y + h)); p.addLine(new Point(x, y + h)); p.closeSubpath(); }
      return p;
    };
    if (area !== false) { c.addPath(path(true)); c.setFillColor(this.col(a, 0.16)); c.fillPath(); }
    c.addPath(path(false)); c.setStrokeColor(this.col(a, alpha == null ? 1 : alpha)); c.setLineWidth(2.2); c.strokePath();
  }
  glyph(kind, cx, cy, color) {                  // iconitos de 14 pt
    const t = this.th, k = color || t.ink;
    if (kind === "trend") this.stroke([[cx - 5, cy + 3], [cx - 1, cy - 1], [cx + 2, cy + 2], [cx + 6, cy - 4]], 1.6, k);
    else if (kind === "bars") { this.stroke([[cx - 4, cy + 5], [cx - 4, cy + 1]], 2, k); this.stroke([[cx, cy + 5], [cx, cy - 3]], 2, k); this.stroke([[cx + 4, cy + 5], [cx + 4, cy - 5]], 2, k); }
    else if (kind === "target") { this.arc(cx, cy, 5, 0, 0.9999, 1.5, k); this.dot(cx, cy, 1.6, k); }
    else if (kind === "list") { [-4, 0, 4].forEach((d) => this.stroke([[cx - 2, cy + d], [cx + 5, cy + d]], 1.5, k)); [-4, 0, 4].forEach((d) => this.dot(cx - 5, cy + d, 0.9, k)); }
    else if (kind === "leaf") { this.stroke([[cx - 5, cy + 5], [cx - 2, cy - 1], [cx + 1, cy - 4], [cx + 6, cy - 5], [cx + 5, cy], [cx + 2, cy + 3], [cx - 5, cy + 5]], 1.5, k); }
    else if (kind === "wallet") { this.stroke([[cx - 5, cy - 3], [cx + 5, cy - 3], [cx + 5, cy + 4], [cx - 5, cy + 4], [cx - 5, cy - 3]], 1.5, k); this.dot(cx + 2.5, cy + 0.5, 1, k); }
    else if (kind === "up") { this.stroke([[cx, cy + 5], [cx, cy - 5]], 1.8, k); this.stroke([[cx - 4, cy - 1], [cx, cy - 5], [cx + 4, cy - 1]], 1.8, k); }
    else if (kind === "down") { this.stroke([[cx, cy - 5], [cx, cy + 5]], 1.8, k); this.stroke([[cx - 4, cy + 1], [cx, cy + 5], [cx + 4, cy + 1]], 1.8, k); }
    else if (kind === "swap") { this.stroke([[cx - 5, cy - 2], [cx + 5, cy - 2]], 1.6, k); this.stroke([[cx + 2, cy - 5], [cx + 5, cy - 2], [cx + 2, cy + 1]], 1.6, k); this.stroke([[cx + 5, cy + 3], [cx - 5, cy + 3]], 1.6, k); this.stroke([[cx - 2, cy], [cx - 5, cy + 3], [cx - 2, cy + 6]], 1.6, k); }
    else if (kind === "plus") { this.stroke([[cx - 6, cy], [cx + 6, cy]], 2.4, k); this.stroke([[cx, cy - 6], [cx, cy + 6]], 2.4, k); }
    else this.dot(cx, cy, 2, k);
  }
  head(title, glyph, right) {                    // encabezado: iconito en círculo + título
    const p = this.pad; this.dot(p + 11, p + 11, 11, this.th.track[0], this.th.track[1]); this.glyph(glyph, p + 11, p + 11);
    this.text(title, p + 28, p + 4, { size: 11.5, font: "b", color: this.th.soft, w: this.W - 2 * p - 30 });
  }
  foot(label) {
    const p = this.pad, y = this.H - p - 11;
    this.text("FIPO", p, y, { size: 9.5, font: "h", color: this.th.soft, alpha: 0.9 });
    if (label) this.text(label + " ›", p + 40, y, { size: 10.5, font: "s", color: this.th.soft, align: "r", w: this.W - 2 * p - 40 });
  }
  kvs(items, y) {                                // fila de 3 cifras con línea arriba
    const p = this.pad, n = items.length, cw = (this.W - 2 * p) / n;
    this.hline(p, this.W - p, y, this.th.line[0]);
    this.c.setFillColor(this.col(this.th.line[0], this.th.line[1]));
    items.forEach((it, i) => {
      this.text(it[0], p + cw * i, y + 8, { size: 9.5, color: this.th.soft, w: cw - 4 });
      this.text(it[1], p + cw * i, y + 21, { size: fitSize(it[1], cw - 6, 13.5), font: "s", color: it[2] || this.th.ink, w: cw - 4 });
    });
  }
}

/* ------------------------------------------------------------------ widgets */
const R = {
  quick(cv) {
    const t = cv.th, p = cv.pad, big = cv.W > 200;
    cv.dot(p + 23, p + 25, 23, t.accent); cv.glyph("plus", p + 23, p + 25, t.bg);
    cv.text(big ? "Nuevo movimiento" : "Nuevo\nmovimiento", p, cv.H - p - 60, { size: big ? 19 : 16, font: "b", w: cv.W - 2 * p });
    cv.foot("");
  },
  summary(cv, d) {
    const t = cv.th, p = cv.pad, W = cv.W, H = cv.H, b = d.balance, m = d.month, cur = d.currency, big = H > 200, small = W < 200;
    let y = p;
    if (big) { cv.head("Resumen general", "bars"); y = p + 34; }
    cv.text("Saldo total", p, y, { size: 10.5, color: t.soft });
    const vs = small ? 22 : big ? 30 : 26;
    cv.text(money(b.value, cur), p, y + 14, { size: fitSize(money(b.value, cur), small ? W - 2 * p : W * 0.52 - p, vs), font: "h" });
    if (b.change_pct != null) cv.text("↗ " + pct(b.change_pct), p, y + 14 + vs * 1.25 + 2, { size: 11.5, font: "b", color: b.change_pct < 0 ? t.bad : t.good });
    if (small) cv.line(b.series, p, H - p - 52, W - 2 * p, 34);
    else cv.line(b.series, W * 0.54, y + 2, W * 0.46 - p, big ? 74 : 56);
    if (!small) cv.kvs([["Ingresos", money(m.income, cur)], ["Gastos", money(m.expense, cur)], ["Ahorro", money(m.savings, cur), m.savings < 0 ? t.bad : null]], big ? y + 104 : H - p - 56);
    if (big) {                                    // en el grande caben los últimos movimientos
      cv.text("Movimientos recientes", p, y + 152, { size: 10.5, font: "b", color: t.soft });
      rows(cv, d, y + 170, 3, true, false, 36);
    }
    cv.foot(big ? "Ver detalle" : "");
  },
  portfolio(cv, d) {
    const t = cv.th, p = cv.pad, W = cv.W, H = cv.H, cur = d.currency, pf = d.portfolio, big = H > 200, small = W < 200;
    if (big || !pf) cv.head("Portafolio", "trend");
    if (!pf) { cv.text("Tu portafolio está vacío", p, H / 2 - 8, { size: 13, color: t.soft }); cv.foot(""); return; }
    const top = big ? p + 34 : p, bh = big ? 120 : small ? H - 2 * p - 76 : 58, ly = big ? top + 14 : small ? top + 62 : top + 10;
    if (pf.series && pf.series.length > 2) cv.line(pf.series, small ? p : W * 0.42, ly, small ? W - 2 * p : W * 0.58 - p, bh); else if (pf.positions.length) bars(cv, pf.positions, small ? p : W * 0.5, ly, small ? W - 2 * p : W * 0.5 - p, bh);
    cv.text(small ? "Portafolio" : big ? "Valor actual" : "Portafolio", p, top, { size: 10.5, color: t.soft, font: big ? null : "b" });
    const v = money(pf.value, cur);
    cv.text(v, p, top + 14, { size: fitSize(v, W - 2 * p, small ? 22 : big ? 30 : 26), font: "h" });
    cv.text("↗ " + pct(pf.gain_pct), p, top + 14 + (small ? 28 : 34), { size: 11.5, font: "b", color: (pf.gain_pct || 0) < 0 ? t.bad : t.good });
    if (!small) cv.kvs(big ? [["Rendimiento", pct(pf.gain_pct), pf.gain < 0 ? t.bad : t.good], ["Ganancia", money(pf.gain, cur, true), pf.gain < 0 ? t.bad : t.good], ["Aporte", money(pf.cost, cur)]]
      : [["Rendimiento", pct(pf.gain_pct), pf.gain < 0 ? t.bad : t.good], ["Ganancia", money(pf.gain, cur, true), pf.gain < 0 ? t.bad : t.good], ["Hoy", money(pf.day_change, cur, true), pf.day_change < 0 ? t.bad : null]], big ? top + bh + 26 : H - p - 56);
    if (big) pf.positions.slice(0, 4).forEach((x, i) => { const y = top + bh + 86 + i * 24; cv.text(x.symbol, p, y, { size: 12, font: "s" }); cv.text(pct(x.pct), p + 80, y, { size: 12, font: "s", color: (x.pct || 0) < 0 ? t.bad : t.good, w: 80 }); cv.text(money(x.value, cur), p, y, { size: 12, align: "r", w: W - 2 * p }); });
    cv.foot(big ? "Ver portafolio" : "");
  },
  categories(cv, d) {
    const t = cv.th, p = cv.pad, W = cv.W, H = cv.H, c = d.categories, cur = d.currency, small = W < 200;
    if (!c.spent) { cv.head("Gastos", "bars"); cv.text("Aún no hay gastos este mes", p, H / 2 - 8, { size: 12.5, color: t.soft }); cv.foot(""); return; }
    const rows_ = c.items.map((i) => ({ name: clean(i.name), amount: i.amount })).concat(c.others > 0 ? [{ name: "Otros", amount: c.others }] : []).map((r) => Object.assign(r, { pct: Math.round(r.amount * 100 / c.spent) }));
    const sum = rows_.reduce((s, r) => s + r.pct, 0); if (rows_.length && sum !== 100) rows_[0].pct += 100 - sum;
    const SH = [1, 0.7, 0.46, 0.26], r0 = small ? 46 : H > 200 ? 62 : 52, cx = small ? W / 2 : p + r0 + 6, cy = small ? H / 2 - 4 : H > 200 ? p + r0 + 12 : H / 2;
    let f = 0; cv.arc(cx, cy, r0, 0, 0.9999, small ? 9 : 11, t.track[0], t.track[1]);
    rows_.forEach((r, i) => { const f1 = f + r.pct / 100; if (r.pct > 0) cv.arc(cx, cy, r0, f + 0.004, Math.max(f + 0.01, f1 - 0.004), small ? 9 : 11, t.accent, SH[i] == null ? 0.2 : SH[i]); f = f1; });
    if (!small) rows_.forEach((r, i) => { const x = cx + r0 + 22, y = cy - (rows_.length * (H > 200 ? 30 : 22)) / 2 + i * (H > 200 ? 30 : 22); cv.dot(x, y + 7, 4.5, t.accent, SH[i] == null ? 0.2 : SH[i]); cv.text(cut(r.name, 16), x + 12, y, { size: 12, w: W - x - 12 - p - 38 }); cv.text(r.pct + "%", x, y, { size: 12, font: "s", align: "r", w: W - x - p }); });
    const v = money(c.spent, cur), iw = (r0 - 8) * 2;
    cv.text(v, cx - iw / 2, cy - 10, { size: fitSize(v, iw, small ? 13 : 15), font: "b", align: "c", w: iw }); cv.text("este mes", cx - iw / 2, cy + 7, { size: 9, color: t.soft, align: "c", w: iw });
    if (!small && H < 200) return;
    cv.foot("");
  },
  goal(cv, d) {
    const t = cv.th, p = cv.pad, W = cv.W, cur = d.currency, g = d.goals.items.find((x) => x.id === d.goals.next_id);
    cv.text("Meta de ahorro", p, p + 3, { size: 11.5, font: "b", color: t.soft }); cv.dot(W - p - 11, p + 11, 11, t.track[0], t.track[1]); cv.glyph("target", W - p - 11, p + 11);
    if (!g) { cv.text("Aún no tienes metas", p, cv.H / 2 - 8, { size: 12.5, color: t.soft }); cv.foot(""); return; }
    cv.text(cut(clean(g.name), W < 200 ? 18 : 40), p, p + 34, { size: 13.5, font: "b", w: W - 2 * p });
    const v = money(g.saved, cur); cv.text(v, p, p + 54, { size: fitSize(v, W - 2 * p, 22), font: "h" });
    if (W < 200) cv.text("de " + money(g.target, cur), p, p + 54 + 27, { size: 10.5, color: t.soft });
    else cv.text("de " + money(g.target, cur), p, p + 62, { size: 11, color: t.soft, align: "r", w: W - 2 * p });
    if (cv.H > 200) { const cx = W / 2, cy = p + 170; cv.ring(cx, cy, 56, g.pct / 100, 10); cv.text(Math.round(g.pct) + "%", cx - 50, cy - 14, { size: 26, font: "h", align: "c", w: 100 }); cv.text("ahorrado", cx - 50, cy + 16, { size: 10, color: t.soft, align: "c", w: 100 }); }
    const by = cv.H - p - 34; cv.bar(p, by, W - 2 * p - 36, 7, g.pct); cv.text(Math.round(g.pct) + "%", p, by - 4, { size: 12, font: "b", align: "r", w: W - 2 * p });
    cv.foot("");
  },
  goals(cv, d) {
    const t = cv.th, p = cv.pad, W = cv.W, H = cv.H, cur = d.currency, items = d.goals.items.filter((g) => !g.done).slice(0, 3), big = H > 200;
    if (W < 200) return R.goal(cv, d);
    cv.head("Mis objetivos", "target");
    if (!items.length) { cv.text(d.goals.items.length ? "¡Completaste todas tus metas!" : "Aún no tienes metas", p, H / 2 - 8, { size: 12.5, color: t.soft }); cv.foot(""); return; }
    if (big) {
      const cw = (W - 2 * p) / 3;
      items.forEach((g, i) => { const cx = p + cw * i + cw / 2, cy = p + 90; cv.ring(cx, cy, 34, g.pct / 100, 5.5); cv.text(Math.round(g.pct) + "%", cx - 30, cy - 8, { size: 15, font: "h", align: "c", w: 60 });
        cv.text(cut(clean(g.name), 13), cx - cw / 2, cy + 48, { size: 12, font: "b", align: "c", w: cw }); cv.text(money(g.saved, cur) + "\n/ " + money(g.target, cur), cx - cw / 2, cy + 66, { size: 10, color: t.soft, align: "c", w: cw }); });
    } else items.forEach((g, i) => { const y = p + 34 + i * 33; cv.text(cut(clean(g.name), 26), p, y, { size: 12, font: "s", w: W - 2 * p - 50 }); cv.text(Math.round(g.pct) + "%", p, y, { size: 12, font: "s", align: "r", w: W - 2 * p }); cv.bar(p, y + 19, W - 2 * p, 6, g.pct); });
    cv.foot("Ver todos");
  },
  recent(cv, d) {
    const t = cv.th, p = cv.pad, H = cv.H, small = cv.W < 200;
    cv.head(small ? "Recientes" : "Movimientos recientes", "list");
    rows(cv, d, p + 34, H > 200 ? 6 : 3, true, small);
    if (H > 200) cv.foot("Ver todos");
  },
  health(cv, d) {
    const t = cv.th, p = cv.pad, W = cv.W, H = cv.H, h = d.health, s = h ? h.score_10 : null, small = W < 200, big = H > 200;
    const msg = s == null ? "Sin datos suficientes todavía" : s >= 8 ? "Vas muy bien encaminado" : s >= 6 ? "Bien, con áreas de mejora" : s >= 4 ? "Regular, conviene ajustar" : "Necesita atención";
    cv.head("SALUD FINANCIERA", "leaf");
    const f = s == null ? 0 : Math.max(0, Math.min(10, s)) / 10, lab = s != null && s > 10 ? "con plus" : "de 10";
    if (small) {
      cv.ring(W / 2, H / 2 + 6, 38, f, 7); cv.text(s == null ? "—" : s.toFixed(1), W / 2 - 40, H / 2 - 12, { size: 25, font: "h", align: "c", w: 80 }); cv.text(lab, W / 2 - 40, H / 2 + 16, { size: 10, color: t.soft, align: "c", w: 80 });
      cv.foot(""); return;
    }
    const ry = p + 34;
    cv.text(s == null ? "—" : s.toFixed(1), p, ry, { size: big ? 42 : 36, font: "h" }); cv.text("/ 10", p + (big ? 78 : 66), ry + (big ? 22 : 17), { size: 13, font: "s", color: t.soft });
    if (big) cv.text(msg, p, ry + 50, { size: 11, color: t.soft, w: W * 0.58 });
    if (h) [["Vida / Gastos", "living"], ["Ahorro", "savings"], ["Inversión", "investments"]].forEach(([l, k], i) => {
      const b = h.breakdown[k], v = Math.max(0, Math.min(100, b.points / (100 / 3) * 100)), y = ry + (big ? 76 : 48) + i * (big ? 34 : 19), bw = W * 0.28;
      cv.text(l, p, y, { size: big ? 12 : 11, font: "s", w: W * 0.34 }); if (big) cv.text(b.actual_pct + "% · meta " + b.target_pct + "%", p, y + 14, { size: 9.5, color: t.soft, w: W * 0.4 });
      cv.bar(W * 0.36, y + 4, bw, 6, v, b.bonus ? t.good : v < 60 ? t.warn : t.accent);
    });
    const rr = big ? 46 : 36; cv.ring(W - p - rr - 4, big ? p + 100 : H / 2 - 4, rr, f, 8);
    cv.text(s == null ? "—" : s.toFixed(1), W - p - rr * 2 - 8, (big ? p + 100 : H / 2 - 4) - 11, { size: big ? 24 : 21, font: "h", align: "c", w: rr * 2 + 8 }); cv.text(lab, W - p - rr * 2 - 8, (big ? p + 100 : H / 2 - 4) + 12, { size: 9.5, color: t.soft, align: "c", w: rr * 2 + 8 });
    if (big && h) cv.text("Con tus ingresos de " + h.month, p, H - p - 30, { size: 10, color: t.soft });
    if (big) cv.foot("Ver detalle");
  },
  budget(cv, d) {
    const t = cv.th, p = cv.pad, W = cv.W, H = cv.H, b = d.budget, cur = d.currency, small = W < 200;
    cv.head("Presupuesto", "wallet");
    if (!b) { cv.text("Aún no defines tu presupuesto", p, H / 2 - 8, { size: 12.5, color: t.soft, w: W - 2 * p }); cv.foot(""); return; }
    const st = b.status, col = st === "over" ? t.bad : st === "warn" ? t.warn : t.accent, y = p + 36, v = money(b.amount, cur);
    cv.text(v, p, y, { size: fitSize(v, W - 2 * p, small ? 22 : 26), font: "h" });
    cv.text("Gastado " + money(b.spent, cur), p, y + 34, { size: 10.5, color: t.soft, w: W - 2 * p - 40 }); cv.text(Math.round(b.pct) + "%", p, y + 33, { size: 12, font: "b", align: "r", w: W - 2 * p });
    cv.bar(p, y + 52, W - 2 * p, 7, b.pct, col);
    if (H > 200) { const cx = W / 2, cy = y + 150, rr = 52; cv.ring(cx, cy, rr, Math.min(b.pct, 100) / 100, 9, col); cv.text(Math.round(b.pct) + "%", cx - 50, cy - 14, { size: 24, font: "h", align: "c", w: 100 }); cv.text("usado", cx - 50, cy + 14, { size: 10, color: t.soft, align: "c", w: 100 }); }
    if (!small) { cv.text(b.remaining < 0 ? "Excedido" : "Disponible", p, y + 64, { size: 10.5, color: t.soft }); cv.text(money(Math.abs(b.remaining), cur), p, y + 63, { size: 12, font: "b", align: "r", color: b.remaining < 0 ? t.bad : t.ink, w: W - 2 * p }); }
    if (st !== "ok" && H > 200) cv.text(st === "over" ? "Has superado tu presupuesto" : "Estás cerca de tu límite", p, H - p - 28, { size: 10.5, font: "s", color: st === "over" ? t.bad : t.warn, w: W - 2 * p });
    cv.foot("");
  },
};

function bars(cv, pos, x, y, w, h) {             // si no hay línea de valor: barras de rendimiento por activo
  const mx = Math.max.apply(null, [1].concat(pos.map((q) => Math.abs(q.pct || 0)))), n = Math.min(pos.length, 8), bw = Math.min(26, (w / n) - 4);
  pos.slice(0, n).forEach((q, i) => { const bh = Math.max(6, (Math.abs(q.pct || 0) / mx) * h); cv.rrect(x + w - (n - i) * (bw + 4), y + h - bh, bw, bh, 4, (q.pct || 0) < 0 ? cv.th.bad : cv.th.accent); });
}
function rows(cv, d, y0, n, withCat, compact, stepIn) {
  const t = cv.th, p = cv.pad, W = cv.W, cur = d.currency, step = stepIn || (compact ? 33 : cv.H > 200 ? 40 : 34);
  const day = (iso) => { const now = new Date(), z = (x) => String(x).padStart(2, "0"), td = now.getFullYear() + "-" + z(now.getMonth() + 1) + "-" + z(now.getDate()), y = new Date(now.getTime() - 864e5), yd = y.getFullYear() + "-" + z(y.getMonth() + 1) + "-" + z(y.getDate());
    return iso === td ? "Hoy" : iso === yd ? "Ayer" : iso.slice(8) + "/" + iso.slice(5, 7); };
  d.recent.slice(0, n).forEach((x, i) => {
    const y = y0 + i * step, inc = x.type === "income" || x.type === "refund", sign = x.type === "expense" ? "−" : inc ? "+" : "";
    cv.dot(p + 14, y + 12, 14, t.track[0], t.track[1]); cv.glyph(x.type === "transfer" ? "swap" : inc ? "up" : "down", p + 14, y + 12);
    const nx = p + 36, aw = 92, name = clean(x.description || (x.type === "transfer" ? "Transferencia" : x.category_name || "Movimiento")), amt = sign + money(x.amount, x.currency || cur).replace("−", "");
    if (compact) {                                // chico: nombre arriba, monto abajo
      cv.text(cut(name, 13), nx, y, { size: 11.5, font: "s", w: W - nx - p });
      cv.text(amt, nx, y + 15, { size: 11, font: "s", color: inc ? t.good : t.soft, w: W - nx - p }); return;
    }
    cv.text(cut(name, 24), nx, y + 1, { size: 12, font: "s", w: W - nx - p - aw });
    if (withCat) cv.text(cut(clean(x.category_name || ""), 22), nx, y + 16, { size: 9.5, color: t.soft, w: W - nx - p - aw });
    cv.text(amt, nx, y + 1, { size: 12, font: "s", align: "r", color: inc ? t.good : t.ink, w: W - nx - p });
    if (withCat) cv.text(day(x.date), nx, y + 16, { size: 9.5, color: t.soft, align: "r", w: W - nx - p });
  });
}

/* ------------------------------------------------------------------ ejecución */
function wrap(id, d, family) {
  const th = themeFor(id, d && d.layout), size = widgetSize(family), cv = new Cv(size, th);
  if (d) R[id](cv, d); else R.quick(cv);
  const w = new ListWidget(), g = new LinearGradient();
  g.colors = [new Color(th.bg2), new Color(th.bg)]; g.locations = [0, 0.75]; g.startPoint = new Point(0, 0); g.endPoint = new Point(1, 1);
  w.backgroundGradient = g; w.setPadding(0, 0, 0, 0);
  const im = w.addImage(cv.c.getImage()); im.imageSize = size;
  return w;
}
const FAIL = (family) => {
  const w = new ListWidget(); w.backgroundColor = new Color("#4E5738"); w.setPadding(14, 14, 14, 14);
  const a = w.addText("FIPO"); a.font = Font.heavySystemFont(14); a.textColor = new Color("#F4F2E8");
  const b = w.addText("No se pudo cargar. Revisa tu conexión o genera un enlace nuevo en FIPO → Widgets."); b.font = Font.systemFont(11); b.textColor = new Color("#D7DCC5");
  return w;
};

const kind = (args.widgetParameter || "summary").trim().toLowerCase(), family = config.widgetFamily || "medium";
let widget;
try {
  const id = R[kind] ? kind : "summary";
  widget = kind === "quick" ? wrap("quick", null, family) : wrap(id, await new Request(URL_FIPO).loadJSON(), family);
  widget.url = URL_FIPO.replace(/\/api\/.*$/, "") + (kind === "quick" ? "/#/new" : "/#/dashboard");
  widget.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
} catch (e) { widget = FAIL(family); }
if (config.runsInWidget) Script.setWidget(widget);
else { if (family === "small") await widget.presentSmall(); else if (family === "large") await widget.presentLarge(); else await widget.presentMedium(); }
Script.complete();
