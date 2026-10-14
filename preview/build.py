"""Genera la vista previa web (un solo HTML) a partir de la app real + preview/shim.js."""
import pathlib
root = pathlib.Path(__file__).resolve().parent.parent
css = (root / "static/style.css").read_text()
import base64, re
# las fuentes van incrustadas: la vista previa es un solo archivo
css = re.sub(r'url\("fonts/([a-z-]+\.woff)"\)', lambda m: 'url("data:font/woff;base64,' + base64.b64encode((root / "static/fonts" / m.group(1)).read_bytes()).decode() + '")', css)
core = (root / "static/core.js").read_text()
shim = (root / "preview/shim.js").read_text()
app = (root / "static/app.js").read_text()
extra = (root / "static/extra.js").read_text()
more = (root / "static/more.js").read_text()
notify_js = (root / "static/notify.js").read_text()
widgets_js = (root / "static/widgets.js").read_text()
css += (root / "static/widgets.css").read_text()
extra_css = """
.preview-bar { display: flex; gap: .6rem; align-items: center; justify-content: center; flex-wrap: wrap; padding: 1rem; color: var(--ink-soft); font-size: .78rem; text-align: center; border-top: 1px solid var(--line); }
@media (max-width: 900px) { .preview-bar { padding-bottom: calc(6.5rem + env(safe-area-inset-bottom, 0px)); } }   /* nota al final de la página (no arriba): arriba parecería barra del navegador */
.preview-bar button { border: 1px solid var(--line); background: var(--card); color: var(--ink); border-radius: 999px; padding: .2rem .7rem; cursor: pointer; font-size: .78rem; }
"""
for name, js in (("core", core), ("extra", extra), ("more", more), ("notify", notify_js), ("widgets", widgets_js), ("shim", shim), ("app", app)):
    assert "</script" not in js, name
for name in ("apple-touch-icon.png", "apple-touch-icon-dark.png"):   # íconos del selector en Configuración, incrustados
    app = app.replace("/static/icons/" + name + "?v=4", "data:image/png;base64," + base64.b64encode((root / "static/icons" / name).read_bytes()).decode())
tpl = (root / "templates/index.html").read_text()
splash = tpl[tpl.index('<div id="splash"'):tpl.index('<div id="app"')].strip()
boot = (root / "static/boot.js").read_text()
html = f"""<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>FIPO</title>
<script>{boot}</script>
<style>
{css}
{extra_css}
</style>
{splash}
<div id="app" aria-live="polite"></div>
<div class="preview-bar" id="preview-bar">Vista previa en el navegador: tus datos se guardan solo en este dispositivo y no hay servidor.
<button type="button" id="preview-reset">Borrar datos de la vista previa</button></div>
<div id="modal-root"></div>
<div id="toasts" role="status" aria-live="polite"></div>
<script>
window.FIPO_PREVIEW = true;
{core}
</script>
<script>
{extra}
</script>
<script>
{more}
</script>
<script>
{notify_js}
</script>
<script>
{widgets_js}
</script>
<script>
{shim}
</script>
<script>
{app}
</script>
<script>
(function () {{
  const b = document.getElementById("preview-reset");
  let armed = false;
  b.addEventListener("click", function () {{
    if (!armed) {{ armed = true; b.textContent = "Toca otra vez para borrar todo"; setTimeout(function () {{ armed = false; b.textContent = "Borrar datos de la vista previa"; }}, 4000); return; }}
    window.fipoPreviewReset();
  }});
}})();
</script>
"""
out = root / "preview/fipo-preview.html"
out.write_text(html)
print(out, len(html) // 1024, "KB")
