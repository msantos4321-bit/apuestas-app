-- ============================================================================
-- APUESTAS -- paso 4 (v1.1): opinion de Claude, cuota de cierre (CLV),
-- notificaciones y busqueda automatica (8 a.m. y 9 p.m. hora de Tijuana).
-- Se puede ejecutar varias veces sin dano. Lo ejecuta solo el workflow
-- "Publicar motor" de GitHub; tambien se puede pegar en el SQL Editor.
-- ============================================================================

-- Opinion de Claude por pick
alter table ap_picks add column if not exists claude_veredicto text;
alter table ap_picks add column if not exists claude_razon text;
alter table ap_picks add column if not exists claude_confianza text;
alter table ap_picks drop constraint if exists ap_picks_conf_chk;
alter table ap_picks add constraint ap_picks_conf_chk check (claude_confianza is null or claude_confianza in ('ALTA','MEDIA','BAJA'));
alter table ap_picks add column if not exists claude_fecha timestamptz;
alter table ap_picks drop constraint if exists ap_picks_claude_chk;
alter table ap_picks add constraint ap_picks_claude_chk check (claude_veredicto is null or claude_veredicto in ('APOSTAR','PASAR'));
-- Ultimo precio de Pinnacle visto antes de empezar (para la cuota de cierre)
alter table ap_picks add column if not exists cuota_pinnacle numeric;
alter table ap_picks add column if not exists p_cierre numeric;
alter table ap_picks add column if not exists cierre_hora timestamptz;
alter table ap_picks add column if not exists avisado boolean not null default false;

-- Cuota de cierre por apuesta y si ya se aviso el resultado
alter table ap_apuestas add column if not exists cuota_cierre numeric;
alter table ap_apuestas add column if not exists p_cierre numeric;
alter table ap_apuestas add column if not exists avisado_res boolean not null default false;

-- Busquedas automaticas: se cuentan aparte de las manuales
alter table ap_uso add column if not exists auto int not null default 0;
alter table ap_uso add column if not exists auto_horas text not null default '';

-- Suscripciones de notificaciones (un renglon por celular/navegador)
create table if not exists ap_push (
  endpoint  text primary key,
  p256dh    text not null,
  auth      text not null,
  email     text,
  creado    timestamptz not null default now()
);
alter table ap_push enable row level security;
drop policy if exists ap_pol_push on ap_push;
create policy ap_pol_push on ap_push for all to authenticated using (ap_autorizado()) with check (ap_autorizado());
grant select, insert, update, delete on ap_push to authenticated;
grant all on ap_push to service_role;

-- Valores privados del motor (llaves de notificaciones y clave del reloj).
-- Sin politicas: nadie la lee desde la app; solo el motor (service_role).
create table if not exists ap_privado (
  clave text primary key,
  valor text not null
);
alter table ap_privado enable row level security;
grant all on ap_privado to service_role;
insert into ap_privado (clave, valor) values ('cron', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
on conflict (clave) do nothing;

-- Reloj: cada hora "toca" al motor; el motor solo busca a las 8 y a las 21
-- hora de Tijuana (asi se ajusta solo al cambio de horario).
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'ap_motor_auto';
  perform cron.schedule('ap_motor_auto', '2 * * * *', $job$
    select net.http_post(
      url := 'https://wnwecaapchcfhcljsvli.supabase.co/functions/v1/motor',
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'x-ap-cron', (select valor from public.ap_privado where clave = 'cron')),
      body := '{"accion":"auto"}'::jsonb,
      timeout_milliseconds := 150000
    );
  $job$);
end $$;
