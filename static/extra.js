/* FIPO - Portafolio de inversiones e importación de estados de cuenta. */
"use strict";

const OP_LABEL = { buy: "Compra", sell: "Venta", dividend: "Dividendo", interest: "Interés" };
const ASSET_LABEL = { stock: "Acción", etf: "ETF", crypto: "Cripto", bond: "Bono", fund: "Fondo", gold: "Oro", other: "Otro" };
const gainCls = (v) => (v == null || v === 0 ? "" : v > 0 ? "pos" : "neg");
const pct = (v) => (v == null ? "" : (v > 0 ? "+" : "") + v.toFixed(2) + "%");
function fmtStamp(iso) {
  if (!iso) return "";
  try { return new Intl.DateTimeFormat("es-MX", { timeZone: S.user.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)); } catch { return iso; }
}
const sel = (name, label, options, value = "", attrs = "") => `<div class="field"><label for="f-${name}">${label}</label><select id="f-${name}" name="${name}" ${attrs}>${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>`;

/* ---------------------------------------------------------------- gráfica de precio */
function priceChart(points, cur) {
  const W = 640, H = 220, L = 52, R = 10, T = 10, B = 24;
  const ts = (t) => (t > 1e12 ? t : t * 1000);
  const xs = points.map((p) => ts(p[0])), vs = points.map((p) => p[1]);
  let min = Math.min(...vs), max = Math.max(...vs);
  if (min === max) { min -= 1; max += 1; }
  const pd = (max - min) * 0.08; min -= pd; max += pd;
  const t0 = xs[0], t1 = xs[xs.length - 1] || t0 + 1;
  const x = (t) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R), y = (v) => T + (H - T - B) * (1 - (v - min) / (max - min));
  const d = points.map((p, i) => `${i ? "L" : "M"} ${x(xs[i]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join(" ");
  const up = vs[vs.length - 1] >= vs[0], col = up ? "var(--income)" : "var(--expense)";
  let g = "";
  for (let i = 0; i <= 3; i++) { const v = min + ((max - min) / 3) * i; g += `<line class="grid-l" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${v.toFixed(v < 10 ? 2 : 0)}</text>`; }
  const dl = (t) => new Intl.DateTimeFormat("es-MX", { day: "2-digit", month: "short", year: "2-digit" }).format(new Date(t));
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Precio histórico">${g}<path d="${d} L ${x(t1)} ${H - B} L ${x(t0)} ${H - B} Z" fill="${col}" opacity=".10"/>
    <path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/><text x="${L}" y="${H - 6}">${dl(t0)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end">${dl(t1)}</text></svg>`;
}

/* ---------------------------------------------------------------- Portafolio */
function portfolioView(sym) { return sym ? portfolioDetailView(decodeURIComponent(sym)) : portfolioListView(); }

function updateLine(s) {
  if (window.FIPO_PREVIEW) return `<p class="muted small">Vista previa: fija los precios a mano.</p>`;
  const when = s.last_update ? `Precios al ${esc(fmtStamp(s.last_update))}` : "Precios sin actualizar";
  return `<p class="muted small" id="pf-upd">${when}${s.any_error ? ' · <span class="neg">algún precio no se actualizó</span>' : ""}</p>`;
}

