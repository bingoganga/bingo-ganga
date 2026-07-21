-- Corrige el reinicio administrativo para cumplir la protección safeupdate.
-- El historial privado de cédulas aprobadas se conserva intencionalmente.

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
  if not (select private.is_admin()) then
    raise exception 'Acceso denegado';
  end if;

  delete from public.solicitudes_carton_gratis where true;
  get diagnostics v_premios = row_count;

  delete from public.inscripciones where true;
  get diagnostics v_ins = row_count;

  delete from public.cartones where true;
  get diagnostics v_cart = row_count;

  if _incluir_ganadores then
    delete from public.ganadores where true;
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

comment on function public.rpc_admin_reiniciar_ventas(boolean) is
  'Reinicia ventas, cartones y solicitudes gratis; conserva el historial permanente de cédulas aprobadas.';

revoke all on function public.rpc_admin_reiniciar_ventas(boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.rpc_admin_reiniciar_ventas(boolean)
  to authenticated;
