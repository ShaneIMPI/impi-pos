-- ═══════════════════════════════════════════════════════════════════════════
-- IMPI POS — Supabase schema
-- Run this entire file once, in Supabase Dashboard → SQL Editor → New query.
-- Safe to run only once on a fresh project — running it twice will error on
-- "already exists" (harmless, but the objects won't be duplicated).
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";

-- Shared, atomic invoice numbering — guarantees no two devices ever produce
-- the same invoice number, even completing sales at the exact same instant.
create sequence if not exists invoice_seq start 1001;

-- ── Tables ───────────────────────────────────────────────────────────────────
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  sku text,
  created_at timestamptz default now()
);

create table if not exists variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) on delete cascade,
  size text not null,
  price numeric not null default 0,
  qty integer not null default 0
);

create table if not exists sales (
  id text primary key,                          -- e.g. IMPI-1001 / TEST-1001
  test_mode boolean not null default false,
  date text not null,
  cashier text not null,
  client jsonb not null default '{}',
  subtotal numeric not null,
  vat numeric not null,
  total numeric not null,
  created_at timestamptz default now()
);

create table if not exists sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id text references sales(id) on delete cascade,
  product_id uuid,
  category text not null,
  sku text,
  size text not null,
  qty integer not null,
  price numeric not null
);

create table if not exists adjustments (
  id uuid primary key default gen_random_uuid(),
  product_id uuid,
  category text not null,
  size text not null,
  adj_type text not null,
  delta integer not null,
  note text,
  cashier text not null,
  before integer not null,
  after integer not null,
  created_at timestamptz default now()
);

-- ── Row Level Security ──────────────────────────────────────────────────────
-- This app has no per-user login on the database side (staff just type a name
-- client-side, same trust model as the app has always used). These policies
-- open read/write to anyone holding the public anon key — which is the same
-- level of access the GitHub Pages link already has, just extended to the
-- database. If you ever need real per-user database auth, that's a separate,
-- bigger change — flag it and we can plan it.
alter table products    enable row level security;
alter table variants    enable row level security;
alter table sales       enable row level security;
alter table sale_items  enable row level security;
alter table adjustments enable row level security;

drop policy if exists "public all products"    on products;
drop policy if exists "public all variants"    on variants;
drop policy if exists "public all sales"       on sales;
drop policy if exists "public all sale_items"  on sale_items;
drop policy if exists "public all adjustments" on adjustments;

create policy "public all products"    on products    for all using (true) with check (true);
create policy "public all variants"    on variants    for all using (true) with check (true);
create policy "public all sales"       on sales       for all using (true) with check (true);
create policy "public all sale_items"  on sale_items  for all using (true) with check (true);
create policy "public all adjustments" on adjustments for all using (true) with check (true);

-- ── Realtime — so every device sees changes the instant they happen ────────
alter publication supabase_realtime add table products;
alter publication supabase_realtime add table variants;
alter publication supabase_realtime add table sales;
alter publication supabase_realtime add table sale_items;
alter publication supabase_realtime add table adjustments;

-- ── complete_sale — the critical one ────────────────────────────────────────
-- Atomically checks AND decrements stock for every item in one database
-- transaction. If ANY item doesn't have enough stock, the ENTIRE sale is
-- rejected and nothing changes — this is what makes it impossible for two
-- devices to both "successfully" sell the same last unit.
create or replace function complete_sale(
  p_cashier text,
  p_client jsonb,
  p_items jsonb,        -- [{"variant_id":"...","product_id":"...","category":"...","sku":"...","size":"...","qty":2,"price":85}, ...]
  p_subtotal numeric,
  p_vat numeric,
  p_total numeric,
  p_test_mode boolean default false
) returns text
language plpgsql
as $$
declare
  v_item jsonb;
  v_variant_id uuid;
  v_qty integer;
  v_new_qty integer;
  v_invoice_id text;
begin
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_variant_id := (v_item->>'variant_id')::uuid;
    v_qty := (v_item->>'qty')::integer;

    update variants set qty = qty - v_qty
    where id = v_variant_id and qty >= v_qty
    returning qty into v_new_qty;

    if not found then
      raise exception 'INSUFFICIENT_STOCK:% :% :requested %', v_item->>'category', v_item->>'size', v_qty;
    end if;
  end loop;

  v_invoice_id := (case when p_test_mode then 'TEST-' else 'IMPI-' end) || nextval('invoice_seq')::text;

  insert into sales(id, test_mode, date, cashier, client, subtotal, vat, total)
  values (v_invoice_id, p_test_mode, to_char(now(),'DD Mon YYYY'), p_cashier, p_client, p_subtotal, p_vat, p_total);

  insert into sale_items(sale_id, product_id, category, sku, size, qty, price)
  select v_invoice_id, (i->>'product_id')::uuid, i->>'category', i->>'sku', i->>'size',
         (i->>'qty')::integer, (i->>'price')::numeric
  from jsonb_array_elements(p_items) i;

  return v_invoice_id;
end;
$$;

-- ── apply_adjustment — atomic Receive / Write-off / Free Issue / Return ────
create or replace function apply_adjustment(
  p_variant_id uuid,
  p_delta integer,
  p_adj_type text,
  p_note text,
  p_cashier text
) returns integer
language plpgsql
as $$
declare
  v_before integer;
  v_after integer;
  v_category text;
  v_size text;
  v_product_id uuid;
begin
  select v.qty, v.size, v.product_id, p.category
    into v_before, v_size, v_product_id, v_category
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

  insert into adjustments(product_id, category, size, adj_type, delta, note, cashier, before, after)
  values (v_product_id, v_category, v_size, p_adj_type, p_delta, p_note, p_cashier, v_before, v_after);

  return v_after;
end;
$$;

-- ── set_stock_take — atomic "set to counted quantity" (bulk stock take) ────
create or replace function set_stock_take(
  p_variant_id uuid,
  p_new_qty integer,
  p_cashier text
) returns integer
language plpgsql
as $$
declare
  v_before integer;
  v_category text;
  v_size text;
  v_product_id uuid;
begin
  select v.qty, v.size, v.product_id, p.category
    into v_before, v_size, v_product_id, v_category
  from variants v join products p on p.id = v.product_id
  where v.id = p_variant_id
  for update;

  if not found then
    raise exception 'VARIANT_NOT_FOUND';
  end if;

  update variants set qty = p_new_qty where id = p_variant_id;

  insert into adjustments(product_id, category, size, adj_type, delta, note, cashier, before, after)
  values (v_product_id, v_category, v_size, 'Stock Take', p_new_qty - v_before, 'Stock take count', p_cashier, v_before, p_new_qty);

  return p_new_qty;
end;
$$;

-- ── wipe_all_data — used by the app's admin "RESET" button ─────────────────
-- Deletes everything. The app downloads a full backup before ever calling this.
create or replace function wipe_all_data() returns void
language plpgsql
as $$
begin
  delete from sale_items;
  delete from sales;
  delete from adjustments;
  delete from variants;
  delete from products;
  alter sequence invoice_seq restart with 1001;
end;
$$;
