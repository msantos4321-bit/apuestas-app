// Prueba la logica del motor con datos de ejemplo (sin internet).
// Uso: node pruebas/probar_motor.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, "..", "supabase", "functions", "motor", "index.ts"), "utf8");
const core = src.split("\n// ==== HANDLER")[0] +
  "\nexport { shin, probReferencia, construirPicks, ganadorDeScores, inferirNivel, inferirSuperficie, pinnacleDe, horaTijuana };\n";
const tmp = path.join(dir, "_core_tmp.mjs");
fs.writeFileSync(tmp, core);
const m = await import("file://" + tmp.replace(/\\/g, "/"));
fs.unlinkSync(tmp);

let fallos = 0;
const ok = (c, msg) => { if (!c) { fallos++; console.log("  FALLO:", msg); } else console.log("  ok:", msg); };

// 1) Shin: suma 1 y favorito conserva ventaja
const [pa, pb] = m.shin(1.5, 2.8);
ok(Math.abs(pa + pb - 1) < 1e-9, "Shin suma 1");
ok(pa > 0.6 && pa < 0.68, "Shin 1.50/2.80 da ~64% (" + pa.toFixed(3) + ")");

// 2) Referencia: Pinnacle manda
const bk = (key, a, b, pa_, pb_) => ({ key, title: key, markets: [{ key: "h2h", outcomes: [{ name: a, price: pa_ }, { name: b, price: pb_ }] }] });
const evPin = [bk("pinnacle", "Ana", "Bea", 1.5, 2.8), bk("otra", "Ana", "Bea", 1.9, 1.9)];
const r1 = m.probReferencia(evPin, "Ana", "Bea");
ok(r1 && r1.fuente === "Pinnacle" && Math.abs(r1.p - 0.64) < 0.03, "usa Pinnacle");

// 3) Sin Pinnacle: consenso solo con >=4 casas
const tres = [bk("a", "Ana", "Bea", 1.6, 2.4), bk("b", "Ana", "Bea", 1.55, 2.5), bk("c", "Ana", "Bea", 1.6, 2.45)];
ok(m.probReferencia(tres, "Ana", "Bea") === null, "3 casas no alcanzan");
const cuatro = tres.concat([bk("d", "Ana", "Bea", 1.58, 2.5)]);
const r2 = m.probReferencia(cuatro, "Ana", "Bea");
ok(r2 && r2.fuente.startsWith("consenso") && r2.p > 0.55, "4 casas -> consenso");

// 4) Picks: solo favoritos claros, cuota minima correcta, excluye muy lejanos / ya empezados
const ahora = Date.parse("2026-10-19T20:00:00Z");
const cfg = { p_min: 0.55, p_max: 0.92, ev_min: 0.02, cuota_max: 3.0, horas_max: 24 };
const mk = (id, h, books, a = "Ana", b = "Bea") => ({ id, sport_key: "tennis_wta_ningbo_open", sport_title: "WTA Ningbo", commence_time: new Date(ahora + h * 3600e3).toISOString(), home_team: a, away_team: b, bookmakers: books });
const eventos = [
  mk("e1", 5, [bk("pinnacle", "Ana", "Bea", 1.5, 2.8)]),                       // favorita Ana 64% -> pick
  mk("e2", 5, [bk("pinnacle", "Ana", "Bea", 1.95, 1.95)], "Cy", "Di"),          // parejo -> sin pick
  mk("e3", 30, [bk("pinnacle", "Ana", "Bea", 1.5, 2.8)], "Eo", "Fi"),           // fuera de horas_max
  mk("e4", -1, [bk("pinnacle", "Ana", "Bea", 1.5, 2.8)], "Go", "Hi"),           // ya empezo
  mk("e5", 6, [bk("pinnacle", "Jo", "Ka", 3.1, 1.38)], "Jo", "Ka"),             // favorito es B (Ka)
  mk("e6", 6, [bk("x", "Lu", "Mo", 1.5, 2.8)], "Lu", "Mo"),                     // sin referencia -> sin pick
];
const picks = m.construirPicks(eventos, cfg, ahora);
ok(picks.length === 2, "2 picks (" + picks.length + ")");
const p1 = picks.find((p) => p.evento_id === "e1");
ok(p1 && p1.seleccion === "Ana" && p1.lado === "A" && p1.semaforo === "verde", "e1 favorita Ana, verde");
ok(p1 && Math.abs(p1.cuota_min - (1.02 / p1.p_justa)) < 0.011, "cuota_min = 1.02 / p (" + (p1 && p1.cuota_min) + ")");
const p5 = picks.find((p) => p.evento_id === "e5");
ok(p5 && p5.seleccion === "Ka" && p5.lado === "B", "e5 favorito es el visitante");
ok(p1.nivel === "WTA" && p1.superficie === "Hard", "nivel y superficie");

// 5) Resultados
const fin = { completed: true, scores: [{ name: "Ana", score: "2" }, { name: "Bea", score: "1" }] };
ok(m.ganadorDeScores(fin) === "Ana", "ganador por sets");
ok(m.ganadorDeScores({ completed: false, scores: fin.scores }) === null, "no terminado");
ok(m.ganadorDeScores({ completed: true, scores: [{ name: "Ana", score: "1" }, { name: "Bea", score: "1" }] }) === null, "empate raro -> sin dato");
// 7) Cuota de cierre: precio de Pinnacle del jugador elegido
{
  const ev = { home_team: "Ana", away_team: "Bea", bookmakers: [bk("otra", "Ana", "Bea", 1.9, 1.9), bk("pinnacle", "Ana", "Bea", 1.5, 2.8)] };
  const pin = m.pinnacleDe(ev, "Bea");
  ok(pin && pin.cuota === 2.8 && pin.p > 0.3 && pin.p < 0.38, "cierre de Pinnacle para Bea (" + (pin && pin.p.toFixed(3)) + ")");
  ok(m.pinnacleDe({ ...ev, bookmakers: [bk("otra", "Ana", "Bea", 1.9, 1.9)] }, "Ana") === null, "sin Pinnacle no hay cierre");
  ok(m.horaTijuana(Date.parse("2026-10-20T15:05:00Z")) === 8, "15:05 UTC = 8 a.m. Tijuana (verano)");
  ok(m.horaTijuana(Date.parse("2026-12-01T16:05:00Z")) === 8, "16:05 UTC = 8 a.m. Tijuana (invierno)");
}


console.log(fallos === 0 ? "\nTODO OK" : "\nHAY " + fallos + " FALLO(S)");
process.exit(fallos ? 1 : 0);
