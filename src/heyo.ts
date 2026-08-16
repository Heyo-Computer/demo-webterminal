/**
 * Thin wrappers over `@heyocomputer/sdk`.
 *
 * Every function takes the API key as its first argument and never stores it —
 * the caller pulls it from the session vault (`src/sessions.ts`) for the
 * duration of one request and lets it fall out of scope.
 */

import {
  ApiError,
  AuthenticationError,
  ConnectionError,
  Daemons,
  HeyoClient,
  InvalidArgumentError,
  Network,
  NotFoundError,
  Sandbox,
  ShellSession,
  type DaemonInfo,
  type NetworkInfo,
  type NetworkMember,
  type NetworkMemberKind,
  type ShellOptions,
} from "@heyocomputer/sdk";

/** A VM the user can pick, flattened across cloud and daemon-hosted sources. */
export interface VmSummary {
  id: string;
  name: string;
  status: string;
  image: string;
  /** `"cloud"` or the owning daemon's `hd-…` id. */
  source: string;
  /** Human label for the source group. */
  sourceLabel: string;
  /** Network member kind to register this VM under. */
  kind: NetworkMemberKind;
  /** Whether a shell can be opened right now. */
  shellable: boolean;
}

/** A daemon we could not reach — surfaced instead of failing the whole list. */
export interface VmSourceWarning {
  source: string;
  sourceLabel: string;
  message: string;
}

export interface VmListing {
  vms: VmSummary[];
  warnings: VmSourceWarning[];
}

export interface NetworkSummary {
  id: string;
  name: string;
  isDefault: boolean;
  description: string | null;
  members: NetworkMember[];
  /** Set when the member list could not be fetched. */
  membersError: string | null;
}

export interface NetworkListing {
  networks: NetworkSummary[];
  /** Set when the list is incomplete but still usable. */
  warning: string | null;
}

/** Cloud statuses that permit an interactive shell. */
const CLOUD_SHELLABLE = new Set(["running"]);
/** Daemon-native statuses that permit an interactive shell. `ready` is what
 * ephemeral backends report in place of `running`. */
const DAEMON_SHELLABLE = new Set(["running", "ready"]);

/**
 * Daemon round-trips get a much shorter leash than the SDK's 60s default.
 * `GET /me/daemons/{id}/sandboxes` is not a database read — the cloud dials
 * the daemon over iroh and proxies the call into it. A daemon that is powered
 * off burns most of that default before the cloud gives up and answers 502,
 * which would leave the picker spinning on an outcome we already know.
 */
const DAEMON_TIMEOUT_MS = 10_000;

/**
 * The `heyvmd` running on this same machine, if there is one.
 *
 * A daemon sandbox is normally reached by asking the cloud to proxy into its
 * daemon over iroh. When the daemon *is* this host that round trip buys
 * nothing: `heyvmd` serves the same `/sandboxes/{id}/shell-stream` endpoint
 * directly, unauthenticated, on loopback. The SDK ships `HeyoClient.local()`
 * for exactly this case.
 *
 * We only take the shortcut when the local daemon's own id matches the one
 * the VM was listed under — sandbox ids are short, and connecting to a
 * same-named sandbox on a different machine would be a real mix-up.
 */
const LOCAL_PROBE_TTL_MS = 30_000;

/** Read at call time, not module load, so tests and `bun --hot` can change it. */
function localDaemonUrl(): string {
  return Bun.env.HEYO_LOCAL_DAEMON_URL ?? "http://127.0.0.1:34099";
}

let localProbe: { id: string | null; at: number } | null = null;

/** Forget the cached probe. For tests. */
export function __resetLocalDaemonProbe(): void {
  localProbe = null;
}

async function localDaemonId(): Promise<string | null> {
  if (Bun.env.HEYO_DISABLE_LOCAL_DAEMON === "1") return null;
  const now = Date.now();
  if (localProbe && now - localProbe.at < LOCAL_PROBE_TTL_MS) {
    return localProbe.id;
  }
  let id: string | null = null;
  try {
    const res = await fetch(`${localDaemonUrl()}/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (res.ok) {
      ({ backendId: id = null } = (await res.json()) as { backendId?: string });
    }
  } catch {
    // No daemon here, or not answering. The cloud route is the fallback.
  }
  // Negative results are cached too, briefly, so a host with no daemon does
  // not pay the probe on every connect.
  localProbe = { id, at: now };
  return id;
}

/**
 * Why a daemon's VM list is missing, in terms the user can act on.
 *
 * The cloud answers 502 for a daemon it cannot dial, so echoing the gateway
 * status verbatim would tell the user their *cloud* is broken when in fact
 * their laptop's `heyvmd` simply isn't running.
 */
function daemonFailure(err: unknown, daemon: DaemonInfo): string {
  if (err instanceof ApiError) {
    if (err.status === 502) {
      return `the cloud could not reach this daemon — is \`heyvmd\` running? (last heartbeat ${daemon.lastSeenAt})`;
    }
    if (err.status === 0) {
      return `timed out after ${DAEMON_TIMEOUT_MS / 1000}s waiting for this daemon`;
    }
  }
  return describe(err);
}

