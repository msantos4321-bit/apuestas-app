# Estado de la app — Apuestas Tenis

**Versión:** 1.2.1 · App: https://msantos4321-bit.github.io/apuestas-app/ · Base y motor: Supabase proyecto "cinecasa" (tablas `ap_*`, función `motor`).

## Qué hace hoy
- Pantallas Hoy, Historial, Banca, Estrategias y Ajustes; modo demostración.
- Registrar apuestas (real/papel) con topes 2% y 5%; **editar** (Real↔Papel, cuota, monto, resultado) y **deshacer registro**.
- Motor en la nube: busca picks con Pinnacle/consenso, liquida resultados, guarda la **cuota de cierre** (último precio de Pinnacle antes del partido).
- **Búsqueda automática** a las 8 a.m. y 6 p.m. hora de Tijuana (reloj `pg_cron` cada hora a :02; el motor solo actúa a esas horas). No cuenta en el límite manual. Si quedan < 40 créditos solo liquida.
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
- No llegan notificaciones: Ajustes → Enviar prueba; revisar permiso de Chrome; en Supabase SQL: `select * from cron.job_run_details order by start_time desc limit 5;` y `select * from net._http_response order by created desc limit 5;`.
- "Falta publicar la actualización": correr Actions → Publicar motor.
- Motor da 404: la función no está publicada.

## Falta / limitaciones
Challenger/ITF sin referencia afilada ni liquidación automática. La cuota de cierre es aproximada (último precio visto en una búsqueda antes del partido). APK opcional vía `apk.yml`.
