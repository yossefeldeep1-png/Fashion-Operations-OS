import { createClient } from "@supabase/supabase-js";
import { projectId, publicAnonKey } from "../../utils/supabase/info";

const hash = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.hash.replace(/^#/, ""));
const query = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
export const initialAuthLink = {
  recovery: hash.get("type") === "recovery" || query.get("type") === "recovery",
  error: hash.get("error_description") ?? query.get("error_description") ?? (hash.get("error") ?? query.get("error")),
  errorCode: hash.get("error_code") ?? query.get("error_code"),
};

export const recoveryRedirectUrl = () => `${window.location.origin}${window.location.pathname}`;

export const supabase = createClient(`https://${projectId}.supabase.co`, publicAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});