/* ---------------------------------------------------------------- Vigilancia (tablita de precios objetivo) */
const WL_STATE = { above: ["En/sobre salida", "income"], in_range: ["En rango", "adjustment"], below: ["Bajo entrada", "expense"] };
let wlShowMain = false;                  // «ver en <moneda principal>»: se resetea al recargar la página
function watchRowHtml(w, C) {
  const main = w.main_currency || C;
  const foreign = !!(w.currency && w.currency !== main);
  const useMain = wlShowMain && foreign;
  const noFx = useMain && w.fx_rate == null;
  const rate = useMain && w.fx_rate != null ? w.fx_rate : 1;
  const dispCur = useMain && !noFx ? main : (w.currency || C);
  const fmt = (v) => (v == null ? "—" : esc(money(Math.round(v * rate * 100), dispCur)));
  const st = w.state ? WL_STATE[w.state] : null;
  const days = w.days_to_report;
  const when = days == null ? "" : days < 0 ? "ya reportó" : days === 0 ? "hoy" : days === 1 ? "mañana" : `en ${days} d`;
  return `<div class="pf-row wl-row" data-wl="${esc(w.symbol)}">
    <span class="desc"><b>${esc(w.symbol)}</b>${w.company ? `<span class="muted small">${esc(w.company)}</span>` : ""}${foreign ? `<span class="badge" style="margin-top:.25rem">${esc(dispCur)}${useMain && !noFx ? " · convertido" : ""}</span>` : ""}</span>
    <span class="c-p wl-cur" data-l="Actual">${w.price != null ? fmt(w.price) : '<span class="muted">Sin precio</span>'}</span>
    <span class="c-p wl-ent" data-l="Entrada">${fmt(w.entry_price)}</span>
    <span class="c-p wl-sal" data-l="Salida">${fmt(w.exit_price)}</span>
    <span class="small wl-st">${st ? `<span class="badge ${st[1]}">${st[0]}</span>` : '<span class="muted">—</span>'}${w.report_date ? `<div class="muted small">Reporta ${when} · ${esc(fmtDate(w.report_date, { day: "2-digit", month: "short", year: "2-digit" }))}</div>` : ""}${noFx ? '<div class="muted small">Sin tipo de cambio</div>' : ""}</span>
    <span class="wl-act"><button class="icon-btn" data-wl-edit="${esc(w.symbol)}" aria-label="Editar">${icon("edit")}</button><button class="icon-btn" data-wl-del="${esc(w.symbol)}" aria-label="Quitar">${icon("trash")}</button></span></div>`;
}
function watchSection(list, C) {
  const main = (list.find((w) => w.main_currency) || {}).main_currency || C;
  const anyForeign = list.some((w) => w.currency && w.currency !== main);
  return `<section class="card" style="margin-bottom:1rem"><h2>Vigilancia ${anyForeign ? `<button class="btn sm" id="wl-fx">${wlShowMain ? "Ver en moneda original" : "Ver todo en " + esc(main)}</button>` : ""}</h2>
    <p class="muted small" style="margin:-.5rem 0 .6rem">Símbolos que sigues, los tengas o no en tu portafolio</p>
    ${list.length ? `<div class="pf-head wl-head"><span>Símbolo</span><span class="c-p">Actual</span><span class="c-p">Entrada</span><span class="c-p">Salida</span><span>Estado</span><span></span></div>${list.map((w) => watchRowHtml(w, C)).join("")}`
      : '<div class="empty"><p>Sin símbolos en vigilancia. Agrega uno con tu precio de entrada y de salida, y opcionalmente la fecha de su próximo reporte.</p></div>'}
    <button class="btn sm" id="wl-new" style="margin-top:.6rem">${icon("plus")} Agregar símbolo</button></section>`;
}
function openWatchModal(existing) {
  const title = existing ? "Editar · " + existing.symbol : "Agregar a vigilancia";
  const curHint = existing && existing.currency ? ` (${existing.currency})` : "";
  const hint = existing
    ? (existing.currency ? `Precios en ${esc(existing.currency)}, la moneda en la que cotiza ${esc(existing.symbol)}.` : "Aún no se conoce la moneda de este símbolo; se detecta con la próxima actualización de precios.")
    : "Escribe los precios en la moneda en la que cotiza el símbolo (por ejemplo, dólares si es una acción de EE. UU.). FIPO detecta esa moneda sola en cuanto consulta el precio.";
  modalForm(title, "wl-f", `${!existing ? field("Símbolo", "symbol", 'required placeholder="Ej. GOOGL, MELI, BTC-USD"') : ""}
      <p class="muted small">${hint}</p>
      <div class="row2">${field("Precio de entrada" + curHint, "entry_price", 'inputmode="decimal"', existing?.entry_price ?? "")}${field("Precio de salida" + curHint, "exit_price", 'inputmode="decimal"', existing?.exit_price ?? "")}</div>
      <div class="row2">${field("Empresa (opcional)", "company", "", existing?.company ?? "")}${field("Fecha del próximo reporte (opcional)", "report_date", 'type="date"', existing?.report_date ?? "")}</div>`,
    existing ? "Guardar" : "Agregar", async (d, m) => {
      await api("PUT", "/api/watchlist", { symbol: existing ? existing.symbol : d.symbol, entry_price: d.entry_price, exit_price: d.exit_price, company: d.company, report_date: d.report_date });
      m.close(); toast("Guardado."); route();
    });
}
function renderWatch(list, C) {
  const wrap = $("#wl-wrap"); if (!wrap) return;
  wrap.innerHTML = watchSection(list, C);
  bindWatch(list, C);
}
function bindWatch(list, C) {
  $("#wl-new").onclick = () => openWatchModal(null);
  const fx = $("#wl-fx"); if (fx) fx.onclick = () => { wlShowMain = !wlShowMain; renderWatch(list, C); };
  $$("[data-wl-edit]").forEach((b) => b.onclick = () => openWatchModal(list.find((w) => w.symbol === b.dataset.wlEdit)));
  $$("[data-wl-del]").forEach((b) => b.onclick = async () => {
    if (!(await confirmDialog("¿Quitar de vigilancia?", "Se borran los precios y la fecha que guardaste para " + b.dataset.wlDel + "."))) return;
    try { await api("DELETE", "/api/watchlist/" + encodeURIComponent(b.dataset.wlDel)); toast("Quitado de vigilancia."); route(); } catch (e) { toast(e.message, "error"); }
  });
}

