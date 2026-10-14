"""Prueba de extremo a extremo con navegador real (requiere playwright + chromium).
Uso: python3 tests/e2e.py http://127.0.0.1:5055 [carpeta_capturas]"""
import os
import re
import sys
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5000"
SHOTS = sys.argv[2] if len(sys.argv) > 2 else "/tmp/shots"
os.makedirs(SHOTS, exist_ok=True)
errors = []


def money_text(page, sel):
    return page.locator(sel).first.inner_text().replace("−", "-")


with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium" if os.path.exists("/opt/pw-browsers/chromium") else None)
    ctx = b.new_context(viewport={"width": 1280, "height": 820}, locale="es-MX")
    page = ctx.new_page()
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    def nav(name):
        bottom = page.locator(".bottom a", has_text=name).first
        if bottom.count() and bottom.is_visible():
            bottom.click(); return
        link = page.locator(".side .nav a", has_text=name).first
        if link.count() and link.is_visible():
            link.click(); return
        for b in page.locator(".side .nav-group-btn").all():
            b.click()
            if link.is_visible():
                break
        link.click()


    # 1. registro + onboarding
    page.goto(BASE)
    expect(page.get_by_role("heading", name="Inicia sesión")).to_be_visible()
    page.get_by_role("link", name="Crear cuenta").click()
    page.fill("#f-name", "Rodrigo Prueba"); page.fill("#f-email", "rodrigo@test.com"); page.fill("#f-password", "clave-segura-1")
    page.get_by_role("button", name="Crear cuenta").click()
    expect(page.get_by_role("heading", name="Configuremos tu espacio")).to_be_visible()
    page.screenshot(path=f"{SHOTS}/1-onboarding.png")
    page.fill('[data-i="0"] [data-k="name"]', "Nómina"); page.fill('[data-i="0"] [data-k="opening_balance"]', "10000")
    page.get_by_role("button", name="Agregar otra cuenta").click()
    page.fill('[data-i="1"] [data-k="name"]', "Efectivo"); page.select_option('[data-i="1"] [data-k="type"]', "cash"); page.fill('[data-i="1"] [data-k="opening_balance"]', "500")
    page.get_by_role("button", name="Comenzar").click()
    expect(page.get_by_role("heading", name="Inicio")).to_be_visible()

    # 2. movimientos: gasto, ingreso, transferencia
    def new_tx(kind, amount, desc, cat=None, to=None, account=None):
        page.get_by_role("button", name="Nuevo movimiento").first.click()
        page.locator(f'.seg button[data-t="{kind}"]').click()
        page.fill("#f-amount", amount)
        if account: page.select_option("#f-account_id", label=f"{account} (MXN)")
        if to: page.select_option("#f-to_account_id", label=f"{to} (MXN)")
        if cat: page.select_option("#f-category_id", label=cat)
        page.fill("#f-description", desc)
        page.get_by_role("button", name="Guardar movimiento").click()
        expect(page.locator(".toast", has_text="Movimiento guardado").first).to_be_visible()

    new_tx("expense", "250.75", "Tacos", cat="Comida", account="Nómina")
    new_tx("income", "3000", "Pago cliente", cat="Ventas", account="Nómina")
    new_tx("transfer", "1000", "Al efectivo", account="Nómina", to="Efectivo")
    page.wait_for_timeout(400)
    page.screenshot(path=f"{SHOTS}/2-dashboard-desktop.png", full_page=True)
    body = page.inner_text("#view")
    assert "$3,000.00" in body, body           # ingresos: la transferencia NO suma
    assert "$250.75" in body, body             # gastos: la transferencia NO suma
    assert "$13,249.25" in body, body          # total = 10000+500-250.75+3000 (transferir no cambia el total)

    nav("Cuentas")
    expect(page.locator("article.acc").first).to_be_visible()
    txt = page.inner_text("#view")
    assert "$11,749.25" in txt and "$1,500.00" in txt, txt   # Nómina y Efectivo
    page.screenshot(path=f"{SHOTS}/3-accounts.png")
    page.locator("article.acc", has_text="Nómina").click()
    expect(page.locator("svg.chart")).to_be_visible()
    page.screenshot(path=f"{SHOTS}/4-account-detail.png", full_page=True)

    # 3. movimientos: buscar, editar, eliminar
    nav("Movimientos")
    expect(page.locator(".tx-row")).to_have_count(3)
    page.fill("#m-q", "tacos"); expect(page.locator(".tx-row")).to_have_count(1)
    page.locator(".tx-row").first.click()
    page.get_by_role("button", name="Editar").click()
    page.fill("#f-amount", "300"); page.get_by_role("button", name="Guardar cambios").click()
    expect(page.locator(".toast", has_text="Movimiento actualizado").first).to_be_visible()
    nav("Cuentas")
    expect(page.locator("article.acc", has_text="Nómina")).to_contain_text("$11,700.00")
    nav("Movimientos")
    page.fill("#m-q", "tacos"); page.locator(".tx-row").first.click()
    page.get_by_role("button", name="Eliminar").click(); page.get_by_role("button", name="Eliminar").last.click()
    expect(page.locator(".toast", has_text="Movimiento eliminado").first).to_be_visible()
    nav("Cuentas")
    expect(page.locator("article.acc", has_text="Nómina")).to_contain_text("$12,000.00")   # 10000+3000-1000

    # 4. validación en formulario
    page.get_by_role("button", name="Nuevo movimiento").first.click()
    page.get_by_role("button", name="Guardar movimiento").click()
    expect(page.locator(".field.err .msg")).to_be_visible()
    page.keyboard.press("Escape")

    # 5. persistencia: recargar, cerrar sesión, volver a entrar
    page.reload(); expect(page.get_by_role("heading", name="Cuentas")).to_be_visible()
    page.get_by_role("link", name="Cerrar sesión").click()
    expect(page.get_by_role("heading", name="Inicia sesión")).to_be_visible()
    page.fill("#f-email", "rodrigo@test.com"); page.fill("#f-password", "clave-segura-1"); page.get_by_role("button", name="Entrar").click()
    expect(page.get_by_role("heading", name="Inicio")).to_be_visible()
    nav("Cuentas")
    expect(page.locator("article.acc", has_text="Nómina")).to_contain_text("$12,000.00")

    # 6. privacidad y tema
    nav("Inicio")
    page.click("#privacy"); expect(page.locator("#view")).to_contain_text("•••••")
    page.click("#privacy")

    # 7. demo en usuario nuevo + capturas (escritorio, oscuro, móvil)
    page.get_by_role("link", name="Cerrar sesión").click()
    page.get_by_role("link", name="Crear cuenta").click()
    page.fill("#f-name", "Demo"); page.fill("#f-email", "demo@test.com"); page.fill("#f-password", "clave-segura-2")
    page.get_by_role("button", name="Crear cuenta").click()
    page.get_by_role("button", name="Comenzar").click()
    page.get_by_role("link", name="Cargar datos de demostración").click()
    expect(page.locator(".stat").first).to_be_visible(); page.wait_for_timeout(500)
    page.screenshot(path=f"{SHOTS}/5-demo-dashboard.png", full_page=True)
    page.click("#theme"); page.wait_for_timeout(400)
    page.screenshot(path=f"{SHOTS}/6-dark.png", full_page=True)
    page.set_viewport_size({"width": 390, "height": 844}); page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOTS}/7-mobile-dark.png")
    page.click("#theme"); page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOTS}/8-mobile-light.png", full_page=True)
    page.locator("#new-tx-m").click()
    expect(page.locator(".modal")).to_be_visible(); page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOTS}/9-mobile-modal.png")
    page.keyboard.press("Escape")
    nav("Movimientos"); page.wait_for_timeout(500)
    page.screenshot(path=f"{SHOTS}/10-mobile-movements.png")
    b.close()

real = [e for e in errors if "Failed to load resource" not in e]  # 401/400 HTTP esperados (sin sesión, validación)
print("ERRORES DE CONSOLA:", real)
assert not real
print("E2E OK")
