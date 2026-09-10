import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";

// SecureStore values are capped (~2048 bytes on Android keystore-backed
// devices), and a Supabase session JSON (access + refresh token) is well over
// that. Values larger than CHUNK_SIZE are split across `${key}.0`,
// `${key}.1`, ... with the chunk count stored under `${key}.__chunks`.
const CHUNK_SIZE = 2048;

// SecureStore keys must match /^[\w.-]+$/. The Supabase storage key
// (e.g. "sb-<project-ref>-auth-token") already satisfies that, but sanitize
// defensively so an unexpected key can never throw and silently drop the
// session.
function sanitizeKey(key: string): string {
  return key.replace(/[^\w.-]/g, "_");
}

function chunkCountKey(key: string): string {
  return `${key}.__chunks`;
}

async function secureGet(key: string): Promise<string | null> {
  const safeKey = sanitizeKey(key);
  const countRaw = await SecureStore.getItemAsync(chunkCountKey(safeKey));
  if (countRaw != null) {
    const count = Number.parseInt(countRaw, 10);
    if (!Number.isInteger(count) || count <= 0) return null;
    const chunks: string[] = [];
    for (let i = 0; i < count; i++) {
      const chunk = await SecureStore.getItemAsync(`${safeKey}.${i}`);
      if (chunk == null) return null; // partial write: treat as missing
      chunks.push(chunk);
    }
    return chunks.join("");
  }
  return SecureStore.getItemAsync(safeKey);
}

async function secureRemove(key: string): Promise<void> {
  const safeKey = sanitizeKey(key);
  const countRaw = await SecureStore.getItemAsync(chunkCountKey(safeKey));
  if (countRaw != null) {
    const count = Number.parseInt(countRaw, 10);
    for (let i = 0; i < (Number.isInteger(count) ? count : 0); i++) {
      await SecureStore.deleteItemAsync(`${safeKey}.${i}`);
    }
    await SecureStore.deleteItemAsync(chunkCountKey(safeKey));
  }
  await SecureStore.deleteItemAsync(safeKey);
}

async function secureSet(key: string, value: string): Promise<void> {
  // Clear any previous representation (chunked or plain) so stale chunks from
  // a longer prior value can never be appended to a shorter new one.
  await secureRemove(key);
  const safeKey = sanitizeKey(key);
  if (value.length <= CHUNK_SIZE) {
    await SecureStore.setItemAsync(safeKey, value);
    return;
  }
  const count = Math.ceil(value.length / CHUNK_SIZE);
  for (let i = 0; i < count; i++) {
    await SecureStore.setItemAsync(
      `${safeKey}.${i}`,
      value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
    );
  }
  await SecureStore.setItemAsync(chunkCountKey(safeKey), String(count));
}

// Storage adapter for supabase-js. Sessions used to live in plaintext
// AsyncStorage; on the first read miss we migrate any legacy value into
// SecureStore and delete the plaintext original.
export const secureSessionStorage = {
  async getItem(key: string): Promise<string | null> {
    try {
      const secure = await secureGet(key);
      if (secure != null) return secure;

      // One-time migration from the old AsyncStorage-backed session.
      const legacy = await AsyncStorage.getItem(key);
      if (legacy == null) return null;
      await secureSet(key, legacy);
      await AsyncStorage.removeItem(key);
      return legacy;
    } catch {
      return null;
    }
  },

  async setItem(key: string, value: string): Promise<void> {
    try {
      await secureSet(key, value);
    } catch (_) {}
  },

  async removeItem(key: string): Promise<void> {
    try {
      await secureRemove(key);
    } catch (_) {}
  },
};
