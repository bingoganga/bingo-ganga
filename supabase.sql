-- Bingo Ganga - esquema seguro y funciones completas para Supabase.
-- Este archivo es idempotente y representa el estado esperado de producción.

create schema if not exists private;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- Tablas base. Estas definiciones permiten aplicar el archivo completo en un
-- proyecto Supabase nuevo y también son seguras sobre el proyecto existente.
create table if not exists public.admins (
  id bigint generated always as identity primary key,
  usuario varchar,
  clave_hash text
);

create table if not exists public.cartones (
  numero bigint primary key check (numero > 0),
  ocupado boolean,
  cedula text,
  partida_id bigint,
  reservado_at timestamptz default now(),
  reservado_hasta timestamptz default (now() + interval '10 minutes')
);

create table if not exists public.configuracion (
  clave text primary key,
  total_cartones bigint,
  valore text,
  valor boolean
);

create table if not exists public.ganadores (
  id bigint generated always as identity primary key,
  telefono text,
  nombre text,
  cedula text,
  cartones text,
  premio varchar,
  fecha date,
  created_at timestamptz not null default now()
);

create table if not exists public.inscripciones (
  id bigint generated always as identity primary key,
  nombre text,
  telefono text,
  cartones text[],
  cedula text,
  referido text,
  estado text not null default 'pendiente',
  comprobante varchar,
  partida_id bigint,
  referencia4dig text,
  monto_bs numeric(12,2) not null default 0,
  pago_banco text,
  pago_telefono text,
  pago_cedula text,
  usa_promo boolean not null default false,
  promo_desc text,
  precio_unitario_bs numeric(12,2),
  created_at timestamptz not null default now(),
  acepta_terminos boolean not null default false,
  terminos_version text
);

-- Sesión administrativa de un solo dispositivo. Los tokens se guardan
-- únicamente como hashes SHA-256 y solo las Edge Functions de servicio
-- pueden leer o modificar esta tabla.
create table if not exists public.admin_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  device_id text not null check (
    length(btrim(device_id)) between 8 and 200
  ),
  session_token_hash text not null unique check (
    session_token_hash ~ '^[0-9a-f]{64}$'
  ),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists admin_sessions_expires_at_idx
  on public.admin_sessions (expires_at);

alter table public.admin_sessions enable row level security;
revoke all on table public.admin_sessions from public, anon, authenticated;
grant all on table public.admin_sessions to service_role;

alter table public.inscripciones
  add column if not exists referencia4dig text,
  add column if not exists monto_bs numeric(12,2) not null default 0,
  add column if not exists pago_banco text,
  add column if not exists pago_telefono text,
  add column if not exists pago_cedula text,
  add column if not exists usa_promo boolean not null default false,
  add column if not exists promo_desc text,
  add column if not exists precio_unitario_bs numeric(12,2),
  add column if not exists acepta_terminos boolean not null default false,
  add column if not exists terminos_version text,
  add column if not exists created_at timestamptz not null default now();

alter table public.cartones
  add column if not exists reservado_at timestamptz default now(),
  add column if not exists reservado_hasta timestamptz default (now() + interval '10 minutes'),
  add column if not exists reserva_token_hash text;

alter table public.ganadores
  add column if not exists created_at timestamptz not null default now();

