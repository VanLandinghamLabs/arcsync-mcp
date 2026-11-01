import { describe, expect, it } from "vitest";
import { envCredential, readSettings } from "./config.js";

const creds = { ARCSYNC_CLIENT_ID: "arc_x", ARCSYNC_CLIENT_SECRET: "arcsec_y" };

describe("readSettings", () => {
  it("defaults to production URLs", () => {
    expect(readSettings({})).toEqual({
      apiUrl: "https://api.arcsync.dev",
      appUrl: "https://arcsync.dev",
    });
  });

  it("accepts overrides, trims trailing slashes and carries the org", () => {
    const cfg = readSettings({
      ARCSYNC_API_URL: "https://api.staging.example/",
      ARCSYNC_APP_URL: "http://localhost:5173/",
      ARCSYNC_ORG: " org_1 ",
    });
    expect(cfg.apiUrl).toBe("https://api.staging.example");
    expect(cfg.appUrl).toBe("http://localhost:5173");
    expect(cfg.orgId).toBe("org_1");
  });

  it("refuses plain http to a non-loopback host, since the secret rides the exchange", () => {
    expect(() => readSettings({ ARCSYNC_API_URL: "http://api.arcsync.dev" })).toThrow(
      "ARCSYNC_API_URL must be an https URL",
    );
    expect(() => readSettings({ ARCSYNC_API_URL: "ftp://localhost" })).toThrow(
      "ARCSYNC_API_URL must be an https URL",
    );
  });

  it("refuses an unparseable URL", () => {
    expect(() => readSettings({ ARCSYNC_APP_URL: "not a url" })).toThrow(
      "ARCSYNC_APP_URL is not a valid URL: not a url",
    );
  });
});

describe("envCredential", () => {
  it("reads and trims both variables", () => {
    expect(
      envCredential({ ARCSYNC_CLIENT_ID: " arc_x ", ARCSYNC_CLIENT_SECRET: "arcsec_y" }),
    ).toEqual({ clientId: "arc_x", clientSecret: "arcsec_y" });
    expect(envCredential(creds)).toEqual({ clientId: "arc_x", clientSecret: "arcsec_y" });
  });

  it("is null when neither is set, so the browser connect flow takes over", () => {
    expect(envCredential({})).toBeNull();
    expect(envCredential({ ARCSYNC_CLIENT_ID: " ", ARCSYNC_CLIENT_SECRET: "" })).toBeNull();
  });

  it("names the one that is missing when only one is set", () => {
    expect(() => envCredential({ ARCSYNC_CLIENT_ID: "arc_x" })).toThrow(
      /Missing ARCSYNC_CLIENT_SECRET\./,
    );
    expect(() => envCredential({ ARCSYNC_CLIENT_SECRET: "arcsec_y" })).toThrow(
      /Missing ARCSYNC_CLIENT_ID\./,
    );
  });
});
