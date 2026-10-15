-- ═══════════════════════════════════════════════════════════════════════════
-- IMPI POS — Supabase schema (multi-event)
-- For a BRAND NEW project, run this entire file once in SQL Editor → New query.
-- If you already have the earlier (single-event) version of this schema live
-- with real data in it, do NOT run this file — use the migration patch
-- instead, which adds events on top of your existing data without losing it.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";

-- Shared, atomic invoice numbering — guarantees no two devices (and no two
-- events) ever produce the same invoice number, even completing sales at the
-- exact same instant.
create sequence if not exists invoice_seq start 1001;

-- ── Events — each one is a logically separate workspace: its own stock,
-- sales, adjustments and loans, all walled off from every other event even
-- though they share the one database. ───────────────────────────────────────
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by text not null,
  created_at timestamptz default now(),
  active boolean not null default true
);

-- ── Tables ───────────────────────────────────────────────────────────────────
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id),
  category text not null,
  sku text,
  created_at timestamptz default now()
);

create table if not exists variants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id),
  product_id uuid references products(id) on delete cascade,
  size text not null,
  price numeric not null default 0,
  qty integer not null default 0
);

create table if not exists sales (
  id text primary key,                          -- e.g. IMPI-1001 / TEST-1001
  event_id uuid references events(id),
  test_mode boolean not null default false,
  date text not null,
  cashier text not null,
  client jsonb not null default '{}',
  payment_method text not null default 'cash',  -- 'cash' or 'card'
  subtotal numeric not null,
  vat numeric not null,
  total numeric not null,
  created_at timestamptz default now()
);

create table if not exists sale_items (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id),
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
  event_id uuid references events(id),
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

create table if not exists loans (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id),
  variant_id uuid references variants(id),
  product_id uuid,
  category text not null,
  sku text,
  size text not null,
  qty integer not null,
  price numeric not null,
  borrower text not null,
  note text,
  status text not null default 'out',  -- 'out' | 'returned' | 'invoiced'
  cashier text not null,
  resolved_by text,
  sale_id text references sales(id),
  created_at timestamptz default now(),
  resolved_at timestamptz
);

-- ── Row Level Security ──────────────────────────────────────────────────────
-- Still no per-user login on the database side — anyone holding the public
-- anon key can read/write. Event isolation here is LOGICAL (every query is
-- filtered/stamped by event_id), not cryptographic — same trust model as
-- before, just extended with an event boundary the app always respects.
alter table events      enable row level security;
alter table products    enable row level security;
alter table variants    enable row level security;
alter table sales       enable row level security;
alter table sale_items  enable row level security;
alter table adjustments enable row level security;
alter table loans       enable row level security;

drop policy if exists "public all events"      on events;
drop policy if exists "public all products"    on products;
drop policy if exists "public all variants"    on variants;
drop policy if exists "public all sales"       on sales;
drop policy if exists "public all sale_items"  on sale_items;
drop policy if exists "public all adjustments" on adjustments;
drop policy if exists "public all loans"       on loans;

create policy "public all events"      on events      for all using (true) with check (true);
create policy "public all products"    on products    for all using (true) with check (true);
create policy "public all variants"    on variants    for all using (true) with check (true);
create policy "public all sales"       on sales       for all using (true) with check (true);
create policy "public all sale_items"  on sale_items  for all using (true) with check (true);
create policy "public all adjustments" on adjustments for all using (true) with check (true);
create policy "public all loans"       on loans       for all using (true) with check (true);

-- ── Realtime — so every device sees changes the instant they happen ────────
do $$
declare
  t text;
begin
  foreach t in array array['events','products','variants','sales','sale_items','adjustments','loans'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;

-- ── complete_sale — the critical one ────────────────────────────────────────
-- Atomically checks AND decrements stock for every item in one database
-- transaction, scoped to one event. Also checks every item actually belongs
-- to the event being sold in, so a stray/stale variant id from a different
-- event can never cross over.
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

-- ── apply_adjustment — atomic Receive / Write-off / Free Issue / Return ────
-- event_id is derived from the variant itself, not passed in — a variant can
-- only ever belong to one event, so there's nothing for the client to get wrong.
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

-- ── set_stock_take — atomic "set to counted quantity" (bulk stock take) ────
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

-- ── create_loan — book stock out on loan (atomic, stock-safe) ──────────────
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

-- ── return_loan — borrowed stock comes back (atomic) ────────────────────────
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

-- ── invoice_loan — borrowed stock is kept, so it becomes a real sale ───────
-- Stock was already decremented when the loan was booked out, so this does
-- NOT touch variants.qty again — it only creates the sale record.
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


-- ═══ Refunds / credit notes ═══
create sequence if not exists credit_seq start 1001;

create table if not exists refunds (
  id text primary key,                          -- e.g. CN-1001
  event_id uuid references events(id),
  sale_id text references sales(id),            -- the invoice being refunded
  date text not null,
  cashier text not null,                        -- who processed the refund
  client jsonb not null default '{}',
  refund_method text not null default 'cash',   -- 'cash' or 'card'
  reason text,
  total numeric not null,
  created_at timestamptz default now()
);

create table if not exists refund_items (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id),
  refund_id text references refunds(id) on delete cascade,
  product_id uuid,
  category text not null,
  sku text,
  size text not null,
  qty integer not null,
  price numeric not null,
  restock boolean not null default true         -- did the item go back into stock?
);

