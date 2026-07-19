# Bingo Ganga

Aplicación web de bingo con sitio público y administración separada.

- `index.html` y `public.js`: compra, reserva atómica y consulta de cartones.
- `admin.html` y `admin.js`: panel protegido por Supabase Auth.
- `supabase-config.js`: URL y clave publicable de Supabase.
- `styles.css`: estilos responsivos con los colores originales.

El frontend utiliza únicamente la clave publicable de Supabase. Las operaciones administrativas requieren un JWT con `app_metadata.role = "admin"`.
