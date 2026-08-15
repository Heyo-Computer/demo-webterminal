/**
 * Ephemeral session store — the only place a heyvm API key ever lives.
 *
 * Design constraints, in order of importance:
 *
 *  1. The key is never persisted. There is no file, no database, no env write.
 *     Restarting the process invalidates every session by construction.
 *  2. The key is never handed back to the browser, and never appears in a log
 *     line. `Session` (the record every other module sees) has no `apiKey`
 *     field at all — the keys live in a separate module-private map that only
 *     {@link getApiKey} can read. So a stray `console.log(session)` or
 *     `JSON.stringify(session)` structurally cannot leak it.
 *  3. Sessions expire on both an idle clock (refreshed by each authenticated
 *     request) and an absolute clock, and expiry tears down any live shells.
 */

/** Minimum surface the store needs from a shell in order to clean it up. The
 * SDK's `ShellSession` satisfies this; tests pass fakes. */
export interface ClosableShell {
  kill(): Promise<void> | void;
}

/** Session metadata. Deliberately contains no credential material. */
export interface Session {
  readonly id: string;
  readonly createdAt: number;
  lastSeenAt: number;
  readonly shells: Set<ClosableShell>;
}

/** Idle timeout — refreshed every time the session authenticates a request. */
export const IDLE_TTL_MS = 30 * 60_000;
/** Hard cap on session lifetime regardless of activity. */
export const ABSOLUTE_TTL_MS = 8 * 60 * 60_000;
/** How often expired sessions are swept. */
export const SWEEP_INTERVAL_MS = 60_000;
/** Concurrent shells one session may hold open, so a single tab can't fan out. */
export const MAX_SHELLS_PER_SESSION = 4;

/**
 * id → API key. Module-private and intentionally separate from `sessions` so
 * the credential is not reachable from any object we pass around.
 */
const keys = new Map<string, string>();
const sessions = new Map<string, Session>();

/** Injectable clock so tests can advance time without sleeping. */
let clock: () => number = () => Date.now();

/** @internal test-only */
export function __setClock(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

/** Opaque 256-bit session id. Not `randomUUID` — that is only 122 bits and
 * carries version/variant structure we don't want in a bearer-equivalent. */
function newSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

function isExpired(session: Session, now: number): boolean {
  return (
    now - session.lastSeenAt >= IDLE_TTL_MS ||
    now - session.createdAt >= ABSOLUTE_TTL_MS
  );
}

/** Mint a session for a key that has already been validated against the cloud. */
export function create(apiKey: string): string {
  const id = newSessionId();
  const now = clock();
  sessions.set(id, {
    id,
    createdAt: now,
    lastSeenAt: now,
    shells: new Set(),
  });
  keys.set(id, apiKey);
  return id;
}

/**
 * Resolve a session id and refresh its idle clock. Returns `undefined` for an
 * unknown id, and destroys-then-returns-`undefined` for an expired one, so
 * callers can treat both as a plain 401.
 */
export function touch(id: string | undefined | null): Session | undefined {
  if (!id) return undefined;
  const session = sessions.get(id);
  if (!session) return undefined;
  const now = clock();
  if (isExpired(session, now)) {
    void destroy(id);
    return undefined;
  }
  session.lastSeenAt = now;
  return session;
}

/**
 * The credential for a live session.
 *
 * Callers must pass the result straight into an SDK call. Never log it, never
 * put it in a response body, never store it anywhere else.
 */
export function getApiKey(id: string): string | undefined {
  return keys.get(id);
}

/** Tear a session down: kill its shells, then forget it and its key. */
export async function destroy(id: string): Promise<void> {
  const session = sessions.get(id);
  keys.delete(id);
  sessions.delete(id);
  if (!session) return;
  const shells = [...session.shells];
  session.shells.clear();
  await Promise.allSettled(shells.map((shell) => shell.kill()));
}

/**
 * Attach a shell to a session so it dies with it. Returns `false` when the
 * session is already at {@link MAX_SHELLS_PER_SESSION}; the caller should
 * reject the connection rather than silently exceed the cap.
 */
export function registerShell(id: string, shell: ClosableShell): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.shells.size >= MAX_SHELLS_PER_SESSION) return false;
  session.shells.add(shell);
  return true;
}

export function unregisterShell(id: string, shell: ClosableShell): void {
  sessions.get(id)?.shells.delete(shell);
}

/** Number of live sessions. Diagnostics only — exposes nothing sensitive. */
export function count(): number {
  return sessions.size;
}

/** Drop every expired session. Returns how many were reaped. */
export function sweep(): number {
  const now = clock();
  let reaped = 0;
  for (const [id, session] of sessions) {
    if (isExpired(session, now)) {
      void destroy(id);
      reaped += 1;
    }
  }
  return reaped;
}

let sweeper: ReturnType<typeof setInterval> | null = null;

export function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(sweep, SWEEP_INTERVAL_MS);
  // Don't let the reaper alone keep the process alive.
  sweeper.unref?.();
}

export function stopSweeper(): void {
  if (!sweeper) return;
  clearInterval(sweeper);
  sweeper = null;
}

/** @internal test-only — drop all state without running shell teardown. */
export function __reset(): void {
  sessions.clear();
  keys.clear();
}
