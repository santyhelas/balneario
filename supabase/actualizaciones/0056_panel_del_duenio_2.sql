begin;

-- 0056 · Panel del dueño, segunda parte:
--   · Datos de cobro (alias/CBU) y recibos numerados de los pagos de los balnearios.
--   · Gastos fijos (todos los meses / todos los años) que se cargan con un clic.
--   · Interesados (los que piden presupuesto) y el embudo demo → consulta → cliente.
--   · Notas internas por balneario.
--   · Avisos a todos los balnearios (les aparece en su panel hasta que tocan «Entendido»).
--   · Estado del sistema: copias de seguridad y Google Drive de cada balneario.

-- ---------- Datos de cobro y recibos ----------
alter table private.plataforma add column if not exists cobro_alias   text check (char_length(cobro_alias) <= 60);
alter table private.plataforma add column if not exists cobro_cbu     text check (char_length(cobro_cbu) <= 40);
alter table private.plataforma add column if not exists cobro_titular text check (char_length(cobro_titular) <= 100);
alter table private.plataforma add column if not exists cobro_banco   text check (char_length(cobro_banco) <= 60);
alter table private.plataforma add column if not exists recibo_emisor text check (char_length(recibo_emisor) <= 120);
alter table private.plataforma add column if not exists recibo_cuit   text check (char_length(recibo_cuit) <= 20);

create sequence if not exists private.owner_receipt_seq;
create table if not exists private.owner_receipts (
  number        integer primary key default nextval('private.owner_receipt_seq'),
  event_id      uuid unique references public.subscription_events(id) on delete set null,
  workspace_id  uuid,
  workspace_name text not null,
  owner_email   text,
  amount        numeric(14,2) not null,
  paid_at       timestamptz not null,
  concept       text,
  created_at    timestamptz not null default now()
);
alter table private.owner_receipts enable row level security;
revoke all on private.owner_receipts from public, anon, authenticated;
revoke all on sequence private.owner_receipt_seq from public, anon, authenticated;

create or replace function public.admin_set_billing_info(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  update private.plataforma set
    cobro_alias   = nullif(btrim(p ->> 'alias'), ''),
    cobro_cbu     = nullif(btrim(p ->> 'cbu'), ''),
    cobro_titular = nullif(btrim(p ->> 'titular'), ''),
    cobro_banco   = nullif(btrim(p ->> 'banco'), ''),
    recibo_emisor = nullif(btrim(p ->> 'emisor'), ''),
    recibo_cuit   = nullif(btrim(p ->> 'cuit'), '')
  where id = 1;
end $$;
revoke all on function public.admin_set_billing_info(jsonb) from public, anon;
grant execute on function public.admin_set_billing_info(jsonb) to authenticated;

-- Contactos, pagos y datos de cobro (para el calendario de cobros, los recordatorios y los recibos).
create or replace function public.admin_billing() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
    'datos', (select jsonb_build_object('alias', cobro_alias, 'cbu', cobro_cbu, 'titular', cobro_titular, 'banco', cobro_banco,
                                        'emisor', recibo_emisor, 'cuit', recibo_cuit) from private.plataforma where id = 1),
    'balnearios', coalesce((select jsonb_agg(jsonb_build_object(
        'id', w.id, 'nombre', w.name, 'telefono', w.phone,
        'correo', (select u.email from public.workspace_members m join auth.users u on u.id = m.user_id
                    where m.workspace_id = w.id and m.role = 'propietario' order by m.created_at limit 1),
        'pagos', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'importe', e.amount, 'fecha', e.created_at, 'detalle', e.detail,
                                                               'recibo', (select r.number from private.owner_receipts r where r.event_id = e.id)) order by e.created_at desc)
                             from public.subscription_events e where e.workspace_id = w.id and e.kind in ('pago_manual','pago_aprobado')), '[]'::jsonb)
      ) order by w.name) from public.workspaces w where not w.is_demo), '[]'::jsonb)
  );
end $$;
revoke all on function public.admin_billing() from public, anon;
grant execute on function public.admin_billing() to authenticated;

