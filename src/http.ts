/**
 * Small HTTP helpers: cookie handling, same-origin enforcement, and JSON
 * responses. Kept separate from routing so the security-relevant bits are in
 * one readable place.
 */

/** Name of the session cookie. The value is an opaque id, never a credential. */
export const SESSION_COOKIE = "hwt_sid";

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export function sessionIdFrom(req: Request): string | undefined {
  return parseCookies(req.headers.get("cookie"))[SESSION_COOKIE];
}

/** True when the request arrived over TLS (directly or via a proxy). */
function isSecureRequest(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]!.trim() === "https";
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * `Set-Cookie` for the session. `HttpOnly` keeps it out of `document.cookie`
 * (so page XSS can't read it), `SameSite=Strict` stops cross-site requests
 * from riding it, and `Secure` is added whenever we're actually on TLS.
 */
export function sessionCookie(
  req: Request,
  id: string,
  maxAgeSeconds: number,
): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(id)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  return parts.join("; ");
}

/** `Set-Cookie` that immediately clears the session cookie. */
export function clearedSessionCookie(req: Request): string {
  return sessionCookie(req, "", 0);
}

/** The host this request was addressed to, as the browser sees it. Behind a
 * proxy that rewrites `Host`, `X-Forwarded-Host` is the browser-visible one. */
function requestHost(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-host");
  if (forwarded) {
    const first = forwarded.split(",")[0]!.trim();
    if (first) return first;
  }
  return req.headers.get("host");
}

/**
 * CSRF guard. `SameSite=Strict` already blocks cross-site cookie carriage in
 * modern browsers; this is the belt to that suspenders, and it also covers the
 * WebSocket upgrade (a GET, which SameSite treats less strictly across
 * browser versions).
 *
 * A missing `Origin` is rejected too: every browser sends one on the requests
 * this guards, so its absence means the caller isn't the app. `null` — what a
 * sandboxed iframe or a redirected cross-site POST sends — is likewise not us.
 *
 * Only the *host* is compared, not the scheme. The security property comes from
 * the browser: a page at another origin cannot forge `Origin`, whatever scheme
 * it claims. Reconstructing our own scheme, by contrast, is guesswork the
 * moment a TLS-terminating proxy sits in front of us — it hands us plain HTTP,
 * so we'd expect `http://host` while the browser truthfully sends
 * `https://host` and every guarded route 403s.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") return false;
  const host = requestHost(req);
  if (!host) return false;
  let originHost: string;
  try {
    ({ host: originHost } = new URL(origin));
  } catch {
    return false;
  }
  return originHost !== "" && originHost === host;
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function error(
  status: number,
  message: string,
  init: ResponseInit = {},
): Response {
  return json({ error: message }, { ...init, status });
}
