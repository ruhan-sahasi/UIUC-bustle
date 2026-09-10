import type AsyncStorageType from "@react-native-async-storage/async-storage";

/**
 * Lazy: client.ts imports this module for the origin allowlist alone, and
 * resolving the native AsyncStorage module at import time breaks any
 * environment that has no native module (or no jest mock) wired up.
 */
function storage(): typeof AsyncStorageType {
  // Interop-safe: the real module is a default export, but jest mocks (and
  // CJS transpilation) may expose the API on the module object itself.
  const mod = require("@react-native-async-storage/async-storage");
  return (mod?.default ?? mod) as typeof AsyncStorageType;
}

const KEY = "@uiuc_bus_api_base_url";

const DEFAULT =
  (typeof process !== "undefined" && process.env?.EXPO_PUBLIC_API_BASE_URL?.trim()) ||
  "http://localhost:8000";

const PRODUCTION_ORIGIN = "https://uiuc-bustle-production.up.railway.app";

// __DEV__ is injected by React Native / jest-expo; guard so plain node tooling
// that imports this module does not crash on the bare identifier.
const IS_DEV = typeof __DEV__ !== "undefined" && __DEV__;

function originOf(url: string | null | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
}

/**
 * The only origins the app will ever send credentials (Supabase JWT, X-API-Key)
 * to, and the only origins accepted as a stored API base URL. A base URL is
 * attacker-influencable state (Settings input, tampered AsyncStorage), and the
 * network layer attaches the session token to every request — so an
 * unrestricted base URL is full credential exfiltration to any host.
 */
export const ALLOWED_API_ORIGINS: readonly string[] = [
  ...new Set([originOf(process.env?.EXPO_PUBLIC_API_BASE_URL), PRODUCTION_ORIGIN].filter(
    (o): o is string => o != null
  )),
];

/** Dev-only loopback / emulator-host / RFC1918 LAN hosts, over plain http. */
function isDevLanHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1") return true;
  if (hostname === "10.0.2.2") return true; // Android emulator's host machine
  return (
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/** Whether a full URL (or bare origin) points at an origin the app trusts with credentials. */
export function isAllowedApiOrigin(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (ALLOWED_API_ORIGINS.includes(parsed.origin)) return true;
  if (IS_DEV && parsed.protocol === "http:" && isDevLanHost(parsed.hostname)) return true;
  return false;
}

export async function getStoredApiBaseUrl(): Promise<string> {
  try {
    const v = await storage().getItem(KEY);
    if (v != null && v.trim()) {
      const url = v.trim().replace(/\/$/, "");
      // A tampered stored value (or one saved before origin pinning existed)
      // must not steer requests — ignore it and fall back to the default.
      if (isAllowedApiOrigin(url)) return url;
    }
  } catch (_) {}
  return DEFAULT.replace(/\/$/, "");
}

export async function setStoredApiBaseUrl(url: string): Promise<void> {
  const value = url.trim().replace(/\/$/, "") || DEFAULT;
  if (!isAllowedApiOrigin(value)) {
    throw new Error("API base URL is not an allowed origin.");
  }
  await storage().setItem(KEY, value);
}
