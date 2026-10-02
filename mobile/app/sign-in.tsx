import { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import * as ExpoLinking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { LinearGradient } from "expo-linear-gradient";
import { BlurView } from "expo-blur";
import { AlertCircle, Bus, MailCheck, Send } from "lucide-react-native";
import { completeAuthFromUrl } from "@/src/auth/authCallback";
import { supabase } from "@/src/auth/supabaseClient";
import { theme } from "@/src/constants/theme";
import {
  FadeInView,
  FloatingView,
  PressableScale,
  RouteProgress,
  Stagger,
  TickingCountdown,
  type RoutePoint,
} from "@/src/components/ui/motion";
import { STAGGER } from "@/src/constants/motion";
import { Badge } from "@/src/components/ui/Badge";
import { Button } from "@/src/components/ui/Button";

WebBrowser.maybeCompleteAuthSession();

// In Expo Go this resolves to exp://<host>/--/auth/callback (custom schemes don't
// work there); in a dev/standalone build it resolves to uiuc-bus://auth/callback.
const REDIRECT_URI = ExpoLinking.createURL("auth/callback");

// ── Decorative route scene ────────────────────────────────────────────────
// Stays on RouteProgress rather than moving to Charts' RouteRibbon: the hero
// shape is an open polyline that has to DRAW ITSELF once on mount and then
// loop a bus dot along its own arc-length. RouteRibbon is a width-varying
// filled band sized to a container, with no self-drawing pass and no dot to
// travel the path, so the hero's whole reason for existing would be lost in
// the swap. (It is also not in the tree yet — see the note in the PR summary.)
//
// Mirrors RouteProgress's internal padding (max(strokeWidth, dotRadius) + 2)
// so the stop-dot overlays land exactly on the polyline vertices.
const ROUTE_STROKE = 3;
const BUS_DOT_RADIUS = 5;
const ROUTE_PAD = Math.max(ROUTE_STROKE, BUS_DOT_RADIUS) + 2;
const STOP_DOT = 10;
/** Head start before the stop dots land, so the line is visibly drawing first. */
const ROUTE_DRAW_LEAD_MS = 200;

/** A route line that draws itself across the hero while a bus dot loops it. */
function RouteScene() {
  const { width } = useWindowDimensions();
  // Screen padding is 24 per side; keep the SVG (line + internal pad) inside it.
  const w = Math.max(width - 48 - ROUTE_PAD * 2, 240);
  const points = useMemo<RoutePoint[]>(
    () => [
      { x: 0, y: 46 },
      { x: w * 0.32, y: 10 },
      { x: w * 0.64, y: 52 },
      { x: w, y: 18 },
    ],
    [w]
  );
  return (
    <View
      style={styles.routeScene}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <RouteProgress
        points={points}
        color={theme.colors.orange}
        strokeWidth={ROUTE_STROKE}
        duration={5200}
        loop
        showDot
        dotColor={theme.colors.orangeBright}
        dotRadius={BUS_DOT_RADIUS}
        trackColor="rgba(255,255,255,0.14)"
      />
      {/*
        Absolutely positioned overlays, so these cannot go through <Stagger>
        (it wraps each child in a layout box of its own, which would collapse
        the left/top coordinates). They keep hand-held delays, but the delays
        now come off the shared STAGGER token and are capped like every other
        list in the app instead of running away at index * 170.
      */}
      {points.map((pt, i) => (
        <FadeInView
          key={i}
          delay={ROUTE_DRAW_LEAD_MS + Math.min(i, STAGGER.cap) * STAGGER.step}
          dy={6}
          style={[
            styles.stopDot,
            { left: pt.x + ROUTE_PAD - STOP_DOT / 2, top: pt.y + ROUTE_PAD - STOP_DOT / 2 },
          ]}
        />
      ))}
    </View>
  );
}

// ── Decorative departure-board vignette ───────────────────────────────────

const DEMO_DEPARTURES = [
  { route: "22", name: "Illini", pillColor: theme.colors.orange, pillText: theme.colors.surface, offsetMs: 74_000 },
  { route: "120", name: "Teal", pillColor: theme.colors.sky, pillText: theme.colors.navyDeep, offsetMs: 4 * 60_000 + 20_000 },
  { route: "13", name: "Silver", pillColor: theme.colors.violet, pillText: theme.colors.surface, offsetMs: 9 * 60_000 },
] as const;

/**
 * Three fake-but-plausible departures ticking on the shared countdown
 * heartbeat, framed like terminal glass. Purely decorative: hidden from
 * accessibility and untouchable.
 */
function DepartureVignette() {
  // Anchor targets on mount, then reseed whenever the soonest row runs out —
  // a decorative board stuck on three "Now"s reads as broken, not live.
  const [targets, setTargets] = useState(() => DEMO_DEPARTURES.map((d) => Date.now() + d.offsetMs));
  useEffect(() => {
    const soonest = Math.min(...targets);
    const t = setTimeout(
      () => setTargets(DEMO_DEPARTURES.map((d) => Date.now() + d.offsetMs)),
      Math.max(soonest - Date.now(), 0) + 12_000,
    );
    return () => clearTimeout(t);
  }, [targets]);
  return (
    <View
      style={styles.boardFrame}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <BlurView intensity={26} tint="dark" style={styles.boardBlur}>
        <View style={styles.boardHeader}>
          <Text style={styles.boardEyebrow}>Departures</Text>
          <Badge label="Live" variant="live" size="sm" />
        </View>
        {DEMO_DEPARTURES.map((d, i) => (
          <View key={d.route} style={[styles.boardRow, i > 0 && styles.boardRowDivider]}>
            <View style={[styles.routePill, { backgroundColor: d.pillColor }]}>
              <Text style={[styles.routePillText, { color: d.pillText }]}>{d.route}</Text>
            </View>
            <Text style={styles.boardRouteName} numberOfLines={1}>
              {d.name}
            </Text>
            <TickingCountdown targetMs={targets[i]} style={styles.boardCountdown} />
          </View>
        ))}
      </BlurView>
    </View>
  );
}

// ── Status card (styled success / error) ──────────────────────────────────

function StatusCard({ kind, title, body }: { kind: "success" | "error"; title: string; body?: string | null }) {
  const success = kind === "success";
  const Icon = success ? MailCheck : AlertCircle;
  const tone = success ? theme.colors.successDeep : theme.colors.errorDeep;
  return (
    <FadeInView dy={8}>
      <View
        accessible
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        style={[
          styles.statusCard,
          { backgroundColor: success ? theme.colors.successSoft : theme.colors.errorSoft },
        ]}
      >
        <Icon size={18} color={tone} strokeWidth={2.4} />
        <View style={styles.statusTextCol}>
          <Text style={[styles.statusTitle, { color: tone }]}>{title}</Text>
          {body ? <Text style={styles.statusBody}>{body}</Text> : null}
        </View>
      </View>
    </FadeInView>
  );
}

export default function SignInScreen() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGoogleSignIn() {
    setLoading(true);
    setError(null);
    // try/finally: openAuthSessionAsync rejects if another auth session is
    // already open, and without the finally the buttons stayed disabled.
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: REDIRECT_URI },
      });
      if (error) {
        setError(error.message);
        return;
      }
      if (data.url) {
        const result = await WebBrowser.openAuthSessionAsync(data.url, REDIRECT_URI);
        if (result.type === "success" && result.url) {
          // Supabase v2 PKCE flow: exchange the auth code for a session
          const exchangeError = await completeAuthFromUrl(result.url);
          if (exchangeError) setError(exchangeError);
          // onAuthStateChange in useAuth will pick up the new session automatically
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start Google sign-in. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleMagicLink() {
    if (!email.trim()) {
      setError("Enter your email address.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: REDIRECT_URI },
      });
      if (error) {
        setError(error.message);
      } else {
        setMagicLinkSent(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send the sign-in link. Check your connection.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={[theme.gradients.hero[0], theme.gradients.hero[1], theme.gradients.hero[2]]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />

      {/* Drifting parallax blobs — soft depth behind the glass board */}
      <FloatingView distance={14} duration={4600} style={[styles.blob, styles.blobOrange]} />
      <FloatingView distance={18} duration={5600} delay={600} style={[styles.blob, styles.blobSky]} />
      <FloatingView distance={10} duration={3800} delay={1100} style={[styles.blob, styles.blobWhite]} />

      <View style={styles.content}>
        {/*
          One Stagger replaces the hand-tuned 0/140/260/380/500/580/660 ladder.
          Two things change on purpose: the whole sequence now lands in ~270ms
          instead of ~660ms (STAGGER.step 45, capped at STAGGER.cap), and it
          becomes the same entrance every other list in the app uses.

          The status cards below are deliberately NOT children here. Stagger
          keys its children off React.Children.toArray, so a conditional child
          appearing would renumber the keys after it and re-run the entrance on
          rows that were already on screen. StatusCard brings its own FadeInView
          anyway, which is the correct motion for something that arrives late.
        */}
        <Stagger step={STAGGER.step} cap={STAGGER.cap}>
          <RouteScene />

          <View style={styles.brandBlock}>
            <View style={styles.eyebrowRow}>
              <Bus size={14} color={theme.colors.orangeBright} strokeWidth={2.4} />
              <Text style={styles.eyebrow}>Campus transit, live</Text>
            </View>
            <Text style={styles.title} accessibilityRole="header">
              UIUC Bustle
            </Text>
          </View>

          <Text style={styles.tagline}>Never miss the bus to class again.</Text>

          <DepartureVignette />

          <Button
            label="Continue with Google"
            onPress={handleGoogleSignIn}
            loading={loading}
            disabled={loading}
          />

          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.divider}>or</Text>
            <View style={styles.dividerLine} />
          </View>

          <View>
            <TextInput
              style={styles.input}
              placeholder="Email address"
              placeholderTextColor={theme.colors.textOnNavyMuted}
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              editable={!loading}
              accessibilityLabel="Email address"
            />
            <PressableScale
              onPress={handleMagicLink}
              disabled={loading}
              style={[styles.magicButton, loading && styles.magicButtonDisabled]}
              accessibilityRole="button"
              accessibilityLabel="Send magic link"
              accessibilityState={{ disabled: loading }}
            >
              <Send size={16} color={theme.colors.textOnNavy} strokeWidth={2.2} />
              <Text style={styles.magicButtonText}>Send magic link</Text>
            </PressableScale>
          </View>
        </Stagger>

        {magicLinkSent && (
          <StatusCard
            kind="success"
            title="Magic link sent"
            body="Check your email for a one-tap sign-in link."
          />
        )}
        {error && <StatusCard kind="error" title="Couldn't sign you in" body={error} />}
      </View>

      <FadeInView delay={760} style={styles.privacyWrap}>
        {/*
          NOTE(store-submission): a real, hosted Privacy Policy URL must exist
          and be linked here before App Store review. The previous placeholder
          (https://your-privacy-policy-url.com) was a dead link, so it was
          removed rather than shipped.
        */}
        <Text style={styles.privacyText}>By signing in you agree to the Privacy Policy.</Text>
      </FadeInView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    backgroundColor: theme.colors.navyDeep,
  },
  blob: {
    position: "absolute",
  },
  blobOrange: {
    width: 320,
    height: 320,
    borderRadius: 160,
    backgroundColor: "rgba(232,74,39,0.10)",
    top: -90,
    right: -110,
  },
  blobSky: {
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: "rgba(56,189,248,0.07)",
    bottom: 70,
    left: -120,
  },
  blobWhite: {
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: "rgba(255,255,255,0.04)",
    top: "30%",
    right: -60,
  },
  content: {
    width: "100%",
  },
  routeScene: {
    alignSelf: "stretch",
    marginBottom: 18,
  },
  stopDot: {
    position: "absolute",
    width: STOP_DOT,
    height: STOP_DOT,
    borderRadius: STOP_DOT / 2,
    backgroundColor: theme.colors.surface,
    borderWidth: 2,
    borderColor: theme.colors.orange,
  },
  brandBlock: {
    alignItems: "center",
  },
  eyebrowRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 10,
  },
  eyebrow: {
    ...theme.text.eyebrow,
    color: theme.colors.textOnNavyMuted,
  },
  title: {
    fontFamily: "DMSerifDisplay_400Regular",
    fontSize: 44,
    lineHeight: 52,
    color: theme.colors.surface,
    textAlign: "center",
  },
  tagline: {
    fontFamily: "DMSerifDisplay_400Regular",
    fontSize: 17,
    lineHeight: 24,
    color: theme.colors.textOnNavyMuted,
    textAlign: "center",
    marginTop: 6,
    marginBottom: 24,
  },
  boardFrame: {
    borderRadius: theme.radius.xl,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.16)",
    marginBottom: 24,
  },
  boardBlur: {
    backgroundColor: "rgba(255,255,255,0.06)",
    paddingBottom: 4,
  },
  boardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 6,
  },
  boardEyebrow: {
    ...theme.text.eyebrow,
    color: theme.colors.textOnNavyMuted,
  },
  boardRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  boardRowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.14)",
  },
  routePill: {
    minWidth: 36,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: theme.radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  routePillText: {
    fontFamily: "DMSans_700Bold",
    fontSize: 12,
    letterSpacing: 0.3,
    fontVariant: ["tabular-nums"],
  },
  boardRouteName: {
    ...theme.text.subhead,
    color: theme.colors.textOnNavy,
    flex: 1,
  },
  boardCountdown: {
    ...theme.text.numeric,
    fontSize: 17,
    lineHeight: 22,
    color: theme.colors.gold,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 18,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(255,255,255,0.22)",
  },
  divider: {
    ...theme.text.caption,
    color: theme.colors.textOnNavyMuted,
    marginHorizontal: 12,
  },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.20)",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: theme.radius.lg,
    paddingVertical: 13,
    paddingHorizontal: 16,
    color: theme.colors.surface,
    fontFamily: "DMSans_400Regular",
    fontSize: 15,
    marginBottom: 12,
  },
  magicButton: {
    minHeight: theme.layout.tapMin,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.32)",
    borderRadius: theme.radius.lg,
    paddingHorizontal: 16,
  },
  magicButtonDisabled: {
    opacity: 0.5,
  },
  magicButtonText: {
    ...theme.text.subhead,
    fontSize: 16,
    color: theme.colors.textOnNavy,
  },
  statusCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    borderRadius: theme.radius.lg,
    padding: 14,
    marginTop: 16,
  },
  statusTextCol: {
    flex: 1,
    gap: 2,
  },
  statusTitle: {
    ...theme.text.subhead,
  },
  statusBody: {
    ...theme.text.caption,
    color: theme.colors.textSecondary,
  },
  privacyWrap: {
    position: "absolute",
    bottom: 36,
    left: 24,
    right: 24,
    alignItems: "center",
  },
  privacyText: {
    ...theme.text.caption,
    fontSize: 12,
    color: theme.colors.textOnNavyMuted,
    textAlign: "center",
  },
});