function portfolioListView() {
  const view = mountShell("portfolio", "Portafolio", `<button class="btn" id="pf-refresh">Actualizar precios</button><button class="btn primary" id="pf-new">${icon("plus")} Operación</button>`);
  $("#pf-new").onclick = () => opModal();
  $("#pf-refresh").onclick = async (e) => {
    e.target.disabled = true;
    try { const r = await api("POST", "/api/portfolio/refresh"); const n = Object.keys(r.failed || {}).length; toast(n ? `Se actualizaron ${r.updated.length}; ${n} no pudieron consultarse.` : "Precios actualizados.", n ? "error" : "ok"); route(); }
    catch (er) { toast(er.message, "error"); e.target.disabled = false; }
  };
  withRetry(view, async () => {
    const s = await api("GET", "/api/portfolio"), C = s.currency, t = s.totals;
    const tset = new Set((await api("GET", "/api/price-alerts")).filter((a) => a.active).map((a) => a.symbol));
    const wl = await api("GET", "/api/watchlist");
    if (!s.positions.length && !s.closed.length) {
      view.innerHTML = `<div class="card empty"><h2 style="justify-content:center">Tu portafolio está vacío</h2><p>Registra tu primera compra con su símbolo (por ejemplo AAPL, VOO, BTC-USD, WALMEX.MX). FIPO calcula tu costo promedio y ganancias, y consulta el precio cada hora.</p>
        <button class="btn primary" id="pf-e">${icon("plus")} Registrar una operación</button></div><div id="wl-wrap">${watchSection(wl, C)}</div>`;
      $("#pf-e").onclick = () => opModal(); bindWatch(wl, C); return;
    }
    const multi = !!(s.totals_all && s.positions.some((p) => p.currency !== C));
    const T = multi ? s.totals_all : t;                     // con acciones en dólares, el resumen va todo en pesos
    const row = (p) => `<div class="pf-row" role="link" tabindex="0" data-sym="${esc(p.symbol)}">
      <span class="desc"><b>${esc(p.symbol)}${tset.has(p.symbol) ? ` <span class="badge" title="Con precios objetivo">${icon("bell")}</span>` : ""}</b><span class="muted small">${esc(p.name !== p.symbol ? p.name : ASSET_LABEL[p.asset_type])}${(s.position_accounts || {})[p.symbol] ? " · " + esc(s.position_accounts[p.symbol].join(", ")) : ""}</span></span>
      <span class="c-q">${esc(p.quantity)}</span>
      <span class="c-p">${p.price != null ? esc(money(Math.round(p.price * 100), p.currency)) : '<span class="muted">Sin precio</span>'}${p.price_source === "manual" ? ' <span class="badge">manual</span>' : ""}</span>
      <span class="amt">${p.market_value != null ? esc(money(p.market_value, p.currency)) : "—"}</span>
      <span class="amt ${gainCls(p.unrealized)}">${p.unrealized != null ? esc(money(p.unrealized, p.currency, { sign: true })) + `<span class="small"> ${pct(p.unrealized_pct)}</span>` : "—"}</span></div>`;
    view.innerHTML = `${updateLine(s)}
      <section class="hero-light pf-hero" id="pf-hero"><div class="k">Ganancia no realizada${multi ? " · todo en " + esc(C) : ""}</div><div class="v ${gainCls(T.unrealized)}">${esc(money(T.unrealized, C, { sign: true }))}</div>
        ${T.unrealized_pct != null ? `<span class="delta ${T.unrealized_pct < 0 ? "down" : ""}">${icon("trend")}${esc(pct(T.unrealized_pct))}</span>` : ""}
        <div class="n">Valor de mercado <b>${esc(money(T.market_value, C))}</b> · costo ${esc(money(T.cost, C))}${multi && (s.fx || []).length ? ` · ${s.fx.map((f) => `1 ${esc(f.currency)} = ${esc(f.rate.toFixed(2))} ${esc(C)}`).join(", ")}` : ""}</div></section>
      ${(s.accounts || []).length ? `<div class="stat-rows">${s.accounts.map((a) => statRow("wallet", a.name, money(a.total, a.currency),
        `Efectivo ${money(a.cash, a.currency)} · Acciones ${money(a.holdings_value, a.currency)} (${a.positions})${a.currency !== C && a.total_main != null ? " · ≈ " + money(a.total_main, C) : ""}`, "", "#/accounts/" + a.id)).join("")}</div>` : ""}
      <div class="stat-rows">
        ${statRow("calendar", "Cambio de hoy", money(T.day_change, C, { sign: true }), "Según el cierre previo", gainCls(T.day_change))}
        ${statRow("trend", "Ganancia realizada", money(t.realized, C, { sign: true }), "Por ventas (costo promedio)", gainCls(t.realized))}
        ${statRow("coins", "Dividendos e intereses", money(t.income, C), "Acumulado")}
      </div>
      ${t.unpriced.length ? `<div class="note">Sin precio disponible: <b>${t.unpriced.map(esc).join(", ")}</b>. No se suman al valor de mercado. Abre el activo para fijar un precio manual o revisa el símbolo.</div>` : ""}
      ${s.other_currency.length && !(s.totals_all && !s.totals_all.missing.length) ? `<div class="note">Hay activos en otra moneda (${s.other_currency.map((o) => esc(o.symbol + " · " + o.currency)).join(", ")}) sin tipo de cambio: no se suman.</div>` : ""}
      <section class="card"><h2>Posiciones ${(() => { const ps = s.positions.filter((p) => p.unrealized_pct != null).sort((x, y) => y.unrealized_pct - x.unrealized_pct); if (!ps.length) return ""; const b = ps[0], w = ps[ps.length - 1]; return ps.length > 1 && w.unrealized_pct < 0 ? insight(`Peor: ${w.symbol} ${w.unrealized_pct}%`, "bad") : insight(`Mejor: ${b.symbol} ${b.unrealized_pct > 0 ? "+" : ""}${b.unrealized_pct}%`, b.unrealized_pct >= 0 ? "ok" : "bad"); })()}</h2>${s.positions.length ? `<div class="pf-head"><span>Activo</span><span class="c-q">Cantidad</span><span class="c-p">Precio</span><span class="amt">Valor</span><span class="amt">Ganancia</span></div>${s.positions.map(row).join("")}` : '<div class="empty">No tienes posiciones abiertas.</div>'}</section>
      ${s.closed.length ? `<section class="card" style="margin-top:1rem"><h2>Posiciones cerradas</h2>${s.closed.map((p) => `<div class="pf-row closed" role="link" tabindex="0" data-sym="${esc(p.symbol)}"><span class="desc"><b>${esc(p.symbol)}</b><span class="muted small">${esc(p.name)}</span></span><span></span><span></span><span></span><span class="amt ${gainCls(p.realized)}">${esc(money(p.realized, p.currency, { sign: true }))}</span></div>`).join("")}</section>` : ""}
      <div id="wl-wrap">${watchSection(wl, C)}</div>`;
    $$("[data-sym]", view).forEach((el) => { const open = () => go("#/portfolio/" + encodeURIComponent(el.dataset.sym)); el.onclick = open; el.onkeydown = (e) => { if (e.key === "Enter") open(); }; });
    bindWatch(wl, C);
    pfHeroLine();
  });
}