/**
 * Validate a key by making the cheapest authenticated call we have. Returns
 * `true` when the cloud accepts it. Never logs or returns the key itself.
 */
export async function validateKey(apiKey: string): Promise<boolean> {
  try {
    await Sandbox.list({ apiKey });
    return true;
  } catch (err) {
    if (err instanceof AuthenticationError) return false;
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      return false;
    }
    throw err;
  }
}

/**
 * Every VM the key can see: cloud-deployed sandboxes plus the sandboxes on
 * each registered daemon. Daemon fetches are settled independently so one
 * unreachable machine degrades to a warning rather than an empty page.
 */
export async function listVms(apiKey: string): Promise<VmListing> {
  const [cloudResult, daemonsResult] = await Promise.allSettled([
    Sandbox.list({ apiKey }),
    Daemons.list({ apiKey }),
  ]);

  const vms: VmSummary[] = [];
  const warnings: VmSourceWarning[] = [];

  if (cloudResult.status === "fulfilled") {
    for (const sb of cloudResult.value) {
      vms.push({
        id: sb.id,
        name: sb.name,
        status: sb.status,
        image: sb.image,
        source: "cloud",
        sourceLabel: "Heyo cloud",
        kind: "deployed",
        shellable: CLOUD_SHELLABLE.has(sb.status),
      });
    }
  } else {
    warnings.push({
      source: "cloud",
      sourceLabel: "Heyo cloud",
      message: describe(cloudResult.reason),
    });
  }

  const daemons: DaemonInfo[] =
    daemonsResult.status === "fulfilled" ? daemonsResult.value : [];
  if (daemonsResult.status === "rejected") {
    warnings.push({
      source: "daemons",
      sourceLabel: "Daemons",
      message: describe(daemonsResult.reason),
    });
  }

  // Only dial daemons the cloud believes are up. Asking about a daemon that
  // has already missed its heartbeats is a guaranteed 502 and a guaranteed
  // wait, and the cloud has told us the answer for free.
  const reachable = daemons.filter((d) => d.status === "online");
  for (const daemon of daemons) {
    if (daemon.status === "online") continue;
    warnings.push({
      source: daemon.id,
      sourceLabel: daemon.name ?? daemon.id,
      message:
        daemon.status === "offline"
          ? "daemon is offline — start `heyvmd` on that machine to list its VMs"
          : `daemon has missed its heartbeats (last seen ${daemon.lastSeenAt})`,
    });
  }

  const daemonListings = await Promise.allSettled(
    reachable.map((d) =>
      Daemons.listSandboxes(d.id, { apiKey, timeoutMs: DAEMON_TIMEOUT_MS }),
    ),
  );

  daemonListings.forEach((result, i) => {
    const daemon = reachable[i]!;
    const label = daemon.name ?? daemon.id;
    if (result.status === "rejected") {
      warnings.push({
        source: daemon.id,
        sourceLabel: label,
        message: daemonFailure(result.reason, daemon),
      });
      return;
    }
    for (const sb of result.value.sandboxes) {
      vms.push({
        id: sb.id,
        name: sb.name,
        status: sb.status,
        image: sb.image,
        source: daemon.id,
        sourceLabel: label,
        // A daemon sandbox that is also deployed is addressable as `deployed`;
        // a purely local one registers as `local`.
        kind: sb.isDeployed ? "deployed" : "local",
        shellable: DAEMON_SHELLABLE.has(sb.status),
      });
    }
  });

  return { vms, warnings };
}

/** Networks with their member lists, for the picker's membership badges. */
export async function listNetworks(apiKey: string): Promise<NetworkListing> {
  // `GET /networks` returns the rows that already exist and nothing more. It
  // is `GET /networks/me` that creates the account's default network on first
  // read, so touch that first — otherwise an account that has never used
  // networks gets an empty picker and no way to register anything.
  let fallback: NetworkInfo | null = null;
  try {
    fallback = (await Network.default({ apiKey })).info();
  } catch {
    // Non-fatal: the listing below is the real source of truth.
  }

  let infos: NetworkInfo[];
  let warning: string | null = null;
  try {
    infos = await Network.list({ apiKey });
  } catch (err) {
    // A failed listing shouldn't blank the screen when we already hold a
    // usable network — degrade to the default and say what's missing.
    if (!fallback) throw err;
    infos = [fallback];
    warning = `Showing the default network only — listing the rest failed: ${describe(err)}`;
  }
  if (infos.length === 0 && fallback) infos = [fallback];

  const summaries = await Promise.allSettled(
    infos.map(async (info) => {
      const net = await Network.get(info.id, { apiKey });
      return await net.listMembers();
    }),
  );

  const networks = infos.map((info, i) => {
    const result = summaries[i]!;
    return {
      id: info.id,
      name: info.name,
      isDefault: info.isDefault,
      description: info.description,
      members: result.status === "fulfilled" ? result.value : [],
      membersError:
        result.status === "rejected" ? describe(result.reason) : null,
    };
  });

  return { networks, warning };
}

