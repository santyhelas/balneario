begin;

-- 0057 · Panel del dueño, tercera parte:
--   · Pedidos de los clientes (qué piden y cuántos lo piden).
--   · Renovación de temporada: propuesta de precio por balneario, estado y aplicar el precio nuevo.
--   · Presupuesto automático en la web: escalas de precio por cantidad de espacios y el pedido queda en Interesados.
--   · Casos de éxito publicados en la página principal (con permiso del balneario).

-- ---------- Pedidos ----------
create table if not exists private.feature_requests (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (char_length(btrim(title)) between 2 and 140),
  detail     text check (char_length(detail) <= 2000),
  status     text not null default 'pendiente' check (status in ('pendiente','en_curso','hecho','descartado')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  done_at    timestamptz
);
create table if not exists private.feature_request_votes (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references private.feature_requests(id) on delete cascade,
  workspace_id uuid references public.workspaces(id) on delete set null,
  who          text check (char_length(who) <= 100),
  note         text check (char_length(note) <= 500),
  created_at   timestamptz not null default now(),
  check (workspace_id is not null or char_length(btrim(coalesce(who, ''))) > 0)
);
alter table private.feature_requests enable row level security;
alter table private.feature_request_votes enable row level security;
revoke all on private.feature_requests, private.feature_request_votes from public, anon, authenticated;

create or replace function public.admin_requests() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'titulo', r.title, 'detalle', r.detail, 'estado', r.status,
            'creado', r.created_at, 'hecho', r.done_at,
            'votos', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'balneario_id', v.workspace_id,
                         'quien', coalesce(w.name, v.who), 'nota', v.note, 'fecha', v.created_at) order by v.created_at)
                       from private.feature_request_votes v left join public.workspaces w on w.id = v.workspace_id
                      where v.request_id = r.id), '[]'::jsonb))
          order by (r.status in ('hecho','descartado')), (select count(*) from private.feature_request_votes v where v.request_id = r.id) desc, r.created_at)
        from private.feature_requests r), '[]'::jsonb);
end $$;
create or replace function public.admin_save_request(p_id uuid, p_title text, p_detail text, p_status text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_platform_admin();
  if char_length(btrim(coalesce(p_title, ''))) < 2 then raise exception 'Poné qué piden.'; end if;
  if p_id is null then
    insert into private.feature_requests (title, detail, status) values (btrim(p_title), nullif(btrim(coalesce(p_detail, '')), ''), coalesce(p_status, 'pendiente'))
    returning id into v_id;
  else
    update private.feature_requests set title = btrim(p_title), detail = nullif(btrim(coalesce(p_detail, '')), ''), status = coalesce(p_status, status),
           done_at = case when coalesce(p_status, status) = 'hecho' then coalesce(done_at, now()) else null end, updated_at = now()
     where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Ese pedido no existe.'; end if;
  end if;
  return v_id;
end $$;
create or replace function public.admin_vote_request(p_request_id uuid, p_workspace_id uuid, p_who text, p_note text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_platform_admin();
  if p_workspace_id is null and char_length(btrim(coalesce(p_who, ''))) = 0 then raise exception 'Elegí el balneario o escribí quién lo pidió.'; end if;
  if p_workspace_id is not null and exists (select 1 from private.feature_request_votes where request_id = p_request_id and workspace_id = p_workspace_id) then
    raise exception 'Ese balneario ya lo había pedido.';
  end if;
  insert into private.feature_request_votes (request_id, workspace_id, who, note)
  values (p_request_id, p_workspace_id, nullif(btrim(coalesce(p_who, '')), ''), nullif(btrim(coalesce(p_note, '')), '')) returning id into v_id;
  update private.feature_requests set updated_at = now() where id = p_request_id;
  return v_id;
end $$;
create or replace function public.admin_delete_vote(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  delete from private.feature_request_votes where id = p_id;
end $$;
revoke all on function public.admin_requests(), public.admin_save_request(uuid, text, text, text), public.admin_vote_request(uuid, uuid, text, text),
  public.admin_delete_vote(uuid) from public, anon;
grant execute on function public.admin_requests(), public.admin_save_request(uuid, text, text, text), public.admin_vote_request(uuid, uuid, text, text),
  public.admin_delete_vote(uuid) to authenticated;

-- ---------- Renovación de temporada ----------
create table if not exists private.renewals (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  season       integer not null check (season between 2020 and 2100),
  plan         text not null check (plan in ('anual','temporada')),
  price        numeric(14,2) not null check (price >= 0),
  entry        numeric(14,2) check (entry >= 0),
  installment  numeric(14,2) check (installment >= 0),
  status       text not null default 'pendiente' check (status in ('pendiente','enviada','acepta','no_renueva')),
  note         text check (char_length(note) <= 500),
  sent_at      timestamptz,
  applied_at   timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, season)
);
alter table private.renewals enable row level security;
revoke all on private.renewals from public, anon, authenticated;

create or replace function public.admin_renewals(p_season integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', w.id, 'nombre', w.name, 'telefono', w.phone, 'pausado', w.paused_at is not null,
      'correo', (select u.email from public.workspace_members m join auth.users u on u.id = m.user_id
                  where m.workspace_id = w.id and m.role = 'propietario' order by m.created_at limit 1),
      'actual', jsonb_build_object('plan', s.plan, 'precio', s.price, 'entrada', s.entry_amount, 'cuota', s.installment_amount, 'pago_hasta', s.paid_until),
      'propuesta', (select jsonb_build_object('plan', r.plan, 'precio', r.price, 'entrada', r.entry, 'cuota', r.installment, 'estado', r.status,
                                              'nota', r.note, 'enviada', r.sent_at, 'aplicada', r.applied_at)
                      from private.renewals r where r.workspace_id = w.id and r.season = p_season)
    ) order by w.name)
    from public.workspaces w join public.subscriptions s on s.workspace_id = w.id
   where not w.is_demo and s.status <> 'exenta'), '[]'::jsonb);