/* gráfica real del valor de tu portafolio, detrás del monto (reemplaza el relieve decorativo) */
async function pfHeroLine() {
  const hero = $("#pf-hero"); if (!hero) return;
  let r = null; try { r = await api("GET", "/api/portfolio/series"); } catch { return; }
  const vals = r && r.series; if (!vals || vals.length < 3 || !hero.isConnected) return;
  const W = 400, H = 100, pad = 6, mn = Math.min(...vals), mx = Math.max(...vals), sp = mx - mn || 1;
  const P = vals.map((v, i) => [(W * i) / (vals.length - 1), pad + (H - 2 * pad) * (1 - (v - mn) / sp)]);
  let d = `M${P[0][0].toFixed(1)} ${P[0][1].toFixed(1)}`;
  for (let i = 0; i < P.length - 1; i++) {
    const A = P[i - 1] || P[i], B = P[i], C = P[i + 1], E = P[i + 2] || C;
    d += ` C${(B[0] + (C[0] - A[0]) / 6).toFixed(1)} ${(B[1] + (C[1] - A[1]) / 6).toFixed(1)} ${(C[0] - (E[0] - B[0]) / 6).toFixed(1)} ${(C[1] - (E[1] - B[1]) / 6).toFixed(1)} ${C[0].toFixed(1)} ${C[1].toFixed(1)}`;
  }
  hero.insertAdjacentHTML("afterbegin", `<svg class="pf-line" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/></svg>`);
  hero.classList.add("has-line");
}

