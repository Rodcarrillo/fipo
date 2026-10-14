import unittest
from health import distribution_score, split_from_totals


def score(l, s, i, income=100):
    return distribution_score(income, {"living": l, "savings": s, "investments": i})


class TestScore(unittest.TestCase):
    def test_perfect(self):
        self.assertEqual(score(50, 25, 25)["score_100"], 100)

    def test_ejemplo_60_20_20(self):
        r = score(60, 20, 20)
        self.assertEqual(r["score_100"], 80)          # 3 × 26.67
        self.assertEqual(r["score_10"], 8.0)

    def test_ahorro_tabla_del_usuario(self):
        # Solo cambia el ahorro; los otros dos en su objetivo (66.67 pts)
        for actual, pts in [(25, 33.33), (20, 26.67), (15, 20.0), (10, 13.33), (0, 0)]:
            r = score(50, actual, 25)
            self.assertAlmostEqual(r["breakdown"]["savings"]["points"], pts, places=2)

    def test_plus_ahorro(self):
        # 35% de ahorro: +10 sobre 25 => +40% de 33.33
        self.assertAlmostEqual(score(50, 35, 25)["breakdown"]["savings"]["points"], 46.67, places=2)
        self.assertGreater(score(50, 35, 25)["score_100"], 100)

    def test_plus_vida_menor(self):
        # 30% en vida: 20 bajo el objetivo => +40%
        self.assertAlmostEqual(score(30, 25, 25)["breakdown"]["living"]["points"], 46.67, places=2)

    def test_vida_mayor_penaliza(self):
        self.assertAlmostEqual(score(70, 25, 25)["breakdown"]["living"]["points"], 20.0, places=2)

    def test_menos_ahorro_penaliza(self):
        self.assertAlmostEqual(score(50, 15, 25)["breakdown"]["savings"]["points"], 20.0, places=2)

    def test_tope_total(self):
        self.assertEqual(score(0, 100, 100)["score_100"], 120)

    def test_no_negativos(self):
        r = score(150, -50, 0)
        for c in r["breakdown"].values():
            self.assertGreaterEqual(c["points"], 0)
        self.assertEqual(r["score_100"], 0)

    def test_sin_ingresos(self):
        self.assertEqual(distribution_score(0, {})["score_100"], 0)

    def test_objetivos_configurables(self):
        t = {"living": 60.0, "savings": 20.0, "investments": 20.0}
        r = distribution_score(100, {"living": 60, "savings": 20, "investments": 20}, t)
        self.assertEqual(r["score_100"], 100)

    def test_split_from_totals(self):
        a = split_from_totals(income=1000, expenses=500, invested=250)
        self.assertEqual(a, {"living": 500, "savings": 250, "investments": 250})
        self.assertEqual(distribution_score(1000, a)["score_100"], 100)


if __name__ == "__main__":
    unittest.main(verbosity=2)
