import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import * as sessions from "./sessions";

/** Controllable clock so TTL behaviour is tested without sleeping. */
let now = 1_000_000;
const advance = (ms: number) => {
  now += ms;
};

beforeEach(() => {
  now = 1_000_000;
  sessions.__setClock(() => now);
  sessions.__reset();
});

afterEach(() => {
  sessions.__setClock(null);
  sessions.__reset();
});

function fakeShell() {
  const shell = {
    killed: false,
    kill() {
      shell.killed = true;
    },
  };
  return shell;
}

describe("session ids", () => {
  test("are opaque, unique, and long", () => {
    const a = sessions.create("heyo_api_aaa");
    const b = sessions.create("heyo_api_bbb");
    expect(a).not.toBe(b);
    // 32 random bytes, base64url encoded.
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("credential isolation", () => {
  test("each session resolves only its own key", () => {
    const a = sessions.create("key-a");
    const b = sessions.create("key-b");
    expect(sessions.getApiKey(a)).toBe("key-a");
    expect(sessions.getApiKey(b)).toBe("key-b");
  });

  test("an unknown id resolves to nothing", () => {
    sessions.create("key-a");
    expect(sessions.touch("not-a-real-id")).toBeUndefined();
    expect(sessions.getApiKey("not-a-real-id")).toBeUndefined();
  });

  test("the session record carries no credential", () => {
    const id = sessions.create("super-secret-key");
    const session = sessions.touch(id)!;
    expect(JSON.stringify(session)).not.toContain("super-secret-key");
    expect(Object.values(session)).not.toContain("super-secret-key");
  });
});

describe("expiry", () => {
  test("touch refreshes the idle clock", () => {
    const id = sessions.create("key");
    advance(sessions.IDLE_TTL_MS - 1);
    expect(sessions.touch(id)).toBeDefined();
    // The refresh means another near-full idle window is available.
    advance(sessions.IDLE_TTL_MS - 1);
    expect(sessions.touch(id)).toBeDefined();
  });

  test("an idle session expires and is destroyed", () => {
    const id = sessions.create("key");
    advance(sessions.IDLE_TTL_MS);
    expect(sessions.touch(id)).toBeUndefined();
    expect(sessions.getApiKey(id)).toBeUndefined();
    expect(sessions.count()).toBe(0);
  });

  test("the absolute cap expires an actively used session", () => {
    const id = sessions.create("key");
    // Stay active, well inside the idle window, until the hard cap passes.
    for (let t = 0; t < sessions.ABSOLUTE_TTL_MS; t += sessions.IDLE_TTL_MS / 2) {
      advance(sessions.IDLE_TTL_MS / 2);
      if (!sessions.touch(id)) break;
    }
    expect(sessions.touch(id)).toBeUndefined();
  });

  test("sweep reaps expired sessions and kills their shells", async () => {
    const id = sessions.create("key");
    const shell = fakeShell();
    sessions.registerShell(id, shell);

    advance(sessions.IDLE_TTL_MS);
    expect(sessions.sweep()).toBe(1);
    // destroy() is async; let its shell teardown settle.
    await Promise.resolve();
    expect(shell.killed).toBe(true);
    expect(sessions.count()).toBe(0);
  });

  test("sweep leaves live sessions alone", () => {
    sessions.create("key");
    advance(sessions.IDLE_TTL_MS - 1);
    expect(sessions.sweep()).toBe(0);
    expect(sessions.count()).toBe(1);
  });
});

describe("shells", () => {
  test("destroy kills every registered shell and forgets the key", async () => {
    const id = sessions.create("key");
    const a = fakeShell();
    const b = fakeShell();
    sessions.registerShell(id, a);
    sessions.registerShell(id, b);

    await sessions.destroy(id);

    expect(a.killed).toBe(true);
    expect(b.killed).toBe(true);
    expect(sessions.getApiKey(id)).toBeUndefined();
    expect(sessions.touch(id)).toBeUndefined();
  });

  test("registration is capped per session", () => {
    const id = sessions.create("key");
    for (let i = 0; i < sessions.MAX_SHELLS_PER_SESSION; i++) {
      expect(sessions.registerShell(id, fakeShell())).toBe(true);
    }
    expect(sessions.registerShell(id, fakeShell())).toBe(false);
  });

  test("unregistering frees a slot", () => {
    const id = sessions.create("key");
    const shells = Array.from({ length: sessions.MAX_SHELLS_PER_SESSION }, () =>
      fakeShell(),
    );
    for (const s of shells) sessions.registerShell(id, s);
    expect(sessions.registerShell(id, fakeShell())).toBe(false);

    sessions.unregisterShell(id, shells[0]!);
    expect(sessions.registerShell(id, fakeShell())).toBe(true);
  });

  test("registering against an unknown session fails", () => {
    expect(sessions.registerShell("nope", fakeShell())).toBe(false);
  });

  test("one session's shells are unaffected by another's teardown", async () => {
    const a = sessions.create("key-a");
    const b = sessions.create("key-b");
    const shellA = fakeShell();
    const shellB = fakeShell();
    sessions.registerShell(a, shellA);
    sessions.registerShell(b, shellB);

    await sessions.destroy(a);

    expect(shellA.killed).toBe(true);
    expect(shellB.killed).toBe(false);
    expect(sessions.getApiKey(b)).toBe("key-b");
  });
});
