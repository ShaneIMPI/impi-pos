// ─────────────────────────────────────────────────────────────────────────────
// IMPI POS — Sync layer
// All reads/writes to the shared Supabase backend go through here, plus the
// offline queue that lets a sale complete locally even with no network, and
// replay itself once the connection comes back.
//
// Every table (except events itself) carries an event_id, and every read/
// write below is scoped to one event — this is what lets multiple events run
// on the same shared backend without their stock or sales ever mixing.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from "./supabase.js";

const QUEUE_KEY = "impi_pos_offline_queue_v1";

// ── Events ───────────────────────────────────────────────────────────────────
export async function fetchEvents(includeArchived) {
  let q = supabase.from("events").select("*").order("created_at", { ascending: false });
  if (!includeArchived) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) throw error;
  return (data||[]).map(e => ({ id:e.id, name:e.name, createdBy:e.created_by, createdAt:e.created_at, active:e.active }));
}

export async function createEvent(name, cashier) {
  const { data, error } = await supabase.from("events")
    .insert({ name, created_by: cashier }).select().single();
  if (error) throw error;
  return { id:data.id, name:data.name, createdBy:data.created_by, createdAt:data.created_at };
}

export async function archiveEvent(eventId) {
  const { error } = await supabase.from("events").update({ active: false }).eq("id", eventId);
  if (error) throw error;
}

export async function unarchiveEvent(eventId) {
  const { error } = await supabase.from("events").update({ active: true }).eq("id", eventId);
  if (error) throw error;
}

export async function deleteEventPermanentlyRPC(eventId) {
  const { error } = await supabase.rpc("delete_event_permanently", { p_event_id: eventId });
  if (error) throw error;
}

// ── Fetch & nest — everything scoped to one event ───────────────────────────
export async function fetchAllData(eventId) {
  const [{ data: products, error: pErr }, { data: variants, error: vErr },
         { data: sales, error: sErr }, { data: saleItems, error: siErr },
         { data: adjustments, error: aErr }, { data: loans, error: lErr },
         { data: refunds, error: rErr }, { data: refundItems, error: riErr }] = await Promise.all([
    supabase.from("products").select("*").eq("event_id", eventId).order("created_at", { ascending: true }),
    supabase.from("variants").select("*").eq("event_id", eventId),
    supabase.from("sales").select("*").eq("event_id", eventId).order("created_at", { ascending: true }),
    supabase.from("sale_items").select("*").eq("event_id", eventId),
    supabase.from("adjustments").select("*").eq("event_id", eventId).order("created_at", { ascending: false }),
    supabase.from("loans").select("*").eq("event_id", eventId).order("created_at", { ascending: false }),
    supabase.from("refunds").select("*").eq("event_id", eventId).order("created_at", { ascending: false }),
    supabase.from("refund_items").select("*").eq("event_id", eventId),
  ]);
  if (pErr||vErr||sErr||siErr||aErr||lErr||rErr||riErr) throw (pErr||vErr||sErr||siErr||aErr||lErr||rErr||riErr);

  const stock = (products||[]).map(p => ({
    id: p.id, category: p.category, sku: p.sku,
    variants: (variants||[]).filter(v=>v.product_id===p.id).map(v=>({ id:v.id, size:v.size, price:Number(v.price), qty:v.qty })),
  }));

  const itemsBySale = {};
  (saleItems||[]).forEach(i => {
    (itemsBySale[i.sale_id] = itemsBySale[i.sale_id]||[]).push({
      productId:i.product_id, variantId:null, category:i.category, sku:i.sku, size:i.size, qty:i.qty, price:Number(i.price),
    });
  });
  const salesOut = (sales||[]).map(s => ({
    id:s.id, date:s.date, cashier:s.cashier, client:s.client||{}, testMode:s.test_mode, paymentMethod:s.payment_method||"cash",
    items: itemsBySale[s.id]||[], subtotal:Number(s.subtotal), vat:Number(s.vat), total:Number(s.total),
  }));

  const adjLog = (adjustments||[]).map(a => ({
    id:a.id, ts:new Date(a.created_at).toLocaleString("en-ZA"), product:a.category, size:a.size,
    delta:a.delta, adjType:a.adj_type, note:a.note||"", cashier:a.cashier, before:a.before, after:a.after,
  }));

  const loansOut = (loans||[]).map(l => ({
    id:l.id, variantId:l.variant_id, productId:l.product_id, category:l.category, sku:l.sku, size:l.size,
    qty:l.qty, price:Number(l.price), borrower:l.borrower, note:l.note||"", status:l.status,
    cashier:l.cashier, resolvedBy:l.resolved_by, saleId:l.sale_id,
    createdAt: new Date(l.created_at).toLocaleString("en-ZA"),
    resolvedAt: l.resolved_at ? new Date(l.resolved_at).toLocaleString("en-ZA") : null,
  }));

  const refundItemsById = {};
  (refundItems||[]).forEach(i => {
    (refundItemsById[i.refund_id] = refundItemsById[i.refund_id]||[]).push({
      productId:i.product_id, category:i.category, sku:i.sku, size:i.size,
      qty:i.qty, price:Number(i.price), restock:i.restock,
    });
  });
  const refundsOut = (refunds||[]).map(r => ({
    id:r.id, saleId:r.sale_id, date:r.date, cashier:r.cashier, client:r.client||{},
    method:r.refund_method||"cash", reason:r.reason||"", total:Number(r.total),
    createdAt:r.created_at, items: refundItemsById[r.id]||[],
  }));

  return { stock, sales: salesOut, adjLog, loans: loansOut, refunds: refundsOut };
}

