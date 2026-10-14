"""E2E de importación y portafolio con navegador real. Yahoo NO es alcanzable desde el sandbox: se prueba la ruta sin precio/manual/enlace."""
import os, sys, tempfile
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1]; SHOTS = sys.argv[2] if len(sys.argv) > 2 else "/tmp/shots2"
os.makedirs(SHOTS, exist_ok=True); errors = []
csvp = os.path.join(tempfile.mkdtemp(), "estado.csv")
open(csvp, "w", encoding="utf-8").write("Fecha,Descripción,Cargo,Abono,Saldo\n05/09/2026,OXXO CENTRO,120.50,,879.50\n06/09/2026,NOMINA EMPRESA,,5000.00,5879.50\n07/09/2026,SUPER WALMART,\"1,234.10\",,4645.40\n")

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium")
    page = b.new_context(viewport={"width": 1280, "height": 820}, locale="es-MX").new_page()
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

    page.goto(BASE); page.get_by_role("link", name="Crear cuenta").click()
    page.fill("#f-name", "Rodrigo"); page.fill("#f-email", "r@test.com"); page.fill("#f-password", "clave-segura-1")
    page.get_by_role("button", name="Crear cuenta").click()
    page.fill('[data-i="0"] [data-k="name"]', "Banco"); page.fill('[data-i="0"] [data-k="opening_balance"]', "1000")
    page.get_by_role("button", name="Comenzar").click()
    expect(page.get_by_role("heading", name="Inicio")).to_be_visible()
    page.screenshot(path=f"{SHOTS}/a-inicio-logo.png")

    # flecha de contraer: gira al cerrar
    t0 = page.locator("#collapse svg").evaluate("e => getComputedStyle(e).transform")
    page.click("#collapse"); page.wait_for_timeout(500)
    t1 = page.locator("#collapse svg").evaluate("e => getComputedStyle(e).transform")
    assert t0 != t1, (t0, t1)
    page.screenshot(path=f"{SHOTS}/b-colapsado.png")
    page.click("#collapse"); page.wait_for_timeout(300)
    assert page.locator("#collapse svg").evaluate("e => getComputedStyle(e).transform") == t0

    # importar desde la cuenta
    nav("Cuentas"); page.locator("[data-acc]").first.click()
    page.get_by_role("button", name="Importar estado de cuenta").click()
    page.set_input_files("#f-file", csvp); page.get_by_role("button", name="Leer archivo").click()
    expect(page.locator("table.imp tbody tr")).to_have_count(3)
    page.screenshot(path=f"{SHOTS}/c-import-revision.png")
    page.locator("table.imp tbody tr").nth(0).locator(".ck").uncheck()   # quito el OXXO
    page.get_by_role("button", name="Guardar movimientos").click()
    expect(page.locator(".toast", has_text="Se importaron 2").first).to_be_visible()
    expect(page.locator("#view")).to_contain_text("4,765.90")   # 1000 + 5000 - 1234.10

    # portafolio (Yahoo inalcanzable aquí -> sin precio, gráfica con enlace)
    nav("Portafolio")
    expect(page.get_by_role("heading", name="Tu portafolio está vacío")).to_be_visible()
    page.get_by_role("button", name="Registrar una operación").click()
    page.fill("#f-symbol", "aapl"); page.fill("#f-quantity", "10"); page.fill("#f-price", "100"); page.fill("#f-fee", "10")
    page.select_option("#f-account_id", index=1)
    page.get_by_role("button", name="Guardar").click()
    expect(page.locator(".toast", has_text="Operación guardada").first).to_be_visible()
    expect(page.locator("#view")).to_contain_text("AAPL"); expect(page.locator("#view")).to_contain_text("Sin precio")
    page.screenshot(path=f"{SHOTS}/d-portafolio-sin-precio.png")
    page.locator("[data-sym]").first.click()
    expect(page.get_by_role("link", name="Ver gráfica en Yahoo Finance")).to_be_visible(timeout=15000)
    page.get_by_role("button", name="Fijar precio manual").click()
    page.fill("#f-price", "120"); page.get_by_role("button", name="Guardar").last.click()
    expect(page.locator("#view")).to_contain_text("1,200.00")   # 10 x 120
    page.screenshot(path=f"{SHOTS}/e-portafolio-detalle.png", full_page=True)
    nav("Cuentas"); page.locator("[data-acc]").first.click()
    expect(page.locator("#view")).to_contain_text("3,755.90")   # 4765.90 - 1000 - 10 (comisión)
    nav("Inicio")
    expect(page.locator(".stat").first).to_be_visible(); page.screenshot(path=f"{SHOTS}/f-inicio.png", full_page=True)
    page.set_viewport_size({"width": 390, "height": 844}); page.locator(".bottom a", has_text="Más").click(); page.locator("a.more-item", has_text="Portafolio").click(); page.wait_for_timeout(600)
    page.screenshot(path=f"{SHOTS}/g-movil-portafolio.png")
    b.close()
real = [e for e in errors if "Failed to load resource" not in e]
print("ERRORES:", real); assert not real; print("E2E2 OK")
