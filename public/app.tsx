/**
 * Three screens: enter key → pick network + VM → shell.
 *
 * The API key is held in a component state field only long enough to POST it,
 * then dropped. It is never written to `localStorage`, `sessionStorage`, a
 * cookie, or the URL — after login this page has no credential at all, just an
 * HttpOnly cookie it cannot read.
 */

import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useState } from "react";

import "./index.css";
import { TerminalPane } from "./terminal";

export interface Vm {
  id: string;
  name: string;
  status: string;
  image: string;
  source: string;
  sourceLabel: string;
  kind: "local" | "deployed" | "database_local" | "database_cloud" | "host";
  shellable: boolean;
}

interface SourceWarning {
  source: string;
  sourceLabel: string;
  message: string;
}

interface Member {
  networkId: string;
  sandboxKind: string;
  sandboxRef: string;
  deviceName: string | null;
}

interface Net {
  id: string;
  name: string;
  isDefault: boolean;
  description: string | null;
  members: Member[];
  membersError: string | null;
}

class Unauthorized extends Error {}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (res.status === 401) throw new Unauthorized("Session expired");
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
  } & Record<string, unknown>;
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

const postJson = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------

type Stage =
  | { name: "checking" }
  | { name: "key" }
  | { name: "picker" }
  | { name: "terminal"; vm: Vm };

function App() {
  const [stage, setStage] = useState<Stage>({ name: "checking" });

  useEffect(() => {
    api("/api/session")
      .then(() => setStage({ name: "picker" }))
      .catch(() => setStage({ name: "key" }));
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/session", {
      method: "DELETE",
      credentials: "same-origin",
    }).catch(() => {});
    setStage({ name: "key" });
  }, []);

  switch (stage.name) {
    case "checking":
      return <div className="center muted">…</div>;
    case "key":
      return <KeyScreen onAuthed={() => setStage({ name: "picker" })} />;
    case "picker":
      return (
        <Picker
          onPick={(vm) => setStage({ name: "terminal", vm })}
          onLogout={logout}
          onExpired={() => setStage({ name: "key" })}
        />
      );
    case "terminal":
      return (
        <TerminalPane
          vm={stage.vm}
          onBack={() => setStage({ name: "picker" })}
        />
      );
  }
}

// ---------------------------------------------------------------------------

