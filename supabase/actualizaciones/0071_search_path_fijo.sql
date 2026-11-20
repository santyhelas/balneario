begin;
-- 0071: ruta de búsqueda fija en las funciones auxiliares (aviso «Function Search Path Mutable» de Supabase).
-- Sin esto, quien llama a la función decide en qué esquemas se buscan las tablas y funciones.
-- Se fija la misma ruta que usan hoy (public, extensions), así que el comportamiento no cambia.

alter function private.ars(p numeric) set search_path = public, extensions, pg_temp;
alter function private.cash_sessions_guard() set search_path = public, extensions, pg_temp;
alter function private.changes_guard() set search_path = public, extensions, pg_temp;
alter function private.check_version() set search_path = public, extensions, pg_temp;
alter function private.current_user_email() set search_path = public, extensions, pg_temp;
alter function private.current_user_id() set search_path = public, extensions, pg_temp;
alter function private.default_layer(p_kind text, p_label text) set search_path = public, extensions, pg_temp;
alter function private.discount_default_label() set search_path = public, extensions, pg_temp;
alter function private.expenses_guard() set search_path = public, extensions, pg_temp;
alter function private.extend_until(p_plan text, p_current date, p_paid_on date) set search_path = public, extensions, pg_temp;
alter function private.forbid_change() set search_path = public, extensions, pg_temp;
alter function private.is_guest() set search_path = public, extensions, pg_temp;
alter function private.lock_spaces(p_space_ids uuid[]) set search_path = public, extensions, pg_temp;
alter function private.next_season_start(p_day date) set search_path = public, extensions, pg_temp;
alter function private.no_show_reason(p_day date) set search_path = public, extensions, pg_temp;
alter function private.normalize_username(p text) set search_path = public, extensions, pg_temp;
alter function private.parador_features() set search_path = public, extensions, pg_temp;
alter function private.parador_spaces() set search_path = public, extensions, pg_temp;
alter function private.purging(p_ws text) set search_path = public, extensions, pg_temp;
alter function private.restore_tables() set search_path = public, extensions, pg_temp;
alter function private.restoring(p_ws text) set search_path = public, extensions, pg_temp;
alter function private.season_end(p_day date) set search_path = public, extensions, pg_temp;
alter function private.season_part_until(p_season_end date, p_part integer) set search_path = public, extensions, pg_temp;
alter function private.space_label(p_kind text, p_code text) set search_path = public, extensions, pg_temp;
alter function private.spaces_guard() set search_path = public, extensions, pg_temp;
alter function private.today_ar() set search_path = public, extensions, pg_temp;
alter function private.valid_method(p text) set search_path = public, extensions, pg_temp;
alter function private.valid_payment_method(p text) set search_path = public, extensions, pg_temp;
alter function private.validate_timezone() set search_path = public, extensions, pg_temp;

commit;
