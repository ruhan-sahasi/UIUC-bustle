import * as SecureStore from "expo-secure-store";
import { addRecentSearch, clearRecentSearches, getRecentSearches } from "../recentSearches";

jest.mock("expo-secure-store");

const mockGet = SecureStore.getItemAsync as jest.Mock;
const mockSet = SecureStore.setItemAsync as jest.Mock;
const mockDelete = SecureStore.deleteItemAsync as jest.Mock;

// In-memory backing store so add -> read round-trips work
let store: Record<string, string> = {};

describe("recentSearches", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store = {};
    mockGet.mockImplementation(async (k: string) => store[k] ?? null);
    mockSet.mockImplementation(async (k: string, v: string) => {
      store[k] = v;
    });
    mockDelete.mockImplementation(async (k: string) => {
      delete store[k];
    });
  });

  it("stores searches in SecureStore (encrypted at rest), not AsyncStorage", async () => {
    await addRecentSearch({ query: "grainger", displayName: "Grainger Library", lat: 40.1124, lng: -88.2268 });
    expect(mockSet).toHaveBeenCalledWith("uiuc_bus_recent_searches", expect.any(String));
  });

  it("caps the persisted list at 5 entries, newest first", async () => {
    for (let i = 0; i < 8; i++) {
      await addRecentSearch({ query: `place-${i}`, displayName: `Place ${i}`, lat: 40.1, lng: -88.2 });
    }
    const searches = await getRecentSearches();
    expect(searches).toHaveLength(5);
    expect(searches.map((s) => s.query)).toEqual(["place-7", "place-6", "place-5", "place-4", "place-3"]);
  });

  it("dedupes repeated queries case-insensitively, moving them to the front", async () => {
    await addRecentSearch({ query: "Grainger", displayName: "Grainger Library", lat: 40.1124, lng: -88.2268 });
    await addRecentSearch({ query: "union", displayName: "Illini Union", lat: 40.1092, lng: -88.2272 });
    await addRecentSearch({ query: "GRAINGER", displayName: "Grainger Library", lat: 40.1124, lng: -88.2268 });
    const searches = await getRecentSearches();
    expect(searches).toHaveLength(2);
    expect(searches[0].query).toBe("GRAINGER");
    expect(searches[1].query).toBe("union");
  });

  it("clearRecentSearches deletes the key", async () => {
    await addRecentSearch({ query: "union", displayName: "Illini Union", lat: 40.1092, lng: -88.2272 });
    await clearRecentSearches();
    expect(mockDelete).toHaveBeenCalledWith("uiuc_bus_recent_searches");
    expect(await getRecentSearches()).toEqual([]);
  });

  it("returns [] for missing or malformed storage", async () => {
    expect(await getRecentSearches()).toEqual([]);
    store["uiuc_bus_recent_searches"] = "{bad json";
    expect(await getRecentSearches()).toEqual([]);
  });
});
