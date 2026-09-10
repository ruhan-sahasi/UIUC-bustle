import { fetchRecommendation } from "@/src/api/client";
import type { RecommendationOption } from "@/src/api/types";
import { useApiBaseUrl } from "@/src/hooks/useApiBaseUrl";
import { useRecommendationSettings } from "@/src/hooks/useRecommendationSettings";
import { getFavoritePlaces, type SavedPlace } from "@/src/storage/favorites";
import { useRouter } from "expo-router";
import * as Location from "expo-location";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { theme } from "@/src/constants/theme";
import { STAGGER } from "@/src/constants/motion";
import { FadeInView, Press, Skeleton, Stagger } from "@/src/components/ui/motion";
import { EmptyState } from "@/src/components/ui/EmptyState";
import { LinearGradient } from "expo-linear-gradient";
import { Bus, Footprints, Heart, MapPinOff, Sparkles } from "lucide-react-native";

const PRESET_CHIPS = ["Home", "Gym", "Library", "Groceries"];

export default function AfterClassPlannerScreen() {
  const router = useRouter();
  const { apiBaseUrl, apiKey } = useApiBaseUrl();
  const { walkingSpeedMps, bufferMinutes } = useRecommendationSettings();
  const [freeText, setFreeText] = useState("");
  const [favorites, setFavorites] = useState<SavedPlace[]>([]);
  const [selectedDest, setSelectedDest] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<{ dest: string; options: RecommendationOption[] }[]>([]);
  const [narrative, setNarrative] = useState<string | null>(null);
  // True once a plan request has completed successfully, so an empty response
  // renders a terminal "no plan" state instead of leaving the region blank.
  const [requested, setRequested] = useState(false);

  useEffect(() => {
    getFavoritePlaces().then((places) => setFavorites(places));
  }, []);

  const onGetPlan = useCallback(async () => {
    const dest = freeText.trim() || selectedDest;
    if (!dest) return;
    setLoading(true);
    setError(null);
    setResults([]);
    setNarrative(null);
    setRequested(false);
    try {
      const { status: perm } = await Location.requestForegroundPermissionsAsync();
      if (perm !== "granted") {
        setError("Location permission required.");
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = loc.coords;
      const base = apiBaseUrl.replace(/\/$/, "");
      // Call the backend planner
      const res = await fetch(`${base}/ai/after-class-plan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "X-API-Key": apiKey } : {}),
        },
        body: JSON.stringify({
          freetext_plan: dest,
          lat: latitude,
          lng: longitude,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { detail?: string }).detail || `Planner: ${res.status}`);
      }
      const data = await res.json();
      setNarrative(data.narrative ?? null);
      const chain: { dest: string; options: RecommendationOption[] }[] = data.destination_sequence ?? [];
      setResults(chain);
      setRequested(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to get plan.");
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, apiKey, freeText, selectedDest]);

  const canPlan = !loading && (!!freeText.trim() || !!selectedDest);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <FadeInView>
        <Text style={styles.eyebrow}>After class</Text>
        <Text style={styles.intro}>What are your plans after class?</Text>
      </FadeInView>
      <TextInput
        style={styles.input}
        value={freeText}
        onChangeText={setFreeText}
        placeholder="e.g. Go to gym then grab dinner"
        multiline
        numberOfLines={3}
        placeholderTextColor={theme.colors.textMuted}
      />

      <Text style={styles.orLabel}>or pick a destination</Text>

      {/*
        Preset chips — a small cluster, so the tighter `STAGGER.step`/`cap`
        default is right here (the list cadence is for scrolling content).
        `Press` rather than `PressableScale`: it enforces the 44pt floor and a
        declared accessibility role at compile time, which is what a row of
        small pill targets most needs.
      */}
      <Stagger style={styles.chipsRow}>
        {PRESET_CHIPS.map((chip) => {
          const on = selectedDest === chip;
          return (
            <Press
              key={chip}
              scaleTo={0.93}
              style={[styles.chip, on && styles.chipActive]}
              onPress={() => {
                setSelectedDest(selectedDest === chip ? null : chip);
                setFreeText("");
              }}
              accessibilityRole="button"
              accessibilityLabel={chip}
              accessibilityState={{ selected: on }}
            >
              <Text style={[styles.chipText, on && styles.chipTextActive]}>{chip}</Text>
            </Press>
          );
        })}
      </Stagger>

      {/* Saved favorites */}
      {favorites.length > 0 && (
        <Stagger style={styles.favRow}>
          {favorites.map((f) => {
            const on = selectedDest === f.name;
            return (
              <Press
                key={f.id}
                scaleTo={0.93}
                style={[styles.chip, on && styles.chipActive]}
                onPress={() => {
                  setSelectedDest(selectedDest === f.name ? null : f.name);
                  setFreeText("");
                }}
                accessibilityRole="button"
                accessibilityLabel={`Favorite: ${f.name}`}
                accessibilityState={{ selected: on }}
              >
                <View style={styles.chipInner}>
                  <Heart
                    size={13}
                    color={on ? theme.colors.surface : theme.colors.brandInk}
                    fill={on ? theme.colors.surface : theme.colors.brandInk}
                  />
                  <Text style={[styles.chipText, on && styles.chipTextActive]}>{f.name}</Text>
                </View>
              </Press>
            );
          })}
        </Stagger>
      )}

      <Press
        scaleTo={0.97}
        style={[styles.planBtn, !canPlan && styles.planBtnDisabled]}
        onPress={onGetPlan}
        disabled={loading || (!freeText.trim() && !selectedDest)}
        accessibilityRole="button"
        accessibilityLabel="Get Plan"
        accessibilityState={{ disabled: !canPlan, busy: loading }}
      >
        <LinearGradient
          colors={[theme.gradients.sunset[0], theme.gradients.sunset[1]]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.planBtnFill}
        >
          {loading ? (
            <ActivityIndicator size="small" color={theme.colors.surface} />
          ) : (
            <Text style={styles.planBtnText}>Get Plan</Text>
          )}
        </LinearGradient>
      </Press>

      {loading && (
        <View style={styles.skeletonStack}>
          <Skeleton height={92} radius={theme.radius.xl} />
          <Skeleton height={92} radius={theme.radius.xl} />
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {/* The planner answered but had nothing for this request — say so,
          rather than leaving the region below the button blank. */}
      {requested && !loading && !error && results.length === 0 && !narrative && (
        <EmptyState
          icon={MapPinOff}
          title="No plan for that"
          subtitle="We couldn't turn that into a route. Try naming a specific place, like a gym, a library, or a street address."
        />
      )}

      {narrative && (
        <FadeInView>
          <View style={styles.narrativeCard}>
            <View style={styles.narrativeHeader}>
              <Sparkles size={14} color={theme.colors.brandInk} strokeWidth={2.2} />
              <Text style={styles.narrativeEyebrow}>Your plan</Text>
            </View>
            <Text style={styles.narrativeText}>{narrative}</Text>
          </View>
        </FadeInView>
      )}

      {/*
        The plan's legs, in order. `Stagger` replaces the old `delay={idx * 90}`
        so this reads at the same cadence as every other list in the app — and
        so it disappears entirely under reduced motion rather than each leg
        waiting out a hand-rolled delay.
      */}
      <Stagger step={STAGGER.listStep} cap={STAGGER.listCap}>
        {results.map((item, idx) => (
          <View key={idx} style={styles.destBlock}>
            <View style={styles.destHeader}>
              <View style={styles.destStep}>
                <Text style={styles.destStepText}>{idx + 1}</Text>
              </View>
              <Text style={styles.destTitle}>{item.dest}</Text>
            </View>
            {item.options.map((opt, oidx) => (
              <View
                key={oidx}
                style={styles.optCard}
                accessible
                accessibilityLabel={`${opt.type === "WALK" ? "Walk" : "Bus"}: leave in ${opt.depart_in_minutes} minutes, ${opt.eta_minutes} minutes total`}
              >
                <View style={styles.optIconHalo}>
                  {opt.type === "WALK"
                    ? <Footprints size={18} color={theme.colors.brandInk} strokeWidth={2} />
                    : <Bus size={18} color={theme.colors.brandInk} strokeWidth={2} />}
                </View>
                <View style={styles.optBody}>
                  <Text style={styles.optType}>{opt.type === "WALK" ? "Walk" : "Bus"}</Text>
                  <Text style={styles.optMeta}>Leave in {opt.depart_in_minutes} min · {opt.eta_minutes} min total</Text>
                </View>
              </View>
            ))}
          </View>
        ))}
      </Stagger>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.surfaceAlt },
  container: { padding: theme.layout.gutter, paddingBottom: 40 },
  eyebrow: { ...theme.text.eyebrow, color: theme.colors.textMuted, marginBottom: theme.spacing.sm },
  intro: { ...theme.text.title1, color: theme.colors.navy, marginBottom: theme.layout.gutter },
  input: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderSoft,
    borderRadius: theme.radius.xl,
    padding: theme.layout.gutter,
    fontSize: 16,
    fontFamily: "DMSans_400Regular",
    color: theme.colors.text,
    marginBottom: theme.layout.gutter,
    minHeight: 96,
    textAlignVertical: "top",
    ...theme.elevation[1],
  },
  orLabel: { ...theme.text.eyebrow, textAlign: "center", color: theme.colors.textMuted, marginBottom: theme.layout.cardGap },
  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.sm, marginBottom: theme.spacing.sm },
  favRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.sm, marginBottom: theme.layout.gutter },
  chip: {
    minHeight: theme.layout.tapMin,
    paddingHorizontal: theme.layout.gutter,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    justifyContent: "center",
  },
  chipActive: { backgroundColor: theme.colors.navy, borderColor: theme.colors.navy, ...theme.elevation[1] },
  chipInner: { flexDirection: "row", alignItems: "center", gap: 6 },
  chipText: { ...theme.text.subhead, fontSize: 14, color: theme.colors.text },
  chipTextActive: { color: theme.colors.surface },

  // Primary CTA — white label rides the gradient's darker ctaEnd stop
  planBtn: {
    borderRadius: theme.radius.lg,
    overflow: "hidden",
    marginTop: theme.spacing.sm,
    marginBottom: theme.layout.gutter,
    minHeight: 52,
    ...theme.shadows.glowOrange,
  },
  planBtnDisabled: { opacity: 0.55 },
  planBtnFill: { minHeight: 52, paddingVertical: 14, alignItems: "center", justifyContent: "center" },
  planBtnText: { color: theme.colors.surface, fontFamily: "DMSans_700Bold", fontSize: 16, letterSpacing: 0.2 },

  skeletonStack: { gap: theme.layout.cardGap, marginBottom: theme.layout.gutter },
  error: { ...theme.text.body, fontSize: 14, color: theme.colors.errorDeep, marginBottom: theme.layout.cardGap },

  narrativeCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    padding: theme.layout.gutter,
    marginBottom: theme.layout.gutter,
    borderLeftWidth: 4,
    borderLeftColor: theme.colors.orange,
    ...theme.elevation[1],
  },
  narrativeHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: theme.spacing.sm },
  narrativeEyebrow: { ...theme.text.eyebrow, color: theme.colors.brandInk },
  narrativeText: { ...theme.text.body, fontSize: 14, color: theme.colors.text, fontStyle: "italic" },

  destBlock: { marginBottom: theme.layout.gutter },
  destHeader: { flexDirection: "row", alignItems: "center", gap: theme.spacing.md, marginBottom: theme.spacing.sm },
  destStep: {
    width: 26,
    height: 26,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.navy,
    alignItems: "center",
    justifyContent: "center",
  },
  destStepText: { ...theme.text.numeric, fontSize: 13, color: theme.colors.textOnNavy },
  destTitle: { ...theme.text.title2, color: theme.colors.navy, flex: 1 },
  optCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.layout.cardGap,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: theme.layout.cardGap,
    marginBottom: theme.spacing.sm,
    ...theme.elevation[1],
  },
  optIconHalo: {
    width: 38,
    height: 38,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.orangeSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  optBody: { flex: 1 },
  optType: { ...theme.text.subhead, color: theme.colors.text },
  optMeta: { ...theme.text.caption, fontSize: 13, color: theme.colors.textSecondary, marginTop: 1, fontVariant: ["tabular-nums"] },
});