// ── Realtime — refetch-on-change, filtered to one event (simple, robust) ───
export function subscribeRealtime(eventId, onChange) {
  const filter = `event_id=eq.${eventId}`;
  const channel = supabase.channel(`impi-pos-live-${eventId}`)
    .on("postgres_changes", { event:"*", schema:"public", table:"products", filter }, onChange)
    .on("postgres_changes", { event:"*", schema:"public", table:"variants", filter }, onChange)
    .on("postgres_changes", { event:"*", schema:"public", table:"sales", filter }, onChange)
    .on("postgres_changes", { event:"*", schema:"public", table:"sale_items", filter }, onChange)
    .on("postgres_changes", { event:"*", schema:"public", table:"adjustments", filter }, onChange)
    .on("postgres_changes", { event:"*", schema:"public", table:"loans", filter }, onChange)
    .on("postgres_changes", { event:"*", schema:"public", table:"refunds", filter }, onChange)
    .on("postgres_changes", { event:"*", schema:"public", table:"refund_items", filter }, onChange)
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// ── Writes ───────────────────────────────────────────────────────────────────
export async function addProduct(category, sku, variantRows, eventId) {
  const { data: prod, error: pErr } = await supabase.from("products")
    .insert({ category, sku, event_id: eventId }).select().single();
  if (pErr) throw pErr;
  const { data: vs, error: vErr } = await supabase.from("variants")
    .insert(variantRows.map(v=>({ product_id:prod.id, event_id:eventId, size:v.size, price:v.price, qty:v.qty })))
    .select();
  if (vErr) throw vErr;
  return { id:prod.id, category:prod.category, sku:prod.sku,
    variants: vs.map(v=>({ id:v.id, size:v.size, price:Number(v.price), qty:v.qty })) };
}

export async function applyAdjustmentRPC(variantId, delta, adjType, note, cashier) {
  const { data, error } = await supabase.rpc("apply_adjustment", {
    p_variant_id: variantId, p_delta: delta, p_adj_type: adjType, p_note: note, p_cashier: cashier,
  });
  if (error) throw error;
  return data; // new qty
}

export async function setStockTakeRPC(variantId, newQty, cashier) {
  const { data, error } = await supabase.rpc("set_stock_take", {
    p_variant_id: variantId, p_new_qty: newQty, p_cashier: cashier,
  });
  if (error) throw error;
  return data;
}

export async function completeSaleRPC(eventId, cashier, client, items, subtotal, vat, total, testMode, paymentMethod) {
  const { data, error } = await supabase.rpc("complete_sale", {
    p_event_id: eventId, p_cashier: cashier, p_client: client,
    p_items: items.map(i=>({ variant_id:i.variantId, product_id:i.productId, category:i.category, sku:i.sku, size:i.size, qty:i.qty, price:i.price })),
    p_subtotal: subtotal, p_vat: vat, p_total: total, p_test_mode: !!testMode, p_payment_method: paymentMethod||"cash",
  });
  if (error) throw error;
  return data; // new invoice id
}

export async function createRefundRPC(eventId, saleId, cashier, items, method, reason) {
  const { data, error } = await supabase.rpc("create_refund", {
    p_event_id: eventId, p_sale_id: saleId, p_cashier: cashier,
    p_items: items.map(i=>({ product_id:i.productId, category:i.category, size:i.size, qty:i.qty, restock:i.restock })),
    p_method: method, p_reason: reason,
  });
  if (error) throw error;
  return data; // new credit note id
}

export async function wipeAllDataRPC(eventId) {
  const { error } = await supabase.rpc("wipe_all_data", { p_event_id: eventId });
  if (error) throw error;
}

export async function createLoanRPC(variantId, qty, borrower, note, cashier) {
  const { data, error } = await supabase.rpc("create_loan", {
    p_variant_id: variantId, p_qty: qty, p_borrower: borrower, p_note: note||"", p_cashier: cashier,
  });
  if (error) throw error;
  return data; // new loan id
}

export async function returnLoanRPC(loanId, cashier) {
  const { error } = await supabase.rpc("return_loan", { p_loan_id: loanId, p_cashier: cashier });
  if (error) throw error;
}

export async function invoiceLoanRPC(loanId, cashier, paymentMethod) {
  const { data, error } = await supabase.rpc("invoice_loan", {
    p_loan_id: loanId, p_cashier: cashier, p_payment_method: paymentMethod||"cash",
  });
  if (error) throw error;
  return data; // new invoice id
}

// Insufficient-stock errors from the DB functions start with this marker —
// used to tell "no stock" apart from "network/other error" everywhere they're caught.
export const isStockError = err => typeof err?.message === "string" && err.message.includes("INSUFFICIENT_STOCK");
// Network-ish errors (fetch failed / offline) vs. real business-logic errors from the DB.
export const isNetworkError = err => !err?.code && (err?.message === "Failed to fetch" || err instanceof TypeError);

// ── Offline queue ────────────────────────────────────────────────────────────
// Holds sales that couldn't reach the server yet. Each entry replays completeSaleRPC.
export function loadQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch { return []; }
}
export function saveQueue(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch {}
}
export function pushToQueue(entry) {
  const q = loadQueue();
  q.push({ ...entry, queuedAt: new Date().toISOString() });
  saveQueue(q);
  return q;
}
export function removeFromQueue(tempId) {
  const q = loadQueue().filter(e => e.tempId !== tempId);
  saveQueue(q);
  return q;
}