-- Recibo de un pago: se numera la primera vez (siempre el mismo número para el mismo pago).
create or replace function public.admin_receipt(p_event_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e public.subscription_events%rowtype; r private.owner_receipts%rowtype;
begin
  perform private.require_platform_admin();
  select * into r from private.owner_receipts where event_id = p_event_id;
  if not found then
    select * into e from public.subscription_events where id = p_event_id and kind in ('pago_manual','pago_aprobado');
    if not found then raise exception 'Ese pago no existe.'; end if;
    insert into private.owner_receipts (event_id, workspace_id, workspace_name, owner_email, amount, paid_at, concept)
    select e.id, w.id, w.name,
           (select u.email from public.workspace_members m join auth.users u on u.id = m.user_id
             where m.workspace_id = w.id and m.role = 'propietario' order by m.created_at limit 1),
           e.amount, e.created_at, e.detail
      from public.workspaces w where w.id = e.workspace_id
    on conflict (event_id) do nothing;
    select * into r from private.owner_receipts where event_id = p_event_id;
  end if;
  return jsonb_build_object('numero', r.number, 'balneario', r.workspace_name, 'correo', r.owner_email, 'importe', r.amount,
                            'fecha', r.paid_at, 'concepto', r.concept, 'emitido', r.created_at,
                            'emisor', (select jsonb_build_object('nombre', recibo_emisor, 'cuit', recibo_cuit, 'alias', cobro_alias) from private.plataforma where id = 1));
end $$;
revoke all on function public.admin_receipt(uuid) from public, anon;
grant execute on function public.admin_receipt(uuid) to authenticated;

-- ---------- Gastos fijos ----------
create table if not exists private.owner_recurring (
  id        uuid primary key default gen_random_uuid(),
  concept   text not null check (char_length(btrim(concept)) between 2 and 120),
  category  text not null check (category in ('servidores','dominio_correo','publicidad','herramientas','viajes','impuestos','otros')),
  amount    numeric(14,2) not null check (amount > 0),
  every     text not null check (every in ('mes','anio')),
  next_on   date not null,
  active    boolean not null default true,
  created_at timestamptz not null default now()
);
alter table private.owner_recurring enable row level security;
revoke all on private.owner_recurring from public, anon, authenticated;
alter table private.owner_expenses add column if not exists recurring_id uuid references private.owner_recurring(id) on delete set null;
create unique index if not exists owner_expenses_recurring_uq on private.owner_expenses(recurring_id, spent_on) where recurring_id is not null;

create or replace function public.admin_recurring() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'concepto', concept, 'categoria', category, 'importe', amount,
                                                       'cada', every, 'proximo', next_on, 'activo', active,
                                                       'vencido', active and next_on <= private.today_ar()) order by active desc, next_on)
                     from private.owner_recurring), '[]'::jsonb);
end $$;

create or replace function public.admin_save_recurring(p_id uuid, p_concept text, p_category text, p_amount numeric, p_every text, p_next date, p_active boolean default true)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_platform_admin();
  if p_amount is null or p_amount <= 0 then raise exception 'El importe tiene que ser mayor a cero.'; end if;
  if char_length(btrim(coalesce(p_concept, ''))) < 2 then raise exception 'Poné el concepto del gasto.'; end if;
  if p_next is null then raise exception 'Poné la fecha del próximo gasto.'; end if;
  if p_id is null then
    insert into private.owner_recurring (concept, category, amount, every, next_on, active)
    values (btrim(p_concept), p_category, round(p_amount, 2), p_every, p_next, coalesce(p_active, true)) returning id into v_id;
  else
    update private.owner_recurring set concept = btrim(p_concept), category = p_category, amount = round(p_amount, 2), every = p_every,
           next_on = p_next, active = coalesce(p_active, true) where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Ese gasto fijo no existe.'; end if;
  end if;
  return v_id;
end $$;

