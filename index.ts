/**
 * Heyo webterminal — Bun server.
 *
 * Acts as a credential vault and stream proxy between the browser and the Heyo
 * cloud. The browser never holds the API key after the login POST, and never
 * talks to the Heyo cloud directly: the SDK's `ShellSession` puts its bearer
 * token in the WebSocket query string (browsers cannot set WS headers), so a
 * direct browser→cloud shell would expose the key in devtools and any proxy's
 * access log. Here the key stays in this process, in memory, keyed by an
 * opaque HttpOnly session cookie.
 */

import type { ShellEvent, ShellSession } from "@heyocomputer/sdk";

import index from "./public/index.html";
import * as heyo from "./src/heyo";
import {
  clearedSessionCookie,
  error as httpError,
  isSameOrigin,
  json,
  sessionCookie,
  sessionIdFrom,
} from "./src/http";
import * as sessions from "./src/sessions";

const PORT = Number(Bun.env.PORT ?? 3000);
const COOKIE_MAX_AGE_SECONDS = Math.floor(sessions.IDLE_TTL_MS / 1000);

/** Per-connection state for a proxied shell. Deliberately holds the session
 * *id*, not the API key — the key is read from the vault only at open time. */
interface ShellSocketData {
  sessionId: string;
  vmId: string;
  cols: number;
  rows: number;
  shell: ShellSession | null;
  /** Reserves a slot in the session's shell cap before the async open. */
  slot: sessions.ClosableShell | null;
  closed: boolean;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clampInt(
  raw: string | number | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Resolve the caller's session, or produce the 401 to return. The session
 * cookie is the *only* accepted credential — no route reads a key from a
 * header, body, or query string.
 */
function requireSession(
  req: Request,
): { sessionId: string; apiKey: string } | Response {
  const sessionId = sessionIdFrom(req);
  const session = sessions.touch(sessionId);
  if (!session || !sessionId) {
    return httpError(401, "No active session", {
      headers: { "set-cookie": clearedSessionCookie(req) },
    });
  }
  const apiKey = sessions.getApiKey(sessionId);
  if (!apiKey) {
    return httpError(401, "No active session", {
      headers: { "set-cookie": clearedSessionCookie(req) },
    });
  }
  return { sessionId, apiKey };
}

/** CSRF guard for anything that mutates state or opens a stream. */
function requireSameOrigin(req: Request): Response | null {
  if (isSameOrigin(req)) return null;
  return httpError(403, "Cross-origin request rejected");
}

/** Turn an SDK failure into a response. Logs the shape, never the credential. */
function sdkFailure(context: string, err: unknown): Response {
  const status = heyo.statusFor(err);
  console.error(`[${context}] ${status}: ${heyo.describe(err)}`);
  return httpError(status, heyo.describe(err));
}

/** Plain-object form of a shell lifecycle event (an `Error` JSON-stringifies
 * to `{}`, so the message has to be pulled out explicitly). */
function serializeEvent(evt: ShellEvent): Record<string, unknown> {
  switch (evt.type) {
    case "reconnecting":
      return { type: evt.type, attempt: evt.attempt, delayMs: evt.delayMs };
    case "reconnected":
      return { type: evt.type };
    case "closed":
      return {
        type: evt.type,
        exitCode: evt.exitCode,
        message: evt.error ? evt.error.message : null,
      };
    case "error":
      return { type: evt.type, message: evt.error.message };
  }
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

sessions.startSweeper();

const server = Bun.serve({
  port: PORT,

  routes: {
    "/": index,

    "/api/session": {
      /** Is the cookie we already hold still good? Used on page load. */
      GET(req) {
        const auth = requireSession(req);
        if (auth instanceof Response) return auth;
        return json({ ok: true });
      },

      /**
       * Exchange an API key for a session. The key is validated against the
       * cloud *before* a session is minted, so a bad key never produces a
       * cookie. The response body carries no key material.
       */
      async POST(req) {
        const csrf = requireSameOrigin(req);
        if (csrf) return csrf;

        let apiKey: unknown;
        try {
          ({ apiKey } = (await req.json()) as { apiKey?: unknown });
        } catch {
          return httpError(400, "Expected a JSON body");
        }
        if (typeof apiKey !== "string" || apiKey.length < 8) {
          return httpError(400, "Missing or malformed apiKey");
        }

        let valid: boolean;
        try {
          valid = await heyo.validateKey(apiKey);
        } catch (err) {
          return sdkFailure("validate-key", err);
        }
        if (!valid) return httpError(401, "The Heyo cloud rejected that key");

        const sessionId = sessions.create(apiKey);
        return json(
          { ok: true },
          {
            headers: {
              "set-cookie": sessionCookie(
                req,
                sessionId,
                COOKIE_MAX_AGE_SECONDS,
              ),
            },
          },
        );
      },

      /** Log out: kill live shells, forget the key, clear the cookie. */
      async DELETE(req) {
        const csrf = requireSameOrigin(req);
        if (csrf) return csrf;
        const sessionId = sessionIdFrom(req);
        if (sessionId) await sessions.destroy(sessionId);
        return json(
          { ok: true },
          { headers: { "set-cookie": clearedSessionCookie(req) } },
        );
      },
    },

    "/api/vms": {
      async GET(req) {
        const auth = requireSession(req);
        if (auth instanceof Response) return auth;
        try {
          return json(await heyo.listVms(auth.apiKey));
        } catch (err) {
          return sdkFailure("list-vms", err);
        }
      },
    },

    "/api/networks": {
      async GET(req) {
        const auth = requireSession(req);
        if (auth instanceof Response) return auth;
        try {
          return json({ networks: await heyo.listNetworks(auth.apiKey) });
        } catch (err) {
          return sdkFailure("list-networks", err);
        }
      },
    },

    "/api/networks/:id/members": {
      async POST(req) {
        const csrf = requireSameOrigin(req);
        if (csrf) return csrf;
        const auth = requireSession(req);
        if (auth instanceof Response) return auth;

        let vmId: unknown;
        try {
          ({ vmId } = (await req.json()) as { vmId?: unknown });
        } catch {
          return httpError(400, "Expected a JSON body");
        }
        if (typeof vmId !== "string" || !vmId) {
          return httpError(400, "Missing vmId");
        }

        try {
          // The member kind is derived server-side from our own VM listing;
          // the client cannot choose it.
          const member = await heyo.addVmToNetwork(
            auth.apiKey,
            req.params.id,
            vmId,
          );
          return json({ member });
        } catch (err) {
          return sdkFailure("add-member", err);
        }
      },
    },

    "/ws/shell": (req, srv) => {
      const csrf = requireSameOrigin(req);
      if (csrf) return csrf;
      const auth = requireSession(req);
      if (auth instanceof Response) return auth;

      const url = new URL(req.url);
      const vmId = url.searchParams.get("vm");
      if (!vmId) return httpError(400, "Missing ?vm");

      const data: ShellSocketData = {
        sessionId: auth.sessionId,
        vmId,
        cols: clampInt(url.searchParams.get("cols"), 80, 20, 500),
        rows: clampInt(url.searchParams.get("rows"), 24, 5, 200),
        shell: null,
        slot: null,
        closed: false,
      };

      if (srv.upgrade(req, { data })) return undefined;
      return httpError(400, "WebSocket upgrade failed");
    },
  },

  fetch() {
    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    data: {} as ShellSocketData,
    // A PTY can idle for a long time between keystrokes.
    idleTimeout: 600,
    // A slow client shouldn't balloon this process; drop it instead.
    backpressureLimit: 8 * 1024 * 1024,
    closeOnBackpressureLimit: true,

    async open(ws) {
      const data = ws.data;
      const apiKey = sessions.getApiKey(data.sessionId);
      if (!apiKey) {
        ws.close(4401, "Session expired");
        return;
      }

      // Reserve a shell slot *before* awaiting, so N parallel connects can't
      // race past the per-session cap.
      const slot: sessions.ClosableShell = {
        kill: async () => {
          await data.shell?.kill();
        },
      };
      if (!sessions.registerShell(data.sessionId, slot)) {
        ws.send(
          JSON.stringify({
            type: "fatal",
            message: `Too many open shells (max ${sessions.MAX_SHELLS_PER_SESSION}). Close one first.`,
          }),
        );
        ws.close(4429, "Shell limit reached");
        return;
      }
      data.slot = slot;

      let shell: ShellSession;
      try {
        shell = await heyo.openShell(apiKey, data.vmId, {
          cols: data.cols,
          rows: data.rows,
        });
      } catch (err) {
        console.error(`[shell-open] ${data.vmId}: ${heyo.describe(err)}`);
        sessions.unregisterShell(data.sessionId, slot);
        data.slot = null;
        if (!data.closed) {
          ws.send(
            JSON.stringify({ type: "fatal", message: heyo.describe(err) }),
          );
          ws.close(4500, "Could not open shell");
        }
        return;
      }

      // The browser may have gone away while we were connecting upstream.
      if (data.closed) {
        sessions.unregisterShell(data.sessionId, slot);
        await shell.kill();
        return;
      }

      data.shell = shell;
      shell.onData((chunk) => {
        if (!data.closed) ws.send(chunk);
      });
      shell.on((evt) => {
        if (data.closed) return;
        ws.send(JSON.stringify(serializeEvent(evt)));
        if (evt.type === "closed") ws.close(1000, "Shell closed");
      });
      ws.send(JSON.stringify({ type: "ready", vmId: data.vmId }));
    },

    async message(ws, message) {
      const shell = ws.data.shell;
      if (!shell) return;

      // Text frames are control messages; keystrokes arrive as binary so the
      // two can never be confused.
      if (typeof message === "string") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(message);
        } catch {
          return;
        }
        const msg = parsed as { type?: string; cols?: number; rows?: number };
        if (msg.type === "resize") {
          await shell.resize(
            clampInt(msg.cols, ws.data.cols, 20, 500),
            clampInt(msg.rows, ws.data.rows, 5, 200),
          );
        }
        return;
      }

      await shell.write(message);
    },

    async close(ws) {
      const data = ws.data;
      data.closed = true;
      if (data.slot) {
        sessions.unregisterShell(data.sessionId, data.slot);
        data.slot = null;
      }
      const shell = data.shell;
      data.shell = null;
      await shell?.kill();
    },
  },

  development: Bun.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`Heyo webterminal listening on ${server.url}`);
