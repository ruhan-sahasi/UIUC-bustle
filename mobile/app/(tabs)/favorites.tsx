import {
  addFavoritePlace,
  addFavoriteStop,
  getAfterLastClassPlaceId,
  getFavoritePlaces,
  getFavoriteStops,
  removeFavoritePlace,
  removeFavoriteStop,
  setAfterLastClassPlaceId,
  type FavoriteStop,
  type SavedPlace,
} from "@/src/storage/favorites";
import { FadeInView, Press, PressableScale, Skeleton, useReducedMotion } from "@/src/components/ui/motion";
import { EmptyState } from "@/src/components/ui/EmptyState";
import { Check, MapPin, Plus, Star, Trash2 } from "lucide-react-native";
import { theme } from "@/src/constants/theme";
import { LinearGradient } from "expo-linear-gradient";
import * as Location from "expo-location";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import {
  Alert,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Animated, {
  FadeInDown,
  LayoutAnimationConfig,
  LinearTransition,
  ReduceMotion,
} from "react-native-reanimated";

// ── Render-only pieces ─────────────────────────────────────────────────────

/**
 * Reorder transition for the saved-place / favorite-stop rows. Mirrors
 * `SPRING.settle` (the "list settle" config) in the layout-builder lane, which
 * cannot take a spring config object. `reduceMotion` is belt-and-braces: the
 * builder is also swapped for `undefined` in JS off the live accessibility flag.
 */
const ROW_REORDER = LinearTransition.springify()
  .damping(120)
  .mass(4)
  .stiffness(900)
  .reduceMotion(ReduceMotion.System);

/**
 * Row entrance. `LayoutAnimationConfig skipEntering` suppresses this for the
 * rows already present when the list mounts, so it only ever plays for a place
 * or stop that genuinely appears later.
 */
const ROW_ENTERING = FadeInDown.duration(theme.motion.slow).reduceMotion(ReduceMotion.System);

/**
 * One flat, single-column list carries both sections so a single
 * `itemLayoutAnimation` covers every row — including the "Favorite stops"
 * heading, which slides as the places above it are added or removed. Keys are
 * namespaced because a place id and a stop id could otherwise collide.
 */
type FavoriteRow =
  | { kind: "place"; key: string; place: SavedPlace }
  | { kind: "stopsHeading"; key: string }
  | { kind: "stop"; key: string; stop: FavoriteStop };

/** Springy selector chip — selected state pairs the fill with a check glyph. */
function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <PressableScale
      scaleTo={0.9}
      style={[styles.chip, selected && styles.chipSelected]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
    >
      {selected && <Check size={13} strokeWidth={3} color={theme.colors.surface} />}
      <Text style={[styles.chipText, selected && styles.chipTextSelected]} numberOfLines={1}>
        {label}
      </Text>
    </PressableScale>
  );
}

