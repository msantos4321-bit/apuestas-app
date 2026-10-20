// ============================================================================
// MOTOR DE APUESTAS (nube) -- Supabase Edge Function "motor"
// Acciones (POST JSON): {"accion":"buscar"} | {"accion":"liquidar"} | {"accion":"estado"}
//
// Que hace "buscar" (todo en uno, sin tu PC):
//   1) Liquida lo pendiente (resultados de TheOddsAPI /scores, ultimos 3 dias).
//   2) Lee los partidos ATP/WTA de las proximas horas y la probabilidad "justa"
//      (Pinnacle sin margen; si no hay Pinnacle, mediana de >=4 casas).
//   3) Guarda como pick a los favoritos claros (prob. justa >= p_min) y calcula
//      la CUOTA MINIMA que Caliente debe pagar para que haya valor
//      (cuota_min = (1 + ev_min) / prob. justa). Caliente no se puede leer desde
//      la nube (bloquea), asi que esa comparacion final la haces tu al apostar.
//
// Secretos: ODDS_API_KEY (tu la pegas en Supabase -> Edge Functions -> Secrets).
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY ya vienen solas.
//
// NOTA: el codigo de arriba de "// ==== HANDLER ====" es JavaScript puro, sin
// tipos, para poder probarlo con Node (ver pruebas/probar_motor.mjs).
// ============================================================================

const ODDS = "https://api.the-odds-api.com/v4";

// ---------- Matematica ------------------------------------------------------

// Shin (1993): quita el margen de la casa dando mas peso al favorito real.
function shin(cuotaA, cuotaB) {
  const pi = [1 / cuotaA, 1 / cuotaB];
  const s = pi[0] + pi[1];
  const probs = (z) => pi.map((p) => (Math.sqrt(z * z + 4 * (1 - z) * (p * p) / s) - z) / (2 * (1 - z)));
  let lo = 0, hi = 0.2;
  for (let i = 0; i < 60; i++) {
    const z = (lo + hi) / 2;
    const t = probs(z).reduce((a, b) => a + b, 0);
    if (t > 1) lo = z; else hi = z;
  }
  const [pa, pb] = probs((lo + hi) / 2);
  return [pa / (pa + pb), pb / (pa + pb)];
}

function preciosH2H(bk, a, b) {
  let pa = null, pb = null;
  for (const m of bk.markets || []) {
    if (m.key !== "h2h") continue;
    for (const o of m.outcomes || []) {
      const precio = Number(o.price);
      if (o.name === a) pa = precio; else if (o.name === b) pb = precio;
    }
  }
  return pa > 1 && pb > 1 ? [pa, pb] : null;
}

// Probabilidad justa de que gane A: Pinnacle, o mediana de >=4 casas.
function probReferencia(bookmakers, a, b) {
  for (const bk of bookmakers || []) {
    if (String(bk.key || bk.title || "").toLowerCase() === "pinnacle") {
      const pr = preciosH2H(bk, a, b);
      if (pr) return { p: shin(pr[0], pr[1])[0], fuente: "Pinnacle" };
    }
  }
  const ps = [];
  for (const bk of bookmakers || []) {
    const pr = preciosH2H(bk, a, b);
    if (pr) ps.push(shin(pr[0], pr[1])[0]);
  }
  if (ps.length >= 4) {
    ps.sort((x, y) => x - y);
    const n = ps.length;
    const med = n % 2 ? ps[(n - 1) / 2] : (ps[n / 2 - 1] + ps[n / 2]) / 2;
    return { p: med, fuente: "consenso (" + n + " casas)" };
  }
  return null;
}

function mejorCuota(bookmakers, nombre) {
  let mejor = 0;
  for (const bk of bookmakers || []) {
    for (const m of bk.markets || []) {
      if (m.key !== "h2h") continue;
      for (const o of m.outcomes || []) if (o.name === nombre && Number(o.price) > mejor) mejor = Number(o.price);
    }
  }
  return mejor || null;
}

function inferirNivel(sportKey) {
  const k = String(sportKey || "").toLowerCase();
  if (/french_open|wimbledon|us_open|aus_open/.test(k)) return "Grand Slam";
  if (k.includes("atp")) return "ATP";
  if (k.includes("wta")) return "WTA";
  return "ATP/WTA";
}

