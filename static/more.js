/* FIPO - Fases 2 y 3: tarjetas, deudas, presupuestos, análisis, reportes, metas, tablas y comprobantes. */
"use strict";

const bar = (pct, cls = "") => `<div class="track" role="progressbar" aria-valuenow="${Math.round(Math.min(100, pct))}" aria-valuemin="0" aria-valuemax="100"><i class="fill ${cls}" style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>`;
const utilCls = (p) => (p >= 80 ? "bad" : p >= 50 ? "mid" : "");
const monthKey = () => todayStr().slice(0, 7);
const shiftMonth = (k, n) => { let [y, m] = k.split("-").map(Number); m += n; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return `${y}-${String(m).padStart(2, "0")}`; };
const monthLabel = (k) => { const [y, m] = k.split("-").map(Number); const s = new Intl.DateTimeFormat("es-MX", { month: "long", year: "numeric" }).format(new Date(y, m - 1, 1)); return s.charAt(0).toUpperCase() + s.slice(1); };
const emptyCard = (title, text, btnId, btnLabel) => `<div class="card empty"><h2 style="justify-content:center">${title}</h2><p>${text}</p>${btnId ? `<button class="btn primary" id="${btnId}">${icon("plus")} ${btnLabel}</button>` : ""}</div>`;
const dayText = (d) => (d ? fmtDate(d, { day: "numeric", month: "short" }) : "—");
const modalForm = (title, id, bodyHtml, submitLabel, onSubmit, opts = {}) => {
  const m = openModal(title, `<form id="${id}" novalidate>${bodyHtml}<footer><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" type="submit">${submitLabel}</button></footer></form>`, {
    ...opts, onMount: (el) => { const f = $("#" + id, el); f.onsubmit = (e) => { e.preventDefault(); submitForm(f, async () => { await onSubmit(formData(f), m, f); }); }; if (opts.onMount) opts.onMount(el, f); } });
  return m;
};

/* ---------------------------------------------------------------- Más (móvil) */
const SECTIONS = [["cards", "Tarjetas", "card", "Límite, corte y pagos"], ["recurring", "Pagos recurrentes", "repeat", "Suscripciones que se registran solas"], ["debts", "Deudas", "debt", "Préstamos y abonos"], ["budgets", "Presupuestos", "target", "Límites por categoría"],
  ["portfolio", "Portafolio", "trend", "Inversiones y precios"], ["goals", "Metas", "flag", "Ahorro con objetivo"], ["analysis", "Análisis", "chart", "Tendencias y proyección"],
  ["reports", "Reportes", "file", "PDF y CSV del periodo"], ["tables", "Tablas", "table", "Tus propias hojas"], ["receipts", "Comprobantes", "camera", "Fotos con lectura OCR"], ["settings", "Configuración", "sliders", "Perfil, datos, seguridad"]];
function moreView() {
  const view = mountShell("more", "Más");
  const descOf = Object.fromEntries(SECTIONS.map(([k, l, ic, d]) => [k, [l, ic, d]]));
  view.innerHTML = `<div class="grid more-grid" style="margin-top:.4rem"><a class="card more-item" href="#/widgets">${icon("widgets")}<span><b>Widgets</b><span class="muted small">Tu dashboard personalizable</span></span></a></div>` + NAV_GROUPS.map((g) => {
    const items = g.items.filter(([k]) => descOf[k]);
    if (!items.length) return "";
    return `<div class="lbl" style="margin:1.1rem 0 .5rem">${esc(g.label)}</div><div class="grid more-grid">${items.map(([k]) => { const [l, ic, d] = descOf[k]; return `<a class="card more-item" href="#/${k}">${icon(ic)}<span><b>${l}</b><span class="muted small">${d}</span></span></a>`; }).join("")}</div>`;
  }).join("");
}

