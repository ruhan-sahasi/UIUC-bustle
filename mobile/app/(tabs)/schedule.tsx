import {
  fetchPlaceDetails,
} from "@/src/api/client";
import { cancelClassReminder } from "@/src/notifications/classReminders";
import { cancelLeaveNowAlert } from "@/src/notifications/leaveNow";
import { disableClassNotif, enableClassNotif, getDisabledClassIds } from "@/src/storage/classNotifPrefs";
import { getClassRouteData, type ClassRouteData } from "@/src/storage/classSummaryCache";
import type { AutocompleteResult } from "@/src/api/client";
import type { Building, ScheduleClass } from "@/src/api/types";
import { useApiBaseUrl } from "@/src/hooks/useApiBaseUrl";
import { theme } from "@/src/constants/theme";
import { FadeInView, fireHaptic, Press, PressableScale, Skeleton, useReducedMotion } from "@/src/components/ui/motion";
import { EmptyState } from "@/src/components/ui/EmptyState";
import { LinearGradient } from "expo-linear-gradient";
import { Bell, BellOff, CalendarDays, Clock, CloudOff, MapPin, Pencil, Plus, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useFocusEffect } from "expo-router";
import { useAnalytics } from "@/src/hooks/useAnalytics";
import {
  ActivityIndicator,
  Alert,
  Modal,
  RefreshControl,
  ScrollView,
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
import { useClasses, useBuildings, useDeleteClass, useCreateClass, useUpdateClass, useBuildingSearch } from "@/src/queries/schedule";
import { usePlacesAutocomplete } from "@/src/queries/places";

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const DAY_LABELS: Record<string, string> = {
  MON: "Mon", TUE: "Tue", WED: "Wed", THU: "Thu", FRI: "Fri", SAT: "Sat", SUN: "Sun",
};
const DAY_FULL: Record<string, string> = {
  MON: "Monday", TUE: "Tuesday", WED: "Wednesday", THU: "Thursday", FRI: "Friday", SAT: "Saturday", SUN: "Sunday",
};

/**
 * Reorder transition for the class list. Mirrors `SPRING.settle` (the "list
 * settle" config) in the layout-builder lane, which cannot take a spring config
 * object. `reduceMotion` is belt-and-braces: the builder is also swapped for
 * `undefined` in JS off the live accessibility flag.
 */
const CARD_REORDER = LinearTransition.springify()
  .damping(120)
  .mass(4)
  .stiffness(900)
  .reduceMotion(ReduceMotion.System);

/**
 * Row entrance. `LayoutAnimationConfig skipEntering` suppresses this for the
 * rows already present when the list mounts, so it only ever plays for a class
 * that genuinely appears later (added, or revealed by the week filter).
 */
const CARD_ENTERING = FadeInDown.duration(theme.motion.slow).reduceMotion(ReduceMotion.System);

function getLeaveByTime(startTime: string, departInMins: number): string {
  const [h, m] = startTime.split(':').map(Number);
  const totalMins = h * 60 + m - Math.round(departInMins);
  const lh = Math.floor(((totalMins % 1440) + 1440) % 1440 / 60);
  const lm = ((totalMins % 1440) + 1440) % 1440 % 60;
  const period = lh >= 12 ? 'PM' : 'AM';
  const displayH = lh % 12 || 12;
  return `${displayH}:${lm.toString().padStart(2, '0')} ${period}`;
}

function to12h(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const displayH = h % 12 || 12;
  return `${displayH}:${m.toString().padStart(2, '0')} ${period}`;
}

function getTransitStatus(startTime: string, departInMins: number): { main: string; soft: string } {
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const [h, m] = startTime.split(':').map(Number);
  const classMins = h * 60 + m;
  const leaveByMins = classMins - Math.round(departInMins);
  const minsUntilLeave = leaveByMins - nowMins;
  // Deep status tokens — AA-safe as text on the soft tints (and fine as accent fills).
  if (minsUntilLeave > 15) return { main: theme.colors.successDeep, soft: theme.colors.successSoft };
  if (minsUntilLeave > 5) return { main: theme.colors.warningDeep, soft: theme.colors.warningSoft };
  return { main: theme.colors.errorDeep, soft: theme.colors.errorSoft };
}

export default function ScheduleScreen() {
  const { apiBaseUrl, apiKey } = useApiBaseUrl();
  const router = useRouter();
  const { capture } = useAnalytics();
  const reduceMotion = useReducedMotion();

  const { data: classesData, isLoading, isError, isRefetching, refetch: refetchClasses } = useClasses();
  const { data: buildingsData } = useBuildings();
  const classes = classesData?.classes ?? [];
  const buildings = buildingsData?.buildings ?? [];

  const { mutate: deleteClassMutation } = useDeleteClass();
  const { mutate: createClassMutation } = useCreateClass();
  const { mutate: updateClassMutation } = useUpdateClass();

  const [editingClass, setEditingClass] = useState<ScheduleClass | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [classRouteDatas, setClassRouteDatas] = useState<Record<string, ClassRouteData | null>>({});
  const [title, setTitle] = useState("");
  const [days, setDays] = useState<string[]>([]);
  const [time, setTime] = useState("09:00");
  const [endTime, setEndTime] = useState("");
  const [locationQuery, setLocationQuery] = useState("");
  const [debouncedLocationQuery, setDebouncedLocationQuery] = useState("");
  const [locationSearching, setLocationSearching] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [locationDisplay, setLocationDisplay] = useState<string | null>(null);
  const [locationLat, setLocationLat] = useState<number | null>(null);
  const [locationLng, setLocationLng] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [successToast, setSuccessToast] = useState<string | null>(null);
  const [disabledNotifIds, setDisabledNotifIds] = useState<string[]>([]);

  const locationDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const locationSessionRef = useRef<string>(Math.random().toString(36).slice(2));

  // "List" or "Week" view toggle
  const [viewMode, setViewMode] = useState<"list" | "week">("list");
  const [selectedWeekDay, setSelectedWeekDay] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      capture("schedule_viewed");
    }, [capture])
  );

  // Load disabled notif IDs and class route data whenever classes update
  useEffect(() => {
    getDisabledClassIds().then(setDisabledNotifIds);
  }, []);

  useEffect(() => {
    if (classes.length === 0) return;
    Promise.all(
      classes.map(async (c) => [c.class_id, await getClassRouteData(c.class_id)] as [string, ClassRouteData | null])
    ).then((entries) => setClassRouteDatas(Object.fromEntries(entries)));
  }, [classes]);

  // Debounce the location query for TQ hooks
  useEffect(() => {
    if (locationDebounceRef.current) clearTimeout(locationDebounceRef.current);
    locationDebounceRef.current = setTimeout(() => {
      setDebouncedLocationQuery(locationQuery.trim());
    }, 300);
    return () => {
      if (locationDebounceRef.current) clearTimeout(locationDebounceRef.current);
    };
  }, [locationQuery]);

  // TQ-powered autocomplete queries
  const { data: buildingSearchData } = useBuildingSearch(debouncedLocationQuery);
  const { data: placesData } = usePlacesAutocomplete(debouncedLocationQuery, locationSessionRef.current);

  // Combine building + places results into locationSuggestions
  const locationSuggestions: AutocompleteResult[] = (() => {
    if (debouncedLocationQuery.length < 2) return [];
    const buildingResults: AutocompleteResult[] = (buildingSearchData?.buildings ?? []).slice(0, 4).map((b) => ({
      type: "building" as const,
      name: b.name,
      display_name: b.name,
      lat: b.lat,
      lng: b.lng,
      building_id: b.building_id,
      place_id: "",
    }));
    const placesResults = (placesData?.predictions ?? []).slice(0, Math.max(0, 6 - buildingResults.length)).map((p) => ({
      type: "google_place" as const,
      name: p.main_text,
      display_name: p.description,
      lat: 0,
      lng: 0,
      building_id: "",
      place_id: p.place_id,
      secondary_text: p.secondary_text,
    }));
    return [...buildingResults, ...placesResults];
  })();

  const resetForm = useCallback(() => {
    setTitle("");
    setDays([]);
    setTime("09:00");
    setEndTime("");
    setLocationQuery("");
    setDebouncedLocationQuery("");
    setLocationDisplay(null);
    setLocationLat(null);
    setLocationLng(null);
    setLocationError(null);
    setEditingClass(null);
    setShowForm(false);
  }, []);

  const onEditClass = useCallback((c: ScheduleClass) => {
    setEditingClass(c);
    setTitle(c.title);
    setDays([...c.days_of_week]);
    setTime(c.start_time_local);
    setEndTime(c.end_time_local ?? "");
    const locName = c.destination_name ?? "";
    setLocationQuery(locName);
    setDebouncedLocationQuery("");
    setLocationDisplay(locName || null);
    setLocationLat(c.destination_lat ?? null);
    setLocationLng(c.destination_lng ?? null);
    setLocationError(null);
    setShowForm(true);
  }, []);

  const toggleDay = (d: string) => {
    setDays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
    );
  };

  const toMinutes = (hhmm: string): number => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };

  const submit = async () => {
    const t = title.trim();
    if (!t) {
      Alert.alert("Error", "Enter a title.");
      return;
    }
    if (days.length === 0) {
      Alert.alert("Error", "Select at least one day.");
      return;
    }
    const match = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(time.trim());
    if (!match) {
      Alert.alert("Error", "Time must be HH:MM (e.g. 09:30).");
      return;
    }
    {
      const [sh, sm] = time.trim().split(":").map(Number);
      const startMins = sh * 60 + sm;
      if (startMins < 7 * 60 || startMins > 22 * 60) {
        const proceed = await new Promise<boolean>((resolve) => {
          Alert.alert(
            "Unusual time",
            `${time.trim()} is outside the typical 07:00–22:00 range. Add anyway?`,
            [
              { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
              { text: "Add anyway", onPress: () => resolve(true) },
            ]
          );
        });
        if (!proceed) return;
      }
    }
    const endTrimmed = endTime.trim();
    if (endTrimmed && !/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(endTrimmed)) {
      Alert.alert("Error", "End time must be HH:MM (e.g. 10:30) or left blank.");
      return;
    }
    if (endTrimmed) {
      const [sh, sm] = time.trim().split(":").map(Number);
      const [eh, em] = endTrimmed.split(":").map(Number);
      if (eh * 60 + em <= sh * 60 + sm) {
        Alert.alert("Error", "End time must be after start time.");
        return;
      }
    }
    if (locationLat == null || locationLng == null) {
      Alert.alert("Error", "Search for a class location (address or place name) first.");
      return;
    }

    // Conflict detection: check if this class overlaps any existing on shared days
    const newStart = toMinutes(time.trim());
    const newEnd = endTrimmed ? toMinutes(endTrimmed) : newStart + 75; // assume 75min if no end
    const conflicts: ScheduleClass[] = [];
    for (const cls of classes) {
      // When editing, skip conflict check against the class being edited
      if (editingClass && cls.class_id === editingClass.class_id) continue;
      if (!days.some((d) => cls.days_of_week.includes(d))) continue;
      const clsStart = toMinutes(cls.start_time_local);
      const clsEnd = cls.end_time_local ? toMinutes(cls.end_time_local) : clsStart + 75;
      if (newStart < clsEnd && newEnd > clsStart) conflicts.push(cls);
    }
    if (conflicts.length > 0) {
      const msg = conflicts.map((c) => `"${c.title}" (${c.start_time_local})`).join(", ");
      const proceed = await new Promise<boolean>((resolve) => {
        Alert.alert(
          "Schedule conflict",
          `This overlaps with ${msg}. ${editingClass ? "Save anyway?" : "Add anyway?"}`,
          [
            { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
            { text: editingClass ? "Save anyway" : "Add anyway", style: "destructive", onPress: () => resolve(true) },
          ]
        );
      });
      if (!proceed) return;
    }

    setSubmitting(true);

    if (editingClass) {
      // Edit mode: PATCH the existing class
      const updates = {
        title: t,
        days_of_week: days,
        start_time_local: time.trim(),
        destination_lat: locationLat ?? undefined,
        destination_lng: locationLng ?? undefined,
        destination_name: locationDisplay ?? (locationQuery.trim() || undefined),
        end_time_local: endTrimmed || undefined,
      };
      updateClassMutation({ classId: editingClass.class_id, updates }, {
        onSuccess: () => {
          resetForm();
          fireHaptic("arrive");
          capture("class_edited", { class_id: editingClass.class_id });
          setSuccessToast("Class saved ✓");
          setTimeout(() => setSuccessToast(null), 2500);
          setSubmitting(false);
        },
        onError: (e) => {
          Alert.alert("Error", e instanceof Error ? e.message : "Failed to save class");
          setSubmitting(false);
        },
      });
      return;
    }

    const body = {
      title: t,
      days_of_week: days,
      start_time_local: time.trim(),
      destination_lat: locationLat,
      destination_lng: locationLng,
      destination_name: locationDisplay ?? (locationQuery.trim() || undefined),
      end_time_local: endTrimmed || undefined,
    };
    createClassMutation(body, {
      onSuccess: () => {
        resetForm();
        fireHaptic("arrive");
        capture("class_added", {
          has_building: false,  // schedule.tsx only uses custom destinations (destination_lat/lng)
          has_custom_dest: locationLat !== null && locationLng !== null,
        });
        setSuccessToast("Class added ✓");
        setTimeout(() => setSuccessToast(null), 2500);
        setSubmitting(false);
      },
      onError: (e) => {
        Alert.alert("Error", e instanceof Error ? e.message : "Failed to add class");
        setSubmitting(false);
      },
    });
  };

  const onLocationQueryChange = useCallback((text: string) => {
    setLocationQuery(text);
    setLocationError(null);
    setLocationDisplay(null);
    setLocationLat(null);
    setLocationLng(null);
  }, []);

  const onSelectLocationSuggestion = useCallback(async (item: AutocompleteResult) => {
    locationSessionRef.current = Math.random().toString(36).slice(2);
    setLocationSearching(true);
    // Clear debounced query so suggestions disappear
    setDebouncedLocationQuery("");
    try {
      if (item.type === "google_place" && item.place_id) {
        const details = await fetchPlaceDetails(apiBaseUrl, item.place_id, { apiKey: apiKey ?? undefined });
        setLocationDisplay(details.display_name || item.name);
        setLocationLat(details.lat);
        setLocationLng(details.lng);
        setLocationQuery(details.display_name || item.name);
      } else {
        setLocationDisplay(item.display_name || item.name);
        setLocationLat(item.lat);
        setLocationLng(item.lng);
        setLocationQuery(item.display_name || item.name);
      }
    } catch (e) {
      setLocationError(e instanceof Error ? e.message : "Failed to resolve location.");
    } finally {
      setLocationSearching(false);
    }
  }, [apiBaseUrl, apiKey]);

  const onDeleteClass = useCallback((c: ScheduleClass) => {
    Alert.alert("Delete class", `Remove "${c.title}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          deleteClassMutation(c.class_id, {
            onSuccess: () => {
              // Deleting the class does not touch the OS notification queue;
              // without this its reminders stay armed for the rest of the horizon.
              void cancelClassReminder(c.class_id);
              void cancelLeaveNowAlert(c.class_id);
            },
            onError: (e) => {
              Alert.alert("Error", e instanceof Error ? e.message : "Failed to delete");
            },
          });
        },
      },
    ]);
  }, [deleteClassMutation]);

  function classLocationLabel(c: ScheduleClass): string {
    if (c.destination_name) return c.destination_name;
    return buildings.find((b: Building) => b.building_id === c.building_id)?.name ?? c.building_id;
  }

  const DAY_ORDER: Record<string, number> = { MON: 0, TUE: 1, WED: 2, THU: 3, FRI: 4, SAT: 5, SUN: 6 };
  const filteredClasses = (
    viewMode === "week" && selectedWeekDay
      ? classes.filter((c) => c.days_of_week?.includes(selectedWeekDay))
      : classes
  ).slice().sort((a, b) => {
    const aDay = Math.min(...(a.days_of_week ?? []).map((d) => DAY_ORDER[d] ?? 99));
    const bDay = Math.min(...(b.days_of_week ?? []).map((d) => DAY_ORDER[d] ?? 99));
    if (aDay !== bDay) return aDay - bDay;
    return (a.start_time_local ?? "").localeCompare(b.start_time_local ?? "");
  });

  // Render-only: which day-of-week is today (JS getDay(): 0 = Sunday).
  const todayKey = DAYS[(new Date().getDay() + 6) % 7];

  if (isLoading) {
    return (
      <View style={styles.loadingWrap}>
        <Skeleton height={116} radius={theme.radius.xl} />
        <Skeleton height={116} radius={theme.radius.xl} />
        <Skeleton height={116} radius={theme.radius.xl} />
      </View>
    );
  }

  return (
    <View style={styles.screenWrapper}>
      <Modal
        visible={showForm}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={resetForm}
      >
        <View style={styles.modalRoot}>
          <ScrollView contentContainerStyle={styles.modalContainer} keyboardShouldPersistTaps="handled">
            <View style={styles.modalHeader}>
              <PressableScale
                scaleTo={0.92}
                style={styles.modalCancelBtn}
                onPress={resetForm}
                accessibilityLabel="Cancel"
                accessibilityRole="button"
              >
                <Text style={styles.modalCancel}>Cancel</Text>
              </PressableScale>
              <Text style={styles.modalTitle}>{editingClass ? "Edit Class" : "Add Class"}</Text>
              <View style={styles.modalHeaderSpacer} />
            </View>
            <View style={styles.formCard}>
              {editingClass && (
                <View style={styles.editingBanner}>
                  <Pencil size={14} color={theme.colors.textOnNavy} strokeWidth={2.2} />
                  <Text style={styles.editingBannerText} numberOfLines={1}>Editing: {editingClass.title}</Text>
                </View>
              )}

              <Text style={styles.sectionEyebrow}>Class details</Text>
              <Text style={styles.label}>Title</Text>
              <TextInput
                style={styles.input}
                value={title}
                onChangeText={(text) => setTitle(text.slice(0, 60))}
                maxLength={60}
                placeholder="e.g. CS 101"
                placeholderTextColor={theme.colors.textMuted}
              />

              <View style={styles.sectionDivider} />
              <Text style={styles.sectionEyebrow}>Schedule</Text>
              <Text style={styles.label}>Days</Text>
              <View style={styles.dayRow}>
                {DAYS.map((d) => {
                  const on = days.includes(d);
                  return (
                    <PressableScale
                      key={d}
                      scaleTo={0.88}
                      style={[styles.dayBtn, on && styles.dayBtnOn]}
                      onPress={() => toggleDay(d)}
                      accessibilityRole="button"
                      accessibilityLabel={DAY_FULL[d]}
                      accessibilityState={{ selected: on }}
                    >
                      <Text style={[styles.dayText, on && styles.dayTextOn]}>{DAY_LABELS[d]}</Text>
                    </PressableScale>
                  );
                })}
              </View>
              <View style={styles.timeRow}>
                <View style={styles.timeCol}>
                  <Text style={styles.label}>Start time (HH:MM)</Text>
                  <TextInput
                    style={[styles.input, styles.timeInput]}
                    value={time}
                    onChangeText={setTime}
                    placeholder="09:00"
                    placeholderTextColor={theme.colors.textMuted}
                    keyboardType="numbers-and-punctuation"
                  />
                </View>
                <View style={styles.timeCol}>
                  <Text style={styles.label}>End time (optional)</Text>
                  <TextInput
                    style={[styles.input, styles.timeInput]}
                    value={endTime}
                    onChangeText={setEndTime}
                    placeholder="10:15"
                    placeholderTextColor={theme.colors.textMuted}
                    keyboardType="numbers-and-punctuation"
                  />
                </View>
              </View>

              <View style={styles.sectionDivider} />
              <Text style={styles.sectionEyebrow}>Location</Text>
              <Text style={styles.label}>Class location (address or place)</Text>
              <TextInput
                style={styles.input}
                value={locationQuery}
                onChangeText={onLocationQueryChange}
                placeholder="e.g. Lincoln Hall, Illini Union, 934 Lundy Lane"
                placeholderTextColor={theme.colors.textMuted}
                autoCorrect={false}
              />
              {locationSearching && <ActivityIndicator size="small" color={theme.colors.navy} style={styles.locationSpinner} />}
              {locationSuggestions.length > 0 && (
                <View style={styles.suggestionList}>
                  {locationSuggestions.map((item, i) => (
                    <PressableScale
                      key={`${item.type}-${item.place_id ?? item.building_id}-${i}`}
                      scaleTo={0.98}
                      haptic={false}
                      style={[styles.suggestionItem, i < locationSuggestions.length - 1 && styles.suggestionSep]}
                      onPress={() => onSelectLocationSuggestion(item)}
                      accessibilityRole="button"
                      accessibilityLabel={item.display_name || item.name}
                    >
                      <Text style={styles.suggestionName} numberOfLines={1}>
                        {item.name}
                      </Text>
                      {(item.secondary_text || item.display_name) ? (
                        <Text style={styles.suggestionSub} numberOfLines={1}>
                          {item.secondary_text ?? item.display_name}
                        </Text>
                      ) : null}
                    </PressableScale>
                  ))}
                </View>
              )}
              {locationError && <Text style={styles.locationError}>{locationError}</Text>}
              {locationDisplay != null && (
                <Text style={styles.locationConfirmed}>✓ {locationDisplay}</Text>
              )}

              <PressableScale
                scaleTo={0.97}
                style={[styles.submitBtn, submitting && styles.submitDisabled]}
                onPress={submit}
                disabled={submitting}
                accessibilityRole="button"
                accessibilityLabel={editingClass ? "Save class" : "Add class"}
                accessibilityState={{ disabled: submitting, busy: submitting }}
              >
                <LinearGradient
                  colors={[theme.gradients.sunset[0], theme.gradients.sunset[1]]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.submitGradient}
                >
                  {submitting ? <ActivityIndicator color={theme.colors.surface} /> : <Text style={styles.submitText}>{editingClass ? "Save" : "Add class"}</Text>}
                </LinearGradient>
              </PressableScale>
            </View>
          </ScrollView>
        </View>
      </Modal>

    <LayoutAnimationConfig skipEntering>
    <Animated.FlatList
      style={styles.list}
      data={filteredClasses}
      // MANDATORY: a stable, non-index key. With a positional key
      // `itemLayoutAnimation` animates the WRONG rows when the sort changes.
      keyExtractor={(c: ScheduleClass) => c.class_id}
      // Single column only — `itemLayoutAnimation` is unsupported past one.
      itemLayoutAnimation={reduceMotion ? undefined : CARD_REORDER}
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl refreshing={isRefetching} onRefresh={() => { refetchClasses(); }} tintColor={theme.colors.navy} />
      }
      ListHeaderComponent={
      <>
      {successToast && (
        <FadeInView dy={-8} duration={theme.motion.base}>
          <View style={styles.successToast}>
            <Text style={styles.successToastText}>{successToast}</Text>
          </View>
        </FadeInView>
      )}

      {/* List / Week toggle */}
      <View style={styles.viewToggleRow}>
        <PressableScale
          scaleTo={0.92}
          style={[styles.viewToggleBtn, viewMode === "list" && styles.viewToggleBtnActive]}
          onPress={() => setViewMode("list")}
          accessibilityRole="button"
          accessibilityLabel="List view"
          accessibilityState={{ selected: viewMode === "list" }}
        >
          <Text style={[styles.viewToggleText, viewMode === "list" && styles.viewToggleTextActive]}>List</Text>
        </PressableScale>
        <PressableScale
          scaleTo={0.92}
          style={[styles.viewToggleBtn, viewMode === "week" && styles.viewToggleBtnActive]}
          onPress={() => setViewMode("week")}
          accessibilityRole="button"
          accessibilityLabel="Week view"
          accessibilityState={{ selected: viewMode === "week" }}
        >
          <Text style={[styles.viewToggleText, viewMode === "week" && styles.viewToggleTextActive]}>Week</Text>
        </PressableScale>
      </View>

      {viewMode === "week" && (
        <View style={styles.weekGrid}>
          {DAYS.map((d) => {
            const isToday = d === todayKey;
            const isSelected = selectedWeekDay === d;
            return (
              <View key={d} style={styles.weekCell}>
                <PressableScale
                  scaleTo={0.92}
                  style={[
                    styles.weekDayBtn,
                    isToday && styles.weekDayBtnToday,
                    isSelected && styles.weekDayBtnActive,
                  ]}
                  onPress={() => setSelectedWeekDay(selectedWeekDay === d ? null : d)}
                  accessibilityRole="button"
                  accessibilityLabel={isToday ? `${DAY_FULL[d]}, today` : DAY_FULL[d]}
                  accessibilityState={{ selected: isSelected }}
                >
                  <Text style={[styles.weekDayText, isSelected && styles.weekDayTextActive]}>
                    {DAY_LABELS[d]}
                  </Text>
                  {isToday && (
                    <Text style={[styles.weekTodayLabel, isSelected && styles.weekTodayLabelActive]}>Today</Text>
                  )}
                </PressableScale>
              </View>
            );
          })}
        </View>
      )}

      <Text style={styles.listTitle}>Your classes</Text>
      </>
      }
      ListEmptyComponent={
        <View style={styles.emptyCard}>
          {isError ? (
            // A failed fetch must never masquerade as a blank schedule — a
            // student could re-enter their whole semester over a dropped
            // connection.
            <EmptyState
              icon={CloudOff}
              title="Couldn't load your schedule"
              subtitle="Check your connection and try again."
              action={{ label: "Retry", onPress: () => { refetchClasses(); } }}
            />
          ) : viewMode === "week" && selectedWeekDay ? (
            <EmptyState
              icon={CalendarDays}
              title={`No classes on ${DAY_LABELS[selectedWeekDay]}`}
              subtitle="Pick another day, or add a class to fill it in."
            />
          ) : (
            <EmptyState
              icon={CalendarDays}
              title="No classes yet"
              subtitle="Add your first class and Bustle will tell you when to leave."
              action={{ label: "Add a class", onPress: () => setShowForm(true) }}
            />
          )}
        </View>
      }
      ListFooterComponent={
        <PressableScale
          scaleTo={0.96}
          style={styles.planWeekBtn}
          onPress={() => router.push('/after-class-planner')}
          accessibilityRole="button"
          accessibilityLabel="Plan my evening"
        >
          <CalendarDays size={16} color={theme.colors.brandInk} />
          <Text style={styles.planWeekBtnText}>Plan my evening →</Text>
        </PressableScale>
      }
      renderItem={({ item: c }: { item: ScheduleClass }) => {
          const route = classRouteDatas[c.class_id];
          const status = route != null ? getTransitStatus(c.start_time_local, route.bestDepartInMinutes) : null;
          const muted = disabledNotifIds.includes(c.class_id);
          return (
            <Animated.View entering={reduceMotion ? undefined : CARD_ENTERING}>
              <View style={styles.card}>
                <View style={[styles.cardAccent, { backgroundColor: status?.main ?? theme.colors.orange }]} />
                <View style={styles.cardBody}>
                  <View style={styles.cardHeader}>
                    <Text style={styles.classTitle}>{c.title}</Text>
                    <View style={styles.cardActions}>
                      <Press
                        scaleTo={0.85}
                        style={styles.iconBtn}
                        hitSlop={4}
                        accessibilityRole="button"
                        accessibilityLabel={muted ? `Unmute notifications for ${c.title}` : `Mute notifications for ${c.title}`}
                        onPress={async () => {
                          if (disabledNotifIds.includes(c.class_id)) {
                            await enableClassNotif(c.class_id);
                          } else {
                            await disableClassNotif(c.class_id);
                            await cancelClassReminder(c.class_id);
                          }
                          setDisabledNotifIds(await getDisabledClassIds());
                        }}
                      >
                        {muted
                          ? <BellOff size={18} color={theme.colors.textMuted} />
                          : <Bell size={18} color={theme.colors.navy} />}
                      </Press>
                      <Press
                        scaleTo={0.85}
                        style={styles.iconBtn}
                        hitSlop={4}
                        onPress={() => onEditClass(c)}
                        accessibilityRole="button"
                        accessibilityLabel={`Edit ${c.title}`}
                      >
                        <Pencil size={18} color={theme.colors.navy} />
                      </Press>
                      {/* Destructive: `onDeleteClass` keeps its own Alert
                          confirmation and its reminder cancellation. */}
                      <Press
                        scaleTo={0.85}
                        style={styles.iconBtn}
                        hitSlop={4}
                        onPress={() => onDeleteClass(c)}
                        accessibilityRole="button"
                        accessibilityLabel={`Delete ${c.title}`}
                      >
                        <Trash2 size={18} color={theme.colors.errorDeep} />
                      </Press>
                    </View>
                  </View>

                  <View style={styles.dayPillRow}>
                    {c.days_of_week.map((d) => (
                      <View key={d} style={[styles.dayPillStatic, d === todayKey && styles.dayPillStaticToday]}>
                        <Text style={[styles.dayPillStaticText, d === todayKey && styles.dayPillStaticTextToday]}>
                          {DAY_LABELS[d]}
                        </Text>
                      </View>
                    ))}
                  </View>

                  <Text style={styles.timeRange}>
                    {to12h(c.start_time_local)}
                    {c.end_time_local ? ` – ${to12h(c.end_time_local)}` : ""}
                  </Text>
                  <View style={styles.buildingRow}>
                    <MapPin size={13} color={theme.colors.textMuted} strokeWidth={2.2} />
                    <Text style={styles.buildingText} numberOfLines={1}>{classLocationLabel(c)}</Text>
                  </View>

                  {muted && (
                    <View style={styles.mutedRow}>
                      <BellOff size={12} color={theme.colors.textMuted} strokeWidth={2.2} />
                      <Text style={styles.notifMutedLabel}>Notifications muted</Text>
                    </View>
                  )}
                  {route != null && status != null && (
                    <View style={[styles.leavePill, { backgroundColor: status.soft }]}>
                      <Clock size={13} color={status.main} strokeWidth={2.4} />
                      <Text style={[styles.leavePillText, { color: status.main }]}>
                        Leave by {getLeaveByTime(c.start_time_local, route.bestDepartInMinutes)}
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            </Animated.View>
          );
        }}
    />
    </LayoutAnimationConfig>

      {/* FAB — add class */}
      <View style={styles.fabWrap} pointerEvents="box-none">
        <PressableScale
          scaleTo={0.9}
          style={styles.fab}
          onPress={() => setShowForm(true)}
          accessibilityLabel="Add class"
          accessibilityRole="button"
        >
          <LinearGradient
            colors={[theme.gradients.sunset[0], theme.gradients.sunset[1]]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          <Plus size={26} color={theme.colors.surface} strokeWidth={2.4} />
        </PressableScale>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screenWrapper: { flex: 1, backgroundColor: theme.colors.surfaceAlt },
  loadingWrap: {
    flex: 1,
    backgroundColor: theme.colors.surfaceAlt,
    padding: theme.layout.gutter,
    gap: theme.layout.cardGap,
  },
  list: { flex: 1 },
  container: { padding: theme.layout.gutter, paddingBottom: 100 },

  // FAB
  fabWrap: { position: "absolute", bottom: 24, right: 20 },
  fab: {
    width: 58,
    height: 58,
    borderRadius: theme.radius.pill,
    overflow: "hidden",
    backgroundColor: theme.colors.ctaEnd,
    alignItems: "center",
    justifyContent: "center",
    ...theme.elevation[3],
  },

  // Modal
  modalRoot: {
    flex: 1,
    backgroundColor: theme.colors.surfaceAlt,
    borderTopLeftRadius: theme.radius.xxl,
    borderTopRightRadius: theme.radius.xxl,
    overflow: "hidden",
  },
  modalContainer: { padding: theme.layout.gutter, paddingBottom: 40 },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  modalTitle: { ...theme.text.title2, color: theme.colors.navy },
  modalCancelBtn: { width: 60, minHeight: theme.layout.tapMin, justifyContent: "center" },
  modalHeaderSpacer: { width: 60 },
  modalCancel: { ...theme.text.subhead, fontSize: 16, color: theme.colors.brandInk },
  formCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    marginBottom: theme.layout.gutter,
    padding: 18,
    ...theme.elevation[2],
  },
  sectionEyebrow: { ...theme.text.eyebrow, color: theme.colors.textMuted },
  sectionDivider: {
    height: 1,
    backgroundColor: theme.colors.borderSoft,
    marginTop: theme.spacing.lg,
    marginBottom: theme.spacing.lg,
  },
  label: { ...theme.text.subhead, fontSize: 14, color: theme.colors.text, marginTop: theme.spacing.md, marginBottom: theme.spacing.sm },
  input: {
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.borderSoft,
    borderRadius: theme.radius.lg,
    minHeight: 48,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontSize: 16,
    color: theme.colors.text,
    fontFamily: "DMSans_400Regular",
  },

  // Time fields — departure-board digits
  timeRow: { flexDirection: "row", gap: theme.layout.cardGap },
  timeCol: { flex: 1 },
  timeInput: {
    fontFamily: "DMSans_600SemiBold",
    fontVariant: ["tabular-nums"],
    fontSize: 17,
    letterSpacing: 0.5,
    textAlign: "center",
  },

  // Modal day selector chips — springy multi-select pills
  dayRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.sm, marginTop: theme.spacing.xs },
  dayBtn: {
    minWidth: theme.layout.tapMin,
    height: theme.layout.tapMin,
    paddingHorizontal: 10,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.orangeSoft,
    justifyContent: "center",
    alignItems: "center",
  },
  dayBtnOn: { backgroundColor: theme.colors.ctaEnd, ...theme.shadows.glowOrange, shadowOpacity: 0.25 },
  dayText: { ...theme.text.badge, fontSize: 13, color: theme.colors.brandInk },
  dayTextOn: { color: theme.colors.surface },

  locationSpinner: { marginTop: theme.spacing.sm, alignSelf: "flex-start" },
  locationError: { ...theme.text.body, fontSize: 14, color: theme.colors.errorDeep, marginTop: theme.spacing.sm },
  locationConfirmed: { ...theme.text.subhead, fontSize: 14, color: theme.colors.successDeep, marginTop: theme.spacing.md },
  suggestionList: {
    borderWidth: 1,
    borderColor: theme.colors.borderSoft,
    borderRadius: theme.radius.lg,
    marginTop: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
    overflow: "hidden",
    ...theme.elevation[1],
  },
  suggestionItem: {
    minHeight: theme.layout.tapMin,
    justifyContent: "center",
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  suggestionSep: { borderBottomWidth: 1, borderBottomColor: theme.colors.borderSoft },
  suggestionName: { ...theme.text.subhead, color: theme.colors.text },
  suggestionSub: { ...theme.text.caption, color: theme.colors.textSecondary, marginTop: 2 },

  // Submit CTA — white label rides the gradient's darker ctaEnd stop
  submitBtn: {
    borderRadius: theme.radius.lg,
    overflow: "hidden",
    marginTop: theme.spacing.xl,
    minHeight: 52,
    ...theme.shadows.glowOrange,
  },
  submitGradient: { minHeight: 52, paddingVertical: 14, alignItems: "center", justifyContent: "center" },
  submitDisabled: { opacity: 0.6 },
  submitText: { color: theme.colors.surface, fontFamily: "DMSans_700Bold", fontSize: 16, letterSpacing: 0.2 },

  // Editing banner
  editingBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.sm,
    backgroundColor: theme.colors.navy,
    borderRadius: theme.radius.lg,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: theme.spacing.md,
  },
  editingBannerText: { ...theme.text.subhead, fontSize: 14, color: theme.colors.textOnNavy, flex: 1 },

  // View toggle pills
  viewToggleRow: { flexDirection: "row", gap: theme.spacing.sm, marginBottom: theme.layout.cardGap },
  viewToggleBtn: {
    minHeight: theme.layout.tapMin,
    paddingHorizontal: 22,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  viewToggleBtnActive: {
    backgroundColor: theme.colors.navy,
    borderColor: theme.colors.navy,
    ...theme.elevation[1],
  },
  viewToggleText: { ...theme.text.subhead, fontSize: 14, color: theme.colors.textSecondary },
  viewToggleTextActive: { color: theme.colors.surface },

  // Week grid — 7 equal cells, today gets the orange accent + label
  weekGrid: { flexDirection: "row", gap: 6, marginBottom: theme.layout.cardGap },
  weekCell: { flex: 1 },
  weekDayBtn: {
    minHeight: 56,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.borderSoft,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing.sm,
    gap: 2,
  },
  weekDayBtnToday: { borderColor: theme.colors.orange, borderWidth: 2 },
  weekDayBtnActive: {
    backgroundColor: theme.colors.navy,
    borderColor: theme.colors.navy,
    ...theme.elevation[1],
  },
  weekDayText: { ...theme.text.subhead, fontSize: 13, color: theme.colors.textSecondary },
  weekDayTextActive: { color: theme.colors.surface },
  weekTodayLabel: { ...theme.text.eyebrow, fontSize: 9, lineHeight: 11, letterSpacing: 0.8, color: theme.colors.brandInk },
  weekTodayLabelActive: { color: theme.colors.gold },

  listTitle: { ...theme.text.title2, color: theme.colors.navy, marginTop: theme.spacing.sm, marginBottom: theme.layout.cardGap },
  emptyCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    ...theme.elevation[1],
  },

  // Class cards
  card: {
    flexDirection: "row",
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    padding: 14,
    marginBottom: theme.layout.cardGap,
    ...theme.elevation[2],
  },
  cardAccent: { width: 4, borderRadius: theme.radius.pill, alignSelf: "stretch" },
  cardBody: { flex: 1, marginLeft: theme.layout.cardGap },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  classTitle: { ...theme.text.heading, fontFamily: "DMSans_700Bold", color: theme.colors.text, flex: 1, marginRight: theme.spacing.sm },
  cardActions: { flexDirection: "row", alignItems: "center" },
  iconBtn: {
    // 44pt square: `Press` enforces the height floor, and the width has to keep
    // up or the target is only 40pt wide.
    width: theme.layout.tapMin,
    height: theme.layout.tapMin,
    borderRadius: theme.radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },

  // Day-of-week pills on each card
  dayPillRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: theme.spacing.sm },
  dayPillStatic: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.surfaceAlt,
  },
  dayPillStaticToday: { backgroundColor: theme.colors.orangeSoft },
  dayPillStaticText: { ...theme.text.badge, fontSize: 11, color: theme.colors.textSecondary },
  dayPillStaticTextToday: { color: theme.colors.brandInk },

  timeRange: { ...theme.text.numeric, color: theme.colors.text, marginTop: theme.spacing.sm },
  buildingRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: theme.spacing.xs },
  buildingText: { ...theme.text.caption, color: theme.colors.textMuted, flex: 1 },
  mutedRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: theme.spacing.sm },
  notifMutedLabel: { ...theme.text.caption, fontSize: 12, color: theme.colors.textMuted, fontStyle: "italic" },

  // "Leave by" status pill — glyph + text, deep color on soft tint (AA)
  leavePill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    marginTop: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: theme.radius.pill,
  },
  leavePillText: { ...theme.text.badge, fontSize: 13, fontVariant: ["tabular-nums"] },

  planWeekBtn: {
    marginTop: theme.spacing.lg,
    minHeight: theme.layout.tapMin,
    paddingVertical: 12,
    paddingHorizontal: theme.layout.gutter,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.orangeSoft,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
  },
  planWeekBtnText: { ...theme.text.subhead, color: theme.colors.brandInk },

  successToast: {
    backgroundColor: theme.colors.successDeep,
    borderRadius: theme.radius.lg,
    padding: 12,
    marginBottom: theme.layout.cardGap,
    alignItems: "center",
    ...theme.elevation[1],
  },
  successToastText: { ...theme.text.subhead, fontSize: 14, color: theme.colors.surface },
});