function inferirSuperficie(sportKey, titulo) {
  const t = (String(sportKey) + " " + String(titulo)).toLowerCase();
  if (/clay|roland|french/.test(t)) return "Clay";
  if (/grass|wimbledon|halle|queens/.test(t)) return "Grass";
  if (/carpet|indoor/.test(t)) return "Carpet";
  return "Hard";
}

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;

// Convierte eventos de TheOddsAPI en picks segun la configuracion.
function construirPicks(eventos, cfg, ahoraMs) {
  const picks = [];
  for (const ev of eventos) {
    const inicioMs = Date.parse(ev.commence_time);
    if (!(inicioMs > ahoraMs + 30 * 60 * 1000)) continue;                 // ya empezo / en <30 min
    if (inicioMs > ahoraMs + cfg.horas_max * 3600 * 1000) continue;       // muy lejos
    const a = ev.home_team, b = ev.away_team;
    if (!a || !b) continue;
    const ref = probReferencia(ev.bookmakers, a, b);
    if (!ref) continue;

    const lados = [
      { lado: "A", nombre: a, p: ref.p },
      { lado: "B", nombre: b, p: 1 - ref.p },
    ];
    const fav = lados.reduce((x, y) => (x.p >= y.p ? x : y));
    if (fav.p < cfg.p_min || fav.p > cfg.p_max) continue;

    const cuotaMin = (1 + cfg.ev_min) / fav.p;
    if (cuotaMin > cfg.cuota_max) continue;

    picks.push({
      evento_id: ev.id,
      sport_key: ev.sport_key,
      torneo: ev.sport_title || ev.sport_key,
      nivel: inferirNivel(ev.sport_key),
      superficie: inferirSuperficie(ev.sport_key, ev.sport_title),
      jugador_a: a,
      jugador_b: b,
      seleccion: fav.nombre,
      lado: fav.lado,
      inicio: new Date(inicioMs).toISOString(),
      p_justa: r4(fav.p),
      ref_fuente: ref.fuente,
      cuota_min: r2(Math.max(cuotaMin, 1.01)),
      cuota_ref: mejorCuota(ev.bookmakers, fav.nombre),
      semaforo: ref.fuente === "Pinnacle" ? "verde" : "amarillo",
      estrategia: "v4",
    });
  }
  return picks.sort((x, y) => (x.inicio < y.inicio ? -1 : 1));
}

// Ganador de un evento completado: quien tenga mas sets (score viene como texto).
function ganadorDeScores(ev) {
  if (!ev.completed || !Array.isArray(ev.scores) || ev.scores.length < 2) return null;
  const s = ev.scores.map((x) => ({ n: x.name, v: parseInt(x.score, 10) }));
  if (s.some((x) => Number.isNaN(x.v)) || s[0].v === s[1].v) return null;
  return s[0].v > s[1].v ? s[0].n : s[1].n;
}

// ==== HANDLER ===============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Limite de tiempo para cada llamada de red (evita que algo se quede colgado).
async function getJson(url, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "apuestas-app/1.0" } });
    const restantes = r.headers.get("x-requests-remaining");
    if (!r.ok) throw new Error("TheOddsAPI HTTP " + r.status);
    return { data: await r.json(), restantes: restantes === null ? null : Number(restantes) };
  } finally {
    clearTimeout(t);
  }
}

function diaTijuana() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tijuana" }).format(new Date());
}

async function liquidar(db, key) {
  const ahora = new Date().toISOString();
  const { data: pend } = await db.from("ap_picks").select("*")
    .is("resultado", null).lt("inicio", ahora).in("estado", ["activo", "pasado"]);
  let liquidados = 0, restantes = null;
  const porDeporte = {};
  for (const p of pend || []) (porDeporte[p.sport_key] = porDeporte[p.sport_key] || []).push(p);

  for (const [sport, lista] of Object.entries(porDeporte)) {
    try {
      const ids = lista.map((p) => p.evento_id).join(",");
      const url = `${ODDS}/sports/${sport}/scores/?apiKey=${key}&daysFrom=3&eventIds=${ids}`;
      const { data, restantes: rest } = await getJson(url);
      if (rest !== null) restantes = rest;
      for (const ev of data || []) {
        const gan = ganadorDeScores(ev);
        if (!gan) continue;
        const p = lista.find((x) => x.evento_id === ev.id);
        if (!p) continue;
        const res = gan === p.seleccion ? "W" : "L";
        await db.from("ap_picks").update({ resultado: res, estado: "liquidado", actualizado: new Date().toISOString() }).eq("id", p.id);
        await db.from("ap_apuestas").update({ resultado: res }).eq("pick_id", p.id).is("resultado", null);
        liquidados++;
      }
    } catch (_e) { /* un deporte que falla no detiene a los demas */ }
  }
  // Picks viejos sin resultado: ya no hay forma gratis de saberlo (limite de 3 dias de TheOddsAPI)
  const hace4d = new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString();
  await db.from("ap_picks").update({ estado: "sin_dato" }).is("resultado", null).lt("inicio", hace4d).in("estado", ["activo", "pasado"]);
  return { liquidados, restantes };
}

