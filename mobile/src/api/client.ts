import { log } from "@/src/telemetry/logBuffer";
import { supabase } from "@/src/auth/supabaseClient";
import { isAllowedApiOrigin } from "@/src/storage/apiUrl";
import type {
  Building,
  BuildingsResponse,
  ClassesResponse,
  CrowdingInfo,
  CrowdingReportRequest,
  DeparturesResponse,
  NearbyStopsResponse,
  PatchShareTripRequest,
  RecommendationRequest,
  RecommendationResponse,
  ScheduleClass,
  ShareTripRequest,
  ShareTripResponse,
  UpdateClassRequest,
  VehiclesResponse,
} from "./types";

export type { Building, ClassesResponse, ScheduleClass } from "./types";
export type { RecommendationOption, RecommendationResponse, RecommendationStep } from "./types";
export type { DeparturesResponse, NearbyStopsResponse } from "./types";
export type { VehicleInfo, VehiclesResponse } from "./types";
export type { ShareTripRequest, ShareTripResponse, PatchShareTripRequest } from "./types";
export type { CrowdingInfo, CrowdingReportRequest, CrowdingLevel } from "./types";

export type RequestSignal = AbortSignal | undefined;

export interface RequestOptions {
  signal?: AbortSignal;
  /** Optional API key for production (X-API-Key header). */
  apiKey?: string | null;
}

async function mergeHeaders(url: string, init?: RequestInit, apiKey?: string | null): Promise<Headers> {
  const headers = init?.headers instanceof Headers ? new Headers(init.headers) : new Headers(init?.headers as HeadersInit);
  // Credentials are pinned to known API origins. The base URL is
  // attacker-influencable state (Settings input, tampered AsyncStorage), so
  // attaching the Supabase JWT and API key unconditionally would hand both to
  // any host — including via background refresh with no UI in sight.
  if (!isAllowedApiOrigin(url)) return headers;
  if (apiKey?.trim()) headers.set("X-API-Key", apiKey.trim());
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session?.access_token) headers.set("Authorization", `Bearer ${session.access_token}`);
  return headers;
}

const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2; // 3 attempts total
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 5000;

/** Any non-2xx response or unusable body, so React Query records a failure instead of a success. */
export class ApiError extends Error {
  readonly status: number;
  readonly path: string;
  /** The backend's `detail` field, when the body carried one. */
  readonly detail?: string;

  constructor(message: string, status: number, path: string, detail?: string) {
    super(message);
    // Subclassing a built-in loses the prototype chain under the class transform, so instanceof needs this.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
    this.status = status;
    this.path = path;
    this.detail = detail;
  }
}

/** 401 from the API-key gate, which runs before the route and is unrelated to the Supabase session. */
export class ApiKeyError extends ApiError {
  constructor(path: string, detail?: string) {
    super(detail?.trim() || "Invalid or missing API key. Enter it in Settings.", 401, path, detail);
  }
}