function portfolioDetailView(sym) {
  const view = mountShell("portfolio", sym);
  withRetry(view, async () => {
    const [s, o, als] = await Promise.all([api("GET", "/api/portfolio"), api("GET", "/api/portfolio/ops?symbol=" + encodeURIComponent(sym)), api("GET", "/api/price-alerts")]);
    const al = als.find((x) => x.symbol === sym) || null;
    const p = s.positions.find((x) => x.symbol === sym) || s.closed.find((x) => x.symbol === sym);
    if (!p) return go("#/portfolio");
    $(".topbar h1").innerHTML = `<button class="icon-btn" id="back" aria-label="Volver">${icon("back")}</button> ${esc(sym)} <span class="muted small">${esc(p.name !== sym ? p.name : "")}</span>`;
    $("#back").onclick = () => go("#/portfolio");
    const held = Number(p.quantity) > 0 || p.quantity == null;
    view.innerHTML = `${updateLine(s)}
      <div class="card" style="margin-bottom:1rem"><div class="muted small">${ASSET_LABEL[p.asset_type]} · ${p.currency}${p.price_source === "manual" ? " · precio manual" : ""}</div>
        <div style="font-size:2rem;font-weight:700;margin:.3rem 0">${p.price != null ? esc(money(Math.round(p.price * 100), p.currency)) : "Sin precio"}
          ${p.day_change_pct != null ? `<span class="small ${gainCls(p.day_change_pct)}"> ${pct(p.day_change_pct)} hoy</span>` : ""}</div>
        <div class="muted small">${p.price_time ? (p.price_source === "manual" ? "Precio fijado por ti el " : "Precio de mercado a las ") + esc(fmtStamp(p.price_time)) : ""}${p.last_error ? ` · <span class="neg">Último intento falló: ${esc(p.last_error)}</span>` : ""}</div>
        ${held ? `<div class="grid stats" style="margin:1rem 0 0"><div><div class="k muted small">Cantidad</div><b>${esc(p.quantity)}</b></div><div><div class="k muted small">Costo promedio</div><b>${p.avg_cost ? esc(money(Math.round(parseFloat(p.avg_cost) * 100), p.currency)) : "—"}</b></div>
          <div><div class="k muted small">Valor</div><b>${p.market_value != null ? esc(money(p.market_value, p.currency)) : "—"}</b></div>
          <div><div class="k muted small">No realizada</div><b class="${gainCls(p.unrealized)}">${p.unrealized != null ? esc(money(p.unrealized, p.currency, { sign: true })) : "—"}</b></div>
          <div><div class="k muted small">Realizada</div><b class="${gainCls(p.realized)}">${esc(money(p.realized, p.currency, { sign: true }))}</b></div></div>` : `<div class="muted">Posición cerrada · realizada <b class="${gainCls(p.realized)}">${esc(money(p.realized, p.currency, { sign: true }))}</b></div>`}
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:1rem"><button class="btn primary sm" id="d-op">${icon("plus")} Operación</button>
          ${held ? '<button class="btn sm" id="d-price">Fijar precio manual</button>' : ""}<a class="btn sm" id="d-yahoo" href="${esc(p.link)}" target="_blank" rel="noopener noreferrer">Ver en Yahoo Finance ↗</a></div></div>
      ${held ? targetCard(sym, p, al) : ""}
      <section class="card" style="margin-bottom:1rem"><h2>Precio <span class="key" id="rng"></span></h2><div id="chart"><div class="spinner"></div></div></section>
      <section class="card"><h2>Operaciones</h2>${o.ops.map((x) => `<div class="tx-row" style="grid-template-columns:80px minmax(0,1fr) auto auto" data-op="${x.id}">
        <span class="small">${esc(fmtDate(x.date, { day: "2-digit", month: "short", year: "2-digit" }))}</span>
        <span class="desc"><b>${OP_LABEL[x.kind]}${x.kind === "buy" || x.kind === "sell" ? " · " + esc(x.quantity) + " × " + esc(x.price) : ""}</b><span class="muted small">${x.account_id && accById(x.account_id) ? esc(accById(x.account_id).name) : "Sin cuenta ligada"}${x.fee ? " · comisión " + esc(money(x.fee, x.currency)) : ""}</span></span>
        <span class="amt">${esc(money(x.gross, x.currency))}</span>
        <span><button class="icon-btn" data-edit="${x.id}" aria-label="Editar operación">${icon("edit")}</button><button class="icon-btn" data-del="${x.id}" aria-label="Eliminar operación">${icon("trash")}</button></span></div>`).join("")}</section>`;
    if (held) bindTargets(sym, p, al);
    $("#d-op").onclick = () => opModal(null, { symbol: sym, asset_type: p.asset_type });
    const dp = $("#d-price"); if (dp) dp.onclick = () => {
      const m = openModal("Fijar precio manual", `<form id="pm" novalidate><p class="muted small">Para cuando Yahoo no tiene el precio. Se reemplaza en la próxima actualización.</p>${field("Precio por unidad (" + p.currency + ")", "price", 'inputmode="decimal" required')}
        <footer><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" type="submit">Guardar</button></footer></form>`, {
        onMount: (el) => { $("#pm", el).onsubmit = (e) => { e.preventDefault(); submitForm(e.target, async () => { await api("POST", "/api/portfolio/price", { symbol: sym, price: formData(e.target).price }); m.close(); toast("Precio guardado."); route(); }); }; } });
    };
    $$("[data-edit]", view).forEach((b) => b.onclick = () => opModal(o.ops.find((x) => x.id === +b.dataset.edit)));
    $$("[data-del]", view).forEach((b) => b.onclick = async () => {
      if (!(await confirmDialog("¿Eliminar operación?", "Se recalculará tu posición y, si estaba ligada a una cuenta, su saldo."))) return;
      try { await api("DELETE", "/api/portfolio/ops/" + b.dataset.del); toast("Operación eliminada."); const left = o.ops.length - 1; if (left) route(); else go("#/portfolio"); } catch (e) { toast(e.message, "error"); }
    });
    // gráfica: solo si se puede; si no, enlace a Yahoo Finance
    let rng = store.get("pf.range", "6mo");
    const drawChart = async () => {
      $("#rng").innerHTML = [["1mo", "1M"], ["6mo", "6M"], ["1y", "1A"], ["5y", "5A"]].map(([k, l]) => `<button class="chip ${rng === k ? "on" : ""}" data-r="${k}">${l}</button>`).join("");
      $$("[data-r]", view).forEach((b) => b.onclick = () => { rng = b.dataset.r; store.set("pf.range", rng); $("#chart").innerHTML = '<div class="spinner"></div>'; drawChart(); });
      let h;
      try { h = await api("GET", `/api/portfolio/history?symbol=${encodeURIComponent(sym)}&range=${rng}`); } catch (e) { h = { available: false, link: p.link, note: e.message }; }
      const box = $("#chart"); if (!box) return;
      box.innerHTML = h.available && h.points.length > 1 ? priceChart(h.points, p.currency) + (h.stale ? `<p class="muted small">Historial guardado de ${esc(fmtStamp(h.fetched_at))}; no se pudo actualizar ahora.</p>` : "")
        : `<div class="empty"><p>No se pudo obtener la gráfica de ${esc(sym)} en este momento.</p><a class="btn" href="${esc(h.link || p.link)}" target="_blank" rel="noopener noreferrer">Ver gráfica en Yahoo Finance ↗</a></div>`;
    };
    drawChart();
  });
}

