/**
 * The SDK wrappers, with the cloud stubbed out.
 *
 * The cases that matter here are the failure ones: a daemon that is powered
 * off makes the cloud answer 502, and an account that has never touched
 * networks has no rows for `GET /networks` to return. Neither may take the
 * picker down with it.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { ApiError, AuthenticationError, NotFoundError } from "@heyocomputer/sdk";

const KEY = "heyo_api_test";

interface StubDaemon {
  id: string;
  name: string | null;
  status: "online" | "stale" | "offline";
  lastSeenAt: string;
  createdAt: string;
}

const state = {
  sandboxes: [] as unknown[],
  sandboxError: null as unknown,
  daemons: [] as StubDaemon[],
  daemonSandboxes: new Map<string, unknown>(),
  daemonErrors: new Map<string, unknown>(),
  /** Every daemon id we actually dialed, so we can assert we skipped some. */
  dialed: [] as string[],
  networkList: null as unknown,
  networkListError: null as unknown,
  defaultNetwork: null as unknown,
  defaultNetworkError: null as unknown,
  members: [] as unknown[],
  cloudShell: null as { id: string; options: unknown } | null,
  daemonShell: null as
    | { sandboxId: string; options: { pathOverride?: string } }
    | null,
  daemonShellOpened: false,
  clientOptions: null as unknown,
};

function cloudSandbox(id: string, status = "running") {
  return { id, name: id, status, image: "ubuntu:24.04" };
}

function daemon(
  id: string,
  status: StubDaemon["status"] = "online",
): StubDaemon {
  return {
    id,
    name: `box-${id}`,
    status,
    lastSeenAt: "2026-08-15T12:00:00Z",
    createdAt: "2026-08-01T12:00:00Z",
  };
}

function networkInfo(id: string, isDefault = false) {
  return { id, name: id, isDefault, description: null };
}

// Only the network-touching statics are stubbed; the error classes stay real
// so the `instanceof` checks inside heyo.ts behave exactly as in production.
const real = await import("@heyocomputer/sdk");

mock.module("@heyocomputer/sdk", () => ({
  ...real,
  Sandbox: {
    list: async () => {
      if (state.sandboxError) throw state.sandboxError;
      return state.sandboxes;
    },
    connect: (id: string) => ({
      shell: async (options: unknown) => {
        state.cloudShell = { id, options };
        return { via: "cloud" };
      },
    }),
  },
  HeyoClient: class {
    constructor(opts: unknown) {
      state.clientOptions = opts;
    }
  },
  ShellSession: class {
    via = "daemon";
    constructor(_client: unknown, sandboxId: string, options: { pathOverride?: string }) {
      state.daemonShell = { sandboxId, options };
    }
    async open() {
      state.daemonShellOpened = true;
    }
  },
  Daemons: {
    list: async () => state.daemons,
    listSandboxes: async (id: string) => {
      state.dialed.push(id);
      const err = state.daemonErrors.get(id);
      if (err) throw err;
      return (
        state.daemonSandboxes.get(id) ?? {
          daemonId: id,
          daemonName: id,
          sandboxes: [],
        }
      );
    },
  },
  Network: {
    list: async () => {
      if (state.networkListError) throw state.networkListError;
      return state.networkList ?? [];
    },
    default: async () => {
      if (state.defaultNetworkError) throw state.defaultNetworkError;
      return { info: () => state.defaultNetwork };
    },
    get: async (id: string) => ({
      id,
      listMembers: async () => state.members,
    }),
  },
}));

const heyo = await import("./heyo");

beforeEach(() => {
  state.sandboxes = [];
  state.sandboxError = null;
  state.daemons = [];
  state.daemonSandboxes = new Map();
  state.daemonErrors = new Map();
  state.dialed = [];
  state.networkList = null;
  state.networkListError = null;
  state.defaultNetwork = networkInfo("net-default", true);
  state.defaultNetworkError = null;
  state.members = [];
  state.cloudShell = null;
  state.daemonShell = null;
  state.daemonShellOpened = false;
  state.clientOptions = null;
});

describe("openShell", () => {
  test("a cloud VM streams from the deployed-sandbox endpoint", async () => {
    state.sandboxes = [cloudSandbox("dep-1")];

    await heyo.openShell(KEY, "dep-1", { cols: 100, rows: 30 });

    expect(state.cloudShell).toEqual({
      id: "dep-1",
      options: { cols: 100, rows: 30 },
    });
    expect(state.daemonShell).toBeNull();
  });

  test("a daemon-native VM streams from its daemon's endpoint", async () => {
    // `/deployed-sandboxes/{id}/shell-stream` cannot resolve an `sb-…` id —
    // the cloud closes the socket before `ready`. This is that regression.
    state.daemons = [daemon("hd-1")];
    state.daemonSandboxes.set("hd-1", {
      daemonId: "hd-1",
      daemonName: "box-hd-1",
      sandboxes: [
        {
          id: "sb-31782662",
          name: "test-apple",
          status: "running",
          image: "ubuntu-24.04",
          isDeployed: false,
        },
      ],
    });

    await heyo.openShell(KEY, "sb-31782662", { cols: 80, rows: 24 });

    expect(state.cloudShell).toBeNull();
    expect(state.daemonShellOpened).toBe(true);
    expect(state.daemonShell!.options.pathOverride).toBe(
      "/me/daemons/hd-1/sandboxes/sb-31782662/shell-stream",
    );
    // The caller's sizing survives the path rewrite.
    expect(state.daemonShell!.options).toMatchObject({ cols: 80, rows: 24 });
  });

  test("a VM this session cannot see is a 404, not a shell", async () => {
    state.sandboxes = [cloudSandbox("dep-1")];

    await expect(heyo.openShell(KEY, "dep-someone-elses", {})).rejects.toThrow(
      /No VM dep-someone-elses is visible to this session/,
    );
    expect(state.cloudShell).toBeNull();
    expect(state.daemonShell).toBeNull();
  });
});