/**
 * Register a VM into a network.
 *
 * The member kind is re-derived from our own VM listing rather than taken from
 * the request body, so a client cannot register an arbitrary ref under an
 * arbitrary kind.
 */
export async function addVmToNetwork(
  apiKey: string,
  networkId: string,
  vmId: string,
): Promise<NetworkMember> {
  const { vms } = await listVms(apiKey);
  const vm = vms.find((v) => v.id === vmId);
  if (!vm) {
    throw new NotFoundError(`No VM ${vmId} is visible to this session`);
  }
  const net = await Network.get(networkId, { apiKey });
  return await net.addMember({
    sandboxKind: vm.kind,
    sandboxRef: vm.id,
    deviceName: vm.name,
  });
}

/**
 * Open an interactive PTY on a VM. The returned `ShellSession` handles its own
 * reconnects inside the cloud's ~60s grace window.
 *
 * Which endpoint to stream from depends on where the VM lives, and the SDK
 * does not decide that for you: `sandbox.shell()` always targets
 * `/deployed-sandboxes/{id}/shell-stream`. That route only knows about
 * cloud-deployed sandboxes, so pointing it at a daemon-native `sb-…` id gets
 * the socket closed before the `ready` frame ever arrives. Daemon sandboxes
 * have their own route, which the cloud proxies into `heyvmd` over iroh.
 *
 * As in `addVmToNetwork`, the VM is looked up in this session's own listing
 * rather than trusted from the request — which doubles as the authorization
 * check, since a VM this key cannot see is a 404.
 */
/** Attach to a sandbox on this host, straight through `heyvmd`. */
async function openLocalShell(
  vmId: string,
  options: ShellOptions,
): Promise<ShellSession> {
  const session = new ShellSession(
    // `apiKey: ""` rather than `undefined`: the client falls back to
    // `process.env.HEYO_API_KEY` on nullish, and a loopback daemon needs no
    // credential at all. An empty string is falsy, so no header is sent.
    new HeyoClient({ baseUrl: localDaemonUrl(), apiKey: "" }),
    vmId,
    {
      ...options,
      pathOverride: `/sandboxes/${encodeURIComponent(vmId)}/shell-stream`,
    },
  );
  await session.open();
  return session;
}

export async function openShell(
  apiKey: string,
  vmId: string,
  options: ShellOptions,
): Promise<ShellSession> {
  const { vms } = await listVms(apiKey);
  const vm = vms.find((v) => v.id === vmId);
  if (!vm) {
    throw new NotFoundError(`No VM ${vmId} is visible to this session`);
  }

  if (vm.source === "cloud") {
    return await Sandbox.connect(vmId, { apiKey }).shell(options);
  }

  if ((await localDaemonId()) === vm.source) {
    try {
      return await openLocalShell(vmId, options);
    } catch (err) {
      // Fall through to the cloud route rather than failing outright — the
      // local daemon may have stopped between the probe and the connect.
      console.warn(
        `[shell] local daemon path failed for ${vmId}, trying the cloud: ${describe(err)}`,
      );
    }
  }

  const session = new ShellSession(new HeyoClient({ apiKey }), vmId, {
    ...options,
    pathOverride:
      `/me/daemons/${encodeURIComponent(vm.source)}` +
      `/sandboxes/${encodeURIComponent(vmId)}/shell-stream`,
  });
  try {
    await session.open();
  } catch (err) {
    // A rejected upgrade closes the socket before `ready`, and the SDK's own
    // hint for that names the deployed-sandbox route — which is not the route
    // we just used. Say what actually has to be true instead.
    throw new ConnectionError(
      `Could not open a shell on ${vm.name} through ${vm.sourceLabel}: ` +
        `${describe(err)}. The daemon must be running, and the sandbox must be ` +
        `exposed for remote access.`,
      err,
    );
  }
  return session;
}

/** Map an SDK error onto an HTTP status for our own responses. */
export function statusFor(err: unknown): number {
  if (err instanceof AuthenticationError) return 401;
  if (err instanceof NotFoundError) return 404;
  if (err instanceof InvalidArgumentError) return 400;
  if (err instanceof ApiError) {
    // The SDK uses status 0 for "no response at all" — a socket error or a
    // client-side timeout. That's a gateway *timeout*, not a bad gateway.
    if (err.status === 0) return 504;
    return err.status >= 400 ? err.status : 502;
  }
  return 500;
}

/** A safe, human-readable description of an error. Never includes a key —
 * SDK errors carry status text and server messages, not request credentials. */
export function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
