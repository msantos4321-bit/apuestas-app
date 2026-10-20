-- ============================================================================
-- APUESTAS (tenis) -- paso 1: tablas, permisos y reglas por persona (RLS)
-- Pegar completo en Supabase -> SQL Editor -> Run.
-- Todas las tablas llevan el prefijo ap_ para convivir con tus otras apps en
-- el mismo proyecto sin mezclarse. Se puede ejecutar varias veces sin dano.
-- ============================================================================

-- Quien puede entrar (solo estos correos ven y tocan datos)
create table if not exists ap_autorizados (
  email text primary key
);

-- Configuracion unica (una sola fila): banca, topes y reglas de la estrategia
create table if not exists ap_config (
  id                int primary key default 1 check (id = 1),
  banca_inicial     numeric not null default 1000,
  tope_apuesta_pct  numeric not null default 2,     -- % maximo de la banca por apuesta
  tope_dia_pct      numeric not null default 5,     -- % maximo de la banca por dia
  kelly_fraccion    numeric not null default 0.25,  -- 1/4 de Kelly
  p_min             numeric not null default 0.55,  -- prob. justa minima (solo favoritos claros)
  p_max             numeric not null default 0.92,
  ev_min            numeric not null default 0.02,  -- ventaja minima exigida a Caliente (2%)
  cuota_max         numeric not null default 3.0,
  horas_max         int     not null default 24,
  busquedas_max_dia int     not null default 3,     -- protege los 500 creditos/mes de TheOddsAPI
  formato_momio     text    not null default 'decimal',
  actualizado       timestamptz not null default now()
);
insert into ap_config (id) values (1) on conflict (id) do nothing;

-- Picks que encuentra el motor en la nube
create table if not exists ap_picks (
  id            bigserial primary key,
  evento_id     text not null unique,
  sport_key     text,
  torneo        text,
  nivel         text,
  superficie    text,
  jugador_a     text not null,
  jugador_b     text not null,
  seleccion     text not null,
  lado          text not null check (lado in ('A','B')),
  inicio        timestamptz not null,
  p_justa       numeric not null,          -- probabilidad sin margen (Pinnacle / consenso)
  ref_fuente    text,
  cuota_min     numeric not null,          -- apostar solo si Caliente paga esto o mas
  cuota_ref     numeric,                   -- mejor cuota en otras casas (solo referencia)
  semaforo      text not null default 'verde' check (semaforo in ('verde','amarillo','rojo')),
  estrategia    text not null default 'v4',
  estado        text not null default 'activo' check (estado in ('activo','pasado','liquidado','sin_dato')),
  resultado     text check (resultado in ('W','L','X')),
  creado        timestamptz not null default now(),
  actualizado   timestamptz not null default now()
);
create index if not exists ap_picks_inicio on ap_picks (inicio);

-- Tus apuestas (reales, de papel, o historial de la estrategia anterior)
create table if not exists ap_apuestas (
  id          bigserial primary key,
  pick_id     bigint references ap_picks(id) on delete set null,
  evento_id   text,
  fecha       timestamptz not null default now(),
  jugador_a   text,
  jugador_b   text,
  seleccion   text not null,
  torneo      text,
  nivel       text,
  estrategia  text not null default 'v4',
  modo        text not null default 'papel' check (modo in ('real','papel','historico')),
  cuota       numeric not null check (cuota > 1),
  monto       numeric not null check (monto > 0),
  p_justa     numeric,
  confianza   text,
  inicio      timestamptz,
  resultado   text check (resultado in ('W','L','X')),
  pnl         numeric,
  notas       text,
  origen      text default 'app'
);
create index if not exists ap_apuestas_fecha on ap_apuestas (fecha);

-- Calcula la ganancia/perdida sola cuando se marca el resultado
create or replace function ap_calc_pnl() returns trigger language plpgsql as $$
begin
  if new.resultado = 'W' then new.pnl := round(new.monto * (new.cuota - 1), 2);
  elsif new.resultado = 'L' then new.pnl := -new.monto;
  elsif new.resultado = 'X' then new.pnl := 0;
  else new.pnl := null;
  end if;
  return new;
end $$;
drop trigger if exists ap_apuestas_pnl on ap_apuestas;
create trigger ap_apuestas_pnl before insert or update on ap_apuestas
  for each row execute function ap_calc_pnl();

-- Uso diario del motor (cuantas busquedas hoy y creditos restantes de TheOddsAPI)
create table if not exists ap_uso (
  dia                 date primary key,
  busquedas           int not null default 0,
  creditos_restantes  int
);

-- Reporte automatico de fallas
create table if not exists ap_crash (
  id       bigserial primary key,
  creado   timestamptz not null default now(),
  version  text,
  error    text,
  detalle  text
);

-- Tabla publica minima para que una tarea diaria "toque" la base y Supabase
-- no se pause por falta de uso.
create table if not exists ap_ping (
  id int primary key default 1,
  ok boolean not null default true
);
insert into ap_ping (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Permisos: solo los correos de ap_autorizados
-- ---------------------------------------------------------------------------
create or replace function ap_autorizado() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from ap_autorizados
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

alter table ap_autorizados enable row level security;
alter table ap_config      enable row level security;
alter table ap_picks       enable row level security;
alter table ap_apuestas    enable row level security;
alter table ap_uso         enable row level security;
alter table ap_crash       enable row level security;
alter table ap_ping        enable row level security;

drop policy if exists ap_pol_config   on ap_config;
drop policy if exists ap_pol_picks    on ap_picks;
drop policy if exists ap_pol_apuestas on ap_apuestas;
drop policy if exists ap_pol_uso      on ap_uso;
drop policy if exists ap_pol_crash    on ap_crash;
drop policy if exists ap_pol_ping     on ap_ping;

create policy ap_pol_config   on ap_config   for all to authenticated using (ap_autorizado()) with check (ap_autorizado());
drop policy if exists ap_pol_picks_upd on ap_picks;
create policy ap_pol_picks    on ap_picks    for select to authenticated using (ap_autorizado());
-- "Pasar" un pick = marcarlo como pasado desde la app
create policy ap_pol_picks_upd on ap_picks   for update to authenticated using (ap_autorizado()) with check (ap_autorizado());
create policy ap_pol_apuestas on ap_apuestas for all to authenticated using (ap_autorizado()) with check (ap_autorizado());
create policy ap_pol_uso      on ap_uso      for select to authenticated using (ap_autorizado());
-- Las fallas las puede reportar cualquiera con sesion (para no perder errores de login)
create policy ap_pol_crash    on ap_crash    for insert to authenticated, anon with check (true);
create policy ap_pol_ping     on ap_ping     for select to anon, authenticated using (true);
-- ap_autorizados no tiene politicas: nadie la lee desde la app (solo el SQL Editor y el motor).
