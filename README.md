# FIPO — Finanzas Personales Ordenadas (Fases 1, 2 y 3 + avisos)

Aplicación web multiusuario de finanzas personales con las tres fases: cuentas, movimientos y dashboard (Fase 1); tarjetas de crédito, deudas, presupuestos, análisis y reportes (Fase 2); metas de ahorro, tablas personalizadas y comprobantes con OCR (Fase 3); más Portafolio de inversiones e importación de estados de cuenta.

## Cómo ejecutarla

**Opción A, Docker (recomendada; incluye Tesseract para los comprobantes):**

```bash
docker compose up --build        # abre http://localhost:8000
```

**Opción B, sin Docker (Python 3.10+):**

```bash
./run.sh                         # crea .venv, instala dependencias y abre http://127.0.0.1:5000
```

Para leer comprobantes necesitas el programa Tesseract en el sistema (`sudo apt install tesseract-ocr tesseract-ocr-spa`, o `brew install tesseract tesseract-lang`). Sin él, todo lo demás funciona y los comprobantes se guardan sin lectura automática.

**Publicarla con un enlace propio y ponerla en tu iPhone — dos opciones:**

### Opción gratis: PythonAnywhere

Pensada para cuando es solo para ti y no vas a guardar datos de tarjeta: no requiere Docker ni tarjeta de crédito para crear la cuenta.

Todo lo técnico lo hace un instalador; tú solo haces esto (unos 10 minutos, la mayoría esperando):