/** The request exceeded REQUEST_TIMEOUT_MS, as opposed to a caller cancelling it. */
export class ApiTimeoutError extends ApiError {
  constructor(path: string) {
    super(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`, 0, path);
  }
}

function isRetryable(status: number, err: unknown): boolean {
  if (status >= 500 && status < 600) return true;
  if (status === 429) return true;
  if (err instanceof TypeError && (err.message === "Network request failed" || err.message === "Failed to fetch")) return true;
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a failed request can be safely re-sent.
 *
 * A timeout or a dropped connection says nothing about whether the server
 * processed the request, so re-sending a POST/PATCH/DELETE can duplicate the
 * write: a second class, a second share trip, a second crowding report. Only
 * replay methods that are idempotent by definition.
 */
function isIdempotent(method: string | undefined): boolean {
  const m = (method ?? "GET").toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

/**
 * A caller-supplied signal must not displace the timeout signal, so both feed one
 * signal that aborts as soon as either of them does. Uses AbortSignal.any where
 * the runtime provides it; otherwise bridges the two by hand.
 */
function combineSignals(
  userSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal
): { signal: AbortSignal; release: () => void } {
  if (!userSignal) return { signal: timeoutSignal, release: () => {} };
  if (userSignal.aborted) return { signal: userSignal, release: () => {} };
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any([userSignal, timeoutSignal]), release: () => {} };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  userSignal.addEventListener("abort", abort);
  timeoutSignal.addEventListener("abort", abort);
  return {
    signal: controller.signal,
    release: () => {
      userSignal.removeEventListener("abort", abort);
      timeoutSignal.removeEventListener("abort", abort);
    },
  };
}

async function readDetail(res: Response): Promise<string> {
  try {
    const body = (await res.clone().json()) as { detail?: unknown };
    return typeof body?.detail === "string" ? body.detail : "";
  } catch {
    return "";
  }
}

function isApiKeyRejection(detail: string): boolean {
  return /api[\s-]?key/i.test(detail);
}

/** Only a complaint about the token itself justifies refreshing or dropping the session. */
function isJwtRejection(res: Response, detail: string): boolean {
  if (/bearer/i.test(res.headers.get("WWW-Authenticate") ?? "")) return true;
  return /token|jwt|session|credential/i.test(detail);
}

/** Read the body's detail (if any) and build the typed error for a non-2xx response. */
async function apiErrorFromResponse(res: Response, pathLabel: string, fallback: string): Promise<ApiError> {
  const detail = await readDetail(res);
  return new ApiError(detail || fallback, res.status, pathLabel, detail || undefined);
}

async function fetchWithRetry(
  url: string,
  pathLabel: string,
  init?: RequestInit & { signal?: AbortSignal; apiKey?: string | null; retryOn429?: boolean }
): Promise<Response> {
  const { signal: userSignal, apiKey, retryOn429 = true, ...rest } = init ?? {};
  const replayable = isIdempotent(rest.method);
  const headers = await mergeHeaders(url, rest, apiKey);
  let requestInit: RequestInit & { signal?: AbortSignal } = { ...rest, headers };
  let lastError: unknown;
  let lastResponse: Response | undefined;
  let refreshAttempted = false;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const timeoutController = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, REQUEST_TIMEOUT_MS);
    const { signal, release } = combineSignals(userSignal, timeoutController.signal);
    try {
      log.info(`api_request path=${pathLabel} attempt=${attempt + 1}`, { path: pathLabel });
      const res = await fetch(url, { ...requestInit, signal });
      clearTimeout(timeoutId);
      release();
      if (!res.ok) {
        log.warn(`api_response path=${pathLabel} status=${res.status}`, { path: pathLabel, status: res.status });
        // 429 is backpressure on most routes, but some use it as a definitive
        // rejection; retrying those only delays the answer and burns the budget.
        const statusRetryable = isRetryable(res.status, null) && (retryOn429 || res.status !== 429);
        if (attempt < MAX_RETRIES && statusRetryable) {
          const backoff = Math.min(RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 300, RETRY_MAX_MS);
          await delay(backoff);
          continue;
        }
        if (res.status === 401) {
          lastResponse = res;
          const detail = await readDetail(res);
          if (isApiKeyRejection(detail)) throw new ApiKeyError(pathLabel, detail);
          if (isJwtRejection(res, detail)) {
            const { data: sessionData } = await supabase.auth.getSession();
            if (!sessionData.session) {
              // Not signed in — a 401 is expected; signing out here would wipe
              // auth storage, including a PKCE code verifier for an in-flight
              // OAuth/magic-link login
              return res;
            }
            if (!refreshAttempted) {
              refreshAttempted = true;
              await supabase.auth.refreshSession();
              const refreshedHeaders = await mergeHeaders(url, rest, apiKey);
              requestInit = { ...requestInit, headers: refreshedHeaders };
              attempt--; // the refresh replay must not consume one of the retry slots
              continue; // retry with refreshed token
            }
            // Second 401 after refresh — session is truly invalid, sign out
            await supabase.auth.signOut(); // AuthGate in _layout.tsx will redirect to /sign-in
          }
          return res;
        }
        return res;
      }
      return res;
    } catch (e) {
      clearTimeout(timeoutId);
      release();
      if (e instanceof ApiError) throw e;
      if (userSignal?.aborted) {
        log.info(`api_aborted path=${pathLabel}`, { path: pathLabel });
        throw e;
      }
      const err = timedOut ? new ApiTimeoutError(pathLabel) : e;
      lastError = err;
      log.error(`api_error path=${pathLabel} attempt=${attempt + 1}`, { path: pathLabel, error: err instanceof Error ? err.message : String(err) });
      if (attempt < MAX_RETRIES && replayable && (timedOut || isRetryable(0, err))) {
        const backoff = Math.min(RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 300, RETRY_MAX_MS);
        await delay(backoff);
      } else {
        throw err;
      }
    }
  }
  // Defensive: the loop only exits via the retry budget, but never rethrow undefined.
  if (lastResponse) return lastResponse;
  throw lastError ?? new ApiError(`${pathLabel}: request failed`, 0, pathLabel);
}

async function parseJson<T>(res: Response, pathLabel: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    log.warn(`api_json_parse_failed path=${pathLabel}`, { path: pathLabel });
    throw new ApiError(`${pathLabel}: malformed response body`, res.status, pathLabel);
  }
}

/** Pass baseUrl from getStoredApiBaseUrl() or useApiBaseUrl() (no trailing slash). */
export async function fetchNearbyStops(
  baseUrl: string,
  lat: number,
  lng: number,
  radiusM = 800,
  options?: RequestOptions
): Promise<NearbyStopsResponse> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/stops/nearby?lat=${lat}&lng=${lng}&radius_m=${radiusM}`;
  const res = await fetchWithRetry(url, "/stops/nearby", options);
  if (!res.ok) throw new ApiError(`Stops: ${res.status}`, res.status, "/stops/nearby");
  return parseJson<NearbyStopsResponse>(res, "/stops/nearby");
}

export async function fetchDepartures(
  baseUrl: string,
  stopId: string,
  minutes = 60,
  options?: RequestOptions
): Promise<DeparturesResponse> {
  const base = baseUrl.replace(/\/$/, "");
  const res = await fetchWithRetry(
    `${base}/stops/${encodeURIComponent(stopId)}/departures?minutes=${minutes}`,
    "/stops/:id/departures",
    options
  );
  if (!res.ok) throw new ApiError(`Departures: ${res.status}`, res.status, "/stops/:id/departures");
  return parseJson<DeparturesResponse>(res, "/stops/:id/departures");
}

export async function fetchBuildings(baseUrl: string, options?: RequestOptions): Promise<BuildingsResponse> {
  const base = baseUrl.replace(/\/$/, "");
  const res = await fetchWithRetry(`${base}/buildings`, "/buildings", options);
  if (!res.ok) throw new ApiError(`Buildings: ${res.status}`, res.status, "/buildings");
  return parseJson<BuildingsResponse>(res, "/buildings");
}

export async function fetchClasses(baseUrl: string, options?: RequestOptions): Promise<ClassesResponse> {
  const base = baseUrl.replace(/\/$/, "");
  const res = await fetchWithRetry(`${base}/schedule/classes`, "/schedule/classes", options);
  if (!res.ok) throw new ApiError(`Classes: ${res.status}`, res.status, "/schedule/classes");
  return parseJson<ClassesResponse>(res, "/schedule/classes");
}

export async function createClass(
  baseUrl: string,
  body: {
    title: string;
    days_of_week: string[];
    start_time_local: string;
    building_id?: string | null;
    destination_lat?: number | null;
    destination_lng?: number | null;
    destination_name?: string | null;
    end_time_local?: string | null;
  },
  options?: RequestOptions
): Promise<ScheduleClass> {
  const base = baseUrl.replace(/\/$/, "");
  const res = await fetchWithRetry(`${base}/schedule/classes`, "POST /schedule/classes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal,
    apiKey: options?.apiKey,
  });
  if (!res.ok) throw await apiErrorFromResponse(res, "POST /schedule/classes", `Classes: ${res.status}`);
  try {
    return (await res.json()) as ScheduleClass;
  } catch {
    log.warn("api_json_parse_failed path=POST /schedule/classes", {});
    throw new Error("Invalid response from server");
  }
}

export async function fetchRecommendation(
  baseUrl: string,
  body: RecommendationRequest,
  options?: RequestOptions
): Promise<RecommendationResponse> {
  const base = baseUrl.replace(/\/$/, "");
  const res = await fetchWithRetry(`${base}/recommendation`, "/recommendation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal,
    apiKey: options?.apiKey,
  });
  if (!res.ok) throw await apiErrorFromResponse(res, "/recommendation", `Recommendation: ${res.status}`);
  const data = await parseJson<RecommendationResponse>(res, "/recommendation");
  return { options: Array.isArray(data.options) ? data.options : [] };
}

