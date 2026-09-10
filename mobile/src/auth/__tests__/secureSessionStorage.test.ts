const secureStoreData: Record<string, string> = {};
const asyncStorageData: Record<string, string> = {};

const SECURESTORE_KEY_RE = /^[\w.-]+$/;
const SECURESTORE_VALUE_LIMIT = 2048;

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async (k: string) => {
    if (!SECURESTORE_KEY_RE.test(k)) throw new Error(`Invalid key: ${k}`);
    return secureStoreData[k] ?? null;
  }),
  setItemAsync: jest.fn(async (k: string, v: string) => {
    if (!SECURESTORE_KEY_RE.test(k)) throw new Error(`Invalid key: ${k}`);
    if (v.length > SECURESTORE_VALUE_LIMIT)
      throw new Error(`Value too large: ${v.length}`);
    secureStoreData[k] = v;
  }),
  deleteItemAsync: jest.fn(async (k: string) => {
    if (!SECURESTORE_KEY_RE.test(k)) throw new Error(`Invalid key: ${k}`);
    delete secureStoreData[k];
  }),
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => asyncStorageData[k] ?? null),
    setItem: jest.fn(async (k: string, v: string) => {
      asyncStorageData[k] = v;
    }),
    removeItem: jest.fn(async (k: string) => {
      delete asyncStorageData[k];
    }),
  },
}));

import AsyncStorage from "@react-native-async-storage/async-storage";
import { secureSessionStorage } from "../secureSessionStorage";

const SUPABASE_KEY = "sb-abcdefghij-auth-token";

// Roughly what supabase-js persists: a session JSON with tokens.
function fakeSessionJson(size: number): string {
  const padding = "x".repeat(Math.max(0, size - 60));
  return JSON.stringify({ refresh_token: "rt-secret", padding });
}

describe("secureSessionStorage", () => {
  beforeEach(() => {
    for (const k of Object.keys(secureStoreData)) delete secureStoreData[k];
    for (const k of Object.keys(asyncStorageData)) delete asyncStorageData[k];
    jest.clearAllMocks();
  });

  it("round-trips a small value without chunking", async () => {
    await secureSessionStorage.setItem(SUPABASE_KEY, "short-value");
    expect(await secureSessionStorage.getItem(SUPABASE_KEY)).toBe(
      "short-value",
    );
    expect(secureStoreData[SUPABASE_KEY]).toBe("short-value");
    expect(secureStoreData[`${SUPABASE_KEY}.__chunks`]).toBeUndefined();
  });

  it("round-trips a 5KB value through chunking", async () => {
    const value = fakeSessionJson(5 * 1024);
    expect(value.length).toBeGreaterThan(5000);

    await secureSessionStorage.setItem(SUPABASE_KEY, value);
    expect(await secureSessionStorage.getItem(SUPABASE_KEY)).toBe(value);

    // Chunked layout: key.0, key.1, key.2 + count key, every chunk <= 2048.
    expect(secureStoreData[`${SUPABASE_KEY}.__chunks`]).toBe("3");
    expect(secureStoreData[`${SUPABASE_KEY}.0`]).toHaveLength(2048);
    expect(secureStoreData[`${SUPABASE_KEY}.1`]).toHaveLength(2048);
    expect(secureStoreData[`${SUPABASE_KEY}.2`]).toBe(value.slice(4096));
    expect(secureStoreData[SUPABASE_KEY]).toBeUndefined();

    // Nothing ever touched plaintext AsyncStorage.
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    expect(asyncStorageData[SUPABASE_KEY]).toBeUndefined();
  });

  it("overwriting a chunked value with a short one leaves no stale chunks", async () => {
    await secureSessionStorage.setItem(SUPABASE_KEY, fakeSessionJson(5 * 1024));
    await secureSessionStorage.setItem(SUPABASE_KEY, "short");
    expect(await secureSessionStorage.getItem(SUPABASE_KEY)).toBe("short");
    expect(secureStoreData[`${SUPABASE_KEY}.__chunks`]).toBeUndefined();
    expect(secureStoreData[`${SUPABASE_KEY}.0`]).toBeUndefined();
  });

  it("removeItem deletes all chunks and the count key", async () => {
    await secureSessionStorage.setItem(SUPABASE_KEY, fakeSessionJson(5 * 1024));
    await secureSessionStorage.removeItem(SUPABASE_KEY);
    expect(await secureSessionStorage.getItem(SUPABASE_KEY)).toBeNull();
    expect(Object.keys(secureStoreData)).toHaveLength(0);
  });

  it("migrates a legacy AsyncStorage session into SecureStore and deletes the plaintext", async () => {
    // Pre-fix state on main: the session JSON persisted by supabase-js sits
    // in plaintext AsyncStorage under the Supabase storage key.
    const legacy = fakeSessionJson(5 * 1024);
    asyncStorageData[SUPABASE_KEY] = legacy;

    const got = await secureSessionStorage.getItem(SUPABASE_KEY);
    expect(got).toBe(legacy);

    // Plaintext original is gone...
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(SUPABASE_KEY);
    expect(asyncStorageData[SUPABASE_KEY]).toBeUndefined();

    // ...and the session now lives (chunked) in SecureStore only.
    expect(secureStoreData[`${SUPABASE_KEY}.__chunks`]).toBe("3");
    expect(await secureSessionStorage.getItem(SUPABASE_KEY)).toBe(legacy);
  });

  it("migration runs at most once (subsequent reads skip AsyncStorage writes)", async () => {
    asyncStorageData[SUPABASE_KEY] = "legacy-session";
    await secureSessionStorage.getItem(SUPABASE_KEY);
    jest.clearAllMocks();
    expect(await secureSessionStorage.getItem(SUPABASE_KEY)).toBe(
      "legacy-session",
    );
    expect(AsyncStorage.getItem).not.toHaveBeenCalled();
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  });

  it("sanitizes keys that SecureStore would reject", async () => {
    await secureSessionStorage.setItem("@weird key!", "v");
    expect(await secureSessionStorage.getItem("@weird key!")).toBe("v");
    expect(secureStoreData["_weird_key_"]).toBe("v");
  });

  it("returns null instead of throwing when SecureStore fails", async () => {
    const SecureStore = jest.requireMock("expo-secure-store");
    SecureStore.getItemAsync.mockRejectedValueOnce(new Error("boom"));
    expect(await secureSessionStorage.getItem(SUPABASE_KEY)).toBeNull();
  });
});
