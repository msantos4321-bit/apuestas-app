select json_build_object(
 'ahora', now(),
 'cron_jobs', (select json_agg(j) from (select jobname, schedule, active from cron.job) j),
 'cron_runs', (select json_agg(r) from (select status, start_time, left(return_message,200) msg from cron.job_run_details order by start_time desc limit 12) r),
 'http', (select json_agg(h) from (select created, status_code, left(content::text,300) content, error_msg from net._http_response order by created desc limit 12) h),
 'uso', (select json_agg(u) from (select * from ap_uso order by dia desc limit 20) u),
 'crash', (select json_agg(c) from (select creado, version, error, left(detalle,300) detalle from ap_crash order by creado desc limit 25) c),
 'picks_estado', (select json_agg(x) from (select estado, resultado, count(*) n from ap_picks group by 1,2 order by 1,2) x),
 'picks', (select json_agg(p) from (select id, evento_id, sport_key, seleccion, jugador_a, jugador_b, inicio, p_justa, ref_fuente, cuota_min, cuota_ref, estado, resultado, claude_veredicto, claude_confianza, cuota_pinnacle, p_cierre, cierre_hora, creado from ap_picks order by inicio) p),
 'apuestas', (select json_agg(a) from (select id, pick_id, fecha, seleccion, modo, cuota, monto, p_justa, resultado, pnl, cuota_cierre, inicio, estrategia from ap_apuestas where modo <> 'historico' order by fecha) a),
 'cfg', (select row_to_json(c) from ap_config c where id=1),
 'push', (select count(*) from ap_push),
 'pm', (select json_agg(x) from (select id, seleccion, inicio, p_justa, pm_precio, pm_bid, pm_max, pm_volumen, pm_hora, pm_lleno from ap_picks where pm_token is not null or (estado='activo' and inicio > now()) order by inicio) x)
) as r;