/* ---------------------------------------------------------------- Tarjetas */
function cardsView() {
  const view = mountShell("cards", "Tarjetas de crédito", `<button class="btn primary" id="card-new">${icon("plus")} Tarjeta</button>`);
  $("#card-new").onclick = () => accountModal(null, { type: "credit" });
  withRetry(view, async () => {
    const [r, rec] = await Promise.all([api("GET", "/api/cards"), api("GET", "/api/recurring").catch(() => ({ items: [] }))]), C = r.currency;
    if (!r.cards.length) { view.innerHTML = emptyCard("Aún no tienes tarjetas", "Registra tu tarjeta con su límite y sus días de corte y pago. Las compras se capturan como gastos en esa tarjeta y los pagos como transferencias desde tu cuenta: no cuentan como gasto dos veces.", "c-e", "Agregar tarjeta"); $("#c-e").onclick = () => accountModal(null, { type: "credit" }); return; }
    const t = r.totals;
    const recOf = (id) => rec.items.filter((x) => x.account_id === id && x.active);
    const planHtml = (p, cur) => `<div class="plan-item ${p.finished ? "done" : ""}">
        <div class="grow"><b>${esc(p.description)}</b>
          <div class="muted small">${esc(p.kind_label)} · ${p.installments_done} de ${p.months_total}${p.finished ? " · liquidado" : p.end_date ? " · termina " + esc(fmtDate(p.end_date, { month: "short", year: "numeric" })) : ""}${p.interest_per_installment ? ` · ${esc(money(p.interest_per_installment, cur))} de interés c/u` : ""}</div>
          ${bar(p.installments_done * 100 / p.months_total, p.finished ? "ok" : "")}</div>
        <div class="right"><b>${esc(money(p.monthly_amount, cur))}</b><div class="muted small">al mes</div>
          <button class="icon-btn" data-del-plan="${p.id}" data-linked="${p.transaction_id ? 1 : 0}" aria-label="Quitar plan">${icon("trash")}</button></div></div>`;
    view.innerHTML = `<div class="grid stats">
      <div class="card stat hero"><div class="k">Pago del mes (todas)</div><div class="v">${esc(money(t.pending, C))}</div><div class="n">Para no generar intereses, según tu día de corte</div></div>
      <div class="card stat"><div class="k">Deuda total en tarjetas</div><div class="v">${esc(money(t.used, C))}</div><div class="n">${t.limit ? `de ${esc(money(t.limit, C))} de límite` : "Sin límite configurado"}</div></div></div>
      <div class="grid acc-grid">${r.cards.map((c) => { const cur = c.currency, st = c.statement, active = c.plans.filter((p) => !p.finished), recs = recOf(c.id);
        return `<article class="card cc ${c.archived ? "archived" : ""}"><div class="muted small">${esc(c.institution || "Tarjeta de crédito")} · ${cur}${c.archived ? " · archivada" : ""}</div>
        <h3 style="margin:.2rem 0">${esc(c.name)}</h3>
        ${st ? `<div class="cc-pay"><div class="k">Pago del mes${c.next_due ? " · vence " + esc(dayText(c.next_due)) : ""}</div><div class="v">${esc(money(st.pending, cur))}</div>
          <div class="muted small">Corte del ${esc(dayText(st.cut_date))}: ${esc(money(st.to_pay_at_cut, cur))}${st.paid_since ? ` · ya pagaste ${esc(money(st.paid_since, cur))}` : ""}</div></div>`
          : `<div class="note small">Agrega el día de corte y el de pago (botón ${icon("edit")}) para calcular tu pago del mes.</div>`}
        <div class="cc-rows">
          <div><span>Deuda total</span><b class="${c.used ? "neg" : ""}">${esc(money(c.used, cur))}</b></div>
          ${c.deferred_now ? `<div><span>A meses (aún no se cobra)</span><b>${esc(money(c.deferred_now, cur))}</b></div>` : ""}
          ${st ? `<div><span>Compras nuevas desde el corte</span><b>${esc(money(st.new_charges, cur))}</b></div>` : ""}
          ${c.credit_in_favor ? `<div><span>Saldo a favor</span><b class="pos">${esc(money(c.credit_in_favor, cur))}</b></div>` : ""}
          <div><span>Próximo corte</span><b>${esc(dayText(c.next_cut))}</b></div>
        </div>
        ${c.limit ? `${bar(c.utilization, utilCls(c.utilization))}<div class="muted small">${c.utilization}% del límite · disponible <b>${esc(money(c.available, cur))}</b></div>` : '<div class="muted small">Define un límite para ver tu uso.</div>'}
        ${c.plans.length ? `<details class="cc-sec" ${active.length ? "open" : ""}><summary>${icon("chevron")} Compras a meses (${active.length} ${active.length === 1 ? "activa" : "activas"}${c.installments_monthly ? ` · ${esc(money(c.installments_monthly, cur))}/mes` : ""})</summary>${c.plans.map((p) => planHtml(p, cur)).join("")}</details>` : ""}
        ${recs.length ? `<details class="cc-sec"><summary>${icon("chevron")} Cargos recurrentes (${recs.length})</summary>${recs.map((x) => `<div class="plan-item"><div class="grow"><b>${esc(x.description)}</b><div class="muted small">${esc(x.frequency_label)} · próximo ${esc(dayText(x.next_date))}</div></div><div class="right"><b>${esc(money(x.amount, cur))}</b></div></div>`).join("")}<a class="small" href="#/recurring">Administrar pagos recurrentes</a></details>` : ""}
        <div class="cc-actions">${c.archived ? "" : `<button class="btn primary sm" data-pay="${c.id}">Pagar tarjeta</button><button class="btn sm" data-buy="${c.id}">Registrar compra</button>`}
          <button class="btn sm" data-more="${c.id}">${icon("plus")} Más opciones</button></div></article>`; }).join("")}</div>`;
    $$("[data-buy]", view).forEach((b) => b.onclick = () => txModal(null, { type: "expense", account_id: +b.dataset.buy }));
    $$("[data-pay]", view).forEach((b) => b.onclick = () => payCardModal(r.cards.find((c) => c.id === +b.dataset.pay)));
    $$("[data-more]", view).forEach((b) => b.onclick = () => {
      const c = r.cards.find((x) => x.id === +b.dataset.more);
      const m = openModal(c.name, `<div class="menu-list">
        <button type="button" data-a="plan">${icon("card")}<span><b>Agregar compra a meses que ya traes</b><span class="muted small">Separa de tu deuda lo que va a MSI, con intereses o diferido</span></span></button>
        <button type="button" data-a="rec">${icon("repeat")}<span><b>Agregar cargo recurrente</b><span class="muted small">Netflix, teléfono, gimnasio… se registra solo cada mes</span></span></button>
        <button type="button" data-a="mov">${icon("list")}<span><b>Ver movimientos</b></span></button>
        <button type="button" data-a="edit">${icon("edit")}<span><b>Editar tarjeta</b><span class="muted small">Límite, días de corte y de pago</span></span></button></div>`);
      m.el.addEventListener("click", (e) => { const x = e.target.closest("[data-a]"); if (!x) return; m.close();
        ({ plan: () => planModal(c), rec: () => recurringModal(null, { account_id: c.id }), mov: () => go("#/accounts/" + c.id), edit: () => accountModal(accById(c.id)) })[x.dataset.a](); });
    });
    $$("[data-del-plan]", view).forEach((b) => b.onclick = async () => {
      const linked = b.dataset.linked === "1";
      if (!(await confirmDialog("¿Quitar este plan a meses?", linked ? "La compra sigue registrada; solo dejará de separarse a meses (todo su saldo contará en el pago del mes)." : "Tu deuda total no cambia; solo dejará de separarse esa parte a meses.", "Quitar"))) return;
      try { await api("DELETE", "/api/cards/plans/" + b.dataset.delPlan); toast("Plan quitado."); route(); } catch (e) { toast(e.message, "error"); }
    });
  });
}
/* ---------------------------------------------------------------- Pagos recurrentes */
function recurringModal(item = null, preset = {}) {
  const accs = S.accounts.filter((a) => !a.archived || (item && item.account_id === a.id));
  if (!accs.length) return toast("Primero crea una cuenta o tarjeta.", "error");
  const accId = item ? item.account_id : preset.account_id || (accs.find((a) => a.type === "credit") || accs[0]).id;
  const cats = categoryOptions("expense", item ? item.category_id : null);
  modalForm(item ? "Editar cargo recurrente" : "Nuevo cargo recurrente", "rc-f", `<p class="muted small">Se registra solo el día que toca.</p>
    ${field("¿Qué es?", "description", 'maxlength="80" required placeholder="Netflix, plan del teléfono, gimnasio…"', item?.description ?? "")}
    <div class="row2">${field("Importe", "amount", 'inputmode="decimal" required placeholder="0.00"', item ? centsToInput(item.amount) : "")}${sel("frequency", "Cada cuánto", [["monthly", "Cada mes"], ["weekly", "Cada semana"], ["yearly", "Cada año"]], item?.frequency ?? "monthly")}</div>
    ${sel("account_id", "Se cobra en", accs.map((a) => [a.id, `${a.name}${a.type === "credit" ? " (tarjeta)" : ""}`]), accId)}
    ${sel("category_id", "Categoría", [["", "Sin categoría"], ...cats], item?.category_id ?? "")}
    ${field("Próximo cargo", "next_date", 'type="date" required', item?.next_date ?? todayStr())}
    <p class="muted small">Si la fecha es hoy o ya pasó, se registra en cuanto guardes.</p>`,
  item ? "Guardar" : "Programar cargo", async (d, m) => { await api(item ? "PATCH" : "POST", item ? "/api/recurring/" + item.id : "/api/recurring", d); m.close(); await refreshCore(); toast(item ? "Cargo actualizado." : "Cargo programado."); route(); });
}
function recurringView() {
  const view = mountShell("recurring", "Pagos recurrentes", `<button class="btn primary" id="rc-new">${icon("plus")} Cargo recurrente</button>`);
  $("#rc-new").onclick = () => recurringModal();
  withRetry(view, async () => {
    const r = await api("GET", "/api/recurring"), C = r.currency;
    if (!r.items.length) { view.innerHTML = emptyCard("Sin pagos recurrentes", "Programa tus suscripciones y pagos fijos (Netflix, teléfono, gimnasio, seguros…). El día que toca, FIPO los registra solos en la tarjeta o cuenta que elijas.", "rc-e", "Programar el primero"); $("#rc-e").onclick = () => recurringModal(); return; }
    view.innerHTML = `<div class="grid stats"><div class="card stat hero"><div class="k">Pagos recurrentes al mes</div><div class="v">${esc(money(r.monthly_total, C))}</div><div class="n">${r.items.filter((x) => x.active).length} activos · semanales y anuales convertidos a su equivalente mensual</div></div></div>
      <section class="card">${r.items.map((x) => `<div class="rec-row ${x.active ? "" : "paused"}">
        <span class="tx-ico ${x.active ? "expense" : ""}">${icon("repeat")}</span>
        <div class="grow"><b>${esc(x.description)}</b><div class="muted small">${esc(x.frequency_label)} · ${esc(x.account_name)}${x.category_name ? " · " + esc(x.category_name) : ""}</div>
          <div class="small">${x.active ? `Próximo: <b>${esc(fmtDate(x.next_date, { weekday: "short", day: "numeric", month: "short" }))}</b>` : '<span class="muted">En pausa</span>'}</div></div>
        <b class="rec-amt">${esc(money(x.amount, x.currency))}</b>
        <div class="rec-actions"><button class="btn sm" data-toggle="${x.id}">${x.active ? "Pausar" : "Reanudar"}</button><button class="btn sm" data-edit-rec="${x.id}">${icon("edit")} Editar</button><button class="icon-btn" data-del-rec="${x.id}" aria-label="Eliminar">${icon("trash")}</button></div></div>`).join("")}</section>`;
    const byId = (id) => r.items.find((x) => x.id === +id);
    $$("[data-toggle]", view).forEach((b) => b.onclick = async () => { const x = byId(b.dataset.toggle); try { await api("PATCH", "/api/recurring/" + x.id, { active: !x.active }); toast(x.active ? "Pausado." : "Reanudado."); route(); } catch (e) { toast(e.message, "error"); } });
    $$("[data-edit-rec]", view).forEach((b) => b.onclick = () => recurringModal(byId(b.dataset.editRec)));
    $$("[data-del-rec]", view).forEach((b) => b.onclick = async () => { const x = byId(b.dataset.delRec);
      if (!(await confirmDialog("¿Eliminar este cargo recurrente?", `Dejará de registrarse «${x.description}». Lo que ya se registró se queda en tus movimientos.`))) return;
      try { await api("DELETE", "/api/recurring/" + x.id); toast("Eliminado."); route(); } catch (e) { toast(e.message, "error"); } });
  });
}
function planModal(c) {
  const kindOpts = Object.entries(PLAN_KINDS).map(([k, l]) => [k, l]);
  modalForm("Compra a meses que ya traes", "pl-f", `<p class="muted small">Para compras que ya están dentro de la deuda de <b>${esc(c.name)}</b>. Tu deuda total no cambia: FIPO solo separa qué parte va a meses para calcular bien tu pago del mes. (Las compras nuevas a meses regístralas con "Registrar compra".)</p>
    ${sel("kind", "Tipo", kindOpts, "msi")}${field("¿Qué compraste?", "description", 'maxlength="80" placeholder="Opcional"')}
    <div class="row3">${field("Mensualidad", "monthly_amount", 'inputmode="decimal" required placeholder="0.00"')}${field("Meses que faltan", "months_remaining", 'inputmode="numeric" required placeholder="4"')}${field("De cuántos", "months_total", 'inputmode="numeric" required placeholder="12"')}</div>
    <div id="pl-int" class="row2 hidden">${field("Saldo pendiente del plan", "principal_remaining", 'inputmode="decimal" placeholder="Opcional"')}${field("Tasa anual %", "interest_rate", 'inputmode="decimal" placeholder="Opcional"')}</div>`,
  "Agregar", async (d, m) => { await api("POST", `/api/cards/${c.id}/plans`, d); m.close(); toast("Plan agregado."); route(); },
  { onMount: (el) => { const k = $("#f-kind", el), box = $("#pl-int", el); const s = () => box.classList.toggle("hidden", k.value === "msi"); k.onchange = s; s(); } });
}
function payCardModal(c) {
  const src = S.accounts.filter((a) => !a.archived && a.type !== "credit" && a.currency === c.currency);
  if (!src.length) return toast(`Necesitas una cuenta de dinero en ${c.currency} desde la cual pagar.`, "error");
  const def = c.statement && c.statement.pending ? c.statement.pending : c.used;
  modalForm("Pagar " + c.name, "pay-f", `<p class="muted small">Es una transferencia: no cuenta como gasto.</p>
    ${sel("from_account_id", "Pagar desde", src.map((a) => [a.id, `${a.name} · ${money(a.balance, a.currency, { mask: false })}`]))}
    ${field("Importe", "amount", 'inputmode="decimal" required', centsToInput(def))}${field("Fecha", "date", 'type="date" required', todayStr())}`, "Registrar pago",
  async (d, m) => { await api("POST", `/api/cards/${c.id}/pay`, d); m.close(); await refreshCore(); toast("Pago registrado."); route(); });
}