end $$;

create or replace function public.admin_save_renewal(p_workspace_id uuid, p_season integer, p_plan text, p_price numeric, p_entry numeric,
                                                     p_installment numeric, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_price numeric := p_price;
begin
  perform private.require_platform_admin();
  if p_plan not in ('anual','temporada') then raise exception 'Plan inválido.'; end if;
  if p_plan = 'temporada' then
    if p_entry is null or p_entry < 0 or p_installment is null or p_installment < 0 then raise exception 'Poné la entrada y la cuota.'; end if;
    v_price := p_entry + 2 * p_installment;
  end if;
  if v_price is null or v_price < 0 then raise exception 'Precio inválido.'; end if;
  insert into private.renewals (workspace_id, season, plan, price, entry, installment, status, note, sent_at)
  values (p_workspace_id, p_season, p_plan, round(v_price, 2), case when p_plan = 'temporada' then round(p_entry, 2) end,
          case when p_plan = 'temporada' then round(p_installment, 2) end, coalesce(p_status, 'pendiente'), nullif(btrim(coalesce(p_note, '')), ''),
          case when p_status = 'enviada' then now() end)
  on conflict (workspace_id, season) do update set
    plan = excluded.plan, price = excluded.price, entry = excluded.entry, installment = excluded.installment, status = excluded.status,
    note = excluded.note, sent_at = coalesce(private.renewals.sent_at, excluded.sent_at), updated_at = now();
end $$;

-- Aplica el precio aceptado al plan del balneario (lo que paga desde ahora). No toca pagos ni fechas.
create or replace function public.admin_apply_renewal(p_workspace_id uuid, p_season integer) returns void
language plpgsql security definer set search_path = '' as $$
declare r private.renewals%rowtype;
begin
  perform private.require_platform_admin();
  select * into r from private.renewals where workspace_id = p_workspace_id and season = p_season for update;
  if not found then raise exception 'Ese balneario no tiene propuesta para esa temporada.'; end if;
  if r.status <> 'acepta' then raise exception 'Primero marcá que acepta la propuesta.'; end if;
  perform public.admin_set_plan(p_workspace_id, r.plan, r.price, false, r.entry, r.installment);
  update private.renewals set applied_at = now(), updated_at = now() where workspace_id = p_workspace_id and season = p_season;
end $$;
revoke all on function public.admin_renewals(integer), public.admin_save_renewal(uuid, integer, text, numeric, numeric, numeric, text, text),
  public.admin_apply_renewal(uuid, integer) from public, anon;
grant execute on function public.admin_renewals(integer), public.admin_save_renewal(uuid, integer, text, numeric, numeric, numeric, text, text),
  public.admin_apply_renewal(uuid, integer) to authenticated;

-- ---------- Presupuesto automático ----------
create table if not exists private.price_tiers (
  id       uuid primary key default gen_random_uuid(),
  up_to    integer check (up_to is null or up_to between 1 and 10000),  -- hasta cuántos espacios (carpas + sombrillas); vacío = sin límite
  anual    numeric(14,2) not null check (anual >= 0),
  entrada  numeric(14,2) not null check (entrada >= 0),
  cuota    numeric(14,2) not null check (cuota >= 0)
);
alter table private.price_tiers enable row level security;
revoke all on private.price_tiers from public, anon, authenticated;

create table if not exists private.quote_requests_log (hash text not null, at timestamptz not null default now());
create index if not exists quote_requests_log_idx on private.quote_requests_log(hash, at);
alter table private.quote_requests_log enable row level security;
revoke all on private.quote_requests_log from public, anon, authenticated;

alter table private.owner_leads add column if not exists tents integer check (tents between 0 and 5000);
alter table private.owner_leads add column if not exists umbrellas integer check (umbrellas between 0 and 5000);
alter table private.owner_leads add column if not exists quote jsonb;
alter table private.owner_leads drop constraint if exists owner_leads_source_check;
alter table private.owner_leads add constraint owner_leads_source_check check (source in ('whatsapp','instagram','correo','demo','recomendacion','visita','web','otro'));

-- Escalas que se ven en la web (los precios son públicos).
create or replace function public.price_tiers() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('hasta', up_to, 'anual', anual, 'entrada', entrada, 'cuota', cuota) order by up_to nulls last), '[]'::jsonb)
    from private.price_tiers
