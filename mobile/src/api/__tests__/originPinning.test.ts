/**
 * Origin-pinned credentials.
 *
 * mergeHeaders used to attach the Supabase JWT and X-API-Key to whatever base
 * URL it was handed, and the base URL is attacker-influencable state (Settings
 * input, tampered AsyncStorage) — so pointing the app at any host exfiltrated
 * both credentials on the next request, including silent background refreshes.
 * These tests pin: credentials only ever go to allowlisted origins, a tampered
 * stored base URL is ignored, and share PATCHes carry the writer's edit token.
 */
const mockGetSession = jest.fn(async () => ({ data: { session: null as null | { access_token: string } } }));
const mockRefreshSession = jest.fn(async () => ({ data: {}, error: null }));
const mockSignOut = jest.fn(async () => undefined);

jest.mock("@/src/auth/supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: () => mockGetSession(),
      refreshSession: () => mockRefreshSession(),
      signOut: () => mockSignOut(),
    },
  },
}));

jest.mock("@/src/telemetry/logBuffer", () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

import AsyncStorage from "@react-native-async-storage/async-storage";
import { fetchNearbyStops, patchShareTrip } from "../client";
import { ALLOWED_API_ORIGINS, getStoredApiBaseUrl, isAllowedApiOrigin, setStoredApiBaseUrl } from "@/src/storage/apiUrl";

const EVIL_BASE = "https://evil.attacker.example";
const PROD_BASE = "https://uiuc-bustle-production.up.railway.app";
const STORAGE_KEY = "@uiuc_bus_api_base_url";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lastRequestHeaders(): Headers {
  const calls = (global.fetch as jest.Mock).mock.calls;
  return calls[calls.length - 1][1].headers as Headers;
}

/** Let pending microtasks (mergeHeaders -> getSession, fire-and-forget fetches) settle. */
async function flush(times = 10) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  // A signed-in session with an API key configured — the worst case to leak.
  mockGetSession.mockResolvedValue({ data: { session: { access_token: "jwt-secret" } } });
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ stops: [] }));
});

describe("credential origin pinning", () => {
  it("attaches NO Authorization and NO X-API-Key to a non-allowlisted origin", async () => {
    // On main this fails: mergeHeaders attached both unconditionally, so an
    // attacker-controlled base URL received the JWT and the API key.
    await fetchNearbyStops(EVIL_BASE, 40.1, -88.2, 800, { apiKey: "key-secret" });

    const headers = lastRequestHeaders();
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("X-API-Key")).toBeNull();
  });

  it("still attaches both credentials to the production origin", async () => {
    await fetchNearbyStops(PROD_BASE, 40.1, -88.2, 800, { apiKey: "key-secret" });

    const headers = lastRequestHeaders();
    expect(headers.get("Authorization")).toBe("Bearer jwt-secret");
    expect(headers.get("X-API-Key")).toBe("key-secret");
  });

  it("allows localhost in dev builds (jest runs with __DEV__ true)", async () => {
    await fetchNearbyStops("http://localhost:8000", 40.1, -88.2, 800, { apiKey: "key-secret" });
    expect(lastRequestHeaders().get("Authorization")).toBe("Bearer jwt-secret");
  });

  it("rejects lookalike origins that merely contain an allowlisted host", () => {
    expect(isAllowedApiOrigin(`${PROD_BASE}.evil.example`)).toBe(false);
    expect(isAllowedApiOrigin("https://evil.example/?u=" + PROD_BASE)).toBe(false);
    expect(ALLOWED_API_ORIGINS).toContain(PROD_BASE);
  });
});

describe("stored base URL validation", () => {
  it("ignores a tampered stored URL and falls back to the default", async () => {
    // On main this fails: getStoredApiBaseUrl returned whatever AsyncStorage
    // held, so tampered storage silently redirected every request (and its
    // credentials) to the attacker's host.
    await AsyncStorage.setItem(STORAGE_KEY, EVIL_BASE);

    const url = await getStoredApiBaseUrl();
    expect(url).not.toContain("evil.attacker.example");
    expect(isAllowedApiOrigin(url)).toBe(true);
  });

  it("refuses to store a non-allowlisted URL", async () => {
    // On main this fails: setStoredApiBaseUrl accepted any string.
    await expect(setStoredApiBaseUrl(EVIL_BASE)).rejects.toThrow();
    expect(await AsyncStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("stores an allowlisted URL unchanged (minus trailing slash)", async () => {
    await setStoredApiBaseUrl(`${PROD_BASE}/`);
    expect(await getStoredApiBaseUrl()).toBe(PROD_BASE);
  });
});

describe("share edit token", () => {
  it("sends X-Edit-Token on PATCH when the writer credential is provided", async () => {
    // On main this fails: patchShareTrip had no editToken parameter, so the
    // header was never sent and the hardened backend rejects the update.
    patchShareTrip(PROD_BASE, "trip-token", { phase: "arrived" }, { editToken: "edit-secret" });
    await flush();

    expect(lastRequestHeaders().get("X-Edit-Token")).toBe("edit-secret");
  });

  it("omits X-Edit-Token when none was returned at creation", async () => {
    patchShareTrip(PROD_BASE, "trip-token", { phase: "arrived" }, { editToken: null });
    await flush();

    expect(lastRequestHeaders().get("X-Edit-Token")).toBeNull();
  });
});
