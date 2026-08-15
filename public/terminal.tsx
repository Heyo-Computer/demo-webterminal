/**
 * xterm.js bound to the server's `/ws/shell` proxy.
 *
 * Keystrokes go out as binary frames, control messages (resize) as text — so
 * the two can never be mistaken for one another. Nothing here ever sees the
 * API key; the connection authenticates with the HttpOnly session cookie the
 * browser attaches automatically.
 */

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";

import type { Vm } from "./app";

type Status =
  | { kind: "connecting" }
  | { kind: "open" }
  | { kind: "reconnecting"; attempt: number }
  | { kind: "closed"; message: string };

/** Control frames the server sends as text. */
type ServerFrame =
  | { type: "ready"; vmId: string }
  | { type: "fatal"; message: string }
  | { type: "reconnecting"; attempt: number; delayMs: number }
  | { type: "reconnected" }
  | { type: "closed"; exitCode: number | null; message: string | null }
  | { type: "error"; message: string };

function wsUrl(vm: Vm, cols: number, rows: number): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({
    vm: vm.id,
    cols: String(cols),
    rows: String(rows),
  });
  return `${proto}//${location.host}/ws/shell?${params}`;
}

export function TerminalPane({ vm, onBack }: { vm: Vm; onBack: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "connecting" });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: false,
      theme: {
        background: "#0d1117",
        foreground: "#d7dde5",
        cursor: "#5ad1a0",
        selectionBackground: "#2c3a4d",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const encoder = new TextEncoder();
    const ws = new WebSocket(wsUrl(vm, term.cols, term.rows));
    ws.binaryType = "arraybuffer";
    socketRef.current = ws;

    // Buffer keystrokes typed before the socket finishes opening.
    const pending: Uint8Array[] = [];
    const send = (bytes: Uint8Array) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(bytes);
      else if (ws.readyState === WebSocket.CONNECTING) pending.push(bytes);
    };

    const dataSub = term.onData((chunk) => send(encoder.encode(chunk)));

    ws.onopen = () => {
      for (const chunk of pending) ws.send(chunk);
      pending.length = 0;
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
        return;
      }
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      switch (frame.type) {
        case "ready":
          setStatus({ kind: "open" });
          break;
        case "reconnecting":
          setStatus({ kind: "reconnecting", attempt: frame.attempt });
          break;
        case "reconnected":
          setStatus({ kind: "open" });
          break;
        case "closed": {
          const detail =
            frame.message ??
            (frame.exitCode === null
              ? "session ended"
              : `exit code ${frame.exitCode}`);
          setStatus({ kind: "closed", message: detail });
          term.write(`\r\n\x1b[38;5;244m— ${detail} —\x1b[0m\r\n`);
          break;
        }
        case "fatal":
        case "error":
          setStatus({ kind: "closed", message: frame.message });
          term.write(`\r\n\x1b[31m${frame.message}\x1b[0m\r\n`);
          break;
      }
    };

    ws.onclose = (event) => {
      setStatus((prev) =>
        prev.kind === "closed"
          ? prev
          : {
              kind: "closed",
              message: event.reason || "connection closed",
            },
      );
    };

    ws.onerror = () => {
      setStatus((prev) =>
        prev.kind === "closed"
          ? prev
          : { kind: "closed", message: "connection error" },
      );
    };

    const resize = () => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
        );
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    term.focus();

    return () => {
      observer.disconnect();
      dataSub.dispose();
      ws.onclose = null;
      ws.close();
      socketRef.current = null;
      term.dispose();
    };
  }, [vm.id]);

  return (
    <div className="terminal-screen">
      <header className="bar">
        <div>
          <button className="ghost" onClick={onBack}>
            ← VMs
          </button>
          <strong>{vm.name}</strong>
          <span className="muted">
            {vm.id} · {vm.sourceLabel}
          </span>
        </div>
        <StatusPill status={status} />
      </header>
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}

function StatusPill({ status }: { status: Status }) {
  switch (status.kind) {
    case "connecting":
      return <span className="pill pending">connecting…</span>;
    case "open":
      return <span className="pill ok">connected</span>;
    case "reconnecting":
      return (
        <span className="pill pending">
          reconnecting (attempt {status.attempt})…
        </span>
      );
    case "closed":
      return <span className="pill bad">{status.message}</span>;
  }
}