/* ---------------------------------------------------------------- Deudas */
function debtModal(debt = null) {
  modalForm(debt ? "Editar deuda" : "Nueva deuda", "d-f", `${field("Nombre", "name", 'maxlength="80" required placeholder="Préstamo del coche, crédito personal…"', debt?.name ?? "")}
    ${field("Acreedor", "creditor", 'maxlength="80" placeholder="Banco o persona"', debt?.creditor ?? "")}
    <div class="row2">${field("Monto original", "principal", 'inputmode="decimal" required', debt ? centsToInput(debt.principal) : "")}
      <div class="field"><label for="f-currency">Moneda</label><select id="f-currency" name="currency">${S.currencies.map((c) => `<option ${(debt?.currency ?? cur()) === c ? "selected" : ""}>${c}</option>`).join("")}</select></div></div>
    <div class="row2">${field("Tasa anual (%)", "interest_rate", 'inputmode="decimal" placeholder="0"', debt?.interest_rate ?? "")}${field("Fecha de inicio", "start_date", 'type="date"', debt?.start_date ?? todayStr())}</div>
    <div class="row2">${field("Pago mensual", "monthly_payment", 'inputmode="decimal" placeholder="0"', debt && debt.monthly_payment ? centsToInput(debt.monthly_payment) : "")}${field("Día de pago (1-31)", "due_day", 'inputmode="numeric" placeholder="0 = sin día"', debt?.due_day || "")}</div>
    ${field("Notas", "notes", 'maxlength="500"', debt?.notes ?? "")}`, debt ? "Guardar" : "Crear deuda",
  async (d, m) => { const r = debt ? await api("PATCH", "/api/debts/" + debt.id, d) : await api("POST", "/api/debts", d); m.close(); toast(debt ? "Deuda actualizada." : "Deuda creada."); if (debt) route(); else go("#/debts/" + r.debt.id); });
}
function debtsView(id) {
  if (id) return debtDetailView(id);
  const view = mountShell("debts", "Deudas", `<button class="btn primary" id="debt-new">${icon("plus")} Deuda</button>`);
  $("#debt-new").onclick = () => debtModal();
  withRetry(view, async () => {
    const r = await api("GET", "/api/debts"), C = r.currency;
    if (!r.debts.length) { view.innerHTML = emptyCard("No tienes deudas registradas", "Registra préstamos o créditos, sus abonos y cuánto capital te falta. Los pagos de tarjeta se manejan en Tarjetas.", "d-e", "Registrar deuda"); $("#d-e").onclick = () => debtModal(); return; }
    view.innerHTML = `<div class="grid stats"><div class="card stat hero"><div class="k">Capital pendiente</div><div class="v">${esc(money(r.totals.remaining, C))}</div><div class="n">Deudas activas en ${C}</div></div>
      <div class="card stat"><div class="k">Pago mensual total</div><div class="v">${esc(money(r.totals.monthly, C))}</div></div><div class="card stat"><div class="k">Intereses pagados</div><div class="v">${esc(money(r.totals.paid_interest, C))}</div><div class="n">Acumulado</div></div></div>
      <div class="grid acc-grid">${r.debts.map((d) => `<article class="card acc ${d.archived ? "archived" : ""}" tabindex="0" role="link" data-debt="${d.id}"><div class="muted small">${esc(d.creditor || "Deuda")} · ${d.currency}${d.archived ? " · archivada" : d.remaining <= 0 ? " · liquidada" : ""}</div>
        <h3 style="margin:.2rem 0">${esc(d.name)}</h3><div class="bal">${esc(money(d.remaining, d.currency))} <span class="muted small" style="font-weight:400">por pagar</span></div>${bar(d.progress)}
        <div class="muted small">${d.progress}% pagado${d.next_due ? ` · próximo pago ${esc(dayText(d.next_due))}` : ""}${d.months_left ? ` · ~${d.months_left} pagos` : ""}</div></article>`).join("")}</div>`;
    $$("[data-debt]", view).forEach((el) => { const open = () => go("#/debts/" + el.dataset.debt); el.onclick = open; el.onkeydown = (e) => { if (e.key === "Enter") open(); }; });
  });
}
function debtDetailView(id) {
  const view = mountShell("debts", "Deuda");
  withRetry(view, async () => {
    const r = await api("GET", "/api/debts/" + id), d = r.debt;
    $(".topbar h1").innerHTML = `<button class="icon-btn" id="back" aria-label="Volver">${icon("back")}</button> ${esc(d.name)}`;
    $("#back").onclick = () => go("#/debts");
    view.innerHTML = `<div class="card" style="margin-bottom:1rem"><div class="muted small">${esc(d.creditor || "Deuda")} · ${d.currency}${d.interest_rate ? ` · ${d.interest_rate}% anual` : ""}</div>
      <div style="font-size:2rem;font-weight:700;margin:.3rem 0">${esc(money(d.remaining, d.currency))} <span class="muted small" style="font-weight:400">de ${esc(money(d.principal, d.currency))}</span></div>${bar(d.progress)}
      <div class="muted small" style="margin-top:.3rem">Capital pagado ${esc(money(d.paid_principal, d.currency))} · intereses pagados ${esc(money(d.paid_interest, d.currency))}${d.next_due ? ` · próximo pago ${esc(dayText(d.next_due))}` : ""}</div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:1rem">${d.remaining > 0 ? `<button class="btn primary sm" id="dp">${icon("plus")} Registrar pago</button>` : ""}<button class="btn sm" id="de">${icon("edit")} Editar</button>
        <button class="btn sm" id="da">${icon("archive")} ${d.archived ? "Restaurar" : "Archivar"}</button><button class="btn sm danger" id="dd">${icon("trash")} Eliminar</button></div></div>
      <section class="card"><h2>Pagos</h2>${r.payments.length ? r.payments.map((p) => `<div class="tx-row" style="grid-template-columns:80px minmax(0,1fr) auto auto"><span class="small">${esc(fmtDate(p.date, { day: "2-digit", month: "short", year: "2-digit" }))}</span>
        <span class="desc"><b>${esc(money(p.total, d.currency))}</b><span class="muted small">Capital ${esc(money(p.principal_part, d.currency))} · intereses ${esc(money(p.interest_part, d.currency))} · ${p.account_name ? "desde " + esc(p.account_name) : "sin cuenta ligada"}</span></span><span></span>
        <button class="icon-btn" data-delpay="${p.id}" aria-label="Eliminar pago">${icon("trash")}</button></div>`).join("") : '<div class="empty">Aún no hay pagos.</div>'}</section>`;
    $("#de").onclick = () => debtModal(d);
    const dp = $("#dp"); if (dp) dp.onclick = () => modalForm("Registrar pago", "dp-f", `<p class="muted small">Solo el capital reduce la deuda. No cuenta como gasto.</p>
      ${field("Pago total", "amount", 'inputmode="decimal" required', d.monthly_payment ? centsToInput(Math.min(d.monthly_payment, d.remaining)) : "")}${field("De los cuales intereses", "interest", 'inputmode="decimal" placeholder="0"')}
      ${sel("account_id", "Pagado desde", [["", "Sin ligar a una cuenta"], ...S.accounts.filter((a) => !a.archived && a.type !== "credit" && a.currency === d.currency).map((a) => [a.id, `${a.name} · ${money(a.balance, a.currency, { mask: false })}`])])}
      ${field("Fecha", "date", 'type="date" required', todayStr())}${field("Notas", "notes", 'maxlength="300"')}`, "Registrar", async (f, m) => { await api("POST", `/api/debts/${id}/payments`, f); m.close(); await refreshCore(); toast("Pago registrado."); route(); });
    $("#da").onclick = async () => { try { await api("PATCH", "/api/debts/" + id, { archived: !d.archived }); toast(d.archived ? "Deuda restaurada." : "Deuda archivada."); route(); } catch (e) { toast(e.message, "error"); } };
    $("#dd").onclick = async () => { if (!(await confirmDialog("¿Eliminar deuda?", "Solo se puede eliminar una deuda sin pagos. Si ya tiene pagos, archívala."))) return; try { await api("DELETE", "/api/debts/" + id); toast("Deuda eliminada."); go("#/debts"); } catch (e) { toast(e.message, "error"); } };
    $$("[data-delpay]", view).forEach((b) => b.onclick = async () => { if (!(await confirmDialog("¿Eliminar pago?", "Se recalculará lo que debes y el saldo de la cuenta desde la que pagaste."))) return; try { await api("DELETE", "/api/debts/payments/" + b.dataset.delpay); await refreshCore(); toast("Pago eliminado."); route(); } catch (e) { toast(e.message, "error"); } });
  });
}

/* ---------------------------------------------------------------- Presupuestos */
let budgetMonth = null;
function budgetModal(catId = null, amount = "", month) {
  const roots = S.categories.filter((c) => c.kind === "expense" && !c.parent_id && !c.archived);
  modalForm("Presupuesto mensual", "b-f", `${sel("category_id", "Categoría", [["0", "Total del mes (todas las categorías)"], ...roots.map((c) => [c.id, c.name])], catId ?? "0")}
    ${field("Límite mensual", "amount", 'inputmode="decimal" required', amount)}<p class="muted small">Incluye subcategorías. Aplica cada mes.</p>`, "Guardar",
  async (d, m) => { await api("PUT", "/api/budgets", { ...d, month }); m.close(); toast("Presupuesto guardado."); route(); });
}
function budgetsView() {
  budgetMonth = budgetMonth || monthKey();
  const view = mountShell("budgets", "Presupuestos", `<button class="btn primary" id="b-new">${icon("plus")} Presupuesto</button>`);
  $("#b-new").onclick = () => budgetModal(null, "", budgetMonth);
  withRetry(view, async () => {
    const r = await api("GET", "/api/budgets?month=" + budgetMonth), C = r.currency;
    const row = (b, total) => `<div class="card" style="margin-bottom:.7rem"><div style="display:flex;justify-content:space-between;gap:.5rem;align-items:baseline"><b>${esc(b.name)}</b><span class="small ${b.status === "over" ? "neg" : ""}">${esc(money(b.spent, C))} de ${esc(money(b.amount, C))}</span></div>
      ${bar(b.pct, b.status === "over" ? "bad" : b.status === "warn" ? "mid" : "")}<div class="muted small" style="display:flex;justify-content:space-between"><span>${b.pct.toFixed(0)}%${b.status === "over" ? " · excedido" : ""}</span><span>${b.remaining >= 0 ? "Quedan " + esc(money(b.remaining, C)) : "Excedido por " + esc(money(-b.remaining, C))}</span></div>
      <div style="margin-top:.4rem"><button class="btn sm" data-edit="${b.category_id}" data-amt="${b.amount}">${icon("edit")} Editar</button> <button class="btn sm danger" data-del="${b.category_id}">${icon("trash")}</button></div></div>`;
    view.innerHTML = `<div style="display:flex;align-items:center;gap:.5rem;margin-bottom:1rem"><button class="icon-btn" id="pm" aria-label="Mes anterior">${icon("back")}</button><b style="min-width:9rem;text-align:center">${esc(monthLabel(r.month))}</b>
      <button class="icon-btn" id="nm" aria-label="Mes siguiente" style="transform:rotate(180deg)">${icon("back")}</button><span class="muted small">Mes transcurrido: ${r.elapsed_pct}%</span></div>
      ${r.total ? row(r.total) : ""}${r.items.map((b) => row(b)).join("") || (r.total ? "" : emptyCard("Sin presupuestos", "Define cuánto quieres gastar al mes por categoría o en total y FIPO te avisa cuando te acerques al límite.", "b-e", "Crear presupuesto"))}
      ${r.unbudgeted.length ? `<section class="card" style="margin-top:1rem"><h2>Gasto sin presupuesto</h2>${r.unbudgeted.map((u) => `<div class="list-row"><span class="grow">${esc(u.name)}</span><b>${esc(money(u.spent, C))}</b>${u.category_id ? `<button class="btn sm" data-set="${u.category_id}">Presupuestar</button>` : ""}</div>`).join("")}</section>` : ""}`;
    $("#pm", view).onclick = () => { budgetMonth = shiftMonth(budgetMonth, -1); route(); }; $("#nm", view).onclick = () => { budgetMonth = shiftMonth(budgetMonth, 1); route(); };
    const be = $("#b-e", view); if (be) be.onclick = () => budgetModal(null, "", budgetMonth);
    $$("[data-edit]", view).forEach((b) => b.onclick = () => budgetModal(b.dataset.edit, centsToInput(+b.dataset.amt), budgetMonth));
    $$("[data-set]", view).forEach((b) => b.onclick = () => budgetModal(b.dataset.set, "", budgetMonth));
    $$("[data-del]", view).forEach((b) => b.onclick = async () => { if (!(await confirmDialog("¿Quitar presupuesto?", "Solo se quita el límite; tus movimientos no cambian.", "Quitar"))) return; try { await api("DELETE", "/api/budgets/" + b.dataset.del); toast("Presupuesto quitado."); route(); } catch (e) { toast(e.message, "error"); } });
  });
}

