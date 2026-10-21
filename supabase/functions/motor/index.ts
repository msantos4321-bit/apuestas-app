// ============================================================================
// MOTOR DE APUESTAS (nube) -- Supabase Edge Function "motor"
// Acciones (POST JSON): {"accion":"buscar"} | {"accion":"liquidar"} | {"accion":"estado"}
//   | {"accion":"vapid"} (llave publica para notificaciones) | {"accion":"prueba"}
//   | {"accion":"auto"} (solo el reloj de la base, con la clave x-ap-cron)
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

// Precio de Pinnacle para un jugador y su probabilidad justa (para la cuota de cierre).
function pinnacleDe(ev, nombre) {
  const a = ev.home_team, b = ev.away_team;
  for (const bk of ev.bookmakers || []) {
    if (String(bk.key || bk.title || "").toLowerCase() !== "pinnacle") continue;
    const pr = preciosH2H(bk, a, b);
    if (!pr) return null;
    const [pa, pb] = shin(pr[0], pr[1]);
    if (nombre === a) return { cuota: pr[0], p: pa };
    if (nombre === b) return { cuota: pr[1], p: pb };
  }
  return null;
}

// Hora (0-23) en Tijuana para un momento dado.
function horaTijuana(ms) {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Tijuana", hour: "numeric", hourCycle: "h23" }).format(new Date(ms)));
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

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const HORAS_AUTO = [8, 21];      // busquedas automaticas (hora de Tijuana)
const CREDITOS_MIN_AUTO = 40;    // con menos creditos, la automatica solo liquida

// Limite de tiempo para cada llamada de red (evita que algo se quede colgado).
async function getJson(url, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "apuestas-app/1.1" } });
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

// Guarda el ultimo precio de Pinnacle visto ANTES de empezar (cuota de cierre aproximada).
async function guardarCierres(db, eventos) {
  const ahora = Date.now();
  const porId = {};
  for (const ev of eventos) if (Date.parse(ev.commence_time) > ahora) porId[ev.id] = ev;
  const ids = Object.keys(porId);
  if (!ids.length) return 0;
  const { data: picks } = await db.from("ap_picks").select("id, evento_id, seleccion").in("evento_id", ids);
  let n = 0;
  for (const p of picks || []) {
    const pin = pinnacleDe(porId[p.evento_id], p.seleccion);
    if (!pin) continue;
    const hora = new Date().toISOString();
    await db.from("ap_picks").update({ cuota_pinnacle: pin.cuota, p_cierre: r4(pin.p), cierre_hora: hora }).eq("id", p.id);
    await db.from("ap_apuestas").update({ cuota_cierre: pin.cuota, p_cierre: r4(pin.p) }).eq("pick_id", p.id);
    n++;
  }
  return n;
}

