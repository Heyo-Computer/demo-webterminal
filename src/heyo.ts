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
  Daemons,
  InvalidArgumentError,
  Network,
  NotFoundError,
  Sandbox,
  type DaemonInfo,
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

/** Cloud statuses that permit an interactive shell. */
const CLOUD_SHELLABLE = new Set(["running"]);
/** Daemon-native statuses that permit an interactive shell. `ready` is what
 * ephemeral backends report in place of `running`. */
const DAEMON_SHELLABLE = new Set(["running", "ready"]);

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

  const daemonListings = await Promise.allSettled(
    daemons.map((d) => Daemons.listSandboxes(d.id, { apiKey })),
  );

  daemonListings.forEach((result, i) => {
    const daemon = daemons[i]!;
    const label = daemon.name ?? daemon.id;
    if (result.status === "rejected") {
      warnings.push({
        source: daemon.id,
        sourceLabel: label,
        message: `${describe(result.reason)} (daemon is ${daemon.status})`,
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
export async function listNetworks(apiKey: string): Promise<NetworkSummary[]> {
  const infos = await Network.list({ apiKey });
  const summaries = await Promise.allSettled(
    infos.map(async (info) => {
      const net = await Network.get(info.id, { apiKey });
      return await net.listMembers();
    }),
  );

  return infos.map((info, i) => {
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
 */
export async function openShell(
  apiKey: string,
  vmId: string,
  options: ShellOptions,
) {
  return await Sandbox.connect(vmId, { apiKey }).shell(options);
}

/** Map an SDK error onto an HTTP status for our own responses. */
export function statusFor(err: unknown): number {
  if (err instanceof AuthenticationError) return 401;
  if (err instanceof NotFoundError) return 404;
  if (err instanceof InvalidArgumentError) return 400;
  if (err instanceof ApiError) return err.status >= 400 ? err.status : 502;
  return 500;
}

/** A safe, human-readable description of an error. Never includes a key —
 * SDK errors carry status text and server messages, not request credentials. */
export function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