function KeyScreen({ onAuthed }: { onAuthed: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api("/api/session", postJson({ apiKey: key }));
      setKey(""); // drop the credential the moment it's been exchanged
      onAuthed();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="card" onSubmit={submit}>
        <h1>Heyo Webterminal</h1>
        <p className="muted">
          Paste a heyvm API key to list your networks and VMs.
        </p>
        <input
          type="password"
          value={key}
          autoComplete="off"
          spellCheck={false}
          placeholder="heyo_api_…"
          onChange={(e) => setKey(e.target.value)}
          disabled={busy}
        />
        {err && <p className="error">{err}</p>}
        <button type="submit" disabled={busy || key.length < 8}>
          {busy ? "Checking…" : "Connect"}
        </button>
        <p className="fineprint">
          The key is verified, then held only in the server's memory for this
          session and reachable only through an <code>HttpOnly</code> cookie
          this page cannot read. It is never written to disk, never logged, and
          never sent back to the browser. Logging out — or restarting the server
          — erases it.
        </p>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Picker({
  onPick,
  onLogout,
  onExpired,
}: {
  onPick: (vm: Vm) => void;
  onLogout: () => void;
  onExpired: () => void;
}) {
  const [vms, setVms] = useState<Vm[]>([]);
  const [warnings, setWarnings] = useState<SourceWarning[]>([]);
  const [nets, setNets] = useState<Net[]>([]);
  const [netId, setNetId] = useState<string | null>(null);
  const [vmId, setVmId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [vmRes, netRes] = await Promise.all([
        api<{ vms: Vm[]; warnings: SourceWarning[] }>("/api/vms"),
        api<{ networks: Net[] }>("/api/networks"),
      ]);
      setVms(vmRes.vms);
      setWarnings(vmRes.warnings);
      setNets(netRes.networks);
      setNetId((cur) =>
        cur && netRes.networks.some((n) => n.id === cur)
          ? cur
          : (netRes.networks.find((n) => n.isDefault) ?? netRes.networks[0])
              ?.id ?? null,
      );
    } catch (e) {
      if (e instanceof Unauthorized) return onExpired();
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [onExpired]);

  useEffect(() => {
    void load();
  }, [load]);

  const network = nets.find((n) => n.id === netId) ?? null;
  const vm = vms.find((v) => v.id === vmId) ?? null;
  const isMember = Boolean(
    network && vm && network.members.some((m) => m.sandboxRef === vm.id),
  );

  async function addToNetwork() {
    if (!network || !vm) return;
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      await api(
        `/api/networks/${encodeURIComponent(network.id)}/members`,
        postJson({ vmId: vm.id }),
      );
      setNote(`${vm.name} is registered in ${network.name}.`);
      await load();
    } catch (e) {
      if (e instanceof Unauthorized) return onExpired();
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const groups = new Map<string, Vm[]>();
  for (const v of vms) {
    const list = groups.get(v.sourceLabel);
    if (list) list.push(v);
    else groups.set(v.sourceLabel, [v]);
  }

  return (
    <div className="picker">
      <header className="bar">
        <strong>Heyo Webterminal</strong>
        <div>
          <button className="ghost" onClick={() => void load()} disabled={busy}>
            Refresh
          </button>
          <button className="ghost" onClick={onLogout}>
            Log out
          </button>
        </div>
      </header>

      {err && <p className="error banner">{err}</p>}
      {note && <p className="note banner">{note}</p>}

      <div className="columns">
        <section>
          <h2>Networks</h2>
          {loading && <p className="muted">Loading…</p>}
          <ul className="list">
            {nets.map((n) => (
              <li key={n.id}>
                <label className={netId === n.id ? "row selected" : "row"}>
                  <input
                    type="radio"
                    name="network"
                    checked={netId === n.id}
                    onChange={() => setNetId(n.id)}
                  />
                  <span className="row-main">
                    <span className="row-title">
                      {n.name}
                      {n.isDefault && <em className="tag">default</em>}
                    </span>
                    <span className="muted">
                      {n.membersError
                        ? `members unavailable: ${n.membersError}`
                        : `${n.members.length} member${n.members.length === 1 ? "" : "s"}`}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2>VMs</h2>
          {loading && <p className="muted">Loading…</p>}
          {!loading && vms.length === 0 && (
            <p className="muted">
              No VMs on this account yet. Create one with{" "}
              <code>heyvm create --cloud</code>.
            </p>
          )}
          {[...groups].map(([label, list]) => (
            <div key={label} className="group">
              <h3>{label}</h3>
              <ul className="list">
                {list.map((v) => {
                  const member = network?.members.some(
                    (m) => m.sandboxRef === v.id,
                  );
                  return (
                    <li key={v.id}>
                      <label className={vmId === v.id ? "row selected" : "row"}>
                        <input
                          type="radio"
                          name="vm"
                          checked={vmId === v.id}
                          onChange={() => setVmId(v.id)}
                        />
                        <span className="row-main">
                          <span className="row-title">
                            {v.name}
                            {member && <em className="tag ok">in network</em>}
                          </span>
                          <span className="muted">
                            {v.id} · {v.status} · {v.image}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {warnings.map((w) => (
            <p key={w.source} className="warn">
              {w.sourceLabel}: {w.message}
            </p>
          ))}
        </section>
      </div>

      <footer className="actions">
        <button
          onClick={() => void addToNetwork()}
          disabled={!network || !vm || isMember || busy}
        >
          {isMember ? "Already in network" : "Add VM to network"}
        </button>
        <button
          className="primary"
          onClick={() => vm && onPick(vm)}
          disabled={!vm || !vm.shellable}
          title={
            vm && !vm.shellable
              ? `${vm.name} is ${vm.status} — start it to open a shell`
              : undefined
          }
        >
          Open shell
        </button>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
