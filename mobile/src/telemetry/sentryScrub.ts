/**
 * Sentry breadcrumb scrubbing. HTTP breadcrumbs (fetch/xhr) record full request
 * URLs, which for this app can carry GPS coordinates in query strings
 * (/stops/nearby?lat=..&lng=..) and share tokens in paths (/share/trips/<token>,
 * /t/<token>) — all tied to the Supabase user id via Sentry.setUser. Strip them
 * before the crumb leaves the device.
 *
 * Typed structurally so this module needs no Sentry import.
 */

interface BreadcrumbLike {
  type?: string;
  category?: string;
  data?: Record<string, unknown>;
}

const HTTP_CATEGORIES = new Set(["http", "xhr", "fetch"]);

const SHARE_TRIP_PATH = /share\/trips\/[^/?]+/g;
const SHORT_TOKEN_PATH = /\/t\/[^/?]+/g;

/** Strip the query string and redact token-bearing path segments from a URL. */
function scrubUrl(url: string): string {
  const withoutQuery = url.split("?")[0]!;
  return withoutQuery
    .replace(SHARE_TRIP_PATH, "share/trips/<redacted>")
    .replace(SHORT_TOKEN_PATH, "/t/<redacted>");
}

/**
 * beforeBreadcrumb hook: scrub URLs on http/xhr/fetch breadcrumbs.
 * Non-HTTP crumbs pass through unchanged.
 */
export function scrubBreadcrumb<T extends BreadcrumbLike>(crumb: T): T {
  const isHttp =
    (crumb.type != null && HTTP_CATEGORIES.has(crumb.type)) ||
    (crumb.category != null && HTTP_CATEGORIES.has(crumb.category));
  if (!isHttp || !crumb.data || typeof crumb.data.url !== "string") {
    return crumb;
  }
  return {
    ...crumb,
    data: { ...crumb.data, url: scrubUrl(crumb.data.url) },
  };
}