/** GET /health - use to verify API is reachable (e.g. from Settings). */
export async function fetchHealth(baseUrl: string, options?: RequestOptions): Promise<{ status: string }> {
  const base = baseUrl.replace(/\/$/, "");
  const res = await fetchWithRetry(`${base}/health`, "/health", options);
  if (!res.ok) throw new ApiError(`Health: ${res.status}`, res.status, "/health");
  return parseJson<{ status: string }>(res, "/health");
}

/** GET /vehicles?route_id=... - live vehicle positions */
export async function fetchVehicles(
  baseUrl: string,
  routeId?: string,
  options?: RequestOptions
): Promise<VehiclesResponse> {
  const base = baseUrl.replace(/\/$/, "");
  const params = routeId ? `?route_id=${encodeURIComponent(routeId)}` : "";
  const res = await fetchWithRetry(`${base}/vehicles${params}`, "/vehicles", options);
  if (!res.ok) throw new ApiError(`Vehicles: ${res.status}`, res.status, "/vehicles");
  return parseJson<VehiclesResponse>(res, "/vehicles");
}

/** GET /crowding/:vehicle_id - fetch crowding info for a vehicle */
export async function fetchCrowding(
  baseUrl: string,
  vehicleId: string,
  routeId?: string,
  options?: { apiKey?: string },
): Promise<CrowdingInfo | null> {
  try {
    const params = routeId ? `?route_id=${encodeURIComponent(routeId)}` : "";
    const url = `${baseUrl.replace(/\/$/, "")}/crowding/${encodeURIComponent(vehicleId)}${params}`;
    const res = await fetchWithRetry(url, "/crowding/:vehicle_id", { apiKey: options?.apiKey });
    if (!res.ok) return null;
    return await parseJson<CrowdingInfo>(res, "/crowding/:vehicle_id");
  } catch {
    // Crowding is supplementary; its absence must not fail the surrounding view.
    return null;
  }
}