function opModal(existing = null, preset = {}) {
  const e = existing || {}, accs = S.accounts.filter((a) => !a.archived || a.id === e.account_id);
  const m = openModal(existing ? "Editar operación" : "Nueva operación", `<form id="op-f" novalidate>
    <div class="row2">${sel("kind", "Tipo", Object.entries(OP_LABEL), e.kind || "buy")}${field("Símbolo", "symbol", 'required maxlength="20" placeholder="AAPL, VOO, BTC-USD" autocapitalize="characters"', e.symbol || preset.symbol || "")}</div>
    <div class="row2" id="qp"><div>${field("Cantidad", "quantity", 'inputmode="decimal"', e.quantity || "")}</div><div>${field("Precio por unidad", "price", 'inputmode="decimal"', e.price || "")}</div></div>
    <div id="amt-row" hidden>${field("Importe recibido", "amount", 'inputmode="decimal"', e.kind === "dividend" || e.kind === "interest" ? centsToInput(e.gross) : "")}</div>
    <div class="row2">${field("Comisión", "fee", 'inputmode="decimal"', e.fee ? centsToInput(e.fee) : "")}${field("Fecha", "date", 'type="date" required', e.date || todayStr())}</div>
    <div class="row2">${sel("asset_type", "Tipo de activo", Object.entries(ASSET_LABEL), e.asset_type || preset.asset_type || "stock")}${sel("account_id", "Cuenta de efectivo", [["", "Sin ligar a una cuenta"], ...accs.map((a) => [a.id, `${a.name} (${a.currency})`])], e.account_id || "")}</div>
    <p class="muted small">Con cuenta ligada, compras restan y ventas suman. No es gasto ni ingreso.</p>
    ${field("Notas", "notes", 'maxlength="500"', e.notes || "")}
    <footer><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" type="submit">Guardar</button></footer></form>`, {
    onMount: (el) => {
      const f = $("#op-f", el), sync = () => { const inc = ["dividend", "interest"].includes(f.kind.value); $("#qp", f).hidden = inc; $("#amt-row", f).hidden = !inc; };
      f.kind.onchange = sync; sync();
      f.onsubmit = (ev) => { ev.preventDefault(); submitForm(f, async () => {
        const d = formData(f); d.symbol = d.symbol.trim().toUpperCase();
        if (existing) await api("PUT", "/api/portfolio/ops/" + existing.id, d); else await api("POST", "/api/portfolio/ops", d);
        m.close(); await refreshCore(); toast("Operación guardada."); if (location.hash.startsWith("#/portfolio")) route(); else go("#/portfolio");
      }); };
    } });
}

