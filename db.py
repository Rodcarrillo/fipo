"""Capa de base de datos (SQLite). Los importes se guardan en centavos (enteros)."""
import os
import sqlite3
from flask import g, current_app

SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    currency      TEXT NOT NULL DEFAULT 'MXN',
    timezone      TEXT NOT NULL DEFAULT 'America/Mexico_City',
    theme         TEXT NOT NULL DEFAULT 'light',
    onboarded     INTEGER NOT NULL DEFAULT 0,
    notify_email  INTEGER NOT NULL DEFAULT 0,
    session_ver   INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS password_resets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS login_attempts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    key        TEXT NOT NULL,
    at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(key, at);

CREATE TABLE IF NOT EXISTS accounts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    institution         TEXT NOT NULL DEFAULT '',
    type                TEXT NOT NULL DEFAULT 'bank',
    currency            TEXT NOT NULL DEFAULT 'MXN',
    opening_balance     INTEGER NOT NULL DEFAULT 0,
    opened_on           TEXT NOT NULL,
    low_balance_alert   INTEGER NOT NULL DEFAULT 0,
    archived            INTEGER NOT NULL DEFAULT 0,
    is_demo             INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);

CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('expense','income')),
    parent_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    archived   INTEGER NOT NULL DEFAULT 0,
    is_demo    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(user_id);

CREATE TABLE IF NOT EXISTS imports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    filename   TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL DEFAULT '',
    row_count  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Un solo registro maestro. amount siempre es > 0 salvo en 'adjustment' (con signo).
-- transfer: account_id = origen, to_account_id = destino, to_amount = importe recibido.
CREATE TABLE IF NOT EXISTS transactions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type          TEXT NOT NULL CHECK (type IN ('expense','income','transfer','refund','adjustment')),
    amount        INTEGER NOT NULL,
    to_amount     INTEGER,
    date          TEXT NOT NULL,
    account_id    INTEGER NOT NULL REFERENCES accounts(id),
    to_account_id INTEGER REFERENCES accounts(id),
    category_id   INTEGER REFERENCES categories(id),
    description   TEXT NOT NULL DEFAULT '',
    payment_method TEXT NOT NULL DEFAULT '',
    tags          TEXT NOT NULL DEFAULT '',
    notes         TEXT NOT NULL DEFAULT '',
    recurring     INTEGER NOT NULL DEFAULT 0,
    is_demo       INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    import_id     INTEGER REFERENCES imports(id)
);
CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, date);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_tx_to_account ON transactions(to_account_id);
CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category_id);

-- Portafolio: operaciones del usuario. quantity y price son decimales exactos en texto;
-- gross y fee son centavos enteros (gross = cantidad x precio redondeado; en dividendos, el monto).
CREATE TABLE IF NOT EXISTS holding_ops (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol     TEXT NOT NULL,
    name       TEXT NOT NULL DEFAULT '',
    asset_type TEXT NOT NULL DEFAULT 'stock',
    kind       TEXT NOT NULL CHECK (kind IN ('buy','sell','dividend','interest')),
    quantity   TEXT NOT NULL DEFAULT '0',
    price      TEXT NOT NULL DEFAULT '0',
    gross      INTEGER NOT NULL DEFAULT 0,
    fee        INTEGER NOT NULL DEFAULT 0,
    currency   TEXT NOT NULL,
    date       TEXT NOT NULL,
    account_id INTEGER REFERENCES accounts(id),
    notes      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hops_user ON holding_ops(user_id, symbol, date);
CREATE INDEX IF NOT EXISTS idx_hops_account ON holding_ops(account_id);

-- Cotizaciones de mercado (datos públicos, compartidos entre usuarios). source: 'yahoo' o 'manual'.
CREATE TABLE IF NOT EXISTS quotes (
    symbol       TEXT PRIMARY KEY,
    name         TEXT NOT NULL DEFAULT '',
    currency     TEXT NOT NULL DEFAULT '',
    exchange     TEXT NOT NULL DEFAULT '',
    price        REAL,
    prev_close   REAL,
    source       TEXT NOT NULL DEFAULT 'yahoo',
    price_time   TEXT,
    updated_at   TEXT,
    last_attempt TEXT,
    last_error   TEXT NOT NULL DEFAULT ''
);
-- Precios objetivo por símbolo. lower_hit/upper_hit: ya se avisó; se rearman cuando el precio vuelve al rango.
CREATE TABLE IF NOT EXISTS price_alerts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol     TEXT NOT NULL,
    lower      REAL,
    upper      REAL,
    active     INTEGER NOT NULL DEFAULT 1,
    lower_hit  INTEGER NOT NULL DEFAULT 0,
    upper_hit  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, symbol)
);
-- Vigilancia manual de acciones (no hace falta tenerlas en el portafolio): símbolo, fecha del próximo
-- reporte trimestral y tus propios precios de entrada/salida. Tú los escribes y los actualizas a mano.
CREATE TABLE IF NOT EXISTS watchlist (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol      TEXT NOT NULL,
    company     TEXT NOT NULL DEFAULT '',
    report_date TEXT,
    entry_price REAL,
    exit_price  REAL,
    notes       TEXT NOT NULL DEFAULT '',
    is_demo     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, symbol)
);
-- Centro de notificaciones dentro de la app. dedupe_key evita avisos repetidos.
CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    link       TEXT NOT NULL DEFAULT '',
    dedupe_key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    read_at    TEXT,
    dismissed  INTEGER NOT NULL DEFAULT 0,   -- «borrado»: se conserva la clave para que no reaparezca
    UNIQUE(user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);
