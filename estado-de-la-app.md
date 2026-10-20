# Estado de la app — Apuestas Tenis

**Versión:** 1.0.0 (código terminado, falta publicarla)

## Qué hace hoy
Pantallas Hoy, Historial, Banca, Estrategias y Ajustes; modo demostración; registrar apuestas (real/papel) con topes 2% y 5%; motor en la nube (Supabase) que busca picks con Pinnacle y liquida resultados; copiar resumen para Claude.

## Pasos de publicación
1. Supabase → SQL Editor: ejecutar `supabase/01_tablas.sql`, `02_autorizar.sql`, `03_importar_historial.sql`.
2. Publicar función `motor` (`supabase/functions/motor/index.ts`) y guardar el secreto `ODDS_API_KEY`.
3. Autenticación: en la plantilla de correo incluir `{{ .Token }}`.
4. Rellenar `docs/config.js` con la URL y la clave anon (nunca service_role).
5. GitHub: repo público `apuestas-app`, Pages → main /docs.

## Límites gratis
TheOddsAPI 500 créditos/mes (≈3 búsquedas/día); Supabase se pausa a los 7 días sin uso (lo evita `keepalive.yml`).

## Falta / limitaciones
Challenger/ITF sin referencia afilada y sin liquidación automática; APK opcional vía workflow `apk.yml`.