/* ---------------------------------------------------------------- Análisis */
const INS_RANK = { warning: 0, insight: 1, trend: 2, goal: 3 };
const insightsBlock = (items) => !items.length ? "" : `<div class="grid insights" style="margin-bottom:1rem">${[...items].sort((x, y) => (INS_RANK[x.kind] ?? 1) - (INS_RANK[y.kind] ?? 1)).slice(0, 2).map((i) => `<div class="card insight ${esc(i.kind)}"><span class="ico">${i.icon}</span><div><b>${esc(i.title)}</b><p>${esc(i.text)}</p></div></div>`).join("")}</div>`;
const statTile = (k, v, n = "", cls = "") => `<div class="card stat ${cls}"><div class="k">${esc(k)}</div><div class="v">${v}</div>${n ? `<div class="n">${esc(n)}</div>` : ""}</div>`;
const legendBtns = (items, val, C) => `<div class="legend">${items.map((x, i) => `<button type="button" disabled><i class="dot" style="background:${PALETTE[i % PALETTE.length]}"></i><span class="nm">${esc(x.name)}</span><span class="am">${esc(money(val(x), C))}</span></button>`).join("")}</div>`;

function budgetBlock(b, C) {
  if (!b || (!b.items.length && !b.total)) return `<div class="empty">Sin presupuestos definidos. <a href="#/budgets">Crea uno</a> para comparar tu gasto contra un límite.</div>`;
  const row = (x) => `<div style="margin-bottom:.7rem"><div style="display:flex;justify-content:space-between;gap:.5rem;align-items:baseline"><b>${esc(x.name)}</b><span class="small ${x.status === "over" ? "neg" : ""}">${esc(money(x.spent, C))} de ${esc(money(x.amount, C))}</span></div>${bar(x.pct, x.status === "over" ? "bad" : x.status === "warn" ? "mid" : "ok")}</div>`;
  return (b.total ? row(b.total) : "") + b.items.map(row).join("") + `<a class="btn sm" href="#/budgets">Ver presupuestos</a>`;
}

function goalsBlock(goals, C) {
  if (!goals.length) return `<div class="empty">Sin metas activas. <a href="#/goals">Crea una</a> para ver tu avance aquí.</div>`;
  return goals.map((g) => `<div style="margin-bottom:.7rem"><div style="display:flex;justify-content:space-between;gap:.5rem;align-items:baseline"><b>${esc(g.name)}</b><span class="small">${esc(money(g.saved, C))} de ${esc(money(g.target, C))}</span></div>${bar(g.pct, g.done ? "ok" : "")}
    <div class="muted small">${g.pct}%${g.needed_per_month ? ` · ${esc(money(g.needed_per_month, C))}/mes para llegar a tiempo` : ""}</div></div>`).join("") + `<a class="btn sm" href="#/goals">Ver metas</a>`;
}

function portfolioBlock(pf, C) {
  const pos = pf.positions.filter((p) => p.currency === C);
  if (!pos.length) return `<div class="empty">Sin posiciones en el portafolio. <a href="#/portfolio">Agrega una operación</a> para ver su rendimiento.</div>`;
  return `<div class="tbl-wrap"><table class="imp"><thead><tr><th>Símbolo</th><th class="r">Valor de mercado</th><th class="r">Costo</th><th class="r">Ganancia/pérdida</th></tr></thead><tbody>
      ${pos.map((p) => `<tr><td>${esc(p.symbol)}</td><td class="r">${p.market_value != null ? esc(money(p.market_value, C)) : "—"}</td><td class="r">${esc(money(p.cost, C))}</td>
        <td class="r ${p.unrealized > 0 ? "pos" : p.unrealized < 0 ? "neg" : ""}">${p.unrealized != null ? esc(money(p.unrealized, C, { sign: true })) + (p.unrealized_pct != null ? ` (${p.unrealized_pct > 0 ? "+" : ""}${p.unrealized_pct}%)` : "") : "—"}</td></tr>`).join("")}
      </tbody></table></div><p class="muted small" style="margin-top:.5rem">Total ${esc(money(pf.totals.market_value, C))} · ganancia/pérdida no realizada ${esc(money(pf.totals.unrealized, C, { sign: true }))}${pf.totals.unrealized_pct != null ? ` (${pf.totals.unrealized_pct > 0 ? "+" : ""}${pf.totals.unrealized_pct}%)` : ""}. <a href="#/portfolio">Ver portafolio</a></p>`;
}

function recurringBlock(items, C) {
  if (!items.length) return `<div class="empty">Aún no se detectan gastos recurrentes (se necesitan al menos 3 de los últimos 4 meses con un monto parecido).</div>`;
  return items.map((r) => `<div class="list-row"><span class="grow">${esc(r.description)}<span class="muted small" style="display:block">Visto en ${r.months_seen} de los últimos 4 meses · último ${esc(fmtDate(r.last_date, { day: "2-digit", month: "short" }))}</span></span><b>${esc(money(r.avg_amount, C))}/mes</b></div>`).join("");
}

const projectionRows = (a, mult) => a.projection.points.map((p) => ({ months_ahead: p.months_ahead, projected: a.overview.net_worth + a.projection.avg_monthly_net * mult * p.months_ahead }));
const projectionRowsHtml = (a, mult, C) => projectionRows(a, mult).map((p) => `<div class="list-row"><span class="grow">En ${p.months_ahead} meses</span><b>${esc(money(Math.round(p.projected), C))}</b></div>`).join("");
function projectionBlock(a, C) {
  return `<div class="seg" style="max-width:360px;margin-bottom:.6rem"><button type="button" data-s="0.5">Conservador</button><button type="button" data-s="1" class="on">Base</button><button type="button" data-s="1.5">Optimista</button></div>
    <div id="proj-rows">${projectionRowsHtml(a, 1, C)}</div>
    <p class="muted small" style="margin-top:.4rem">Con tu ahorro promedio de ${esc(money(a.projection.avg_monthly_net, C, { sign: true }))} al mes.</p>`;
}

function calculatorsBlock() {
  return `<details class="calc" open><summary>${icon("chevron")} Interés compuesto</summary>
      <div class="row2">${field("Capital inicial", "ci-p", 'inputmode="decimal"', "10000")}${field("Aporte mensual", "ci-a", 'inputmode="decimal"', "1000")}</div>
      <div class="row2">${field("Tasa anual %", "ci-r", 'inputmode="decimal"', "8")}${field("Años", "ci-y", 'inputmode="decimal"', "10")}</div>
      <div class="v" id="ci-out" style="font-weight:700;margin-top:.5rem"></div></details>
    <details class="calc"><summary>${icon("chevron")} Calculadora de deuda</summary>
      <div class="row2">${field("Saldo de la deuda", "cd-p", 'inputmode="decimal"', "50000")}${field("Tasa anual %", "cd-r", 'inputmode="decimal"', "24")}</div>
      <div class="row2">${field("Pago mensual", "cd-m", 'inputmode="decimal"', "2000")}</div>
      <div class="v" id="cd-out" style="font-weight:700;margin-top:.5rem"></div></details>
    <details class="calc"><summary>${icon("chevron")} Fondo de emergencia</summary>
      <div class="row2">${field("Gasto mensual", "ce-e", 'inputmode="decimal"', "15000")}${field("Meses de colchón deseados", "ce-m", 'inputmode="decimal"', "6")}</div>
      <div class="v" id="ce-out" style="font-weight:700;margin-top:.5rem"></div></details>`;
}
function wireCalculators(view, C) {
  const num = (id) => { const v = parseFloat(($("#f-" + id, view) || {}).value); return isNaN(v) ? 0 : v; };
  const upd = () => {
    const p = num("ci-p"), pmt = num("ci-a"), r = num("ci-r") / 100 / 12, n = num("ci-y") * 12;
    const fv = n > 0 ? p * Math.pow(1 + r, n) + (r ? pmt * ((Math.pow(1 + r, n) - 1) / r) : pmt * n) : p;
    $("#ci-out", view).textContent = "Valor futuro: " + money(Math.round(fv * 100), C);
  };
  const updD = () => {
    const out = $("#cd-out", view), p = num("cd-p"), r = num("cd-r") / 100 / 12, pay = num("cd-m");
    if (p <= 0 || pay <= 0) { out.textContent = ""; return; }
    if (pay <= p * r) { out.textContent = "Ese pago no alcanza a cubrir el interés: la deuda nunca se termina de pagar."; return; }
    let bal = p, months = 0, interest = 0;
    while (bal > 0 && months < 1200) { const i = bal * r; interest += i; bal = bal + i - pay; months++; }
    out.textContent = `${months} meses para pagarla · ${money(Math.round(interest * 100), C)} de interés total`;
  };
  const updE = () => { const e = num("ce-e"), m = num("ce-m"); $("#ce-out", view).textContent = e > 0 && m > 0 ? "Objetivo: " + money(Math.round(e * m * 100), C) : ""; };
  ["ci-p", "ci-a", "ci-r", "ci-y"].forEach((id) => $("#f-" + id, view).oninput = upd);
  ["cd-p", "cd-r", "cd-m"].forEach((id) => $("#f-" + id, view).oninput = updD);
  ["ce-e", "ce-m"].forEach((id) => $("#f-" + id, view).oninput = updE);
  upd(); updD(); updE();
}