// auto=true: busqueda del reloj (no cuenta en tu limite diario manual).
async function buscar(db, key, cfg, auto = false) {
  const dia = diaTijuana();
  const { data: uso } = await db.from("ap_uso").select("*").eq("dia", dia).maybeSingle();
  const hechas = uso ? uso.busquedas : 0;
  if (!auto && hechas >= cfg.busquedas_max_dia) {
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
  const cierres = await guardarCierres(db, eventos);

  const fila = { dia, busquedas: hechas + (auto ? 0 : 1), creditos_restantes: restantes, ...(auto ? { auto: (uso ? uso.auto : 0) + 1 } : {}) };
  await db.from("ap_uso").upsert(fila, { onConflict: "dia" });

  return {
    ok: true, torneos: activos.length, partidos: eventos.length, picks: picks.length,
    liquidados: lis.liquidados, creditos_restantes: restantes, busquedas_hoy: hechas + (auto ? 0 : 1), cierres,
  };
}

// ---------- Notificaciones --------------------------------------------------

async function llavesVapid(db) {
  const { data } = await db.from("ap_privado").select("clave, valor").in("clave", ["vapid_pub", "vapid_priv"]);
  const m = Object.fromEntries((data || []).map((x) => [x.clave, x.valor]));
  if (m.vapid_pub && m.vapid_priv) return { pub: m.vapid_pub, priv: m.vapid_priv };
  const k = webpush.generateVAPIDKeys();
  await db.from("ap_privado").upsert([{ clave: "vapid_pub", valor: k.publicKey }, { clave: "vapid_priv", valor: k.privateKey }], { onConflict: "clave", ignoreDuplicates: true });
  return llavesVapid(db);
}

async function notificar(db, titulo, cuerpo, tag = "apuestas") {
  const { data: subs } = await db.from("ap_push").select("*");
  if (!subs || !subs.length) return 0;
  const k = await llavesVapid(db);
  webpush.setVapidDetails("mailto:avisos@apuestas-app.local", k.pub, k.priv);
  const payload = JSON.stringify({ titulo, cuerpo, tag });
  let enviados = 0;
  for (const s of subs) {
    try {
      const d = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 6 * 3600 });
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(d.endpoint, { method: "POST", headers: d.headers, body: d.body, signal: ctl.signal }).finally(() => clearTimeout(t));
      if (r.status === 404 || r.status === 410) await db.from("ap_push").delete().eq("endpoint", s.endpoint);
      else if (r.ok) enviados++;
    } catch (_e) { /* un celular que falla no detiene a los demas */ }
  }
  return enviados;
}

const fmtMoney = (x) => (x < 0 ? "-$" : "+$") + Math.abs(Number(x) || 0).toFixed(2);

// Avisa picks nuevos y resultados liquidados. silencioso=true solo los marca como vistos.
async function avisar(db, silencioso) {
  const ahora = new Date().toISOString();
  const { data: nuevos } = await db.from("ap_picks").select("id, seleccion, cuota_min")
    .eq("avisado", false).eq("estado", "activo").gt("inicio", ahora).order("inicio");
  const { data: res } = await db.from("ap_apuestas").select("id, seleccion, resultado, pnl, modo")
    .eq("avisado_res", false).not("resultado", "is", null).in("modo", ["real", "papel"]);
  let enviados = 0;
  if (!silencioso && nuevos && nuevos.length) {
    const lista = nuevos.slice(0, 4).map((p) => p.seleccion.split(" ").slice(-1)[0] + " (min. " + Number(p.cuota_min).toFixed(2) + ")").join(", ");
    enviados += await notificar(db, nuevos.length === 1 ? "Hay 1 pick nuevo" : `Hay ${nuevos.length} picks nuevos`,
      lista + (nuevos.length > 4 ? "..." : "") + ". Revisa Caliente antes de apostar.", "picks");
  }
  if (!silencioso && res && res.length) {
    const total = res.reduce((a, x) => a + (Number(x.pnl) || 0), 0);
    const lineas = res.slice(0, 4).map((x) => (x.resultado === "W" ? "Gano " : x.resultado === "L" ? "Perdio " : "Anulada ") + x.seleccion.split(" ").slice(-1)[0] + " " + fmtMoney(x.pnl) + " (" + x.modo + ")").join(" - ");
    enviados += await notificar(db, (res.length === 1 ? "Resultado: " : `${res.length} resultados: `) + fmtMoney(total), lineas + (res.length > 4 ? "..." : ""), "resultados");
  }
  if (nuevos && nuevos.length) await db.from("ap_picks").update({ avisado: true }).in("id", nuevos.map((x) => x.id));
  if (res && res.length) await db.from("ap_apuestas").update({ avisado_res: true }).in("id", res.map((x) => x.id));
  return enviados;
}

