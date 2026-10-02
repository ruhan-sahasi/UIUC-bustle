jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  addFavoritePlace,
  addFavoriteStop,
  getAfterLastClassPlaceId,
  getFavoritePlaces,
  getFavoriteStops,
  removeFavoritePlace,
  setAfterLastClassPlaceId,
} from "../favorites";
import { getStopThresholds, setStopThreshold } from "../stopThresholds";
import { getWalkedClassIdsToday, markClassAsWalkedToday } from "../walkedClassToday";

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe("favorites", () => {
  it("clears the after-last-class pick when that place is removed", async () => {
    const gym = await addFavoritePlace({ name: "Gym", lat: 40.1, lng: -88.2 });
    const cafe = await addFavoritePlace({ name: "Cafe", lat: 40.11, lng: -88.21 });
    await setAfterLastClassPlaceId(gym.id);

    await removeFavoritePlace(cafe.id);
    expect(await getAfterLastClassPlaceId()).toBe(gym.id);

    await removeFavoritePlace(gym.id);
    expect(await getAfterLastClassPlaceId()).toBe("");
    expect(await getFavoritePlaces()).toEqual([]);
  });

  it("dedupes favorite stops by id", async () => {
    await addFavoriteStop({ stop_id: "IU", stop_name: "Illini Union" });
    await addFavoriteStop({ stop_id: "IU", stop_name: "Illini Union" });
    expect(await getFavoriteStops()).toHaveLength(1);
  });

  it("treats corrupt storage as empty", async () => {
    await AsyncStorage.setItem("@uiuc_bus_favorite_places", "{not json");
    expect(await getFavoritePlaces()).toEqual([]);
  });
});

describe("stopThresholds", () => {
  it("recovers from a non-array stored value instead of throwing", async () => {
    await AsyncStorage.setItem("@uiuc_bus_stop_thresholds", JSON.stringify({ oops: true }));
    expect(await getStopThresholds()).toEqual([]);
    await setStopThreshold({ stop_id: "IU", stop_name: "Illini Union", route_id: "22", threshold_mins: 5, enabled: true });
    expect(await getStopThresholds()).toHaveLength(1);
  });
});

describe("walkedClassToday", () => {
  it("records ids once and prunes previous days' keys", async () => {
    await AsyncStorage.setItem("@uiuc_bus_walked_class_ids_2000-01-01", JSON.stringify(["old"]));
    await markClassAsWalkedToday("c1");
    await markClassAsWalkedToday("c1");
    expect(await getWalkedClassIdsToday()).toEqual(["c1"]);
    expect(await AsyncStorage.getItem("@uiuc_bus_walked_class_ids_2000-01-01")).toBeNull();
  });
});