create or replace function private.hash_reserva_token(_token text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select encode(extensions.digest(_token, 'sha256'), 'hex');
$$;

revoke all on function private.hash_reserva_token(text)
  from public, anon, authenticated;

update public.inscripciones
set estado = 'pendiente'
where estado is null or btrim(estado) = '';

alter table public.inscripciones
  alter column estado set default 'pendiente',
  alter column estado set not null;

-- Unifica las claves heredadas sin perder el precio configurado por el negocio.
insert into public.configuracion (clave, valore, valor)
values
  ('total_cartones', '300', null),
  ('precio_carton', '250', null),
  ('modo_cartones', 'libre', null),
  ('cartones_obligatorios', '1', null),
  ('ventas_abierta', null, true),
  ('tiempo_reserva_minutos', '10', null),
  ('mostrar_barra_progreso', 'true', null),
  ('meta_referidos', '10', null),
  ('terminos_version', '2026-07-19', null),
  ('link_whatsapp', '', null),
  ('youtube_live', '', null),
  ('youtube_url', 'https://www.youtube.com/@bingoandinoenvivo', null),
  ('facebook_url', 'https://www.facebook.com/profile.php?id=61576936027458', null),
  ('instagram_url', 'https://www.instagram.com/bingoandino75/', null),
  ('whatsapp_contacto', 'https://wa.me/584247221608', null),
  ('pago_banco', 'Banco de Venezuela (0102)', null),
  ('pago_telefono', '0424-4687496', null),
  ('pago_cedula', '25476241', null),
  ('imagen_premios_inicio', '', null)
on conflict (clave) do nothing;

update public.configuracion destino
set valore = origen.valore
from public.configuracion origen
where destino.clave = 'precio_carton'
  and origen.clave = 'precio_por_carton'
  and coalesce(nullif(destino.valore, '')::numeric, 0) = 0
  and coalesce(nullif(origen.valore, '')::numeric, 0) > 0;

update public.configuracion destino
set valor = origen.valor
from public.configuracion origen
where destino.clave = 'ventas_abierta'
  and origen.clave = 'ventas_abiertas'
  and destino.valor is null;

insert into public.configuracion (clave, valore, valor)
select 'promo' || n || '_activa', 'false', null::boolean from generate_series(1,4) n
union all
select 'promo' || n || '_descripcion', '', null::boolean from generate_series(1,4) n
union all
select 'promo' || n || '_cantidad', '0', null::boolean from generate_series(1,4) n
union all
select 'promo' || n || '_precio', '0', null::boolean from generate_series(1,4) n
on conflict (clave) do nothing;

-- El acceso administrativo ahora depende exclusivamente de Supabase Auth.
delete from public.configuracion
where clave in ('clave_admin', 'clave_reinicio', 'clave_borrar_cartones', 'precio_por_carton', 'ventas_abiertas', '1');

create index if not exists inscripciones_cedula_created_idx
  on public.inscripciones (cedula, created_at desc);
create index if not exists inscripciones_estado_created_idx
  on public.inscripciones (estado, created_at desc);
create index if not exists inscripciones_referido_aprobado_idx
  on public.inscripciones (referido, cedula) where estado = 'aprobado';
create index if not exists inscripciones_cartones_gin_idx
  on public.inscripciones using gin (cartones);
create unique index if not exists inscripciones_comprobante_unique_idx
  on public.inscripciones (comprobante) where comprobante is not null;
create index if not exists cartones_cedula_idx on public.cartones (cedula);
create index if not exists cartones_reserva_expirada_idx
  on public.cartones (reservado_hasta) where reservado_hasta is not null;
create index if not exists ganadores_fecha_idx
  on public.ganadores (fecha desc, created_at desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'cartones_reserva_token_hash_valido'
      and conrelid = 'public.cartones'::regclass
  ) then
    alter table public.cartones
      add constraint cartones_reserva_token_hash_valido
      check (
        reserva_token_hash is null
        or reserva_token_hash ~ '^[0-9a-f]{64}$'
      );
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'inscripciones_estado_valido'
      and conrelid = 'public.inscripciones'::regclass
  ) then
    alter table public.inscripciones
      add constraint inscripciones_estado_valido
      check (estado in ('pendiente','aprobado','rechazado'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'inscripciones_monto_no_negativo'
      and conrelid = 'public.inscripciones'::regclass
  ) then
    alter table public.inscripciones
      add constraint inscripciones_monto_no_negativo check (monto_bs >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'cartones_numero_positivo'
      and conrelid = 'public.cartones'::regclass
  ) then
    alter table public.cartones
      add constraint cartones_numero_positivo check (numero > 0);
  end if;
end $$;

create or replace function private.is_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((select auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin';
$$;

revoke all on function private.is_admin() from public, anon;
grant usage on schema private to anon, authenticated;
grant execute on function private.is_admin() to authenticated;

alter table public.admins enable row level security;
alter table public.cartones enable row level security;
alter table public.configuracion enable row level security;
alter table public.ganadores enable row level security;
alter table public.inscripciones enable row level security;

drop policy if exists public_read_cartones on public.cartones;
drop policy if exists public_read_config on public.configuracion;
drop policy if exists public_read_winners on public.ganadores;

drop policy if exists admin_all_admins on public.admins;
create policy admin_all_admins on public.admins for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
drop policy if exists admin_all_cartones on public.cartones;
create policy admin_all_cartones on public.cartones for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
drop policy if exists admin_all_configuracion on public.configuracion;
create policy admin_all_configuracion on public.configuracion for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
drop policy if exists admin_all_ganadores on public.ganadores;
create policy admin_all_ganadores on public.ganadores for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
drop policy if exists admin_all_inscripciones on public.inscripciones;
create policy admin_all_inscripciones on public.inscripciones for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

revoke all on public.admins, public.cartones, public.configuracion, public.ganadores, public.inscripciones
  from anon, authenticated;
grant select, insert, update, delete
  on public.admins, public.cartones, public.configuracion, public.ganadores, public.inscripciones
  to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Las funciones públicas devuelven solo columnas expresamente seguras.
drop function if exists public.rpc_configuracion_publica();
create function public.rpc_configuracion_publica()
returns table(clave text, valore text, valor boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select c.clave, c.valore, c.valor
  from public.configuracion c
  where c.clave = any(array[
    'total_cartones','precio_carton','modo_cartones','cartones_obligatorios',
    'ventas_abierta','tiempo_reserva_minutos','mostrar_barra_progreso',
    'meta_referidos','terminos_version','link_whatsapp','youtube_live',
    'youtube_url','facebook_url','instagram_url','whatsapp_contacto',
    'pago_banco','pago_telefono','pago_cedula','imagen_premios_inicio'
  ]) or c.clave ~ '^promo[1-4]_(activa|descripcion|cantidad|precio)$'
  order by c.clave;
$$;

drop function if exists public.rpc_cartones_ocupados();
create function public.rpc_cartones_ocupados()
returns table(numero bigint)
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.cartones c
  where c.reservado_hasta is not null
    and c.reservado_hasta < now()
    and not exists (
      select 1 from public.inscripciones i
      where i.estado in ('pendiente','aprobado')
        and c.numero::text = any(i.cartones)
    );

  return query select c.numero from public.cartones c order by c.numero;
end;
$$;

drop function if exists public.rpc_ganadores_publicos();
create function public.rpc_ganadores_publicos()
returns table(nombre text, cartones text, premio text, fecha date)
language sql
stable
security definer
set search_path = ''
as $$
  select g.nombre, g.cartones, g.premio::text, g.fecha
  from public.ganadores g
  order by g.fecha desc nulls last, g.created_at desc
  limit 100;
$$;

drop function if exists public.rpc_top_compradores();
create function public.rpc_top_compradores()
returns table(nombre text, cedula_mascara text, total_cartones bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select min(i.nombre), '****' || right(i.cedula, 4), sum(cardinality(i.cartones))::bigint
  from public.inscripciones i
  where i.estado = 'aprobado'
  group by i.cedula
  order by sum(cardinality(i.cartones)) desc, min(i.nombre)
  limit 5;
$$;

drop function if exists public.rpc_resumen_referidos(text);
create function public.rpc_resumen_referidos(_cedula text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'aprobados', count(distinct i.cedula),
    'meta', coalesce((select nullif(c.valore,'')::integer from public.configuracion c where c.clave='meta_referidos'), 10)
  )
  from public.inscripciones i
  where i.estado = 'aprobado'
    and i.referido = regexp_replace(coalesce(_cedula,''), '[^0-9]', '', 'g');
$$;

drop function if exists public.rpc_reservar_carton(bigint,text);
drop function if exists public.rpc_reservar_carton(bigint,text,text);
create function public.rpc_reservar_carton(
  _numero bigint,
  _cedula text,
  _reserva_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer;
  v_minutos integer;
  v_expira timestamptz;
  v_cedula text := regexp_replace(coalesce(_cedula,''), '[^0-9]', '', 'g');
  v_token_hash text;
  v_ventas boolean;
begin
  if length(v_cedula) < 5 or length(v_cedula) > 14
     or coalesce(_reserva_token,'') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('exito',false,'mensaje','Datos de reserva inválidos');
  end if;

  v_token_hash := private.hash_reserva_token(_reserva_token);

  select coalesce(c.valor, lower(c.valore) in ('true','1','si','sí'))
  into v_ventas from public.configuracion c where c.clave='ventas_abierta';
  if v_ventas is not true then
    return jsonb_build_object('exito',false,'mensaje','Las ventas están cerradas');
  end if;

  select coalesce(nullif(c.valore,'')::integer, 300)
  into v_total from public.configuracion c where c.clave='total_cartones';
  select least(30, greatest(5, coalesce(nullif(c.valore,'')::integer, 10)))
  into v_minutos from public.configuracion c where c.clave='tiempo_reserva_minutos';

  if _numero < 1 or _numero > coalesce(v_total,300) then
    return jsonb_build_object('exito',false,'mensaje','Cartón fuera de rango');
  end if;

  delete from public.cartones c
  where c.numero = _numero
    and c.reservado_hasta is not null
    and c.reservado_hasta < now()
    and not exists (
      select 1 from public.inscripciones i
      where i.estado in ('pendiente','aprobado') and _numero::text = any(i.cartones)
    );

  insert into public.cartones(
    numero,ocupado,cedula,reservado_at,reservado_hasta,reserva_token_hash
  )
  values (
    _numero,true,v_cedula,now(),
    now() + make_interval(mins => coalesce(v_minutos,10)),v_token_hash
  )
  on conflict (numero) do update
    set reservado_hasta = excluded.reservado_hasta,
        reservado_at = now()
    where public.cartones.cedula = v_cedula
      and public.cartones.reservado_hasta is not null
      and public.cartones.reserva_token_hash = v_token_hash
  returning reservado_hasta into v_expira;

  if v_expira is not null then
    return jsonb_build_object('exito',true,'numero',_numero,'expira',v_expira);
  end if;

  return jsonb_build_object('exito',false,'mensaje','Ese cartón ya está ocupado');
end;
$$;

drop function if exists public.rpc_reservar_cartones_aleatorios(integer,text,bigint);
drop function if exists public.rpc_reservar_cartones_aleatorios(integer,text,text,bigint);
create function public.rpc_reservar_cartones_aleatorios(
  _cantidad integer,
  _cedula text,
  _reserva_token text,
  _partida_id bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer;
  v_minutos integer;
  v_num bigint;
  v_insertado bigint;
  v_resultado bigint[] := array[]::bigint[];
  v_cedula text := regexp_replace(coalesce(_cedula,''), '[^0-9]', '', 'g');
  v_token_hash text;
  v_ventas boolean;
begin
  if length(v_cedula) < 5 or _cantidad < 1 or _cantidad > 100
     or coalesce(_reserva_token,'') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('exito',false,'mensaje','Solicitud inválida');
  end if;

  v_token_hash := private.hash_reserva_token(_reserva_token);

  select coalesce(c.valor, lower(c.valore) in ('true','1','si','sí'))
  into v_ventas from public.configuracion c where c.clave='ventas_abierta';
  if v_ventas is not true then
    return jsonb_build_object('exito',false,'mensaje','Las ventas están cerradas');
  end if;

  select coalesce(nullif(c.valore,'')::integer,300) into v_total
  from public.configuracion c where c.clave='total_cartones';
  select least(30,greatest(5,coalesce(nullif(c.valore,'')::integer,10))) into v_minutos
  from public.configuracion c where c.clave='tiempo_reserva_minutos';

  delete from public.cartones c
  where c.reservado_hasta is not null and c.reservado_hasta < now()
    and not exists (
      select 1 from public.inscripciones i
      where i.estado in ('pendiente','aprobado') and c.numero::text = any(i.cartones)
    );

  for v_num in
    select s.n
    from generate_series(1,coalesce(v_total,300)) as s(n)
    where not exists (select 1 from public.cartones c where c.numero=s.n)
    order by random()
  loop
    v_insertado := null;
    insert into public.cartones(
      numero,ocupado,cedula,partida_id,reservado_at,reservado_hasta,reserva_token_hash
    )
    values(
      v_num,true,v_cedula,_partida_id,now(),
      now()+make_interval(mins=>coalesce(v_minutos,10)),v_token_hash
    )
    on conflict(numero) do nothing
    returning numero into v_insertado;

    if v_insertado is not null then
      v_resultado := array_append(v_resultado,v_insertado);
      exit when cardinality(v_resultado) = _cantidad;
    end if;
  end loop;

  if cardinality(v_resultado) <> _cantidad then
    delete from public.cartones c
    where c.numero = any(v_resultado) and c.cedula=v_cedula
      and c.reservado_hasta is not null
      and c.reserva_token_hash=v_token_hash;
    return jsonb_build_object('exito',false,'mensaje','No quedan suficientes cartones disponibles');
  end if;

  return jsonb_build_object(
    'exito',true,
    'cartones',(select jsonb_agg(x order by x) from unnest(v_resultado) x),
    'expira',now()+make_interval(mins=>coalesce(v_minutos,10))
  );
end;
$$;

drop function if exists public.rpc_liberar_reserva(bigint,text);
drop function if exists public.rpc_liberar_reserva(bigint,text,text);
create function public.rpc_liberar_reserva(
  _numero bigint,
  _cedula text,
  _reserva_token text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.cartones c
  where c.numero=_numero
    and c.cedula=regexp_replace(coalesce(_cedula,''), '[^0-9]', '', 'g')
    and c.reserva_token_hash=private.hash_reserva_token(_reserva_token)
    and c.reservado_hasta is not null
    and not exists (
      select 1 from public.inscripciones i
      where i.estado in ('pendiente','aprobado') and _numero::text=any(i.cartones)
    );
  return found;
end;
$$;

drop function if exists public.rpc_liberar_todas_reservas(text);
drop function if exists public.rpc_liberar_todas_reservas(text,text);
create function public.rpc_liberar_todas_reservas(
  _cedula text,
  _reserva_token text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_count integer;
begin
  delete from public.cartones c
  where c.cedula=regexp_replace(coalesce(_cedula,''), '[^0-9]', '', 'g')
    and c.reserva_token_hash=private.hash_reserva_token(_reserva_token)
    and c.reservado_hasta is not null
    and not exists (
      select 1 from public.inscripciones i
      where i.estado in ('pendiente','aprobado') and c.numero::text=any(i.cartones)
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

drop function if exists public.rpc_renovar_reservas(text,bigint[]);
drop function if exists public.rpc_renovar_reservas(text,bigint[],text);
create function public.rpc_renovar_reservas(
  _cedula text,
  _cartones bigint[],
  _reserva_token text
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare v_expira timestamptz; v_minutos integer;
begin
  if cardinality(_cartones) < 1 or cardinality(_cartones) > 100 then return null; end if;
  select least(30,greatest(5,coalesce(nullif(c.valore,'')::integer,10))) into v_minutos
  from public.configuracion c where c.clave='tiempo_reserva_minutos';
  v_expira := now()+make_interval(mins=>coalesce(v_minutos,10));
  update public.cartones c
  set reservado_hasta=v_expira
  where c.numero=any(_cartones)
    and c.cedula=regexp_replace(coalesce(_cedula,''), '[^0-9]', '', 'g')
    and c.reserva_token_hash=private.hash_reserva_token(_reserva_token)
    and c.reservado_hasta is not null
    and c.reservado_hasta > now()-interval '30 seconds';
  if found then return v_expira; end if;
  return null;
end;
$$;

drop function if exists public.rpc_crear_inscripcion(text,text,text,text,bigint[],text,text,numeric,text,text,text);
drop function if exists public.rpc_crear_inscripcion(text,text,text,text,bigint[],text,text,numeric,text,text,text,integer,boolean);
drop function if exists public.rpc_crear_inscripcion(text,text,text,text,bigint[],text,text,numeric,text,text,text,integer,boolean,text);
create function public.rpc_crear_inscripcion(
  _nombre text,
  _telefono text,
  _cedula text,
  _referido text,
  _cartones bigint[],
  _referencia4dig text,
  _comprobante text,
  _monto_bs numeric,
  _pago_banco text default null,
  _pago_telefono text default null,
  _pago_cedula text default null,
  _promo_id integer default null,
  _acepta_terminos boolean default false,
  _reserva_token text default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
  v_total integer;
  v_reservadas integer;
  v_unicas integer;
  v_precio numeric(12,2);
  v_monto numeric(12,2);
  v_promo_activa boolean := false;
  v_promo_cantidad integer := 0;
  v_promo_precio numeric(12,2) := 0;
  v_promo_desc text;
  v_terminos text;
  v_ventas boolean;
  v_cedula text := regexp_replace(coalesce(_cedula,''), '[^0-9]', '', 'g');
  v_referido text := regexp_replace(coalesce(_referido,''), '[^0-9]', '', 'g');
  v_token_hash text;
begin
  if _acepta_terminos is not true then raise exception 'Debes aceptar los términos y la política de privacidad'; end if;
  if length(btrim(coalesce(_nombre,''))) < 3 or length(btrim(_nombre)) > 90 then raise exception 'Nombre inválido'; end if;
  if length(regexp_replace(coalesce(_telefono,''), '[^0-9]', '', 'g')) < 7 then raise exception 'Teléfono inválido'; end if;
  if length(v_cedula) < 5 or length(v_cedula) > 14 then raise exception 'Cédula inválida'; end if;
  if v_referido = v_cedula then raise exception 'No puedes referirte a ti mismo'; end if;
  if cardinality(_cartones) < 1 or cardinality(_cartones) > 100 then raise exception 'Cantidad de cartones inválida'; end if;
  if coalesce(_referencia4dig,'') !~ '^[0-9]{4}$' then raise exception 'Referencia inválida'; end if;
  if coalesce(_comprobante,'') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}/[0-9a-fA-F-]{36}\.(jpg|jpeg|png|webp)$' then raise exception 'Comprobante inválido'; end if;
  if coalesce(_reserva_token,'') !~ '^[0-9a-f]{64}$' then raise exception 'Token de reserva inválido'; end if;

  v_token_hash := private.hash_reserva_token(_reserva_token);

  select count(distinct x) into v_unicas from unnest(_cartones) x;
  if v_unicas <> cardinality(_cartones) then raise exception 'Hay cartones repetidos'; end if;

  select coalesce(c.valor, lower(c.valore) in ('true','1','si','sí')) into v_ventas
  from public.configuracion c where c.clave='ventas_abierta';
  if v_ventas is not true then raise exception 'Las ventas están cerradas'; end if;

  select coalesce(nullif(c.valore,'')::integer,300) into v_total
  from public.configuracion c where c.clave='total_cartones';
  if exists(select 1 from unnest(_cartones) x where x < 1 or x > coalesce(v_total,300)) then
    raise exception 'Hay cartones fuera de rango';
  end if;

  perform 1 from public.cartones c where c.numero=any(_cartones) order by c.numero for update;
  select count(*) into v_reservadas
  from public.cartones c
  where c.numero=any(_cartones)
    and c.cedula=v_cedula
    and c.reservado_hasta is not null
    and c.reservado_hasta >= now()
    and c.reserva_token_hash=v_token_hash;
  if v_reservadas <> cardinality(_cartones) then
    raise exception 'Una reserva expiró o pertenece a otra persona';
  end if;

  if exists(
    select 1 from public.inscripciones i
    where i.estado in ('pendiente','aprobado')
      and i.cartones && array(select x::text from unnest(_cartones) x)
  ) then raise exception 'Hay cartones ya inscritos'; end if;

  if not exists(
    select 1 from storage.objects o
    where o.bucket_id='comprobantes' and o.name=_comprobante
  ) then raise exception 'No se encontró el comprobante subido'; end if;

  select greatest(0,coalesce(nullif(c.valore,'')::numeric,0)) into v_precio
  from public.configuracion c where c.clave='precio_carton';
  v_precio := coalesce(v_precio,0);
  v_monto := cardinality(_cartones) * v_precio;

  if _promo_id between 1 and 4 then
    select lower(coalesce(a.valore,'false')) in ('true','1','si','sí'),
           coalesce(nullif(q.valore,'')::integer,0),
           greatest(0,coalesce(nullif(p.valore,'')::numeric,0)),
           nullif(btrim(d.valore),'')
    into v_promo_activa,v_promo_cantidad,v_promo_precio,v_promo_desc
    from public.configuracion a
    join public.configuracion q on q.clave='promo'||_promo_id||'_cantidad'
    join public.configuracion p on p.clave='promo'||_promo_id||'_precio'
    join public.configuracion d on d.clave='promo'||_promo_id||'_descripcion'
    where a.clave='promo'||_promo_id||'_activa';

    if v_promo_activa and v_promo_cantidad=cardinality(_cartones) then
      v_monto := v_promo_precio;
    else
      v_promo_activa := false;
      v_promo_desc := null;
    end if;
  end if;

  select coalesce(nullif(c.valore,''),'2026-07-19') into v_terminos
  from public.configuracion c where c.clave='terminos_version';

  insert into public.inscripciones(
    nombre,telefono,cedula,referido,cartones,referencia4dig,comprobante,estado,
    monto_bs,pago_banco,pago_telefono,pago_cedula,usa_promo,promo_desc,
    precio_unitario_bs,acepta_terminos,terminos_version
  ) values (
    btrim(_nombre),btrim(_telefono),v_cedula,nullif(v_referido,''),
    array(select x::text from unnest(_cartones) x order by x),
    _referencia4dig,_comprobante,'pendiente',v_monto,
    nullif(left(btrim(coalesce(_pago_banco,'')),80),''),
    nullif(left(btrim(coalesce(_pago_telefono,'')),30),''),
    nullif(left(btrim(coalesce(_pago_cedula,'')),20),''),
    v_promo_activa,v_promo_desc,v_precio,true,v_terminos
  ) returning id into v_id;

  update public.cartones c
  set reservado_hasta=null,
      reserva_token_hash=null
  where c.numero=any(_cartones) and c.cedula=v_cedula;

  return v_id;
end;
$$;

drop function if exists public.rpc_consultar_jugadas(text);
create function public.rpc_consultar_jugadas(_cedula text)
returns table(estado text, cartones text[], monto_bs numeric, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select i.estado, i.cartones, i.monto_bs, i.created_at
  from public.inscripciones i
  where i.cedula=regexp_replace(coalesce(_cedula,''), '[^0-9]', '', 'g')
  order by i.created_at desc
  limit 20;
$$;

drop function if exists public.rpc_lista_aprobados();
create function public.rpc_lista_aprobados()
returns table(carton bigint, nombre text, cedula_mascara text)
language sql
stable
security definer
set search_path = ''
as $$
  select c::bigint, i.nombre, repeat('*',greatest(length(i.cedula)-4,0))||right(i.cedula,4)
  from public.inscripciones i
  cross join lateral unnest(i.cartones) c
  where i.estado='aprobado' and c ~ '^[0-9]+$'
  order by c::bigint;
$$;

drop function if exists public.rpc_listar_cartones_huerfanos(interval);
create function public.rpc_listar_cartones_huerfanos(_min_age interval default interval '5 minutes')
returns table(numero bigint, cedula text, reservado_at timestamptz, reservado_hasta timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select private.is_admin()) then raise exception 'Acceso denegado'; end if;
  return query
  select c.numero,c.cedula,c.reservado_at,c.reservado_hasta
  from public.cartones c
  where c.reservado_at < now()-greatest(_min_age,interval '5 minutes')
    and (c.reservado_hasta is null or c.reservado_hasta < now())
    and not exists (
      select 1 from public.inscripciones i
      where i.estado in ('pendiente','aprobado') and c.numero::text=any(i.cartones)
    )
  order by c.reservado_at;
end;
$$;

drop function if exists public.rpc_liberar_cartones_huerfanos(interval);
create function public.rpc_liberar_cartones_huerfanos(_min_age interval default interval '5 minutes')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_count integer;
begin
  if not (select private.is_admin()) then raise exception 'Acceso denegado'; end if;
  delete from public.cartones c
  where c.reservado_at < now()-greatest(_min_age,interval '5 minutes')
    and (c.reservado_hasta is null or c.reservado_hasta < now())
    and not exists (
      select 1 from public.inscripciones i
      where i.estado in ('pendiente','aprobado') and c.numero::text=any(i.cartones)
    );
  get diagnostics v_count=row_count;
  return v_count;
end;
$$;

drop function if exists public.rpc_admin_cambiar_estado(bigint,text);
create function public.rpc_admin_cambiar_estado(_id bigint, _estado text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v public.inscripciones%rowtype; v_num bigint; v_conflictos integer;
begin
  if not (select private.is_admin()) then raise exception 'Acceso denegado'; end if;
  if _estado not in ('pendiente','aprobado','rechazado') then raise exception 'Estado inválido'; end if;
  select * into v from public.inscripciones i where i.id=_id for update;
  if not found then raise exception 'Inscripción no encontrada'; end if;

  if _estado='rechazado' then
    delete from public.cartones c
    where c.cedula=v.cedula
      and c.numero::text=any(v.cartones)
      and c.reservado_hasta is null
      and not exists (
        select 1
        from public.inscripciones i
        where i.id<>_id
          and i.estado in ('pendiente','aprobado')
          and c.numero::text=any(i.cartones)
      );
  else
    select
      (select count(*)
       from public.cartones c
       where c.numero::text=any(v.cartones)
         and (c.cedula<>v.cedula or c.reservado_hasta is not null))
      +
      (select count(*)
       from public.inscripciones i
       where i.id<>_id
         and i.estado in ('pendiente','aprobado')
         and i.cartones && v.cartones)
    into v_conflictos;
    if v_conflictos>0 then raise exception 'Uno o más cartones ya pertenecen a otra persona'; end if;

    for v_num in select x::bigint from unnest(v.cartones) x where x ~ '^[0-9]+$'
    loop
      insert into public.cartones(numero,ocupado,cedula,reservado_at,reservado_hasta)
      values(v_num,true,v.cedula,now(),null)
      on conflict(numero) do update
        set ocupado=true,cedula=excluded.cedula,reservado_hasta=null
        where public.cartones.cedula=excluded.cedula;
    end loop;
  end if;

  update public.inscripciones set estado=_estado where id=_id;
  return jsonb_build_object('exito',true,'estado',_estado);
end;
$$;

drop function if exists public.rpc_eliminar_inscripcion_seguro(bigint);
create function public.rpc_eliminar_inscripcion_seguro(_id bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v public.inscripciones%rowtype;
begin
  if not (select private.is_admin()) then raise exception 'Acceso denegado'; end if;
  select * into v from public.inscripciones i where i.id=_id for update;
  if not found then raise exception 'Inscripción no encontrada'; end if;
  delete from public.cartones c
  where c.cedula=v.cedula
    and c.numero::text=any(v.cartones)
    and c.reservado_hasta is null
    and not exists (
      select 1
      from public.inscripciones i
      where i.id<>_id
        and i.estado in ('pendiente','aprobado')
        and c.numero::text=any(i.cartones)
    );
  delete from public.inscripciones where id=_id;
  return v.comprobante::text;
end;
$$;

drop function if exists public.rpc_admin_reiniciar_ventas(boolean);
create function public.rpc_admin_reiniciar_ventas(_incluir_ganadores boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_ins integer; v_cart integer; v_gan integer:=0;
begin
  if not (select private.is_admin()) then raise exception 'Acceso denegado'; end if;
  delete from public.inscripciones; get diagnostics v_ins=row_count;
  delete from public.cartones; get diagnostics v_cart=row_count;
  if _incluir_ganadores then delete from public.ganadores; get diagnostics v_gan=row_count; end if;
  return jsonb_build_object('inscripciones',v_ins,'cartones',v_cart,'ganadores',v_gan);
end;
$$;

drop function if exists public.rpc_admin_lanzar_cohetes();
create function public.rpc_admin_lanzar_cohetes()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select private.is_admin()) then raise exception 'Acceso denegado'; end if;
  perform realtime.send(
    jsonb_build_object('lanzado_en', now()),
    'cohetes',
    'bingo-ganga-celebraciones',
    false
  );
  return true;
end;
$$;

-- Cierra el EXECUTE implícito que PostgreSQL concede a PUBLIC.
revoke all on function public.rpc_configuracion_publica() from public, anon, authenticated;
revoke all on function public.rpc_cartones_ocupados() from public, anon, authenticated;
revoke all on function public.rpc_ganadores_publicos() from public, anon, authenticated;
revoke all on function public.rpc_top_compradores() from public, anon, authenticated;
revoke all on function public.rpc_resumen_referidos(text) from public, anon, authenticated;
revoke all on function public.rpc_reservar_carton(bigint,text,text) from public, anon, authenticated;
revoke all on function public.rpc_reservar_cartones_aleatorios(integer,text,text,bigint) from public, anon, authenticated;
revoke all on function public.rpc_liberar_reserva(bigint,text,text) from public, anon, authenticated;
revoke all on function public.rpc_liberar_todas_reservas(text,text) from public, anon, authenticated;
revoke all on function public.rpc_renovar_reservas(text,bigint[],text) from public, anon, authenticated;
revoke all on function public.rpc_crear_inscripcion(text,text,text,text,bigint[],text,text,numeric,text,text,text,integer,boolean,text) from public, anon, authenticated;
revoke all on function public.rpc_consultar_jugadas(text) from public, anon, authenticated;
revoke all on function public.rpc_lista_aprobados() from public, anon, authenticated;
revoke all on function public.rpc_listar_cartones_huerfanos(interval) from public, anon, authenticated;
revoke all on function public.rpc_liberar_cartones_huerfanos(interval) from public, anon, authenticated;
revoke all on function public.rpc_admin_cambiar_estado(bigint,text) from public, anon, authenticated;
revoke all on function public.rpc_eliminar_inscripcion_seguro(bigint) from public, anon, authenticated;
revoke all on function public.rpc_admin_reiniciar_ventas(boolean) from public, anon, authenticated;
revoke all on function public.rpc_admin_lanzar_cohetes() from public, anon, authenticated;

grant execute on function
  public.rpc_configuracion_publica(),
  public.rpc_cartones_ocupados(),
  public.rpc_ganadores_publicos(),
  public.rpc_top_compradores(),
  public.rpc_resumen_referidos(text),
  public.rpc_reservar_carton(bigint,text,text),
  public.rpc_reservar_cartones_aleatorios(integer,text,text,bigint),
  public.rpc_liberar_reserva(bigint,text,text),
  public.rpc_liberar_todas_reservas(text,text),
  public.rpc_renovar_reservas(text,bigint[],text),
  public.rpc_crear_inscripcion(text,text,text,text,bigint[],text,text,numeric,text,text,text,integer,boolean,text),
  public.rpc_consultar_jugadas(text),
  public.rpc_lista_aprobados()
to anon, authenticated;

grant execute on function
  public.rpc_listar_cartones_huerfanos(interval),
  public.rpc_liberar_cartones_huerfanos(interval),
  public.rpc_admin_cambiar_estado(bigint,text),
  public.rpc_eliminar_inscripcion_seguro(bigint),
  public.rpc_admin_reiniciar_ventas(boolean),
  public.rpc_admin_lanzar_cohetes()
to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'inscripciones'
  ) then
    alter publication supabase_realtime add table public.inscripciones;
  end if;
end;
$$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values
 ('comprobantes','comprobantes',false,5242880,array['image/jpeg','image/png','image/webp']),
 ('cartones','cartones',true,5242880,array['image/jpeg','image/png','image/webp']),
 ('imagenes','imagenes',true,5242880,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update
set public=excluded.public,
    file_size_limit=excluded.file_size_limit,
    allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists public_upload_receipts on storage.objects;
create policy public_upload_receipts on storage.objects for insert to anon
with check(
  bucket_id='comprobantes'
  and lower(storage.extension(name)) in ('jpg','jpeg','png','webp')
  and (storage.foldername(name))[1] ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  and storage.filename(name) ~* '^[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$'
  and length(name) < 180
);

-- Permite al mismo cliente limpiar un comprobante recién subido cuando la
-- inscripción falla. El nombre UUID no se puede listar ni descargar y la
-- eliminación deja de estar permitida en cuanto el archivo se usa o envejece.
create or replace function private.can_delete_recent_receipt(
  _name text,
  _created_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select _created_at >= now() - interval '15 minutes'
    and not exists (
      select 1
      from public.inscripciones i
      where i.comprobante = _name
    );
$$;

revoke all on function private.can_delete_recent_receipt(text,timestamptz)
  from public, anon, authenticated;
grant execute on function private.can_delete_recent_receipt(text,timestamptz)
  to anon;

drop policy if exists public_delete_unclaimed_receipts on storage.objects;
create policy public_delete_unclaimed_receipts on storage.objects
for delete to anon
using (
  bucket_id='comprobantes'
  and lower(storage.extension(name)) in ('jpg','jpeg','png','webp')
  and (storage.foldername(name))[1] ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  and storage.filename(name) ~* '^[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$'
  and private.can_delete_recent_receipt(name,created_at)
);

drop policy if exists public_read_assets on storage.objects;
create policy public_read_assets on storage.objects for select to anon
using(bucket_id in ('cartones','imagenes'));

drop policy if exists admin_manage_storage on storage.objects;
create policy admin_manage_storage on storage.objects for all to authenticated
using((select private.is_admin())) with check((select private.is_admin()));

grant select,insert,delete on storage.objects to anon;
grant select,insert,update,delete on storage.objects to authenticated;

notify pgrst, 'reload schema';