alter table refunds      enable row level security;
alter table refund_items enable row level security;
drop policy if exists "public all refunds"      on refunds;
drop policy if exists "public all refund_items" on refund_items;
create policy "public all refunds"      on refunds      for all using (true) with check (true);
create policy "public all refund_items" on refund_items for all using (true) with check (true);

do $$
declare
  t text;
begin
  foreach t in array array['refunds','refund_items'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;

-- create_refund — validates everything, then writes the credit note and (per
-- item, if ticked) puts stock back, all in one transaction.
--   • the invoice must belong to this event
--   • each item must be on that invoice
--   • you can never refund more than was sold, counting earlier credit notes
--   • refunds use the price the customer actually paid on the invoice
create or replace function create_refund(
  p_event_id uuid,
  p_sale_id text,
  p_cashier text,
  p_items jsonb,     -- [{"product_id":"...","category":"...","size":"M","qty":2,"restock":true}, ...]
  p_method text,
  p_reason text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale sales%rowtype;
  v_item jsonb;
  v_product_id uuid;
  v_size text;
  v_qty integer;
  v_restock boolean;
  v_sold integer;
  v_already integer;
  v_price numeric;
  v_category text;
  v_sku text;
  v_variant_id uuid;
  v_before integer;
  v_after integer;
  v_total numeric := 0;
  v_cn_id text;
begin
  -- Lock the invoice so two refunds against it can't race each other.
  select * into v_sale from sales where id = p_sale_id for update;
  if not found then
    raise exception 'SALE_NOT_FOUND';
  end if;
  if v_sale.event_id is distinct from p_event_id then
    raise exception 'EVENT_MISMATCH: invoice does not belong to this event';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'NOTHING_TO_REFUND';
  end if;

  -- Pass 1: validate everything and work out the total BEFORE using a credit
  -- note number, so a failed attempt never leaves a gap in the numbering.
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_size := v_item->>'size';
    v_qty := (v_item->>'qty')::integer;
    if v_qty is null or v_qty < 1 then
      raise exception 'INVALID_QTY';
    end if;

    select coalesce(sum(qty),0), max(price), max(category)
      into v_sold, v_price, v_category
    from sale_items
    where sale_id = p_sale_id and product_id = v_product_id and size = v_size;

    if v_sold = 0 then
      raise exception 'ITEM_NOT_ON_INVOICE:% %', v_item->>'category', v_size;
    end if;

    select coalesce(sum(ri.qty),0) into v_already
    from refund_items ri join refunds r on r.id = ri.refund_id
    where r.sale_id = p_sale_id and ri.product_id = v_product_id and ri.size = v_size;

    if v_qty > v_sold - v_already then
      raise exception 'REFUND_EXCEEDS_SOLD:% % — only % left to refund', v_category, v_size, v_sold - v_already;
    end if;

    v_total := v_total + v_qty * v_price;
  end loop;

  -- Pass 2: write the credit note, and put stock back where ticked.
  v_cn_id := 'CN-' || nextval('credit_seq')::text;

  insert into refunds(id, event_id, sale_id, date, cashier, client, refund_method, reason, total)
  values (v_cn_id, p_event_id, p_sale_id, to_char(now(),'DD Mon YYYY'), p_cashier,
          v_sale.client, p_method, p_reason, v_total);

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_product_id := (v_item->>'product_id')::uuid;
    v_size := v_item->>'size';
    v_qty := (v_item->>'qty')::integer;
    v_restock := coalesce((v_item->>'restock')::boolean, true);

    select max(price), max(category), max(sku) into v_price, v_category, v_sku
    from sale_items
    where sale_id = p_sale_id and product_id = v_product_id and size = v_size;

    insert into refund_items(event_id, refund_id, product_id, category, sku, size, qty, price, restock)
    values (p_event_id, v_cn_id, v_product_id, v_category, v_sku, v_size, v_qty, v_price, v_restock);

    if v_restock then
      select id into v_variant_id from variants
      where product_id = v_product_id and size = v_size and event_id = p_event_id
      limit 1;

      if found then
        update variants set qty = qty + v_qty where id = v_variant_id returning qty into v_after;
        v_before := v_after - v_qty;
        insert into adjustments(product_id, event_id, category, size, adj_type, delta, note, cashier, before, after)
        values (v_product_id, p_event_id, v_category, v_size, 'Refund Return', v_qty,
                concat('Credit note ', v_cn_id, ' for invoice ', p_sale_id), p_cashier, v_before, v_after);
      end if;
    end if;
  end loop;

  return v_cn_id;
end;
$$;

-- RESET and permanent delete now clear credit notes too (they sit between
-- loans and sales in the deletion order because they reference sales).
create or replace function wipe_all_data(p_event_id uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from loans where event_id = p_event_id;
  delete from refund_items where event_id = p_event_id;
  delete from refunds where event_id = p_event_id;
  delete from sale_items where event_id = p_event_id;
  delete from sales where event_id = p_event_id;
  delete from adjustments where event_id = p_event_id;
  delete from variants where event_id = p_event_id;
  delete from products where event_id = p_event_id;
end;
$$;

create or replace function delete_event_permanently(p_event_id uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from loans where event_id = p_event_id;
  delete from refund_items where event_id = p_event_id;
  delete from refunds where event_id = p_event_id;
  delete from sale_items where event_id = p_event_id;
  delete from sales where event_id = p_event_id;
  delete from adjustments where event_id = p_event_id;
  delete from variants where event_id = p_event_id;
  delete from products where event_id = p_event_id;
  delete from events where id = p_event_id;
end;
$$;
