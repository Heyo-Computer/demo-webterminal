# Heyo Webterminal

A browser terminal for Heyo VMs. Paste a heyvm API key, register a VM into one
of your networks, and get an interactive PTY on it — all in the browser.

```bash
bun install
bun run dev          # http://localhost:3000
```

## Flow

1. **Key** — paste a `heyo_api_…` key. It is validated against the cloud before
   anything is stored.
2. **Pick** — choose a network and a VM, then register the VM into the network.
   Both cloud-deployed sandboxes (`dep-…`) and sandboxes on your registered
   daemons (`hd-…` machines) are listed.
3. **Shell** — open a real PTY. `cd`, env changes, `vim`, `top`, and window
   resizing all behave normally.

### Where a shell actually connects

`sandbox.shell()` always targets `/deployed-sandboxes/{id}/shell-stream`, which
only resolves cloud-deployed ids — point it at a daemon-native `sb-…` and the
socket closes before the `ready` frame. `src/heyo.ts` looks the VM up in the
session's own listing and picks the route from where it lives:

| VM lives on | Route |
| --- | --- |
| The Heyo cloud | `/deployed-sandboxes/{id}/shell-stream` |
| **This machine's daemon** | `heyvmd` on loopback, `/sandboxes/{id}/shell-stream` |
| Another machine's daemon | `/me/daemons/{daemonId}/sandboxes/{id}/shell-stream` |

The middle row is the same-host shortcut: when the daemon hosting a sandbox
*is* this host, asking the cloud to tunnel back in buys nothing, so the server
attaches to `heyvmd` directly. It is taken only when the loopback daemon's own
`backendId` matches the daemon the VM was listed under — sandbox ids are short,
and attaching to a same-named sandbox on another machine would be a real mix-up.

Authorization is unaffected: the VM must appear in *this session's* cloud
listing before any route is chosen, so a session still only reaches what its own
key can see. If the local connect fails, the cloud route is tried next.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HEYO_LOCAL_DAEMON_URL` | `http://127.0.0.1:34099` | Where to look for a local `heyvmd` |
| `HEYO_DISABLE_LOCAL_DAEMON` | unset | Set to `1` to always go through the cloud |

## How the key is handled

The Heyo SDK's `ShellSession` puts its bearer token in the **WebSocket query
string** — a deliberate workaround, since browsers cannot set headers on a
`WebSocket`. A browser talking straight to the cloud would therefore expose the
key in devtools, the browser's own network log, and any intermediary's access
log.

So the browser never talks to the Heyo cloud. This server does, and holds the
key like this:

- **Memory only.** `src/sessions.ts` keeps keys in a module-private `Map`. There
  is no file, no database, no env write. Restarting the process invalidates
  every session by construction.
- **Structurally unloggable.** The `Session` record passed around the app has no
  `apiKey` field at all — keys live in a separate map only `getApiKey()` can
  read. A stray `console.log(session)` cannot leak one.
- **Never echoed.** No response body contains the key or anything derived from
  it. After login the page holds no credential — just an `HttpOnly` cookie it
  cannot read.
- **Cookie-only auth.** Every `/api/*` route and the WebSocket upgrade resolve
  the caller from the `hwt_sid` cookie. No route accepts a key in a header,
  body, or query string, so one browser session can never see another's VMs.
- **Expiring.** 30 min idle (refreshed per request), 8 h absolute. A sweeper
  reaps expired sessions and kills their shells. Logging out does the same
  immediately.
- **CSRF-guarded.** `SameSite=Strict` plus an explicit `Origin`-equals-host
  check on every state-changing request and on the WebSocket upgrade.

## Layout

| Path | What it is |
| --- | --- |
| `index.ts` | `Bun.serve` — routes, auth, and the WebSocket shell proxy |
| `src/sessions.ts` | The credential vault: session lifecycle, TTLs, shell registry |
| `src/http.ts` | Cookie handling, same-origin check, JSON helpers |
| `src/heyo.ts` | Thin wrappers over `@heyocomputer/sdk` |
| `public/app.tsx` | Key → picker → terminal screens |
| `public/terminal.tsx` | xterm.js bound to `/ws/shell` |

## API

| Route | Purpose |
| --- | --- |
| `GET /api/session` | Is the current cookie still valid? |
| `POST /api/session` | Exchange `{ apiKey }` for a session cookie |
| `DELETE /api/session` | Log out: kill shells, forget the key |
| `GET /api/vms` | Cloud + daemon-hosted VMs, with per-source warnings |
| `GET /api/networks` | Networks with their member lists, plus a `warning` when the list is partial |
| `POST /api/networks/:id/members` | Register `{ vmId }` into a network |
| `GET /ws/shell?vm=…&cols=…&rows=…` | PTY stream (binary = bytes, text = control JSON) |

The WebSocket carries keystrokes as **binary** frames and control messages
(`{type:"resize"}`) as **text**, so the two can never be confused.

## When a source is unavailable

Neither column is all-or-nothing — a source that can't be reached becomes a
warning next to the ones that can.

- **A daemon shows "offline".** `GET /me/daemons/{id}/sandboxes` isn't a
  database read: the cloud dials your machine over iroh and proxies the call
  into `heyvmd`. If `heyvmd` isn't running the cloud answers **502 Bad
  Gateway** — the gateway in question is your laptop, not the Heyo cloud.
  Start `heyvmd` and hit Refresh. Daemons the cloud already reports as
  `offline` or `stale` aren't dialed at all, so one sleeping machine never
  stalls the picker.
- **Networks are empty.** `GET /networks` lists existing rows and creates
  nothing; it's `GET /networks/me` that creates the account default. The server
  touches that first, so the picker always has at least one network.
- **The cloud itself is unreachable.** Cloud and daemon listings settle
  independently, so daemon VMs still render when the cloud is down, and vice
  versa.

## Tests

```bash
bun test        # session vault, HTTP helpers, SDK wrappers
bun run typecheck
```
