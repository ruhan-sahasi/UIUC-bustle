import { fetchBuildings, fetchClasses, fetchHealth } from "@/src/api/client";
import { resetAllPatterns } from "@/src/utils/patternEngine";
import { theme } from "@/src/constants/theme";
import { WALKING_MODES } from "@/src/constants/walkingMode";
import { Button } from "@/src/components/ui/Button";
import { SectionHeader } from "@/src/components/ui/SectionHeader";
import { AnimatedNumber, FadeInView, PressableScale, useReducedMotion } from "@/src/components/ui/motion";
import { useAuth } from "@/src/auth/useAuth";
import { useApiBaseUrl } from "@/src/hooks/useApiBaseUrl";
import { useClassNotificationsEnabled } from "@/src/hooks/useClassNotificationsEnabled";
import { useRecommendationSettings } from "@/src/hooks/useRecommendationSettings";
import {
  cancelAllClassReminders,
  requestNotificationPermission,
  scheduleClassReminders,
  sendTestNotification,
} from "@/src/notifications/classReminders";
import { isAllowedApiOrigin } from "@/src/storage/apiUrl";
import { MAX_BUFFER, MAX_WEIGHT_KG, MIN_BUFFER, MIN_WEIGHT_KG } from "@/src/storage/recommendationSettings";
import Constants from "expo-constants";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import {
  Accessibility,
  Bell,
  BellRing,
  Bug,
  ClipboardList,
  CloudRain,
  Footprints,
  Info,
  KeyRound,
  LayoutGrid,
  LogOut,
  Mail,
  Minus,
  Plus,
  RotateCcw,
  Server,
  ShieldCheck,
  Timer,
  Weight,
  type LucideIcon,
} from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import Animated, {
  ReduceMotion,
  ReducedMotionConfig,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

const WIDGET_STEPS = [
  "Long-press your iPhone home screen until icons jiggle",
  "Tap the + button in the top-left corner",
  'Search for "UIUC Bus" and choose a size (small, medium, or large)',
];

const KG_TO_LBS = 2.20462;

export default function SettingsScreen() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const { apiBaseUrl, setApiBaseUrl, apiKey, setApiKey } = useApiBaseUrl();
  const { enabled: classNotificationsEnabled, setEnabled: setClassNotificationsEnabled } =
    useClassNotificationsEnabled();
  const {
    walkingModeId,
    bufferMinutes,
    weightKg,
    rainMode,
    setWalkingModeId,
    setBufferMinutes,
    setWeightKg,
    setRainMode,
  } = useRecommendationSettings();
  const [input, setInput] = useState(apiBaseUrl);
  const [apiKeyInput, setApiKeyInput] = useState(apiKey ?? "");
  const [saving, setSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [notificationsToggling, setNotificationsToggling] = useState(false);
  const [bufferSlider, setBufferSlider] = useState(bufferMinutes);
  const [weightSlider, setWeightSlider] = useState(weightKg);
  // Developer-only motion override. Deliberately NOT persisted: a debug switch
  // that survives a restart is a debug switch someone forgets is on.
  const [forceReducedMotion, setForceReducedMotion] = useState(false);

  // Keep input in sync when stored URL loads or changes
  useEffect(() => {
    setInput(apiBaseUrl);
  }, [apiBaseUrl]);
  useEffect(() => {
    setApiKeyInput(apiKey ?? "");
  }, [apiKey]);

  useEffect(() => {
    setBufferSlider(bufferMinutes);
  }, [bufferMinutes]);

  useEffect(() => {
    setWeightSlider(weightKg);
  }, [weightKg]);

  const onClassNotificationsToggle = useCallback(
    async (value: boolean) => {
      setNotificationsToggling(true);
      try {
        if (value) {
          const granted = await requestNotificationPermission();
          if (!granted) {
            Alert.alert(
              "Permission needed",
              "Enable notifications in your device Settings to get class reminders."
            );
            return;
          }
          let scheduleOk = true;
          try {
            const [classesRes, buildingsRes] = await Promise.all([
              fetchClasses(apiBaseUrl, { apiKey: apiKey ?? undefined }),
              fetchBuildings(apiBaseUrl, { apiKey: apiKey ?? undefined }),
            ]);
            const classes = classesRes.classes ?? [];
            const buildings = buildingsRes.buildings ?? [];
            const buildingMap: Record<string, string> = {};
            for (const b of buildings) buildingMap[b.building_id] = b.name;
            await cancelAllClassReminders();
            await scheduleClassReminders(classes, buildingMap);
          } catch (_) {
            scheduleOk = false;
            await scheduleClassReminders([]);
          }
          await setClassNotificationsEnabled(true);
          if (!scheduleOk) {
            Alert.alert(
              "Reminders enabled",
              "Schedule couldn’t be loaded. Open Home to set class reminders when you’re online."
            );
          }
        } else {
          await cancelAllClassReminders();
          await setClassNotificationsEnabled(false);
        }
      } finally {
        setNotificationsToggling(false);
      }
    },
    [apiBaseUrl, apiKey, setClassNotificationsEnabled]
  );

  const handleSignOut = useCallback(() => {
    Alert.alert(
      "Sign out",
      "Are you sure you want to sign out?",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Sign out", style: "destructive", onPress: () => signOut() },
      ]
    );
  }, [signOut]);

  // Shared allowlist, not just "any http(s) URL": the network layer attaches the
  // session token and API key to whatever base URL is stored, so accepting an
  // arbitrary host here would hand both to it.
  const isValidApiUrl = useCallback((value: string) => {
    const url = value.trim().replace(/\/$/, "");
    if (!url) return false;
    return isAllowedApiOrigin(url);
  }, []);

  const save = useCallback(async () => {
    const url = input.trim().replace(/\/$/, "");
    if (!isValidApiUrl(input)) {
      Alert.alert("Invalid URL", "Enter an allowed API base URL (e.g. http://localhost:8000 or the production server).");
      return;
    }
    setSaving(true);
    try {
      // Key first: if the URL write throws, we must not end up with the old
      // key paired against a half-applied connection config.
      await setApiKey(apiKeyInput.trim() || null);
      await setApiBaseUrl(url);
      Alert.alert("Saved", "API base URL and optional API key saved.");
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }, [input, apiKeyInput, setApiBaseUrl, setApiKey, isValidApiUrl]);

  const testConnection = useCallback(async () => {
    const url = input.trim().replace(/\/$/, "");
    if (!isValidApiUrl(input)) {
      Alert.alert("Invalid URL", "Enter a valid URL first, then tap Test connection.");
      return;
    }
    setTestingConnection(true);
    try {
      await fetchHealth(url, { apiKey: apiKeyInput.trim() || undefined });
      Alert.alert("Connection OK", "The server responded. You can save this URL.");
    } catch (e) {
      Alert.alert("Connection failed", e instanceof Error ? e.message : "Server unreachable. Check URL and that the backend is running.");
    } finally {
      setTestingConnection(false);
    }
  }, [input, isValidApiUrl]);

  // Render-only derived values for the steppers / segmented control
  const bufferValue = Math.round(bufferSlider);
  const weightKgValue = Math.round(weightSlider);
  const weightLbs = Math.round(weightSlider * KG_TO_LBS);
  const activeMode = WALKING_MODES.find((m) => m.id === walkingModeId) ?? WALKING_MODES[0];

  const adjustBuffer = (delta: number) => {
    const next = Math.min(MAX_BUFFER, Math.max(MIN_BUFFER, bufferValue + delta));
    setBufferSlider(next);
    void setBufferMinutes(next);
  };

  const adjustWeight = (delta: number) => {
    const next = Math.min(MAX_WEIGHT_KG, Math.max(MIN_WEIGHT_KG, weightKgValue + delta));
    setWeightSlider(next);
    void setWeightKg(next);
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: theme.colors.surfaceAlt }}
    >
    <ScrollView contentContainerStyle={styles.container}>
      <FadeInView delay={0}>
        <View style={styles.sectionHeaderWrap}>
          <SectionHeader title="Account" />
        </View>
        <View style={styles.sectionCard}>
          <View style={styles.accountRow}>
            <LinearGradient
              colors={[theme.gradients.sunset[0], theme.gradients.sunset[1]]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.accountAvatar}
            >
              <Text style={styles.accountAvatarText}>
                {(user?.email?.[0] ?? "?").toUpperCase()}
              </Text>
            </LinearGradient>
            <View style={{ flex: 1 }}>
              <Text style={styles.accountEmail} numberOfLines={1}>{user?.email ?? "—"}</Text>
              <Text style={styles.accountHint}>Signed in via Supabase</Text>
            </View>
          </View>
          <Button label="Sign out" variant="secondary" icon={LogOut} onPress={handleSignOut} />
        </View>
      </FadeInView>

      {__DEV__ ? (
      <FadeInView delay={70}>
        <View style={styles.sectionHeaderWrap}>
          <SectionHeader title="Connection" />
        </View>
        <View style={styles.sectionCard}>
          <View style={styles.rowHeader}>
            <SettingIcon icon={Server} />
            <Text style={styles.rowLabel}>API base URL</Text>
          </View>
          <Text style={styles.hint}>
            Use localhost for simulator; use your computer’s IP for a physical device (e.g. http://192.168.1.100:8000).
          </Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            editable={!saving}
            keyboardType="url"
            onChangeText={setInput}
            onBlur={() => setInput((v) => v.trim().replace(/\/$/, ""))}
            placeholder="http://localhost:8000"
            placeholderTextColor={theme.colors.textMuted}
            style={styles.input}
            value={input}
          />
          <View style={styles.rowHeader}>
            <SettingIcon icon={KeyRound} />
            <Text style={styles.rowLabel}>API key (optional)</Text>
          </View>
          <Text style={styles.hint}>Required only if the server has API key auth enabled. Leave blank for local dev.</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            editable={!saving}
            onChangeText={setApiKeyInput}
            placeholder="Leave blank if not required"
            placeholderTextColor={theme.colors.textMuted}
            secureTextEntry
            style={styles.input}
            value={apiKeyInput}
          />
          <View style={styles.buttonRow}>
            <View style={{ flex: 1 }}>
              <Button
                label="Test connection"
                variant="secondary"
                onPress={testConnection}
                loading={testingConnection}
                disabled={saving || testingConnection}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                label="Save"
                variant="primary"
                onPress={save}
                loading={saving}
                disabled={saving || testingConnection}
              />
            </View>
          </View>
        </View>
      </FadeInView>
      ) : null}

      <FadeInView delay={140}>
        <View style={styles.sectionHeaderWrap}>
          <SectionHeader title="Route preferences" />
        </View>
        <View style={styles.sectionCard}>
          <View style={styles.rowHeader}>
            <SettingIcon icon={Footprints} />
            <Text style={styles.rowLabel}>Walking mode</Text>
          </View>
          <Text style={styles.hint}>
            Affects route times and recommendation order. Faster = shorter walk estimates.
          </Text>
          <SegmentedControl
            options={WALKING_MODES}
            selectedId={walkingModeId}
            onSelect={(id) => setWalkingModeId(id)}
          />
          <Text style={styles.paceMeta}>{activeMode.label} pace · {activeMode.mps.toFixed(1)} m/s</Text>

          <View style={styles.dividerTop}>
            <StepperRow
              icon={Timer}
              label="Buffer"
              hint="Extra time before arrival (0–15 min). More buffer = earlier suggested departure."
              value={bufferValue}
              unit="min"
              accessibilityValueText={`Buffer ${bufferValue} minutes`}
              atMin={bufferValue <= MIN_BUFFER}
              atMax={bufferValue >= MAX_BUFFER}
              onDecrement={() => adjustBuffer(-1)}
              onIncrement={() => adjustBuffer(1)}
              decrementLabel="Decrease buffer by one minute"
              incrementLabel="Increase buffer by one minute"
            />
          </View>

          <View style={styles.dividerTop}>
            <StepperRow
              icon={Weight}
              label="Body weight"
              hint="Used to calculate calories burned during walks (88–330 lbs)."
              value={weightLbs}
              unit="lbs"
              accessibilityValueText={`Body weight ${weightLbs} pounds`}
              atMin={weightKgValue <= MIN_WEIGHT_KG}
              atMax={weightKgValue >= MAX_WEIGHT_KG}
              onDecrement={() => adjustWeight(-1)}
              onIncrement={() => adjustWeight(1)}
              decrementLabel="Decrease body weight"
              incrementLabel="Increase body weight"
              footnote="Stored on-device only. Never transmitted to any server."
            />
          </View>
        </View>
      </FadeInView>

      <FadeInView delay={210}>
        <View style={styles.sectionHeaderWrap}>
          <SectionHeader title="Notifications" />
        </View>
        <View style={styles.sectionCard}>
          <View style={styles.rowHeader}>
            <SettingIcon icon={Bell} />
            <View style={styles.rowLabelWrap}>
              <Text style={styles.rowLabel}>Class notifications</Text>
              <Text style={styles.rowStatus}>{classNotificationsEnabled ? "On" : "Off"}</Text>
            </View>
            <Switch
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel="Class notifications on or off"
              accessibilityRole="switch"
              accessibilityState={{ checked: classNotificationsEnabled, disabled: notificationsToggling }}
              disabled={notificationsToggling}
              onValueChange={onClassNotificationsToggle}
              value={classNotificationsEnabled}
              trackColor={{ false: theme.colors.border, true: theme.colors.orange }}
              thumbColor={theme.colors.surface}
            />
          </View>
          <Text style={styles.hint}>
            Remind you 20 minutes before each class today. Opens Home with route options when you tap.
          </Text>
          <Button
            label="Send test notification"
            variant="ghost"
            icon={BellRing}
            onPress={async () => {
              try {
                await sendTestNotification();
                Alert.alert("Test sent", "You should get a notification in a few seconds.");
              } catch (e) {
                Alert.alert("Failed", e instanceof Error ? e.message : "Enable notifications and try again.");
              }
            }}
          />

          <View style={styles.dividerTop}>
            <View style={styles.rowHeader}>
              <SettingIcon icon={CloudRain} />
              <View style={styles.rowLabelWrap}>
                <Text style={styles.rowLabel}>Rain mode</Text>
                <Text style={styles.rowStatus}>{rainMode ? "On — bus preferred" : "Off"}</Text>
              </View>
              <Switch
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityLabel="Rain mode on or off"
                accessibilityRole="switch"
                accessibilityState={{ checked: rainMode }}
                onValueChange={setRainMode}
                value={rainMode}
                trackColor={{ false: theme.colors.border, true: theme.colors.orange }}
                thumbColor={theme.colors.surface}
              />
            </View>
            <Text style={[styles.hint, styles.hintLast]}>
              Adds 5 min buffer and prioritises bus routes over walking when raining.
            </Text>
          </View>
        </View>
      </FadeInView>

      <FadeInView delay={280}>
        <View style={styles.sectionHeaderWrap}>
          <SectionHeader title="Privacy & data" />
        </View>
        <View style={styles.sectionCard}>
          <View style={styles.rowHeader}>
            <SettingIcon icon={ShieldCheck} />
            <Text style={styles.rowLabel}>Commute learning</Text>
          </View>
          <Text style={styles.hint}>
            The app quietly learns your walk times, stop choices, and departure habits to make suggestions more accurate. All data stays on your device and is never uploaded.
          </Text>
          <Button
            label="Reset my patterns"
            variant="destructive"
            icon={RotateCcw}
            onPress={() =>
              Alert.alert(
                "Reset patterns?",
                "This will delete all learned walk times, stop preferences, and departure habits. Suggestions will return to defaults.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Reset",
                    style: "destructive",
                    onPress: async () => {
                      await resetAllPatterns();
                      Alert.alert("Patterns reset", "All learned data has been cleared.");
                    },
                  },
                ]
              )
            }
          />
        </View>
      </FadeInView>

      <FadeInView delay={350}>
        <View style={styles.sectionHeaderWrap}>
          <SectionHeader title="Home screen widget" />
        </View>
        <View style={styles.sectionCard}>
          <View style={styles.rowHeader}>
            <SettingIcon icon={LayoutGrid} />
            <Text style={styles.rowLabel}>Add widget</Text>
          </View>
          <Text style={styles.hint}>
            The UIUC Bus widget shows your next class and departure time on your home screen or lock screen. To add it:
          </Text>
          <View style={styles.widgetSteps}>
            {WIDGET_STEPS.map((step, i) => (
              <View key={step} style={styles.widgetStepRow}>
                <View style={styles.stepCircle}>
                  <Text style={styles.stepCircleText}>{i + 1}</Text>
                </View>
                <Text style={styles.widgetStep}>{step}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.hint} numberOfLines={0}>
            The widget refreshes every 15 minutes in the background. Tap the widget to open the app.
          </Text>
          <Text style={styles.note}>
            Note: Widget requires a production build via EAS Build (not Expo Go).
          </Text>
        </View>
      </FadeInView>

      <FadeInView delay={420}>
        <View style={styles.sectionHeaderWrap}>
          <SectionHeader title="Debug" />
        </View>
        <View style={styles.sectionCard}>
          <View style={styles.rowHeader}>
            <SettingIcon icon={Bug} />
            <Text style={styles.rowLabel}>Report issue</Text>
          </View>
          <Text style={styles.hint}>Copy recent logs to paste when reporting a bug (no external service).</Text>
          <Button
            label="Copy logs & report"
            variant="secondary"
            icon={ClipboardList}
            onPress={() => router.push("/report-issue")}
          />
        </View>
      </FadeInView>

      {__DEV__ ? (
      <FadeInView delay={490}>
        <View style={styles.sectionHeaderWrap}>
          <SectionHeader title="Developer" />
        </View>
        <View style={[styles.sectionCard, styles.devCard]}>
          <Text style={styles.devTag}>DEVELOPER TOOLS — NOT FOR RELEASE BUILDS</Text>
          <View style={styles.rowHeader}>
            <SettingIcon icon={Accessibility} />
            <View style={styles.rowLabelWrap}>
              <Text style={styles.rowLabel}>Force reduced motion</Text>
              <Text style={styles.rowStatus}>
                {forceReducedMotion ? "On — animations jump to their end state" : "Off — following system setting"}
              </Text>
            </View>
            <Switch
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityLabel="Force reduced motion for testing"
              accessibilityRole="switch"
              accessibilityState={{ checked: forceReducedMotion }}
              onValueChange={setForceReducedMotion}
              value={forceReducedMotion}
              trackColor={{ false: theme.colors.border, true: theme.colors.orange }}
              thumbColor={theme.colors.surface}
            />
          </View>
          <Text style={styles.hint}>
            Overrides Reanimated app-wide so every animation lands on its final frame — for checking static
            layouts without digging through iOS Accessibility settings.
          </Text>
          <Text style={[styles.hint, styles.hintLast]}>
            Note: this drives Reanimated only. Looping indicators (live dots, shimmers, beacons) read the real
            system “Reduce Motion” switch, so flip that one to test them.
          </Text>
        </View>
      </FadeInView>
      ) : null}

      {/*
        Renders nothing — it just sets Reanimated's global reduce-motion mode
        while mounted, and restores the previous mode when unmounted (i.e. when
        the switch goes back off).
      */}
      {forceReducedMotion && <ReducedMotionConfig mode={ReduceMotion.Always} />}

      <FadeInView delay={560}>
        <View style={styles.sectionHeaderWrap}>
          <SectionHeader title="About" />
        </View>
        <View style={styles.sectionCard}>
          <View style={styles.rowHeader}>
            <SettingIcon icon={Info} />
            <Text style={[styles.rowLabel, { flex: 1 }]}>App version</Text>
            <Text style={styles.aboutValue}>{Constants.expoConfig?.version ?? "—"}</Text>
          </View>
          <View style={styles.dividerTop}>
            <Button
              label="Send feedback"
              variant="ghost"
              icon={Mail}
              onPress={() => Linking.openURL("mailto:support@uiucbus.app?subject=UIUC%20Bus%20App%20Feedback")}
            />
          </View>
        </View>
      </FadeInView>
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ── Render-only subcomponents ─────────────────────────────────────────────

/** Small tinted icon tile that leads every settings row. */
function SettingIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <View style={styles.iconTile}>
      <Icon size={17} color={theme.colors.brandInk} strokeWidth={2.2} />
    </View>
  );
}

