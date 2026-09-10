const store: Record<string, string> = {};

const SECURESTORE_KEY_RE = /^[\w.-]+$/;

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async (k: string) => {
    if (!SECURESTORE_KEY_RE.test(k)) throw new Error(`Invalid key: ${k}`);
    return store[k] ?? null;
  }),
  setItemAsync: jest.fn(async (k: string, v: string) => {
    if (!SECURESTORE_KEY_RE.test(k)) throw new Error(`Invalid key: ${k}`);
    store[k] = v;
  }),
  deleteItemAsync: jest.fn(async (k: string) => {
    if (!SECURESTORE_KEY_RE.test(k)) throw new Error(`Invalid key: ${k}`);
    delete store[k];
  }),
}));

import {
  API_KEY_STORAGE_KEY,
  getStoredApiKey,
  setStoredApiKey,
} from "../apiKey";

describe("apiKey storage", () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    jest.clearAllMocks();
  });

  it("uses a SecureStore-valid key (no leading @)", () => {
    expect(API_KEY_STORAGE_KEY).toMatch(SECURESTORE_KEY_RE);
  });

  it("round-trips set/get through SecureStore", async () => {
    expect(await setStoredApiKey("  my-secret-key  ")).toBe(true);
    expect(await getStoredApiKey()).toBe("my-secret-key");
  });

  it("deletes on null/empty and returns success", async () => {
    await setStoredApiKey("abc");
    expect(await setStoredApiKey(null)).toBe(true);
    expect(await getStoredApiKey()).toBeNull();
    await setStoredApiKey("abc");
    expect(await setStoredApiKey("   ")).toBe(true);
    expect(await getStoredApiKey()).toBeNull();
  });

  it("returns false instead of throwing when SecureStore fails", async () => {
    const SecureStore = jest.requireMock("expo-secure-store");
    SecureStore.setItemAsync.mockRejectedValueOnce(new Error("boom"));
    expect(await setStoredApiKey("abc")).toBe(false);
  });
});
