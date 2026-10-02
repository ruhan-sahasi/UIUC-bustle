/**
 * Tests for the network layer.
 *
 * client.ts had no coverage at all, while every query test mocks it wholesale
 * — so URL construction, header injection, timeout, abort, and retry semantics
 * were verified by nothing. These pin the behaviours that are easy to break
 * silently and expensive to get wrong.
 */
const mockGetSession = jest.fn(async () => ({ data: { session: null as null | { access_token: string } } }));
const mockRefreshSession = jest.fn(async () => ({ data: {}, error: null }));
const mockSignOut = jest.fn(async () => undefined);

jest.mock("@/src/auth/supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: () => mockGetSession(),
      refreshSession: () => mockRefreshSession(),
      signOut: () => mockSignOut(),
    },
  },
}));

jest.mock("@/src/telemetry/logBuffer", () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  fetchDepartures,
  fetchNearbyStops,
  createClass,
  ApiError,
  ApiKeyError,
  ApiTimeoutError,
} from "../client";

const BASE = "http://localhost:8000";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lastRequestUrl(): string {
  const calls = (global.fetch as jest.Mock).mock.calls;
  return calls[calls.length - 1][0] as string;
}

function lastRequestHeaders(): Headers {
  const calls = (global.fetch as jest.Mock).mock.calls;
  return calls[calls.length - 1][1].headers as Headers;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ data: { session: null } });
  global.fetch = jest.fn();
});

describe("URL construction", () => {
  it("encodes the stop id rather than interpolating it raw", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ stop_id: "a/b", departures: [] }));
    await fetchDepartures(BASE, "a/b c", 30);

    const url = lastRequestUrl();
    expect(url).not.toContain("a/b c");
    expect(url).toContain("minutes=30");
  });

  it("tolerates a base URL with a trailing slash", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ stops: [] }));
    await fetchNearbyStops(`${BASE}/`, 40.1, -88.2, 800);
    expect(lastRequestUrl()).not.toContain("//stops");
  });
});

describe("auth headers", () => {
  it("attaches the bearer token when a session exists", async () => {
    mockGetSession.mockResolvedValue({ data: { session: { access_token: "tok-123" } } });
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ stops: [] }));

    await fetchNearbyStops(BASE, 40.1, -88.2);
    expect(lastRequestHeaders().get("Authorization")).toBe("Bearer tok-123");
  });

  it("omits Authorization when signed out", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ stops: [] }));
    await fetchNearbyStops(BASE, 40.1, -88.2);
    expect(lastRequestHeaders().get("Authorization")).toBeNull();
  });

  it("sends X-API-Key when configured, and not when blank", async () => {
    (global.fetch as jest.Mock).mockImplementation(async () => jsonResponse({ stops: [] }));

    await fetchNearbyStops(BASE, 40.1, -88.2, 800, { apiKey: "secret" });
    expect(lastRequestHeaders().get("X-API-Key")).toBe("secret");

    await fetchNearbyStops(BASE, 40.1, -88.2, 800, { apiKey: "   " });
    expect(lastRequestHeaders().get("X-API-Key")).toBeNull();
  });
});

describe("error typing", () => {
  it("throws a typed ApiError carrying the status, not an empty success", async () => {
    // Several client functions used to return `{ stops: [] }` on a non-2xx,
    // which React Query records as isSuccess — so an outage rendered as
    // "no results" and never retried.
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ detail: "boom" }, 400));

    await expect(fetchNearbyStops(BASE, 40.1, -88.2)).rejects.toBeInstanceOf(ApiError);
  });

  it("distinguishes an API-key 401 from a JWT 401", async () => {
    // An API-key rejection must not trigger refresh-then-signOut; that turned
    // a missing key into an unrecoverable sign-out loop.
    (global.fetch as jest.Mock).mockResolvedValue(
      jsonResponse({ detail: "Invalid or missing API key" }, 401),
    );

    await expect(fetchNearbyStops(BASE, 40.1, -88.2)).rejects.toBeInstanceOf(ApiKeyError);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });
});

