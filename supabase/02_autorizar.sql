-- Paso 2: da acceso a tu correo (el mismo con el que vas a iniciar sesion).
insert into ap_autorizados (email) values ('msantos.4321@gmail.com')
on conflict (email) do nothing;
