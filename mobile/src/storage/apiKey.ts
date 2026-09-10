import * as SecureStore from "expo-secure-store";

// SecureStore keys must match /^[\w.-]+$/ — no leading "@".
export const API_KEY_STORAGE_KEY = "uiuc_bus_api_key";

export async function getStoredApiKey(): Promise<string | null> {
  try {
    const v = await SecureStore.getItemAsync(API_KEY_STORAGE_KEY);
    if (v != null && v.trim()) return v.trim();
  } catch (_) {}
  return null;
}

export async function setStoredApiKey(key: string | null): Promise<boolean> {
  try {
    if (key == null || !key.trim()) {
      await SecureStore.deleteItemAsync(API_KEY_STORAGE_KEY);
    } else {
      await SecureStore.setItemAsync(API_KEY_STORAGE_KEY, key.trim());
    }
    return true;
  } catch (_) {
    return false;
  }
}
