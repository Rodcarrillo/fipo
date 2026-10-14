"""E2E de avisos (tarjeta + precios objetivo). Uso: python3 tests/e2e_notify.py URL [carpeta_capturas]"""
import os, sys, datetime
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1]; SHOTS = sys.argv[2] if len(sys.argv) > 2 else "/tmp/shots5"
os.makedirs(SHOTS, exist_ok=True); errors = []
due = (datetime.date.today() + datetime.timedelta(days=2)).day

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

    bell_n = lambda: page.locator("#bell-n")

    page.goto(BASE); page.get_by_role("link", name="Crear cuenta").click()
    page.fill("#f-name", "Rodrigo"); page.fill("#f-email", "n@test.com"); page.fill("#f-password", "clave-segura-1")
    page.get_by_role("button", name="Crear cuenta").click()
    page.fill('[data-i="0"] [data-k="name"]', "Broker"); page.select_option('[data-i="0"] [data-k="type"]', "investment")
    page.fill('[data-i="0"] [data-k="opening_balance"]', "10000")
    page.get_by_role("button", name="Comenzar").click(); expect(page.get_by_role("heading", name="Inicio")).to_be_visible()
    expect(bell_n()).to_be_hidden()                                   # sin avisos al inicio

    # --- tarjeta que vence en 2 días con deuda -> recordatorio
    nav("Tarjetas"); page.get_by_role("button", name="Agregar tarjeta").click()
    page.fill("#f-name", "Visa"); page.fill("#f-credit_limit", "5000"); page.fill("#f-cut_day", "1"); page.fill("#f-due_day", str(due))
    page.get_by_role("button", name="Crear cuenta").click(); toast("Cuenta creada")
    nav("Tarjetas"); page.get_by_role("button", name="Registrar compra").click()
    page.fill("#f-amount", "800"); page.fill("#f-description", "Compra"); page.get_by_role("button", name="Guardar movimiento").click(); toast("Movimiento guardado")
    toast("Pago de Visa vence en 2 días")                              # aviso emergente al recargar la vista
    expect(bell_n()).to_have_text("1", timeout=8000); page.reload(); expect(bell_n()).to_have_text("1", timeout=8000)   # persiste tras recargar
    page.locator("#bell").click(); expect(page.locator("#notif-list")).to_contain_text("800.00")
    page.screenshot(path=f"{SHOTS}/n1-avisos-tarjeta.png")
    page.locator("#notif-list [data-open]").first.click(); expect(page.locator(".topbar h1")).to_contain_text("Tarjetas"); expect(bell_n()).to_be_hidden()

    # --- portafolio: compra + precio manual + objetivos
    nav("Portafolio"); page.locator("#pf-e, #pf-new").first.click()
    page.fill("#f-symbol", "AAPL"); page.fill("#f-quantity", "2"); page.fill("#f-price", "100"); page.get_by_role("button", name="Guardar").click(); toast("Operación")
    nav("Portafolio"); page.locator(".pf-row").first.click()
    page.get_by_role("button", name="Fijar precio manual").click(); page.fill("#f-price", "100"); page.get_by_role("button", name="Guardar").click(); toast("Precio guardado")
    page.get_by_role("button", name="Poner objetivos").click()
    page.fill("#f-lower", "300"); page.fill("#f-upper", "200"); page.get_by_role("button", name="Guardar").click()
    expect(page.locator(".field.err").first).to_be_visible()      # inferior >= superior: validación
    page.fill("#f-lower", "80"); page.fill("#f-upper", "150"); page.get_by_role("button", name="Guardar").click(); toast("Objetivos guardados")
    expect(page.locator("#targets")).to_contain_text("vigilando"); expect(bell_n()).to_be_hidden()
    page.screenshot(path=f"{SHOTS}/n2-objetivos.png")
    # el precio sube por encima del objetivo -> aviso
    page.get_by_role("button", name="Fijar precio manual").click(); page.fill("#f-price", "160"); page.get_by_role("button", name="Guardar").click()
    toast("Precio guardado"); expect(bell_n()).to_have_text("1", timeout=8000)
    toast("AAPL alcanzó tu precio objetivo")
    page.locator("#bell").click(); expect(page.locator("#notif-list")).to_contain_text("objetivo superior 150.00")
    page.screenshot(path=f"{SHOTS}/n3-aviso-precio.png")
    page.locator("#n-all").click(); expect(bell_n()).to_be_hidden()
    page.locator("#notif-list [data-rm]").first.click(); page.keyboard.press("Escape")
    # pausar / quitar
    nav("Portafolio"); expect(page.locator(".pf-row").first.locator('.badge[title]')).to_be_visible()
    page.locator(".pf-row").first.click(); page.get_by_role("button", name="Pausar").click(); expect(page.locator("#targets")).to_contain_text("en pausa")
    page.get_by_role("button", name="Quitar", exact=True).click(); expect(page.locator("#targets")).to_contain_text("Poner objetivos")

    # móvil: la campana existe
    page.set_viewport_size({"width": 390, "height": 800}); page.reload(); expect(page.locator("#bell")).to_be_visible()
    page.screenshot(path=f"{SHOTS}/n4-movil.png")
    b.close()

real = [e for e in errors if "favicon" not in e and "401" not in e and "400 (BAD" not in e]
print("ERRORES DE CONSOLA:", real if real else "ninguno")
sys.exit(1 if real else 0)