/** Segmented control with a navy pill that springs under the active segment. */
function SegmentedControl<T extends string>({
  options,
  selectedId,
  onSelect,
}: {
  options: ReadonlyArray<{ readonly id: T; readonly label: string }>;
  selectedId: string;
  onSelect: (id: T) => void;
}) {
  const reduceMotion = useReducedMotion();
  const [rowWidth, setRowWidth] = useState(0);
  const count = options.length;
  const segmentWidth = count > 0 ? rowWidth / count : 0;
  const selectedIndex = Math.max(0, options.findIndex((o) => o.id === selectedId));
  const x = useSharedValue(0);

  useEffect(() => {
    if (segmentWidth <= 0) return;
    const target = selectedIndex * segmentWidth;
    x.value = reduceMotion ? withTiming(target, { duration: 0 }) : withSpring(target, theme.motion.springBouncy);
  }, [selectedIndex, segmentWidth, reduceMotion, x]);

  const indicatorStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));

  return (
    <View style={styles.segmentTrack}>
      <View style={styles.segmentRow} onLayout={(e) => setRowWidth(e.nativeEvent.layout.width)}>
        {segmentWidth > 0 && (
          <Animated.View style={[styles.segmentIndicator, { width: segmentWidth }, indicatorStyle]} />
        )}
        {options.map((option) => {
          const selected = option.id === selectedId;
          return (
            <View key={option.id} style={styles.segmentSlot}>
              <PressableScale
                scaleTo={0.97}
                onPress={() => onSelect(option.id)}
                style={styles.segment}
                accessibilityRole="button"
                accessibilityLabel={`Walking mode ${option.label}`}
                accessibilityState={{ selected }}
              >
                <Text style={[styles.segmentLabel, selected && styles.segmentLabelOn]} numberOfLines={1}>
                  {option.label}
                </Text>
              </PressableScale>
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** Departure-board stepper: minus / big tabular numeral / plus. */
function StepperRow({
  icon,
  label,
  hint,
  value,
  unit,
  accessibilityValueText,
  atMin,
  atMax,
  onDecrement,
  onIncrement,
  decrementLabel,
  incrementLabel,
  footnote,
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  value: number;
  unit: string;
  accessibilityValueText: string;
  atMin: boolean;
  atMax: boolean;
  onDecrement: () => void;
  onIncrement: () => void;
  decrementLabel: string;
  incrementLabel: string;
  footnote?: string;
}) {
  return (
    <View>
      <View style={styles.rowHeader}>
        <SettingIcon icon={icon} />
        <Text style={styles.rowLabel}>{label}</Text>
      </View>
      <Text style={styles.hint}>{hint}</Text>
      <View style={styles.stepperRow}>
        <PressableScale
          scaleTo={0.9}
          disabled={atMin}
          onPress={onDecrement}
          style={[styles.stepBtn, atMin && styles.stepBtnDisabled]}
          accessibilityRole="button"
          accessibilityLabel={decrementLabel}
          accessibilityState={{ disabled: atMin }}
        >
          <Minus size={20} color={atMin ? theme.colors.textMuted : theme.colors.navy} strokeWidth={2.4} />
        </PressableScale>
        <View style={styles.stepValueWrap}>
          <AnimatedNumber value={value} style={styles.stepValue} accessibilityLabel={accessibilityValueText} />
          <Text style={styles.stepUnit}>{unit}</Text>
        </View>
        <PressableScale
          scaleTo={0.9}
          disabled={atMax}
          onPress={onIncrement}
          style={[styles.stepBtn, atMax && styles.stepBtnDisabled]}
          accessibilityRole="button"
          accessibilityLabel={incrementLabel}
          accessibilityState={{ disabled: atMax }}
        >
          <Plus size={20} color={atMax ? theme.colors.textMuted : theme.colors.navy} strokeWidth={2.4} />
        </PressableScale>
      </View>
      {footnote != null && <Text style={styles.stepFootnote}>{footnote}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: theme.layout.gutter,
    paddingBottom: 48,
    backgroundColor: theme.colors.surfaceAlt,
  },
  sectionHeaderWrap: { marginBottom: 10 },
  sectionCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    padding: theme.layout.gutter,
    marginBottom: theme.layout.sectionGap,
    borderWidth: 1,
    borderColor: theme.colors.borderSoft,
    ...theme.elevation[2],
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.layout.cardGap,
    minHeight: theme.layout.tapMin,
  },
  rowLabelWrap: { flex: 1 },
  rowLabel: { ...theme.text.heading, color: theme.colors.navy },
  rowStatus: { ...theme.text.caption, color: theme.colors.textMuted, marginTop: 1 },
  iconTile: {
    width: 34,
    height: 34,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.orangeSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  hint: {
    ...theme.text.caption,
    color: theme.colors.textSecondary,
    marginTop: 2,
    marginBottom: theme.layout.cardGap,
  },
  hintLast: { marginBottom: 0 },
  // Developer section — visually fenced off so nobody mistakes it for a
  // user-facing preference.
  devCard: {
    borderColor: theme.colors.border,
    borderStyle: "dashed",
    backgroundColor: theme.colors.surfaceRaised,
  },
  devTag: {
    ...theme.text.eyebrow,
    fontSize: 10,
    color: theme.colors.textMuted,
    marginBottom: theme.spacing.sm,
  },
  note: { ...theme.text.caption, fontSize: 12, color: theme.colors.textMuted, marginTop: 4 },
  input: {
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.lg,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: theme.layout.tapMin,
    fontFamily: "DMSans_400Regular",
    fontSize: 16,
    color: theme.colors.text,
    marginBottom: theme.layout.cardGap,
  },
  buttonRow: { flexDirection: "row", gap: theme.layout.cardGap, marginTop: 4 },
  dividerTop: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderSoft,
    marginTop: theme.layout.gutter,
    paddingTop: theme.layout.gutter,
  },
  // Segmented control
  segmentTrack: {
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: theme.radius.pill,
    padding: 3,
    borderWidth: 1,
    borderColor: theme.colors.borderSoft,
  },
  segmentRow: { flexDirection: "row", position: "relative" },
  segmentIndicator: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.navy,
    ...theme.elevation[1],
  },
  segmentSlot: { flex: 1 },
  segment: {
    minHeight: theme.layout.tapMin,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  segmentLabel: { ...theme.text.badge, fontSize: 13, color: theme.colors.text },
  segmentLabelOn: { color: theme.colors.surface },
  paceMeta: {
    ...theme.text.caption,
    color: theme.colors.textMuted,
    fontVariant: ["tabular-nums" as const],
    marginTop: 8,
    textAlign: "center",
  },
  // Stepper
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.layout.cardGap,
  },
  stepBtn: {
    width: 48,
    height: 48,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  stepBtnDisabled: { opacity: 0.4 },
  stepValueWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "center",
    gap: 6,
  },
  stepValue: { ...theme.text.display, fontSize: 42, lineHeight: 48, color: theme.colors.navy },
  stepUnit: { ...theme.text.eyebrow, color: theme.colors.textMuted, paddingBottom: 9 },
  stepFootnote: {
    ...theme.text.caption,
    fontSize: 12,
    color: theme.colors.textMuted,
    textAlign: "center",
    marginTop: 8,
  },
  // Widget steps
  widgetSteps: { marginBottom: theme.layout.cardGap, marginTop: 2 },
  widgetStepRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 8 },
  stepCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: theme.colors.navy,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  stepCircleText: {
    fontSize: 12,
    fontFamily: "DMSans_700Bold",
    color: theme.colors.surface,
    fontVariant: ["tabular-nums" as const],
  },
  widgetStep: { flex: 1, ...theme.text.body, fontSize: 14, lineHeight: 20, color: theme.colors.text },
  // About
  aboutValue: { ...theme.text.numeric, color: theme.colors.textSecondary },
  // Account
  accountRow: { flexDirection: "row", alignItems: "center", gap: theme.layout.cardGap, marginBottom: theme.layout.gutter },
  accountAvatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    justifyContent: "center",
    alignItems: "center",
    ...theme.shadows.glowOrange,
  },
  accountAvatarText: { fontFamily: "DMSans_700Bold", fontSize: 19, color: theme.colors.surface },
  accountEmail: { ...theme.text.subhead, color: theme.colors.text },
  accountHint: { ...theme.text.caption, color: theme.colors.textSecondary, marginTop: 2 },
});