$$;
revoke all on function public.price_tiers() from public;
grant execute on function public.price_tiers() to anon, authenticated;

create or replace function public.admin_save_price_tiers(p_tiers jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare t jsonb; v_open integer := 0;
begin
  perform private.require_platform_admin();
  if jsonb_typeof(p_tiers) <> 'array' or jsonb_array_length(p_tiers) > 10 then raise exception 'Escalas inválidas (hasta 10).'; end if;
  if (select count(*) from jsonb_array_elements(p_tiers) x where nullif(x ->> 'hasta', '') is not null)
     <> (select count(distinct (x ->> 'hasta')) from jsonb_array_elements(p_tiers) x where nullif(x ->> 'hasta', '') is not null) then
    raise exception 'Hay dos escalas con el mismo «hasta».';
  end if;
  delete from private.price_tiers;
  for t in select * from jsonb_array_elements(p_tiers) loop
    if nullif(t ->> 'hasta', '') is null then v_open := v_open + 1; end if;
    insert into private.price_tiers (up_to, anual, entrada, cuota)
    values (nullif(t ->> 'hasta', '')::integer, (t ->> 'anual')::numeric, (t ->> 'entrada')::numeric, (t ->> 'cuota')::numeric);
  end loop;
  if v_open > 1 then raise exception 'Solo puede haber una escala «sin límite».'; end if;
end $$;
revoke all on function public.admin_save_price_tiers(jsonb) from public, anon;
grant execute on function public.admin_save_price_tiers(jsonb) to authenticated;

-- Pedido de presupuesto desde la web (lo llama el servidor, con la IP cifrada para frenar abusos).
create or replace function public.submit_quote_request(p_hash text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_t integer := coalesce(nullif(p ->> 'carpas', '')::integer, 0); v_u integer := coalesce(nullif(p ->> 'sombrillas', '')::integer, 0);
        v_tier private.price_tiers%rowtype; v_quote jsonb;
begin
  if (select count(*) from private.quote_requests_log where hash = p_hash and at > now() - interval '1 day') >= 5 then
    raise exception 'Ya mandaste varios pedidos hoy. Escribinos por WhatsApp y te respondemos.';
  end if;
  if char_length(btrim(coalesce(p ->> 'nombre', ''))) < 2 then raise exception 'Poné tu nombre.'; end if;
  if char_length(btrim(coalesce(p ->> 'telefono', ''))) < 6 and coalesce(p ->> 'correo', '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Dejanos un teléfono o un correo para responderte.';
  end if;
  if v_t < 0 or v_u < 0 or v_t + v_u = 0 or v_t + v_u > 5000 then raise exception 'Poné cuántas carpas y sombrillas tenés.'; end if;
  insert into private.quote_requests_log (hash) values (p_hash);
  delete from private.quote_requests_log where at < now() - interval '7 days';
  select * into v_tier from private.price_tiers where up_to is null or up_to >= v_t + v_u order by up_to nulls last limit 1;
  if found then v_quote := jsonb_build_object('anual', v_tier.anual, 'entrada', v_tier.entrada, 'cuota', v_tier.cuota, 'hasta', v_tier.up_to); end if;
  insert into private.owner_leads (name, business, phone, email, city, source, status, notes, tents, umbrellas, quote)
  values (left(btrim(p ->> 'nombre'), 100), nullif(left(btrim(coalesce(p ->> 'balneario', '')), 100), ''), nullif(left(btrim(coalesce(p ->> 'telefono', '')), 40), ''),
          nullif(lower(left(btrim(coalesce(p ->> 'correo', '')), 120)), ''), nullif(left(btrim(coalesce(p ->> 'ciudad', '')), 80), ''), 'web', 'nuevo',
          'Pidió presupuesto en la web: ' || v_t || ' carpas y ' || v_u || ' sombrillas.' || coalesce(E'\n' || nullif(left(btrim(coalesce(p ->> 'mensaje', '')), 1500), ''), ''),
          v_t, v_u, v_quote);
  return coalesce(v_quote, '{}'::jsonb);
end $$;
revoke all on function public.submit_quote_request(text, jsonb) from public, anon, authenticated;
grant execute on function public.submit_quote_request(text, jsonb) to service_role;

-- Interesados: también devuelve carpas, sombrillas y el precio que vio en la web.
create or replace function public.admin_leads() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := private.today_ar();
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
    'hoy', v_today,
    'interesados', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'nombre', name, 'balneario', business, 'telefono', phone, 'correo', email,
                     'ciudad', city, 'origen', source, 'estado', status, 'notas', notes, 'proximo_contacto', next_contact,
                     'creado', created_at, 'actualizado', updated_at, 'cerrado', closed_at, 'version', version,
                     'carpas', tents, 'sombrillas', umbrellas, 'presupuesto', quote) order by updated_at desc)
                     from private.owner_leads), '[]'::jsonb),
    'embudo', (select jsonb_agg(jsonb_build_object('mes', to_char(m, 'YYYY-MM'),
                 'demo', (select count(*) from private.demo_visitors d where d.first_at >= m and d.first_at < m + interval '1 month'),
                 'consultas', (select count(*) from private.owner_leads l where l.created_at >= m and l.created_at < m + interval '1 month'),
                 'clientes', (select count(*) from public.workspaces w where not w.is_demo and w.created_at >= m and w.created_at < m + interval '1 month')) order by m)
               from generate_series(date_trunc('month', v_today) - interval '11 months', date_trunc('month', v_today), interval '1 month') m)
  );
