create or replace function public.rpc_admin_lanzar_cohetes()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select private.is_admin()) then
    raise exception 'Acceso denegado';
  end if;

  perform realtime.send(
    jsonb_build_object('lanzado_en', now()),
    'cohetes',
    'bingo-ganga-celebraciones',
    false
  );

  return true;
end;
$$;

comment on function public.rpc_admin_lanzar_cohetes() is
  'Envía por Realtime la animación de cohetes a los clientes públicos conectados.';

revoke all on function public.rpc_admin_lanzar_cohetes()
from public, anon, authenticated;

grant execute on function public.rpc_admin_lanzar_cohetes()
to authenticated;
