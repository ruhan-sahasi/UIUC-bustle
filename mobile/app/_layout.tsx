import "react-native-reanimated"; // must be first — initializes worklets runtime
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { NotificationRedirect } from "@/src/components/NotificationRedirect";
import "@/src/tasks/notificationRefresh"; // registers defineTask at module level
import { registerNotificationRefreshTask } from "@/src/tasks/notificationRefresh";
import { AUTO_WALK_TASK_NAME } from '@/src/utils/autoWalkDetect';
import { refreshWidgetData } from '@/src/tasks/widgetRefresh';
import { completeAuthFromUrl } from "@/src/auth/authCallback";
import { supabase } from "@/src/auth/supabaseClient";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import * as ExpoLinking from 'expo-linking';
import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_600SemiBold,
  DMSans_700Bold,
} from "@expo-google-fonts/dm-sans";
import { DMSerifDisplay_400Regular } from "@expo-google-fonts/dm-serif-display";
import { useFonts } from "expo-font";
import { Redirect, Stack, useSegments } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAuth } from "@/src/auth/useAuth";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import * as TaskManager from 'expo-task-manager';
import { useEffect } from "react";
import * as Sentry from "@sentry/react-native";
import { PostHogProvider, usePostHog } from "posthog-react-native";
import { theme } from "@/src/constants/theme";
import { scrubBreadcrumb } from "@/src/telemetry/sentryScrub";

// Sentry — init before anything else; no-ops silently when DSN is absent
if (process.env.NODE_ENV !== "test" && process.env.EXPO_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.1,
    // Strip query strings (GPS coords) and share tokens from http breadcrumb URLs
    beforeBreadcrumb: scrubBreadcrumb,
  });
}

TaskManager.defineTask(AUTO_WALK_TASK_NAME, async ({ data, error }: any) => {
  if (error || !data?.locations?.length) return;
  const locations: any[] = data.locations;

  // Simple heuristic: if speed in walk range for 2+ consecutive updates → save pending walk
  const walkLocations = locations.filter(
    (l) => l.coords.speed != null && l.coords.speed >= 0.9 && l.coords.speed <= 2.5
  );

  if (walkLocations.length >= 2) {
    const first = walkLocations[0];
    const last = walkLocations[walkLocations.length - 1];
    const durationS = (last.timestamp - first.timestamp) / 1000;
    if (durationS >= 120) {
      // Estimate distance from speed * time
      const distanceM = walkLocations.reduce((acc, l, i) => {
        if (i === 0) return acc;
        return acc + (l.coords.speed ?? 1.2) * ((l.timestamp - walkLocations[i - 1].timestamp) / 1000);
      }, 0);

      const pending = {
        startEpochMs: first.timestamp,
        endEpochMs: last.timestamp,
        distanceM,
        stepCount: Math.round(distanceM / 0.75),
        detectedAt: Date.now(),
      };
      await AsyncStorage.setItem('@uiuc_bus_pending_auto_walk', JSON.stringify(pending));
    }
  }
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 300_000,
      retry: 1,
    },
  },
});

SplashScreen.preventAutoHideAsync();

/** Identifies the user in both Sentry and PostHog once auth is established. */
function AnalyticsIdentifier({ userId }: { userId: string | undefined }) {
  const posthog = usePostHog();
  useEffect(() => {
    if (userId) {
      posthog?.identify(userId);
      if (process.env.EXPO_PUBLIC_SENTRY_DSN) {
        Sentry.setUser({ id: userId });
      }
    }
  }, [posthog, userId]);
  return null;
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    DMSerifDisplay_400Regular,
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_600SemiBold,
    DMSans_700Bold,
  });

  const { session, user, loading: authLoading } = useAuth();
  const segments = useSegments();

  useEffect(() => {
    registerNotificationRefreshTask();
    // Write widget data on mount and every time app comes to foreground
    refreshWidgetData();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshWidgetData();
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (fontsLoaded && !authLoading) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, authLoading]);

  useEffect(() => {
    // Handle deep links (magic link / OAuth callback)
    const handleUrl = async ({ url }: { url: string }) => {
      if (url.includes('auth/callback')) {
        const error = await completeAuthFromUrl(url);
        if (error) console.warn('Auth link exchange error:', error);
      }
    };

    // Handle the case where the app was opened from a cold start via the link
    ExpoLinking.getInitialURL().then((url) => {
      if (url) handleUrl({ url });
    });

    // Handle the case where the app was already open (foreground)
    const sub = ExpoLinking.addEventListener('url', handleUrl);
    return () => sub.remove();
  }, []);

  if (!fontsLoaded || authLoading) {
    return null; // SplashScreen still showing
  }
  if (!session && segments[0] !== "sign-in") {
    return <Redirect href="/sign-in" />;
  }
  if (session && segments[0] === "sign-in") {
    return <Redirect href="/" />;
  }

  const posthogKey = process.env.EXPO_PUBLIC_POSTHOG_API_KEY;

  return (
    <QueryClientProvider client={queryClient}>
      <PostHogProvider
        apiKey={posthogKey || "placeholder"}
        options={{
          host: "https://us.i.posthog.com",
          disabled: !posthogKey || process.env.NODE_ENV === "test",
        }}
        autocapture={false}
      >
        <AnalyticsIdentifier userId={user?.id} />
        <GestureHandlerRootView style={{ flex: 1 }}>
          <StatusBar style="light" />
          <NotificationRedirect />
          <Stack
            screenOptions={{
              // NOTE: `animationDuration` is deliberately NOT set here. Verified in
              // node_modules: RNScreens maps "slide_from_right" -> RNSScreenStackAnimationDefault
              // on iOS (RNSConvert.mm), and +[RNSScreenStackAnimator isCustomAnimation:] returns NO
              // for Default, so no custom animator is installed and transitionDuration is never read.
              // On Android `transitionDuration` is not a Screen prop at all. A duration set here
              // would be inert on both platforms — do not build timed choreography off one.
              animation: "slide_from_right",
              headerShown: false,
              headerStyle: { backgroundColor: theme.colors.navy },
              headerShadowVisible: false,
              headerTintColor: theme.colors.surface,
              headerTitleStyle: { fontFamily: "DMSerifDisplay_400Regular", fontSize: 20, color: theme.colors.surface },
            }}
          >
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="sign-in" options={{ headerShown: false }} />
            <Stack.Screen name="trip" options={{ headerShown: true, title: "Trip", headerBackTitle: "Back" }} />
            <Stack.Screen name="report-issue" options={{ headerShown: true, title: "Report issue", headerBackTitle: "Back" }} />
            <Stack.Screen name="walk-nav" options={{ animation: "default", headerShown: true, title: "Walking Navigation", headerBackTitle: "Back", presentation: "fullScreenModal" }} />
            <Stack.Screen name="after-class-planner" options={{ animation: "default", headerShown: true, title: "Plan my evening", headerBackTitle: "Back", presentation: "modal" }} />
            <Stack.Screen name="route-tracker" options={{ headerShown: true, title: "Route", headerBackTitle: "Back" }} />
          </Stack>
        </GestureHandlerRootView>
      </PostHogProvider>
    </QueryClientProvider>
  );
}
