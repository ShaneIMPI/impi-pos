-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRATION: add multi-event support to an EXISTING live database.
-- Safe to run on your current project — adds things, deletes nothing, and
-- everything you already have gets automatically filed under one event
-- called "Existing Data (Migrated)" so none of it is orphaned.
-- Run this ONCE, in SQL Editor → New query.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Create the events table.
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by text not null,
  created_at timestamptz default now(),
  active boolean not null default true
);

alter table events enable row level security;
drop policy if exists "public all events" on events;
create policy "public all events" on events for all using (true) with check (true);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'events'
  ) then
    alter publication supabase_realtime add table events;
  end if;
end $$;

-- 2. One fixed-id event to hold everything that already exists.
insert into events (id, name, created_by)
select '00000000-0000-0000-0000-000000000001'::uuid, 'Existing Data (Migrated)', 'system'
where not exists (select 1 from events where id = '00000000-0000-0000-0000-000000000001'::uuid);

-- 3. Add event_id to every table (nullable — safe on existing rows) and
--    backfill it onto everything that's already there.
alter table products add column if not exists event_id uuid references events(id);
update products set event_id = '00000000-0000-0000-0000-000000000001'::uuid where event_id is null;

alter table variants add column if not exists event_id uuid references events(id);
update variants v set event_id = p.event_id from products p where p.id = v.product_id and v.event_id is null;

alter table sales add column if not exists event_id uuid references events(id);
update sales set event_id = '00000000-0000-0000-0000-000000000001'::uuid where event_id is null;

alter table sale_items add column if not exists event_id uuid references events(id);
update sale_items si set event_id = s.event_id from sales s where s.id = si.sale_id and si.event_id is null;

alter table adjustments add column if not exists event_id uuid references events(id);
update adjustments set event_id = '00000000-0000-0000-0000-000000000001'::uuid where event_id is null;

alter table loans add column if not exists event_id uuid references events(id);
update loans set event_id = '00000000-0000-0000-0000-000000000001'::uuid where event_id is null;

-- 4. Replace the RPC functions with event-aware versions (same names, same
--    signatures apart from the new p_event_id on complete_sale and
--    wipe_all_data — CREATE OR REPLACE, nothing destructive).