end $$;

-- ---------- Casos de éxito ----------
create table if not exists private.success_cases (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete set null,
  name         text not null check (char_length(btrim(name)) between 2 and 100),
  city         text check (char_length(city) <= 80),
  quote        text check (char_length(quote) <= 600),
  author       text check (char_length(author) <= 100),
  consent      boolean not null default false,
  stats        jsonb not null default '[]'::jsonb,
  published    boolean not null default false,
  sort         integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (not published or consent)
);
alter table private.success_cases enable row level security;
revoke all on private.success_cases from public, anon, authenticated;

-- Números reales de un balneario para elegir cuáles mostrar (se guardan fijos al publicar).
create or replace function public.admin_case_stats(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  return jsonb_build_array(
    jsonb_build_object('clave', 'reservas', 'valor', (select count(*) from public.reservations where workspace_id = p_workspace_id and status = 'confirmada'), 'texto', 'reservas cargadas'),
    jsonb_build_object('clave', 'reservas_12m', 'valor', (select count(*) from public.reservations where workspace_id = p_workspace_id and status = 'confirmada' and created_at > now() - interval '12 months'), 'texto', 'reservas en el último año'),
    jsonb_build_object('clave', 'clientes', 'valor', (select count(*) from public.customers where workspace_id = p_workspace_id), 'texto', 'clientes en su agenda'),
    jsonb_build_object('clave', 'espacios', 'valor', (select count(*) from public.spaces where workspace_id = p_workspace_id and active), 'texto', 'carpas y sombrillas en el mapa'),
    jsonb_build_object('clave', 'cobros', 'valor', (select count(*) from public.payments where workspace_id = p_workspace_id and kind = 'cobro'), 'texto', 'cobros registrados')
  );
end $$;

create or replace function public.admin_success_cases() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'balneario_id', workspace_id, 'nombre', name, 'ciudad', city, 'frase', quote, 'autor', author,
                     'permiso', consent, 'numeros', stats, 'publicado', published, 'orden', sort, 'actualizado', updated_at) order by sort, created_at)
                     from private.success_cases), '[]'::jsonb);
