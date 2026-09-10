/** GET /stops/nearby */
export interface StopInfo {
  stop_id: string;
  stop_name: string;
  lat: number;
  lng: number;
}

export interface NearbyStopsResponse {
  stops: StopInfo[];
}

/** A stop annotated with its distance from the user, computed client-side. */
export type StopWithDistance = StopInfo & { distance_m: number };

/** GET /stops/{stop_id}/departures */
export interface DepartureItem {
  route: string;
  headsign: string;
  expected_mins: number;
  expected_time_iso: string | null;
  is_realtime: boolean;
  scheduled_mins?: number | null;
  delay_mins?: number | null;
  delay_status?: "on_time" | "delayed" | "early" | null;
}

export interface DeparturesResponse {
  stop_id: string;
  departures: DepartureItem[];
  /** "realtime" if any departure is live, else "scheduled" (GTFS times only). */
  source?: "realtime" | "scheduled";
  /** epoch seconds when the server produced this response. */
  generated_at?: number;
}

/** GET /buildings */
export interface Building {
  building_id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface BuildingsResponse {
  buildings: Building[];
}

/** GET/POST /schedule/classes */
export interface ScheduleClass {
  class_id: string;
  title: string;
  days_of_week: string[];
  start_time_local: string;
  building_id: string;
  destination_lat?: number | null;
  destination_lng?: number | null;
  destination_name?: string | null;
  end_time_local?: string | null;
}

/** PATCH /schedule/classes/:id */
export interface UpdateClassRequest {
  title?: string;
  building_id?: string;
  days_of_week?: string[];
  start_time_local?: string;
  end_time_local?: string;
  destination_lat?: number;
  destination_lng?: number;
  destination_name?: string;
}

/** Crowding level: 1=empty, 2=some seats, 3=standing room, 4=full */
export type CrowdingLevel = 1 | 2 | 3 | 4;

export interface CrowdingInfo {
  level: CrowdingLevel;
  confidence: string;
  source: "crowdsourced" | "estimated";
  report_count: number;
}

export interface CrowdingReportRequest {
  vehicle_id: string;
  route_id: string;
  trip_id?: string;
  crowding_level: CrowdingLevel;
  lat?: number;
  lon?: number;
  user_token?: string;
}

/** GET /vehicles */
export interface VehicleInfo {
  vehicle_id: string;
  lat: number;
  lng: number;
  heading: number;
  route_id: string;
  headsign: string;
  crowding?: CrowdingInfo;
}

export interface VehiclesResponse {
  vehicles: VehicleInfo[];
}

export interface ClassesResponse {
  classes: ScheduleClass[];
}

/** POST /recommendation */
export interface RecommendationStep {
  type: "WALK_TO_STOP" | "WAIT" | "RIDE" | "WALK_TO_DEST";
  duration_minutes: number;
  stop_id?: string;
  stop_name?: string;
  stop_lat?: number;
  stop_lng?: number;
  building_id?: string;
  building_lat?: number;
  building_lng?: number;
  route?: string;
  route_short_name?: string;
  walk_distance_m?: number;
  headsign?: string;
  alighting_stop_id?: string | null;
  alighting_stop_lat?: number | null;
  alighting_stop_lng?: number | null;
  vehicle_id?: string;
  route_id?: string;
}

export interface RecommendationOption {
  type: "WALK" | "BUS";
  summary: string;
  eta_minutes: number;
  depart_in_minutes: number;
  steps: RecommendationStep[];
  ai_explanation?: string | null;
  ai_ranked?: boolean;
}

export interface RecommendationRequest {
  lat: number;
  lng: number;
  /** Use when destination is a building. Omit when destination_lat/lng provided. */
  destination_building_id?: string;
  arrive_by_iso: string;
  walking_speed_mps?: number;
  buffer_minutes?: number;
  max_options?: number;
  /** Custom destination (e.g. general location). When set, recommendation uses this instead of building. */
  destination_lat?: number;
  destination_lng?: number;
  destination_name?: string;
  /** Rain mode: bus options sorted first, walk deprioritised. */
  prefer_bus?: boolean;
}

export interface RecommendationResponse {
  options: RecommendationOption[];
  /** epoch seconds when the server produced this response (data-freshness signal). */
  generated_at?: number;
}

/** POST /share/trips */
export interface ShareTripRequest {
  destination: string;
  route_id?: string | null;
  route_name?: string | null;
  stop_name?: string | null;
  phase: "walking" | "waiting" | "on_bus" | "arrived";
  eta_epoch?: number | null;
}

export interface ShareTripResponse {
  token: string;
  /** May be absent (or null) on newer backends; construct `${apiBaseUrl}/t/${token}` client-side. */
  url?: string;
  /** Writer credential, returned only at creation. Send as X-Edit-Token on PATCH. */
  edit_token?: string;
}

/** PATCH /share/trips/{token} */
export interface PatchShareTripRequest {
  phase?: "walking" | "waiting" | "on_bus" | "arrived";
  eta_epoch?: number | null;
}