CREATE TABLE IF NOT EXISTS quote_history (
    symbol     TEXT NOT NULL,
    range      TEXT NOT NULL,
    points     TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (symbol, range)
);

-- Fase 2: deudas y pagos (el pago puede ligarse a una cuenta y restarle efectivo; no cuenta como gasto)
CREATE TABLE IF NOT EXISTS debts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    creditor        TEXT NOT NULL DEFAULT '',
    currency        TEXT NOT NULL DEFAULT 'MXN',
    principal       INTEGER NOT NULL,
    interest_rate   REAL NOT NULL DEFAULT 0,
    start_date      TEXT NOT NULL,
    monthly_payment INTEGER NOT NULL DEFAULT 0,
    due_day         INTEGER NOT NULL DEFAULT 0,
    notes           TEXT NOT NULL DEFAULT '',
    archived        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS debt_payments (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    debt_id        INTEGER NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
    date           TEXT NOT NULL,
    principal_part INTEGER NOT NULL DEFAULT 0,
    interest_part  INTEGER NOT NULL DEFAULT 0,
    account_id     INTEGER REFERENCES accounts(id),
    notes          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_debtpay_debt ON debt_payments(debt_id);
CREATE INDEX IF NOT EXISTS idx_debtpay_account ON debt_payments(account_id);

-- Presupuestos mensuales por categoría (category_id 0 = presupuesto total del mes)
CREATE TABLE IF NOT EXISTS budgets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL DEFAULT 0,
    amount      INTEGER NOT NULL,
    UNIQUE (user_id, category_id)
);

-- Fase 3: metas de ahorro (apartados virtuales: no mueven saldos de cuentas)
CREATE TABLE IF NOT EXISTS goals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    target      INTEGER NOT NULL,
    target_date TEXT,
    currency    TEXT NOT NULL DEFAULT 'MXN',
    notes       TEXT NOT NULL DEFAULT '',
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS goal_contribs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    date    TEXT NOT NULL,
    amount  INTEGER NOT NULL,
    notes   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_goalc_goal ON goal_contribs(goal_id);

