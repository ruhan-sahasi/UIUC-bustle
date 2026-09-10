import { createClient } from "@supabase/supabase-js";
import { secureSessionStorage } from "./secureSessionStorage";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // SecureStore-backed adapter (with one-time migration off AsyncStorage);
    // the refresh token must never sit in plaintext AsyncStorage.
    storage: secureSessionStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    // sign-in.tsx and the deep-link handler use exchangeCodeForSession, which
    // requires the PKCE flow (default is implicit, whose tokens arrive in the
    // URL fragment and can't be exchanged)
    flowType: "pkce",
  },
});
