import AsyncStorage from "@react-native-async-storage/async-storage";

const PLACES_KEY = "@uiuc_bus_favorite_places";
const STOPS_KEY = "@uiuc_bus_favorite_stops";
const AFTER_LAST_CLASS_KEY = "@uiuc_bus_after_last_class";

export interface SavedPlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface FavoriteStop {
  stop_id: string;
  stop_name: string;
}

export async function getFavoritePlaces(): Promise<SavedPlace[]> {
  try {
    const raw = await AsyncStorage.getItem(PLACES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function setFavoritePlaces(places: SavedPlace[]): Promise<void> {
  await AsyncStorage.setItem(PLACES_KEY, JSON.stringify(places));
}

export async function addFavoritePlace(place: Omit<SavedPlace, "id">): Promise<SavedPlace> {
  const places = await getFavoritePlaces();
  const id = `place_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const newPlace: SavedPlace = { ...place, id };
  await setFavoritePlaces([...places, newPlace]);
  return newPlace;
}

export async function removeFavoritePlace(id: string): Promise<void> {
  const places = (await getFavoritePlaces()).filter((p) => p.id !== id);
  await setFavoritePlaces(places);
  // Don't leave "after last class" pointing at a place that no longer exists.
  if ((await getAfterLastClassPlaceId()) === id) {
    await AsyncStorage.removeItem(AFTER_LAST_CLASS_KEY);
  }
}

export async function getFavoriteStops(): Promise<FavoriteStop[]> {
  try {
    const raw = await AsyncStorage.getItem(STOPS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function setFavoriteStops(stops: FavoriteStop[]): Promise<void> {
  await AsyncStorage.setItem(STOPS_KEY, JSON.stringify(stops));
}

export async function addFavoriteStop(stop: FavoriteStop): Promise<void> {
  const stops = await getFavoriteStops();
  if (stops.some((s) => s.stop_id === stop.stop_id)) return;
  await setFavoriteStops([...stops, stop]);
}

export async function removeFavoriteStop(stopId: string): Promise<void> {
  const stops = (await getFavoriteStops()).filter((s) => s.stop_id !== stopId);
  await setFavoriteStops(stops);
}

/** After-last-class destination: place id (e.g. place_xxx) or empty. */
export async function getAfterLastClassPlaceId(): Promise<string> {
  try {
    return (await AsyncStorage.getItem(AFTER_LAST_CLASS_KEY)) ?? "";
  } catch {
    return "";
  }
}

export async function setAfterLastClassPlaceId(placeId: string): Promise<void> {
  await AsyncStorage.setItem(AFTER_LAST_CLASS_KEY, placeId);
}
