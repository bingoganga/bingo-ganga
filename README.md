# Bingo Ganga

Aplicación web estática conectada al proyecto Supabase `bingo ganga`.

## Archivos principales

- `index.html` y `public.js`: compra, promociones, reserva atómica, comprobantes, consultas, referidos, aprobados, top y ganadores.
- `admin.html` y `admin.js`: panel separado protegido por Supabase Auth y el rol `app_metadata.role = admin`.
- `supabase-config.js`: URL y clave publicable del proyecto. No contiene claves secretas.
- `supabase.sql`: esquema, funciones RPC, RLS, permisos, índices y políticas de Storage.
- `styles.css`: interfaz adaptable con los colores originales de Bingo Ganga.
- `privacidad.html` y `terminos.html`: información legal para los jugadores.

## Seguridad

- El navegador usa únicamente una clave publicable.
- Las tablas con datos personales no tienen lectura anónima directa.
- La vista pública consume RPC que devuelven únicamente datos autorizados.
- Los comprobantes se guardan en un bucket privado y el administrador los abre mediante URL firmada de corta duración.
- Reservar, inscribir, aprobar, rechazar y eliminar se ejecuta de forma transaccional en PostgreSQL.
- El precio y las promociones se calculan nuevamente en la base de datos; el monto enviado por el navegador no se toma como autoridad.
- El panel valida el rol administrativo desde `app_metadata`, no desde metadatos modificables por el usuario.

## Publicación

El sitio puede publicarse con GitHub Pages porque no requiere servidor propio. Después de modificar la base, aplica `supabase.sql` en el proyecto correspondiente y revisa los asesores de seguridad y rendimiento de Supabase.

## Administración

La administración se abre desde `admin.html`. La cuenta debe existir en Supabase Auth y tener:

```json
{ "role": "admin" }
```

dentro de `app_metadata`.

