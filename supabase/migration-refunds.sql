-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRATION: refunds / credit notes.
-- Safe on your live project — adds new tables and functions, changes none of
-- your existing data. Run ONCE in SQL Editor → New query (fresh empty tab).
-- ═══════════════════════════════════════════════════════════════════════════

-- Credit notes get their own numbering (CN-1001, CN-1002 …), shared across
-- events and never reset, so a credit note number can never repeat.
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