// Reloj de la base: cada hora; solo actua a las HORAS_AUTO de Tijuana, una vez por hora.
async function auto(db, key, cfg) {
  const h = horaTijuana(Date.now());
  if (!HORAS_AUTO.includes(h)) return { ok: true, nada: "fuera de horario", hora: h };
  const dia = diaTijuana();
  const { data: uso } = await db.from("ap_uso").select("*").eq("dia", dia).maybeSingle();
  const hechas = String((uso && uso.auto_horas) || "").split(",").filter(Boolean);
  if (hechas.includes(String(h))) return { ok: true, nada: "ya corrio esta hora", hora: h };
  await db.from("ap_uso").upsert({ dia, busquedas: uso ? uso.busquedas : 0, auto_horas: hechas.concat(String(h)).join(",") }, { onConflict: "dia" });

  // Creditos: si ya casi no hay, solo liquida (no busca picks nuevos)
  const { data: ult } = await db.from("ap_uso").select("creditos_restantes").not("creditos_restantes", "is", null).order("dia", { ascending: false }).limit(1).maybeSingle();
  const creditos = ult ? ult.creditos_restantes : null;
  let r;
  if (creditos !== null && creditos < CREDITOS_MIN_AUTO) {
    const lis = await liquidar(db, key);
    r = { ok: true, solo_liquidar: true, liquidados: lis.liquidados, creditos_restantes: lis.restantes };
  } else {
    r = await buscar(db, key, cfg, true);
  }
  r.avisos = await avisar(db, false);
  return r;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const key = Deno.env.get("ODDS_API_KEY");
    const db = createClient(url, service);
    const body = await req.json().catch(() => ({}));
    const accion = body.accion || "buscar";

    // Reloj de la base (pg_cron): se identifica con la clave privada x-ap-cron
    const cron = req.headers.get("x-ap-cron");
    if (cron) {
      const { data: sec } = await db.from("ap_privado").select("valor").eq("clave", "cron").maybeSingle();
      if (!sec || sec.valor !== cron) return json({ ok: false, error: "no_autorizado" }, 403);
      if (!key) return json({ ok: false, error: "sin_clave" }, 500);
      const { data: cfg } = await db.from("ap_config").select("*").eq("id", 1).single();
      return json(await auto(db, key, cfg));
    }

    // Solo usuarios con sesion y en la lista de autorizados
    const auth = req.headers.get("Authorization") || "";
    const userClient = createClient(url, anon, { global: { headers: { Authorization: auth } } });
    const { data: u } = await userClient.auth.getUser();
    const email = u && u.user && u.user.email;
    if (!email) return json({ ok: false, error: "sin_sesion", mensaje: "Inicia sesion de nuevo." }, 401);

    const { data: okUser } = await db.from("ap_autorizados").select("email").ilike("email", email).maybeSingle();
    if (!okUser) return json({ ok: false, error: "no_autorizado", mensaje: "Ese correo no tiene acceso." }, 403);

    const { data: cfg } = await db.from("ap_config").select("*").eq("id", 1).single();

    if (accion === "estado") {
      const { data: uso } = await db.from("ap_uso").select("*").eq("dia", diaTijuana()).maybeSingle();
      return json({ ok: true, version: "1.1", key_configurada: !!key, busquedas_hoy: uso ? uso.busquedas : 0, creditos_restantes: uso ? uso.creditos_restantes : null });
    }
    if (accion === "vapid") return json({ ok: true, publica: (await llavesVapid(db)).pub });
    if (accion === "prueba") {
      const n = await notificar(db, "Notificaciones activadas", "Asi te avisare de picks nuevos y resultados.", "prueba");
      return json({ ok: n > 0, enviados: n, mensaje: n ? "Enviada." : "No hay celulares suscritos todavia." });
    }
    if (!key) return json({ ok: false, error: "sin_clave", mensaje: "Falta la clave ODDS_API_KEY en Supabase (Edge Functions -> Secrets)." }, 500);

    if (accion === "liquidar") { const r = await liquidar(db, key); await avisar(db, true); return json({ ok: true, ...r }); }
    const r = await buscar(db, key, cfg);
    if (r.ok) await avisar(db, true);   // tu ya lo estas viendo en la app: no te aviso de nuevo
    return json(r);
  } catch (e) {
    return json({ ok: false, error: "fallo", mensaje: String(e && e.message ? e.message : e) }, 500);
  }
});