1. En [pythonanywhere.com](https://www.pythonanywhere.com) crea una cuenta gratis, plan **"Beginner"**. Tu usuario será parte de tu dirección (`tuusuario.pythonanywhere.com`).
2. Arriba a la derecha: **Account** → pestaña **API token** → **Create a new API token**. Deja esa página abierta (vas a copiar ese texto largo en el paso 4).
3. Pestaña **Files** → botón **Upload a file** → sube `fipo.zip` (queda en `/home/tuusuario`).
4. Pestaña **Consoles** → **Bash**. Pega esta línea y presiona Enter:
   ```bash
   unzip -o fipo.zip && bash fipo/deploy/instalar_pythonanywhere.sh
   ```
   Cuando te lo pida, pega tu API token y presiona Enter (no se ve mientras lo pegas; es normal). Al final te muestra tu dirección.
5. Abre `https://tuusuario.pythonanywhere.com`, crea tu cuenta real y, en tu iPhone, abre esa dirección en Safari y sigue "Agregar a inicio" (más abajo).

**Para actualizar FIPO** después: sube el `fipo.zip` nuevo en Files (reemplaza el anterior) y corre la misma línea del paso 4. Tus datos viven en `~/fipo_data` y nunca se tocan al actualizar.

El instalador usa la [API oficial de PythonAnywhere](https://help.pythonanywhere.com/pages/API/): crea la app web, le indica la carpeta del código y el entorno de Python, fuerza HTTPS, escribe el archivo WSGI (`deploy/pythonanywhere_wsgi.py`, no hay que editarlo) y la recarga. Si prefieres no usar el token, presiona Enter cuando te lo pida y te dice los 2–3 clics que faltan en la pestaña **Web**.

**Límites reales del plan gratis (para que no te tome por sorpresa):**
- **Hay que renovarla cada mes**: PythonAnywhere apaga las apps gratis que nadie renueva (desde marzo de 2026 el plazo es de 1 mes; antes eran 3). Entra a la pestaña **Web** y da clic en **“Run until 1 month from today”**. Tus datos no se borran si se apaga; solo deja de abrir hasta que la renueves. Un recordatorio mensual en tu calendario lo resuelve.
- **100 segundos de CPU al día**: de sobra para uso personal normal; si un día lo agotas, la app responde muy lento hasta la medianoche (hora del servidor), no se borra nada.
- Sin tareas automáticas de fondo en el plan gratis, así que los precios del portafolio **no se actualizan solos cada hora**: usa el botón "Actualizar precios" dentro de FIPO cuando quieras verlos al día (por eso la plantilla del WSGI trae `FIPO_NO_SCHEDULER=1`).
- **Sin Tesseract** (no se puede instalar software del sistema en el plan gratis): los comprobantes se guardan con su foto pero sin lectura automática de monto/fecha — igual que correr FIPO sin Tesseract instalado, ya contemplado arriba.
- Sin dominio propio y sin SMTP en el plan gratis, así que los avisos por correo no estarán disponibles ahí (sí los avisos dentro de la app).
- 512 MB de espacio: alcanza para años de movimientos y bastantes comprobantes; si algún día se llena, PythonAnywhere lo avisa.

### Actualizar desde GitHub (sin zips)

1. Una sola vez, en una consola Bash de PythonAnywhere: `bash ~/fipo/deploy/conectar_github.sh` y pega un token de GitHub de **solo lectura** (fine-grained, solo el repositorio `fipo`, permiso *Contents: Read*). El script deja `~/fipo` igual a GitHub sin tocar `~/fipo_data` ni `venv`, y te muestra la dirección y la clave del webhook.
2. En GitHub: **Settings → Webhooks → Add webhook** con esa dirección (`https://<tu-usuario>.pythonanywhere.com/api/deploy`), *Content type* `application/json` y la clave (*Secret*).

Desde entonces, cada `push` a `main` llega solo: GitHub avisa a `/api/deploy`, FIPO comprueba la firma (`X-Hub-Signature-256` con la clave de `~/fipo_data/deploy.key`), hace `git pull --ff-only` y se recarga tocando el archivo WSGI. Sin `deploy.key` esa dirección no existe (404). A mano: `cd ~/fipo && git pull && touch /var/www/*_wsgi.py`.

### Opción de pago: Render (con Docker)

1. Sube esta carpeta a un repositorio de GitHub (puede ser privado).
2. En [render.com](https://render.com) crea una cuenta, luego *New → Blueprint* y selecciona ese repositorio. `render.yaml` ya crea el servicio con un disco persistente (`/data`) para la base de datos, la clave de sesión y los comprobantes — sin ese disco perderías tus datos en cada reinicio, así que **no uses el plan gratis** para esto: el plan de pago más barato que acepta disco (*Starter*) cuesta alrededor de $7 USD/mes, más $0.25 USD/mes por cada GB de disco (1 GB, el que trae `render.yaml`, alcanza de sobra para uso personal). Verifica el precio vigente en [render.com/pricing](https://render.com/pricing), porque puede cambiar.
3. Cuando termine el despliegue, Render te da una URL (`https://tu-app.onrender.com`). Ábrela, crea tu cuenta real y confirma que todo funciona antes del siguiente paso.
4. En tu iPhone, abre esa URL en Safari y sigue el paso de "Agregar a inicio" de más abajo.
5. (Opcional pero recomendado) En Render, configura un dominio propio o dale a "Auto-Deploy" para que se actualice solo cuando subas cambios al repositorio; y activa las variables `FIPO_SMTP_*` si quieres avisos por correo (pagos de tarjeta, precios objetivo).

También sirve cualquier otro hosting que ejecute Docker con un disco persistente (Fly.io, Railway, un VPS propio) — el `Dockerfile` no depende de Render. Debe ser **un solo proceso** (ya configurado), porque la actualización horaria de precios corre dentro del servidor.

### Agregar FIPO a la pantalla de inicio del iPhone (para las dos opciones)

Al abrirla desde el ícono verás la pantalla de carga de FIPO: el mismo fondo de Inicio (crema de día, oliva casi negro en modo oscuro) con el logo; se quita sola en cuanto Inicio tiene sus datos (mínimo ~0.7 s para que no parpadee, máximo 6 s). Para que no haya destello blanco, mientras abre la app iOS muestra una imagen de arranque que es solo el color de fondo, sin logo (`static/splash/`, 12 tamaños de iPhone en claro y oscuro): así la única pantalla de carga que se ve es la de FIPO.

En Safari (tiene que ser Safari, no Chrome ni otro navegador, o "Agregar a inicio" no funciona igual), abre la URL de tu FIPO. Toca el ícono de compartir (el cuadrado con la flecha hacia arriba) y elige **"Agregar a inicio"**. FIPO queda como un ícono en tu pantalla de inicio, con su propio logo, y al abrirlo se ve a pantalla completa (sin la barra de Safari) — se siente como una app normal, aunque técnicamente es la página web.

La base de datos (`fipo.db`), la clave de sesión (`secret.key`) y los comprobantes se guardan en `instance/` (o en `FIPO_DATA_DIR`: el disco `/data` en Render, o `~/fipo_data` en PythonAnywhere con la plantilla de arriba). **Haz copias de seguridad de esa carpeta/disco.**

**Límite de esta verificación:** en el entorno donde se construyó FIPO no se pudo completar una build de Docker de extremo a extremo (el registro `docker.io` está bloqueado por política de red de ese entorno, no por un problema del `Dockerfile`), ni instalar la app en una cuenta real de PythonAnywhere (sin acceso a ese sitio desde este entorno; el instalador sí se probó de punta a punta contra una imitación estricta de su API: instalación nueva, cargar la app desde el archivo WSGI, actualizar sin perder datos y token equivocado) — así que antes de depender de esto para tus datos reales, prueba tú una vez el despliegue completo (en PythonAnywhere, en Render, o `docker compose up --build` en tu propia computadora) y confirma que abre bien. Los pasos de PythonAnywhere se basan en su documentación oficial vigente (confirmé el espacio, los segundos de CPU, la falta de tareas de fondo en el plan gratis y que el subdominio ya sirve HTTPS); lo único que no pude reconfirmar del todo es si el registro gratuito sigue sin pedir tarjeta — hasta ahora siempre ha sido así.

Pruebas automáticas:

```bash
python3 -m unittest discover -s tests -v     # 128 pruebas: motor financiero, carga de datos, avisos push, tarjetas a meses y cargos recurrentes, seguridad, importación, portafolio, vigilancia y tipo de cambio, fases 2 y 3, análisis
python3 tests/e2e_phases.py http://127.0.0.1:5000   # navegador real (playwright + chromium, servidor en marcha y base nueva)
```

## Variables de entorno

| Variable | Para qué sirve |
|---|---|
| `PORT`, `HOST` | Puerto y dirección (por defecto `5000` y `127.0.0.1`) |
| `FIPO_DB` | Ruta de la base de datos SQLite |
| `FIPO_SECRET` | Clave para firmar sesiones. En producción defínela y mantenla privada |
| `FIPO_REFRESH_SECONDS` | Cada cuánto se actualizan los precios del portafolio (por defecto 3600 = cada hora) |
| `FIPO_NO_SCHEDULER=1` | Desactiva la actualización automática de precios |
| `FIPO_DATA_DIR` | Carpeta de datos (base, clave y comprobantes). En hosting, apúntala al disco persistente |
| `FIPO_HTTPS=1` | Marca la cookie de sesión como `Secure` (actívalo detrás de HTTPS) |
| `FIPO_SMTP_HOST`, `FIPO_SMTP_PORT`, `FIPO_SMTP_USER`, `FIPO_SMTP_PASS`, `FIPO_SMTP_FROM` | Correo saliente: recuperar contraseñas y avisos por correo (puerto 465 usa SSL; `FIPO_SMTP_TLS=0` desactiva STARTTLS) |
| `FIPO_PUBLIC_URL` | Dirección pública de tu FIPO (p. ej. `https://fipo.onrender.com`); se usa para el enlace dentro de los correos de aviso |

**Recuperación de contraseña:** sin SMTP configurado no puede enviarse correo, así que el enlace de recuperación se imprime en la consola del servidor. Con SMTP configurado se envía por correo. La respuesta al usuario es idéntica exista o no la cuenta.

**Producción:** usa un servidor WSGI (por ejemplo `gunicorn -w 1 app:app`) detrás de HTTPS, con `FIPO_SECRET` y `FIPO_HTTPS=1`. La actualización horaria de precios corre en un hilo del propio servidor; con varios procesos cada uno la ejecuta, pero se evitan consultas repetidas por antigüedad del precio. SQLite es adecuada para uso personal o un grupo pequeño; para muchos usuarios simultáneos conviene migrar a PostgreSQL (el acceso a datos está concentrado en `db.py` y `ledger.py`).

## Qué incluye la Fase 1

- Registro, inicio y cierre de sesión, recuperación y cambio de contraseña, perfil, moneda y zona horaria, tema claro/oscuro, botón de privacidad de montos.
- Onboarding: moneda, cuentas iniciales con saldo de apertura y categorías predeterminadas.
- Cuentas (banco, efectivo, ahorro, digital, inversión, otra): saldo actual calculado, historial, gráfica de evolución, ajuste de saldo registrado, archivar y eliminar (solo sin movimientos).
- Movimientos: gasto, ingreso, transferencia entre cuentas, reembolso y ajuste. Crear, ver detalle, editar y eliminar con recálculo automático. Búsqueda, filtros (fecha, cuenta, categoría, tipo), orden por columna, paginación y exportación CSV.
- Categorías y subcategorías personalizadas, con archivo y renombrado.
- Dashboard: total en cuentas, disponible, ingresos, gastos, balance neto y patrimonio; filtros de periodo (hoy, semana, mes, 3 meses, año, rango libre); ingresos vs. gastos; gastos por categoría; últimos movimientos; alertas basadas en datos reales. Las barras y categorías son clicables y llevan a los movimientos que las forman.
- **Salud financiera (Inicio):** una tarjeta destacada arriba del dashboard con el puntaje de 1 a 10 (un decimal) y enlace al detalle en Análisis. Usa la misma fórmula que "Salud financiera" en Análisis (`/api/health-score` reusa `analysis()`, así que nunca se pueden ver dos números distintos). **Mide qué tan cerca está tu distribución de ingresos de la meta: 50% vida/gastos, 25% ahorro, 25% inversión** (`health.py`; las metas son la constante `TARGETS`, editable sin tocar la lógica):
  - Base = ingresos del mes. Vida = gastos del mes (gastos − reembolsos); Inversión = compras del portafolio del mes (importe + comisión, convertidas a tu moneda); Ahorro = lo que sobra (ingresos − gastos − inversión).
  - Cada categoría vale 33.33 puntos. Del lado malo se penaliza: `33.33 × (1 − diferencia / meta)`, mínimo 0 (gastar de más en vida; ahorrar o invertir de menos). Del lado bueno hay **puntos extra** proporcionales: `33.33 × (1 + diferencia / meta)` (gastar menos en vida; ahorrar o invertir más). `BONUS_RATE` ajusta qué tan rápido crece el extra y `MAX_TOTAL` (120) topa el total.
  - Se redondea a entero; `score_10` = `score_100 / 10`, así que puede pasar de 10 si hay extras. Si el mes en curso aún no tiene ingresos, se usa el último mes que sí los tenga (se indica en Análisis); sin ingresos en ningún mes, la tarjeta muestra "Sin datos". Contrato de la API: `score_100`, `score_10`, `breakdown` (por categoría: `actual_pct`, `target_pct`, `difference`, `bonus`, `points`) y `month`.
- El logo de FIPO en la barra lateral es un enlace a Inicio desde cualquier página.
- Exportación de todos tus datos (JSON) y eliminación de tu cuenta.
- **Navegación:** la barra lateral agrupa todo en 4 categorías (Dinero diario, Planeación, Inversión y análisis, Más) más Inicio, en vez de una lista larga de enlaces; cada grupo se abre y muestra sus páginas, y en modo compacto (barra angosta) cada categoría es un acceso directo a su primera página. El logo de arriba también es un enlace directo a Inicio.
- **Instalable en el celular (PWA):** `static/manifest.webmanifest` + ícono propio (`static/icons/`) + las etiquetas de iOS en `templates/index.html`, para que "Agregar a inicio" en Safari (iPhone) deje un ícono real de FIPO que abre a pantalla completa, sin la barra de Safari.
- Datos de demostración **opcionales**, marcados `[DEMO]`, separados de los reales y eliminables sin tocar nada tuyo. Cubren 10 meses e incluyen cuentas, una tarjeta con compras y pagos, una deuda con abonos, presupuestos, dos metas de ahorro con aportaciones y un portafolio con dos posiciones — para que Análisis, Tarjetas, Deudas, Presupuestos, Metas y Portafolio tengan algo real que mostrar desde el primer momento. Disponibles también en la vista previa sin servidor.

## Fase 2: tarjetas, deudas, presupuestos, análisis y reportes

- **Tarjetas de crédito** (cuenta de tipo «Tarjeta de crédito» con límite, día de corte y día de pago). Las compras son gastos en la tarjeta; el **pago** es una transferencia desde tu cuenta (no cuenta como gasto ni ingreso). La tarjeta **no se suma a tu dinero**: su deuda resta de tu patrimonio. Muestra uso del límite, disponible, próximo corte y pago, y lo pendiente del último corte (estimado con tu día de corte; no incluye intereses ni pagos mínimos del banco). Avisos al 80% del límite y a 5 días del pago.
- **Compras a meses y saldos diferidos.** Al dar de alta una tarjeta, «¿Cuánto debes hoy?» se captura en positivo (el teclado numérico del iPhone no tiene signo menos) y se separa en lo que no está a meses y los planes que ya traes: meses sin intereses, meses con intereses o saldo diferido (mensualidad, plazo y meses que faltan). Las compras nuevas con tarjeta también pueden ser a meses (MSI o con intereses). El capital de un plan ya está dentro del saldo de la tarjeta; cada fecha de corte entra una mensualidad al estado de cuenta, así que **Pago del mes = saldo al corte − capital a meses que aún no tocaba − pagos desde el corte**. En los planes con intereses, la parte de interés de cada mensualidad se registra al corte como un gasto real «Intereses de tarjeta», una sola vez. Una compra a meses con mensualidades ya cobradas no se puede editar en importe, fecha, tarjeta o plazo (se borra y se registra de nuevo); al borrarla se borran también sus intereses.
- **Pagos recurrentes / suscripciones** (sección «Pagos recurrentes» y desde cada tarjeta): eliges la cuenta o tarjeta donde se cobra, cada cuánto (semana, mes, año) y la próxima fecha; FIPO registra el gasto solo ese día (y se pone al día si pasaron varios), con un aviso. Si la cuenta se archiva, el cargo se pausa y te avisa. Los saldos de otras cuentas aceptan negativos con el botón ±.
- **Deudas** con pagos divididos en capital e intereses: solo el capital reduce lo que debes. El pago puede ligarse a una cuenta (le resta efectivo) y **no cuenta como gasto**; los intereses pagados se muestran aparte. No se calculan intereses futuros: FIPO registra lo que tú pagas.
- **Presupuestos** mensuales por categoría principal (las subcategorías suman) y total del mes, con avance, excedido y avisos en Inicio.
- **Análisis:** un panel completo, calculado siempre a partir de tus datos reales (nunca inventado):
  - *Valores principales:* patrimonio neto, dinero disponible, ingresos, gastos, ahorro y tasa de ahorro del mes, deuda total y deuda/ingreso, fondo de emergencia (meses de cobertura con dinero líquido), burn rate, runway (si gastas más de lo que ingresas), y el rendimiento no realizado del portafolio.
  - *Gráficas:* ingresos vs. gastos, evolución del ahorro acumulado, evolución del patrimonio neto, evolución de deudas, gastos por categoría, gastos vs. presupuesto, distribución de activos (efectivo, cuentas de inversión y portafolio por tipo), progreso de metas y proyección patrimonial con tres escenarios (conservador/base/optimista).
  - *Herramientas:* calculadoras de interés compuesto, de deuda (meses para pagarla e interés total) y de fondo de emergencia; detector de gastos recurrentes y suscripciones (mismo importe y descripción en al menos 3 de los últimos 4 meses); comparación del mes contra el anterior por categoría; **puntaje de salud financiera** (0–100, hasta 120 con puntos extra; cercanía a la distribución objetivo 50/25/25, ver Fase 1).
  - **Financial Insights:** tarjetas en lenguaje natural generadas con reglas sobre tus propios números — nunca texto fijo ni cifras inventadas: cambio de gasto vs. el mes anterior (con la categoría que más influyó), tendencia de tu ahorro promedio, aviso si tu gasto se aleja de tu propio promedio, y tiempo estimado para alcanzar tu meta más cercana según tu ritmo de aportes reciente. Un insight solo aparece cuando hay suficiente historial para calcularlo con datos reales; si no, simplemente no se muestra.
- **Reportes** de un mes o rango: resumen en pantalla, **PDF** (resumen, categorías, presupuestos, saldos y movimientos) y **CSV** de movimientos.

## Fase 3: metas, tablas y comprobantes

- **Metas de ahorro** con aportaciones y retiros, avance y cuánto ahorrar al mes. Son apartados de control: no mueven saldos de cuentas.
- **Tablas personalizadas** tipo hoja (texto, número, dinero, fecha, casilla) con edición en la celda, totales automáticos y exportación CSV. Una columna con datos no cambia de tipo.
- **Comprobantes:** subes o tomas una foto (JPG/PNG/WEBP), el servidor la lee con **Tesseract** y sugiere total, fecha y comercio. Con «Revisar y confirmar» se abre un formulario corto (tipo gasto/ingreso, importe, fecha, cuenta, categoría y comercio) ya lleno con lo leído: solo confirmas o corriges y se guarda el movimiento con la foto adjunta, sin tener que volver a escribir los datos. Si necesitas método de pago, notas o que sea una transferencia, hay un enlace para abrir el formulario completo. También puedes adjuntar fotos a movimientos existentes. La lectura automática depende de la calidad de la foto y puede equivocarse: **siempre verifica el importe**. Las imágenes se guardan en el servidor y solo tú puedes verlas.

## Comprar acciones desde «+ Movimiento»

En «Nuevo movimiento» hay una quinta pestaña, **Acciones**: símbolo, tipo de activo, cantidad, precio, comisión, fecha y la cuenta desde la que pagas. Se guarda como una **compra del Portafolio** (aparece ahí y descuenta el efectivo de la cuenta; no cuenta como gasto). La acción debe cotizar en la misma moneda que la cuenta (acciones en dólares → cuenta en USD).

- **Convertir pesos a dólares antes (flujo GBM):** si marcas «Antes convertí … (transferencia interna entre mis cuentas)», eliges la cuenta de origen (p. ej. Smart Cash), cuánto salió y cuánto llegó. FIPO registra una **transferencia entre monedas** (baja Smart Cash, sube la cuenta USD; no es ingreso ni gasto) y enseguida la compra de la acción desde la cuenta USD. Muestra el tipo de cambio que pagaste y cómo quedará cada saldo. Si la conversión se guarda pero la compra falla, el aviso lo dice (la conversión ya quedó registrada).
- **Ver en USD o en MXN:** cuando la cuenta es de otra moneda que tu moneda principal, el importe (en compras y en gastos/ingresos) tiene un selector para verlo en la moneda de la cuenta o en tu moneda principal, con el tipo de cambio usado (`GET /api/fx`, el mismo de Yahoo/manual del resto de la app; si no hay, lo dice en vez de inventarlo). En Transferencias entre monedas también se muestra el tipo de cambio implícito.

## Widgets (sección «Widgets» del menú)

Página modular con 9 widgets en tamaños S / M / L: Nuevo movimiento, Resumen general, Portafolio, Gastos por categoría, Meta de ahorro, Objetivos, Movimientos recientes, Salud financiera y Presupuesto. Usan los mismos cálculos que Análisis, Presupuestos, Metas y Portafolio (`GET /api/widgets/data`), así que nunca muestran cifras distintas.

- **Personalizar dashboard**: mostrar/ocultar, reordenar (arrastrar en computadora; «Antes/Después» en el menú ••• en celular; mantener presionado entra al modo edición), cambiar tamaño, color por widget o global, Claro / Oscuro / Automático y «Restaurar».
- **Colores**: oliva (predeterminado), verde oscuro, crema, negro, azul, morado, rosa, gris y personalizado (se calcula un contraste legible).
- **Persistencia**: el diseño se guarda en tu cuenta (`/api/widgets/layout`, tabla `widget_prefs`) y en el dispositivo; se conserva al reiniciar o actualizar el zip.
- **Widgets nativos de iPhone**: una PWA **no puede** crearlos (Apple exige WidgetKit/app nativa y cuenta de pago). Alternativa gratis: en Widgets → «Crear enlace privado para mi iPhone» y pegar el script en la app **Scriptable** (`static/fipo-loader.js`, un cargador que en cada actualización baja el diseño de `static/fipo-scriptable.js` con `?t=` para no usar copias viejas; si no hay conexión usa la última copia guardada en el iPhone). El diseño dibuja los widgets con los mismos colores, líneas, anillos y barras que la web (lee tus colores guardados) en los 3 tamaños; parámetros: summary, portfolio, health, budget, goal, goals, categories, recent, quick. El enlace (`/api/widgets/public?token=`) es de solo lectura, se guarda con hash, se puede regenerar/revocar y tiene límite de intentos. Ese mismo endpoint sirve de base para una app nativa futura.
- El widget de Portafolio muestra el rendimiento por activo (barras); el historial del portafolio no existe como endpoint único.

## Portafolio (sección aparte)

- Registra **compras, ventas, dividendos e intereses** con símbolo (AAPL, VOO, BTC-USD, WALMEX.MX…), cantidad, precio, comisión, fecha y, opcionalmente, la cuenta de efectivo ligada.
- Calcula por activo: cantidad, **costo promedio**, valor de mercado, ganancia **no realizada** y **realizada** (método de costo promedio), cambio del día, dividendos. No permite vender más de lo que tienes en esa fecha.
- Si ligas una cuenta, la compra descuenta efectivo y la venta o el dividendo lo suma; **nunca cuenta como ingreso o gasto**, y el saldo sigue siendo reconstruible. El valor de mercado del portafolio se suma al patrimonio neto del Inicio.
- **Precios:** Yahoo Finance sin clave, consultados **solo desde el servidor**, actualizados **cada hora** en segundo plano y con botón «Actualizar precios». Se muestra la hora de la última actualización. Si Yahoo falla, se conserva el último precio conocido, se muestra el error y no se inventa nada. Si un símbolo no tiene precio, puedes fijarlo a mano (se marca «manual»).
- **Gráfica** del activo (1M/6M/1A/5A) solo cuando el historial está disponible; si no, aparece el enlace a la página del activo en Yahoo Finance.
- **Advertencia:** Yahoo no ofrece una API pública oficial; se usa su endpoint no documentado, que puede cambiar, limitar peticiones o dejar de funcionar sin aviso. Los precios pueden tener retraso. En las pruebas automáticas los precios son datos falsos de prueba: la consulta real a Yahoo no pudo verificarse desde el entorno de desarrollo (sin acceso saliente), así que pruébala en tu equipo.

## Cargar mis datos (archivo de carga)

Configuración → Datos → «Cargar mis datos» da de alta de una vez cuentas, tarjetas e inversiones desde un archivo JSON (formato `fipo-carga` v1, ver `restore.py`). Primero muestra una prueba sin guardar (el servidor ejecuta todo y lo deshace, así el resumen es exactamente lo que quedará) y luego se confirma; es todo o nada y se niega a cargar si ya existen cuentas con esos nombres (no duplica).

- **Tarjetas:** saldo del último estado de cuenta, compras a meses (con `starts_after_cuts` para un pago final que se cobra después de N cortes) y lo cargado después del corte sin desglose, que queda como ajuste de saldo marcado (no cuenta como gasto; se ve como «compras nuevas desde el corte»).
- **Inversiones:** las acciones se registran como operaciones ligadas a su cuenta; el efectivo = total de la cuenta − valor de las acciones a los precios del archivo. La cuenta muestra efectivo + acciones y el patrimonio lo suma una sola vez.
- **Otras monedas:** cuentas y acciones en dólares se muestran en su moneda (US$) y se suman a los totales convertidas con el tipo de cambio de Yahoo Finance; si todavía no hay, con el del archivo.

## Importar estado de cuenta

Desde Configuración → Datos, o desde el detalle de una cuenta: sube un **CSV, Excel (.xlsx) o PDF**, elige la cuenta y revisa antes de guardar. Se detectan columnas (fecha, descripción, importe o cargo/abono, saldo), se marcan **posibles duplicados** (desmarcados por defecto), se sugiere categoría según tu historial y puedes corregir columnas, formato de fecha o signo. Cada importación se puede **deshacer** completa. Los PDF son de mejor esfuerzo: cada banco los arma distinto y solo se leen PDF con texto (no escaneados); revisa siempre las filas marcadas. Los archivos no se guardan, solo los movimientos que confirmes.

## Avisos: pagos de tarjeta y precios objetivo

Hay una campana en la barra superior con el número de avisos sin leer, un centro de avisos (marcar leído, quitar) y un mensaje emergente cuando llega uno nuevo. La app consulta cada minuto mientras está abierta.

- **Pagos de tarjeta:** para cada tarjeta con día de pago y deuda, se crea un aviso 5 días antes, 1 día antes y el mismo día del vencimiento, con lo que debes pagar (saldo del estado de cuenta pendiente, o la deuda total si no hay día de corte). Un aviso por tarjeta, fecha y etapa; si lo quitas no reaparece.
- **Precios objetivo:** en el detalle de cada activo del Portafolio puedes fijar un límite inferior y/o un objetivo superior, pausarlos o quitarlos. Se revisan tras cada actualización de precios (cada hora), al actualizar a mano y al fijar un precio manual. Avisa una vez al cruzar el límite y se vuelve a armar cuando el precio regresa al rango.
- **Con la app cerrada (en el teléfono, push):** en la campana, «Activar avisos en este dispositivo». En iPhone funciona con FIPO agregada a la pantalla de inicio (iOS 16.4 o más nuevo) y abierta desde ese ícono. Cada aviso nuevo (pago de tarjeta, cargo recurrente registrado, precio objetivo, reporte en vigilancia) llega como notificación del sistema y al tocarla abre FIPO en esa pantalla. Es Web Push estándar (cifrado RFC 8291 y VAPID RFC 8292, implementado con `cryptography`; el cifrado se verificó contra el vector de prueba oficial del RFC). Las llaves VAPID se generan solas en la carpeta de datos (`vapid.pem`). Solo se envía a servicios de push conocidos (Apple, Google, Mozilla, Microsoft).
- **Revisión automática (necesaria para el push con la app cerrada):** alguien tiene que «despertar» a FIPO para que revise pagos, cargos y precios. En servidores con proceso continuo lo hace el hilo interno; en el plan gratis de PythonAnywhere (cuentas nuevas sin tareas programadas) se usa un servicio externo gratuito como cron-job.org que visita cada 30 minutos `https://<tu-sitio>/api/cron/<clave>`. La clave es secreta (`cron.key` en la carpeta de datos), la dirección aparece en la campana y al final del instalador, no muestra datos y si se llama seguido no repite el trabajo. **Límite:** el envío real a los servidores de Apple no se pudo probar desde el entorno de desarrollo (sin acceso a apple.com); el dominio `.apple.com` sí está en la lista de sitios permitidos del plan gratis de PythonAnywhere.
- **Con la app cerrada (correo):** en el panel de avisos, activa «Recibir también por correo». Cada aviso nuevo se manda a tu correo aunque FIPO esté cerrado; el servidor revisa cada hora. Requiere que el servidor tenga SMTP configurado (`FIPO_SMTP_*`); sin él, la casilla aparece desactivada y los avisos solo se ven dentro de FIPO. Un correo por aviso, sin repetir. El envío por SMTP se probó contra un servidor SMTP local de prueba, no contra Gmail u otro proveedor real.
- **No incluido:** notificaciones push al teléfono (requieren HTTPS, service worker y claves VAPID, y no pude probarlas aquí). Opcionalmente puedes activar avisos del navegador, que solo aparecen con FIPO abierto en una pestaña. En la vista previa (sin servidor) no hay correo y los avisos se calculan al abrirla o al fijar un precio.

## Reglas financieras implementadas

- Los saldos **no se guardan**: `saldo = saldo inicial + suma de efectos de los movimientos`, así que siempre pueden reconstruirse.
- Ingreso: suma a la cuenta. Gasto: resta. Reembolso: suma a la cuenta y **reduce el gasto** de su categoría.
- Transferencia: una sola fila que resta al origen y suma al destino. **No es ingreso ni gasto.** Entre monedas distintas se pide el importe recibido.
- Ajuste de saldo: movimiento firmado y registrado; no cuenta como ingreso ni gasto. No hay forma de cambiar un saldo sin dejar rastro.
- Cada operación que toca varias filas usa una transacción atómica de la base de datos (todo o nada).
- Las cuentas en otra moneda no se suman a los totales del dashboard (no hay tipo de cambio configurado); se avisa en pantalla.

## Seguridad

Contraseñas con hash (scrypt/PBKDF2 de Werkzeug), sesión en cookie firmada `HttpOnly` + `SameSite=Lax`, cabecera `X-Requested-With` obligatoria en operaciones que modifican datos (defensa CSRF), límite de intentos de acceso, cierre de las demás sesiones al cambiar contraseña, cabeceras CSP/`X-Frame-Options`, y **cada consulta filtrada por `user_id` en el servidor**. Las pruebas verifican que un usuario no puede leer, modificar, eliminar ni usar cuentas o categorías de otro. El CSV neutraliza fórmulas (`=`, `+`, `-`, `@`).

*Nota técnica:* en esta sesión el acceso a npm y PyPI estaba bloqueado, por lo que no se pudieron usar Next.js/React/Tailwind/Supabase. Se construyó con Flask + SQLite + JavaScript nativo, sin dependencias externas ni CDN. Las políticas de aislamiento están en el servidor (equivalente funcional a RLS); si migras a Supabase, deberás portarlas a políticas RLS.

## Límites conocidos (por honestidad)

- Yahoo Finance no tiene API oficial; puede fallar o limitar. La consulta real no pudo probarse en el entorno de desarrollo (sin internet saliente).
- El OCR se probó con imágenes de prueba limpias; fotos reales arrugadas o con poca luz leerán peor. Los PDF de bancos varían mucho.
- Sin tipo de cambio: las cuentas, deudas y metas en otra moneda no se suman a los totales.
- No hay notificaciones push ni cobros recurrentes automáticos; los avisos aparecen dentro de la app y, si configuras SMTP, también llegan por correo (ver la sección Avisos).
- SQLite basta para uso personal o un grupo pequeño; para muchos usuarios conviene migrar a PostgreSQL.
- La imagen Docker y el despliegue en Render no pudieron construirse aquí (sin Docker en marcha ni acceso a PyPI); los archivos están escritos con configuración estándar y conviene probarlos una vez.
- **Evolución del patrimonio neto y de deudas (Análisis):** los meses pasados solo reconstruyen efectivo, cuentas de inversión y deudas; el valor de mercado del portafolio **no** tiene historial (solo se guarda la cotización de hoy), así que esos meses no lo incluyen y el patrimonio de hoy puede verse más alto que el último punto de la gráfica — la diferencia es justamente el valor actual del portafolio. Se indica en la propia gráfica.
- **Patrimonio neto y bienes no financieros:** FIPO solo suma cuentas, portafolio y resta deudas — nunca el valor de un auto, una casa u otro bien que no sea una cuenta dentro de la app. Si registras una deuda (por ejemplo un préstamo de auto) sin la cuenta correspondiente que reciba ese dinero, el patrimonio neto (y su gráfica de evolución) baja de golpe por el monto completo del préstamo, aunque en la vida real tengas el bien que compraste con él. Es el mismo criterio que usan la mayoría de rastreadores de patrimonio (solo activos financieros), pero conviene tenerlo presente al leer la gráfica.
- **Deuda/ingreso, fondo de emergencia, burn rate y runway** son cálculos simplificados y transparentes (no sustituyen asesoría financiera): deuda/ingreso usa solo el pago mensual fijo de tus deudas activas (no un pago mínimo de tarjeta, que no existe como dato); fondo de emergencia y runway comparan tu efectivo disponible contra tu gasto (o déficit) promedio de los meses con datos, así que con poco historial el número puede ser poco representativo.
- **Detector de gastos recurrentes / suscripciones** es una heurística (misma cuenta y descripción, sin dígitos, en 3 de los últimos 4 meses con variación de importe menor a 15%): puede no detectar un cobro si cambia de descripción, o agrupar dos gastos distintos si coinciden en texto y monto.
- **Financial Insights** y el **puntaje de salud financiera** son reglas simples sobre tus propios números (umbrales y una fórmula, documentados arriba), no un modelo financiero ni un consejo profesional; con pocos meses de datos, varios insights no aparecen porque no hay suficiente historial para calcularlos con confianza.

## Estructura

```
app.py            servidor Flask: autenticación, API JSON, seguridad
cards.py          planes a meses de tarjetas (MSI, con intereses, diferidos) y cargos recurrentes
more.py           tarjetas, deudas, presupuestos, análisis, reportes, metas, tablas y comprobantes (OCR)
mailer.py         envío SMTP
notify.py         avisos: recordatorios de tarjeta, precios objetivo, avisos push y revisión automática (/api/cron)
webpush.py        Web Push (VAPID + cifrado aes128gcm) sin dependencias extra
importer.py       lectura de CSV/Excel/PDF de estados de cuenta
portfolio.py      posiciones, costo promedio, precios (Yahoo) y actualización horaria
health.py         puntaje de salud financiera (distribución objetivo 50/25/25)
ledger.py         reglas financieras, saldos, validación, dashboard, demo
db.py             esquema SQLite y transacciones atómicas
templates/        index.html (shell de la aplicación)
static/           style.css, core.js, app.js (vistas base), extra.js (portafolio, importación), more.js (fases 2 y 3), notify.js (campana y objetivos)
Dockerfile, docker-compose.yml, render.yaml, run.sh   despliegue y arranque (pago, con Docker)
deploy/instalar_pythonanywhere.sh  instalador de un solo comando para PythonAnywhere (gratis)
deploy/pa_setup.py              configura la app web con la API oficial de PythonAnywhere
deploy/pythonanywhere_wsgi.py   archivo WSGI (el instalador lo copia solo; no hay que editarlo)
tests/            test_finance.py, test_health_score.py, test_import_portfolio.py, test_phases.py, test_notify.py, e2e*.py (navegador)
```