describe("listVms", () => {
  test("an unreachable daemon becomes a warning, not a failure", async () => {
    state.sandboxes = [cloudSandbox("dep-1")];
    state.daemons = [daemon("hd-1")];
    state.daemonErrors.set(
      "hd-1",
      new ApiError(502, "no route to daemon", { error: "Failed to reach daemon" }),
    );

    const listing = await heyo.listVms(KEY);

    // The cloud VM still made it through.
    expect(listing.vms.map((v) => v.id)).toEqual(["dep-1"]);
    expect(listing.warnings).toHaveLength(1);
    expect(listing.warnings[0]!.source).toBe("hd-1");
    // The message explains the actual cause rather than echoing "502".
    expect(listing.warnings[0]!.message).toContain("heyvmd");
    expect(listing.warnings[0]!.message).not.toContain("502");
  });

  test("offline and stale daemons are never dialed", async () => {
    state.daemons = [daemon("hd-up"), daemon("hd-off", "offline"), daemon("hd-stale", "stale")];

    const listing = await heyo.listVms(KEY);

    expect(state.dialed).toEqual(["hd-up"]);
    expect(listing.warnings.map((w) => w.source).sort()).toEqual([
      "hd-off",
      "hd-stale",
    ]);
    expect(
      listing.warnings.find((w) => w.source === "hd-off")!.message,
    ).toContain("offline");
  });

  test("daemon VMs are merged in and tagged with their source", async () => {
    state.sandboxes = [cloudSandbox("dep-1")];
    state.daemons = [daemon("hd-1")];
    state.daemonSandboxes.set("hd-1", {
      daemonId: "hd-1",
      daemonName: "box-hd-1",
      sandboxes: [
        { id: "sb-1", name: "local", status: "ready", image: "alpine", isDeployed: false },
      ],
    });

    const listing = await heyo.listVms(KEY);

    expect(listing.warnings).toEqual([]);
    const local = listing.vms.find((v) => v.id === "sb-1")!;
    expect(local.kind).toBe("local");
    expect(local.source).toBe("hd-1");
    // `ready` is a shellable state for ephemeral backends.
    expect(local.shellable).toBe(true);
  });

  test("a cloud outage degrades instead of throwing", async () => {
    state.sandboxError = new ApiError(
      0,
      "Network error calling /deployed-sandboxes",
    );
    state.daemons = [daemon("hd-1")];
    state.daemonSandboxes.set("hd-1", {
      daemonId: "hd-1",
      daemonName: "box-hd-1",
      sandboxes: [
        { id: "sb-1", name: "local", status: "running", image: "alpine" },
      ],
    });

    const listing = await heyo.listVms(KEY);

    // Cloud is down, but the daemon's VMs are still usable.
    expect(listing.vms.map((v) => v.id)).toEqual(["sb-1"]);
    expect(listing.warnings.map((w) => w.source)).toEqual(["cloud"]);
  });
});

describe("listNetworks", () => {
  test("falls back to the default network when the list comes back empty", async () => {
    // `GET /networks` lists existing rows only — a fresh account has none
    // until `GET /networks/me` creates the default.
    state.networkList = [];

    const { networks, warning } = await heyo.listNetworks(KEY);

    expect(networks).toHaveLength(1);
    expect(networks[0]!.id).toBe("net-default");
    expect(networks[0]!.isDefault).toBe(true);
    expect(warning).toBeNull();
  });

  test("degrades to the default network when listing fails", async () => {
    state.networkListError = new ApiError(500, "Failed to list networks");

    const { networks, warning } = await heyo.listNetworks(KEY);

    expect(networks.map((n) => n.id)).toEqual(["net-default"]);
    expect(warning).toContain("Failed to list networks");
  });

  test("rethrows when neither the list nor the default is reachable", async () => {
    state.networkListError = new AuthenticationError("Unauthorized");
    state.defaultNetworkError = new AuthenticationError("Unauthorized");

    await expect(heyo.listNetworks(KEY)).rejects.toThrow("Unauthorized");
  });

  test("a failed member fetch is per-network, not fatal", async () => {
    state.networkList = [networkInfo("net-a", true), networkInfo("net-b")];
    state.members = [];

    const { networks } = await heyo.listNetworks(KEY);

    expect(networks.map((n) => n.id)).toEqual(["net-a", "net-b"]);
    expect(networks.every((n) => n.membersError === null)).toBe(true);
  });
});

describe("statusFor", () => {
  test("maps a no-response ApiError to 504, not 502", () => {
    // status 0 is the SDK's "the request never completed" — a timeout or a
    // socket error. Reporting that as 502 told users their gateway was bad.
    expect(heyo.statusFor(new ApiError(0, "timed out"))).toBe(504);
  });

  test("passes through a real upstream status", () => {
    expect(heyo.statusFor(new ApiError(502, "Failed to reach daemon"))).toBe(502);
    expect(heyo.statusFor(new ApiError(500, "boom"))).toBe(500);
  });

  test("maps the typed SDK errors", () => {
    expect(heyo.statusFor(new AuthenticationError("nope"))).toBe(401);
    expect(heyo.statusFor(new NotFoundError("gone"))).toBe(404);
    expect(heyo.statusFor(new TypeError("bug"))).toBe(500);
  });
});