/** POST /crowding/report - submit a crowding report */
export async function submitCrowdingReport(
  baseUrl: string,
  body: CrowdingReportRequest,
  options?: { apiKey?: string },
): Promise<{ success: boolean; current_aggregate: CrowdingInfo | null }> {
  const res = await fetchWithRetry(`${baseUrl.replace(/\/$/, "")}/crowding/report`, "POST /crowding/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    apiKey: options?.apiKey,
    // The backend answers "you already reported this bus recently" with 429, so a
    // retry cannot succeed — it just makes the message take three round trips to show.
    retryOn429: false,
  });
  if (!res.ok) throw await apiErrorFromResponse(res, "POST /crowding/report", `HTTP ${res.status}`);
  return parseJson<{ success: boolean; current_aggregate: CrowdingInfo | null }>(res, "POST /crowding/report");
}

/** PATCH /schedule/classes/:id */
export async function updateClass(
  baseUrl: string,
  classId: string,
  body: UpdateClassRequest,
  options?: RequestOptions
): Promise<ScheduleClass> {
  const base = baseUrl.replace(/\/$/, "");
  const res = await fetchWithRetry(
    `${base}/schedule/classes/${encodeURIComponent(classId)}`,
    "PATCH /schedule/classes/:id",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options?.signal,
      apiKey: options?.apiKey,
    }
  );
  if (!res.ok) throw await apiErrorFromResponse(res, "PATCH /schedule/classes/:id", `Update class: ${res.status}`);
  try {
    return (await res.json()) as ScheduleClass;
  } catch {
    log.warn("api_json_parse_failed path=PATCH /schedule/classes/:id", {});
    throw new Error("Invalid response from server");
  }
}

/** DELETE /schedule/classes/:id */
export async function deleteClass(
  baseUrl: string,
  classId: string,
  options?: RequestOptions
): Promise<void> {
  const base = baseUrl.replace(/\/$/, "");
  const res = await fetchWithRetry(
    `${base}/schedule/classes/${encodeURIComponent(classId)}`,
    "DELETE /schedule/classes/:id",
    { method: "DELETE", signal: options?.signal, apiKey: options?.apiKey }
  );
  if (!res.ok && res.status !== 204) {
    throw await apiErrorFromResponse(res, "DELETE /schedule/classes/:id", `Delete class: ${res.status}`);
  }
}

