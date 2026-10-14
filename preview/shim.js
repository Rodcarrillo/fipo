/* Vista previa web: reemplaza el servidor Flask por una versión en el navegador.
   Misma API, mismas reglas financieras (port de ledger.py). Los datos viven en localStorage. */
"use strict";
(function () {
  const KEY = "fipo.preview.v1", OLD_KEY = "oliva.preview.v1";
  const CURRENCIES = ["MXN", "USD", "EUR", "GBP", "CAD", "COP", "ARS", "CLP", "PEN", "BRL"];
  // Tipos de cambio de ejemplo (unidades por 1 USD) SOLO para la vista previa: aquí no hay conexión con Yahoo
  // Finance, así que no puede traer el tipo de cambio real. Sirven para mostrar cómo se vería el botón
  // «ver en <moneda principal>»; en la app con servidor el tipo de cambio se consulta de verdad y se actualiza.
  const FX_USD = { USD: 1, MXN: 18.5, EUR: 0.92, GBP: 0.79, CAD: 1.36, COP: 3950, ARS: 990, CLP: 960, PEN: 3.75, BRL: 5.4 };
  function fxRate(from, to) {
    from = (from || "").toUpperCase(); to = (to || "").toUpperCase();
    if (!from || !to || from === to) return 1;
    const rf = FX_USD[from], rt = FX_USD[to];
    if (!rf || !rt) return null;
    return rt / rf;
  }
  const ACC_TYPES = ["bank", "cash", "savings", "digital", "credit", "investment", "other"];
  const TX_TYPES = ["expense", "income", "transfer", "refund", "adjustment"];
  const EXP_CATS = ["Comida", "Transporte", "Vivienda", "Entretenimiento", "Salud", "Educación", "Viajes", "Servicios", "Suscripciones", "Compras", "Inversiones"];
  const INC_CATS = ["Nómina", "Ventas", "Negocio", "Rendimientos", "Reembolsos", "Otros ingresos"];
  let TZS = ["America/Mexico_City", "America/Merida", "America/Bogota", "America/Lima", "America/Santiago", "America/Argentina/Buenos_Aires", "America/New_York", "America/Los_Angeles", "Europe/Madrid", "UTC"];
  try { const l = Intl.supportedValuesOf("timeZone"); if (l && l.length) TZS = l; } catch { /* lista corta */ }

  /* ---------- persistencia ---------- */
  let mem = null;
  const fresh = () => ({ users: [], accounts: [], categories: [], transactions: [], ops: [], quotes: {}, imports: [], debts: [], debtPays: [], budgets: [], goals: [], contribs: [], tables: [], plans: [], planCharges: [], recurring: [], seq: { u: 0, a: 0, c: 0, t: 0, o: 0, i: 0, d: 0, dp: 0, g: 0, gc: 0, tb: 0, tr: 0, pl: 0, rc: 0 }, session: null });
  function db() {
    if (mem) return mem;
    try { const r = localStorage.getItem(KEY) || localStorage.getItem(OLD_KEY); if (r) mem = JSON.parse(r); } catch { /* vacío */ }
    mem = mem || fresh();
    mem.ops = mem.ops || []; mem.quotes = mem.quotes || {}; mem.imports = mem.imports || []; mem.seq.o = mem.seq.o || 0; mem.seq.i = mem.seq.i || 0;
    for (const k of ["debts", "debtPays", "budgets", "goals", "contribs", "tables", "plans", "planCharges", "recurring"]) mem[k] = mem[k] || []; for (const k of ["d", "dp", "g", "gc", "tb", "tr", "pl", "rc"]) mem.seq[k] = mem.seq[k] || 0;
    return mem;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch { /* sin almacenamiento: sigue en memoria */ } }
  function resetAll() { mem = fresh(); save(); }
  const nid = (k) => (db().seq[k] += 1);

  /* ---------- utilidades ---------- */
  const fail = (msg, status = 400, field = null) => { throw new ApiError(msg, status, field); };
  const MAX = 1e13;
  function toCents(v, field = "importe", { neg = false, zero = false } = {}) {
    if (v === null || v === undefined || (typeof v === "string" && !v.trim())) fail("Introduce un importe.", 400, field);
    let s = String(v).replace(/[,$\s]/g, "");
    const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
    if (!m || (m[2] === "" && (m[3] === undefined || m[3] === ""))) fail("El importe no es un número válido.", 400, field);
    const frac = ((m[3] || "") + "000").slice(0, 3);
    let cents = (parseInt(m[2] || "0", 10)) * 100 + parseInt(frac.slice(0, 2), 10) + (parseInt(frac[2], 10) >= 5 ? 1 : 0);
    if (m[1] === "-") cents = -cents;
    if (Math.abs(cents) > MAX) fail("El importe es demasiado grande.", 400, field);
    if (cents < 0 && !neg) fail("El importe no puede ser negativo.", 400, field);
    if (cents === 0 && !zero) fail("El importe debe ser mayor que cero.", 400, field);
    return cents;
  }
  function parseDate(v, field = "fecha") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
    if (!m) fail("La fecha no es válida (AAAA-MM-DD).", 400, field);
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) fail("La fecha no es válida (AAAA-MM-DD).", 400, field);
    if (+m[1] < 1990 || +m[1] > 2100) fail("La fecha está fuera de rango.", 400, field);
    return String(v);
  }
  const U = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  const fromU = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
  const addDays = (s, n) => fromU(U(s) + n * 86400000);
  const dowMon0 = (s) => (new Date(U(s)).getUTCDay() + 6) % 7;
  const monthStart = (s) => s.slice(0, 8) + "01";
  const monthEnd = (y, m) => fromU(Date.UTC(y, m, 0));           // m = 1..12
  const todayFor = (tz) => { try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date()); } catch { return ymd(new Date()); } };
  function text(v, field, max, required = false) {
    const s = v == null ? "" : String(v).trim();
    if (required && !s) fail("Este campo es obligatorio.", 400, field);
    if (s.length > max) fail(`Máximo ${max} caracteres.`, 400, field);
    return s;
  }
  async function hashPw(pw, salt) {
    try {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + ":" + pw));
      return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch { let h = 5381; const s = salt + ":" + pw; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return "x" + (h >>> 0).toString(16); }
  }
  const rid = () => Math.random().toString(36).slice(2, 12);
  const userDict = (u) => ({ id: u.id, name: u.name, email: u.email, currency: u.currency, timezone: u.timezone, theme: u.theme, onboarded: !!u.onboarded, notify_email: false });
  const me = () => { const d = db(); return d.users.find((u) => u.id === d.session) || null; };
  function need() { const u = me(); if (!u) throw new ApiError("Inicia sesión para continuar.", 401); return u; }

  /* ---------- saldos ---------- */
  function effect(t, accId) {
    let e = 0;
    if (t.account_id === accId) {
      if (t.type === "income" || t.type === "refund" || t.type === "adjustment") e += t.amount;
      else if (t.type === "expense" || t.type === "transfer") e -= t.amount;
    }
    if (t.type === "transfer" && t.to_account_id === accId) e += t.to_amount;
    return e;
  }
  const opCash = (o) => (o.kind === "buy" ? -(o.gross + o.fee) : o.gross - o.fee);
  const balanceOf = (uid, a) => a.opening_balance + db().transactions.filter((t) => t.user_id === uid && (t.account_id === a.id || t.to_account_id === a.id)).reduce((s, t) => s + effect(t, a.id), 0)
    + db().ops.filter((o) => o.user_id === uid && o.account_id === a.id).reduce((s, o) => s + opCash(o), 0)
    - db().debtPays.filter((p) => p.user_id === uid && p.account_id === a.id).reduce((s, p) => s + p.principal_part + p.interest_part, 0);
  const accRow = (uid, a) => ({ id: a.id, name: a.name, institution: a.institution, type: a.type, currency: a.currency, opening_balance: a.opening_balance,
    opened_on: a.opened_on, low_balance_alert: a.low_balance_alert, archived: !!a.archived, is_demo: !!a.is_demo, balance: balanceOf(uid, a), credit_limit: a.credit_limit || 0, cut_day: a.cut_day || 0, due_day: a.due_day || 0 });
  const myAcc = (uid, id) => db().accounts.find((a) => a.user_id === uid && a.id === Number(id));
  const myCat = (uid, id) => db().categories.find((c) => c.user_id === uid && c.id === Number(id));
  const cmpName = (a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" });

  /* ---------- movimientos ---------- */
  function normalizeTx(uid, d, existing) {
    const type = d.type;
    if (!TX_TYPES.includes(type)) fail("Tipo de movimiento no válido.", 400, "type");
    if (existing && existing.type !== type && (type === "adjustment" || existing.type === "adjustment")) fail("Un ajuste no puede convertirse en otro tipo de movimiento.", 400, "type");
    const tx = { type };
    tx.amount = toCents(d.amount, "amount", { neg: type === "adjustment" });
    tx.date = parseDate(d.date);
    const acc = myAcc(uid, d.account_id);
    if (!acc) fail("Selecciona una cuenta válida.", 400, "account_id");
    if (acc.archived && !(existing && existing.account_id === acc.id)) fail("La cuenta está archivada.", 400, "account_id");
    tx.account_id = acc.id; tx.to_account_id = null; tx.to_amount = null; tx.category_id = null;
    if (type === "transfer") {
      const dest = myAcc(uid, d.to_account_id);
      if (!dest) fail("Selecciona la cuenta de destino.", 400, "to_account_id");
      if (dest.id === acc.id) fail("El origen y el destino deben ser distintos.", 400, "to_account_id");
      if (dest.archived && !(existing && existing.to_account_id === dest.id)) fail("La cuenta de destino está archivada.", 400, "to_account_id");
      tx.to_account_id = dest.id;
      if (dest.currency === acc.currency) tx.to_amount = tx.amount;
      else {
        if (d.to_amount === null || d.to_amount === undefined || d.to_amount === "") fail(`Las cuentas usan monedas distintas (${acc.currency} → ${dest.currency}). Indica el importe que recibe la cuenta destino.`, 400, "to_amount");
        tx.to_amount = toCents(d.to_amount, "to_amount");
      }
    } else if (type !== "adjustment") {
      if (d.category_id !== null && d.category_id !== undefined && d.category_id !== "") {
        const cat = myCat(uid, d.category_id);
        if (!cat) fail("La categoría no es válida.", 400, "category_id");
        if (cat.kind !== (type === "income" ? "income" : "expense")) fail("La categoría no corresponde al tipo de movimiento.", 400, "category_id");
        if (cat.archived && !(existing && existing.category_id === cat.id)) fail("La categoría está archivada.", 400, "category_id");
        tx.category_id = cat.id;
      }
    }
    tx.description = text(d.description, "description", 200);
    tx.payment_method = text(d.payment_method, "payment_method", 60);
    tx.notes = text(d.notes, "notes", 2000);
    let tags = d.tags || ""; if (Array.isArray(tags)) tags = tags.join(",");
    tx.tags = text(String(tags).split(/[,;]/).map((x) => x.trim()).filter(Boolean).join(","), "tags", 300);
    tx.recurring = d.recurring ? 1 : 0;
    return tx;
  }
  function txView(t) {
    const a = db().accounts.find((x) => x.id === t.account_id), ta = t.to_account_id ? db().accounts.find((x) => x.id === t.to_account_id) : null;
    const c = t.category_id ? db().categories.find((x) => x.id === t.category_id) : null, pl = (db().plans || []).find((p) => p.transaction_id === t.id);
    return { ...t, recurring: !!t.recurring, is_demo: !!t.is_demo, account_name: a.name, account_currency: a.currency, to_account_name: ta ? ta.name : null, category_name: c ? c.name : null,
      plan_kind: pl ? pl.kind : null, plan_months: pl ? pl.months_total : null, plan_monthly: pl ? pl.monthly_amount : null };
  }
  function queryTx(uid, q, paginate = true) {
    let rows = db().transactions.filter((t) => t.user_id === uid).map(txView);
    const s = (q.q || "").trim().toLowerCase();
    if (s) rows = rows.filter((t) => [t.description, t.notes, t.tags, t.category_name, t.account_name].some((x) => (x || "").toLowerCase().includes(s)));
    if (q.from) { const f = parseDate(q.from, "from"); rows = rows.filter((t) => t.date >= f); }
    if (q.to) { const f = parseDate(q.to, "to"); rows = rows.filter((t) => t.date <= f); }
    if (q.account_id) rows = rows.filter((t) => t.account_id === +q.account_id || t.to_account_id === +q.account_id);
    if (q.category_id) rows = rows.filter((t) => t.category_id === +q.category_id);
    if (TX_TYPES.includes(q.type)) rows = rows.filter((t) => t.type === q.type);
    const dir = q.dir === "asc" ? 1 : -1;
    const key = { date: (t) => t.date, description: (t) => (t.description || "").toLowerCase(), category: (t) => (t.category_name || "").toLowerCase(),
      account: (t) => t.account_name.toLowerCase(), type: (t) => t.type, amount: (t) => t.amount }[q.sort] || ((t) => t.date);
    rows.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || (a.id - b.id) * dir; });
    const total = rows.length; let page = null, per = null;
    if (paginate) {
      page = Math.max(1, parseInt(q.page || 1, 10) || 1); per = Math.min(100, Math.max(5, parseInt(q.per_page || 25, 10) || 25));
      rows = rows.slice((page - 1) * per, page * per);
    }
    return { rows, total, page, per };
  }
  function createTx(uid, d, isDemo = 0) { const tx = normalizeTx(uid, d); const row = { id: nid("t"), user_id: uid, is_demo: isDemo, created_at: nowStr(), updated_at: nowStr(), ...tx }; db().transactions.push(row); return row; }
  const nowStr = () => new Date().toISOString().replace("T", " ").slice(0, 19);

  /* ---------- dashboard ---------- */
  function periodRange(period, today, from, to) {
    const [y, m] = today.split("-").map(Number);
    if (period === "today") return [today, today];
    if (period === "week") { const s = addDays(today, -dowMon0(today)); return [s, addDays(s, 6)]; }
    if (period === "3months") { let mm = m - 2, yy = y; if (mm < 1) { mm += 12; yy -= 1; } return [`${yy}-${pad(mm)}-01`, today]; }
    if (period === "year") return [`${y}-01-01`, `${y}-12-31`];
    if (period === "custom") { const s = parseDate(from, "from"), e = parseDate(to, "to"); if (e < s) fail("La fecha final es anterior a la inicial.", 400, "to"); return [s, e]; }
    return [`${y}-${pad(m)}-01`, monthEnd(y, m)];
  }
  const PREV_LABEL = { today: "vs. ayer", week: "vs. la semana pasada", month: "vs. el mes pasado", "3months": "vs. los 3 meses anteriores", year: "vs. el año pasado", custom: "vs. el periodo anterior" };
  function shiftMonthsDay(dstr, n) { const y0 = +dstr.slice(0, 4), m0 = +dstr.slice(5, 7) - 1 + n, y = y0 + Math.floor(m0 / 12), m = ((m0 % 12) + 12) % 12 + 1; return `${y}-${pad(m)}-${pad(Math.min(+dstr.slice(8), daysInMonth(y, m)))}`; }
  function previousPeriod(period, s, e, today) {       // mismo avance: «esta semana» (lun-mié) contra lun-mié de la anterior (igual que ledger.previous_period)
    const end = period === "custom" ? e : (e < today ? e : today);
    if (end < s) return null;
    if (period === "custom") { const n = (U(e) - U(s)) / 86400000 + 1; return [addDays(s, -n), addDays(s, -1)]; }
    if (period === "today" || period === "week") { const n = period === "today" ? 1 : 7; return [addDays(s, -n), addDays(end, -n)]; }
    const k = { "3months": 3, year: 12 }[period] || 1, pe = shiftMonthsDay(end, -k), lim = addDays(s, -1);
    return [shiftMonthsDay(s, -k), pe < lim ? pe : lim];
  }
  function sumPeriod(uid, s, e, cur) {
    let inc = 0, exp = 0;
    for (const t of db().transactions) {
      if (t.user_id !== uid || t.date < s || t.date > e) continue;
      const a = db().accounts.find((x) => x.id === t.account_id); if (a.currency !== cur) continue;
      if (t.type === "income") inc += t.amount; else if (t.type === "expense") exp += t.amount; else if (t.type === "refund") exp -= t.amount;
    }
    return [inc, exp];
  }
  function dashboard(u, q) {
    const uid = u.id, cur = u.currency, today = todayFor(u.timezone), period = q.period || "month";
    const [s, e] = periodRange(period, today, q.from, q.to);
    const accounts = db().accounts.filter((a) => a.user_id === uid && !a.archived).sort(cmpName).map((a) => accRow(uid, a));
    const main = accounts.filter((a) => a.currency === cur), other = accounts.filter((a) => a.currency !== cur);
    const total = main.filter((a) => a.type !== "credit").reduce((x, a) => x + a.balance, 0), cardDebt = main.filter((a) => a.type === "credit").reduce((x, a) => x - a.balance, 0), debtsTotal = debtsRemaining(uid, cur);
    const liquid = main.filter((a) => ["bank", "cash", "savings", "digital"].includes(a.type)).reduce((x, a) => x + a.balance, 0);
    const invested = main.filter((a) => a.type === "investment").reduce((x, a) => x + a.balance, 0);
    const [income, expense] = sumPeriod(uid, s, e, cur);
    const pp = previousPeriod(period, s, e, today); let prev = null;
    if (pp) { const [pi, pe_] = sumPeriod(uid, pp[0], pp[1], cur); prev = { from: pp[0], to: pp[1], income: pi, expense: pe_, label: PREV_LABEL[period] || PREV_LABEL.custom, expense_change_pct: pe_ > 0 ? Math.round(((expense - pe_) * 10000) / pe_) / 100 : null }; }
    const monthly = (U(e) - U(s)) / 86400000 > 62;
    const bucket = {};
    for (const t of db().transactions) {
      if (t.user_id !== uid || t.date < s || t.date > e || !["income", "expense", "refund"].includes(t.type)) continue;
      if (db().accounts.find((x) => x.id === t.account_id).currency !== cur) continue;
      const k = monthly ? t.date.slice(0, 7) : t.date;
      const b = (bucket[k] = bucket[k] || { income: 0, expense: 0 });
      if (t.type === "income") b.income += t.amount; else if (t.type === "expense") b.expense += t.amount; else b.expense -= t.amount;
    }
    const series = [];
    if (monthly) {
      let [y, m] = s.split("-").map(Number); const [ey, em] = e.split("-").map(Number);
      while (y < ey || (y === ey && m <= em)) { const k = `${y}-${pad(m)}`, b = bucket[k]; series.push({ key: k, income: b ? b.income : 0, expense: b ? b.expense : 0 }); m += 1; if (m > 12) { m = 1; y += 1; } }
    } else {
      const end = period === "custom" ? e : (e < today ? e : today); const last = end > s ? end : s;
      for (let d = s; d <= last; d = addDays(d, 1)) { const b = bucket[d]; series.push({ key: d, income: b ? b.income : 0, expense: b ? b.expense : 0 }); }
    }
    const cats = {};
    for (const t of db().transactions) {
      if (t.user_id !== uid || t.date < s || t.date > e || !["expense", "refund"].includes(t.type)) continue;
      if (db().accounts.find((x) => x.id === t.account_id).currency !== cur) continue;
      const k = t.category_id || 0; cats[k] = (cats[k] || 0) + (t.type === "expense" ? t.amount : -t.amount);
    }
    const catList = Object.entries(cats).filter(([, v]) => v > 0).map(([k, v]) => { const c = +k ? db().categories.find((x) => x.id === +k) : null; return { id: c ? c.id : null, name: c ? c.name : "Sin categoría", total: v }; }).sort((a, b) => b.total - a.total);
    return {
      period: { key: period, from: s, to: e, today }, currency: cur,
      cards: { total_money: total, available: liquid, invested, income, expense, net: income - expense, card_debt: cardDebt, debts_total: debtsTotal, investments_value: invested, net_worth: total - cardDebt - debtsTotal },
      excluded_accounts: other.map((a) => ({ name: a.name, currency: a.currency, balance: a.balance })),
      series, series_unit: monthly ? "month" : "day", categories: catList,
      latest: queryTx(uid, { per_page: 8, sort: "date", dir: "desc" }).rows, previous: prev, alerts: alerts(u, accounts, today).concat(budgetAlerts(u)),
    };
  }
  function alerts(u, accounts, today) {
    const out = [];
    for (const a of accounts) {
      if (a.type === "credit") {
        const used = -a.balance;
        if (a.credit_limit && used > 0 && used >= a.credit_limit * 0.8) out.push({ level: used >= a.credit_limit ? "danger" : "warn", text: `La tarjeta «${a.name}» usa ${Math.round((used * 100) / a.credit_limit)}% de su límite.`, account_id: a.id, link: "#/cards" });
        const due = nextDay(today, a.due_day); if (due && used > 0 && (U(due) - U(today)) / 86400000 <= 5) out.push({ level: "warn", text: `La tarjeta «${a.name}» vence el ${due} y debes ${(used / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}.`, account_id: a.id, link: "#/cards" });
        continue;
      }
      if (a.balance < 0) out.push({ level: "danger", text: `La cuenta «${a.name}» tiene saldo negativo.`, account_id: a.id, link: "#/accounts/" + a.id });
      else if (a.low_balance_alert && a.balance < a.low_balance_alert) out.push({ level: "warn", text: `La cuenta «${a.name}» está por debajo de tu límite de saldo bajo.`, account_id: a.id, link: "#/accounts/" + a.id });
    }
    const [y0, m0] = today.split("-").map(Number); const totals = []; let y = y0, m = m0;
    for (let i = 0; i < 3; i++) { m -= 1; if (m < 1) { m = 12; y -= 1; } const [, ex] = sumPeriod(u.id, `${y}-${pad(m)}-01`, monthEnd(y, m), u.currency); if (ex > 0) totals.push(ex); }
    if (totals.length) {
      const avg = totals.reduce((a, b) => a + b, 0) / totals.length, day = +today.slice(8);
      const [, now] = sumPeriod(u.id, monthStart(today), today, u.currency);
      const dim = +monthEnd(y0, m0).slice(8);
      if (day >= 7 && now > ((avg * day) / dim) * 1.3) out.push({ level: "warn", text: "Tus gastos de este mes van por encima de tu promedio habitual (últimos meses con datos).", link: "#/analysis" });
    }
    return out;
  }

  /* ---------- demo ---------- */
  const DEMO_SYMBOLS = ["DEMOACCA", "DEMOFND1"];
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  /* Crea cuentas, tarjeta, deuda, presupuestos, metas y portafolio de ejemplo (10 meses), igual que ledger.load_demo
     en el servidor, para que la vista previa muestre lo mismo que la app real. Todo queda marcado is_demo=1. */
  function loadDemo(u) {
    const d = db(); if (d.accounts.some((a) => a.user_id === u.id && a.is_demo)) fail("Los datos de demostración ya están cargados.");
    const today = todayFor(u.timezone), cur = u.currency, first = shiftM(monthStart(today), -9).s, ids = {};
    let n = 0;
    [["bank", "[DEMO] Cuenta de nómina", "bank", 1500000, 0, 0, 0], ["cash", "[DEMO] Efectivo", "cash", 800000, 0, 0, 0], ["sav", "[DEMO] Ahorro", "savings", 1200000, 0, 0, 0],
      ["card", "[DEMO] Visa", "credit", 0, 5000000, 20, 5], ["inv", "[DEMO] Inversiones", "investment", 1500000, 0, 0, 0]].forEach(([k, name, typ, ob, cl, cutd, dued]) => {
      const a = { id: nid("a"), user_id: u.id, name, institution: "Demostración", type: typ, currency: cur, opening_balance: ob, opened_on: first, low_balance_alert: 0,
        credit_limit: cl, cut_day: cutd, due_day: dued, archived: 0, is_demo: 1 };
      d.accounts.push(a); ids[k] = a.id;
    });
    const cats = {};
    [["[DEMO] Comida", "expense"], ["[DEMO] Transporte", "expense"], ["[DEMO] Servicios", "expense"], ["[DEMO] Entretenimiento", "expense"], ["[DEMO] Suscripciones", "expense"],
      ["[DEMO] Nómina", "income"], ["[DEMO] Ventas", "income"]].forEach(([name, k]) => {
      const c = { id: nid("c"), user_id: u.id, name, kind: k, parent_id: null, archived: 0, is_demo: 1 }; d.categories.push(c); cats[name] = c.id;
    });
    const add = (type, amount, date, acc, cat, desc, toAcc, toAmount) => {
      d.transactions.push({ id: nid("t"), user_id: u.id, type, amount, to_amount: toAmount ?? null, date, account_id: ids[acc], to_account_id: toAcc ? ids[toAcc] : null,
        category_id: cat ? cats[cat] : null, description: desc, payment_method: "", tags: "", notes: "", recurring: 0, is_demo: 1, created_at: nowStr(), updated_at: nowStr() }); n += 1;
    };
    // a partir del mes 6 hay un pequeño "aumento" de sueldo: crea una tendencia de ahorro real (no solo
    // ruido) entre la primera y la segunda mitad del historial, para el insight de Tendencia
    const midx = (dstr) => { const [fy, fm] = first.split("-").map(Number); const [dy, dm] = dstr.split("-").map(Number); return (dy - fy) * 12 + (dm - fm); };
    let i = 0;
    for (let day = first; day <= today; day = addDays(day, 1)) {
      i += 1; const wd = dowMon0(day), dn = +day.slice(8);
      if (dn === 1 || dn === 15) add("income", midx(day) >= 6 ? 2000000 : 1800000, day, "bank", "[DEMO] Nómina", "Pago quincenal");
      if (dn === 20 && Math.floor(i / 30) % 3 === 0) add("income", 350000 + (i % 4) * 40000, day, "bank", "[DEMO] Ventas", "Venta extra");
      if (wd === 1 || wd === 4) add("expense", 25000 + (i % 5) * 4500, day, "cash", "[DEMO] Comida", "Comida");
      if (wd === 0) add("expense", 12000 + (i % 3) * 3000, day, "bank", "[DEMO] Transporte", "Transporte");
      if (dn === 5) add("expense", 95000, day, "bank", "[DEMO] Servicios", "Renta de internet y luz");
      if (wd === 5) add("expense", 40000 + (i % 4) * 6000, day, "bank", "[DEMO] Entretenimiento", "Salida de fin de semana");
      if (dn === 3) add("expense", 19900, day, "bank", "[DEMO] Suscripciones", "Streaming de video");
      if (dn === 8) add("expense", 11500, day, "bank", "[DEMO] Suscripciones", "Música en streaming");
      if (wd === 2) add("expense", 18000 + (i % 3) * 5000, day, "card", "[DEMO] Entretenimiento", "Cena o salida");
    }
    // gasto puntual (no recurrente) unos días antes de hoy: da pie a un insight de Atención real, con
    // transporte y entretenimiento como responsables, tal como el ejemplo que pidió el usuario
    [["Reparación del auto", 350000, 4, "[DEMO] Transporte"], ["Concierto", 250000, 2, "[DEMO] Entretenimiento"]].forEach(([desc, amt, daysBefore, cat]) => {
      const sd = addDays(today, -daysBefore);
      if (sd >= first) add("expense", amt, sd, "bank", cat, desc);
    });
    // ahorro mensual, pago de tarjeta y retiro de efectivo
    let mstart = first, transfers = 0;
    while (mstart <= today) {
      const [my, mm] = mstart.split("-").map(Number);
      const saveDay = `${my}-${pad(mm)}-${pad(Math.min(20, daysInMonth(my, mm)))}`;
      if (saveDay <= today) { const amt2 = 280000 + transfers * 15000; add("transfer", amt2, saveDay, "bank", null, "Ahorro mensual", "sav", amt2); transfers += 1; }
      const payDay = `${my}-${pad(mm)}-${pad(Math.min(27, daysInMonth(my, mm)))}`;
      if (payDay <= today && mstart > first) add("transfer", 60000, payDay, "bank", null, "Pago de tarjeta Visa", "card", 60000);
      const cashDay = `${my}-${pad(mm)}-${pad(Math.min(10, daysInMonth(my, mm)))}`;
      if (cashDay <= today) add("transfer", 320000, cashDay, "bank", null, "Retiro de efectivo", "cash", 320000);
      mstart = shiftM(mstart, 1).s;
    }
    // deuda de ejemplo con abonos mensuales
    const debtId = nid("d");
    d.debts.push({ id: debtId, user_id: u.id, name: "[DEMO] Préstamo auto", creditor: "Banco Demo", currency: cur, principal: 8000000, interest_rate: 13.5,
      start_date: first, monthly_payment: 250000, due_day: 10, notes: "Ejemplo de demostración", archived: 0, is_demo: 1 });
    mstart = first;
    while (mstart <= today) {
      const [my, mm] = mstart.split("-").map(Number), pd = `${my}-${pad(mm)}-${pad(Math.min(10, daysInMonth(my, mm)))}`;
      if (pd <= today && mstart > first) { d.debtPays.push({ id: nid("dp"), user_id: u.id, debt_id: debtId, date: pd, principal_part: 218000, interest_part: 32000, account_id: null, notes: "Abono mensual" }); n += 1; }
      mstart = shiftM(mstart, 1).s;
    }
    // compra a 12 meses sin intereses y suscripciones en la tarjeta (igual que ledger.load_demo)
    const buyDay = addDays(today, -75), pantalla = 1199900;
    if (buyDay >= first) {
      add("expense", pantalla, buyDay, "card", "[DEMO] Entretenimiento", "Pantalla 55 pulgadas");
      const tv = d.transactions[d.transactions.length - 1];
      d.plans.push({ id: nid("pl"), user_id: u.id, account_id: ids.card, kind: "msi", description: "Pantalla 55 pulgadas", monthly_amount: Math.floor((pantalla + 6) / 12), months_total: 12,
        months_remaining: 12, principal_remaining: pantalla, interest_rate: 0, start_date: buyDay, transaction_id: tv.id, is_demo: 1, created_at: nowStr() });
    }
    [["Netflix", 21900, "[DEMO] Suscripciones", 6], ["Spotify", 12900, "[DEMO] Suscripciones", 13], ["Plan de teléfono", 39900, "[DEMO] Servicios", 20]].forEach(([desc, amt, cat, ahead]) => {
      const nd_ = addDays(today, ahead);
      d.recurring.push({ id: nid("rc"), user_id: u.id, account_id: ids.card, category_id: cats[cat], description: desc, amount: amt, frequency: "monthly", anchor_day: +nd_.slice(8), next_date: nd_, active: 1, is_demo: 1, created_at: nowStr() });
    });
    // presupuestos
    [["[DEMO] Comida", 900000], ["[DEMO] Entretenimiento", 350000], ["[DEMO] Transporte", 250000]].forEach(([name, amount]) => d.budgets.push({ user_id: u.id, category_id: cats[name], amount }));
    // metas de ahorro
    const g1 = { id: nid("g"), user_id: u.id, name: "[DEMO] Fondo de emergencia", target: 5000000, target_date: addDays(today, 150), currency: cur, notes: "", archived: 0, is_demo: 1 }; d.goals.push(g1);
    const g2 = { id: nid("g"), user_id: u.id, name: "[DEMO] Vacaciones", target: 2000000, target_date: addDays(today, 240), currency: cur, notes: "", archived: 0, is_demo: 1 }; d.goals.push(g2);
    mstart = first; let k = 0;
    while (mstart <= today) {
      const [my, mm] = mstart.split("-").map(Number), cd = `${my}-${pad(mm)}-${pad(Math.min(18, daysInMonth(my, mm)))}`;
      if (cd <= today) {
        d.contribs.push({ id: nid("gc"), user_id: u.id, goal_id: g1.id, date: cd, amount: 320000, notes: "" }); n += 1;
        if (k % 2 === 0) { d.contribs.push({ id: nid("gc"), user_id: u.id, goal_id: g2.id, date: cd, amount: 150000, notes: "" }); n += 1; }
      }
      mstart = shiftM(mstart, 1).s; k += 1;
    }
    // portafolio de ejemplo (símbolos sintéticos, sin cotización real)
    [[DEMO_SYMBOLS[0], "Demo Acciones SA", "stock", 4, 18000, "10"], [DEMO_SYMBOLS[1], "Demo Fondo Índice", "etf", 3, 42000, "5"]].forEach(([sym, name, atype, buys, unitCost, qty]) => {
      mstart = first; let done = 0;
      while (mstart <= today && done < buys) {
        const [my, mm] = mstart.split("-").map(Number), bd = `${my}-${pad(mm)}-${pad(Math.min(12, daysInMonth(my, mm)))}`;
        if (bd <= today) {
          const gross = unitCost * Number(qty);
          d.ops.push({ id: nid("o"), user_id: u.id, symbol: sym, name, asset_type: atype, kind: "buy", quantity: qty, price: (unitCost / 100).toFixed(2), gross, fee: 0,
            currency: cur, date: bd, account_id: ids.inv, notes: "", is_demo: 1 });
          n += 1; done += 1;
        }
        mstart = shiftM(mstart, 1).s;
      }
      const price = Math.round(unitCost * 1.15);
      d.quotes[sym] = { price: price / 100, prev_close: (price / 100) * 0.98, source: "manual", at: new Date().toISOString() };
    });
    // vigilancia de ejemplo (símbolos reales, con un precio de ejemplo fijo: en la vista previa no hay Yahoo Finance)
    ensureN(d);
    [["GOOGL", "Alphabet Inc.", 330, 400, 15, 343.92], ["META", "Meta Platforms, Inc.", 510, 650, 16, 751.66],
     ["MELI", "MercadoLibre, Inc.", 1750, 1960, 23, 1752.61], ["OSCR", "Oscar Health, Inc.", 25.5, 35, 29, 29.60]].forEach(([sym, company, entry, exitp, daysAhead, price]) => {
      d.watchlist.push({ id: ++d.wseq, user_id: u.id, symbol: sym, company, report_date: addDays(today, daysAhead), entry_price: entry, exit_price: exitp, notes: "", is_demo: 1 });
      if (!d.quotes[sym]) d.quotes[sym] = { price, prev_close: price * 0.99, currency: "USD", source: "manual", at: new Date().toISOString() };  // cotizan en dólares
      n += 1;
    });
    return n;
  }
  function deleteDemo(u) {
    const d = db(), demoIds = d.accounts.filter((a) => a.user_id === u.id && a.is_demo).map((a) => a.id);
    if (d.transactions.some((t) => t.user_id === u.id && !t.is_demo && (demoIds.includes(t.account_id) || demoIds.includes(t.to_account_id))))
      fail("Hay movimientos reales que usan cuentas de demostración. Edítalos o elimínalos primero para no perder tu información real.");
    const before = d.transactions.length;
    ensureN(d);
    const demoRec = d.recurring.filter((r) => r.user_id === u.id && r.is_demo).map((r) => r.id);
    d.notifs = d.notifs.filter((x) => !(x.user_id === u.id && demoRec.some((id) => (x.key || "").startsWith(`rec:${id}:`) || (x.key || "").startsWith(`rec-paused:${id}:`))));
    d.recurring = d.recurring.filter((r) => !(r.user_id === u.id && r.is_demo));
    dropPlans((p) => p.user_id === u.id && p.is_demo);
    d.transactions = d.transactions.filter((t) => !(t.user_id === u.id && t.is_demo));
    const demoDebtIds = d.debts.filter((x) => x.user_id === u.id && x.is_demo).map((x) => x.id);
    d.debtPays = d.debtPays.filter((p) => !demoDebtIds.includes(p.debt_id));
    d.debts = d.debts.filter((x) => !(x.user_id === u.id && x.is_demo));
    const demoGoalIds = d.goals.filter((g) => g.user_id === u.id && g.is_demo).map((g) => g.id);
    d.contribs = d.contribs.filter((c) => !demoGoalIds.includes(c.goal_id));
    d.goals = d.goals.filter((g) => !(g.user_id === u.id && g.is_demo));
    const demoSyms = new Set(d.ops.filter((o) => o.user_id === u.id && o.is_demo).map((o) => o.symbol));
    d.ops = d.ops.filter((o) => !(o.user_id === u.id && o.is_demo));
    demoSyms.forEach((sym) => { if (!d.ops.some((o) => o.symbol === sym)) delete d.quotes[sym]; });
    d.accounts = d.accounts.filter((a) => !(a.user_id === u.id && a.is_demo));
    const live = new Set(d.accounts.map((a) => a.id));   // como ON DELETE CASCADE: nada queda apuntando a una cuenta borrada
    d.recurring = d.recurring.filter((r) => live.has(r.account_id)); dropPlans((p) => !live.has(p.account_id));
    const demoCatIds = d.categories.filter((c) => c.user_id === u.id && c.is_demo).map((c) => c.id);
    d.budgets = d.budgets.filter((b) => !(b.user_id === u.id && demoCatIds.includes(b.category_id)));
    d.transactions.forEach((t) => { if (demoCatIds.includes(t.category_id)) t.category_id = null; });
    d.categories = d.categories.filter((c) => !(c.user_id === u.id && c.is_demo));
    d.watchlist = (d.watchlist || []).filter((w) => !(w.user_id === u.id && w.is_demo));  // se deja la cotización en caché: son símbolos reales
    return before - d.transactions.length;
  }

  /* ---------- cuentas ---------- */
  function creditFields(d, typ, a) {
    if (typ !== "credit") return { credit_limit: 0, cut_day: 0, due_day: 0 };
    const day = (k) => { const v = Number(d[k] ?? (a ? a[k] : 0) ?? 0) || 0; if (!Number.isInteger(v) || v < 0 || v > 31) fail("Indica un día entre 1 y 31.", 400, k); return v; };
    return { credit_limit: toCents(d.credit_limit ?? (a ? a.credit_limit / 100 : 0) ?? 0, "credit_limit", { zero: true }), cut_day: day("cut_day"), due_day: day("due_day") };
  }
  function createAccount(u, d, defCur, defDate) {
    const typ = d.type || "bank"; if (!ACC_TYPES.includes(typ)) fail("Tipo de cuenta no válido.", 400, "type");
    const cur = d.currency || defCur; if (!CURRENCIES.includes(cur)) fail("Moneda no compatible.", 400, "currency");
    const a = { id: 0, user_id: u.id, name: text(d.name, "name", 80, true), institution: text(d.institution, "institution", 80), type: typ, currency: cur,
      opening_balance: toCents(d.opening_balance || 0, "opening_balance", { neg: true, zero: true }), opened_on: parseDate(d.opened_on || defDate, "opened_on"),
      low_balance_alert: toCents(d.low_balance_alert || 0, "low_balance_alert", { zero: true }), archived: 0, is_demo: 0, ...creditFields(d, typ) };
    let plans = [];
    if (typ === "credit" && ("owed_now" in d || "plans" in d)) {
      // tarjeta: «¿cuánto debes hoy?» en positivo (el teclado del iPhone no tiene signo menos) + planes a meses que ya traes
      const owed = toCents(d.owed_now || 0, "owed_now", { zero: true }), inFavor = toCents(d.credit_in_favor || 0, "credit_in_favor", { zero: true });
      const raw = d.plans || []; if (!Array.isArray(raw) || raw.length > 30) fail("Lista de planes no válida.", 400, "plans");
      plans = raw.map((p, i) => parsePlan(p || {}, a.cut_day, `plans.${i}.`));
      a.opening_balance = inFavor - owed - plans.reduce((s_, p) => s_ + p.principal_remaining, 0);
    }
    a.id = nid("a"); db().accounts.push(a);
    plans.forEach((p) => insertPlan(u.id, a.id, p, defDate || a.opened_on));
    return a;
  }
  function history(u, id) {
    const a = myAcc(u.id, id); if (!a) fail("Cuenta no encontrada.", 404);
    const txs = db().transactions.filter((t) => t.user_id === u.id && (t.account_id === a.id || t.to_account_id === a.id)).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.id - y.id));
    let running = a.opening_balance; const byDay = {};
    txs.forEach((t) => { byDay[t.date] = (byDay[t.date] || 0) + effect(t, a.id); });
    const aops = db().ops.filter((o) => o.user_id === u.id && o.account_id === a.id);
    aops.forEach((o) => { byDay[o.date] = (byDay[o.date] || 0) + opCash(o); });
    const dps = db().debtPays.filter((p) => p.user_id === u.id && p.account_id === a.id); dps.forEach((p) => { byDay[p.date] = (byDay[p.date] || 0) - (p.principal_part + p.interest_part); });
    const points = [{ date: a.opened_on, balance: running }];
    Object.keys(byDay).sort().forEach((dd) => { running += byDay[dd]; points.push({ date: dd, balance: running }); });
    const today = todayFor(u.timezone); if (points[points.length - 1].date < today) points.push({ date: today, balance: running });
    const recent = txs.map((t) => ({ ...txView(t), effect: effect(t, a.id) })).concat(aops.map((o) => ({ id: o.id, op: true, symbol: o.symbol, type: "investment", date: o.date,
      description: `${{ buy: "Compra", sell: "Venta", dividend: "Dividendo", interest: "Interés" }[o.kind]} ${o.symbol}${o.kind === "buy" || o.kind === "sell" ? " · " + o.quantity + " × " + o.price : ""}`,
      category_name: null, to_account_name: null, account_id: a.id, effect: opCash(o) }))).concat(dps.map((p) => ({ id: p.id, op: true, debt_id: p.debt_id, type: "debt_payment", date: p.date, description: "Pago de deuda: " + (db().debts.find((x) => x.id === p.debt_id) || { name: "" }).name, category_name: null, to_account_name: null, account_id: a.id, effect: -(p.principal_part + p.interest_part) }))).sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : y.id - x.id)).slice(0, 100);
    return { account: accRow(u.id, a), series: points, transactions: recent };
  }

  /* ---------- CSV / JSON ---------- */
  const csvSafe = (v) => { const s = v == null ? "" : String(v); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };
  const csvCell = (v) => { const s = String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const money = (c) => (c / 100).toFixed(2);
  function csvFor(u, q) {
    const rows = queryTx(u.id, q, false).rows;
    const head = ["Fecha", "Tipo", "Descripción", "Categoría", "Cuenta", "Cuenta destino", "Importe", "Importe destino", "Método de pago", "Etiquetas", "Notas", "Recurrente"];
    const lines = [head].concat(rows.map((r) => [r.date, r.type, csvSafe(r.description), csvSafe(r.category_name), csvSafe(r.account_name), csvSafe(r.to_account_name),
      money(r.amount), r.to_amount != null ? money(r.to_amount) : "", csvSafe(r.payment_method), csvSafe(r.tags), csvSafe(r.notes), r.recurring ? "sí" : "no"]));
    return "﻿" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }


  /* ---------- Portafolio (vista previa: sin Yahoo, precios manuales) ---------- */
  const OP_KINDS = ["buy", "sell", "dividend", "interest"], ASSET = ["stock", "etf", "crypto", "bond", "fund", "gold", "other"];
  const yLink = (s) => "https://finance.yahoo.com/quote/" + encodeURIComponent(s);
  const cleanSym = (v) => { const s = String(v || "").trim().toUpperCase(); if (!/^[A-Z0-9^][A-Z0-9.^=\-]{0,19}$/.test(s)) fail("Escribe un símbolo válido (por ejemplo AAPL o BTC-USD).", 400, "symbol"); return s; };
  function decIn(v, field) { const s = String(v ?? "").replace(/[,\s]/g, ""); if (!/^\d+(\.\d{1,8})?$/.test(s) || Number(s) <= 0) fail("Introduce un número mayor que cero (máximo 8 decimales).", 400, field); return s; }
  const sortedOps = (ops) => ops.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  function simulate(ops) {
    const pos = {};
    for (const o of sortedOps(ops)) {
      const p = (pos[o.symbol] = pos[o.symbol] || { qty: 0, cost: 0, realized: 0, income: 0, name: o.name, type: o.asset_type, currency: o.currency });
      p.name = o.name || p.name; p.type = o.asset_type; const q = Number(o.quantity);
      if (o.kind === "buy") { p.qty += q; p.cost += o.gross + o.fee; }
      else if (o.kind === "sell") {
        if (q > p.qty + 1e-9) fail(`No tienes suficientes unidades de ${o.symbol} al ${o.date} (tenías ${+p.qty.toFixed(8)}, intentas vender ${q}).`, 400, "quantity");
        const basis = p.qty ? (p.cost * q) / p.qty : 0; p.realized += o.gross - o.fee - basis; p.cost -= basis; p.qty -= q; if (p.qty < 1e-9) { p.qty = 0; p.cost = 0; }
      } else p.income += o.gross - o.fee;
    }
    return pos;
  }
  function saveOp(u, body, id) {
    const d = db(), kind = body.kind; if (!OP_KINDS.includes(kind)) fail("Tipo de operación no válido.", 400, "kind");
    const symbol = cleanSym(body.symbol), date = parseDate(body.date, "date"), at = body.asset_type || "stock"; if (!ASSET.includes(at)) fail("Tipo de activo no válido.", 400, "asset_type");
    let acc = null; if (body.account_id) { acc = myAcc(u.id, body.account_id); if (!acc) fail("Selecciona una cuenta válida.", 400, "account_id"); }
    const prev = d.ops.find((o) => o.user_id === u.id && o.symbol === symbol && o.id !== id);
    const cur = (prev && prev.currency) || (acc && acc.currency) || u.currency;
    if (acc && acc.currency !== cur) fail(`${symbol} está en ${cur} y la cuenta en ${acc.currency}. Elige una cuenta en ${cur} o deja el efectivo sin ligar.`, 400, "account_id");
    const o = { user_id: u.id, symbol, kind, date, asset_type: at, account_id: acc ? acc.id : null, currency: cur, notes: text(body.notes, "notes", 500), name: text(body.name, "name", 120) || (prev && prev.name) || symbol,
      fee: body.fee ? toCents(body.fee, "fee", { zero: true }) : 0 };
    if (kind === "buy" || kind === "sell") { const q = decIn(body.quantity, "quantity"), pr = decIn(body.price, "price"); o.quantity = q; o.price = pr; o.gross = Math.round(Number(q) * Number(pr) * 100); if (o.gross <= 0) fail("El importe de la operación es demasiado pequeño.", 400, "price"); }
    else { o.quantity = "0"; o.price = "0"; o.gross = toCents(body.amount, "amount"); }
    const others = d.ops.filter((x) => x.user_id === u.id && x.id !== id), mine = id ? d.ops.find((x) => x.id === id && x.user_id === u.id) : null;
    if (id && !mine) fail("Operación no encontrada.", 404);
    const row = mine ? Object.assign(mine, o) : Object.assign(o, { id: nid("o") });
    simulate(others.concat([row]));                 // valida que no se venda de más; si falla, se revierte
    if (!mine) d.ops.push(row);
    return row;
  }
  const opRow = (o) => ({ id: o.id, symbol: o.symbol, name: o.name, asset_type: o.asset_type, kind: o.kind, quantity: o.quantity, price: o.price, gross: o.gross, fee: o.fee, currency: o.currency, date: o.date, account_id: o.account_id, notes: o.notes });
  function portfolioSummary(u) {
    const d = db(), main = u.currency, ops = d.ops.filter((o) => o.user_id === u.id), pos = simulate(ops), items = [], closed = [];
    for (const sym of Object.keys(pos).sort()) {
      const p = pos[sym], q = d.quotes[sym], price = q ? q.price : null, held = p.qty > 0;
      const mv = held && price != null ? Math.round(p.qty * price * 100) : null, cost = Math.round(p.cost), un = mv != null ? mv - cost : null;
      const it = { symbol: sym, name: p.name || sym, asset_type: p.type, currency: p.currency, quantity: String(+p.qty.toFixed(8)), avg_cost: held ? (p.cost / p.qty / 100).toFixed(4) : null, cost,
        price, market_value: mv, unrealized: un, unrealized_pct: un != null && cost ? Math.round((un / cost) * 10000) / 100 : null, day_change: null, day_change_pct: null,
        realized: Math.round(p.realized), income: Math.round(p.income), price_source: q ? "manual" : null, updated_at: q ? q.at : null, price_time: q ? q.at : null, last_error: "", link: yLink(sym) };
      (held ? items : closed).push(it);
    }
    const inm = items.filter((i) => i.currency === main), priced = inm.filter((i) => i.market_value != null), all = inm.concat(closed.filter((c) => c.currency === main));
    const t = { market_value: priced.reduce((s, i) => s + i.market_value, 0), cost: priced.reduce((s, i) => s + i.cost, 0), unrealized: priced.reduce((s, i) => s + i.unrealized, 0), day_change: 0,
      realized: all.reduce((s, i) => s + i.realized, 0), income: all.reduce((s, i) => s + i.income, 0), unpriced: inm.filter((i) => i.market_value == null).map((i) => i.symbol) };
    t.unrealized_pct = t.cost ? Math.round((t.unrealized / t.cost) * 10000) / 100 : null;
    return { currency: main, positions: items, closed, totals: t, other_currency: items.filter((i) => i.currency !== main).map((i) => ({ symbol: i.symbol, currency: i.currency, market_value: i.market_value, cost: i.cost })),
      last_update: null, refresh_seconds: 3600, server_time: new Date().toISOString(), any_error: false, symbols: items.map((i) => i.symbol) };
  }


  /* ---------- Widgets (misma forma que widgets.py) ---------- */
  function widgetData(u) {
    const a = analysis(u, 12), cur = u.currency, nw = a.networth_evolution, monthly = a.monthly;
    const total = db().accounts.filter((x) => x.user_id === u.id && !x.archived && x.type !== "credit" && x.currency === cur).reduce((s, x) => s + accRow(u.id, x).balance, 0);
    const series = nw.map((x) => x.liquid + x.invested); if (series.length) series[series.length - 1] = total;
    const prev = series.length >= 2 ? series[series.length - 2] : null, m = monthly[monthly.length - 1];
    const ps = portfolioSummary(u), pos = ps.positions.filter((p) => p.currency === cur && p.market_value != null);
    const portfolio_ = ps.positions.length ? { value: ps.totals.market_value, cost: ps.totals.cost, gain: ps.totals.unrealized, gain_pct: ps.totals.unrealized_pct, day_change: 0,
      positions: pos.map((p) => ({ symbol: p.symbol, pct: p.unrealized_pct, value: p.market_value })).sort((x, y) => y.value - x.value).slice(0, 8), missing: ps.totals.unpriced } : null;
    const cats = a.categories.filter((c) => c.current > 0).sort((x, y) => y.current - x.current), spent = a.this_month.spent, shown = cats.slice(0, 3);
    const gl = a.goals || [], open = gl.filter((g) => !g.done), dated = open.filter((g) => g.target_date && (g.days_left || 0) >= 0).sort((x, y) => x.days_left - y.days_left);
    const pick = dated[0] || open.slice().sort((x, y) => y.pct - x.pct)[0] || null;
    let budget = null; const b = a.budget;
    if (b && (b.total || (b.items && b.items.length))) { let t = b.total; if (!t) { const am = b.items.reduce((s, i) => s + i.amount, 0), sp = b.items.reduce((s, i) => s + i.spent, 0), pc = am ? Math.round((sp * 1000) / am) / 10 : 0; t = { amount: am, spent: sp, remaining: am - sp, pct: pc, status: sp > am ? "over" : pc >= 80 ? "warn" : "ok" }; }
      budget = { amount: t.amount, spent: t.spent, remaining: t.remaining, pct: t.pct, status: t.status }; }
    const h = a.health, recent = queryTx(u.id, { per_page: 6, sort: "date", dir: "desc" }).rows.map((t) => ({ id: t.id, date: t.date, type: t.type, amount: t.amount, description: t.description, category_name: t.category_name, account_name: t.account_name, currency: t.currency || cur }));
    return { currency: cur, generated_at: new Date().toISOString(), balance: { value: total, series, change_pct: prev ? Math.round(((total - prev) * 10000) / Math.abs(prev)) / 100 : null },
      month: { key: m.key, income: m.income, expense: m.expense, savings: m.net, savings_rate: m.savings_rate }, portfolio: portfolio_,
      categories: { spent, items: shown.map((c) => ({ name: c.name, amount: c.current })), others: Math.max(0, spent - shown.reduce((s, c) => s + c.current, 0)) },
      goals: { next_id: pick ? pick.id : null, items: gl.slice(0, 6).map((g) => ({ id: g.id, name: g.name, target: g.target, saved: g.saved, pct: g.pct, done: g.done, target_date: g.target_date, days_left: g.days_left })) },
      budget, health: h.score == null ? null : { score_100: h.score, score_10: Math.round(h.score) / 10, breakdown: h.breakdown, month: h.month }, recent };
  }
  const WG_SIZES = { quick: ["s"], summary: ["m", "l"], portfolio: ["m", "l"], categories: ["s", "m"], goal: ["s"], goals: ["m", "l"], recent: ["m", "l"], health: ["m", "l"], budget: ["s", "m"] };
  function widgetLayoutClean(x) {
    if (!x || typeof x !== "object" || !Array.isArray(x.items)) fail("Diseño de widgets no válido.");
    const seen = new Set(); x.items.forEach((i) => { if (!WG_SIZES[i.id] || seen.has(i.id) || !WG_SIZES[i.id].includes(i.size || WG_SIZES[i.id][0])) fail("Widget no válido."); seen.add(i.id); });
    return x;
  }

  /* ---------- Importar estado de cuenta (vista previa: solo CSV) ---------- */
  function csvGrid(text_) {
    text_ = text_.replace(/^﻿/, ""); const first = text_.split(/\r?\n/, 5).join("\n");
    const delim = [",", ";", "\t", "|"].map((c) => [c, first.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = []; let row = [], cell = "", q = false;
    for (let i = 0; i < text_.length; i++) {
      const ch = text_[i];
      if (q) { if (ch === '"') { if (text_[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true; else if (ch === delim) { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text_[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((c) => c.trim())) rows.push(row); row = []; }
      else cell += ch;
    }
    row.push(cell); if (row.some((c) => c.trim())) rows.push(row); return rows;
  }
  function amt(v) { let s = String(v ?? "").trim(); if (!s) return null; let neg = /^\(.*\)$/.test(s) || /-\s*$/.test(s) || /^-/.test(s); s = s.replace(/[^0-9.,]/g, ""); if (!s) return null;
    if (/,\d{1,2}$/.test(s) && !/\.\d/.test(s)) s = s.replace(/\./g, "").replace(",", "."); else s = s.replace(/,/g, ""); const n = Math.round(parseFloat(s) * 100); return isNaN(n) ? null : neg ? -n : n; }
  function dt(v, dayFirst) {
    const s = String(v ?? "").trim(); let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s); let y, mo, da;
    if (m) { y = +m[1]; mo = +m[2]; da = +m[3]; } else { m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s); if (!m) return null; let a = +m[1], b = +m[2]; y = +m[3]; if (y < 100) y += 2000; if (a > 12) { da = a; mo = b; } else if (b > 12) { mo = a; da = b; } else if (dayFirst) { da = a; mo = b; } else { mo = a; da = b; } }
    try { return parseDate(`${y}-${pad(mo)}-${pad(da)}`); } catch { return null; }
  }
  const nd = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  function parseCsv(u, file, form) {
    const name = (file.name || "").toLowerCase();
    if (/\.(xlsx|xlsm|xls|pdf)$/.test(name)) fail("En la vista previa solo se leen archivos CSV. Excel y PDF funcionan en la app con servidor.", 400, "file");
    const grid = csvGrid(file.text); if (grid.length < 2) fail("No encontré movimientos en el archivo.", 400, "file");
    const hi = grid.findIndex((r) => r.filter((c) => /fecha|date/i.test(c)).length && r.length >= 3); const hdr = grid[hi >= 0 ? hi : 0].map((c) => c.trim());
    const find = (re) => hdr.findIndex((c) => re.test(nd(c)));
    let map = { date: find(/fecha|date/), description: find(/descrip|concepto|detalle|movimiento|memo/), amount: find(/importe|monto|amount/), debit: find(/cargo|retiro|debito|debit/), credit: find(/abono|deposito|credito|credit/), balance: find(/saldo|balance/) };
    if (form.mapping) { const mp = JSON.parse(form.mapping); map = { date: -1, description: -1, amount: -1, debit: -1, credit: -1, balance: -1, ...mp }; }
    if (map.date < 0 || (map.amount < 0 && map.debit < 0 && map.credit < 0)) return { columns: hdr, mapping: map, rows: [], warnings: [], needs_mapping: true, error: null, kind: "csv" };
    const dayFirst = form.day_first !== "0", inv = form.invert === "1", rows = [];
    for (const r of grid.slice((hi >= 0 ? hi : 0) + 1)) {
      const date = dt(r[map.date], dayFirst); if (!date) continue; let a = null;
      if (map.amount >= 0) a = amt(r[map.amount]); else { const de = map.debit >= 0 ? amt(r[map.debit]) : null, cr = map.credit >= 0 ? amt(r[map.credit]) : null; a = (cr || 0) - Math.abs(de || 0); if (de == null && cr == null) a = null; }
      if (a == null || a === 0) continue; rows.push({ date, description: (map.description >= 0 ? r[map.description] : "").trim().slice(0, 200), amount: inv ? -a : a, balance: map.balance >= 0 ? amt(r[map.balance]) : null, confidence: "columns" });
    }
    if (!rows.length) fail("No encontré movimientos con fecha e importe válidos.", 400, "file");
    const acc = myAcc(u.id, form.account_id), pool = db().transactions.filter((t) => t.user_id === u.id && t.account_id === acc.id && ["income", "expense", "refund"].includes(t.type)).map((t) => [t.date, t.type === "expense" ? -t.amount : t.amount, nd(t.description)]);
    const hist = {}; db().transactions.filter((t) => t.user_id === u.id && t.category_id && t.description && ["income", "expense"].includes(t.type)).forEach((t) => { hist[nd(t.description) + "|" + t.type] = t.category_id; });
    rows.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0)).forEach((r, i) => {
      r.idx = i; r.duplicate = false; const k = nd(r.description);
      const j = pool.findIndex((e) => e[0] === r.date && e[1] === r.amount && (e[2] === k || !e[2] || !k)); if (j >= 0) { r.duplicate = true; pool.splice(j, 1); }
      r.category_id = k ? hist[k + "|" + (r.amount > 0 ? "income" : "expense")] || null : null;
    });
    return { columns: hdr, mapping: map, rows, warnings: [], needs_mapping: false, kind: "csv", filename: file.name, account: { id: acc.id, name: acc.name, currency: acc.currency } };
  }


  /* ---------- Fases 2 y 3 (vista previa): tarjetas, deudas, presupuestos, análisis, reportes, metas, tablas ---------- */
  const mt = (c) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  function nextDay(today, day) {
    if (!day) return null; let [y, m] = today.split("-").map(Number);
    for (let i = 0; i < 3; i++) { const last = new Date(Date.UTC(y, m, 0)).getUTCDate(), dd = `${y}-${pad(m)}-${pad(Math.min(day, last))}`; if (dd >= today) return dd; m += 1; if (m > 12) { m = 1; y += 1; } }
    return null;
  }
  function prevDay(today, day) {
    let [y, m] = today.split("-").map(Number);
    for (let i = 0; i < 3; i++) { const last = new Date(Date.UTC(y, m, 0)).getUTCDate(), dd = `${y}-${pad(m)}-${pad(Math.min(day, last))}`; if (dd <= today) return dd; m -= 1; if (m < 1) { m = 12; y -= 1; } }
    return null;
  }
  const balanceAsOf = (uid, a, dd) => a.opening_balance
    + db().transactions.filter((t) => t.user_id === uid && t.date <= dd && (t.account_id === a.id || t.to_account_id === a.id)).reduce((s, t) => s + effect(t, a.id), 0)
    + db().ops.filter((o) => o.user_id === uid && o.account_id === a.id && o.date <= dd).reduce((s, o) => s + opCash(o), 0)
    - db().debtPays.filter((p) => p.user_id === uid && p.account_id === a.id && p.date <= dd).reduce((s, p) => s + p.principal_part + p.interest_part, 0);
  function cardRow(u, a) {
    const uid = u.id, today = todayFor(u.timezone), bal = balanceOf(uid, a), used = Math.max(0, -bal);
    const out = { id: a.id, name: a.name, institution: a.institution, currency: a.currency, archived: !!a.archived, balance: bal, used, credit_in_favor: Math.max(0, bal), limit: a.credit_limit || 0,
      available: a.credit_limit ? a.credit_limit - used : null, utilization: a.credit_limit ? Math.round((used * 1000) / a.credit_limit) / 10 : null, cut_day: a.cut_day, due_day: a.due_day,
      next_cut: nextDay(today, a.cut_day), next_due: nextDay(today, a.due_day), statement: null };
    const lc = a.cut_day ? prevDay(today, a.cut_day) : null, ex = cardExtras(uid, a, today, lc);
    Object.assign(out, { plans: ex.plans, deferred_now: ex.deferred_now, installments_monthly: ex.installments_monthly });
    if (a.cut_day) {
      if (lc) {
        const atCut = Math.max(0, -balanceAsOf(uid, a, lc)), paid = db().transactions.filter((t) => t.user_id === uid && t.to_account_id === a.id && t.type === "transfer" && t.date > lc).reduce((s, t) => s + t.to_amount, 0);
        const toPay = Math.max(0, atCut - ex.deferred_at_cut);   // lo que entró al estado de cuenta, sin el capital a meses que aún no tocaba
        out.statement = { cut_date: lc, balance_at_cut: atCut, deferred_at_cut: Math.min(ex.deferred_at_cut, atCut), to_pay_at_cut: toPay, paid_since: paid, pending: Math.max(0, toPay - paid),
          new_charges: db().transactions.filter((t) => t.user_id === uid && t.account_id === a.id && t.date > lc).reduce((s, t) => s + (t.type === "expense" ? t.amount : t.type === "refund" || t.type === "adjustment" ? -t.amount : 0), 0) };
      }
    }
    return out;
  }
  // ---- avisos (mismo comportamiento que notify.py)
  function ensureN(d) { d.notifs = d.notifs || []; d.alerts = d.alerts || []; d.nseq = d.nseq || 0; d.watchlist = d.watchlist || []; d.wseq = d.wseq || 0; return d; }
  function addN(d, uid, kind, title, body, link, key) {
    if (d.notifs.some((n) => n.user_id === uid && n.key === key)) return 0;
    d.notifs.push({ id: ++d.nseq, user_id: uid, kind, title, body, link, key, created_at: nowStr(), read_at: null, dismissed: 0 }); return 1;
  }
  function checkCards(u) {
    const d = ensureN(db()), today = todayFor(u.timezone);
    for (const a of d.accounts.filter((x) => x.user_id === u.id && x.type === "credit" && !x.archived && x.due_day > 0)) {
      const c = cardRow(u, a); if (!c.next_due || c.used <= 0) continue;
      const days = Math.round((U(c.next_due) - U(today)) / 86400000), stage = [0, 1, 5].find((s) => days <= s); if (stage === undefined) continue;
      const owe = c.statement && c.statement.pending > 0 ? c.statement.pending : c.used, when = days === 0 ? "hoy" : days === 1 ? "mañana" : `en ${days} días`;
      addN(d, u.id, "card_due", `Pago de ${c.name} vence ${when}`, `Fecha límite: ${c.next_due}. Por pagar: ${mt(owe)} ${c.currency} (deuda total ${mt(c.used)} ${c.currency}).`, "#/cards", `card:${a.id}:${c.next_due}:${stage}`);
    }
  }
  function checkPrices(u, syms) {
    const d = ensureN(db());
    for (const a of d.alerts.filter((x) => x.user_id === u.id && x.active)) {
      if (syms && !syms.includes(a.symbol)) continue;
      const qt = d.quotes[a.symbol]; if (!qt || qt.price == null) continue;
      const op = d.ops.find((o) => o.user_id === u.id && o.symbol === a.symbol), cur = (op && op.currency) || u.currency, link = "#/portfolio/" + a.symbol, stamp = Date.now() + ":" + d.nseq;
      if (a.lower != null && qt.price <= a.lower) { if (!a.lower_hit) { addN(d, u.id, "price_low", `${a.symbol} tocó tu límite inferior`, `Precio actual ${qt.price.toFixed(2)} ${cur} (límite inferior ${a.lower.toFixed(2)}).`, link, `price:${a.id}:low:${stamp}`); a.lower_hit = 1; } } else a.lower_hit = 0;
      if (a.upper != null && qt.price >= a.upper) { if (!a.upper_hit) { addN(d, u.id, "price_high", `${a.symbol} alcanzó tu precio objetivo superior`, `Precio actual ${qt.price.toFixed(2)} ${cur} (objetivo superior ${a.upper.toFixed(2)}).`, link, `price:${a.id}:high:${stamp}`); a.upper_hit = 1; } } else a.upper_hit = 0;
    }
  }
  function alertNum(v, field) { if (v === null || v === undefined || v === "") return null; const x = Number(String(v).replace(/,/g, "")); if (!(x > 0) || x > 1e12) fail("El precio debe ser mayor que cero.", 400, field); return x; }
  function alertRow(d, a) { const qt = d.quotes[a.symbol]; return { id: a.id, symbol: a.symbol, lower: a.lower, upper: a.upper, active: !!a.active, lower_hit: !!a.lower_hit, upper_hit: !!a.upper_hit, price: qt ? qt.price : null, currency: "" }; }
  // ---- vigilancia (mismo comportamiento que notify.py: check_watchlist + /api/watchlist)
  const WATCH_STAGES = [0, 1, 3];
  function checkWatchlist(u) {
    const d = ensureN(db()), today = todayFor(u.timezone);
    for (const w of d.watchlist.filter((x) => x.user_id === u.id && x.report_date)) {
      const days = Math.round((U(w.report_date) - U(today)) / 86400000);
      if (days < 0) continue;
      const stage = WATCH_STAGES.find((s) => days <= s); if (stage === undefined) continue;
      const when = days === 0 ? "hoy" : days === 1 ? "mañana" : `en ${days} días`;
      addN(d, u.id, "watch_report", `${w.symbol} reporta ${when}`, `Fecha del reporte: ${w.report_date}.`, "#/portfolio", `watch:${w.id}:${w.report_date}:${stage}`);
    }
  }
  function watchRow(d, w, today) {
    const qt = d.quotes[w.symbol], price = qt ? qt.price : null;
    let state = null;
    if (price != null) {
      if (w.exit_price != null && price >= w.exit_price) state = "above";
      else if (w.entry_price != null && price < w.entry_price) state = "below";
      else if (w.entry_price != null || w.exit_price != null) state = "in_range";
    }
    const days = w.report_date && today ? Math.round((U(w.report_date) - U(today)) / 86400000) : null;
    return { id: w.id, symbol: w.symbol, company: w.company, report_date: w.report_date, entry_price: w.entry_price, exit_price: w.exit_price, notes: w.notes,
      price, currency: qt ? qt.currency || "" : "", state, days_to_report: days };
  }
  function attachFx(items, main) {
    items.forEach((i) => { i.main_currency = main; i.fx_rate = !i.currency || i.currency === main ? 1 : fxRate(i.currency, main); });
    return items;
  }
  function debtRow(u, x) {
    const pays = db().debtPays.filter((p) => p.debt_id === x.id), pp = pays.reduce((s, p) => s + p.principal_part, 0), pi = pays.reduce((s, p) => s + p.interest_part, 0), rem = x.principal - pp;
    const nd = rem > 0 ? nextDay(todayFor(u.timezone), x.due_day) : null;
    return { id: x.id, name: x.name, creditor: x.creditor, currency: x.currency, principal: x.principal, interest_rate: x.interest_rate, start_date: x.start_date, monthly_payment: x.monthly_payment, due_day: x.due_day, notes: x.notes,
      archived: !!x.archived, paid_principal: pp, paid_interest: pi, remaining: rem, progress: x.principal ? Math.round((pp * 1000) / x.principal) / 10 : 0, next_due: nd, months_left: rem > 0 && x.monthly_payment ? Math.ceil(rem / x.monthly_payment) : null, payment_count: pays.length };
  }
  const debtsRemaining = (uid, cur) => Math.max(0, db().debts.filter((x) => x.user_id === uid && x.currency === cur && !x.archived).reduce((s, x) => s + x.principal - db().debtPays.filter((p) => p.debt_id === x.id).reduce((a, p) => a + p.principal_part, 0), 0));
  function debtFields(d, u, row) {
    const cur = d.currency ?? (row ? row.currency : u.currency); if (!CURRENCIES.includes(cur)) fail("Moneda no compatible.", 400, "currency");
    const rate = Number(d.interest_rate ?? (row ? row.interest_rate : 0)) || 0; if (rate < 0 || rate > 1000) fail("La tasa debe estar entre 0 y 1000.", 400, "interest_rate");
    const due = Number(d.due_day ?? (row ? row.due_day : 0)) || 0; if (!Number.isInteger(due) || due < 0 || due > 31) fail("Indica un día entre 1 y 31.", 400, "due_day");
    return { name: text(d.name ?? (row && row.name), "name", 80, true), creditor: text(d.creditor ?? (row ? row.creditor : ""), "creditor", 80), currency: cur, principal: toCents(d.principal ?? (row && row.principal / 100), "principal"), interest_rate: rate,
      start_date: parseDate(d.start_date ?? (row ? row.start_date : todayFor(u.timezone)), "start_date"), monthly_payment: toCents(d.monthly_payment ?? (row ? row.monthly_payment / 100 : 0) ?? 0, "monthly_payment", { zero: true }), due_day: due, notes: text(d.notes ?? (row ? row.notes : ""), "notes", 500) };
  }
  const topCat = (c) => (c && c.parent_id) || (c && c.id) || 0;
  function categorySpend(uid, s, e, cur) {
    const out = {};
    for (const t of db().transactions) {
      if (t.user_id !== uid || t.date < s || t.date > e || !["expense", "refund"].includes(t.type)) continue;
      if (db().accounts.find((x) => x.id === t.account_id).currency !== cur) continue;
      const k = t.category_id ? topCat(db().categories.find((c) => c.id === t.category_id)) : 0; out[k] = (out[k] || 0) + (t.type === "expense" ? t.amount : -t.amount);
    }
    return out;
  }
  const monthBounds = (key, today) => {
    let y, m; if (key) { if (!/^\d{4}-\d{2}$/.test(key) || +key.slice(5) < 1 || +key.slice(5) > 12) fail("Mes no válido (AAAA-MM).", 400, "month"); y = +key.slice(0, 4); m = +key.slice(5); } else [y, m] = today.split("-").map(Number);
    return { y, m, s: `${y}-${pad(m)}-01`, e: monthEnd(y, m) };
  };
  function budgetStatus(u, key) {
    const uid = u.id, cur = u.currency, today = todayFor(u.timezone), { y, m, s, e } = monthBounds(key, today), spend = categorySpend(uid, s, e, cur), rows = db().budgets.filter((b) => b.user_id === uid);
    const names = Object.fromEntries(db().categories.filter((c) => c.user_id === uid).map((c) => [c.id, c.name]));
    const elapsed = today >= s ? Math.min(1, ((U(today < e ? today : e) - U(s)) / 86400000 + 1) / ((U(e) - U(s)) / 86400000 + 1)) : 0;
    const item = (cid, amount, spent, name) => { const pct = amount ? Math.round((spent * 1000) / amount) / 10 : 0; return { category_id: cid, name, amount, spent: Math.max(0, spent), remaining: amount - spent, pct, status: spent > amount ? "over" : pct >= 80 ? "warn" : "ok" }; };
    const tot = rows.find((b) => b.category_id === 0), totalSpent = Object.values(spend).reduce((a, b) => a + b, 0), budgeted = new Set(rows.map((b) => b.category_id));
    return { month: `${y}-${pad(m)}`, currency: cur, elapsed_pct: Math.round(elapsed * 100), total: tot ? item(0, tot.amount, totalSpent, "Presupuesto total") : null,
      items: rows.filter((b) => b.category_id !== 0).map((b) => item(b.category_id, b.amount, spend[b.category_id] || 0, names[b.category_id] || "Categoría eliminada")).sort((a, b) => b.pct - a.pct),
      unbudgeted: Object.entries(spend).filter(([k, v]) => v > 0 && !budgeted.has(+k)).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ category_id: +k || null, name: +k ? names[k] : "Sin categoría", spent: v })) };
  }
  function budgetAlerts(u) {
    let st; try { st = budgetStatus(u); } catch { return []; }
    const out = []; if (st.total && st.total.status !== "ok") out.push({ level: st.total.status === "over" ? "danger" : "warn", text: `Presupuesto total del mes: llevas ${Math.round(st.total.pct)}% (${mt(st.total.spent)} de ${mt(st.total.amount)}).`, link: "#/budgets" });
    st.items.filter((i) => i.status !== "ok").forEach((i) => out.push({ level: i.status === "over" ? "danger" : "warn", text: `Presupuesto de «${i.name}»: llevas ${Math.round(i.pct)}% (${mt(i.spent)} de ${mt(i.amount)}).`, link: "#/budgets" }));
    return out.slice(0, 4);
  }
  /* ---- análisis: patrimonio, metas, portafolio, salud financiera, insights (aditivo sobre lo anterior) ---- */
  const LIQUID_TYPES = ["bank", "cash", "savings", "digital"];
  const ASSET_ES = { stock: "Acciones", etf: "ETF", crypto: "Cripto", bond: "Bonos", fund: "Fondos", gold: "Oro", other: "Otros" };
  function debtsRemainingAsOf(uid, cur, dd) {
    let total = 0;
    for (const x of db().debts.filter((x) => x.user_id === uid && x.currency === cur && x.start_date <= dd)) {
      const paid = db().debtPays.filter((p) => p.debt_id === x.id && p.date <= dd).reduce((s, p) => s + p.principal_part, 0);
      total += Math.max(0, x.principal - paid);
    }
    return total;
  }
  function netWorthAsOf(uid, cur, dd, accounts) {
    const liquid = accounts.filter((a) => LIQUID_TYPES.includes(a.type)).reduce((s, a) => s + balanceAsOf(uid, a, dd), 0);
    const invested = accounts.filter((a) => a.type === "investment").reduce((s, a) => s + balanceAsOf(uid, a, dd), 0);
    const cardDebt = accounts.filter((a) => a.type === "credit").reduce((s, a) => s + Math.max(0, -balanceAsOf(uid, a, dd)), 0);
    const debtsTotal = debtsRemainingAsOf(uid, cur, dd);
    return { liquid, invested, card_debt: cardDebt, debts_total: debtsTotal, net_worth: liquid + invested - cardDebt - debtsTotal };
  }
  function recurringExpenses(uid, cur, today) {
    let [y, m] = today.split("-").map(Number);
    for (let i = 0; i < 3; i++) { m -= 1; if (m < 1) { m = 12; y -= 1; } }
    const start = `${y}-${pad(m)}-01`;
    const rows = db().transactions.filter((t) => t.user_id === uid && t.type === "expense" && t.date >= start && (db().accounts.find((x) => x.id === t.account_id) || {}).currency === cur).sort((a, b) => (a.date < b.date ? -1 : 1));
    const groups = {};
    for (const r of rows) {
      const desc = (r.description || "").trim().toLowerCase().replace(/\d+/g, "").replace(/\s+/g, " ").trim();
      if (!desc) continue;
      const key = r.account_id + "|" + desc, mk = r.date.slice(0, 7);
      const g = (groups[key] = groups[key] || { by_month: {}, last_date: r.date, desc, account_id: r.account_id });
      (g.by_month[mk] = g.by_month[mk] || []).push(r.amount);
      if (r.date > g.last_date) g.last_date = r.date;
    }
    const out = [];
    for (const key in groups) {
      const g = groups[key], months = Object.keys(g.by_month);
      if (months.length < 3) continue;
      const amounts = months.map((k) => { const v = g.by_month[k]; return v.reduce((a, b) => a + b, 0) / v.length; });
      const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
      if (avg <= 0 || amounts.some((a) => Math.abs(a - avg) / avg > 0.15)) continue;
      out.push({ description: g.desc.charAt(0).toUpperCase() + g.desc.slice(1), account_id: g.account_id, months_seen: months.length, avg_amount: Math.round(avg), last_date: g.last_date });
    }
    out.sort((a, b) => b.avg_amount - a.avg_amount);
    return out.slice(0, 15);
  }
  // Puntaje de salud financiera: cercanía a la distribución objetivo (espejo de health.py)
  const HS_TARGETS = { living: 50, savings: 25, investments: 25 }, HS_DIR = { living: "max", savings: "min", investments: "min" };
  const HS_LABELS = { living: "Vida / Gastos", savings: "Ahorro", investments: "Inversión" }, HS_BONUS_RATE = 1.0, HS_MAX_TOTAL = 120, HS_CAT = 100 / 3;
  // Ahorro / Inversión: lo transferido (neto) a cuentas de ese tipo desde cuentas de otro tipo (espejo de more.flows_by_month)
  function flowsByMonth(uid, cur, firstKey, types) {
    const out = {}, acc = (id) => db().accounts.find((a) => a.id === id);
    for (const t of db().transactions) {
      if (t.user_id !== uid || t.type !== "transfer" || t.date.slice(0, 7) < firstKey) continue;
      const f = acc(t.account_id), to = acc(t.to_account_id); if (!f || !to) continue;
      const into = types.includes(to.type), outof = types.includes(f.type); if (into === outof) continue;
      const [v, c] = into ? [t.to_amount != null ? t.to_amount : t.amount, to.currency] : [-t.amount, f.currency];
      const r = fxRate(c, cur); if (!r) continue;
      const k = t.date.slice(0, 7); out[k] = (out[k] || 0) + Math.round(v * r);
    }
    return out;
  }
  function allocationByMonth(uid, cur, firstKey) {
    const has = (ty) => db().accounts.some((a) => a.user_id === uid && !a.archived && a.type === ty);
    return [has("savings") ? flowsByMonth(uid, cur, firstKey, ["savings"]) : null, has("investment") ? flowsByMonth(uid, cur, firstKey, ["investment"]) : investedByMonth(uid, cur, firstKey)];
  }
  function healthScore(monthly, invested, saved = null) {
    for (let i = monthly.length - 1; i >= 0; i--) {
      const x = monthly[i]; if (!(x.income > 0)) continue;
      const inv = invested[x.key] || 0, amounts = { living: x.expense, savings: saved ? saved[x.key] || 0 : x.income - x.expense - inv, investments: inv };
      const breakdown = {}; let total = 0;
      for (const key of Object.keys(HS_TARGETS)) {
        const target = HS_TARGETS[key], actual = (amounts[key] / x.income) * 100, diff = Math.abs(actual - target);
        const gap = HS_DIR[key] === "min" ? actual - target : target - actual;
        const points = gap >= 0 ? HS_CAT * (1 + (HS_BONUS_RATE * gap) / target) : Math.max(0, HS_CAT * (1 - diff / target));
        breakdown[key] = { label: HS_LABELS[key], target_pct: target, actual_pct: Math.round(actual * 100) / 100, difference: Math.round(diff * 100) / 100, bonus: gap > 0, points: Math.round(points * 100) / 100 };
        total += points;
      }
      return { score: Math.round(Math.min(total, HS_MAX_TOTAL)), breakdown, month: x.key, is_current_month: i === monthly.length - 1, amounts, income: x.income,
        unassigned: x.income - amounts.living - amounts.savings - amounts.investments, savings_source: saved ? "accounts" : "leftover" };
    }
    return { score: null, breakdown: null, month: null };
  }
  function investedByMonth(uid, cur, firstKey) {
    const out = {};
    for (const o of db().ops) {
      if (o.user_id !== uid || o.kind !== "buy" || o.date.slice(0, 7) < firstKey) continue;
      const r = fxRate(o.currency, cur); if (!r) continue;
      const k = o.date.slice(0, 7); out[k] = (out[k] || 0) + Math.round((o.gross + o.fee) * r);
    }
    return out;
  }
  function buildInsights(uid, cur, today, monthly, cats, goalsList) {
    const out = [], withData = monthly.filter((x) => x.income || x.expense);
    if (withData.length >= 2 && withData[withData.length - 2].expense > 0) {
      const curM = withData[withData.length - 1], prevM = withData[withData.length - 2];
      const deltaPct = Math.round(((curM.expense - prevM.expense) * 1000) / prevM.expense) / 10;
      if (Math.abs(deltaPct) >= 8) {
        const pool = deltaPct > 0 ? cats.filter((c) => c.delta > 0) : cats.filter((c) => c.delta < 0);
        const drivers = pool.slice().sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 2);
        let text = `Este mes tus gastos ${deltaPct > 0 ? "aumentaron" : "bajaron"} ${Math.abs(deltaPct).toFixed(0)}% respecto al mes anterior`;
        text += drivers.length ? `, principalmente por ${drivers.map((x) => x.name).join(" y ")}.` : ".";
        out.push({ kind: "insight", icon: "💡", title: "Insight", text });
      }
    }
    if (withData.length >= 4) {
      const half = Math.floor(withData.length / 2), first = withData.slice(0, half), second = withData.slice(half);
      const avg1 = first.reduce((s, x) => s + x.net, 0) / first.length, avg2 = second.reduce((s, x) => s + x.net, 0) / second.length;
      if (Math.abs(avg2 - avg1) >= Math.max(100, Math.abs(avg1) * 0.05)) out.push({ kind: "trend", icon: "📈", title: "Tendencia", text: `Tu ahorro mensual promedio pasó de ${mt(Math.round(avg1))} a ${mt(Math.round(avg2))} en los últimos ${withData.length} meses.` });
    }
    if (withData.length && withData[withData.length - 1].income > 0) {
      const curM = withData[withData.length - 1], ratio = (curM.expense * 100) / curM.income, others = withData.slice(0, -1).filter((x) => x.income > 0);
      if (others.length) {
        const avgRatio = others.reduce((s, x) => s + (x.expense * 100) / x.income, 0) / others.length;
        if (ratio - avgRatio >= 8) out.push({ kind: "warning", icon: "⚠️", title: "Atención", text: `Tus gastos representan ${ratio.toFixed(0)}% de tus ingresos este mes, ${(ratio - avgRatio).toFixed(0)} puntos por encima de tu promedio.` });
      }
    }
    let best = null;
    for (const g of goalsList) {
      if (g.done || g.remaining <= 0) continue;
      let [y, m] = today.split("-").map(Number);
      for (let i = 0; i < 2; i++) { m -= 1; if (m < 1) { m = 12; y -= 1; } }
      const start3 = `${y}-${pad(m)}-01`;
      const paced = db().contribs.filter((c) => c.goal_id === g.id && c.date >= start3).reduce((s, c) => s + c.amount, 0);
      const pace = paced / Math.max(1, (U(today) - U(start3)) / 86400000 / 30.4);
      if (pace > 0) { const monthsNeeded = g.remaining / pace; if (!best || monthsNeeded < best[1]) best = [g, monthsNeeded]; }
    }
    if (best) { const [g, monthsNeeded] = best; out.push({ kind: "goal", icon: "🎯", title: "Meta", text: `Si mantienes tu ritmo actual de aportes, alcanzarías «${g.name}» en aproximadamente ${Math.max(1, Math.round(monthsNeeded))} meses.` }); }
    return out;
  }
  function analysisExtra(u, uid, cur, today, keys, monthly, cats, withData) {
    const accounts = db().accounts.filter((a) => a.user_id === uid && !a.archived).map((a) => accRow(uid, a));
    const main = accounts.filter((a) => a.currency === cur);
    const liquidNow = main.filter((a) => LIQUID_TYPES.includes(a.type)).reduce((s, a) => s + a.balance, 0);
    const investedNow = main.filter((a) => a.type === "investment").reduce((s, a) => s + a.balance, 0);
    const cardDebtNow = main.filter((a) => a.type === "credit").reduce((s, a) => s + Math.max(0, -a.balance), 0);
    const debtsTotalNow = debtsRemaining(uid, cur);
    const pf = portfolioSummary(u), pfValue = pf.totals.market_value;
    const netWorthNow = liquidNow + investedNow + pfValue - cardDebtNow - debtsTotalNow;

    const avgIncome = withData.length ? withData.reduce((s, x) => s + x.income, 0) / withData.length : 0;
    const avgExpense = withData.length ? withData.reduce((s, x) => s + x.expense, 0) / withData.length : 0;
    const avgNet = withData.length ? withData.reduce((s, x) => s + x.net, 0) / withData.length : 0;
    const curM = monthly[monthly.length - 1];

    const debtRows = db().debts.filter((x) => x.user_id === uid && x.currency === cur && !x.archived);
    const debtMonthlyPayment = debtRows.filter((x) => debtRow(u, x).remaining > 0).reduce((s, x) => s + x.monthly_payment, 0);
    const debtToIncome = avgIncome > 0 ? Math.round((debtMonthlyPayment * 1000) / avgIncome) / 10 : null;
    const emergencyFundMonths = avgExpense > 0 ? Math.round((liquidNow * 10) / avgExpense) / 10 : null;
    const deficit = avgExpense - avgIncome;
    const runwayMonths = deficit > 0 ? Math.round(((liquidNow + investedNow + pfValue) * 10) / deficit) / 10 : null;

    const overview = {
      net_worth: netWorthNow, available: liquidNow, income: curM.income, expense: curM.expense, savings: curM.net, savings_rate: curM.savings_rate,
      debt_total: cardDebtNow + debtsTotalNow, card_debt: cardDebtNow, debts_total: debtsTotalNow, debt_to_income: debtToIncome,
      emergency_fund_months: emergencyFundMonths, burn_rate: Math.round(avgExpense), runway_months: runwayMonths,
      investment_return_pct: pf.totals.unrealized_pct, portfolio_value: pfValue,
    };

    let cum = 0;
    const savingsEvolution = monthly.map((x) => { cum += x.net; return { key: x.key, cumulative: cum }; });
    const networthEvolution = [], debtEvolution = [];
    keys.forEach(([yy, mm], i) => {
      const end = monthEnd(yy, mm), dd = end < today ? end : today, nw = netWorthAsOf(uid, cur, dd, accounts);
      networthEvolution.push({ key: monthly[i].key, net_worth: nw.net_worth, liquid: nw.liquid, invested: nw.invested });
      debtEvolution.push({ key: monthly[i].key, card_debt: nw.card_debt, debts_total: nw.debts_total, total: nw.card_debt + nw.debts_total });
    });

    const assetAllocation = [{ name: "Efectivo y ahorro", value: liquidNow }, { name: "Cuentas de inversión (sin invertir)", value: investedNow }];
    const byType = {};
    for (const it of pf.positions) if (it.currency === cur && it.market_value) byType[it.asset_type] = (byType[it.asset_type] || 0) + it.market_value;
    for (const k in byType) assetAllocation.push({ name: ASSET_ES[k] || k, value: byType[k] });

    let budget = null; try { budget = budgetStatus(u); } catch { budget = null; }
    const budgetOkPct = budget && budget.items.length ? (budget.items.filter((i) => i.status === "ok").length * 100) / budget.items.length : null;
    const goalsList = db().goals.filter((g) => g.user_id === uid && !g.archived && g.currency === cur).sort(cmpName).map((g) => goalRow(u, g));
    const projection = [3, 6, 12, 24].map((n) => ({ months_ahead: n, projected: Math.round(netWorthNow + avgNet * n) }));
    const recurring = recurringExpenses(uid, cur, today), [savedM, investedM] = allocationByMonth(uid, cur, monthly[0].key), health = healthScore(monthly, investedM, savedM);
    const insights = buildInsights(uid, cur, today, monthly, cats, goalsList);

    return { overview, savings_evolution: savingsEvolution, networth_evolution: networthEvolution, debt_evolution: debtEvolution,
      asset_allocation: assetAllocation.filter((a) => a.value > 0), budget, goals: goalsList,
      portfolio: { currency: pf.currency, totals: pf.totals, positions: pf.positions },
      projection: { avg_monthly_net: Math.round(avgNet), points: projection }, recurring, health, insights };
  }
  function analysis(u, months) {
    const uid = u.id, cur = u.currency, today = todayFor(u.timezone); months = Math.max(2, Math.min(24, months));
    let [y, m] = today.split("-").map(Number); const keys = []; for (let i = 0; i < months; i++) { keys.push([y, m]); m -= 1; if (m < 1) { m = 12; y -= 1; } } keys.reverse();
    const monthly = keys.map(([yy, mm]) => { const k = `${yy}-${pad(mm)}`, [inc, exp] = sumPeriod(uid, `${k}-01`, monthEnd(yy, mm), cur); return { key: k, income: inc, expense: exp, net: inc - exp, savings_rate: inc > 0 ? Math.round(((inc - exp) * 1000) / inc) / 10 : null }; });
    const cs = monthStart(today), ce = monthEnd(+today.slice(0, 4), +today.slice(5, 7)), pm = shiftM(cs, -1), ps = pm.s, pe = pm.e;
    const cSp = categorySpend(uid, cs, ce, cur), pSp = categorySpend(uid, ps, pe, cur), names = Object.fromEntries(db().categories.filter((c) => c.user_id === uid).map((c) => [c.id, c.name]));
    const cats = [...new Set([...Object.keys(cSp), ...Object.keys(pSp)])].map((k) => { const c = Math.max(0, cSp[k] || 0), p = Math.max(0, pSp[k] || 0); return { category_id: +k || null, name: +k ? names[k] : "Sin categoría", current: c, previous: p, delta: c - p, delta_pct: p ? Math.round(((c - p) * 1000) / p) / 10 : null }; }).filter((c) => c.current || c.previous).sort((a, b) => Math.max(b.current, b.previous) - Math.max(a.current, a.previous));
    const top = db().transactions.filter((t) => t.user_id === uid && t.type === "expense" && t.date >= cs && t.date <= ce && db().accounts.find((x) => x.id === t.account_id).currency === cur).sort((a, b) => b.amount - a.amount).slice(0, 5).map((t) => ({ id: t.id, date: t.date, amount: t.amount, description: t.description, category_name: (db().categories.find((c) => c.id === t.category_id) || {}).name || null }));
    const since = addDays(today, -90), dow = {}; db().transactions.forEach((t) => { if (t.user_id === uid && ["expense", "refund"].includes(t.type) && t.date >= since && db().accounts.find((x) => x.id === t.account_id).currency === cur) { const w = new Date(U(t.date)).getUTCDay(); dow[w] = (dow[w] || 0) + (t.type === "expense" ? t.amount : -t.amount); } });
    const nd = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"], spent = Object.values(cSp).reduce((a, b) => a + b, 0), dim = +ce.slice(8), day = +today.slice(8);
    const past = monthly.slice(0, -1).filter((x) => x.expense > 0).slice(-3), wd = monthly.filter((x) => x.income || x.expense), inc = wd.reduce((s, x) => s + x.income, 0);
    const base = { currency: cur, monthly, categories: cats.slice(0, 10), top_expenses: top, weekday: [1, 2, 3, 4, 5, 6, 0].map((i) => ({ day: nd[i], total: Math.max(0, dow[i] || 0) })),
      this_month: { spent, day, days: dim, daily_avg: Math.floor(spent / Math.max(1, day)), projected: Math.floor((spent / Math.max(1, day)) * dim), prev_avg: past.length ? Math.floor(past.reduce((s, x) => s + x.expense, 0) / past.length) : null },
      totals: { income: monthly.reduce((s, x) => s + x.income, 0), expense: monthly.reduce((s, x) => s + x.expense, 0), months_with_data: wd.length, avg_savings_rate: inc > 0 ? Math.round((wd.reduce((s, x) => s + x.net, 0) * 1000) / inc) / 10 : null } };
    return Object.assign(base, analysisExtra(u, uid, cur, today, keys, monthly, cats, wd));
  }
  function shiftM(dstr, n) { let y = +dstr.slice(0, 4), m = +dstr.slice(5, 7) + n; while (m < 1) { m += 12; y -= 1; } while (m > 12) { m -= 12; y += 1; } return { s: `${y}-${pad(m)}-01`, e: monthEnd(y, m) }; }
  function buildReport(u, s, e) {
    const uid = u.id, cur = u.currency, [inc, exp] = sumPeriod(uid, s, e, cur), spend = categorySpend(uid, s, e, cur), names = Object.fromEntries(db().categories.filter((c) => c.user_id === uid).map((c) => [c.id, c.name]));
    const ic = {}; db().transactions.forEach((t) => { if (t.user_id === uid && t.type === "income" && t.date >= s && t.date <= e && db().accounts.find((x) => x.id === t.account_id).currency === cur) { const n = (t.category_id && names[t.category_id]) || "Sin categoría"; ic[n] = (ic[n] || 0) + t.amount; } });
    const txs = queryTx(uid, { from: s, to: e, sort: "date", dir: "asc" }, false).rows;
    return { from: s, to: e, currency: cur, income: inc, expense: exp, net: inc - exp, savings_rate: inc > 0 ? Math.round(((inc - exp) * 1000) / inc) / 10 : null,
      expense_by_category: Object.entries(spend).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ name: +k ? names[k] : "Sin categoría", total: v, pct: exp > 0 ? Math.round((v * 1000) / exp) / 10 : 0 })),
      income_by_category: Object.entries(ic).sort((a, b) => b[1] - a[1]).map(([n, v]) => ({ name: n, total: v })), transactions: txs, transaction_count: txs.length };
  }
  const goalRow = (u, g) => {
    const saved = db().contribs.filter((c) => c.goal_id === g.id).reduce((s, c) => s + c.amount, 0), rem = Math.max(0, g.target - saved), today = todayFor(u.timezone);
    const out = { id: g.id, name: g.name, target: g.target, target_date: g.target_date, currency: g.currency, notes: g.notes, archived: !!g.archived, saved, remaining: rem, pct: g.target ? Math.round(Math.min(1000, (saved * 1000) / g.target)) / 10 : 0, done: saved >= g.target, days_left: null, needed_per_month: null };
    if (g.target_date && !out.done) { out.days_left = (U(g.target_date) - U(today)) / 86400000; if (out.days_left > 0) out.needed_per_month = Math.ceil(rem / Math.max(1, Math.round(out.days_left / 30.4))); }
    return out;
  };
  const COLT = ["text", "number", "money", "date", "check"];
  function cleanCols(cols, existing, used) {
    if (!Array.isArray(cols) || !cols.length) fail("Agrega al menos una columna.", 400, "columns"); if (cols.length > 30) fail("Máximo 30 columnas.", 400, "columns");
    const old = Object.fromEntries((existing || []).map((c) => [c.id, c])); let n = Math.max(0, ...(existing || []).map((c) => +c.id.slice(1))); const names = new Set();
    return cols.map((c) => {
      const name = text(c.name, "columns", 60, true), typ = c.type || "text"; if (!COLT.includes(typ)) fail("Tipo de columna no válido.", 400, "columns");
      if (names.has(name.toLowerCase())) fail(`Hay dos columnas llamadas «${name}».`, 400, "columns"); names.add(name.toLowerCase());
      let id = c.id; if (id && old[id]) { if (old[id].type !== typ && used && used.has(id)) fail(`«${old[id].name}» ya tiene datos; para cambiar su tipo crea una columna nueva.`, 400, "columns"); } else { n += 1; id = "c" + n; }
      return { id, name, type: typ };
    });
  }
  function cleanCell(v, typ, name) {
    if (v === null || v === undefined || v === "") return null;
    if (typ === "check") return !!v && !["false", "0", "no"].includes(String(v));
    if (typ === "date") return parseDate(v, name);
    if (typ === "number" || typ === "money") { const s_ = String(v).replace(/[,$\s]/g, ""); if (!/^[+-]?\d+(\.\d+)?$/.test(s_) || Math.abs(Number(s_)) > 1e12) fail(`«${name}» debe ser un número.`, 400, name); return typ === "money" ? Number(s_).toFixed(2) : String(Number(s_)); }
    return text(String(v), name, 500);
  }
  function cleanRow(cols, data) { const out = {}; for (const c of cols) { const v = cleanCell(data[c.id], c.type, c.name); if (v !== null) out[c.id] = v; } return out; }
  function tablePayload(t) {
    const totals = {}; for (const c of t.columns) { if (c.type === "number" || c.type === "money") { const sum = t.rows.reduce((s, r) => s + (r.data[c.id] ? Math.round(Number(r.data[c.id]) * 100) : 0), 0); totals[c.id] = (sum / 100).toFixed(2); } else if (c.type === "check") totals[c.id] = t.rows.filter((r) => r.data[c.id]).length; }
    return { id: t.id, name: t.name, columns: t.columns, rows: t.rows.map((r) => ({ id: r.id, data: r.data })), totals };
  }

  /* ---------- tarjetas: planes a meses y cargos recurrentes (igual que cards.py) ----------
     El capital de un plan YA está dentro del saldo de la tarjeta; el plan solo dice qué parte aún no entra al estado de
     cuenta (una mensualidad por corte). Los intereses de los planes con intereses se registran como gasto real al corte. */
  const PLAN_KINDS_S = { msi: "Meses sin intereses", mci: "Meses con intereses", diferido: "Saldo diferido" };
  const FREQS_S = { weekly: "Cada semana", monthly: "Cada mes", yearly: "Cada año" };
  const INTEREST_CAT = "Intereses de tarjeta", MAX_CATCHUP = 60;
  const clampDay = (y, m, day) => `${y}-${pad(m)}-${pad(Math.min(day, daysInMonth(y, m)))}`;
  function addMonthsS(s, n, anchor) { const y = +s.slice(0, 4), m0 = +s.slice(5, 7) - 1 + n; return clampDay(y + Math.floor(m0 / 12), ((m0 % 12) + 12) % 12 + 1, anchor); }
  function cutsBetween(start, end, cut) {            // cortes c con start < c <= end
    if (!cut || end <= start) return [];
    const out = []; let y = +start.slice(0, 4), m = +start.slice(5, 7);
    for (;;) { const c = clampDay(y, m, cut); if (c > end) return out; if (c > start) out.push(c); m += 1; if (m > 12) { m = 1; y += 1; } }
  }
  function nthCutAfter(start, cut, n) {
    let y = +start.slice(0, 4), m = +start.slice(5, 7), found = 0;
    for (;;) { const c = clampDay(y, m, cut); if (c > start && ++found === n) return c; m += 1; if (m > 12) { m = 1; y += 1; } }
  }
  function planState(p, cut, asOf) {
    const m = p.months_remaining, principal = p.principal_remaining;
    const billed = cut ? Math.min(cutsBetween(p.start_date, asOf, cut).length, m) : 0, base = Math.floor(principal / m);
    return { billed, remaining_principal: billed >= m ? 0 : principal - base * billed, base, interest_per_installment: p.kind !== "msi" ? Math.max(0, p.monthly_amount - base) : 0,
      left: m - billed, done: (p.months_total - m) + billed, next_date: cut && billed < m ? nthCutAfter(p.start_date, cut, billed + 1) : null, end_date: cut ? nthCutAfter(p.start_date, cut, m) : null };
  }
  function planRow(p, cut, today) {
    const st = planState(p, cut, today);
    return { id: p.id, account_id: p.account_id, kind: p.kind, kind_label: PLAN_KINDS_S[p.kind], description: p.description, monthly_amount: p.monthly_amount, months_total: p.months_total,
      installments_done: st.done, months_left: st.left, principal_left: st.remaining_principal, interest_per_installment: st.interest_per_installment, interest_rate: p.interest_rate,
      next_date: st.next_date, end_date: st.end_date, finished: st.left === 0, transaction_id: p.transaction_id, start_date: p.start_date, is_demo: !!p.is_demo };
  }
  const plansFor = (uid, aid) => db().plans.filter((p) => p.user_id === uid && p.account_id === aid).sort((a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : a.id - b.id));
  function cardExtras(uid, a, today, lc) {
    const plans = plansFor(uid, a.id); let atCut = 0;
    if (lc) plans.forEach((p) => { if (p.transaction_id != null && p.start_date > lc) return; atCut += planState(p, a.cut_day, lc).remaining_principal; });
    const rows = plans.map((p) => planRow(p, a.cut_day, today)), active = rows.filter((r) => !r.finished);
    return { plans: rows, deferred_at_cut: atCut, deferred_now: active.reduce((s, r) => s + r.principal_left, 0), installments_monthly: active.reduce((s, r) => s + r.monthly_amount, 0) };
  }
  function intIn(v) { const s = String(v ?? "").trim(); return /^\d+$/.test(s) ? Number(s) : NaN; }
  function parsePlan(dd, cut, pre = "") {
    const f = (k) => pre + k;
    if (!cut) fail("Para usar meses, primero indica el día de corte de la tarjeta.", 400, "cut_day");
    const kind = dd.kind; if (!PLAN_KINDS_S[kind]) fail("Elige el tipo de plan.", 400, f("kind"));
    const monthly = toCents(dd.monthly_amount, f("monthly_amount"));
    const total = intIn(dd.months_total || 0), left = intIn(dd.months_remaining || 0);
    if (Number.isNaN(total) || Number.isNaN(left)) fail("Los meses deben ser números enteros.", 400, f("months_remaining"));
    if (total < 1 || total > 120) fail("El plazo debe ser de 1 a 120 meses.", 400, f("months_total"));
    if (left < 1 || left > total) fail("Los meses que faltan deben estar entre 1 y el plazo total.", 400, f("months_remaining"));
    const top = monthly * left; let principal = top;
    if (kind !== "msi" && dd.principal_remaining !== null && dd.principal_remaining !== undefined && dd.principal_remaining !== "") {
      principal = toCents(dd.principal_remaining, f("principal_remaining"));
      if (principal > top) fail("El saldo pendiente no puede ser mayor que mensualidad × meses que faltan.", 400, f("principal_remaining"));
    }
    const rate = kind !== "msi" ? Number(dd.interest_rate || 0) : 0;
    if (!Number.isFinite(rate)) fail("La tasa debe ser un número.", 400, f("interest_rate"));
    if (rate < 0 || rate > 1000) fail("La tasa debe estar entre 0 y 1000.", 400, f("interest_rate"));
    return { kind, description: text(dd.description, f("description"), 80) || PLAN_KINDS_S[kind], monthly_amount: monthly, months_total: total, months_remaining: left, principal_remaining: principal, interest_rate: rate };
  }
  function insertPlan(uid, aid, p, start, txId = null, isDemo = 0) {
    const row = { id: nid("pl"), user_id: uid, account_id: aid, ...p, start_date: start, transaction_id: txId, is_demo: isDemo ? 1 : 0, created_at: nowStr() };
    db().plans.push(row); return row;
  }
  function parsePurchasePlan(spec, amount, acc) {
    if (acc.type !== "credit") fail("Solo las compras con tarjeta de crédito pueden ser a meses.", 400, "installments");
    if (!acc.cut_day) fail("Para comprar a meses, indica primero el día de corte de la tarjeta (edítala en Cuentas).", 400, "installments");
    const kind = spec.kind; if (kind !== "msi" && kind !== "mci") fail("Elige meses sin intereses o con intereses.", 400, "installments");
    const n = intIn(spec.months || 0); if (Number.isNaN(n)) fail("Elige a cuántos meses.", 400, "installments");
    if (n < 2 || n > 60) fail("Elige entre 2 y 60 meses.", 400, "installments");
    let monthly, rate = 0;
    if (kind === "msi") monthly = Math.floor((amount + Math.floor(n / 2)) / n);
    else {
      monthly = toCents(spec.monthly_amount, "monthly_amount");
      if (monthly * n < amount) fail("Con intereses, la mensualidad × meses no puede ser menor que el importe de la compra.", 400, "monthly_amount");
      rate = Number(spec.interest_rate || 0); if (!Number.isFinite(rate)) fail("La tasa debe ser un número.", 400, "interest_rate");
    }
    return { kind, description: "", monthly_amount: monthly, months_total: n, months_remaining: n, principal_remaining: amount, interest_rate: rate };
  }
  function dropPlans(pred) {
    const d = db(), gone = d.plans.filter(pred).map((p) => p.id); if (!gone.length) return;
    d.plans = d.plans.filter((p) => !gone.includes(p.id)); d.planCharges = d.planCharges.filter((c) => !gone.includes(c.plan_id));
  }
  function attachPurchasePlan(uid, t, spec) {
    dropPlans((p) => p.transaction_id === t.id && p.user_id === uid);
    if (!spec || !spec.kind) return null;
    if (t.type !== "expense") fail("Solo los gastos pueden ser a meses.", 400, "installments");
    const acc = db().accounts.find((a) => a.id === t.account_id), p = parsePurchasePlan(spec, t.amount, acc);
    p.description = (t.description || "Compra").slice(0, 80);
    return insertPlan(uid, acc.id, p, t.date, t.id, t.is_demo);
  }
  const planOfTx = (uid, tid) => db().plans.find((p) => p.transaction_id === tid && p.user_id === uid);
  function specDiffers(uid, tid, spec) {
    const p = planOfTx(uid, tid), want = spec ? spec.kind : null;
    if (!p || !want) return !!p !== !!want;
    if (want !== p.kind || String(spec.months) !== String(p.months_total)) return true;
    return want === "mci" && toCents(spec.monthly_amount || 0, "monthly_amount", { zero: true }) !== p.monthly_amount;
  }
  function purchasePlanGuard(u, existing, tx, specGiven) {
    const p = planOfTx(u.id, existing.id); if (!p) return;
    const acc = db().accounts.find((a) => a.id === p.account_id), billed = planState(p, acc.cut_day, todayFor(u.timezone)).billed;
    const changed = tx.amount !== existing.amount || tx.account_id !== existing.account_id || tx.date !== existing.date || tx.type !== existing.type || specGiven;
    if (billed && changed) fail("Esta compra a meses ya tiene mensualidades en tus estados de cuenta; para cambiar el importe, la fecha, la tarjeta o los meses, bórrala y regístrala de nuevo.", 400, "amount");
  }
  function resyncPurchasePlan(uid, t) {
    const p = planOfTx(uid, t.id); if (!p) return;
    const acc = db().accounts.find((a) => a.id === t.account_id);
    if (t.type !== "expense" || acc.type !== "credit") { dropPlans((x) => x.id === p.id); return; }
    const monthly = p.kind === "msi" ? Math.floor((t.amount + Math.floor(p.months_total / 2)) / p.months_total) : Math.max(p.monthly_amount, Math.ceil(t.amount / p.months_total));
    Object.assign(p, { account_id: acc.id, principal_remaining: t.amount, monthly_amount: monthly, start_date: t.date, description: (t.description || "Compra").slice(0, 80) });
  }
  function beforeDeleteTx(uid, tid) {         // al borrar una compra a meses se borran sus intereses registrados y el plan
    const d = db(), p = planOfTx(uid, tid); if (!p) return;
    const ids = d.planCharges.filter((c) => c.plan_id === p.id && c.transaction_id != null).map((c) => c.transaction_id);
    d.transactions = d.transactions.filter((t) => !(t.user_id === uid && ids.includes(t.id)));
    dropPlans((x) => x.id === p.id);
  }
  function interestCategory(uid) {
    const d = db(), c = d.categories.find((x) => x.user_id === uid && x.kind === "expense" && x.name === INTEREST_CAT && !x.archived); if (c) return c.id;
    const n = { id: nid("c"), user_id: uid, name: INTEREST_CAT, kind: "expense", parent_id: null, archived: 0, is_demo: 0 }; d.categories.push(n); return n.id;
  }
  const nextOcc = (s, freq, anchor) => (freq === "weekly" ? addDays(s, 7) : addMonthsS(s, freq === "yearly" ? 12 : 1, anchor));
  function recRow(r) {
    const d = db(), a = d.accounts.find((x) => x.id === r.account_id), c = r.category_id ? d.categories.find((x) => x.id === r.category_id) : null;
    const f = r.frequency === "weekly" ? 52 / 12 : r.frequency === "yearly" ? 1 / 12 : 1;
    return { id: r.id, description: r.description, amount: r.amount, frequency: r.frequency, frequency_label: FREQS_S[r.frequency], next_date: r.next_date, active: !!r.active,
      account_id: r.account_id, account_name: a.name, account_type: a.type, currency: a.currency, category_id: r.category_id, category_name: c ? c.name : null,
      monthly_equivalent: Math.round(r.amount * f), is_demo: !!r.is_demo };
  }
  function parseRecurring(uid, b, cur) {
    const g = (k) => (k in b ? b[k] : cur ? cur[k] : undefined);
    const description = text(g("description"), "description", 80, true);
    const amount = toCents("amount" in b ? b.amount : cur ? (cur.amount / 100).toFixed(2) : undefined, "amount");
    const acc = myAcc(uid, g("account_id")); if (!acc) fail("Elige la cuenta o tarjeta donde se cobra.", 400, "account_id");
    if (acc.archived && !(cur && cur.account_id === acc.id)) fail("Esa cuenta está archivada.", 400, "account_id");
    let cat = null; const cv = g("category_id");
    if (cv !== null && cv !== undefined && cv !== "") { const c = myCat(uid, cv); if (!c || c.kind !== "expense") fail("Elige una categoría de gasto.", 400, "category_id"); cat = c.id; }
    const frequency = g("frequency"); if (!FREQS_S[frequency]) fail("Elige cada cuánto se cobra.", 400, "frequency");
    const next_date = parseDate(g("next_date"), "next_date");
    return { description, amount, account_id: acc.id, category_id: cat, frequency, next_date, anchor_day: +next_date.slice(8) };
  }
  function materialize(u) {                  // registra lo que ya tocaba (intereses al corte y cargos recurrentes). Idempotente.
    const d = db(), uid = u.id, today = todayFor(u.timezone);
    for (const p of d.plans.filter((x) => x.user_id === uid && x.kind !== "msi")) {
      const acc = d.accounts.find((a) => a.id === p.account_id); if (!acc || !acc.cut_day) continue;
      const st = planState(p, acc.cut_day, today); if (!st.interest_per_installment || !st.billed) continue;
      const charged = d.planCharges.filter((c) => c.plan_id === p.id), last = charged.reduce((mx, c) => (c.cut_date > mx ? c.cut_date : mx), "");
      let done = charged.length;
      cutsBetween(p.start_date, today, acc.cut_day).slice(0, st.billed).forEach((c, i) => {
        if ((last && c <= last) || done >= st.billed) return;
        let tid = null;
        try {
          tid = createTx(uid, { type: "expense", amount: money(st.interest_per_installment), date: c, account_id: p.account_id, category_id: interestCategory(uid),
            description: `Intereses · ${p.description} (${(p.months_total - p.months_remaining) + i + 1}/${p.months_total})`, notes: "Registrado por FIPO al corte: parte de intereses de la mensualidad." }, p.is_demo).id;
        } catch (e) { if (!(e instanceof ApiError)) throw e; }     // p. ej. tarjeta archivada: no se inventa nada
        d.planCharges.push({ plan_id: p.id, cut_date: c, transaction_id: tid }); done += 1;
      });
    }
    ensureN(d);
    for (const r of d.recurring.filter((x) => x.user_id === uid && x.active && x.next_date <= today)) {
      const acc = d.accounts.find((a) => a.id === r.account_id); let dt_ = r.next_date, n = 0;
      if (acc.archived) {
        r.active = 0;
        addN(d, uid, "recurring", `Pausé «${r.description}»`, `La cuenta ${acc.name} está archivada; elige otra para seguir registrándolo.`, "#/recurring", `rec-paused:${r.id}:${dt_}`);
        continue;
      }
      let cat = r.category_id; const c = cat ? d.categories.find((x) => x.id === cat) : null; if (!c || c.archived) cat = null;
      while (dt_ <= today && n < MAX_CATCHUP) {
        createTx(uid, { type: "expense", amount: money(r.amount), date: dt_, account_id: r.account_id, category_id: cat, description: r.description, recurring: 1,
          notes: "Cargo recurrente registrado automáticamente por FIPO." }, r.is_demo);
        addN(d, uid, "recurring", `Se registró ${r.description}`, `${mt(r.amount)} ${acc.currency} en ${acc.name} (${dt_}).`, "#/movements", `rec:${r.id}:${dt_}`);
        dt_ = nextOcc(dt_, r.frequency, r.anchor_day); n += 1;
      }
      r.next_date = dt_;
    }
  }
  function recurringList(u) {
    const rows = db().recurring.filter((r) => r.user_id === u.id).sort((a, b) => b.active - a.active || (a.next_date < b.next_date ? -1 : a.next_date > b.next_date ? 1 : a.id - b.id)).map(recRow);
    return { items: rows, currency: u.currency, monthly_total: rows.filter((r) => r.active && r.currency === u.currency).reduce((s, r) => s + r.monthly_equivalent, 0) };
  }

  /* ---------- enrutador de la API ---------- */
  async function handle(method, url, body) {
    const [path, query] = url.split("?"); const q = Object.fromEntries(new URLSearchParams(query || "")); let m; const d = db();
    body = body || {};
    if (path === "/api/auth/register" && method === "POST") {
      const name = text(body.name, "name", 80, true), email = text(body.email, "email", 200, true).toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail("Correo electrónico no válido.", 400, "email");
      if (typeof body.password !== "string" || body.password.length < 8) fail("La contraseña debe tener al menos 8 caracteres.", 400, "password");
      if (d.users.some((x) => x.email === email)) fail("Ya existe una cuenta con ese correo.", 409, "email");
      const salt = rid(); const u = { id: nid("u"), name, email, salt, hash: await hashPw(body.password, salt), currency: "MXN", timezone: "America/Mexico_City", theme: "", onboarded: 0 };
      try { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; if (TZS.includes(tz)) u.timezone = tz; } catch { /* por defecto */ }
      d.users.push(u);
      EXP_CATS.forEach((n) => d.categories.push({ id: nid("c"), user_id: u.id, name: n, kind: "expense", parent_id: null, archived: 0, is_demo: 0 }));
      INC_CATS.forEach((n) => d.categories.push({ id: nid("c"), user_id: u.id, name: n, kind: "income", parent_id: null, archived: 0, is_demo: 0 }));
      d.session = u.id; return { user: userDict(u) };
    }
    if (path === "/api/auth/login" && method === "POST") {
      const email = String(body.email || "").trim().toLowerCase(), u = d.users.find((x) => x.email === email);
      if (!u || (await hashPw(String(body.password || ""), u.salt)) !== u.hash) fail("Correo o contraseña incorrectos.", 401);
      d.session = u.id; return { user: userDict(u) };
    }
    if (path === "/api/auth/logout") { d.session = null; return { ok: true }; }
    if (path === "/api/auth/forgot") return { ok: true, preview: true };
    if (path === "/api/auth/reset") fail("El enlace no es válido o ya expiró. Solicita uno nuevo.");
    if (path === "/api/me" && method === "GET") { const u = me(); if (!u) throw new ApiError("No autenticado.", 401); materialize(u); return { user: userDict(u), currencies: CURRENCIES, timezones: TZS, email_available: false }; }
    const u = need();
    materialize(u);                                   // pone al día intereses al corte y cargos recurrentes (como el before_request del servidor)
    if (path === "/api/me" && method === "PATCH") {
      const name = text(body.name ?? u.name, "name", 80, true), cur = body.currency ?? u.currency, tz = body.timezone ?? u.timezone, th = body.theme ?? u.theme;
      if (!CURRENCIES.includes(cur)) fail("Moneda no compatible.", 400, "currency");
      if (!TZS.includes(tz)) fail("Zona horaria no válida.", 400, "timezone");
      if (!["light", "dark", ""].includes(th)) fail("Tema no válido.", 400, "theme");
      if (body.notify_email) fail("La vista previa no tiene servidor de correo. En la app con servidor y SMTP configurado sí puede enviarte los avisos por correo.", 400, "notify_email");
      Object.assign(u, { name, currency: cur, timezone: tz, theme: th }); return { user: userDict(u) };
    }
    if (path === "/api/me" && method === "DELETE") {
      if ((await hashPw(String(body.password || ""), u.salt)) !== u.hash) fail("La contraseña no es correcta.", 400, "password");
      d.transactions = d.transactions.filter((t) => t.user_id !== u.id); d.accounts = d.accounts.filter((a) => a.user_id !== u.id);
      d.categories = d.categories.filter((c) => c.user_id !== u.id); dropPlans((p) => p.user_id === u.id); d.recurring = d.recurring.filter((r) => r.user_id !== u.id); d.users = d.users.filter((x) => x.id !== u.id); d.session = null; return { ok: true };
    }
    if (path === "/api/me/password") {
      if ((await hashPw(String(body.current || ""), u.salt)) !== u.hash) fail("La contraseña actual no es correcta.", 400, "current");
      if (typeof body.password !== "string" || body.password.length < 8) fail("La contraseña debe tener al menos 8 caracteres.", 400, "password");
      u.salt = rid(); u.hash = await hashPw(body.password, u.salt); return { ok: true };
    }
    if (path === "/api/onboarding") {
      const cur = body.currency || u.currency; if (!CURRENCIES.includes(cur)) fail("Moneda no compatible.", 400, "currency");
      const list = body.accounts || []; if (!Array.isArray(list) || list.length > 20) fail("Lista de cuentas no válida.");
      const snapshot = JSON.stringify(d);
      try { u.currency = cur; list.forEach((a) => createAccount(u, a, cur, todayFor(u.timezone))); u.onboarded = 1; }
      catch (e) { mem = JSON.parse(snapshot); throw e; }
      return { user: userDict(u) };
    }
    if (path === "/api/accounts" && method === "GET") return { accounts: d.accounts.filter((a) => a.user_id === u.id).sort((x, y) => x.archived - y.archived || cmpName(x, y)).map((a) => accRow(u.id, a)) };
    if (path === "/api/accounts" && method === "POST") { const a = createAccount(u, body, u.currency, todayFor(u.timezone)); return { account: accRow(u.id, a) }; }
    if ((m = /^\/api\/accounts\/(\d+)\/adjust$/.exec(path))) {
      const a = myAcc(u.id, m[1]); if (!a) fail("Cuenta no encontrada.", 404);
      const target = toCents(body.new_balance, "new_balance", { neg: true, zero: true }), diff = target - balanceOf(u.id, a);
      if (diff === 0) fail("El saldo indicado es igual al saldo actual.", 400, "new_balance");
      d.transactions.push({ id: nid("t"), user_id: u.id, type: "adjustment", amount: diff, to_amount: null, date: parseDate(body.date || todayFor(u.timezone)), account_id: a.id, to_account_id: null, category_id: null,
        description: "Ajuste de saldo", payment_method: "", tags: "", notes: text(body.note, "note", 500), recurring: 0, is_demo: 0, created_at: nowStr(), updated_at: nowStr() });
      return { ok: true, difference: diff };
    }
    if ((m = /^\/api\/accounts\/(\d+)$/.exec(path))) {
      const a = myAcc(u.id, m[1]); if (!a) fail("Cuenta no encontrada.", 404);
      if (method === "GET") return history(u, m[1]);
      const used = d.transactions.some((t) => t.user_id === u.id && (t.account_id === a.id || t.to_account_id === a.id)) || d.ops.some((o) => o.user_id === u.id && o.account_id === a.id) || d.debtPays.some((p) => p.user_id === u.id && p.account_id === a.id);
      if (method === "DELETE") { if (used) fail("La cuenta tiene movimientos. Archívala en lugar de eliminarla.", 409); d.accounts = d.accounts.filter((x) => x !== a); dropPlans((p) => p.account_id === a.id); d.recurring = d.recurring.filter((r) => r.account_id !== a.id); return { ok: true }; }
      if (method === "PATCH") {
        const typ = body.type ?? a.type; if (!ACC_TYPES.includes(typ)) fail("Tipo de cuenta no válido.", 400, "type");
        const cur = body.currency ?? a.currency; if (cur !== a.currency && used) fail("No puedes cambiar la moneda de una cuenta con movimientos.", 400, "currency");
        if (!CURRENCIES.includes(cur)) fail("Moneda no compatible.", 400, "currency");
        const low = toCents(body.low_balance_alert ?? a.low_balance_alert / 100 ?? 0, "low_balance_alert", { zero: true });
        Object.assign(a, { name: text(body.name ?? a.name, "name", 80, true), institution: text(body.institution ?? a.institution, "institution", 80), type: typ, currency: cur,
          low_balance_alert: low, archived: (body.archived ?? a.archived) ? 1 : 0, opened_on: parseDate(body.opened_on ?? a.opened_on, "opened_on"), ...creditFields(body, typ, a) });
        return { account: accRow(u.id, a) };
      }
    }
    if (path === "/api/categories" && method === "GET") {
      const rows = d.categories.filter((c) => c.user_id === u.id).sort((x, y) => x.archived - y.archived || (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0) || cmpName(x, y));
      return { categories: rows.map((c) => ({ id: c.id, name: c.name, kind: c.kind, parent_id: c.parent_id, archived: !!c.archived, is_demo: !!c.is_demo, uses: d.transactions.filter((t) => t.category_id === c.id).length })) };
    }
    if (path === "/api/categories" && method === "POST") {
      if (!["expense", "income"].includes(body.kind)) fail("Tipo de categoría no válido.", 400, "kind");
      const name = text(body.name, "name", 60, true); let parent = null;
      if (body.parent_id) { const p = myCat(u.id, body.parent_id); if (!p || p.kind !== body.kind || p.parent_id) fail("Categoría principal no válida.", 400, "parent_id"); parent = p.id; }
      if (d.categories.some((c) => c.user_id === u.id && c.kind === body.kind && c.name.toLowerCase() === name.toLowerCase() && !c.archived && (c.parent_id || 0) === (parent || 0))) fail("Ya existe una categoría con ese nombre.", 409, "name");
      const c = { id: nid("c"), user_id: u.id, name, kind: body.kind, parent_id: parent, archived: 0, is_demo: 0 }; d.categories.push(c);
      return { category: { id: c.id, name, kind: c.kind, parent_id: parent, archived: false, uses: 0 } };
    }
    if ((m = /^\/api\/categories\/(\d+)$/.exec(path))) {
      const c = myCat(u.id, m[1]); if (!c) fail("Categoría no encontrada.", 404);
      if (method === "PATCH") { c.name = text(body.name ?? c.name, "name", 60, true); c.archived = (body.archived ?? c.archived) ? 1 : 0; return { ok: true }; }
      if (method === "DELETE") {
        if (d.transactions.some((t) => t.category_id === c.id)) fail("La categoría tiene movimientos. Archívala en lugar de eliminarla.", 409);
        d.categories.forEach((x) => { if (x.parent_id === c.id) x.parent_id = null; }); d.categories = d.categories.filter((x) => x !== c); return { ok: true };
      }
    }
    if (path === "/api/transactions" && method === "GET") { const r = queryTx(u.id, q); return { transactions: r.rows, total: r.total, page: r.page, per_page: r.per }; }
    if (path === "/api/transactions" && method === "POST") { const t = createTx(u.id, body); if (body.installments) attachPurchasePlan(u.id, t, body.installments); return { transaction: txView(t) }; }
    if ((m = /^\/api\/transactions\/(\d+)$/.exec(path))) {
      const t = d.transactions.find((x) => x.user_id === u.id && x.id === +m[1]); if (!t) fail("Movimiento no encontrado.", 404);
      if (method === "GET") return { transaction: txView(t) };
      if (method === "DELETE") { beforeDeleteTx(u.id, t.id); db().transactions = db().transactions.filter((x) => x !== t); db().planCharges.forEach((c) => { if (c.transaction_id === t.id) c.transaction_id = null; }); return { ok: true }; }
      if (method === "PUT") {
        const specGiven = "installments" in body && specDiffers(u.id, t.id, body.installments);
        const tx = normalizeTx(u.id, body, t), ids = [tx.account_id, tx.to_account_id].filter(Boolean);
        purchasePlanGuard(u, t, tx, specGiven);
        const allDemo = ids.every((i) => d.accounts.find((a) => a.id === i).is_demo);
        Object.assign(t, tx, { is_demo: t.is_demo && allDemo ? 1 : 0, updated_at: nowStr() });
        if (specGiven) attachPurchasePlan(u.id, t, body.installments); else resyncPurchasePlan(u.id, t);
        return { transaction: txView(t) };
      }
    }

    if (path === "/api/import/parse" && method === "POST") {
      const acc = myAcc(u.id, body.account_id); if (!acc) fail("Elige la cuenta a la que pertenece el estado de cuenta.", 400, "account_id");
      if (!body.file) fail("Selecciona un archivo.", 400, "file");
      return parseCsv(u, body.file, body);
    }
    if (path === "/api/import/commit" && method === "POST") {
      const acc = myAcc(u.id, body.account_id); if (!acc) fail("Cuenta no válida.", 400, "account_id");
      const rows = body.rows; if (!Array.isArray(rows) || !rows.length) fail("No hay movimientos para guardar.");
      if (rows.length > 2000) fail("Máximo 2,000 movimientos por importación.");
      const before = d.transactions.length, imp = { id: nid("i"), user_id: u.id, account_id: acc.id, filename: text(body.filename, "filename", 200), kind: "csv", created_at: nowStr() };
      try {
        rows.forEach((r, i) => { if (!Number.isInteger(r.amount) || r.amount === 0) fail(`Fila ${i + 1}: importe no válido.`);
          const tx = createTx(u.id, { type: r.amount > 0 ? "income" : "expense", amount: (Math.abs(r.amount) / 100).toFixed(2), date: r.date, account_id: acc.id, category_id: r.category_id || null, description: r.description || "" }); tx.import_id = imp.id; });
      } catch (e) { d.transactions.length = before; throw e; }
      d.imports.push(imp); return { ok: true, import_id: imp.id, created: rows.length };
    }
    if (path === "/api/imports" && method === "GET") return { imports: d.imports.filter((i) => i.user_id === u.id).slice().reverse().slice(0, 30).map((i) => ({ id: i.id, filename: i.filename, kind: i.kind, created_at: i.created_at.replace(" ", "T") + "Z",
      account_name: (myAcc(u.id, i.account_id) || { name: "" }).name, remaining: d.transactions.filter((t) => t.import_id === i.id).length })) };
    if ((m = /^\/api\/imports\/(\d+)$/.exec(path)) && method === "DELETE") {
      const i = d.imports.find((x) => x.id === +m[1] && x.user_id === u.id); if (!i) fail("Importación no encontrada.", 404);
      const n = d.transactions.filter((t) => t.import_id === i.id).length; d.transactions = d.transactions.filter((t) => t.import_id !== i.id); d.imports = d.imports.filter((x) => x !== i); return { ok: true, deleted: n };
    }
    if (path === "/api/widgets/data" && method === "GET") return widgetData(u);
    if (path === "/api/widgets/layout") {
      if (method === "GET") return { layout: u.widget_layout || null };
      if (method === "PUT") { u.widget_layout = widgetLayoutClean(body); save(); return { layout: u.widget_layout }; }
      if (method === "DELETE") { delete u.widget_layout; save(); return { layout: null }; }
    }
    if (path === "/api/widgets/token") {
      if (method === "GET") return { has_token: !!u.widget_token, created_at: u.widget_token || null };
      if (method === "POST") { u.widget_token = new Date().toISOString(); save(); return { token: "preview-sin-servidor-no-funciona" }; }
      if (method === "DELETE") { delete u.widget_token; save(); return { ok: true }; }
    }
    if (path === "/api/fx" && method === "GET") {
      const set = new Set(db().accounts.filter((x) => x.user_id === u.id && !x.archived).map((x) => x.currency)); set.delete(u.currency);
      const rates = {}; for (const c of [...set].sort()) { const r = fxRate(c, u.currency); rates[c] = r ? { currency: c, rate: r, source: "preview", as_of: null } : null; }
      return { main: u.currency, rates };
    }
    if (path === "/api/portfolio" && method === "GET") return portfolioSummary(u);
    if (path === "/api/portfolio/ops" && method === "GET") { const s_ = q.symbol ? cleanSym(q.symbol) : null; return { ops: d.ops.filter((o) => o.user_id === u.id && (!s_ || o.symbol === s_)).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id)).map(opRow) }; }
    if (path === "/api/portfolio/ops" && method === "POST") return { op: opRow(saveOp(u, body)) };
    if ((m = /^\/api\/portfolio\/ops\/(\d+)$/.exec(path))) {
      if (method === "PUT") return { op: opRow(saveOp(u, body, +m[1])) };
      if (method === "DELETE") { const o = d.ops.find((x) => x.id === +m[1] && x.user_id === u.id); if (!o) fail("Operación no encontrada.", 404); const rest = d.ops.filter((x) => x.user_id === u.id && x !== o); simulate(rest); d.ops = d.ops.filter((x) => x !== o); return { ok: true }; }
    }
    if (path === "/api/portfolio/refresh") fail("En la vista previa no hay conexión con Yahoo Finance. Fija los precios a mano en cada activo; en la app con servidor se actualizan solos cada hora.", 503);
    if (path === "/api/portfolio/price" && method === "POST") {
      const sym = cleanSym(body.symbol); if (!d.ops.some((o) => o.user_id === u.id && o.symbol === sym)) fail("Solo puedes fijar el precio de activos que tengas en tu portafolio.", 404, "symbol");
      d.quotes[sym] = { price: Number(decIn(body.price, "price")), at: new Date().toISOString() }; checkPrices(u, [sym]); return { ok: true };
    }
    if (path === "/api/portfolio/history") return { available: false, link: yLink(cleanSym(q.symbol)), note: "La vista previa no consulta Yahoo Finance." };

    // ---- avisos
    if (path === "/api/notifications" && method === "GET") {
      const dd = ensureN(d); checkCards(u); checkPrices(u); checkWatchlist(u);
      const mine = dd.notifs.filter((n) => n.user_id === u.id && !n.dismissed).sort((a, b) => b.id - a.id).slice(0, 100);
      return { unread: mine.filter((n) => !n.read_at).length, items: mine.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, created_at: n.created_at, read_at: n.read_at })) };
    }
    if (path === "/api/notifications/read" && method === "POST") { ensureN(d).notifs.filter((n) => n.user_id === u.id && (body.all || (body.ids || []).map(Number).includes(n.id)) && !n.read_at).forEach((n) => { n.read_at = nowStr(); }); return { ok: true }; }
    if (path === "/api/notifications" && method === "DELETE") { ensureN(d).notifs.filter((n) => n.user_id === u.id && n.read_at).forEach((n) => { n.dismissed = 1; }); return { ok: true }; }
    if ((m = /^\/api\/notifications\/(\d+)$/.exec(path)) && method === "DELETE") { ensureN(d).notifs.filter((n) => n.user_id === u.id && n.id === +m[1]).forEach((n) => { n.dismissed = 1; n.read_at = n.read_at || nowStr(); }); return { ok: true }; }
    if (path === "/api/price-alerts" && method === "GET") return ensureN(d).alerts.filter((a) => a.user_id === u.id).sort((a, b) => (a.symbol < b.symbol ? -1 : 1)).map((a) => alertRow(d, a));
    if (path === "/api/price-alerts" && method === "PUT") {
      ensureN(d); const sym = cleanSym(body.symbol); if (!d.ops.some((o) => o.user_id === u.id && o.symbol === sym)) fail("Solo puedes poner objetivos a activos de tu portafolio.", 404);
      const lo = alertNum(body.lower, "lower"), up = alertNum(body.upper, "upper");
      if (lo === null && up === null) fail("Escribe al menos un límite (inferior o superior).", 400, "lower");
      if (lo !== null && up !== null && lo >= up) fail("El límite inferior debe ser menor que el superior.", 400, "lower");
      let a = d.alerts.find((x) => x.user_id === u.id && x.symbol === sym);
      if (!a) { a = { id: ++d.nseq, user_id: u.id, symbol: sym }; d.alerts.push(a); }
      Object.assign(a, { lower: lo, upper: up, active: body.active === false ? 0 : 1, lower_hit: 0, upper_hit: 0 }); checkPrices(u, [sym]); return alertRow(d, a);
    }
    if ((m = /^\/api\/price-alerts\/([^/]+)$/.exec(path)) && method === "DELETE") { const sym = cleanSym(decodeURIComponent(m[1])); ensureN(d).alerts = d.alerts.filter((a) => !(a.user_id === u.id && a.symbol === sym)); return { ok: true }; }
    if (path === "/api/watchlist" && method === "GET") {
      ensureN(d); const today = todayFor(u.timezone);
      const rows = d.watchlist.filter((w) => w.user_id === u.id).sort((a, b) => {
        const ka = a.report_date || "9999-99-99", kb = b.report_date || "9999-99-99";
        return ka < kb ? -1 : ka > kb ? 1 : (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);
      });
      return attachFx(rows.map((w) => watchRow(d, w, today)), u.currency);
    }
    if (path === "/api/watchlist" && method === "PUT") {
      ensureN(d); const sym = cleanSym(body.symbol); if (!sym) fail("Escribe un símbolo.", 400, "symbol");
      const entry = alertNum(body.entry_price, "entry_price"), exitp = alertNum(body.exit_price, "exit_price");
      if (entry !== null && exitp !== null && entry >= exitp) fail("El precio de entrada debe ser menor que el de salida.", 400, "entry_price");
      const reportDate = body.report_date ? String(body.report_date) : null;
      let w = d.watchlist.find((x) => x.user_id === u.id && x.symbol === sym);
      if (!w) { w = { id: ++d.wseq, user_id: u.id, symbol: sym, is_demo: 0 }; d.watchlist.push(w); }
      Object.assign(w, { company: (body.company || "").slice(0, 120), report_date: reportDate, entry_price: entry, exit_price: exitp, notes: (body.notes || "").slice(0, 300) });
      return attachFx([watchRow(d, w, todayFor(u.timezone))], u.currency)[0];
    }
    if ((m = /^\/api\/watchlist\/([^/]+)$/.exec(path)) && method === "DELETE") { const sym = cleanSym(decodeURIComponent(m[1])); ensureN(d).watchlist = d.watchlist.filter((w) => !(w.user_id === u.id && w.symbol === sym)); return { ok: true }; }

    // ---- tarjetas: planes a meses y cargos recurrentes
    if ((m = /^\/api\/cards\/(\d+)\/plans$/.exec(path)) && method === "POST") {
      const a = myAcc(u.id, m[1]); if (!a || a.type !== "credit") fail("Tarjeta no encontrada.", 404);
      const p = insertPlan(u.id, a.id, parsePlan(body, a.cut_day), todayFor(u.timezone)); return { plan: planRow(p, a.cut_day, todayFor(u.timezone)) };
    }
    if ((m = /^\/api\/cards\/plans\/(\d+)$/.exec(path)) && method === "DELETE") {
      const p = d.plans.find((x) => x.user_id === u.id && x.id === +m[1]); if (!p) fail("Plan no encontrado.", 404); dropPlans((x) => x === p); return { ok: true };
    }
    if (path === "/api/recurring" && method === "GET") return recurringList(u);
    if (path === "/api/recurring" && method === "POST") {
      const f = parseRecurring(u.id, body), r = { id: nid("rc"), user_id: u.id, ...f, active: 1, is_demo: 0, created_at: nowStr() }; d.recurring.push(r);
      materialize(u); return { item: recRow(r) };
    }
    if ((m = /^\/api\/recurring\/(\d+)$/.exec(path))) {
      const r = d.recurring.find((x) => x.user_id === u.id && x.id === +m[1]); if (!r) fail("Cargo no encontrado.", 404);
      if (method === "DELETE") { d.recurring = d.recurring.filter((x) => x !== r); return { ok: true }; }
      if (method === "PATCH") { const f = parseRecurring(u.id, body, r); Object.assign(r, f, { active: "active" in body ? (body.active ? 1 : 0) : r.active }); materialize(u); return { item: recRow(r) }; }
    }
    // ---- tarjetas
    if (path === "/api/cards" && method === "GET") {
      const cards = d.accounts.filter((a) => a.user_id === u.id && a.type === "credit").sort((a, b) => a.archived - b.archived || cmpName(a, b)).map((a) => cardRow(u, a)), act = cards.filter((c) => !c.archived && c.currency === u.currency);
      return { cards, currency: u.currency, totals: { used: act.reduce((s, c) => s + c.used, 0), limit: act.reduce((s, c) => s + c.limit, 0), pending: act.reduce((s, c) => s + ((c.statement || {}).pending || 0), 0) } };
    }
    if ((m = /^\/api\/cards\/(\d+)\/pay$/.exec(path)) && method === "POST") {
      const card = myAcc(u.id, m[1]); if (!card || card.type !== "credit") fail("Tarjeta no encontrada.", 404);
      const src = myAcc(u.id, body.from_account_id); if (!src || src.type === "credit") fail("Elige la cuenta desde la que pagas.", 400, "from_account_id");
      if (src.currency !== card.currency) fail(`La tarjeta está en ${card.currency} y la cuenta en ${src.currency}. Registra la transferencia manualmente indicando el importe recibido.`, 400, "from_account_id");
      const amt = toCents(body.amount, "amount"); const tx = createTx(u.id, { type: "transfer", amount: (amt / 100).toFixed(2), date: body.date || todayFor(u.timezone), account_id: src.id, to_account_id: card.id, description: "Pago de tarjeta " + card.name });
      return { ok: true, transaction_id: tx.id };
    }
    // ---- deudas
    if (path === "/api/debts" && method === "GET") {
      const rows = d.debts.filter((x) => x.user_id === u.id).sort((a, b) => a.archived - b.archived || cmpName(a, b)).map((x) => debtRow(u, x)), act = rows.filter((r) => !r.archived && r.currency === u.currency);
      return { debts: rows, currency: u.currency, totals: { remaining: act.reduce((s, r) => s + r.remaining, 0), monthly: act.filter((r) => r.remaining > 0).reduce((s, r) => s + r.monthly_payment, 0), paid_interest: rows.filter((r) => r.currency === u.currency).reduce((s, r) => s + r.paid_interest, 0) } };
    }
    if (path === "/api/debts" && method === "POST") { const f = debtFields(body, u), x = { id: nid("d"), user_id: u.id, archived: 0, ...f }; d.debts.push(x); return { debt: debtRow(u, x) }; }
    if ((m = /^\/api\/debts\/payments\/(\d+)$/.exec(path)) && method === "DELETE") { const p = d.debtPays.find((x) => x.id === +m[1] && x.user_id === u.id); if (!p) fail("Pago no encontrado.", 404); d.debtPays = d.debtPays.filter((x) => x !== p); return { ok: true }; }
    if ((m = /^\/api\/debts\/(\d+)\/payments$/.exec(path)) && method === "POST") {
      const x = d.debts.find((y) => y.id === +m[1] && y.user_id === u.id); if (!x) fail("Deuda no encontrada.", 404);
      const total = toCents(body.amount, "amount"), interest = toCents(body.interest || 0, "interest", { zero: true }); if (interest > total) fail("Los intereses no pueden ser mayores que el pago.", 400, "interest");
      const pp = total - interest, rem = debtRow(u, x).remaining; if (pp > rem) fail(`Ese pago abona ${mt(pp)} al capital y solo quedan ${mt(rem)}. Si el resto son intereses, indícalo en «de los cuales intereses».`, 400, "amount");
      let acc = null; if (body.account_id) { const a = myAcc(u.id, body.account_id); if (!a) fail("Selecciona una cuenta válida.", 400, "account_id"); if (a.archived) fail("La cuenta está archivada.", 400, "account_id"); if (a.type === "credit") fail("Paga desde una cuenta de dinero, no desde una tarjeta de crédito.", 400, "account_id"); if (a.currency !== x.currency) fail(`La deuda está en ${x.currency} y la cuenta en ${a.currency}.`, 400, "account_id"); acc = a.id; }
      const p = { id: nid("dp"), user_id: u.id, debt_id: x.id, date: parseDate(body.date || todayFor(u.timezone), "date"), principal_part: pp, interest_part: interest, account_id: acc, notes: text(body.notes, "notes", 300) }; d.debtPays.push(p); return { ok: true, payment_id: p.id };
    }
    if ((m = /^\/api\/debts\/(\d+)$/.exec(path))) {
      const x = d.debts.find((y) => y.id === +m[1] && y.user_id === u.id); if (!x) fail("Deuda no encontrada.", 404);
      if (method === "GET") return { debt: debtRow(u, x), payments: d.debtPays.filter((p) => p.debt_id === x.id).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id)).map((p) => ({ ...p, total: p.principal_part + p.interest_part, account_name: p.account_id ? (myAcc(u.id, p.account_id) || {}).name : null })) };
      if (method === "PATCH") {
        const f = debtFields(body, u, x), paid = d.debtPays.filter((p) => p.debt_id === x.id);
        if (f.currency !== x.currency && paid.length) fail("No puedes cambiar la moneda de una deuda con pagos.", 400, "currency");
        if (f.principal < paid.reduce((s, p) => s + p.principal_part, 0)) fail("El monto original no puede ser menor a lo que ya has abonado al capital.", 400, "principal");
        Object.assign(x, f, { archived: (body.archived ?? x.archived) ? 1 : 0 }); return { debt: debtRow(u, x) };
      }
      if (method === "DELETE") { if (d.debtPays.some((p) => p.debt_id === x.id)) fail("La deuda tiene pagos registrados. Archívala en lugar de eliminarla, o elimina primero sus pagos.", 409); d.debts = d.debts.filter((y) => y !== x); return { ok: true }; }
    }
    // ---- presupuestos
    if (path === "/api/budgets" && method === "GET") return budgetStatus(u, q.month);
    if (path === "/api/budgets" && method === "PUT") {
      const cid = Number(body.category_id || 0); if (!Number.isInteger(cid)) fail("Categoría no válida.", 400, "category_id"); const amount = toCents(body.amount, "amount");
      if (cid) { const c = myCat(u.id, cid); if (!c || c.kind !== "expense") fail("Elige una categoría de gasto.", 400, "category_id"); if (c.parent_id) fail("Los presupuestos se definen en la categoría principal; sus subcategorías se suman a ella.", 400, "category_id"); }
      const b = d.budgets.find((x) => x.user_id === u.id && x.category_id === cid); if (b) b.amount = amount; else d.budgets.push({ user_id: u.id, category_id: cid, amount }); return budgetStatus(u, body.month);
    }
    if ((m = /^\/api\/budgets\/(\d+)$/.exec(path)) && method === "DELETE") { const b = d.budgets.find((x) => x.user_id === u.id && x.category_id === +m[1]); if (!b) fail("Presupuesto no encontrado.", 404); d.budgets = d.budgets.filter((x) => x !== b); return { ok: true }; }
    // ---- análisis y reportes
    if (path === "/api/analysis") { const n = q.months ? parseInt(q.months, 10) : 12; if (!Number.isInteger(n)) fail("Número de meses no válido."); return analysis(u, n); }
    if (path === "/api/health-score") { const h = analysis(u, 12).health; return { score_100: h.score, score_10: h.score == null ? null : Math.round(h.score) / 10, breakdown: h.breakdown, month: h.month, amounts: h.amounts, income: h.income, is_current_month: h.is_current_month, unassigned: h.unassigned, savings_source: h.savings_source }; }
    if (path === "/api/report") {
      const today = todayFor(u.timezone); let s, e;
      if (q.from || q.to) { s = parseDate(q.from, "from"); e = parseDate(q.to, "to"); if (e < s) fail("La fecha final es anterior a la inicial.", 400, "to"); } else { const b = monthBounds(q.month, today); s = b.s; e = b.e; }
      const rep = buildReport(u, s, e), fmt = q.format || "json";
      if (fmt === "csv") { const T = { expense: "Gasto", income: "Ingreso", transfer: "Transferencia", refund: "Reembolso", adjustment: "Ajuste" };
        const lines = [["Fecha", "Tipo", "Descripción", "Categoría", "Cuenta", "Cuenta destino", "Importe"]].concat(rep.transactions.map((t) => [t.date, T[t.type], csvSafe(t.description), csvSafe(t.category_name), csvSafe(t.account_name), csvSafe(t.to_account_name), money(t.amount)]));
        return { __file: true, name: `fipo-reporte-${s}_${e}.csv`, data: "﻿" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n" }; }
      if (fmt === "pdf") fail("El PDF se genera en el servidor; en la vista previa descarga el CSV. La app con servidor incluye el PDF.", 501);
      rep.transactions = rep.transactions.slice(0, 50); return rep;
    }
    // ---- metas
    if (path === "/api/goals" && method === "GET") return { goals: d.goals.filter((g) => g.user_id === u.id).sort((a, b) => a.archived - b.archived || cmpName(a, b)).map((g) => goalRow(u, g)) };
    const goalF = (b, row) => { const cur = b.currency ?? (row ? row.currency : u.currency); if (!CURRENCIES.includes(cur)) fail("Moneda no compatible.", 400, "currency"); const td = b.target_date ?? (row ? row.target_date : null);
      return { name: text(b.name ?? (row && row.name), "name", 80, true), currency: cur, target: toCents(b.target ?? (row && row.target / 100), "target"), target_date: td ? parseDate(td, "target_date") : null, notes: text(b.notes ?? (row ? row.notes : ""), "notes", 500) }; };
    if (path === "/api/goals" && method === "POST") { const g = { id: nid("g"), user_id: u.id, archived: 0, ...goalF(body) }; d.goals.push(g); return { goal: goalRow(u, g) }; }
    if ((m = /^\/api\/goals\/contribs\/(\d+)$/.exec(path)) && method === "DELETE") {
      const c = d.contribs.find((x) => x.id === +m[1] && x.user_id === u.id); if (!c) fail("Aportación no encontrada.", 404);
      if (d.contribs.filter((x) => x.goal_id === c.goal_id).reduce((s, x) => s + x.amount, 0) - c.amount < 0) fail("No puedes eliminar esta aportación porque dejaría la meta con saldo negativo.", 409); d.contribs = d.contribs.filter((x) => x !== c); return { ok: true };
    }
    if ((m = /^\/api\/goals\/(\d+)\/contribs$/.exec(path)) && method === "POST") {
      const g = d.goals.find((x) => x.id === +m[1] && x.user_id === u.id); if (!g) fail("Meta no encontrada.", 404); let amt = toCents(body.amount, "amount");
      if (body.kind === "withdraw") { const saved = goalRow(u, g).saved; if (amt > saved) fail(`Solo tienes ${mt(saved)} ahorrados en esta meta.`, 400, "amount"); amt = -amt; }
      const c = { id: nid("gc"), user_id: u.id, goal_id: g.id, date: parseDate(body.date || todayFor(u.timezone), "date"), amount: amt, notes: text(body.notes, "notes", 300) }; d.contribs.push(c); return { ok: true, id: c.id };
    }
    if ((m = /^\/api\/goals\/(\d+)$/.exec(path))) {
      const g = d.goals.find((x) => x.id === +m[1] && x.user_id === u.id); if (!g) fail("Meta no encontrada.", 404);
      if (method === "GET") return { goal: goalRow(u, g), contribs: d.contribs.filter((c) => c.goal_id === g.id).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id)) };
      if (method === "PATCH") { const f = goalF(body, g); if (f.currency !== g.currency && d.contribs.some((c) => c.goal_id === g.id)) fail("No puedes cambiar la moneda de una meta con aportaciones.", 400, "currency"); Object.assign(g, f, { archived: (body.archived ?? g.archived) ? 1 : 0 }); return { goal: goalRow(u, g) }; }
      if (method === "DELETE") { d.goals = d.goals.filter((x) => x !== g); d.contribs = d.contribs.filter((c) => c.goal_id !== g.id); return { ok: true }; }
    }
    // ---- tablas
    if (path === "/api/tables" && method === "GET") return { tables: d.tables.filter((t) => t.user_id === u.id).sort(cmpName).map((t) => ({ id: t.id, name: t.name, columns: t.columns.length, rows: t.rows.length })) };
    if (path === "/api/tables" && method === "POST") { if (d.tables.filter((t) => t.user_id === u.id).length >= 50) fail("Máximo 50 tablas."); const t = { id: nid("tb"), user_id: u.id, name: text(body.name, "name", 80, true), columns: cleanCols(body.columns), rows: [] }; d.tables.push(t); return { table: tablePayload(t) }; }
    if ((m = /^\/api\/tables\/(\d+)\.csv$/.exec(path))) {
      const t = d.tables.find((x) => x.id === +m[1] && x.user_id === u.id); if (!t) fail("Tabla no encontrada.", 404);
      const lines = [t.columns.map((c) => csvSafe(c.name))].concat(t.rows.map((r) => t.columns.map((c) => (c.type === "check" ? (r.data[c.id] ? "Sí" : "") : csvSafe(r.data[c.id] ?? "")))));
      return { __file: true, name: "tabla.csv", data: "﻿" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n" };
    }
    if ((m = /^\/api\/tables\/(\d+)\/rows(?:\/(\d+))?$/.exec(path))) {
      const t = d.tables.find((x) => x.id === +m[1] && x.user_id === u.id); if (!t) fail(m[2] ? "Fila no encontrada." : "Tabla no encontrada.", 404);
      if (method === "POST" && !m[2]) { if (t.rows.length >= 5000) fail("Máximo 5,000 filas por tabla."); const r = { id: nid("tr"), data: cleanRow(t.columns, body.data || {}) }; t.rows.push(r); return { table: tablePayload(t), row_id: r.id }; }
      const r = t.rows.find((x) => x.id === +m[2]); if (!r) fail("Fila no encontrada.", 404);
      if (method === "PUT") { for (const c of t.columns) { if (c.id in (body.data || {})) { const v = cleanCell(body.data[c.id], c.type, c.name); if (v === null) delete r.data[c.id]; else r.data[c.id] = v; } } return { table: tablePayload(t) }; }
      if (method === "DELETE") { t.rows = t.rows.filter((x) => x !== r); return { table: tablePayload(t) }; }
    }
    if ((m = /^\/api\/tables\/(\d+)$/.exec(path))) {
      const t = d.tables.find((x) => x.id === +m[1] && x.user_id === u.id); if (!t) fail("Tabla no encontrada.", 404);
      if (method === "GET") return { table: tablePayload(t) };
      if (method === "PATCH") {
        let cols = t.columns;
        if (body.columns) { const used = new Set(); t.rows.forEach((r) => Object.entries(r.data).forEach(([k, v]) => { if (v !== "" && v !== false && v != null) used.add(k); })); cols = cleanCols(body.columns, t.columns, used);
          const gone = new Set(t.columns.map((c) => c.id).filter((id) => !cols.some((c) => c.id === id))); t.rows.forEach((r) => gone.forEach((g) => delete r.data[g])); }
        t.name = text(body.name ?? t.name, "name", 80, true); t.columns = cols; return { table: tablePayload(t) };
      }
      if (method === "DELETE") { d.tables = d.tables.filter((x) => x !== t); return { ok: true }; }
    }
    // ---- comprobantes (la lectura OCR necesita el servidor)
    if (path === "/api/receipts" && method === "GET") return { receipts: [], ocr_available: false };
    if (path === "/api/receipts" && method === "POST") fail("Los comprobantes con lectura automática (OCR) se guardan en el servidor; no están disponibles en esta vista previa.", 501);
    if (path === "/api/dashboard") { const r = dashboard(u, q), ps = portfolioSummary(u), pv = ps.totals.market_value; r.cards.portfolio_value = pv; r.cards.investments_value += pv; r.cards.net_worth += pv; return r; }
    if (path === "/api/restore") fail("«Cargar mis datos» funciona en tu app con servidor (PythonAnywhere); en esta vista previa no se guardan datos reales.", 501);
    if (path === "/api/demo" && method === "POST") return { ok: true, created: loadDemo(u) };
    if (path === "/api/demo" && method === "DELETE") return { ok: true, deleted: deleteDemo(u) };
    if (path === "/api/transactions.csv") return { __file: true, name: "movimientos.csv", data: csvFor(u, q) };
    if (path === "/api/export.json") {
      const out = { exported_at: new Date().toISOString(), user: userDict(u), accounts: d.accounts.filter((a) => a.user_id === u.id).map((a) => accRow(u.id, a)),
        categories: d.categories.filter((c) => c.user_id === u.id), transactions: queryTx(u.id, {}, false).rows, portfolio_ops: d.ops.filter((o) => o.user_id === u.id).map(opRow) };
      return { __file: true, name: "fipo-datos.json", data: JSON.stringify(out, null, 2) };
    }
    fail("No encontrado.", 404);
  }

  api = async function (method, url, body) {
    const snap = JSON.stringify(db());            // cada petición es atómica, como en el servidor: si falla, nada queda a medias
    try { const r = await handle(method, url, body); if (r && r.__file) return r; save(); return JSON.parse(JSON.stringify(r)); }
    catch (e) {
      mem = JSON.parse(snap);
      if (e instanceof ApiError) { if (e.status === 401 && !url.startsWith("/api/auth/")) onUnauthorized(); throw e; }
      console.error(e); throw new ApiError("Ocurrió un error inesperado. Intenta de nuevo.", 500);
    }
  };

  /* ---------- subida de archivos (lee el CSV en el navegador) ---------- */
  uploadForm = async function (url, fd) {
    const file = fd.get("file"), body = {}; fd.forEach((v, k) => { if (k !== "file") body[k] = v; });
    try { body.file = { name: file.name, text: await file.text() }; return JSON.parse(JSON.stringify(await handle("POST", url, body))); }
    catch (e) { if (e instanceof ApiError) throw e; console.error(e); throw new ApiError("No se pudo leer el archivo.", 500); }
  };

  /* ---------- descargas mediante la capacidad "downloads" del visor ---------- */
  downloadFile = async function (url) {
    try {
      const f = await handle("GET", url, {});
      const dl = await claude.use("downloads");
      if (!dl) return toast("Las descargas no están disponibles en esta vista. Prueba abriendo la página en una pestaña propia.", "error");
      await dl.save({ filename: f.name, data: f.data });
      toast("Archivo listo.");
    } catch (e) {
      if (e && e.code === "declined") return;
      toast((e && e.message) || "No se pudo descargar el archivo.", "error");
    }
  };

  /* ---------- aviso de vista previa ---------- */
  window.fipoPreviewReset = () => { resetAll(); location.hash = "#/login"; location.reload(); };
})();
