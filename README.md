# Bingo Ganga

Aplicación web estática conectada al proyecto Supabase `bingo ganga`.

## Archivos principales

- `index.html`: página pública original de compra, reservas, consultas, referidos, aprobados, top y ganadores.
- `admin.html`: panel original separado del `index`, protegido por Supabase Auth y el rol `app_metadata.role = admin`.
- `script.js`: JavaScript original suministrado, con las adaptaciones internas necesarias para la separación y la seguridad de Supabase.
- `styles.css`: CSS original suministrado, con extensiones puntuales que respetan su formato y colores.
- `supabase.sql`: esquema, funciones RPC, RLS, permisos, índices y políticas de Storage.
- `supabase/migrations/`: migraciones versionadas; incluye el canje seguro de cartones gratis por referidos.
- `supabase/functions/`: código de las tres Edge Functions usadas por el acceso administrativo.
- `privacidad.html` y `terminos.html`: información legal para los jugadores.

## Seguridad

- El navegador usa únicamente una clave publicable.
- Las tablas con datos personales no tienen lectura anónima directa.
- La vista pública consume RPC que devuelven únicamente datos autorizados.
- Los comprobantes se guardan en un bucket privado y el administrador los abre mediante URL firmada de corta duración.
- Reservar, inscribir, aprobar, rechazar y eliminar se ejecuta de forma transaccional en PostgreSQL.
- El precio y las promociones se calculan nuevamente en la base de datos; el monto enviado por el navegador no se toma como autoridad.
- El panel valida el rol administrativo desde `app_metadata`, no desde metadatos modificables por el usuario.

## Cartón gratis por referidos

- Al completar 5 referidos aprobados aparece el botón `Cartón gratis`.
- El jugador confirma su teléfono, reserva durante 5 minutos un cartón libre y adjunta una captura.
- La solicitud conserva el cartón hasta que el administrador la apruebe o rechace.
- Al aprobar se consumen exactamente 5 referidos; cualquier sobrante se mantiene para la siguiente barra.
- Al rechazar se libera el cartón y no se consume ningún referido.
- La base de datos verifica la elegibilidad al enviar y nuevamente al aprobar; la captura es solo respaldo visual.

## Publicación

El sitio puede publicarse con GitHub Pages porque no requiere servidor propio. Después de modificar la base, aplica `supabase.sql` en el proyecto correspondiente y revisa los asesores de seguridad y rendimiento de Supabase.

## Administración

La administración se abre desde `admin.html`. La cuenta debe existir en Supabase Auth y tener:

```json
{ "role": "admin" }
```

dentro de `app_metadata`.

El `index.html` no contiene el formulario de acceso ni el panel administrativo. Ambos documentos cargan el mismo `script.js` original, que detecta en cuál página se encuentra y activa únicamente las funciones correspondientes.