end $$;

create or replace function public.admin_save_success_case(p_id uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_pub boolean := coalesce((p ->> 'publicado')::boolean, false); v_ok boolean := coalesce((p ->> 'permiso')::boolean, false);
begin
  perform private.require_platform_admin();
  if char_length(btrim(coalesce(p ->> 'nombre', ''))) < 2 then raise exception 'Poné el nombre del balneario.'; end if;
  if v_pub and not v_ok then raise exception 'Para publicarlo tenés que tener el permiso del balneario.'; end if;
  if jsonb_typeof(coalesce(p -> 'numeros', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p -> 'numeros', '[]'::jsonb)) > 4 then
    raise exception 'Elegí hasta 4 números.';
  end if;
  if p_id is null then
    insert into private.success_cases (workspace_id, name, city, quote, author, consent, stats, published, sort)
    values (nullif(p ->> 'balneario_id', '')::uuid, btrim(p ->> 'nombre'), nullif(btrim(coalesce(p ->> 'ciudad', '')), ''), nullif(btrim(coalesce(p ->> 'frase', '')), ''),
            nullif(btrim(coalesce(p ->> 'autor', '')), ''), v_ok, coalesce(p -> 'numeros', '[]'::jsonb), v_pub, coalesce((p ->> 'orden')::integer, 0))
    returning id into v_id;
  else
    update private.success_cases set workspace_id = nullif(p ->> 'balneario_id', '')::uuid, name = btrim(p ->> 'nombre'),
           city = nullif(btrim(coalesce(p ->> 'ciudad', '')), ''), quote = nullif(btrim(coalesce(p ->> 'frase', '')), ''),
           author = nullif(btrim(coalesce(p ->> 'autor', '')), ''), consent = v_ok, stats = coalesce(p -> 'numeros', '[]'::jsonb),
           published = v_pub, sort = coalesce((p ->> 'orden')::integer, sort), updated_at = now()
     where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Ese caso no existe.'; end if;
  end if;
  return v_id;
end $$;
create or replace function public.admin_delete_success_case(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  delete from private.success_cases where id = p_id;
end $$;
revoke all on function public.admin_case_stats(uuid), public.admin_success_cases(), public.admin_save_success_case(uuid, jsonb),
  public.admin_delete_success_case(uuid) from public, anon;
grant execute on function public.admin_case_stats(uuid), public.admin_success_cases(), public.admin_save_success_case(uuid, jsonb),
  public.admin_delete_success_case(uuid) to authenticated;

-- Para la página principal: solo los publicados (con permiso).
create or replace function public.success_cases() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('nombre', name, 'ciudad', city, 'frase', quote, 'autor', author, 'numeros', stats) order by sort, created_at), '[]'::jsonb)
    from private.success_cases where published and consent
$$;
revoke all on function public.success_cases() from public;
grant execute on function public.success_cases() to anon, authenticated;

commit;
