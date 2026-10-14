"""E2E de fases 2 y 3 con navegador real. Uso: python3 tests/e2e_phases.py URL [carpeta_capturas]"""
import io, os, sys, tempfile
from playwright.sync_api import sync_playwright, expect
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

BASE = sys.argv[1]; SHOTS = sys.argv[2] if len(sys.argv) > 2 else "/tmp/shots4"
os.makedirs(SHOTS, exist_ok=True); errors = []
PREVIEW = "preview" in BASE
rc = os.path.join(tempfile.mkdtemp(), "ticket.png")
from PIL import Image, ImageDraw, ImageFont
im = Image.new("RGB", (700, 500), "white"); d = ImageDraw.Draw(im)
f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 34)
for i, line in enumerate(["SUPER MERCADO LUNA", "Fecha: 12/09/2026", "Leche 2 x 25.00", "Pan 18.50", "IVA 5.00", "TOTAL $ 123.45"]):
    d.text((30, 30 + i * 70), line, fill="black", font=f)
im.save(rc)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium")
    page = b.new_context(viewport={"width": 1280, "height": 860}, locale="es-MX").new_page()
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    toast = lambda t: expect(page.locator(".toast", has_text=t).first).to_be_visible()
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
    page.fill('[data-i="0"] [data-k="name"]', "Banco"); page.fill('[data-i="0"] [data-k="opening_balance"]', "10000")
    page.get_by_role("button", name="Comenzar").click(); expect(page.get_by_role("heading", name="Inicio")).to_be_visible()

    # --- tarjeta: crear, comprar, pagar
    nav("Tarjetas"); page.get_by_role("button", name="Agregar tarjeta").click()
    page.fill("#f-name", "Visa"); expect(page.locator("#f-type")).to_have_value("credit")
    page.fill("#f-credit_limit", "5000"); page.fill("#f-cut_day", "10"); page.fill("#f-due_day", "25")
    page.get_by_role("button", name="Crear cuenta").click(); toast("Cuenta creada")
    nav("Tarjetas"); page.get_by_role("button", name="Registrar compra").click()
    page.fill("#f-amount", "1200"); page.fill("#f-description", "Laptop"); page.get_by_role("button", name="Guardar movimiento").click(); toast("Movimiento guardado")
    nav("Tarjetas"); expect(page.locator("#view")).to_contain_text("1,200.00"); expect(page.locator("#view")).to_contain_text("24%")
    page.get_by_role("button", name="Pagar tarjeta").click(); page.fill("#f-amount", "700"); page.get_by_role("button", name="Registrar pago").click(); toast("Pago registrado")
    expect(page.locator("#view")).to_contain_text("500.00"); page.screenshot(path=f"{SHOTS}/a-tarjetas.png")
    nav("Inicio"); expect(page.locator(".stat", has_text="Deuda en tarjetas")).to_contain_text("500.00")
    expect(page.locator(".stat", has_text="Gastos").first).to_contain_text("1,200.00")   # el pago no duplicó el gasto

    # --- deuda
    nav("Deudas"); page.get_by_role("button", name="Registrar deuda").click()
    page.fill("#f-name", "Préstamo coche"); page.fill("#f-principal", "6000"); page.fill("#f-monthly_payment", "500"); page.get_by_role("button", name="Crear deuda").click()
    expect(page.locator(".topbar h1")).to_contain_text("Préstamo coche"); page.get_by_role("button", name="Registrar pago").click()
    page.fill("#f-amount", "500"); page.fill("#f-interest", "50"); page.select_option("#f-account_id", index=1); page.get_by_role("button", name="Registrar").last.click(); toast("Pago registrado")
    expect(page.locator("#view")).to_contain_text("5,550.00"); page.screenshot(path=f"{SHOTS}/b-deuda.png")

    # --- presupuesto
    nav("Presupuestos"); page.get_by_role("button", name="Crear presupuesto").click(); page.select_option("#f-category_id", index=0); page.fill("#f-amount", "1000"); page.get_by_role("button", name="Guardar").click(); toast("Presupuesto guardado")
    expect(page.locator("#view")).to_contain_text("120%"); expect(page.locator("#view")).to_contain_text("excedido"); page.screenshot(path=f"{SHOTS}/c-presupuesto.png")

    # --- meta
    nav("Metas"); page.get_by_role("button", name="Crear meta").click(); page.fill("#f-name", "Viaje"); page.fill("#f-target", "2000"); page.get_by_role("button", name="Crear meta").last.click()
    page.get_by_role("button", name="Aportar").click(); page.fill("#f-amount", "500"); page.get_by_role("button", name="Guardar").last.click(); toast("Registrado")
    expect(page.locator("#view")).to_contain_text("25%")

    # --- tabla
    nav("Tablas"); page.get_by_role("button", name="Crear tabla").click(); page.fill("#f-name", "Suscripciones")
    page.locator(".col-row .cn").nth(0).fill("Servicio"); page.locator(".col-row .cn").nth(1).fill("Costo"); page.get_by_role("button", name="Crear tabla").last.click()
    page.get_by_role("button", name="Fila").click(); page.locator("tbody tr").first.locator("input").nth(0).fill("Netflix"); page.locator("tbody tr").first.locator("input").nth(1).fill("199"); page.locator("tbody tr").first.locator("input").nth(1).blur()
    page.wait_for_timeout(600); expect(page.locator("td.tot").nth(1)).to_contain_text("199.00"); page.screenshot(path=f"{SHOTS}/d-tabla.png")

    # --- análisis y reportes
    nav("Análisis"); expect(page.locator("#view")).to_contain_text("Proyección del mes"); page.screenshot(path=f"{SHOTS}/e-analisis.png", full_page=True)
    nav("Reportes"); expect(page.locator("#view")).to_contain_text("Balance neto"); page.screenshot(path=f"{SHOTS}/f-reportes.png")

    # --- comprobante
    if not PREVIEW:
        nav("Comprobantes"); page.set_input_files("#rc-file", rc)
        expect(page.locator("#rc-out")).to_contain_text("123.45", timeout=60000); page.screenshot(path=f"{SHOTS}/g-comprobante.png")
        page.get_by_role("button", name="Revisar y confirmar").first.click()
        expect(page.locator("#f-amount")).to_have_value("123.45")
        expect(page.locator("#f-description")).to_have_value("SUPER MERCADO LUNA")           # el comercio leído entra listo para confirmar
        page.get_by_role("button", name="Confirmar y guardar").click(); toast("Movimiento guardado a partir del comprobante")
        nav("Comprobantes"); page.locator(".tabs button", has_text="Todos").click(); expect(page.locator("#rc-list")).to_contain_text("ligado a un movimiento")
        nav("Movimientos"); page.get_by_text("SUPER MERCADO LUNA").first.click(); expect(page.locator(".modal img.rc-thumb")).to_be_visible(); page.screenshot(path=f"{SHOTS}/h-tx-comprobante.png")
        page.keyboard.press("Escape")

    # --- móvil
    page.set_viewport_size({"width": 390, "height": 844}); page.locator(".bottom a", has_text="Más").click(); page.wait_for_timeout(400)
    expect(page.locator("#view")).to_contain_text("Tarjetas"); page.screenshot(path=f"{SHOTS}/i-movil-mas.png")
    b.close()
real = [e for e in errors if "Failed to load resource" not in e]
print("ERRORES:", real); assert not real; print("E2E FASES OK")