/** POST /ai/eod-report - end-of-day activity report */
export async function fetchEodReport(
  baseUrl: string,
  body: { entries: unknown[]; total_steps: number; total_calories: number; total_distance_m: number },
  options?: RequestOptions
): Promise<{ report: string; encouragement?: string; highlights?: string[] }> {
  const base = baseUrl.replace(/\/$/, "");
  const res = await fetchWithRetry(`${base}/ai/eod-report`, "POST /ai/eod-report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal,
    apiKey: options?.apiKey,
  });
  if (!res.ok) throw await apiErrorFromResponse(res, "POST /ai/eod-report", `EOD report: ${res.status}`);
  return parseJson<{ report: string; encouragement?: string; highlights?: string[] }>(res, "POST /ai/eod-report");
}

/** GET /buildings/search?q=... - search buildings by name (ranked: exact → starts-with → contains) */
export async function fetchBuildingSearch(
  baseUrl: string,
  query: string,
  options?: RequestOptions
): Promise<BuildingsResponse> {
  const base = baseUrl.replace(/\/$/, "");
  const res = await fetchWithRetry(
    `${base}/buildings/search?q=${encodeURIComponent(query)}&limit=5`,
    "/buildings/search",
    options
  );
  if (!res.ok) throw new ApiError(`Building search: ${res.status}`, res.status, "/buildings/search");
  return parseJson<BuildingsResponse>(res, "/buildings/search");
}

/** GET /autocomplete - combined buildings + Nominatim suggestions */
export interface AutocompleteResult {
  type: "building" | "place" | "google_place";
  name: string;
  display_name?: string;
  secondary_text?: string;
  lat: number;
  lng: number;
  building_id?: string;
  place_id?: string;
}

export interface PlacePrediction {
  place_id: string;
  main_text: string;
  secondary_text: string;
  description: string;
}

/** POST /places/autocomplete - Google Places autocomplete via backend proxy */
export async function fetchPlacesAutocomplete(
  baseUrl: string,
  query: string,
  sessionToken?: string,
  options?: RequestOptions
): Promise<{ predictions: PlacePrediction[] }> {
  const base = baseUrl.replace(/\/$/, "");
  const res = await fetchWithRetry(`${base}/places/autocomplete`, "/places/autocomplete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, session_token: sessionToken }),
    signal: options?.signal,
    apiKey: options?.apiKey,
  });
  if (!res.ok) throw new ApiError(`Places autocomplete: ${res.status}`, res.status, "/places/autocomplete");
  return parseJson<{ predictions: PlacePrediction[] }>(res, "/places/autocomplete");
}

/** GET /places/details - resolve a place_id to lat/lng */
export async function fetchPlaceDetails(
  baseUrl: string,
  placeId: string,
  options?: RequestOptions
): Promise<{ lat: number; lng: number; display_name: string }> {
  const base = baseUrl.replace(/\/$/, "");
  const res = await fetchWithRetry(
    `${base}/places/details?place_id=${encodeURIComponent(placeId)}`,
    "/places/details",
    options
  );
  if (!res.ok) throw new ApiError(`Places details: ${res.status}`, res.status, "/places/details");
  return parseJson<{ lat: number; lng: number; display_name: string }>(res, "/places/details");
}

export async function fetchAutocomplete(
  baseUrl: string,
  query: string,
  options?: RequestOptions
): Promise<{ results: AutocompleteResult[] }> {
  const base = baseUrl.replace(/\/$/, "");
  const res = await fetchWithRetry(
    `${base}/autocomplete?q=${encodeURIComponent(query)}&limit=8`,
    "/autocomplete",
    options
  );
  if (!res.ok) throw new ApiError(`Autocomplete: ${res.status}`, res.status, "/autocomplete");
  return parseJson<{ results: AutocompleteResult[] }>(res, "/autocomplete");
}

