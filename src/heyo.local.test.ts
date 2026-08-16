/**
 * The same-host shortcut.
 *
 * When the daemon hosting a sandbox *is* this machine, there is no reason to
 * ask the cloud to tunnel back into it. These tests stand up a stub standing in
 * for `heyvmd`'s `/health` and check that the shortcut is taken only when the
 * daemon identifies itself as the one the VM was listed under.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const KEY = "heyo_api_test";

const state = {
  daemons: [] as { id: string; name: string; status: string; lastSeenAt: string; createdAt: string }[],
  daemonSandboxes: new Map<string, unknown>(),
  shell: null as { sandboxId: string; options: { pathOverride?: string } } | null,
  clientOptions: null as { baseUrl?: string; apiKey?: string } | null,
};

const real = await import("@heyocomputer/sdk");

mock.module("@heyocomputer/sdk", () => ({
  ...real,
  Sandbox: { list: async () => [], connect: () => ({ shell: async () => ({}) }) },
  Daemons: {
    list: async () => state.daemons,
    listSandboxes: async (id: string) =>
      state.daemonSandboxes.get(id) ?? { daemonId: id, daemonName: id, sandboxes: [] },
  },
  Network: real.Network,
  HeyoClient: class {
    constructor(opts: { baseUrl?: string; apiKey?: string }) {
      state.clientOptions = opts;
    }
  },
  ShellSession: class {
    constructor(_c: unknown, sandboxId: string, options: { pathOverride?: string }) {
      state.shell = { sandboxId, options };
    }
    async open() {}
  },
}));

// Stands in for the loopback daemon. Port 0 lets the OS pick a free one.
let daemonId = "hd-local";
const stub = Bun.serve({
  port: 0,
  fetch(req) {
    if (new URL(req.url).pathname === "/health") {
      return Response.json({ backendId: daemonId, status: "ok" });
    }
    return new Response("nope", { status: 404 });
  },
});

process.env.HEYO_LOCAL_DAEMON_URL = `http://127.0.0.1:${stub.port}`;
delete process.env.HEYO_DISABLE_LOCAL_DAEMON;

const heyo = await import("./heyo");

afterAll(() => stub.stop(true));

function daemon(id: string) {
  return {
    id,
    name: `box-${id}`,
    status: "online",
    lastSeenAt: "2026-08-15T12:00:00Z",
    createdAt: "2026-08-01T12:00:00Z",
  };
}

/** Register one sandbox as living on `daemonId`. */
function hostedOn(id: string, sandboxId: string) {
  state.daemons = [daemon(id)];
  state.daemonSandboxes.set(id, {
    daemonId: id,
    daemonName: `box-${id}`,
    sandboxes: [
      { id: sandboxId, name: "test-apple", status: "running", image: "ubuntu-24.04" },
    ],
  });
}

beforeEach(() => {
  state.daemons = [];
  state.daemonSandboxes = new Map();
  state.shell = null;
  state.clientOptions = null;
  daemonId = "hd-local";
  delete process.env.HEYO_DISABLE_LOCAL_DAEMON;
  heyo.__resetLocalDaemonProbe();
});

describe("same-host shortcut", () => {
  test("a sandbox on this machine attaches straight through heyvmd", async () => {
    hostedOn("hd-local", "sb-31782662");

    await heyo.openShell(KEY, "sb-31782662", { cols: 80, rows: 24 });

    expect(state.shell!.options.pathOverride).toBe(
      "/sandboxes/sb-31782662/shell-stream",
    );
    expect(state.clientOptions!.baseUrl).toBe(
      `http://127.0.0.1:${stub.port}`,
    );
    // A loopback daemon needs no credential, and an empty string (rather than
    // undefined) stops the SDK falling back to process.env.HEYO_API_KEY.
    expect(state.clientOptions!.apiKey).toBe("");
  });

  test("a sandbox on a different daemon still goes through the cloud", async () => {
    // Same sandbox id, but the local daemon reports a different identity —
    // ids are short, so this must not be treated as the same box.
    daemonId = "hd-someone-else";
    hostedOn("hd-remote", "sb-31782662");

    await heyo.openShell(KEY, "sb-31782662", {});

    expect(state.shell!.options.pathOverride).toBe(
      "/me/daemons/hd-remote/sandboxes/sb-31782662/shell-stream",
    );
  });

  test("the shortcut can be turned off", async () => {
    process.env.HEYO_DISABLE_LOCAL_DAEMON = "1";
    hostedOn("hd-local", "sb-31782662");

    await heyo.openShell(KEY, "sb-31782662", {});

    expect(state.shell!.options.pathOverride).toBe(
      "/me/daemons/hd-local/sandboxes/sb-31782662/shell-stream",
    );
  });

  test("no daemon on loopback falls back to the cloud", async () => {
    process.env.HEYO_LOCAL_DAEMON_URL = "http://127.0.0.1:1";
    heyo.__resetLocalDaemonProbe();
    hostedOn("hd-local", "sb-31782662");

    await heyo.openShell(KEY, "sb-31782662", {});

    expect(state.shell!.options.pathOverride).toBe(
      "/me/daemons/hd-local/sandboxes/sb-31782662/shell-stream",
    );
    process.env.HEYO_LOCAL_DAEMON_URL = `http://127.0.0.1:${stub.port}`;
  });
});