export default function FavoritesScreen() {
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const [places, setPlaces] = useState<SavedPlace[]>([]);
  const [stops, setStops] = useState<FavoriteStop[]>([]);
  const [afterLastClassId, setAfterLastClassId] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [addingPlace, setAddingPlace] = useState(false);
  const [savingPlace, setSavingPlace] = useState(false);
  const [newPlaceName, setNewPlaceName] = useState("");

  const load = useCallback(async () => {
    const [p, s, a] = await Promise.all([
      getFavoritePlaces(),
      getFavoriteStops(),
      getAfterLastClassPlaceId(),
    ]);
    setPlaces(p);
    setStops(s);
    setAfterLastClassId(a);
    setLoading(false);
  }, []);

  // Refresh on every focus (not just mount) so a stop starred on Home or Map
  // is already in the list when the user switches back to this tab.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const addPlaceWithLocation = useCallback(async () => {
    const name = newPlaceName.trim() || "Saved place";
    setSavingPlace(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Need location", "Allow location to add a place.");
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const place = await addFavoritePlace({
        name,
        lat: loc.coords.latitude,
        lng: loc.coords.longitude,
      });
      setPlaces((prev) => [...prev, place]);
      setNewPlaceName("");
      setAddingPlace(false);
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Could not add place.");
    } finally {
      setSavingPlace(false);
    }
  }, [newPlaceName]);

  const removePlace = useCallback(async (id: string) => {
    await removeFavoritePlace(id);
    setPlaces((prev) => prev.filter((p) => p.id !== id));
    if (afterLastClassId === id) setAfterLastClassId(await getAfterLastClassPlaceId());
  }, [afterLastClassId]);

  const removeStop = useCallback(async (stopId: string) => {
    await removeFavoriteStop(stopId);
    setStops((prev) => prev.filter((s) => s.stop_id !== stopId));
  }, []);

  const setAfterLastClass = useCallback(async (placeId: string) => {
    await setAfterLastClassPlaceId(placeId);
    setAfterLastClassId(placeId);
  }, []);

  if (loading) {
    // Skeleton mirror of the loaded layout: section label + chip row card,
    // section label + add button, then two favorite cards.
    return (
      <View style={styles.screen}>
        <View style={styles.container} accessibilityLabel="Loading favorites">
          <Skeleton width={140} height={12} style={styles.skeletonLabel} />
          <View style={styles.sectionCard}>
            <View style={styles.afterRow}>
              <Skeleton width={72} height={theme.layout.tapMin} radius={theme.radius.pill} />
              <Skeleton width={96} height={theme.layout.tapMin} radius={theme.radius.pill} />
            </View>
          </View>
          <Skeleton width={110} height={12} style={styles.skeletonLabel} />
          <Skeleton width="100%" height={52} radius={theme.radius.lg} />
          <Skeleton width="100%" height={104} radius={theme.radius.xl} style={styles.skeletonCard} />
          <Skeleton width="100%" height={104} radius={theme.radius.xl} style={styles.skeletonCard} />
        </View>
      </View>
    );
  }

  const rows: FavoriteRow[] = [
    ...places.map((p) => ({ kind: "place" as const, key: `place:${p.id}`, place: p })),
    { kind: "stopsHeading" as const, key: "stops-heading" },
    ...stops.map((s) => ({ kind: "stop" as const, key: `stop:${s.stop_id}`, stop: s })),
  ];

  return (
    <LayoutAnimationConfig skipEntering>
    <Animated.FlatList
      style={styles.screen}
      contentContainerStyle={styles.container}
      data={rows}
      // MANDATORY: stable, non-index keys (place id / stop id). With a
      // positional key `itemLayoutAnimation` animates the WRONG rows when a
      // place or stop is removed from the middle.
      keyExtractor={(row: FavoriteRow) => row.key}
      // Single column only — `itemLayoutAnimation` is unsupported past one.
      itemLayoutAnimation={reduceMotion ? undefined : ROW_REORDER}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.navy} />
      }
      ListHeaderComponent={
      <>
      <FadeInView delay={0}>
        <Text style={styles.sectionLabel} accessibilityRole="header">After last class I go to</Text>
        <View style={styles.sectionCard}>
          <View style={styles.afterRow}>
            <Chip label="None" selected={afterLastClassId === ""} onPress={() => setAfterLastClass("")} />
            {places.map((p) => (
              <Chip
                key={p.id}
                label={p.name}
                selected={afterLastClassId === p.id}
                onPress={() => setAfterLastClass(p.id)}
              />
            ))}
          </View>
        </View>
      </FadeInView>

      <FadeInView delay={70}>
        <Text style={styles.sectionLabel} accessibilityRole="header">Saved places</Text>
        <Text style={styles.hint}>Save spots like the gym or a friend's place — we'll recommend the best bus route from Home, and you can use them for "After last class."</Text>
        {addingPlace ? (
          <View style={styles.addCard}>
            <TextInput
              placeholder="Place name (e.g. Gym, McDonald's)"
              placeholderTextColor={theme.colors.textMuted}
              style={styles.input}
              value={newPlaceName}
              onChangeText={setNewPlaceName}
            />
            <PressableScale
              style={styles.addBtnWrap}
              onPress={addPlaceWithLocation}
              disabled={savingPlace}
              accessibilityRole="button"
              accessibilityLabel="Use my location"
              accessibilityState={{ disabled: savingPlace, busy: savingPlace }}
            >
              <LinearGradient
                colors={[theme.gradients.sunset[0], theme.gradients.sunset[1]]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.addBtn}
              >
                <MapPin size={15} color={theme.colors.surface} strokeWidth={2.2} />
                <Text style={styles.addBtnText}>{savingPlace ? "Saving place…" : "Use my location"}</Text>
              </LinearGradient>
            </PressableScale>
            <PressableScale
              haptic={false}
              style={styles.cancelBtn}
              onPress={() => { setAddingPlace(false); setNewPlaceName(""); }}
              accessibilityRole="button"
              accessibilityLabel="Cancel adding a place"
            >
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </PressableScale>
          </View>
        ) : (
          <PressableScale
            style={styles.addPlaceBtn}
            onPress={() => setAddingPlace(true)}
            accessibilityRole="button"
            accessibilityLabel="Add place"
          >
            <Plus size={16} color={theme.colors.brandInk} strokeWidth={2.2} />
            <Text style={styles.addPlaceBtnText}>Add place</Text>
          </PressableScale>
        )}
      </FadeInView>
      {places.length === 0 && !addingPlace && (
        <FadeInView delay={100} style={styles.emptyCard}>
          <EmptyState
            icon={MapPin}
            title="No saved places yet"
            subtitle={'Tap "Add place" while you’re at the gym, work, or a friend’s to save the spot.'}
          />
        </FadeInView>
      )}
      </>
      }
      renderItem={({ item }: { item: FavoriteRow }) => (
        <Animated.View entering={reduceMotion ? undefined : ROW_ENTERING}>
          {item.kind === "place" ? (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={styles.iconCircle}>
                  <MapPin size={16} color={theme.colors.brandInk} strokeWidth={2} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.placeName}>{item.place.name}</Text>
                  <Text style={styles.placeCoords}>{item.place.lat.toFixed(4)}, {item.place.lng.toFixed(4)}</Text>
                </View>
              </View>
              <View style={styles.cardRow}>
                <Press
                  style={styles.linkBtn}
                  onPress={() => router.push("/(tabs)")}
                  accessibilityRole="button"
                  accessibilityLabel={`Open Home for routes to ${item.place.name}`}
                >
                  <Text style={styles.linkBtnText}>Open Home for routes</Text>
                </Press>
                <Press
                  style={styles.removeBtn}
                  onPress={() => removePlace(item.place.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${item.place.name} from saved places`}
                >
                  <Trash2 size={13} color={theme.colors.errorDeep} strokeWidth={2.2} />
                  <Text style={styles.removeBtnText}>Remove</Text>
                </Press>
              </View>
            </View>
          ) : item.kind === "stop" ? (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={styles.iconCircle}>
                  <Star size={16} color={theme.colors.brandInk} strokeWidth={2} />
                </View>
                <Text style={[styles.stopName, { flex: 1 }]}>{item.stop.stop_name}</Text>
              </View>
              <View style={styles.cardRow}>
                <Press
                  style={styles.linkBtn}
                  onPress={() => router.push({ pathname: "/trip", params: { stop_id: item.stop.stop_id, stop_name: item.stop.stop_name } })}
                  accessibilityRole="button"
                  accessibilityLabel={`Departures from ${item.stop.stop_name}`}
                >
                  <Text style={styles.linkBtnText}>Departures</Text>
                </Press>
                <Press
                  style={styles.removeBtn}
                  onPress={() => removeStop(item.stop.stop_id)}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${item.stop.stop_name} from favorite stops`}
                >
                  <Trash2 size={13} color={theme.colors.errorDeep} strokeWidth={2.2} />
                  <Text style={styles.removeBtnText}>Remove</Text>
                </Press>
              </View>
            </View>
          ) : (
            <View>
              <Text style={styles.sectionLabel} accessibilityRole="header">Favorite stops</Text>
              <Text style={styles.hint}>Add stops from Home or Map. Quick access to departures.</Text>
              {stops.length === 0 && (
                <View style={styles.emptyCard}>
                  <EmptyState
                    icon={Star}
                    title="No favorite stops yet"
                    subtitle="Tap the star on any stop in Home or Map for one-tap departures."
                  />
                </View>
              )}
            </View>
          )}
        </Animated.View>
      )}
    />
    </LayoutAnimationConfig>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.surfaceAlt },
  container: { padding: theme.layout.gutter, paddingBottom: 40 },
  skeletonLabel: { marginTop: theme.layout.gutter, marginBottom: theme.spacing.sm, marginLeft: 4 },
  skeletonCard: { marginTop: theme.layout.cardGap },
  sectionLabel: { ...theme.text.eyebrow, color: theme.colors.textMuted, marginTop: theme.layout.gutter, marginBottom: theme.spacing.sm, marginLeft: 4 },
  hint: { ...theme.text.caption, color: theme.colors.textSecondary, marginBottom: theme.layout.cardGap, marginLeft: 4 },
  sectionCard: { backgroundColor: theme.colors.surface, borderRadius: theme.radius.xl, padding: theme.layout.gutter, ...theme.elevation[2] },
  afterRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.sm },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    minHeight: theme.layout.tapMin,
    paddingHorizontal: theme.layout.gutter,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.orangeSoft,
  },
  chipSelected: { backgroundColor: theme.colors.ctaEnd, ...theme.shadows.glowOrange },
  chipText: { ...theme.text.subhead, fontSize: 14, color: theme.colors.brandInk },
  chipTextSelected: { color: theme.colors.surface },
  addCard: { backgroundColor: theme.colors.surface, borderRadius: theme.radius.xl, padding: theme.layout.gutter, marginBottom: theme.layout.cardGap, ...theme.elevation[2] },
  input: {
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderSoft,
    borderRadius: theme.radius.lg,
    padding: 12,
    marginBottom: 10,
    minHeight: theme.layout.tapMin,
    ...theme.text.body,
    fontSize: 16,
    color: theme.colors.text,
  },
  addBtnWrap: { borderRadius: theme.radius.lg, ...theme.shadows.glowOrange, marginBottom: 4 },
  addBtn: {
    flexDirection: "row",
    gap: 7,
    padding: 14,
    minHeight: theme.layout.tapMin,
    borderRadius: theme.radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  addBtnText: { ...theme.text.subhead, color: theme.colors.surface },
  cancelBtn: { alignItems: "center", justifyContent: "center", minHeight: theme.layout.tapMin, padding: 10 },
  cancelBtnText: { ...theme.text.body, fontSize: 14, color: theme.colors.textSecondary },
  addPlaceBtn: {
    flexDirection: "row",
    gap: 6,
    minHeight: theme.layout.tapMin,
    padding: theme.layout.gutter,
    borderRadius: theme.radius.lg,
    borderWidth: 1.5,
    borderColor: theme.colors.orange,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: theme.layout.cardGap,
    backgroundColor: theme.colors.surface,
  },
  addPlaceBtnText: { ...theme.text.subhead, color: theme.colors.brandInk },
  emptyCard: { backgroundColor: theme.colors.surface, borderRadius: theme.radius.xl, marginBottom: theme.layout.cardGap, ...theme.elevation[1] },
  card: { backgroundColor: theme.colors.surface, borderRadius: theme.radius.xl, padding: theme.layout.gutter, marginBottom: 10, ...theme.elevation[2] },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  iconCircle: { width: 36, height: 36, borderRadius: 18, backgroundColor: theme.colors.orangeSoft, alignItems: "center", justifyContent: "center" },
  placeName: { ...theme.text.heading, fontSize: 16, color: theme.colors.navy },
  placeCoords: { ...theme.text.caption, fontSize: 12, color: theme.colors.textMuted, marginTop: 1, fontVariant: ["tabular-nums" as const] },
  stopName: { ...theme.text.heading, fontSize: 16, color: theme.colors.navy },
  cardRow: { flexDirection: "row", marginTop: theme.spacing.md, gap: 10, alignItems: "center" },
  linkBtn: {
    minHeight: theme.layout.tapMin,
    justifyContent: "center",
    paddingVertical: 8,
    paddingHorizontal: theme.layout.gutter,
    backgroundColor: theme.colors.navy,
    borderRadius: theme.radius.pill,
  },
  linkBtnText: { ...theme.text.subhead, fontSize: 14, color: theme.colors.surface },
  removeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    minHeight: theme.layout.tapMin,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: theme.colors.errorSoft,
    borderRadius: theme.radius.pill,
  },
  removeBtnText: { ...theme.text.subhead, fontSize: 14, color: theme.colors.errorDeep },
});