/* insights de Análisis: una frase corta por tarjeta, calculada con tus datos */
function analysisInsights(a, C) {
  const I = {}, clean = (s) => String(s || "").replace(/^\[DEMO\]\s*/, ""), short = (c) => money(c, C).replace(/\.\d\d$/, "");
  const sr = a.totals.avg_savings_rate;
  if (sr != null) I.flow = insight(sr < 0 ? `Gastas más de lo que ganas (${sr}%)` : `Ahorras ${sr}% en promedio`, sr < 0 ? "bad" : sr < 10 ? "warn" : "ok");
  const sv = a.savings_evolution, svLast = sv.length ? sv[sv.length - 1].cumulative : null, sv3 = sv.length > 3 ? sv[sv.length - 4].cumulative : null;
  if (svLast != null && sv3 != null) { const dlt = svLast - sv3; I.sav = insight(`${dlt >= 0 ? "+" : "−"}${short(Math.abs(dlt))} en 3 meses`, dlt >= 0 ? "ok" : "bad"); }
  const nw = a.networth_evolution.filter((x) => x.net_worth), n0 = nw.length ? nw[0].net_worth : 0, n1 = nw.length ? nw[nw.length - 1].net_worth : 0;
  if (nw.length > 1 && n0) { const p = ((n1 - n0) * 100) / Math.abs(n0); I.nw = insight(`${p >= 0 ? "+" : ""}${Math.round(p)}% en ${nw.length} meses`, p >= 0 ? "ok" : "bad"); }
  const de = a.debt_evolution;
  if (de.length > 1) { const d1 = de[de.length - 1].total, d0 = de[de.length - 2].total, dd = d1 - d0;
    I.debt = !d1 ? insight("Sin deudas", "ok") : dd < 0 ? insight(`Bajó ${short(-dd)} este mes`, "ok") : dd > 0 ? insight(`Subió ${short(dd)} este mes`, "bad") : insight("Igual que el mes pasado"); }
  const cur = a.categories.filter((c) => c.current > 0), tot = cur.reduce((s, c) => s + c.current, 0), top = [...cur].sort((x, y) => y.current - x.current)[0];
  if (top && tot) I.cat = insight(`${clean(top.name)}: ${Math.round((top.current * 100) / tot)}% del gasto`, (top.current * 100) / tot >= 40 ? "warn" : "");
  const up = [...a.categories].filter((c) => c.delta > 0).sort((x, y) => y.delta - x.delta)[0];
  I.catcmp = up ? insight(`${clean(up.name)} subió ${short(up.delta)}`, "warn") : a.categories.length ? insight("Nada subió vs. el mes pasado", "ok") : "";
  const at = a.asset_allocation.reduce((s, x) => s + x.value, 0), ab = [...a.asset_allocation].sort((x, y) => y.value - x.value)[0];
  if (ab && at) I.assets = insight(`${clean(ab.name)}: ${Math.round((ab.value * 100) / at)}%`);
  if (a.budget && a.budget.items && a.budget.items.length) { const over = a.budget.items.filter((i) => i.status === "over").length, warn = a.budget.items.filter((i) => i.status === "warn").length;
    I.budget = over ? insight(`${over} excedido${over > 1 ? "s" : ""}`, "bad") : warn ? insight(`${warn} cerca del límite`, "warn") : insight("Todo dentro del límite", "ok"); }
  const g = (a.goals || []).filter((x) => !x.done).sort((x, y) => y.pct - x.pct)[0];
  if (g) I.goals = insight(`Más cerca: ${clean(g.name)} ${Math.round(g.pct)}%`);
  const pt = a.portfolio && a.portfolio.totals;
  if (pt && pt.unrealized_pct != null) I.pf = insight(`${pt.unrealized_pct > 0 ? "+" : ""}${pt.unrealized_pct}% de ganancia`, pt.unrealized_pct >= 0 ? "ok" : "bad");
  const p12 = a.projection && (a.projection.points || []).find((x) => x.months_ahead === 12);
  if (p12) I.proj = insight(`En 1 año: ${short(p12.projected)}`);
  const rc = (a.recurring || []).reduce((s, r) => s + (r.avg_amount || 0), 0);
  if (rc) I.rec = insight(`≈ ${short(rc)} al mes`);
  const wd = [...a.weekday].sort((x, y) => y.total - x.total)[0];
  if (wd && wd.total) I.dow = insight(`Gastas más en ${wd.day.toLowerCase()}`);
  const tm = a.this_month;
  if (tm.prev_avg) { const p = ((tm.projected - tm.prev_avg) * 100) / tm.prev_avg; I.month = insight(`${p >= 0 ? "+" : ""}${Math.round(p)}% vs. tu promedio`, p > 10 ? "bad" : p > 0 ? "warn" : "ok"); }
  const t5 = (a.top_expenses || []).reduce((s, t) => s + t.amount, 0);
  if (t5 && tm.spent) I.top = insight(`${Math.round((t5 * 100) / tm.spent)}% del gasto del mes`);
  return I;
}

