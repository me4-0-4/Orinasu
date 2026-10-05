import { createClient } from "@supabase/supabase-js";

// anon key はブラウザに配る前提の公開用キー。データを守っているのはSupabase側のRLS（supabase/schema.sql）。
const SUPABASE_URL = "https://bgamyimbzvvealiiiuyu.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJnYW15aW1ienZ2ZWFsaWlpdXl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTExODQ2MjcsImV4cCI6MjEwNjc2MDYyN30.Pl4hEoEvF-bke4gZ0q0rjCMyBDFAoBz6TpBpcdLrkJc";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

export type CloudTable = "phrases" | "presets";