create or replace function complete_sale(
  p_event_id uuid,
  p_cashier text,
  p_client jsonb,
  p_items jsonb,
  p_subtotal numeric,
  p_vat numeric,
  p_total numeric,
  p_test_mode boolean default false,
  p_payment_method text default 'cash'
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_variant_id uuid;
  v_qty integer;
  v_new_qty integer;
  v_invoice_id text;
  v_variant_event uuid;
begin
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_variant_id := (v_item->>'variant_id')::uuid;
    v_qty := (v_item->>'qty')::integer;

    select event_id into v_variant_event from variants where id = v_variant_id;
    if v_variant_event is distinct from p_event_id then
      raise exception 'EVENT_MISMATCH: item does not belong to this event';
    end if;

    update variants set qty = qty - v_qty
    where id = v_variant_id and qty >= v_qty
    returning qty into v_new_qty;

    if not found then
      raise exception 'INSUFFICIENT_STOCK:% :% :requested %', v_item->>'category', v_item->>'size', v_qty;
    end if;
  end loop;

  v_invoice_id := (case when p_test_mode then 'TEST-' else 'IMPI-' end) || nextval('invoice_seq')::text;

  insert into sales(id, event_id, test_mode, date, cashier, client, payment_method, subtotal, vat, total)
  values (v_invoice_id, p_event_id, p_test_mode, to_char(now(),'DD Mon YYYY'), p_cashier, p_client, p_payment_method, p_subtotal, p_vat, p_total);

  insert into sale_items(sale_id, event_id, product_id, category, sku, size, qty, price)
  select v_invoice_id, p_event_id, (i->>'product_id')::uuid, i->>'category', i->>'sku', i->>'size',
         (i->>'qty')::integer, (i->>'price')::numeric
  from jsonb_array_elements(p_items) i;

  return v_invoice_id;
end;
$$;

create or replace function apply_adjustment(
  p_variant_id uuid,
  p_delta integer,
  p_adj_type text,
  p_note text,
  p_cashier text
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before integer;
  v_after integer;
  v_category text;
  v_size text;
  v_product_id uuid;
  v_event_id uuid;
begin
  select v.qty, v.size, v.product_id, p.category, v.event_id
    into v_before, v_size, v_product_id, v_category, v_event_id
  from variants v join products p on p.id = v.product_id
  where v.id = p_variant_id
  for update;

  if not found then
    raise exception 'VARIANT_NOT_FOUND';
  end if;

  v_after := v_before + p_delta;
  if v_after < 0 then
    raise exception 'INSUFFICIENT_STOCK:only % on hand', v_before;
  end if;

  update variants set qty = v_after where id = p_variant_id;

  insert into adjustments(product_id, event_id, category, size, adj_type, delta, note, cashier, before, after)
  values (v_product_id, v_event_id, v_category, v_size, p_adj_type, p_delta, p_note, p_cashier, v_before, v_after);

  return v_after;
end;
$$;

create or replace function set_stock_take(
  p_variant_id uuid,
  p_new_qty integer,
  p_cashier text
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before integer;
  v_category text;
  v_size text;
  v_product_id uuid;
  v_event_id uuid;
begin
  select v.qty, v.size, v.product_id, p.category, v.event_id
    into v_before, v_size, v_product_id, v_category, v_event_id
  from variants v join products p on p.id = v.product_id
  where v.id = p_variant_id
  for update;

  if not found then
    raise exception 'VARIANT_NOT_FOUND';
  end if;

  update variants set qty = p_new_qty where id = p_variant_id;

  insert into adjustments(product_id, event_id, category, size, adj_type, delta, note, cashier, before, after)
  values (v_product_id, v_event_id, v_category, v_size, 'Stock Take', p_new_qty - v_before, 'Stock take count', p_cashier, v_before, p_new_qty);

  return p_new_qty;
end;
$$;

create or replace function create_loan(
  p_variant_id uuid,
  p_qty integer,
  p_borrower text,
  p_note text,
  p_cashier text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_category text; v_size text; v_sku text; v_product_id uuid; v_price numeric; v_new_qty integer; v_loan_id uuid; v_event_id uuid;
begin
  select p.category, v.size, p.sku, v.product_id, v.price, v.event_id
    into v_category, v_size, v_sku, v_product_id, v_price, v_event_id
  from variants v join products p on p.id = v.product_id
  where v.id = p_variant_id;

  if not found then
    raise exception 'VARIANT_NOT_FOUND';
  end if;

  update variants set qty = qty - p_qty
  where id = p_variant_id and qty >= p_qty
  returning qty into v_new_qty;

  if not found then
    raise exception 'INSUFFICIENT_STOCK:% :% :requested %', v_category, v_size, p_qty;
  end if;

  insert into loans(variant_id, event_id, product_id, category, sku, size, qty, price, borrower, note, cashier)
  values (p_variant_id, v_event_id, v_product_id, v_category, v_sku, v_size, p_qty, v_price, p_borrower, p_note, p_cashier)
  returning id into v_loan_id;

  insert into adjustments(product_id, event_id, category, size, adj_type, delta, note, cashier, before, after)
  values (v_product_id, v_event_id, v_category, v_size, 'Loan Out', -p_qty,
    concat('Borrowed by ', p_borrower, case when coalesce(p_note,'')<>'' then ': '||p_note else '' end),
    p_cashier, v_new_qty+p_qty, v_new_qty);

  return v_loan_id;
end;
$$;

create or replace function return_loan(p_loan_id uuid, p_cashier text) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_variant_id uuid; v_qty integer; v_category text; v_size text; v_product_id uuid; v_status text;
  v_before integer; v_after integer;
begin
  select variant_id, qty, category, size, product_id, status
    into v_variant_id, v_qty, v_category, v_size, v_product_id, v_status
  from loans where id = p_loan_id for update;

  if not found then
    raise exception 'LOAN_NOT_FOUND';
  end if;
  if v_status <> 'out' then
    raise exception 'LOAN_ALREADY_RESOLVED';
  end if;

  update variants set qty = qty + v_qty where id = v_variant_id returning qty into v_after;
  v_before := v_after - v_qty;

  update loans set status='returned', resolved_by=p_cashier, resolved_at=now() where id = p_loan_id;

  insert into adjustments(product_id, event_id, category, size, adj_type, delta, note, cashier, before, after)
  select v_product_id, event_id, v_category, v_size, 'Loan Return', v_qty, 'Loan returned', p_cashier, v_before, v_after
  from loans where id = p_loan_id;
end;
$$;

create or replace function invoice_loan(p_loan_id uuid, p_cashier text, p_payment_method text default 'cash') returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loan loans%rowtype;
  v_invoice_id text;
  v_current_qty integer;
begin
  select * into v_loan from loans where id = p_loan_id for update;

  if not found then
    raise exception 'LOAN_NOT_FOUND';
  end if;
  if v_loan.status <> 'out' then
    raise exception 'LOAN_ALREADY_RESOLVED';
  end if;

  v_invoice_id := 'IMPI-' || nextval('invoice_seq')::text;

  insert into sales(id, event_id, test_mode, date, cashier, client, payment_method, subtotal, vat, total)
  values (v_invoice_id, v_loan.event_id, false, to_char(now(),'DD Mon YYYY'), p_cashier,
    jsonb_build_object('name', v_loan.borrower), p_payment_method,
    v_loan.price * v_loan.qty, 0, v_loan.price * v_loan.qty);

  insert into sale_items(sale_id, event_id, product_id, category, sku, size, qty, price)
  values (v_invoice_id, v_loan.event_id, v_loan.product_id, v_loan.category, v_loan.sku, v_loan.size, v_loan.qty, v_loan.price);

  update loans set status='invoiced', resolved_by=p_cashier, resolved_at=now(), sale_id=v_invoice_id
  where id = p_loan_id;

  select qty into v_current_qty from variants where id = v_loan.variant_id;
  insert into adjustments(product_id, event_id, category, size, adj_type, delta, note, cashier, before, after)
  values (v_loan.product_id, v_loan.event_id, v_loan.category, v_loan.size, 'Loan Invoiced', 0,
    concat('Not returned — converted to invoice ', v_invoice_id), p_cashier, v_current_qty, v_current_qty);

  return v_invoice_id;
end;
$$;

create or replace function wipe_all_data(p_event_id uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from loans where event_id = p_event_id;
  delete from sale_items where event_id = p_event_id;
  delete from sales where event_id = p_event_id;
  delete from adjustments where event_id = p_event_id;
  delete from variants where event_id = p_event_id;
  delete from products where event_id = p_event_id;
end;
$$;
