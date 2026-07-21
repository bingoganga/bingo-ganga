-- Conserva la identidad de clientes aprobados entre reinicios de ventas.
-- Una persona puede volver a comprar, pero solo su primera aprobacion puede
-- acreditarse como referido.

create table if not exists private.cedulas_aprobadas_historial (
  cedula text primary key check (cedula ~ '^[0-9]{5,14}$'),
  primera_inscripcion_id bigint not null check (primera_inscripcion_id > 0),
  primer_referidor_cedula text check (
    primer_referidor_cedula is null
    or (
      primer_referidor_cedula ~ '^[0-9]{5,14}$'
      and primer_referidor_cedula <> cedula
    )
  ),
  primera_aprobacion_at timestamptz not null,
  registrado_at timestamptz not null default now()
);

comment on table private.cedulas_aprobadas_historial is
  'Registro interno permanente para impedir que una cedula aprobada vuelva a generar credito como referido.';
comment on column private.cedulas_aprobadas_historial.primera_inscripcion_id is
  'Identificador historico sin FK: la inscripcion original se elimina al reiniciar las ventas.';

create index if not exists cedulas_aprobadas_historial_referidor_idx
  on private.cedulas_aprobadas_historial (
    primer_referidor_cedula,
    primera_aprobacion_at,
    cedula
  )
  where primer_referidor_cedula is not null;

alter table private.cedulas_aprobadas_historial enable row level security;
revoke all on table private.cedulas_aprobadas_historial
  from public, anon, authenticated, service_role;

-- Registra las aprobaciones actuales sin cambiar el progreso vigente.
with normalizadas as (
  select
    i.id,
    regexp_replace(coalesce(i.cedula, ''), '[^0-9]', '', 'g') as cedula,
    regexp_replace(coalesce(i.referido, ''), '[^0-9]', '', 'g') as referidor,
    i.created_at,
    row_number() over (
      partition by regexp_replace(coalesce(i.cedula, ''), '[^0-9]', '', 'g')
      order by i.created_at, i.id
    ) as orden
  from public.inscripciones i
  where i.estado = 'aprobado'
    and regexp_replace(coalesce(i.cedula, ''), '[^0-9]', '', 'g')
      ~ '^[0-9]{5,14}$'
)
insert into private.cedulas_aprobadas_historial (
  cedula,
  primera_inscripcion_id,
  primer_referidor_cedula,
  primera_aprobacion_at
)
select
  n.cedula,
  n.id,
  case
    when n.referidor ~ '^[0-9]{5,14}$' and n.referidor <> n.cedula
      then n.referidor
    else null
  end,
  n.created_at
from normalizadas n
where n.orden = 1
on conflict (cedula) do nothing;

create or replace function private.registrar_primera_cedula_aprobada()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cedula text := regexp_replace(coalesce(new.cedula, ''), '[^0-9]', '', 'g');
  v_referidor text := regexp_replace(coalesce(new.referido, ''), '[^0-9]', '', 'g');
begin
  if tg_op = 'UPDATE' and old.estado = 'aprobado' then
    return new;
  end if;

  if new.estado <> 'aprobado' or v_cedula !~ '^[0-9]{5,14}$' then
    return new;
  end if;

  if v_referidor !~ '^[0-9]{5,14}$' or v_referidor = v_cedula then
    v_referidor := null;
  end if;

  insert into private.cedulas_aprobadas_historial (
    cedula,
    primera_inscripcion_id,
    primer_referidor_cedula,
    primera_aprobacion_at
  ) values (
    v_cedula,
    new.id,
    v_referidor,
    now()
  )
  on conflict (cedula) do nothing;

  return new;
end;
$$;

revoke all on function private.registrar_primera_cedula_aprobada()
  from public, anon, authenticated, service_role;

drop trigger if exists registrar_primera_cedula_aprobada
  on public.inscripciones;
create trigger registrar_primera_cedula_aprobada
after insert or update of estado on public.inscripciones
for each row
when (new.estado = 'aprobado')
execute function private.registrar_primera_cedula_aprobada();

create or replace function private.referidos_aprobados_canonicos(_cedula text)
returns table(referido_cedula text, aprobado_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select h.cedula, h.primera_aprobacion_at
  from private.cedulas_aprobadas_historial h
  join public.inscripciones i
    on i.id = h.primera_inscripcion_id
   and regexp_replace(coalesce(i.cedula, ''), '[^0-9]', '', 'g') = h.cedula
  where i.estado = 'aprobado'
    and h.primer_referidor_cedula =
      regexp_replace(coalesce(_cedula, ''), '[^0-9]', '', 'g')
  order by h.primera_aprobacion_at, h.cedula;
$$;

revoke all on function private.referidos_aprobados_canonicos(text)
  from public, anon, authenticated, service_role;

