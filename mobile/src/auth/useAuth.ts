import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { Session, User } from "@supabase/supabase-js";
import { QueryClientContext, type QueryClient } from "@tanstack/react-query";
import { supabase } from "./supabaseClient";

/**
 * Query keys have to be scoped to the signed-in user, but a query hook opening its own
 * auth subscription would multiply them, so the id lives in a module store that the
 * mounted useAuth feeds.
 */
let currentUserId: string | null = null;
const userIdListeners = new Set<() => void>();

/**
 * The app's QueryClient is module-scoped in app/_layout.tsx and only reachable through
 * context, but RootLayout's own useAuth mounts above the provider. Remember the client
 * from any instance rendered below it (Settings, where sign-out lives) so auth
 * transitions can wipe the cache.
 */
let knownQueryClient: QueryClient | null = null;

function publishUserId(userId: string | null): void {
  if (currentUserId === userId) return;
  const hadUser = currentUserId !== null;
  currentUserId = userId;
  for (const listener of userIdListeners) listener();
  // Signed out, or signed in as a different account: drop the whole cache so the next
  // user cannot be served the previous one's data (gcTime keeps entries for 5 min).
  if (hadUser) knownQueryClient?.clear();
}

function subscribeUserId(listener: () => void): () => void {
  userIdListeners.add(listener);
  return () => {
    userIdListeners.delete(listener);
  };
}

function getUserIdSnapshot(): string | null {
  return currentUserId;
}

/** Id of the signed-in user, or null. Use to scope anything cached per account. */
export function useCurrentUserId(): string | null {
  return useSyncExternalStore(subscribeUserId, getUserIdSnapshot, getUserIdSnapshot);
}

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  // Undefined for the RootLayout instance, which renders above the provider.
  const queryClient = useContext(QueryClientContext);

  useEffect(() => {
    if (queryClient) knownQueryClient = queryClient;
  }, [queryClient]);

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        setSession(session);
        setUser(session?.user ?? null);
        publishUserId(session?.user?.id ?? null);
      })
      // A failed restore (corrupt secure-store entry, keychain error) leaves
      // the user signed out; it must not keep RootLayout on the splash forever.
      .catch(() => {})
      .finally(() => setLoading(false));

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      publishUserId(session?.user?.id ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  return { session, user, loading, signOut: () => supabase.auth.signOut() };
}
