import { describe, expect, test } from "vitest";

import { assertPublicResolution, normalizeProviderOrigin } from "../src/api/provider-origin.js";

describe("normalizeProviderOrigin", () => {
  test("accepts public HTTPS origins and normalizes them", () => {
    expect(normalizeProviderOrigin("https://github.com")).toBe("https://github.com");
    expect(normalizeProviderOrigin("https://GitLab.Example.COM/")).toBe(
      "https://gitlab.example.com",
    );
    expect(normalizeProviderOrigin("https://ghe.example.com:443")).toBe("https://ghe.example.com");
  });

  test("rejects non-HTTPS origins", () => {
    expect(() => normalizeProviderOrigin("http://github.com")).toThrow(/HTTPS/);
    expect(() => normalizeProviderOrigin("ftp://github.com")).toThrow();
  });

  test("rejects embedded credentials, queries, fragments, and paths", () => {
    expect(() => normalizeProviderOrigin("https://user:pass@github.com")).toThrow(/credentials/);
    expect(() => normalizeProviderOrigin("https://github.com?x=1")).toThrow(/query/);
    expect(() => normalizeProviderOrigin("https://github.com#frag")).toThrow(/fragment/);
    expect(() => normalizeProviderOrigin("https://github.com/login")).toThrow(/path/);
  });

  test("rejects non-default ports", () => {
    expect(() => normalizeProviderOrigin("https://github.com:8443")).toThrow(/port/);
    expect(() => normalizeProviderOrigin("https://github.com:22")).toThrow(/port/);
  });

  test("rejects internal and reserved IP literals", () => {
    for (const origin of [
      "https://10.0.0.5",
      "https://172.16.0.9",
      "https://192.168.1.10",
      "https://127.0.0.1",
      "https://169.254.169.254",
      "https://100.64.0.1",
      "https://0.0.0.0",
      "https://198.18.0.1",
      "https://203.0.113.7",
      "https://[::1]",
      "https://[fd00::1]",
      "https://[fe80::1]",
      "https://[::ffff:10.0.0.1]",
      "https://[::ffff:a00:1]",
      "https://[::a00:1]",
    ]) {
      expect(() => normalizeProviderOrigin(origin), origin).toThrow(
        /internal or reserved|internal-network/,
      );
    }
  });

  test("accepts public IP literals", () => {
    expect(normalizeProviderOrigin("https://140.82.112.3")).toBe("https://140.82.112.3");
    expect(normalizeProviderOrigin("https://[2606:2800:220:1:248:1893:25c8:1946]")).toContain(
      "2606:2800",
    );
  });

  test("rejects single-label and internal-suffix hostnames", () => {
    expect(() => normalizeProviderOrigin("https://intranet")).toThrow(/fully qualified/);
    for (const origin of [
      "https://gitlab.corp",
      "https://git.corp.example.internal",
      "https://gitlab.local",
      "https://git.lan",
      "https://git.home.arpa",
    ]) {
      expect(() => normalizeProviderOrigin(origin), origin).toThrow();
    }
  });
});

describe("assertPublicResolution", () => {
  test("rejects hostnames that resolve to internal addresses", async () => {
    await expect(
      assertPublicResolution("https://gitlab.example.com", async () => ["10.0.0.5"]),
    ).rejects.toThrow(/internal or reserved/);
    await expect(
      assertPublicResolution("https://gitlab.example.com", async () => [
        "104.16.0.1",
        "192.168.0.1",
      ]),
    ).rejects.toThrow(/internal or reserved/);
  });

  test("rejects hostnames that do not resolve", async () => {
    await expect(
      assertPublicResolution("https://gitlab.example.com", async () => []),
    ).rejects.toThrow(/does not resolve/);
    await expect(
      assertPublicResolution("https://gitlab.example.com", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow(/does not resolve/);
  });

  test("accepts hostnames resolving to public addresses only", async () => {
    await expect(
      assertPublicResolution("https://gitlab.example.com", async () => ["104.16.0.1"]),
    ).resolves.toBeUndefined();
    // Literal addresses skip the resolver entirely.
    await expect(
      assertPublicResolution("https://140.82.112.3", async () => []),
    ).resolves.toBeUndefined();
  });
});
