# Estado de la app — Apuestas Tenis

**Versión:** 1.3.0 · App: https://msantos4321-bit.github.io/apuestas-app/ · Base y motor: Supabase proyecto "cinecasa" (tablas `ap_*`, función `motor`).

## Qué hace hoy
- **v1.3.0 (4 nov 2026): resultados con ESPN.** TheOddsAPI no daba resultados del Masters de París (`completed:false`, `scores:null`), así que desde el 1 nov nada se liquidaba. Ahora el motor liquida con el scoreboard público de ESPN (`site.api.espn.com/.../tennis/{atp|wta}/scoreboard?dates=YYYYMMDD`, gratis, sin clave) **cada hora**; TheOddsAPI queda de respaldo. Reintenta picks de hasta 12 días (incluye `sin_dato`). Walkover = anulada (X); retiro = gana quien avanza. Se recuperaron 36 resultados atrasados el 4 nov.
- **Historial → Sistema**: todos los picks del motor, registrados y liquidados solos (acierto real vs esperado, unidades a la cuota mínima y al precio de Pinnacle). Estrategias → "Sistema completo".
- Picks muertos: si su torneo se leyó bien y el partido ya no aparece, pasan a `sin_dato` (ESPN igual los liquida si se juegan).
- Avisos de resultados solo a las 8 a.m. y 9 p.m. (la liquidación de cada hora es silenciosa).
- Pantallas Hoy, Historial, Banca, Estrategias y Ajustes; modo demostración.
- Registrar apuestas (real/papel) con topes 2% y 5%; **editar** (Real↔Papel, cuota, monto, resultado) y **deshacer registro**.
- Motor en la nube: busca picks con Pinnacle/consenso, liquida resultados, guarda la **cuota de cierre** (último precio de Pinnacle antes del partido).
- **Búsqueda automática** a las 8 a.m. y 9 p.m. hora de Tijuana (reloj `pg_cron` cada hora a :02; el motor solo actúa a esas horas). No cuenta en el límite manual. Si quedan < 40 créditos solo liquida.
- **Notificaciones push** (Android/Chrome): picks nuevos y resultados liquidados. Llaves VAPID se generan solas y viven en `ap_privado` (solo el motor las lee).
- **Opinión de Claude por lote**: "Copiar todo" incluye `#id` y pide a Claude terminar con un bloque `VEREDICTOS`; "Pegar opinión de Claude" lo lee y guarda en `ap_picks.claude_*`. Estrategias → "Filtro de Claude" compara APOSTAR vs PASAR.
- Confianza de Claude (ALTA/MEDIA/BAJA) en el bloque `#id | APOSTAR/PASAR | confianza | razón`; BAJA = mitad del monto; aviso si Claude dijo PASAR. El texto copiado incluye el historial del filtro para que Claude se calibre.
- Monto sugerido en cada tarjeta (Kelly 1/4, tope 2%, ajustado por Claude) y total del día contra el tope diario.
- Historial: línea de ganancia **esperada vs real** y tarjeta **CLV**.
- Borrar historial v3 con respaldo CSV (Ajustes).

## Publicación
- Pantallas: GitHub Pages (main /docs) — se publica sola al hacer push.
- Motor y base: workflow **Publicar motor** (se corre solo cuando cambia `supabase/`, o a mano). Aplica `supabase/04_mejoras.sql` y publica la función con `--no-verify-jwt` (el motor valida la sesión él mismo).

## Secretos (nombres, nunca valores)
- Supabase → Edge Functions → Secrets: `ODDS_API_KEY`.
- GitHub → Actions secrets: `SUPABASE_ACCESS_TOKEN` (para el workflow Publicar motor).
- `ap_privado` (tabla): `cron`, `vapid_pub`, `vapid_priv` — se crean solos.

## Límites gratis
TheOddsAPI 500 créditos/mes (2 búsquedas automáticas + manuales; vigilar el contador en Hoy). Supabase se pausa a los 7 días sin uso (lo evitan `keepalive.yml` y el reloj horario).

## Qué revisar si se rompe
- **Diagnóstico** (Actions → Diagnostico → Run): llama al motor para liquidar (`{"accion":"liquidar"}` con la clave del reloj), muestra lo que da TheOddsAPI y saca un volcado de la base **cifrado** con `diagnostico/llave_publica.pem` (el repo es público: nunca imprimir datos sin cifrar). Cada sesión de Claude debe generar su propia llave y reemplazar la pública.
- "Publicar motor" necesita `--yes` con la CLI nueva de Supabase (ya puesto).
- `keepalive.yml` no tenía `actions/checkout` y fallaba (arreglado; el reloj horario igual mantenía viva la base).
- No llegan notificaciones: Ajustes → Enviar prueba; revisar permiso de Chrome; en Supabase SQL: `select * from cron.job_run_details order by start_time desc limit 5;` y `select * from net._http_response order by created desc limit 5;`.
- "Falta publicar la actualización": correr Actions → Publicar motor.
- Motor da 404: la función no está publicada.

## Falta / limitaciones
Challenger/ITF sin referencia afilada ni liquidación automática. La cuota de cierre es aproximada (último precio visto en una búsqueda antes del partido). APK opcional vía `apk.yml`.