/** GET /directions/walk - real walking route via OSRM proxy */
export async function fetchWalkingRoute(
  baseUrl: string,
  origLat: number,
  origLng: number,
  destLat: number,
  destLng: number,
  options?: RequestOptions
): Promise<{ coords: [number, number][] }> {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/directions/walk?orig_lat=${origLat}&orig_lng=${origLng}&dest_lat=${destLat}&dest_lng=${destLng}`;
  const res = await fetchWithRetry(url, "/directions/walk", options);
  if (!res.ok) throw new ApiError(`Walking route: ${res.status}`, res.status, "/directions/walk");
  return parseJson<{ coords: [number, number][] }>(res, "/directions/walk");
}

export interface BusStop {
  stop_id: string;
  stop_name: string;
  lat: number;
  lng: number;
  sequence: number;
}

/** GET /gtfs/route-stops - bus trip shape + stops between two stops */
export async function fetchBusRouteStops(
  baseUrl: string,
  routeId: string,
  fromStopId: string,
  toStopId: string,
  afterTime: string,
  options?: RequestOptions
): Promise<{ trip_id: string | null; stops: BusStop[]; shape_points: [number, number][] }> {
  const base = baseUrl.replace(/\/$/, "");
  const params = new URLSearchParams({
    route_id: routeId,
    from_stop_id: fromStopId,
    to_stop_id: toStopId,
    after_time: afterTime,
  });
  const res = await fetchWithRetry(`${base}/gtfs/route-stops?${params}`, "/gtfs/route-stops", options);
  if (!res.ok) throw new ApiError(`Route stops: ${res.status}`, res.status, "/gtfs/route-stops");
  return parseJson<{ trip_id: string | null; stops: BusStop[]; shape_points: [number, number][] }>(res, "/gtfs/route-stops");
}

/** GET /gtfs/route-all-stops - all stops in order for a route (canonical trip) */
export async function fetchAllStopsForRoute(
  baseUrl: string,
  routeId: string,
  options?: RequestOptions
): Promise<{ stops: BusStop[] }> {
  const base = baseUrl.replace(/\/$/, "");
  const res = await fetchWithRetry(
    `${base}/gtfs/route-all-stops?route_id=${encodeURIComponent(routeId)}`,
    "/gtfs/route-all-stops",
    options
  );
  if (!res.ok) throw new ApiError(`Route stops: ${res.status}`, res.status, "/gtfs/route-all-stops");
  return parseJson<{ stops: BusStop[] }>(res, "/gtfs/route-all-stops");
}

/** GET /geocode?q=... - resolve place/address to lat, lng, display_name */
export interface GeocodeResult {
  lat: number;
  lng: number;
  display_name: string;
}
export async function fetchGeocode(
  baseUrl: string,
  query: string,
  options?: RequestOptions
): Promise<GeocodeResult> {
  const base = baseUrl.replace(/\/$/, "");
  const res = await fetchWithRetry(
    `${base}/geocode?${encodeURIComponent("q")}=${encodeURIComponent(query)}`,
    "/geocode",
    options
  );
  if (!res.ok) throw await apiErrorFromResponse(res, "/geocode", `Geocode: ${res.status}`);
  return parseJson<GeocodeResult>(res, "/geocode");
}

export async function createShareTrip(
  baseUrl: string,
  body: ShareTripRequest,
  opts?: RequestOptions
): Promise<ShareTripResponse> {
  const res = await fetchWithRetry(`${baseUrl}/share/trips`, "/share/trips", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    apiKey: opts?.apiKey,
    signal: opts?.signal,
  });
  if (!res.ok) throw new ApiError(`share_create_failed status=${res.status}`, res.status, "/share/trips");
  return parseJson<ShareTripResponse>(res, "/share/trips");
}

/** Fire-and-forget: silently updates phase/eta. Call without await. */
export function patchShareTrip(
  baseUrl: string,
  token: string,
  body: PatchShareTripRequest,
  opts?: RequestOptions & { editToken?: string | null }
): void {
  // Static label: pathLabel is logged, and the token grants access to the trip.
  fetchWithRetry(`${baseUrl}/share/trips/${token}`, "/share/trips/:token", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      // The backend requires the writer credential from creation; the public
      // view token alone must no longer be able to mutate the trip.
      ...(opts?.editToken ? { "X-Edit-Token": opts.editToken } : {}),
    },
    body: JSON.stringify(body),
    apiKey: opts?.apiKey,
  }).catch(() => {/* silent — stale phase on recipient is acceptable */});
}
