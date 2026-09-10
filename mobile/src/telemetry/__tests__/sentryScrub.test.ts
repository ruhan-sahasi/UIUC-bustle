import { scrubBreadcrumb } from "../sentryScrub";

describe("scrubBreadcrumb", () => {
  it("redacts share-trip tokens and strips the query string", () => {
    const crumb = {
      type: "http",
      category: "fetch",
      data: {
        url: "https://api.example.com/share/trips/SECRET?x=1",
        method: "GET",
        status_code: 200,
      },
    };
    const scrubbed = scrubBreadcrumb(crumb);
    expect(scrubbed.data.url).not.toContain("SECRET");
    expect(scrubbed.data.url).not.toContain("?");
    expect(scrubbed.data.url).not.toContain("x=1");
    expect(scrubbed.data.url).toBe("https://api.example.com/share/trips/<redacted>");
    // other data fields preserved
    expect(scrubbed.data.method).toBe("GET");
    expect(scrubbed.data.status_code).toBe(200);
  });

  it("redacts short share-token /t/ path segments", () => {
    const crumb = {
      type: "http",
      data: { url: "https://bustle.app/t/abc123XYZ?utm=share" },
    };
    const scrubbed = scrubBreadcrumb(crumb);
    expect(scrubbed.data.url).not.toContain("abc123XYZ");
    expect(scrubbed.data.url).toBe("https://bustle.app/t/<redacted>");
  });

  it("strips GPS coordinates carried in query strings", () => {
    const crumb = {
      type: "http",
      category: "xhr",
      data: { url: "https://api.example.com/stops/nearby?lat=40.1&lng=-88.2" },
    };
    const scrubbed = scrubBreadcrumb(crumb);
    expect(scrubbed.data.url).not.toContain("40.1");
    expect(scrubbed.data.url).not.toContain("-88.2");
    expect(scrubbed.data.url).not.toContain("lat=");
    expect(scrubbed.data.url).toBe("https://api.example.com/stops/nearby");
  });

  it("matches crumbs identified only by category (no type)", () => {
    const crumb = {
      category: "xhr",
      data: { url: "https://api.example.com/share/trips/tok-1?sig=abc" },
    };
    expect(scrubBreadcrumb(crumb).data.url).toBe(
      "https://api.example.com/share/trips/<redacted>"
    );
  });

  it("passes non-http crumbs through unchanged", () => {
    const crumb = {
      type: "navigation",
      category: "navigation",
      data: { from: "/home", to: "/trip?lat=40.1" },
      message: "navigated",
    };
    expect(scrubBreadcrumb(crumb)).toBe(crumb);

    const consoleCrumb = { category: "console", message: "hello ?x=1" };
    expect(scrubBreadcrumb(consoleCrumb)).toBe(consoleCrumb);
  });

  it("passes http crumbs with no url through unchanged", () => {
    const crumb = { type: "http", data: { method: "GET" } };
    expect(scrubBreadcrumb(crumb)).toBe(crumb);
    const noData = { type: "http" };
    expect(scrubBreadcrumb(noData)).toBe(noData);
  });

  it("does not mutate the original crumb", () => {
    const crumb = {
      type: "http",
      data: { url: "https://api.example.com/share/trips/SECRET?x=1" },
    };
    scrubBreadcrumb(crumb);
    expect(crumb.data.url).toBe("https://api.example.com/share/trips/SECRET?x=1");
  });
});
