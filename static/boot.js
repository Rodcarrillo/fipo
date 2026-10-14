/* FIPO · arranque: aplica el tema guardado antes de pintar nada (evita un destello del color equivocado)
   y elige el ícono de la pantalla de inicio: blanco/verde (día) o verde/negro (noche). */
(function () {
  var get = function (k) { try { return JSON.parse(localStorage.getItem("fipo." + k) || '""'); } catch (e) { return ""; } };
  var t = get("theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  var isDark = function () {
    var a = document.documentElement.getAttribute("data-theme");
    return a ? a === "dark" : !!(window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
  };
  var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute("content", isDark() ? "#262A22" : "#F6F3EB");
  /* El iPhone guarda el ícono al «Agregar a inicio» y ya no lo cambia solo: se toma el que esté elegido en ese momento.
     «auto» = según el modo claro/oscuro que tengas al agregarla. */
  window.fipoSetIcon = function () {
    var pref = get("icon"), dark = pref === "dark" || (pref !== "light" && isDark());
    var l = document.querySelector('link[rel="apple-touch-icon"]');
    if (l) l.setAttribute("href", "/static/icons/apple-touch-icon" + (dark ? "-dark" : "") + ".png?v=4");
  };
  window.fipoSetIcon();
})();
