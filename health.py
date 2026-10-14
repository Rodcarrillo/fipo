"""Puntaje de salud financiera de FIPO: cercanía a la distribución objetivo.

Mide qué tan parecida es tu distribución real de ingresos a la objetivo.
Penaliza solo el lado malo (gastar más de lo objetivo en Vida; ahorrar o invertir
menos) y da puntos extra por el lado bueno (gastar menos en Vida; ahorrar o
invertir más), en proporción a cuánto te alejas del objetivo:
    50% Vida / Gastos, 25% Ahorro, 25% Inversión.

Para cambiar los objetivos basta editar TARGETS (los porcentajes deben sumar 100);
la lógica de cálculo no se toca.
"""

# ── Configuración (editable sin tocar la lógica) ────────────────────────────
TARGETS = {
    "living": 50.0,       # Vida / Gastos
    "savings": 25.0,      # Ahorro
    "investments": 25.0,  # Inversión
}
MAX_SCORE = 100.0
# Dirección favorable de cada categoría:
#   "max" = tope (pasarte es malo, quedarte abajo es un plus)  -> Vida / Gastos
#   "min" = piso (quedarte abajo es malo, pasarte es un plus)  -> Ahorro, Inversión
DIRECTION = {"living": "max", "savings": "min", "investments": "min"}
# Qué tan rápido crece el plus frente a la penalización (1.0 = mismo ritmo).
BONUS_RATE = 1.0
# Tope del puntaje total con puntos extra (None = sin tope).
MAX_TOTAL = 120
# Cada categoría vale lo mismo: 100 / 3 = 33.33 puntos.
CATEGORY_POINTS = MAX_SCORE / len(TARGETS)

LABELS = {"living": "Vida / Gastos", "savings": "Ahorro", "investments": "Inversión"}


def split_from_totals(income, expenses, invested):
    """Arma las 3 cantidades a partir de los totales del mes.

    Vida = gastos; Inversión = lo aportado al portafolio; Ahorro = lo que sobra
    (ingreso − gastos − inversión). Si gastas más de lo que ingresas, el ahorro
    sale negativo y simplemente puntúa 0.
    """
    return {
        "living": expenses,
        "savings": income - expenses - invested,
        "investments": invested,
    }


def distribution_score(income, amounts, targets=None):
    """Devuelve {'score_100', 'score_10', 'breakdown'}.

    income   -- ingreso mensual total (la base de los porcentajes)
    amounts  -- dict con 'living', 'savings', 'investments' (montos)
    targets  -- opcional, para sobrescribir TARGETS
    """
    targets = targets or TARGETS
    if income is None or income <= 0:
        return {
            "score_100": 0,
            "score_10": 0.0,
            "breakdown": {
                k: {"label": LABELS[k], "target_pct": t, "actual_pct": None,
                    "difference": None, "points": 0.0}
                for k, t in targets.items()
            },
            "note": "Sin ingresos en el periodo: no se puede calcular.",
        }

    breakdown, total = {}, 0.0
    for key, target in targets.items():
        actual = amounts.get(key, 0) / income * 100          # % real
        diff = abs(actual - target)                           # distancia al objetivo
        gap = (actual - target) if DIRECTION[key] == "min" else (target - actual)
        if gap >= 0:   # lado favorable: plus proporcional a cuánto te pasaste
            points = CATEGORY_POINTS * (1 + BONUS_RATE * gap / target)
        else:          # lado desfavorable: penalización
            points = max(0.0, CATEGORY_POINTS * (1 - diff / target))
        breakdown[key] = {
            "label": LABELS.get(key, key),
            "target_pct": target,
            "actual_pct": round(actual, 2),
            "difference": round(diff, 2),
            "bonus": gap > 0,
            "points": round(points, 2),
        }
        total += points

    if MAX_TOTAL is not None:
        total = min(total, MAX_TOTAL)
    score_100 = int(round(total))
    return {
        "score_100": score_100,
        "score_10": round(score_100 / 10, 1),
        "breakdown": breakdown,
    }


def from_monthly(monthly, invested_by_month, saved_by_month=None):
    """Puntaje a partir de los meses de Análisis. Usa el mes en curso; si todavía no tiene ingresos
    (p. ej. el día 1, antes de que llegue tu sueldo), usa el último mes que sí los tenga.
    Devuelve None si ningún mes tiene ingresos."""
    for x in reversed(monthly):
        if x["income"] > 0:
            inv = invested_by_month.get(x["key"], 0)
            if saved_by_month is None:               # sin cuentas de ahorro: el ahorro es lo que sobra
                amounts = split_from_totals(x["income"], x["expense"], inv)
            else:                                    # con cuentas de ahorro: lo que les transferiste ese mes
                amounts = {"living": x["expense"], "savings": saved_by_month.get(x["key"], 0), "investments": inv}
            r = distribution_score(x["income"], amounts)
            r.update({"month": x["key"], "is_current_month": x is monthly[-1], "amounts": amounts})
            return r
    return None
