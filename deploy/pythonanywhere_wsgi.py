# Archivo WSGI de FIPO para PythonAnywhere (plan gratis).
#
# NO tienes que editar nada: el instalador (deploy/instalar_pythonanywhere.sh)
# lo copia solo a /var/www/<tu-dominio>_wsgi.py. Detecta tu usuario por su cuenta.
#
# Por qué así: el plan gratis ("Beginner") no tiene una pantalla para definir
# variables de entorno, así que aquí se definen antes de importar la app.
# La clave secreta de las sesiones la genera FIPO sola la primera vez y la
# guarda en ~/fipo_data/secret.key (no hace falta inventar una).

import os
import pwd
import sys

HOME = pwd.getpwuid(os.getuid()).pw_dir          # /home/<tu-usuario>
PROJECT = os.path.join(HOME, "fipo")
if PROJECT not in sys.path:
    sys.path.insert(0, PROJECT)

# Carpeta persistente para la base de datos, la clave y los comprobantes
# (fuera de ~/fipo, para que al actualizar el código no se toquen tus datos).
os.environ.setdefault("FIPO_DATA_DIR", os.path.join(HOME, "fipo_data"))
os.environ.setdefault("FIPO_HTTPS", "1")          # <usuario>.pythonanywhere.com ya sirve HTTPS
os.environ.setdefault("FIPO_NO_SCHEDULER", "1")   # el plan gratis no permite tareas de fondo;
                                                  # usa el botón "Actualizar precios" dentro de FIPO

from app import app as application  # noqa: E402  (import al final: necesita las líneas de arriba)