function analysisView() {
  const view = mountShell("analysis", "Análisis");
  withRetry(view, async () => {
    const a = await api("GET", "/api/analysis"), C = a.currency, tm = a.this_month, ov = a.overview;
    if (!a.totals.months_with_data) { view.innerHTML = emptyCard("Aún no hay datos para analizar", "Registra ingresos y gastos (o carga los datos de demostración desde Inicio) y aquí verás tu patrimonio, tu salud financiera, tendencias e insights automáticos."); return; }
    const maxDow = Math.max(1, ...a.weekday.map((w) => w.total)), I = analysisInsights(a, C);
    view.innerHTML = `${insightsBlock(a.insights)}
    <div class="grid stats">
      ${statTile("Patrimonio neto", money(ov.net_worth, C), "Lo que tienes menos lo que debes", "hero")}
      ${statTile("Dinero disponible", money(ov.available, C), "Efectivo y ahorro líquido")}
      ${statTile("Ahorro", money(ov.savings, C, { sign: true }), ov.savings_rate != null ? "Tasa de ahorro " + ov.savings_rate + "%" : "Sin ingresos este mes")}
      ${statTile("Deuda total", money(ov.debt_total, C), ov.debt_to_income ? "Deuda/ingreso " + ov.debt_to_income + "%" : "Sin deuda activa")}
      ${statTile("Fondo de emergencia", ov.emergency_fund_months != null ? ov.emergency_fund_months + " meses" : "—", "Cobertura con dinero líquido")}
      ${statTile("Rendimiento de inversiones", ov.investment_return_pct != null ? (ov.investment_return_pct > 0 ? "+" : "") + ov.investment_return_pct + "%" : "—", "Ganancia/pérdida no realizada del portafolio")}
    </div>
    <section class="card" style="margin-top:1rem"><h2>Salud financiera</h2>${a.health.score == null ? `<p class="muted small">Sin ingresos registrados todavía: no se puede calcular.</p>` : `${bar(Math.min(100, a.health.score), a.health.score >= 70 ? "ok" : a.health.score >= 40 ? "mid" : "bad")}
      <div style="font-size:1.6rem;font-weight:700">${a.health.score}<span class="muted small" style="font-weight:400"> / 100</span></div>
      <p class="muted small" style="margin:.2rem 0 .5rem">Meta 50% vida · 25% ahorro · 25% inversión · ${esc(a.health.month)}</p>
      <div class="grid two" style="gap:.3rem">${["living", "savings", "investments"].map((k) => { const b = a.health.breakdown[k]; return `<span class="muted small">${esc(b.label)}: ${b.actual_pct}% (meta ${b.target_pct}%) · ${b.points} pts${b.bonus ? " ⭐ extra" : ""}</span>`; }).join("")}</div>`}</section>
    <div class="grid two" style="margin-top:1rem">
      <section class="card"><h2>Ingresos vs gastos ${I.flow || ""}</h2><div class="key key-sm"><span><i class="dot" style="background:var(--income)"></i>Ingresos</span><span><i class="dot" style="background:var(--expense)"></i>Gastos</span></div>${barChart(a.monthly.map((m) => ({ key: m.key, income: m.income, expense: m.expense })), "month", C)}</section>
      <section class="card"><h2>Evolución del ahorro ${I.sav || ""}</h2>${lineChart(a.savings_evolution.map((x) => ({ date: x.key + "-01", balance: x.cumulative })), C, "Evolución del ahorro acumulado")}</section>
    </div>
    <div class="grid two" style="margin-top:1rem">
      <section class="card"><h2>Patrimonio neto ${I.nw || ""}</h2>${lineChart(a.networth_evolution.map((x) => ({ date: x.key + "-01", balance: x.net_worth })), C, "Evolución del patrimonio neto")}</section>
      <section class="card"><h2>Deudas ${I.debt || ""}</h2>${lineChart(a.debt_evolution.map((x) => ({ date: x.key + "-01", balance: x.total })), C, "Evolución de deudas")}</section>
    </div>
    <div class="grid two" style="margin-top:1rem">
      <section class="card"><h2>Gastos por categoría ${I.cat || ""}</h2>${a.categories.filter((c) => c.current > 0).length ? donut(a.categories.filter((c) => c.current > 0).map((c) => ({ name: c.name, total: c.current })), C) + legendBtns(a.categories.filter((c) => c.current > 0), (c) => c.current, C) : '<div class="empty">Sin gastos este mes.</div>'}</section>
      <section class="card"><h2>Distribución de activos ${I.assets || ""}</h2>${a.asset_allocation.length ? donut(a.asset_allocation.map((x) => ({ name: x.name, total: x.value })), C) + legendBtns(a.asset_allocation, (x) => x.value, C) : '<div class="empty">Sin cuentas o inversiones que mostrar.</div>'}</section>
    </div>
    <div class="grid two even" style="margin-top:1rem">
      <section class="card"><h2>Presupuesto ${I.budget || ""}</h2>${budgetBlock(a.budget, C)}</section>
      <section class="card"><h2>Metas ${I.goals || ""}</h2>${goalsBlock(a.goals, C)}</section>
    </div>
    <div class="grid two even" style="margin-top:1rem">
      <section class="card"><h2>Portafolio ${I.pf || ""}</h2>${portfolioBlock(a.portfolio, C)}</section>
      <section class="card"><h2>Proyección patrimonial ${I.proj || ""}</h2>${projectionBlock(a, C)}</section>
    </div>
    <section class="card" style="margin-top:1rem"><h2>Recurrentes y suscripciones ${I.rec || ""}</h2>${recurringBlock(a.recurring, C)}</section>
    <div class="grid two" style="margin-top:1rem">
      <section class="card"><h2>Gasto por día ${I.dow || ""}</h2>${a.weekday.map((w) => `<div class="dow"><span>${w.day.slice(0, 3)}</span><div class="track"><i class="fill" style="width:${w.total / maxDow * 100}%"></i></div><b class="small">${esc(money(w.total, C))}</b></div>`).join("")}</section>
      <section class="card"><h2>Proyección del mes ${I.month || ""}</h2><div class="v" style="font-size:1.4rem;font-weight:700">${esc(money(tm.projected, C))}</div><div class="muted small">${tm.prev_avg != null ? "Promedio de meses previos " + esc(money(tm.prev_avg, C)) : "Al ritmo actual"} · gasto diario promedio ${esc(money(tm.daily_avg, C))}</div></section>
    </div>
    <div class="grid two w13" style="margin-top:1rem">
      <section class="card"><h2>Este mes vs. anterior ${I.catcmp || ""}</h2>${a.categories.length ? `<div class="tbl-wrap"><table class="imp"><thead><tr><th>Categoría</th><th class="r">Este mes</th><th class="r">Mes anterior</th><th class="r">Cambio</th></tr></thead><tbody>${a.categories.map((c) => `<tr><td>${esc(c.name)}</td><td class="r">${esc(money(c.current, C))}</td><td class="r">${esc(money(c.previous, C))}</td><td class="r ${c.delta > 0 ? "neg" : c.delta < 0 ? "pos" : ""}">${c.delta_pct != null ? (c.delta_pct > 0 ? "+" : "") + c.delta_pct + "%" : c.delta ? "nuevo" : "—"}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">Sin gastos en estos meses.</div>'}</section>
      <section class="card"><h2>Mayores gastos ${I.top || ""}</h2>${a.top_expenses.length ? a.top_expenses.map((t) => `<div class="tx-row" style="grid-template-columns:70px minmax(0,1fr) auto" data-tx="${t.id}"><span class="small">${esc(fmtDate(t.date, { day: "2-digit", month: "short" }))}</span><span class="desc"><b>${esc(t.description || t.category_name || "Gasto")}</b><span class="muted small">${esc(t.category_name || "Sin categoría")}</span></span><span class="amt neg">${esc(money(-t.amount, C))}</span></div>`).join("") : '<div class="empty">Sin gastos este mes.</div>'}</section>
    </div>
    <section class="card" style="margin-top:1rem"><h2>Calculadoras</h2>${calculatorsBlock()}</section>`;
    bindTxRows(view);
    wireCalculators(view, C);
    $$(".seg button[data-s]", view).forEach((b) => b.onclick = () => {
      $$(".seg button[data-s]", view).forEach((x) => x.classList.remove("on")); b.classList.add("on");
      $("#proj-rows", view).innerHTML = projectionRowsHtml(a, +b.dataset.s, C);
    });
  });
}

/* ---------------------------------------------------------------- Reportes */
let reportState = { mode: "month", month: null, from: "", to: "" };
function reportsView() {
  reportState.month = reportState.month || monthKey();
  const view = mountShell("reports", "Reportes");
  const params = () => (reportState.mode === "month" ? { month: reportState.month } : { from: reportState.from, to: reportState.to });
  view.innerHTML = `<form class="card" id="rp-f" style="max-width:640px;margin-bottom:1rem" novalidate><div class="seg" style="max-width:280px"><button type="button" data-m="month" class="${reportState.mode === "month" ? "on" : ""}">Mes</button><button type="button" data-m="range" class="${reportState.mode === "range" ? "on" : ""}">Rango</button></div>
    ${reportState.mode === "month" ? field("Mes", "month", 'type="month" required', reportState.month) : `<div class="row2">${field("Desde", "from", 'type="date" required', reportState.from)}${field("Hasta", "to", 'type="date" required', reportState.to || todayStr())}</div>`}
    <div style="display:flex;gap:.5rem;flex-wrap:wrap"><button class="btn primary" type="submit">Ver resumen</button><button type="button" class="btn" id="rp-pdf">${icon("download")} PDF</button><button type="button" class="btn" id="rp-csv">${icon("download")} CSV de movimientos</button></div></form><div id="rp-out"></div>`;
  $$(".seg button", view).forEach((b) => b.onclick = () => { reportState.mode = b.dataset.m; reportsView(); });
  const read = () => { const f = formData($("#rp-f", view)); if (reportState.mode === "month") reportState.month = f.month; else { reportState.from = f.from; reportState.to = f.to; } };
  const load = async () => {
    read(); const out = $("#rp-out", view); out.innerHTML = '<div class="spinner"></div>';
    try {
      const r = await api("GET", "/api/report?" + qs(params())), C = r.currency;
      out.innerHTML = `<div class="grid stats"><div class="card stat"><div class="k">Ingresos</div><div class="v pos">${esc(money(r.income, C))}</div></div><div class="card stat"><div class="k">Gastos</div><div class="v neg">${esc(money(r.expense, C))}</div></div>
        <div class="card stat hero"><div class="k">Balance neto</div><div class="v">${esc(money(r.net, C, { sign: true }))}</div><div class="n">${r.savings_rate != null ? "Tasa de ahorro " + r.savings_rate + "%" : ""}</div></div></div>
        <div class="grid two"><section class="card"><h2>Gastos por categoría</h2>${r.expense_by_category.length ? r.expense_by_category.map((c) => `<div class="list-row"><span class="grow">${esc(c.name)}</span><span class="muted small">${c.pct}%</span><b>${esc(money(c.total, C))}</b></div>`).join("") : '<div class="empty">Sin gastos en este periodo.</div>'}</section>
        <section class="card"><h2>Ingresos por categoría</h2>${r.income_by_category.length ? r.income_by_category.map((c) => `<div class="list-row"><span class="grow">${esc(c.name)}</span><b>${esc(money(c.total, C))}</b></div>`).join("") : '<div class="empty">Sin ingresos en este periodo.</div>'}</section></div>
        <p class="muted small" style="margin-top:.8rem">${r.transaction_count} movimientos en el periodo. El PDF incluye resumen, categorías, presupuestos del mes, saldos y movimientos.</p>`;
    } catch (e) { out.innerHTML = ""; toast(e.message, "error"); }
  };
  $("#rp-f", view).onsubmit = (e) => { e.preventDefault(); load(); };
  $("#rp-pdf", view).onclick = () => { read(); downloadFile("/api/report?" + qs({ ...params(), format: "pdf" })); };
  $("#rp-csv", view).onclick = () => { read(); downloadFile("/api/report?" + qs({ ...params(), format: "csv" })); };
  if (reportState.mode === "month" || (reportState.from && reportState.to)) load();
}

/* ---------------------------------------------------------------- Metas */
function goalModal(g = null) {
  modalForm(g ? "Editar meta" : "Nueva meta", "g-f", `${field("Nombre", "name", 'maxlength="80" required placeholder="Viaje, fondo de emergencia…"', g?.name ?? "")}
    <div class="row2">${field("Monto objetivo", "target", 'inputmode="decimal" required', g ? centsToInput(g.target) : "")}${field("Fecha objetivo (opcional)", "target_date", 'type="date"', g?.target_date ?? "")}</div>
    <div class="field"><label for="f-currency">Moneda</label><select id="f-currency" name="currency">${S.currencies.map((c) => `<option ${(g?.currency ?? cur()) === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
    ${field("Notas", "notes", 'maxlength="500"', g?.notes ?? "")}<p class="muted small">No mueve el saldo de tus cuentas.</p>`, g ? "Guardar" : "Crear meta",
  async (d, m) => { const r = g ? await api("PATCH", "/api/goals/" + g.id, d) : await api("POST", "/api/goals", d); m.close(); toast(g ? "Meta actualizada." : "Meta creada."); if (g) route(); else go("#/goals/" + r.goal.id); });
}
const GOAL_TONES = ["income", "transfer", "adjustment", "expense"];
const GOAL_QUOTES = ["La disciplina de hoy, es la libertad de mañana.", "Cada aportación te acerca un poco más.", "Las grandes metas se logran en pequeños pasos."];
function goalsView(id) {
  if (id) return goalDetailView(id);
  const view = mountShell("goals", "Metas de ahorro", `<button class="btn primary" id="g-new">${icon("plus")} Meta</button>`);
  $("#g-new").onclick = () => goalModal();
  withRetry(view, async () => {
    const r = await api("GET", "/api/goals");
    if (!r.goals.length) { view.innerHTML = emptyCard("Sin metas todavía", "Crea una meta (viaje, fondo de emergencia, un equipo…) y registra tus aportaciones para ver tu avance.", "g-e", "Crear meta"); $("#g-e").onclick = () => goalModal(); return; }
    view.innerHTML = `<div class="grid acc-grid">${r.goals.map((g, i) => `<article class="card acc ${g.archived ? "archived" : ""}" tabindex="0" role="link" data-goal="${g.id}">
      <div class="goal-head"><span class="tx-ico ${GOAL_TONES[i % GOAL_TONES.length]}" style="width:44px;height:44px">${icon("flag")}</span>${progressRing(g.pct, 52)}</div>
      <div class="muted small">${g.done ? "¡Lograda!" : g.target_date ? "Meta para " + esc(fmtDate(g.target_date)) : "Sin fecha"}${g.archived ? " · archivada" : ""}</div>
      <h3 style="margin:.2rem 0">${esc(g.name)}</h3><div class="bal">${esc(money(g.saved, g.currency))} <span class="muted small" style="font-weight:400">de ${esc(money(g.target, g.currency))}</span></div>
      <div class="muted small">${g.needed_per_month ? `ahorra ${esc(money(g.needed_per_month, g.currency))}/mes` : ""}${g.days_left != null && g.days_left < 0 && !g.done ? " · fecha vencida" : ""}</div></article>`).join("")}</div>
      <div class="card goal-quote">“${esc(GOAL_QUOTES[new Date().getDate() % GOAL_QUOTES.length])}”</div>`;
    $$("[data-goal]", view).forEach((el) => { const open = () => go("#/goals/" + el.dataset.goal); el.onclick = open; el.onkeydown = (e) => { if (e.key === "Enter") open(); }; });
  });
}
function goalDetailView(id) {
  const view = mountShell("goals", "Meta");
  withRetry(view, async () => {
    const r = await api("GET", "/api/goals/" + id), g = r.goal;
    $(".topbar h1").innerHTML = `<button class="icon-btn" id="back" aria-label="Volver">${icon("back")}</button> ${esc(g.name)}`;
    $("#back").onclick = () => go("#/goals");
    view.innerHTML = `<div class="card" style="margin-bottom:1rem"><div style="font-size:2rem;font-weight:700">${esc(money(g.saved, g.currency))} <span class="muted small" style="font-weight:400">de ${esc(money(g.target, g.currency))}</span></div>${bar(g.pct, g.done ? "ok" : "")}
      <div class="muted small" style="margin-top:.3rem">${g.pct}%${g.done ? " · ¡meta lograda!" : ` · faltan ${esc(money(g.remaining, g.currency))}`}${g.target_date ? ` · para el ${esc(fmtDate(g.target_date))}` : ""}${g.needed_per_month ? ` · ${esc(money(g.needed_per_month, g.currency))} al mes` : ""}</div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:1rem"><button class="btn primary sm" id="gc">${icon("plus")} Aportar</button><button class="btn sm" id="gw">Retirar</button><button class="btn sm" id="ge">${icon("edit")} Editar</button>
      <button class="btn sm" id="ga">${icon("archive")} ${g.archived ? "Restaurar" : "Archivar"}</button><button class="btn sm danger" id="gd">${icon("trash")}</button></div></div>
      <section class="card"><h2>Aportaciones</h2>${r.contribs.length ? r.contribs.map((c) => `<div class="tx-row" style="grid-template-columns:80px minmax(0,1fr) auto auto"><span class="small">${esc(fmtDate(c.date, { day: "2-digit", month: "short", year: "2-digit" }))}</span><span class="desc"><b>${c.amount > 0 ? "Aportación" : "Retiro"}</b><span class="muted small">${esc(c.notes)}</span></span>
        <span class="amt ${c.amount > 0 ? "pos" : "neg"}">${esc(money(c.amount, g.currency, { sign: true }))}</span><button class="icon-btn" data-dc="${c.id}" aria-label="Eliminar">${icon("trash")}</button></div>`).join("") : '<div class="empty">Aún no hay aportaciones.</div>'}</section>`;
    const contrib = (kind) => modalForm(kind === "withdraw" ? "Retirar de la meta" : "Aportar a la meta", "gc-f", `${field("Importe", "amount", 'inputmode="decimal" required')}${field("Fecha", "date", 'type="date" required', todayStr())}${field("Nota", "notes", 'maxlength="300"')}`, "Guardar",
      async (d, m) => { await api("POST", `/api/goals/${id}/contribs`, { ...d, kind }); m.close(); toast("Registrado."); route(); });
    $("#gc").onclick = () => contrib("deposit"); $("#gw").onclick = () => contrib("withdraw"); $("#ge").onclick = () => goalModal(g);
    $("#ga").onclick = async () => { try { await api("PATCH", "/api/goals/" + id, { archived: !g.archived }); route(); } catch (e) { toast(e.message, "error"); } };
    $("#gd").onclick = async () => { if (!(await confirmDialog("¿Eliminar meta?", "Se borran también sus aportaciones."))) return; try { await api("DELETE", "/api/goals/" + id); go("#/goals"); } catch (e) { toast(e.message, "error"); } };
    $$("[data-dc]", view).forEach((b) => b.onclick = async () => { try { await api("DELETE", "/api/goals/contribs/" + b.dataset.dc); route(); } catch (e) { toast(e.message, "error"); } });
  });
}

/* ---------------------------------------------------------------- Tablas personalizadas */
const COL_LABEL = { text: "Texto", number: "Número", money: "Dinero", date: "Fecha", check: "Casilla" };
function columnsEditor(cols = [{ name: "", type: "text" }], locked = new Set()) {
  return `<div id="cols">${cols.map((c, i) => `<div class="col-row" data-i="${i}" data-id="${esc(c.id || "")}"><input class="cn" maxlength="60" placeholder="Nombre de la columna" value="${esc(c.name)}" aria-label="Nombre de columna">
    <select class="ct" aria-label="Tipo">${Object.entries(COL_LABEL).map(([k, v]) => `<option value="${k}" ${c.type === k ? "selected" : ""}>${v}</option>`).join("")}</select><button type="button" class="icon-btn rm" aria-label="Quitar columna">${icon("x")}</button></div>`).join("")}</div>
    <button type="button" class="btn sm" id="col-add">${icon("plus")} Columna</button>`;
}
function bindColumnsEditor(el) {
  const host = $("#cols", el);
  const bindRm = () => $$(".rm", host).forEach((b) => b.onclick = () => { if ($$(".col-row", host).length > 1) b.closest(".col-row").remove(); });
  bindRm();
  $("#col-add", el).onclick = () => { const d = document.createElement("div"); d.className = "col-row"; d.dataset.id = ""; d.innerHTML = `<input class="cn" maxlength="60" placeholder="Nombre de la columna" aria-label="Nombre de columna"><select class="ct" aria-label="Tipo">${Object.entries(COL_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select><button type="button" class="icon-btn rm" aria-label="Quitar columna">${icon("x")}</button>`; host.appendChild(d); bindRm(); $(".cn", d).focus(); };
  return () => $$(".col-row", host).map((r) => ({ ...(r.dataset.id ? { id: r.dataset.id } : {}), name: $(".cn", r).value, type: $(".ct", r).value }));
}
function tablesView(id) {
  if (id) return tableDetailView(id);
  const view = mountShell("tables", "Tablas", `<button class="btn primary" id="t-new">${icon("plus")} Tabla</button>`);
  const create = () => { let read; const m = modalForm("Nueva tabla", "t-f", `${field("Nombre", "name", 'maxlength="80" required placeholder="Suscripciones, Inventario, Pendientes…"')}<div class="lbl" style="margin-bottom:.4rem">Columnas</div>${columnsEditor([{ name: "", type: "text" }, { name: "", type: "money" }])}`, "Crear tabla",
    async (d, mm) => { const r = await api("POST", "/api/tables", { name: d.name, columns: read() }); mm.close(); go("#/tables/" + r.table.id); }, { onMount: (el) => { read = bindColumnsEditor(el); } }); return m; };
  $("#t-new").onclick = create;
  withRetry(view, async () => {
    const r = await api("GET", "/api/tables");
    if (!r.tables.length) { view.innerHTML = emptyCard("Sin tablas", "Crea tablas a tu medida (texto, números, dinero, fechas y casillas) con totales automáticos. Ideal para listas de suscripciones, pendientes o inventarios.", "t-e", "Crear tabla"); $("#t-e").onclick = create; return; }
    view.innerHTML = `<div class="grid acc-grid">${r.tables.map((t) => `<article class="card acc" tabindex="0" role="link" data-tb="${t.id}"><h3>${esc(t.name)}</h3><div class="muted small">${t.columns} columnas · ${t.rows} filas</div></article>`).join("")}</div>`;
    $$("[data-tb]", view).forEach((el) => { const open = () => go("#/tables/" + el.dataset.tb); el.onclick = open; el.onkeydown = (e) => { if (e.key === "Enter") open(); }; });
  });
}
function tableDetailView(id) {
  const view = mountShell("tables", "Tabla");
  withRetry(view, async () => {
    let t = (await api("GET", "/api/tables/" + id)).table;
    $(".topbar h1").innerHTML = `<button class="icon-btn" id="back" aria-label="Volver">${icon("back")}</button> ${esc(t.name)}`;
    $("#back").onclick = () => go("#/tables");
    const cellHtml = (c, v, rid) => c.type === "check" ? `<input type="checkbox" data-r="${rid}" data-c="${c.id}" ${v ? "checked" : ""} aria-label="${esc(c.name)}">`
      : `<input data-r="${rid}" data-c="${c.id}" type="${c.type === "date" ? "date" : "text"}" ${c.type === "number" || c.type === "money" ? 'inputmode="decimal" class="num"' : ""} value="${esc(v ?? "")}" aria-label="${esc(c.name)}">`;
    const totalCell = (c) => (c.type === "money" ? money(Math.round(parseFloat(t.totals[c.id] || 0) * 100), cur()) : c.type === "number" ? t.totals[c.id] : c.type === "check" ? `${t.totals[c.id]} ✓` : "");
    const draw = () => {
      view.innerHTML = `<div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1rem"><button class="btn primary sm" id="ar">${icon("plus")} Fila</button><button class="btn sm" id="ec">Columnas y nombre</button><button class="btn sm" id="ex">${icon("download")} CSV</button><button class="btn sm danger" id="dt">${icon("trash")} Eliminar tabla</button></div>
        <div class="tbl-wrap card" style="padding:0"><table class="sheet"><thead><tr>${t.columns.map((c) => `<th>${esc(c.name)} <span class="muted small">${COL_LABEL[c.type]}</span></th>`).join("")}<th></th></tr></thead>
        <tbody>${t.rows.map((r) => `<tr>${t.columns.map((c) => `<td>${cellHtml(c, r.data[c.id], r.id)}</td>`).join("")}<td><button class="icon-btn" data-dr="${r.id}" aria-label="Eliminar fila">${icon("trash")}</button></td></tr>`).join("") || `<tr><td colspan="${t.columns.length + 1}" class="empty">Sin filas. Usa “Fila” para agregar.</td></tr>`}</tbody>
        <tfoot><tr>${t.columns.map((c) => `<td class="tot" data-tot="${c.id}">${esc(totalCell(c))}</td>`).join("")}<td></td></tr></tfoot></table></div>`;
      $("#ar", view).onclick = async () => { try { t = (await api("POST", `/api/tables/${id}/rows`, { data: {} })).table; draw(); const last = $$("tbody tr:last-child input", view)[0]; if (last) last.focus(); } catch (e) { toast(e.message, "error"); } };
      $("#ex", view).onclick = () => downloadFile(`/api/tables/${id}.csv`);
      $("#dt", view).onclick = async () => { if (!(await confirmDialog("¿Eliminar tabla?", "Se borran todas sus filas."))) return; try { await api("DELETE", "/api/tables/" + id); go("#/tables"); } catch (e) { toast(e.message, "error"); } };
      $$("[data-dr]", view).forEach((b) => b.onclick = async () => { try { t = (await api("DELETE", `/api/tables/${id}/rows/${b.dataset.dr}`)).table; draw(); } catch (e) { toast(e.message, "error"); } });
      $$("tbody input", view).forEach((inp) => inp.onchange = async () => {
        const col = t.columns.find((c) => c.id === inp.dataset.c), val = inp.type === "checkbox" ? inp.checked : inp.value;
        try { t = (await api("PUT", `/api/tables/${id}/rows/${inp.dataset.r}`, { data: { [inp.dataset.c]: val } })).table; inp.classList.remove("bad");
          if (col.type === "money") { const row = t.rows.find((r) => r.id === +inp.dataset.r); inp.value = row.data[col.id] ?? ""; }
          $$("[data-tot]", view).forEach((td) => { const c = t.columns.find((x) => x.id === td.dataset.tot); td.textContent = totalCell(c); }); }
        catch (e) { inp.classList.add("bad"); toast(e.message, "error"); }
      });
      $("#ec", view).onclick = () => { let read; modalForm("Nombre y columnas", "ec-f", `${field("Nombre de la tabla", "name", 'maxlength="80" required', t.name)}<div class="lbl" style="margin-bottom:.4rem">Columnas</div>${columnsEditor(t.columns)}<p class="muted small">Una columna con datos no puede cambiar de tipo; crea una nueva. Al quitar una columna se borran sus datos.</p>`, "Guardar",
        async (d, mm) => { t = (await api("PATCH", "/api/tables/" + id, { name: d.name, columns: read() })).table; mm.close(); $(".topbar h1").innerHTML = `<button class="icon-btn" id="back" aria-label="Volver">${icon("back")}</button> ${esc(t.name)}`; $("#back").onclick = () => go("#/tables"); draw(); toast("Tabla actualizada."); }, { onMount: (el) => { read = bindColumnsEditor(el); } }); };
    };
    draw();
  });
}

/* ---------------------------------------------------------------- Comprobantes */
async function scanReceipt(file) {
  const fd = new FormData(); fd.append("file", file);
  return uploadForm("/api/receipts", fd);
}
/* Confirmar la lectura del comprobante y guardar el movimiento con lo mínimo: tipo, importe, fecha, cuenta y comercio. */
function receiptConfirmModal(rid, sug, onSaved) {
  const active = S.accounts.filter((a) => !a.archived);
  if (!active.length) { toast("Primero crea una cuenta para registrar movimientos.", "error"); return go("#/accounts"); }
  const lastAcc = store.get("lastAccount", active[0].id);
  const st = { type: "expense" };
  const m = openModal("Confirmar comprobante", "");
  const draw = (keep) => {
    const v = { ...keep };
    const accOpt = active.map((a) => `<option value="${a.id}" ${String(v.account_id ?? lastAcc) === String(a.id) ? "selected" : ""}>${esc(a.name)} (${a.currency})</option>`).join("");
    const cats = categoryOptions(st.type);
    m.el.querySelector(".modal").innerHTML = `<header><h2>Confirmar comprobante</h2><button class="icon-btn" data-close aria-label="Cerrar">${icon("x")}</button></header>
      <form id="rc-conf-f" novalidate><p class="muted small">Revisa lo que leyó FIPO y corrige lo que haga falta antes de guardar.</p>
        <div class="seg" role="tablist" aria-label="Tipo de movimiento">${["expense", "income"].map((k) => `<button type="button" role="tab" data-t="${k}" class="${st.type === k ? "on" : ""}" aria-selected="${st.type === k}">${TYPE_LABEL[k]}</button>`).join("")}</div>
        <div class="row2">${field("Importe", "amount", 'inputmode="decimal" placeholder="0.00" autocomplete="off" required', v.amount ?? (sug && sug.amount ? centsToInput(sug.amount) : ""))}
          ${field("Fecha", "date", 'type="date" required', v.date ?? (sug && sug.date ? sug.date : todayStr()))}</div>
        <div class="field"><label for="f-account_id">Cuenta</label><select id="f-account_id" name="account_id">${accOpt}</select></div>
        <div class="field"><label for="f-category_id">Categoría</label><select id="f-category_id" name="category_id"><option value="">Sin categoría</option>${cats.map(([id, n]) => `<option value="${id}" ${String(v.category_id ?? "") === String(id) ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></div>
        ${field("Comercio o descripción", "description", 'maxlength="200"', v.description ?? (sug ? sug.merchant || "" : ""))}
        <p class="muted small"><a href="#" id="rc-more">¿Necesitas más campos (método de pago, notas, transferencia)? Ábrelo completo</a></p>
        <footer><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" type="submit">Confirmar y guardar</button></footer></form>`;
    const form = $("#rc-conf-f", m.el);
    $$(".seg button", form).forEach((b) => b.onclick = () => { const d = formData(form); delete d.category_id; st.type = b.dataset.t; draw(d); });
    $("#rc-more", form).onclick = (e) => { e.preventDefault(); const d = formData(form); m.close(); txModal(null, { type: st.type, amount: d.amount, date: d.date, account_id: d.account_id, category_id: d.category_id, description: d.description, receipt_id: rid }); };
    form.onsubmit = (e) => { e.preventDefault(); submitForm(form, async () => {
      const d = formData(form);
      const saved = await api("POST", "/api/transactions", { type: st.type, amount: d.amount, date: d.date, account_id: d.account_id, category_id: d.category_id || null, description: d.description });
      try { await api("POST", `/api/receipts/${rid}/link`, { tx_id: saved.transaction.id }); } catch { /* el movimiento ya se guardó */ }
      store.set("lastAccount", d.account_id); m.close(); await refreshCore(); toast("Movimiento guardado a partir del comprobante."); if (onSaved) onSaved(); else route(); }); };
  };
  draw();
}
function receiptsView() {
  const view = mountShell("receipts", "Comprobantes");
  let filter = "unlinked";
  const draw = async () => {
    const r = await api("GET", "/api/receipts" + (filter === "unlinked" ? "?unlinked=1" : ""));
    $("#rc-list", view).innerHTML = r.receipts.length ? `<div class="grid acc-grid">${r.receipts.map((x) => `<article class="card"><a href="/api/receipts/${x.id}/file" target="_blank" rel="noopener"><img class="rc-img" src="/api/receipts/${x.id}/file" alt="Comprobante ${esc(x.filename)}" loading="lazy"></a>
      <div class="muted small" style="margin:.4rem 0">${esc(x.filename)} · ${x.tx_id ? "ligado a un movimiento" : "sin ligar"}</div><div style="display:flex;gap:.4rem;flex-wrap:wrap">${x.tx_id ? "" : `<button class="btn primary sm" data-use="${x.id}">Revisar y confirmar</button>`}<button class="btn sm danger" data-del="${x.id}" aria-label="Eliminar">${icon("trash")}</button></div></article>`).join("")}</div>` : '<div class="empty">No hay comprobantes en esta lista.</div>';
    $$("[data-use]", view).forEach((b) => b.onclick = async () => { try { const d = await api("GET", "/api/receipts/" + b.dataset.use); receiptConfirmModal(+b.dataset.use, d.suggestion, draw); } catch (e) { toast(e.message, "error"); } });
    $$("[data-del]", view).forEach((b) => b.onclick = async () => { if (!(await confirmDialog("¿Eliminar comprobante?", "Se borra la imagen guardada."))) return; try { await api("DELETE", "/api/receipts/" + b.dataset.del); draw(); } catch (e) { toast(e.message, "error"); } });
  };
  view.innerHTML = `<section class="card" style="margin-bottom:1rem;max-width:640px"><h2>Escanear un comprobante</h2><p class="muted small">Toma una foto de tu ticket. Revisa el importe antes de guardar.</p>
    <div class="field"><label for="rc-file">Foto del comprobante</label><input id="rc-file" type="file" accept="image/jpeg,image/png,image/webp" capture="environment"></div><div id="rc-out"></div></section>
    <div class="tabs" role="tablist"><button class="on" data-f="unlinked">Sin ligar</button><button data-f="all">Todos</button></div><div id="rc-list"><div class="spinner"></div></div>`;
  $$(".tabs button", view).forEach((b) => b.onclick = () => { filter = b.dataset.f; $$(".tabs button", view).forEach((x) => x.classList.toggle("on", x === b)); draw(); });
  $("#rc-file", view).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return; const out = $("#rc-out", view); out.innerHTML = '<div class="spinner"></div><p class="muted small" style="text-align:center">Leyendo comprobante…</p>';
    try {
      const r = await scanReceipt(f), s = r.suggestion;
      out.innerHTML = `<div class="note">${r.ocr_available ? (s && (s.amount || s.date || s.merchant) ? `Leí: <b>${esc(s.merchant || "comercio no detectado")}</b> · total <b>${s && s.amount ? esc(money(s.amount, cur(), { mask: false })) : "no detectado"}</b> · fecha <b>${s && s.date ? esc(fmtDate(s.date)) : "no detectada"}</b>.` : "No pude detectar datos en la imagen. Prueba con una foto más clara o captura el movimiento a mano.") : esc(r.ocr_error || "La lectura automática no está disponible en este servidor.") + " El comprobante quedó guardado."}</div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap"><button class="btn primary" id="rc-use">Revisar y confirmar</button><button class="btn" id="rc-keep">Solo guardar</button></div>${r.text ? `<details style="margin-top:.6rem"><summary class="muted small" style="cursor:pointer">Ver texto leído</summary><pre class="ocr">${esc(r.text)}</pre></details>` : ""}`;
      $("#rc-use", view).onclick = () => receiptConfirmModal(r.receipt.id, s, () => { out.innerHTML = ""; e.target.value = ""; draw(); }); $("#rc-keep", view).onclick = () => { out.innerHTML = ""; e.target.value = ""; draw(); toast("Comprobante guardado."); };
      draw();
    } catch (er) { out.innerHTML = ""; toast(er.message, "error"); }
  };
  draw().catch((e) => { $("#rc-list", view).innerHTML = errorBox(e); });
}
