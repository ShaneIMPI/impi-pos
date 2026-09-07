// ─────────────────────────────────────────────────────────────────────────────
// IMPI POS — Supabase connection
//
// Fill in the two values below from your Supabase project:
// Dashboard → Project Settings → API → "Project URL" and "anon public" key.
//
// The anon/public key is SAFE to put here and commit to GitHub — it's designed
// to be public. Real security comes from the Row Level Security policies in
// supabase/schema.sql, not from keeping this key secret.
//
// NEVER put the "service_role" key here (or anywhere in this app) — that one
// bypasses all security and must never be exposed in client-side code.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = "https://nkrgxegpsxdeyhdanhze.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rcmd4ZWdwc3hkZXloZGFuaHplIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg3Mzk5NjQsImV4cCI6MjEwNDMxNTk2NH0.84q4QG-mBmvI4AZTkgSeys8h0bku_Hxrh9aRTI2Vbas";

export const SUPABASE_CONFIGURED =
  !SUPABASE_URL.includes("YOUR-PROJECT") && !SUPABASE_ANON_KEY.includes("YOUR-ANON");

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  realtime: { params: { eventsPerSecond: 5 } },
});