/* ---------------------------------------------------------------- Importar estado de cuenta */
var uploadForm = async function (url, fd) {
  let res;
  try { res = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "X-Requested-With": "fipo" }, body: fd }); } catch { throw new ApiError("No se pudo conectar con el servidor.", 0); }
  let data = null; try { data = await res.json(); } catch { /* */ }
  if (!res.ok) { if (res.status === 401) onUnauthorized(); throw new ApiError((data && data.error) || (res.status === 413 ? "El archivo es demasiado grande." : "No se pudo leer el archivo."), res.status, data && data.field); }
  return data;
};

function importModal(accountId = "") {
  const accs = S.accounts.filter((a) => !a.archived);
  if (!accs.length) return toast("Primero crea una cuenta.", "error");
  const m = openModal("Importar estado de cuenta", "", { wide: true });
  const box = $(".modal", m.el);
  const head = box.querySelector("header");
  const body = document.createElement("div"); box.appendChild(body);
  let last = { accountId: accountId || accs[0].id, mapping: null, opts: { day_first: "1", invert: "0" } };

  const stepPick = (msg = "") => {
    body.innerHTML = `<form id="imp-f" novalidate><p class="muted small">CSV, Excel o PDF de tu banco. Revisas todo antes de guardar.</p>
      ${msg ? `<div class="alert warn" role="alert">${icon("alert")}<span>${esc(msg)}</span></div>` : ""}
      ${sel("account_id", "¿A qué cuenta pertenece?", accs.map((a) => [a.id, `${a.name} (${a.currency})`]), last.accountId)}
      <div class="field"><label for="f-file">Archivo</label><input id="f-file" name="file" type="file" accept=".csv,.txt,.xlsx,.xlsm,.pdf" required></div>
      <div class="row2">${sel("day_first", "Formato de fecha", [["1", "Día/Mes/Año (México)"], ["0", "Mes/Día/Año"]], last.opts.day_first)}${sel("invert", "Signo de los importes", [["0", "Normal (cargos negativos)"], ["1", "Invertido"]], last.opts.invert)}</div>
      <footer><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" type="submit">Leer archivo</button></footer></form>`;
    const f = $("#imp-f", body);
    f.onsubmit = (ev) => { ev.preventDefault(); if (!f.file.files.length) return toast("Elige un archivo.", "error");
      last.file = f.file.files[0]; last.accountId = f.account_id.value; last.opts = { day_first: f.day_first.value, invert: f.invert.value }; last.mapping = null; runParse(f); };
  };

  const runParse = (btnForm) => {
    const fd = new FormData();
    fd.append("file", last.file); fd.append("account_id", last.accountId); fd.append("day_first", last.opts.day_first); fd.append("invert", last.opts.invert);
    if (last.mapping) fd.append("mapping", JSON.stringify(last.mapping));
    const b = btnForm && $("button[type=submit]", btnForm); if (b) { b.disabled = true; b.textContent = "Leyendo…"; }
    uploadForm("/api/import/parse", fd).then(stepReview).catch((er) => { toast(er.message, "error"); if (b) { b.disabled = false; b.textContent = "Leer archivo"; } });
  };

  const stepReview = (res) => {
    const rows = res.rows, cur_ = res.account.currency;
    const cats = { expense: S.categories.filter((c) => c.kind === "expense" && !c.archived), income: S.categories.filter((c) => c.kind === "income" && !c.archived) };
    const catOpts = (k, v) => `<option value="">Sin categoría</option>` + cats[k].map((c) => `<option value="${c.id}" ${c.id === v ? "selected" : ""}>${esc(c.name)}</option>`).join("");
    const canMap = res.columns && res.columns.length;
    const colOpts = (k) => `<option value="">—</option>` + res.columns.map((c, i) => `<option value="${i}" ${res.mapping && res.mapping[k] === i ? "selected" : ""}>${esc(c || "Columna " + (i + 1))}</option>`).join("");
    body.innerHTML = `<div class="note">${esc(res.filename)} → <b>${esc(res.account.name)}</b>. Encontré <b>${rows.length}</b> movimientos${rows.filter((r) => r.duplicate).length ? `; <b>${rows.filter((r) => r.duplicate).length}</b> parecen ya registrados y vienen desmarcados` : ""}. Revisa antes de guardar.</div>
      ${(res.warnings || []).map((w) => `<div class="alert warn">${icon("alert")}<span>${esc(w)}</span></div>`).join("")}
      ${canMap ? `<details style="margin-bottom:.8rem"><summary class="small" style="cursor:pointer">¿Las columnas están mal? Ajustarlas</summary><form id="map-f" class="map-grid">${[["date", "Fecha"], ["description", "Descripción"], ["amount", "Importe (una columna)"], ["debit", "Cargo"], ["credit", "Abono"], ["balance", "Saldo"]].map(([k, l]) => `<div class="field"><label>${l}</label><select name="${k}">${colOpts(k)}</select></div>`).join("")}<button class="btn sm" type="submit">Volver a leer</button></form></details>` : ""}
      ${rows.length ? `<div class="imp-scroll"><table class="imp"><thead><tr><th><input type="checkbox" id="all" checked aria-label="Seleccionar todo"></th><th>Fecha</th><th>Descripción</th><th>Categoría</th><th class="r">Importe</th></tr></thead><tbody>
        ${rows.map((r) => { const k = r.amount > 0 ? "income" : "expense"; return `<tr data-i="${r.idx}" class="${r.duplicate ? "dup" : ""}"><td><input type="checkbox" class="ck" ${r.duplicate ? "" : "checked"} aria-label="Incluir"></td><td>${esc(fmtDate(r.date, { day: "2-digit", month: "short", year: "2-digit" }))}</td>
          <td>${esc(r.description || "(sin descripción)")}${r.duplicate ? ' <span class="badge">posible duplicado</span>' : ""}${["default", "keyword"].includes(r.confidence) ? ' <span class="badge demo">verifica signo</span>' : ""}</td>
          <td><select class="cat" aria-label="Categoría">${catOpts(k, r.category_id)}</select></td><td class="r amt ${r.amount >= 0 ? "pos" : "neg"}">${esc(money(r.amount, cur_, { sign: true, mask: false }))}</td></tr>`; }).join("")}</tbody></table></div>
        <p class="small" id="imp-sum"></p>` : '<div class="empty">No se encontraron movimientos con esta configuración.</div>'}
      <footer><button class="btn" id="imp-back">Elegir otro archivo</button>${rows.length ? '<button class="btn primary" id="imp-go">Guardar movimientos</button>' : ""}</footer>`;
    $("#imp-back", body).onclick = () => stepPick();
    const mf = $("#map-f", body);
    if (mf) mf.onsubmit = (ev) => { ev.preventDefault(); const d = formData(mf); last.mapping = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== "").map(([k, v]) => [k, +v])); const fd = new FormData(); fd.append("file", last.file); fd.append("account_id", last.accountId); fd.append("day_first", last.opts.day_first); fd.append("invert", last.opts.invert); fd.append("mapping", JSON.stringify(last.mapping));
      uploadForm("/api/import/parse", fd).then(stepReview).catch((er) => toast(er.message, "error")); };
    if (!rows.length) return;
    const trs = $$("tbody tr", body);
    const sum = () => { const sel_ = trs.filter((t) => $(".ck", t).checked); const tot = sel_.reduce((a, t) => a + rows[+t.dataset.i].amount, 0); $("#imp-sum", body).innerHTML = `Se guardarán <b>${sel_.length}</b> movimientos · neto <b>${esc(money(tot, cur_, { sign: true, mask: false }))}</b>`; $("#imp-go", body).disabled = !sel_.length; };
    $$(".ck", body).forEach((c) => c.onchange = sum); $("#all", body).onchange = (e) => { $$(".ck", body).forEach((c) => c.checked = e.target.checked); sum(); }; sum();
    $("#imp-go", body).onclick = async (ev) => {
      const chosen = trs.filter((t) => $(".ck", t).checked).map((t) => { const r = rows[+t.dataset.i]; return { date: r.date, description: r.description, amount: r.amount, category_id: +$(".cat", t).value || null }; });
      ev.target.disabled = true;
      try { const r = await api("POST", "/api/import/commit", { account_id: res.account.id, filename: res.filename, kind: res.kind || "", rows: chosen }); m.close(); await refreshCore(); toast(`Se importaron ${r.created} movimientos.`); route(); }
      catch (er) { toast(er.message, "error"); ev.target.disabled = false; }
    };
  };
  stepPick();
}

async function importsHistory(host, redraw) {
  const r = await api("GET", "/api/imports");
  host.innerHTML = r.imports.length ? `<h3 style="margin:1rem 0 .4rem">Importaciones recientes</h3>${r.imports.map((i) => `<div class="tx-row" style="grid-template-columns:minmax(0,1fr) auto"><span class="desc"><b>${esc(i.filename || "Archivo")}</b><span class="muted small">${esc(i.account_name)} · ${esc(fmtStamp(i.created_at))} · ${i.remaining} movimientos</span></span><button class="btn sm danger" data-undo="${i.id}">Deshacer</button></div>`).join("")}` : "";
  $$("[data-undo]", host).forEach((b) => b.onclick = async () => {
    if (!(await confirmDialog("¿Deshacer importación?", "Se eliminarán los movimientos que trajo este archivo (los que no hayas editado a mano se borran igual). Los saldos se recalculan solos.", "Deshacer"))) return;
    try { const d = await api("DELETE", "/api/imports/" + b.dataset.undo); await refreshCore(); toast(`Se eliminaron ${d.deleted} movimientos.`); redraw(); } catch (e) { toast(e.message, "error"); }
  });
}
