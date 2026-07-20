-- Meta variable de referidos administrada desde el panel.

alter table public.configuracion
  drop constraint if exists configuracion_meta_referidos_valida;

alter table public.configuracion
  add constraint configuracion_meta_referidos_valida
  check (
    clave <> 'meta_referidos'
    or case
      when valore ~ '^[0-9]{1,3}$'
        then valore::integer between 1 and 100
      else false
    end
  );

create or replace function public.rpc_admin_configurar_meta_referidos(
  _meta integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not (select private.is_admin()) then
    raise exception 'Acceso denegado';
  end if;

  if _meta is null or _meta < 1 or _meta > 100 then
    raise exception 'La meta debe estar entre 1 y 100';
  end if;

  insert into public.configuracion (clave, valore, valor)
  values ('meta_referidos', _meta::text, null)
  on conflict (clave) do update
  set valore = excluded.valore,
      valor = null;

  return jsonb_build_object(
    'exito', true,
    'meta', _meta
  );
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
  v_meta_actual integer := 5;
begin
  if not (select private.is_admin()) then
    raise exception 'Acceso denegado';
  end if;
  if _estado not in ('aprobado', 'rechazado') then
    raise exception 'Estado inválido';
  end if;

  select least(100, greatest(1, coalesce(nullif(c.valore, '')::integer, 5)))
  into v_meta_actual
  from public.configuracion c
  where c.clave = 'meta_referidos';
  v_meta_actual := coalesce(v_meta_actual, 5);

  select s.* into v
  from public.solicitudes_carton_gratis s
  where s.id = _id
  for update;
  if not found then
    raise exception 'Solicitud no encontrada';
  end if;

  if v.estado = _estado then
    if v.estado = 'aprobado' then
      select count(*)::integer
      into v_restantes
      from private.referidos_aprobados_canonicos(v.cedula) a
      where not exists (
        select 1
        from public.referidos_canjeados r
        where r.referidor_cedula = v.cedula
          and r.referido_cedula = a.referido_cedula
      );
    end if;

    return jsonb_build_object(
      'exito', true,
      'sin_cambios', true,
      'estado', v.estado,
      'carton', v.carton,
      'referidos_consumidos',
        case when v.estado = 'aprobado' then v.meta_referidos else 0 end,
      'referidos_restantes', v_restantes,
      'meta_actual', v_meta_actual
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
      'carton', v.carton,
      'referidos_consumidos', 0,
      'meta_actual', v_meta_actual
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
    'referidos_consumidos', v.meta_referidos,
    'referidos_restantes', v_restantes,
    'meta_actual', v_meta_actual
  );
end;
$$;

revoke all on function public.rpc_admin_configurar_meta_referidos(integer)
  from public, anon, authenticated;
grant execute on function public.rpc_admin_configurar_meta_referidos(integer)
  to authenticated;

revoke all on function public.rpc_admin_resolver_carton_gratis(bigint,text)
  from public, anon, authenticated;
grant execute on function public.rpc_admin_resolver_carton_gratis(bigint,text)
  to authenticated;