async function buscar(db, key, cfg) {
  const dia = diaTijuana();
  const { data: uso } = await db.from("ap_uso").select("*").eq("dia", dia).maybeSingle();
  const hechas = uso ? uso.busquedas : 0;
  if (hechas >= cfg.busquedas_max_dia) {
    return { ok: false, error: "limite", mensaje: `Ya hiciste ${hechas} busquedas hoy (maximo ${cfg.busquedas_max_dia}). Cuida tus creditos de TheOddsAPI; manana se reinicia.` };
  }

  const lis = await liquidar(db, key);

  const { data: deportes } = await getJson(`${ODDS}/sports/?apiKey=${key}`);
  const activos = (deportes || []).filter((s) => String(s.group).toLowerCase() === "tennis" && s.active && !s.has_outrights).map((s) => s.key);

  let eventos = [], restantes = lis.restantes;
  for (const sk of activos) {
    try {
      const { data, restantes: rest } = await getJson(`${ODDS}/sports/${sk}/odds/?apiKey=${key}&regions=eu&markets=h2h&oddsFormat=decimal&dateFormat=iso`);
      if (rest !== null) restantes = rest;
      eventos = eventos.concat(data || []);
    } catch (_e) { /* sigue con el siguiente torneo */ }
  }

  const picks = construirPicks(eventos, cfg, Date.now());
  if (picks.length) {
    const { error } = await db.from("ap_picks").upsert(
      picks.map((p) => ({ ...p, actualizado: new Date().toISOString() })),
      { onConflict: "evento_id" },
    );
    if (error) throw new Error("No se pudo guardar: " + error.message);
  }
  await db.from("ap_uso").upsert({ dia, busquedas: hechas + 1, creditos_restantes: restantes }, { onConflict: "dia" });

  return {
    ok: true, torneos: activos.length, partidos: eventos.length, picks: picks.length,
    liquidados: lis.liquidados, creditos_restantes: restantes, busquedas_hoy: hechas + 1,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const key = Deno.env.get("ODDS_API_KEY");

    // Solo usuarios con sesion y en la lista de autorizados
    const auth = req.headers.get("Authorization") || "";
    const userClient = createClient(url, anon, { global: { headers: { Authorization: auth } } });
    const { data: u } = await userClient.auth.getUser();
    const email = u && u.user && u.user.email;
    if (!email) return json({ ok: false, error: "sin_sesion", mensaje: "Inicia sesion de nuevo." }, 401);

    const db = createClient(url, service);
    const { data: okUser } = await db.from("ap_autorizados").select("email").ilike("email", email).maybeSingle();
    if (!okUser) return json({ ok: false, error: "no_autorizado", mensaje: "Ese correo no tiene acceso." }, 403);

    const body = await req.json().catch(() => ({}));
    const accion = body.accion || "buscar";
    const { data: cfg } = await db.from("ap_config").select("*").eq("id", 1).single();

    if (accion === "estado") {
      const { data: uso } = await db.from("ap_uso").select("*").eq("dia", diaTijuana()).maybeSingle();
      return json({ ok: true, key_configurada: !!key, busquedas_hoy: uso ? uso.busquedas : 0, creditos_restantes: uso ? uso.creditos_restantes : null });
    }
    if (!key) return json({ ok: false, error: "sin_clave", mensaje: "Falta la clave ODDS_API_KEY en Supabase (Edge Functions -> Secrets)." }, 500);

    if (accion === "liquidar") return json({ ok: true, ...(await liquidar(db, key)) });
    return json(await buscar(db, key, cfg));
  } catch (e) {
    return json({ ok: false, error: "fallo", mensaje: String(e && e.message ? e.message : e) }, 500);
  }
});
