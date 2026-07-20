-- Premio de cartón gratis por referidos.
-- La captura es evidencia para el administrador; la elegibilidad siempre se
-- valida de nuevo en PostgreSQL antes de crear y antes de aprobar la solicitud.

create table if not exists public.solicitudes_carton_gratis (
  id bigint generated always as identity primary key,
  cedula text not null check (cedula ~ '^[0-9]{5,14}$'),
  nombre text not null check (length(btrim(nombre)) between 3 and 90),
  telefono text not null check (
    length(regexp_replace(telefono, '[^0-9]', '', 'g')) between 7 and 15
  ),
  carton bigint not null check (carton > 0),
  captura varchar(180) not null unique check (
    captura ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}/[0-9a-fA-F-]{36}\.(jpg|jpeg|png|webp)$'
  ),
  estado text not null default 'pendiente' check (
    estado in ('pendiente', 'aprobado', 'rechazado')
  ),
  meta_referidos integer not null check (meta_referidos between 1 and 100),
  referidos_validados integer not null check (referidos_validados >= meta_referidos),
  pago_banco text,
  pago_telefono text,
  pago_cedula text,
  created_at timestamptz not null default now(),
  revisado_at timestamptz,
  revisado_por uuid references auth.users(id) on delete set null,
  constraint solicitudes_carton_gratis_revision_coherente check (
    (estado = 'pendiente' and revisado_at is null and revisado_por is null)
    or (estado in ('aprobado', 'rechazado') and revisado_at is not null)
  )
);

create unique index if not exists solicitudes_carton_gratis_pendiente_cedula_idx
  on public.solicitudes_carton_gratis (cedula)
  where estado = 'pendiente';

create unique index if not exists solicitudes_carton_gratis_carton_activo_idx
  on public.solicitudes_carton_gratis (carton)
  where estado in ('pendiente', 'aprobado');

create index if not exists solicitudes_carton_gratis_estado_fecha_idx
  on public.solicitudes_carton_gratis (estado, created_at desc);

create index if not exists solicitudes_carton_gratis_cedula_historial_idx
  on public.solicitudes_carton_gratis (cedula, id desc);

create index if not exists solicitudes_carton_gratis_revisado_por_idx
  on public.solicitudes_carton_gratis (revisado_por)
  where revisado_por is not null;

create table if not exists public.referidos_canjeados (
  solicitud_id bigint not null
    references public.solicitudes_carton_gratis(id) on delete cascade,
  referidor_cedula text not null check (referidor_cedula ~ '^[0-9]{5,14}$'),
  referido_cedula text not null check (referido_cedula ~ '^[0-9]{5,14}$'),
  consumido_at timestamptz not null default now(),
  primary key (solicitud_id, referido_cedula),
  unique (referido_cedula),
  unique (referidor_cedula, referido_cedula)
);

create index if not exists referidos_canjeados_referidor_idx
  on public.referidos_canjeados (referidor_cedula, consumido_at desc);

alter table public.cartones
  add column if not exists premio_solicitud_id bigint;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'cartones_premio_solicitud_fk'
      and conrelid = 'public.cartones'::regclass
  ) then
    alter table public.cartones
      add constraint cartones_premio_solicitud_fk
      foreign key (premio_solicitud_id)
      references public.solicitudes_carton_gratis(id)
      on delete set null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'cartones_premio_reserva_coherente'
      and conrelid = 'public.cartones'::regclass
  ) then
    alter table public.cartones
      add constraint cartones_premio_reserva_coherente check (
        premio_solicitud_id is null
        or (reservado_hasta is null and reserva_token_hash is null)
      );
  end if;
end;
$$;

create index if not exists cartones_premio_solicitud_idx
  on public.cartones (premio_solicitud_id)
  where premio_solicitud_id is not null;

create index if not exists inscripciones_referido_canonico_idx
  on public.inscripciones (cedula, created_at, id)
  include (referido)
  where estado = 'aprobado' and referido is not null;

alter table public.solicitudes_carton_gratis enable row level security;
alter table public.referidos_canjeados enable row level security;

drop policy if exists admin_read_solicitudes_carton_gratis
  on public.solicitudes_carton_gratis;
create policy admin_read_solicitudes_carton_gratis
  on public.solicitudes_carton_gratis
  for select to authenticated
  using ((select private.is_admin()));

