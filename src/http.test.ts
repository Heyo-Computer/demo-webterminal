import { describe, expect, test } from "bun:test";

import {
  SESSION_COOKIE,
  clearedSessionCookie,
  isSameOrigin,
  parseCookies,
  sessionCookie,
  sessionIdFrom,
} from "./http";

function req(
  url: string,
  headers: Record<string, string> = {},
  init: RequestInit = {},
): Request {
  return new Request(url, { ...init, headers });
}

describe("parseCookies", () => {
  test("handles a missing header", () => {
    expect(parseCookies(null)).toEqual({});
  });

  test("parses multiple pairs and trims whitespace", () => {
    expect(parseCookies("a=1; b=two;   c=3")).toEqual({
      a: "1",
      b: "two",
      c: "3",
    });
  });

  test("percent-decodes values", () => {
    expect(parseCookies("k=a%2Fb%3D")["k"]).toBe("a/b=");
  });

  test("keeps `=` inside a value", () => {
    expect(parseCookies("k=abc=def")["k"]).toBe("abc=def");
  });

  test("skips malformed segments", () => {
    expect(parseCookies("novalue; =orphan; ok=1")).toEqual({ ok: "1" });
  });
});

describe("sessionIdFrom", () => {
  test("reads the session cookie", () => {
    const r = req("http://localhost:3000/api/vms", {
      cookie: `other=x; ${SESSION_COOKIE}=abc123`,
    });
    expect(sessionIdFrom(r)).toBe("abc123");
  });

  test("is undefined when absent", () => {
    expect(sessionIdFrom(req("http://localhost:3000/api/vms"))).toBeUndefined();
  });
});

describe("sessionCookie", () => {
  const plain = req("http://localhost:3000/api/session", {
    host: "localhost:3000",
  });

  test("is HttpOnly, SameSite=Strict, and root-scoped", () => {
    const c = sessionCookie(plain, "sid-value", 1800);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Path=/");
    expect(c).toContain("Max-Age=1800");
    expect(c).toContain(`${SESSION_COOKIE}=sid-value`);
  });

  test("omits Secure on plain http (so localhost works)", () => {
    expect(sessionCookie(plain, "sid", 60)).not.toContain("Secure");
  });

  test("adds Secure over https", () => {
    const r = req("https://app.example.com/api/session", {
      host: "app.example.com",
    });
    expect(sessionCookie(r, "sid", 60)).toContain("Secure");
  });

  test("adds Secure behind a TLS-terminating proxy", () => {
    const r = req("http://app.example.com/api/session", {
      host: "app.example.com",
      "x-forwarded-proto": "https",
    });
    expect(sessionCookie(r, "sid", 60)).toContain("Secure");
  });

  test("the cleared cookie expires immediately and holds no id", () => {
    const c = clearedSessionCookie(plain);
    expect(c).toContain("Max-Age=0");
    expect(c).toContain(`${SESSION_COOKIE}=`);
    expect(c).not.toContain("sid-value");
  });
});

describe("isSameOrigin", () => {
  test("accepts the app's own origin", () => {
    const r = req("http://localhost:3000/api/session", {
      host: "localhost:3000",
      origin: "http://localhost:3000",
    });
    expect(isSameOrigin(r)).toBe(true);
  });

  test("rejects a different origin", () => {
    const r = req("http://localhost:3000/api/session", {
      host: "localhost:3000",
      origin: "http://evil.test",
    });
    expect(isSameOrigin(r)).toBe(false);
  });

  test("rejects the same host on a different port", () => {
    const r = req("http://localhost:3000/api/session", {
      host: "localhost:3000",
      origin: "http://localhost:4000",
    });
    expect(isSameOrigin(r)).toBe(false);
  });

  test("rejects a missing Origin — browsers always send one here", () => {
    const r = req("http://localhost:3000/api/session", {
      host: "localhost:3000",
    });
    expect(isSameOrigin(r)).toBe(false);
  });

  test("compares the host only, not the scheme", () => {
    // A TLS-terminating proxy hands us plain HTTP while the browser sends the
    // https Origin it really used. Reconstructing our own scheme to compare
    // against would 403 every guarded route; the browser is what makes Origin
    // unforgeable, so the host match is the security property.
    const r = req("http://app.example.com/api/session", {
      host: "app.example.com",
      "x-forwarded-proto": "https",
      origin: "http://app.example.com",
    });
    expect(isSameOrigin(r)).toBe(true);
  });

  test("prefers X-Forwarded-Host over a proxy-rewritten Host", () => {
    const r = req("http://internal-svc:8080/api/session", {
      host: "internal-svc:8080",
      "x-forwarded-host": "app.example.com",
      origin: "https://app.example.com",
    });
    expect(isSameOrigin(r)).toBe(true);
  });

  test("rejects the opaque `null` Origin", () => {
    // What a sandboxed iframe or a redirected cross-site POST sends.
    const r = req("http://localhost:3000/api/session", {
      host: "localhost:3000",
      origin: "null",
    });
    expect(isSameOrigin(r)).toBe(false);
  });

  test("rejects an unparseable Origin", () => {
    const r = req("http://localhost:3000/api/session", {
      host: "localhost:3000",
      origin: "not-a-url",
    });
    expect(isSameOrigin(r)).toBe(false);
  });

  test("accepts the https Origin behind a TLS-terminating proxy", () => {
    const r = req("http://app.example.com/api/session", {
      host: "app.example.com",
      "x-forwarded-proto": "https",
      origin: "https://app.example.com",
    });
    expect(isSameOrigin(r)).toBe(true);
  });
});
