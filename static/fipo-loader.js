// FIPO · widget para la pantalla de inicio del iPhone (app gratuita "Scriptable").
// Este script es solo un cargador: cada vez que el widget se actualiza baja de TU FIPO el diseño más reciente
// (static/fipo-scriptable.js), así nunca tienes que volver a pegarlo cuando FIPO cambie.
// Lleva tu enlace privado de SOLO LECTURA: no lo compartas.
// Parámetro del widget: summary | portfolio | health | budget | goal | goals | categories | recent | quick
const FIPO_URL = "__FIPO_URL__";

const fm = FileManager.local(), cache = fm.joinPath(fm.documentsDirectory(), "fipo-widget-design.js");
const base = FIPO_URL.replace(/\/api\/.*$/, "");
let code = null, why = "No se pudo conectar con tu FIPO. Revisa tu internet.";
if (FIPO_URL.indexOf("http") !== 0) why = "Falta tu enlace: en la línea 6 de este script pega el enlace de FIPO → Widgets → «Copiar solo el enlace».";
else try {
  const r = new Request(base + "/static/fipo-scriptable.js?t=" + Date.now());   // ?t= evita que el iPhone use una versión vieja guardada
  r.timeoutInterval = 15;
  const txt = await r.loadString();
  const st = r.response ? r.response.statusCode : 0;
  if (st === 200 && txt.indexOf("FIPO_URL") >= 0) { code = txt; fm.writeString(cache, txt); }
  else if (st === 200) why = "Tu FIPO en PythonAnywhere todavía tiene la versión vieja. Sube el zip nuevo y toca Reload.";
  else why = "Tu FIPO respondió con error " + st + ". Revisa que esté funcionando en PythonAnywhere.";
} catch (e) { /* sin conexión: se usa la última copia guardada */ }
if (!code && fm.fileExists(cache)) code = fm.readString(cache);

if (code) {
  await new Function("FIPO_URL", "args", "config", "return (async () => {\n" + code + "\n})()")(FIPO_URL, args, config);
} else {
  const w = new ListWidget(); w.backgroundColor = new Color("#4E5738"); w.setPadding(14, 14, 14, 14);
  const a = w.addText("FIPO"); a.font = Font.heavySystemFont(14); a.textColor = new Color("#F4F2E8");
  const b = w.addText(why); b.font = Font.systemFont(11); b.textColor = new Color("#D7DCC5"); b.minimumScaleFactor = 0.7;
  if (config.runsInWidget) Script.setWidget(w); else await w.presentMedium();
  Script.complete();
}