revoke all on table public.solicitudes_carton_gratis,
  public.referidos_canjeados from public, anon, authenticated;
grant select on table public.solicitudes_carton_gratis to authenticated;
grant all on table public.solicitudes_carton_gratis,
  public.referidos_canjeados to service_role;

create or replace function private.referidos_aprobados_canonicos(_cedula text)
returns table(referido_cedula text, aprobado_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with atribuciones as (
    select distinct on (i.cedula)
      i.cedula as referido_cedula,
      regexp_replace(i.referido, '[^0-9]', '', 'g') as referidor_cedula,
      i.created_at as aprobado_at
    from public.inscripciones i
    where i.estado = 'aprobado'
      and i.cedula ~ '^[0-9]{5,14}$'
      and regexp_replace(coalesce(i.referido, ''), '[^0-9]', '', 'g')
        ~ '^[0-9]{5,14}$'
      and i.cedula <> regexp_replace(i.referido, '[^0-9]', '', 'g')
    order by i.cedula, i.created_at, i.id
  )
  select a.referido_cedula, a.aprobado_at
  from atribuciones a
  where a.referidor_cedula =
    regexp_replace(coalesce(_cedula, ''), '[^0-9]', '', 'g')
  order by a.aprobado_at, a.referido_cedula;
$$;

revoke all on function private.referidos_aprobados_canonicos(text)
  from public, anon, authenticated;

create or replace function public.rpc_resumen_referidos(_cedula text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cedula text := regexp_replace(coalesce(_cedula, ''), '[^0-9]', '', 'g');
  v_meta integer := 5;
  v_total integer := 0;
  v_consumidos integer := 0;
  v_disponibles integer := 0;
  v_tiene_compra boolean := false;
  v_pendiente boolean := false;
  v_ultima jsonb;
begin
  select least(100, greatest(1, coalesce(nullif(c.valore, '')::integer, 5)))
  into v_meta
  from public.configuracion c
  where c.clave = 'meta_referidos';
  v_meta := coalesce(v_meta, 5);

  if v_cedula !~ '^[0-9]{5,14}$' then
    return jsonb_build_object(
      'aprobados', 0,
      'total_aprobados', 0,
      'consumidos', 0,
      'meta', v_meta,
      'puede_reclamar', false,
      'tiene_compra_aprobada', false,
      'solicitud_pendiente', false,
      'ultima_solicitud', null
    );
  end if;

  select count(*)::integer
  into v_total
  from private.referidos_aprobados_canonicos(v_cedula);

  select count(*)::integer
  into v_consumidos
  from public.referidos_canjeados r
  where r.referidor_cedula = v_cedula;

  select count(*)::integer
  into v_disponibles
  from private.referidos_aprobados_canonicos(v_cedula) a
  where not exists (
    select 1
    from public.referidos_canjeados r
    where r.referidor_cedula = v_cedula
      and r.referido_cedula = a.referido_cedula
  );

  select exists (
    select 1
    from public.inscripciones i
    where i.cedula = v_cedula and i.estado = 'aprobado'
  ) into v_tiene_compra;

  select exists (
    select 1
    from public.solicitudes_carton_gratis s
    where s.cedula = v_cedula and s.estado = 'pendiente'
  ) into v_pendiente;

  select jsonb_build_object(
    'estado', s.estado,
    'carton', s.carton,
    'created_at', s.created_at,
    'revisado_at', s.revisado_at
  )
  into v_ultima
  from public.solicitudes_carton_gratis s
  where s.cedula = v_cedula
  order by s.id desc
  limit 1;

  return jsonb_build_object(
    'aprobados', v_disponibles,
    'total_aprobados', v_total,
    'consumidos', v_consumidos,
    'meta', v_meta,
    'puede_reclamar',
      v_disponibles >= v_meta and v_tiene_compra and not v_pendiente,
    'tiene_compra_aprobada', v_tiene_compra,
    'solicitud_pendiente', v_pendiente,
    'ultima_solicitud', v_ultima
  );
end;
$$;

create or replace function public.rpc_solicitar_carton_gratis(
  _cedula text,
  _telefono text,
  _carton bigint,
  _captura text,
  _reserva_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
  v_cedula text := regexp_replace(coalesce(_cedula, ''), '[^0-9]', '', 'g');
  v_telefono text := regexp_replace(coalesce(_telefono, ''), '[^0-9]', '', 'g');
  v_meta integer := 5;
  v_disponibles integer := 0;
  v_total integer := 300;
  v_ventas boolean := false;
  v_cliente public.inscripciones%rowtype;
  v_reserva public.cartones%rowtype;
begin
  if v_cedula !~ '^[0-9]{5,14}$' then
    raise exception 'Cédula inválida';
  end if;
  if length(v_telefono) < 7 or length(v_telefono) > 15 then
    raise exception 'Teléfono inválido';
  end if;
  if coalesce(_reserva_token, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'Token de reserva inválido';
  end if;
  if coalesce(_captura, '') !~
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}/[0-9a-fA-F-]{36}\.(jpg|jpeg|png|webp)$' then
    raise exception 'Captura inválida';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('premio-referidos:' || v_cedula, 0)
  );

  select coalesce(c.valor, lower(c.valore) in ('true', '1', 'si', 'sí'))
  into v_ventas
  from public.configuracion c
  where c.clave = 'ventas_abierta';
  if v_ventas is not true then
    raise exception 'Las ventas están cerradas';
  end if;

  select least(100, greatest(1, coalesce(nullif(c.valore, '')::integer, 5)))
  into v_meta
  from public.configuracion c
  where c.clave = 'meta_referidos';
  v_meta := coalesce(v_meta, 5);

  select coalesce(nullif(c.valore, '')::integer, 300)
  into v_total
  from public.configuracion c
  where c.clave = 'total_cartones';
  v_total := coalesce(v_total, 300);

  if _carton < 1 or _carton > v_total then
    raise exception 'Cartón fuera de rango';
  end if;

  if exists (
    select 1
    from public.solicitudes_carton_gratis s
    where s.cedula = v_cedula and s.estado = 'pendiente'
  ) then
    raise exception 'Ya tienes un cartón gratis pendiente de revisión';
  end if;

  select count(*)::integer
  into v_disponibles
  from private.referidos_aprobados_canonicos(v_cedula) a
  where not exists (
    select 1
    from public.referidos_canjeados r
    where r.referidor_cedula = v_cedula
      and r.referido_cedula = a.referido_cedula
  );

  if v_disponibles < v_meta then
    raise exception 'Aún no tienes los % referidos aprobados disponibles', v_meta;
  end if;

  select i.*
  into v_cliente
  from public.inscripciones i
  where i.cedula = v_cedula
    and i.estado = 'aprobado'
    and regexp_replace(coalesce(i.telefono, ''), '[^0-9]', '', 'g') = v_telefono
  order by i.created_at desc, i.id desc
  limit 1;

  if not found then
    raise exception 'El teléfono no coincide con una compra aprobada de esta cédula';
  end if;

  if not exists (
    select 1
    from storage.objects o
    where o.bucket_id = 'comprobantes' and o.name = _captura
  ) then
    raise exception 'No se encontró la captura subida';
  end if;

  if exists (
    select 1 from public.inscripciones i where i.comprobante = _captura
    union all
    select 1 from public.solicitudes_carton_gratis s where s.captura = _captura
  ) then
    raise exception 'La captura ya fue utilizada';
  end if;

  select c.*
  into v_reserva
  from public.cartones c
  where c.numero = _carton
  for update;

  if not found
     or v_reserva.cedula <> v_cedula
     or v_reserva.reservado_hasta is null
     or v_reserva.reservado_hasta < now()
     or v_reserva.reserva_token_hash is distinct from
        private.hash_reserva_token(_reserva_token)
     or v_reserva.premio_solicitud_id is not null then
    raise exception 'La reserva del cartón venció o pertenece a otra persona';
  end if;

  insert into public.solicitudes_carton_gratis (
    cedula, nombre, telefono, carton, captura, estado,
    meta_referidos, referidos_validados,
    pago_banco, pago_telefono, pago_cedula
  ) values (
    v_cedula, btrim(v_cliente.nombre), btrim(v_cliente.telefono),
    _carton, _captura, 'pendiente', v_meta, v_disponibles,
    v_cliente.pago_banco, v_cliente.pago_telefono, v_cliente.pago_cedula
  )
  returning id into v_id;

  update public.cartones c
  set ocupado = true,
      cedula = v_cedula,
      partida_id = null,
      reservado_at = now(),
      reservado_hasta = null,
      reserva_token_hash = null,
      premio_solicitud_id = v_id
  where c.numero = _carton;

  return jsonb_build_object(
    'exito', true,
    'solicitud_id', v_id,
    'carton', _carton,
    'estado', 'pendiente'
  );
end;
$$;

create or replace function public.rpc_admin_listar_cartones_gratis()
returns table(
  id bigint,
  nombre text,
  telefono text,
  cedula text,
  carton bigint,
  captura text,
  estado text,
  meta_referidos integer,
  referidos_al_solicitar integer,
  referidos_disponibles integer,
  created_at timestamptz,
  revisado_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select private.is_admin()) then
    raise exception 'Acceso denegado';
  end if;

  return query
  select
    s.id,
    s.nombre,
    s.telefono,
    s.cedula,
    s.carton,
    s.captura::text,
    s.estado,
    s.meta_referidos,
    s.referidos_validados,
    (
      select count(*)::integer
      from private.referidos_aprobados_canonicos(s.cedula) a
      where not exists (
        select 1
        from public.referidos_canjeados r
        where r.referidor_cedula = s.cedula
          and r.referido_cedula = a.referido_cedula
      )
    ),
    s.created_at,
    s.revisado_at
  from public.solicitudes_carton_gratis s
  order by
    case s.estado when 'pendiente' then 0 when 'rechazado' then 1 else 2 end,
    s.created_at desc;
end;
$$;

create or replace function public.rpc_admin_resolver_carton_gratis(
  _id bigint,
  _estado text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.solicitudes_carton_gratis%rowtype;
  v_carton public.cartones%rowtype;
  v_insertados integer := 0;
  v_restantes integer := 0;
begin
  if not (select private.is_admin()) then
    raise exception 'Acceso denegado';
  end if;
  if _estado not in ('aprobado', 'rechazado') then
    raise exception 'Estado inválido';
  end if;

  select s.* into v
  from public.solicitudes_carton_gratis s
  where s.id = _id
  for update;
  if not found then
    raise exception 'Solicitud no encontrada';
  end if;

  if v.estado = _estado then
    return jsonb_build_object(
      'exito', true,
      'sin_cambios', true,
      'estado', v.estado,
      'carton', v.carton
    );
  end if;
  if v.estado <> 'pendiente' then
    raise exception 'La solicitud ya fue revisada';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('premio-referidos:' || v.cedula, 0)
  );

  select c.* into v_carton
  from public.cartones c
  where c.numero = v.carton
  for update;

  if not found
     or v_carton.cedula <> v.cedula
     or v_carton.premio_solicitud_id is distinct from v.id then
    raise exception 'El cartón reservado para esta solicitud ya no está disponible';
  end if;

  if _estado = 'rechazado' then
    update public.solicitudes_carton_gratis
    set estado = 'rechazado',
        revisado_at = now(),
        revisado_por = (select auth.uid())
    where id = v.id;

    delete from public.cartones c
    where c.numero = v.carton
      and c.cedula = v.cedula
      and c.premio_solicitud_id = v.id;

    return jsonb_build_object(
      'exito', true,
      'estado', 'rechazado',
      'carton', v.carton
    );
  end if;

  with elegibles as (
    select a.referido_cedula
    from private.referidos_aprobados_canonicos(v.cedula) a
    where not exists (
      select 1
      from public.referidos_canjeados r
      where r.referidor_cedula = v.cedula
        and r.referido_cedula = a.referido_cedula
    )
    order by a.aprobado_at, a.referido_cedula
    limit v.meta_referidos
  ), insertados as (
    insert into public.referidos_canjeados (
      solicitud_id, referidor_cedula, referido_cedula
    )
    select v.id, v.cedula, e.referido_cedula
    from elegibles e
    on conflict do nothing
    returning 1
  )
  select count(*)::integer into v_insertados from insertados;

  if v_insertados <> v.meta_referidos then
    raise exception 'La solicitud ya no tiene % referidos aprobados disponibles',
      v.meta_referidos;
  end if;

  update public.solicitudes_carton_gratis
  set estado = 'aprobado',
      revisado_at = now(),
      revisado_por = (select auth.uid())
  where id = v.id;

  update public.cartones c
  set ocupado = true,
      reservado_hasta = null,
      reserva_token_hash = null
  where c.numero = v.carton
    and c.premio_solicitud_id = v.id;

  select count(*)::integer
  into v_restantes
  from private.referidos_aprobados_canonicos(v.cedula) a
  where not exists (
    select 1
    from public.referidos_canjeados r
    where r.referidor_cedula = v.cedula
      and r.referido_cedula = a.referido_cedula
  );

  return jsonb_build_object(
    'exito', true,
    'estado', 'aprobado',
    'carton', v.carton,
    'referidos_restantes', v_restantes
  );
end;
$$;

create or replace function public.rpc_consultar_jugadas(_cedula text)
returns table(estado text, cartones text[], monto_bs numeric, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select q.estado, q.cartones, q.monto_bs, q.created_at
  from (
    select i.estado, i.cartones, i.monto_bs, i.created_at
    from public.inscripciones i
    where i.cedula = regexp_replace(coalesce(_cedula, ''), '[^0-9]', '', 'g')

    union all

    select
      s.estado,
      array[s.carton::text],
      0::numeric,
      coalesce(s.revisado_at, s.created_at)
    from public.solicitudes_carton_gratis s
    where s.cedula = regexp_replace(coalesce(_cedula, ''), '[^0-9]', '', 'g')
      and s.estado = 'aprobado'
  ) q
  order by q.created_at desc
  limit 20;
$$;

create or replace function public.rpc_lista_aprobados()
returns table(carton bigint, nombre text, cedula_mascara text)
language sql
stable
security definer
set search_path = ''
as $$
  select q.carton, q.nombre, q.cedula_mascara
  from (
    select
      c::bigint as carton,
      i.nombre,
      repeat('*', greatest(length(i.cedula) - 4, 0)) || right(i.cedula, 4)
        as cedula_mascara
    from public.inscripciones i
    cross join lateral unnest(i.cartones) c
    where i.estado = 'aprobado' and c ~ '^[0-9]+$'

    union all

    select
      s.carton,
      s.nombre,
      repeat('*', greatest(length(s.cedula) - 4, 0)) || right(s.cedula, 4)
    from public.solicitudes_carton_gratis s
    where s.estado = 'aprobado'
  ) q
  order by q.carton;
$$;

create or replace function public.rpc_listar_cartones_huerfanos(
  _min_age interval default interval '5 minutes'
)
returns table(numero bigint, cedula text, reservado_at timestamptz, reservado_hasta timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select private.is_admin()) then raise exception 'Acceso denegado'; end if;
  return query
  select c.numero, c.cedula, c.reservado_at, c.reservado_hasta
  from public.cartones c
  where c.reservado_at < now() - greatest(_min_age, interval '5 minutes')
    and (c.reservado_hasta is null or c.reservado_hasta < now())
    and c.premio_solicitud_id is null
    and not exists (
      select 1 from public.inscripciones i
      where i.estado in ('pendiente', 'aprobado')
        and c.numero::text = any(i.cartones)
    )
  order by c.reservado_at;
end;
$$;

create or replace function public.rpc_liberar_cartones_huerfanos(
  _min_age interval default interval '5 minutes'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_count integer;
begin
  if not (select private.is_admin()) then raise exception 'Acceso denegado'; end if;
  delete from public.cartones c
  where c.reservado_at < now() - greatest(_min_age, interval '5 minutes')
    and (c.reservado_hasta is null or c.reservado_hasta < now())
    and c.premio_solicitud_id is null
    and not exists (
      select 1 from public.inscripciones i
      where i.estado in ('pendiente', 'aprobado')
        and c.numero::text = any(i.cartones)
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.rpc_admin_cambiar_estado(
  _id bigint,
  _estado text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.inscripciones%rowtype;
  v_num bigint;
  v_conflictos integer;
begin
  if not (select private.is_admin()) then raise exception 'Acceso denegado'; end if;
  if _estado not in ('pendiente', 'aprobado', 'rechazado') then
    raise exception 'Estado inválido';
  end if;

  select * into v
  from public.inscripciones i
  where i.id = _id
  for update;
  if not found then raise exception 'Inscripción no encontrada'; end if;

  if _estado = 'rechazado' then
    delete from public.cartones c
    where c.cedula = v.cedula
      and c.numero::text = any(v.cartones)
      and c.reservado_hasta is null
      and c.premio_solicitud_id is null
      and not exists (
        select 1
        from public.inscripciones i
        where i.id <> _id
          and i.estado in ('pendiente', 'aprobado')
          and c.numero::text = any(i.cartones)
      );
  else
    select
      (
        select count(*)
        from public.cartones c
        where c.numero::text = any(v.cartones)
          and (
            c.cedula <> v.cedula
            or c.reservado_hasta is not null
            or c.premio_solicitud_id is not null
          )
      )
      +
      (
        select count(*)
        from public.inscripciones i
        where i.id <> _id
          and i.estado in ('pendiente', 'aprobado')
          and i.cartones && v.cartones
      )
    into v_conflictos;

    if v_conflictos > 0 then
      raise exception 'Uno o más cartones ya pertenecen a otra persona o a un premio';
    end if;

    for v_num in
      select x::bigint from unnest(v.cartones) x where x ~ '^[0-9]+$'
    loop
      insert into public.cartones (
        numero, ocupado, cedula, reservado_at, reservado_hasta
      ) values (
        v_num, true, v.cedula, now(), null
      )
      on conflict (numero) do update
        set ocupado = true,
            cedula = excluded.cedula,
            reservado_hasta = null
        where public.cartones.cedula = excluded.cedula
          and public.cartones.premio_solicitud_id is null;
    end loop;
  end if;

  update public.inscripciones set estado = _estado where id = _id;
  return jsonb_build_object('exito', true, 'estado', _estado);
end;
$$;

create or replace function public.rpc_eliminar_inscripcion_seguro(_id bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v public.inscripciones%rowtype;
begin
  if not (select private.is_admin()) then raise exception 'Acceso denegado'; end if;
  select * into v
  from public.inscripciones i
  where i.id = _id
  for update;
  if not found then raise exception 'Inscripción no encontrada'; end if;

  delete from public.cartones c
  where c.cedula = v.cedula
    and c.numero::text = any(v.cartones)
    and c.reservado_hasta is null
    and c.premio_solicitud_id is null
    and not exists (
      select 1
      from public.inscripciones i
      where i.id <> _id
        and i.estado in ('pendiente', 'aprobado')
        and c.numero::text = any(i.cartones)
    );

  delete from public.inscripciones where id = _id;
  return v.comprobante::text;
end;
$$;

create or replace function public.rpc_admin_reiniciar_ventas(
  _incluir_ganadores boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ins integer;
  v_cart integer;
  v_gan integer := 0;
  v_premios integer;
begin
  if not (select private.is_admin()) then raise exception 'Acceso denegado'; end if;
  delete from public.solicitudes_carton_gratis;
  get diagnostics v_premios = row_count;
  delete from public.inscripciones;
  get diagnostics v_ins = row_count;
  delete from public.cartones;
  get diagnostics v_cart = row_count;
  if _incluir_ganadores then
    delete from public.ganadores;
    get diagnostics v_gan = row_count;
  end if;
  return jsonb_build_object(
    'inscripciones', v_ins,
    'cartones', v_cart,
    'ganadores', v_gan,
    'premios_referidos', v_premios
  );
end;
$$;

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
      select 1 from public.inscripciones i where i.comprobante = _name
    )
    and not exists (
      select 1 from public.solicitudes_carton_gratis s where s.captura = _name
    );
$$;

revoke all on function public.rpc_resumen_referidos(text)
  from public, anon, authenticated;
revoke all on function public.rpc_solicitar_carton_gratis(text,text,bigint,text,text)
  from public, anon, authenticated;
revoke all on function public.rpc_admin_listar_cartones_gratis()
  from public, anon, authenticated;
revoke all on function public.rpc_admin_resolver_carton_gratis(bigint,text)
  from public, anon, authenticated;

grant execute on function public.rpc_resumen_referidos(text),
  public.rpc_solicitar_carton_gratis(text,text,bigint,text,text)
to anon, authenticated;

grant execute on function public.rpc_admin_listar_cartones_gratis(),
  public.rpc_admin_resolver_carton_gratis(bigint,text)
to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'solicitudes_carton_gratis'
  ) then
    alter publication supabase_realtime
      add table public.solicitudes_carton_gratis;
  end if;
end;
$$;