-- Tablas personalizadas tipo hoja de cálculo
CREATE TABLE IF NOT EXISTS custom_tables (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    columns    TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS custom_rows (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    table_id INTEGER NOT NULL REFERENCES custom_tables(id) ON DELETE CASCADE,
    data     TEXT NOT NULL DEFAULT '{}',
    position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_crow_table ON custom_rows(table_id);

-- Comprobantes (imagen guardada en disco + texto leído por OCR); tx_id se llena al ligarlo a un movimiento
CREATE TABLE IF NOT EXISTS receipts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tx_id      INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
    filename   TEXT NOT NULL DEFAULT '',
    mime       TEXT NOT NULL,
    path       TEXT NOT NULL,
    size       INTEGER NOT NULL DEFAULT 0,
    ocr_text   TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_receipts_tx ON receipts(tx_id);

-- Planes a meses de una tarjeta de crédito (MSI, meses con intereses, saldo diferido).
-- El capital del plan YA está dentro del saldo de la tarjeta (por el saldo inicial o por la compra ligada en
-- transaction_id); el plan solo indica qué parte NO se cobra todavía en el estado de cuenta.
-- Al registrarse (start_date) le faltan months_remaining mensualidades y principal_remaining de capital;
-- se cobra una mensualidad en cada fecha de corte posterior a start_date.
CREATE TABLE IF NOT EXISTS card_plans (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id          INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind                TEXT NOT NULL CHECK (kind IN ('msi','mci','diferido')),
    description         TEXT NOT NULL DEFAULT '',
    monthly_amount      INTEGER NOT NULL,           -- mensualidad que cobra el banco (con intereses si aplica)
    months_total        INTEGER NOT NULL,
    months_remaining    INTEGER NOT NULL,           -- mensualidades pendientes al registrarlo
    principal_remaining INTEGER NOT NULL,           -- capital pendiente al registrarlo
    interest_rate       REAL NOT NULL DEFAULT 0,    -- tasa anual informativa (%)
    start_date          TEXT NOT NULL,
    transaction_id      INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
    is_demo             INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_plans_account ON card_plans(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_tx ON card_plans(transaction_id) WHERE transaction_id IS NOT NULL;

-- Intereses ya registrados de un plan con intereses (uno por corte): evita registrarlos dos veces.
CREATE TABLE IF NOT EXISTS card_plan_charges (
    plan_id        INTEGER NOT NULL REFERENCES card_plans(id) ON DELETE CASCADE,
    cut_date       TEXT NOT NULL,
    transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
    PRIMARY KEY (plan_id, cut_date)
);

-- Cargos recurrentes (suscripciones, teléfono, gimnasio…): FIPO registra el gasto solo al llegar next_date.
CREATE TABLE IF NOT EXISTS recurring (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    description TEXT NOT NULL,
    amount      INTEGER NOT NULL,
    frequency   TEXT NOT NULL CHECK (frequency IN ('weekly','monthly','yearly')),
    anchor_day  INTEGER NOT NULL DEFAULT 1,         -- día del mes original (para que un 31 no se vuelva 28 para siempre)
    next_date   TEXT NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    is_demo     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recurring_user ON recurring(user_id, active, next_date);
-- Avisos push (Web Push): un renglón por dispositivo donde el usuario activó los avisos.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    subject     TEXT NOT NULL DEFAULT '',
    device      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_ok     TEXT,
    failures    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
-- Widgets: diseño por usuario y enlace de solo lectura (token guardado con hash) para widgets nativos de iPhone.
CREATE TABLE IF NOT EXISTS widget_prefs (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data       TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS widget_tokens (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Datos sueltos del servidor (p. ej. cuándo corrió la revisión automática).
CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def get_db():
    if "db" not in g:
        conn = sqlite3.connect(current_app.config["DATABASE"], isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        g.db = conn
    return g.db


def close_db(_exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db(path):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(transactions)")]
    if "import_id" not in cols:                       # bases creadas antes de la importación de estados
        conn.execute("ALTER TABLE transactions ADD COLUMN import_id INTEGER REFERENCES imports(id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_tx_import ON transactions(import_id)")
    ucols = [r[1] for r in conn.execute("PRAGMA table_info(users)")]
    if "notify_email" not in ucols:                   # avisos por correo (opcional)
        conn.execute("ALTER TABLE users ADD COLUMN notify_email INTEGER NOT NULL DEFAULT 0")
    acols = [r[1] for r in conn.execute("PRAGMA table_info(accounts)")]
    for col in ("credit_limit", "cut_day", "due_day"):   # tarjetas de crédito
        if col not in acols:
            conn.execute(f"ALTER TABLE accounts ADD COLUMN {col} INTEGER NOT NULL DEFAULT 0")
    for tbl in ("debts", "goals", "holding_ops"):        # para poder identificar y borrar los datos de demostración
        cols = [r[1] for r in conn.execute(f"PRAGMA table_info({tbl})")]
        if "is_demo" not in cols:
            conn.execute(f"ALTER TABLE {tbl} ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0")
    conn.commit()
    conn.close()


class atomic:
    """Contexto de transacción atómica: todo o nada."""

    def __init__(self, db):
        self.db = db

    def __enter__(self):
        self.db.execute("BEGIN IMMEDIATE")
        return self.db

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            self.db.execute("COMMIT")
        else:
            self.db.execute("ROLLBACK")
        return False