-- Carga el gasto fijo que venció (con el importe que se indique, por si cambió) o lo saltea; pasa al próximo mes/año.
create or replace function public.admin_apply_recurring(p_id uuid, p_amount numeric default null, p_skip boolean default false)
returns date language plpgsql security definer set search_path = '' as $$
declare r private.owner_recurring%rowtype; v_next date;
begin
  perform private.require_platform_admin();
  select * into r from private.owner_recurring where id = p_id for update;
  if not found then raise exception 'Ese gasto fijo no existe.'; end if;
  if not r.active then raise exception 'Ese gasto fijo está pausado.'; end if;
  if r.next_on > private.today_ar() then raise exception 'Todavía no venció (el próximo es el %).', to_char(r.next_on, 'DD/MM/YYYY'); end if;
  if not coalesce(p_skip, false) then
    if coalesce(p_amount, r.amount) <= 0 then raise exception 'El importe tiene que ser mayor a cero.'; end if;
    insert into private.owner_expenses (spent_on, concept, category, amount, created_by, recurring_id)
    values (r.next_on, r.concept, r.category, round(coalesce(p_amount, r.amount), 2), auth.uid(), r.id)
    on conflict do nothing;
  end if;
  v_next := (r.next_on + case when r.every = 'mes' then interval '1 month' else interval '1 year' end)::date;
  update private.owner_recurring set next_on = v_next, amount = case when p_amount is not null and p_amount > 0 then round(p_amount, 2) else amount end where id = p_id;
  return v_next;
end $$;
revoke all on function public.admin_recurring(), public.admin_save_recurring(uuid, text, text, numeric, text, date, boolean),
  public.admin_apply_recurring(uuid, numeric, boolean) from public, anon;
grant execute on function public.admin_recurring(), public.admin_save_recurring(uuid, text, text, numeric, text, date, boolean),
  public.admin_apply_recurring(uuid, numeric, boolean) to authenticated;

-- ---------- Interesados y embudo ----------
create table if not exists private.owner_leads (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(btrim(name)) between 2 and 100),
  business     text check (char_length(business) <= 100),
  phone        text check (char_length(phone) <= 40),
  email        text check (char_length(email) <= 120),
  city         text check (char_length(city) <= 80),
  source       text check (source in ('whatsapp','instagram','correo','demo','recomendacion','visita','otro')),
  status       text not null default 'nuevo' check (status in ('nuevo','contactado','propuesta','demo','cerrado','perdido')),
  notes        text check (char_length(notes) <= 2000),
  next_contact date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  closed_at    timestamptz,
  version      integer not null default 1
);
alter table private.owner_leads enable row level security;
revoke all on private.owner_leads from public, anon, authenticated;

create or replace function public.admin_leads() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_today date := private.today_ar();
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
    'hoy', v_today,
    'interesados', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'nombre', name, 'balneario', business, 'telefono', phone, 'correo', email,
                     'ciudad', city, 'origen', source, 'estado', status, 'notas', notes, 'proximo_contacto', next_contact,
                     'creado', created_at, 'actualizado', updated_at, 'cerrado', closed_at, 'version', version) order by updated_at desc)
                     from private.owner_leads), '[]'::jsonb),
    'embudo', (select jsonb_agg(jsonb_build_object('mes', to_char(m, 'YYYY-MM'),
                 'demo', (select count(*) from private.demo_visitors d where d.first_at >= m and d.first_at < m + interval '1 month'),
                 'consultas', (select count(*) from private.owner_leads l where l.created_at >= m and l.created_at < m + interval '1 month'),
                 'clientes', (select count(*) from public.workspaces w where not w.is_demo and w.created_at >= m and w.created_at < m + interval '1 month')) order by m)
               from generate_series(date_trunc('month', v_today) - interval '11 months', date_trunc('month', v_today), interval '1 month') m)
  );
end $$;