describe("retry policy", () => {
  it("retries an idempotent GET on 5xx", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse({ detail: "err" }, 503))
      .mockResolvedValueOnce(jsonResponse({ stops: [] }));

    await fetchNearbyStops(BASE, 40.1, -88.2);
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(2);
  });

  it("does NOT replay a POST after a network failure", async () => {
    // A dropped connection says nothing about whether the server processed the
    // request, so replaying a create can duplicate the row.
    (global.fetch as jest.Mock).mockRejectedValue(
      Object.assign(new TypeError("Network request failed"), { name: "TypeError" }),
    );

    await expect(
      createClass(BASE, {
        title: "CS 233",
        days_of_week: ["MON"],
        start_time_local: "09:00",
        building_id: "siebel",
      }),
    ).rejects.toBeTruthy();

    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
  });

  it("does NOT replay a POST after an ambiguous 502", async () => {
    // The gateway may have timed out after the class row was written.
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ detail: "bad gateway" }, 502));

    await expect(
      createClass(BASE, {
        title: "CS 233",
        days_of_week: ["MON"],
        start_time_local: "09:00",
        building_id: "siebel",
      }),
    ).rejects.toBeTruthy();

    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
  });

  it("does replay a POST on 503, which means the server never acted on it", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse({ detail: "unavailable" }, 503))
      .mockResolvedValueOnce(
        jsonResponse({
          class_id: "c1",
          title: "CS 233",
          days_of_week: ["MON"],
          start_time_local: "09:00",
          building_id: "siebel",
        }, 201),
      );

    await createClass(BASE, {
      title: "CS 233",
      days_of_week: ["MON"],
      start_time_local: "09:00",
      building_id: "siebel",
    });
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(2);
  });

  it("retries an idempotent GET after a network failure", async () => {
    (global.fetch as jest.Mock)
      .mockRejectedValueOnce(new TypeError("Network request failed"))
      .mockResolvedValueOnce(jsonResponse({ stops: [] }));

    await fetchNearbyStops(BASE, 40.1, -88.2);
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(2);
  });
});

/** fetch stub that honours an already-aborted signal, as a real fetch does. */
function abortAwareFetch(): typeof global.fetch {
  const impl = (_u: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const fail = () =>
        reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      if (init?.signal?.aborted) return fail();
      init?.signal?.addEventListener("abort", fail);
    });
  return jest.fn(impl) as unknown as typeof global.fetch;
}

/** Let pending microtasks (mergeHeaders -> getSession) settle. */
async function flush(times = 5) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("timeout and cancellation", () => {
  it("passes an abort signal on every request", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ stops: [] }));
    await fetchNearbyStops(BASE, 40.1, -88.2);

    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts when the caller's signal fires, and does not retry", async () => {
    // A caller-supplied signal used to REPLACE the timeout signal entirely.
    // Both must feed one combined signal, and a real user cancellation must
    // not be retried.
    const controller = new AbortController();
    global.fetch = abortAwareFetch();

    const promise = fetchNearbyStops(BASE, 40.1, -88.2, 800, { signal: controller.signal });
    const settled = promise.then(
      () => "resolved",
      () => "rejected",
    );
    await flush();
    controller.abort();

    expect(await settled).toBe("rejected");
    // One attempt only: a user cancellation must never be retried.
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
  });

  it("surfaces a timeout as a typed ApiTimeoutError, not a bare AbortError", async () => {
    jest.useFakeTimers();
    global.fetch = abortAwareFetch();

    // A POST, so the timeout is terminal and no retry follows.
    const promise = createClass(BASE, {
      title: "CS 233",
      days_of_week: ["MON"],
      start_time_local: "09:00",
      building_id: "siebel",
    }).catch((e) => e);

    await flush();
    jest.advanceTimersByTime(20000);
    const err = await promise;

    expect(err).toBeInstanceOf(ApiTimeoutError);
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(1);
    jest.useRealTimers();
  });
});