create or replace function public.admin_save_lead(p_id uuid, p_version integer, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_status text := coalesce(nullif(p ->> 'estado', ''), 'nuevo'); v_old private.owner_leads%rowtype;
begin
  perform private.require_platform_admin();
  if char_length(btrim(coalesce(p ->> 'nombre', ''))) < 2 then raise exception 'Poné el nombre del interesado.'; end if;
  if p_id is null then
    insert into private.owner_leads (name, business, phone, email, city, source, status, notes, next_contact, closed_at)
    values (btrim(p ->> 'nombre'), nullif(btrim(p ->> 'balneario'), ''), nullif(btrim(p ->> 'telefono'), ''), nullif(lower(btrim(p ->> 'correo')), ''),
            nullif(btrim(p ->> 'ciudad'), ''), nullif(p ->> 'origen', ''), v_status, nullif(btrim(p ->> 'notas'), ''),
            nullif(p ->> 'proximo_contacto', '')::date, case when v_status = 'cerrado' then now() end)
    returning id into v_id;
    return v_id;
  end if;
  select * into v_old from private.owner_leads where id = p_id for update;
  if not found then raise exception 'Ese interesado no existe.'; end if;
  if v_old.version <> p_version then
    raise exception 'Este dato fue modificado desde otro dispositivo. Recargá la pantalla e intentá de nuevo.' using errcode = '40001', hint = 'CONFLICTO_VERSION';
  end if;
  update private.owner_leads set
    name = btrim(p ->> 'nombre'), business = nullif(btrim(p ->> 'balneario'), ''), phone = nullif(btrim(p ->> 'telefono'), ''),
    email = nullif(lower(btrim(p ->> 'correo')), ''), city = nullif(btrim(p ->> 'ciudad'), ''), source = nullif(p ->> 'origen', ''),
    status = v_status, notes = nullif(btrim(p ->> 'notas'), ''), next_contact = nullif(p ->> 'proximo_contacto', '')::date,
    closed_at = case when v_status = 'cerrado' then coalesce(v_old.closed_at, now()) else null end,
    updated_at = now(), version = version + 1
  where id = p_id;
  return p_id;
end $$;
revoke all on function public.admin_leads(), public.admin_save_lead(uuid, integer, jsonb) from public, anon;
grant execute on function public.admin_leads(), public.admin_save_lead(uuid, integer, jsonb) to authenticated;

-- ---------- Notas internas por balneario ----------
create table if not exists private.owner_notes (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  body         text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at   timestamptz not null default now(),
  created_by   uuid
);
create index if not exists owner_notes_ws_idx on private.owner_notes(workspace_id, created_at desc);
alter table private.owner_notes enable row level security;
revoke all on private.owner_notes from public, anon, authenticated;

create or replace function public.admin_notes(p_workspace_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  if p_workspace_id is null then
    return coalesce((select jsonb_object_agg(workspace_id, n) from (select workspace_id, count(*) n from private.owner_notes group by workspace_id) c), '{}'::jsonb);
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'texto', body, 'fecha', created_at) order by created_at desc)
                     from private.owner_notes where workspace_id = p_workspace_id), '[]'::jsonb);
end $$;
create or replace function public.admin_add_note(p_workspace_id uuid, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_platform_admin();
  if char_length(btrim(coalesce(p_body, ''))) = 0 then raise exception 'Escribí la nota.'; end if;
  insert into private.owner_notes (workspace_id, body, created_by) values (p_workspace_id, btrim(p_body), auth.uid()) returning id into v_id;
  return v_id;
end $$;
create or replace function public.admin_delete_note(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  delete from private.owner_notes where id = p_id;
end $$;
revoke all on function public.admin_notes(uuid), public.admin_add_note(uuid, text), public.admin_delete_note(uuid) from public, anon;
grant execute on function public.admin_notes(uuid), public.admin_add_note(uuid, text), public.admin_delete_note(uuid) to authenticated;

-- ---------- Avisos a todos los balnearios ----------
create table if not exists private.announcements (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (char_length(btrim(title)) between 2 and 120),
  body       text not null check (char_length(btrim(body)) between 2 and 2000),
  tone       text not null default 'info' check (tone in ('info','novedad','importante')),
  ends_on    date not null,
  ended_at   timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid
);
create table if not exists private.announcement_reads (
  announcement_id uuid not null references private.announcements(id) on delete cascade,
  user_id         uuid not null,
  read_at         timestamptz not null default now(),
  primary key (announcement_id, user_id)
);
alter table private.announcements enable row level security;
alter table private.announcement_reads enable row level security;
revoke all on private.announcements, private.announcement_reads from public, anon, authenticated;

create or replace function public.admin_announcements() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'titulo', a.title, 'texto', a.body, 'tipo', a.tone, 'hasta', a.ends_on,
                     'creado', a.created_at, 'terminado', a.ended_at,
                     'activo', a.ended_at is null and a.ends_on >= private.today_ar(),
                     'leidos', (select count(*) from private.announcement_reads r where r.announcement_id = a.id)) order by a.created_at desc)
                     from private.announcements a), '[]'::jsonb);
end $$;
create or replace function public.admin_publish_announcement(p_title text, p_body text, p_tone text, p_ends_on date) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_platform_admin();
  if p_ends_on is null or p_ends_on < private.today_ar() then raise exception 'La fecha hasta la que se muestra tiene que ser hoy o después.'; end if;
  insert into private.announcements (title, body, tone, ends_on, created_by)
  values (btrim(p_title), btrim(p_body), coalesce(p_tone, 'info'), p_ends_on, auth.uid()) returning id into v_id;
  return v_id;
end $$;
create or replace function public.admin_end_announcement(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  update private.announcements set ended_at = now() where id = p_id and ended_at is null;
end $$;
revoke all on function public.admin_announcements(), public.admin_publish_announcement(text, text, text, date), public.admin_end_announcement(uuid) from public, anon;
grant execute on function public.admin_announcements(), public.admin_publish_announcement(text, text, text, date), public.admin_end_announcement(uuid) to authenticated;

-- Para los balnearios: los avisos vigentes que este usuario todavía no marcó como leídos.
create or replace function public.my_announcements() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then return '[]'::jsonb; end if;
  if not exists (select 1 from public.workspace_members m join public.workspaces w on w.id = m.workspace_id where m.user_id = auth.uid() and not w.is_demo) then
    return '[]'::jsonb;
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'titulo', a.title, 'texto', a.body, 'tipo', a.tone, 'fecha', a.created_at) order by a.created_at desc)
                     from private.announcements a
                    where a.ended_at is null and a.ends_on >= private.today_ar()
                      and not exists (select 1 from private.announcement_reads r where r.announcement_id = a.id and r.user_id = auth.uid())), '[]'::jsonb);
end $$;
create or replace function public.dismiss_announcement(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Tenés que iniciar sesión.'; end if;
  insert into private.announcement_reads (announcement_id, user_id) select id, auth.uid() from private.announcements where id = p_id
  on conflict do nothing;
end $$;
revoke all on function public.my_announcements(), public.dismiss_announcement(uuid) from public, anon;
grant execute on function public.my_announcements(), public.dismiss_announcement(uuid) to authenticated;

-- ---------- Estado del sistema ----------
create or replace function public.admin_health() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_platform_admin();
  return jsonb_build_object(
    'ahora', now(),
    'balnearios', coalesce((select jsonb_agg(jsonb_build_object(
        'id', w.id, 'nombre', w.name, 'pausado', w.paused_at is not null,
        'ultima_copia', (select max(b.created_at) from public.backups b where b.workspace_id = w.id),
        'ultima_copia_auto', (select max(b.created_at) from public.backups b where b.workspace_id = w.id and b.kind = 'automatica'),
        'copias', (select count(*) from public.backups b where b.workspace_id = w.id),
        'drive', (select jsonb_build_object('correo', d.connected_email, 'ultimo_ok', d.last_ok_at, 'error', d.last_error, 'error_fecha', d.last_error_at)
                    from private.drive_links d where d.workspace_id = w.id),
        'ultimo_movimiento', (select max(h.at) from public.audit_log h where h.workspace_id = w.id)
      ) order by w.name) from public.workspaces w where not w.is_demo), '[]'::jsonb),
    'base', jsonb_build_object('tamanio', pg_database_size(current_database()))
  );
end $$;
revoke all on function public.admin_health() from public, anon;
grant execute on function public.admin_health() to authenticated;

commit;
