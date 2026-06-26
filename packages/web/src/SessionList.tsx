import { useEffect, useRef, useState } from 'react';
import { AlarmToggle } from './AlarmToggle.js';
import { CliScan } from './CliScan.js';
import { FileManager } from './FileManager.js';
import type { ServerMessage, SessionSummary } from './protocol.js';
import { WS_BASE } from './ws-url.js';

export interface SessionListProps {
  onAttach(sessionId: string): void;
  onCreate(adapterId: string): void;
  onCameras?(): void;
  onWorkgroups?(): void;
}

type ConnState = 'connecting' | 'reconnecting' | 'open' | 'closed' | 'error';

export function SessionList({
  onAttach,
  onCreate,
  onCameras,
  onWorkgroups,
}: SessionListProps): JSX.Element {
  const [conn, setConn] = useState<ConnState>('connecting');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [showFileManager, setShowFileManager] = useState(false);
  const [showCliScan, setShowCliScan] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    const connect = (): void => {
      const ws = new WebSocket(`${WS_BASE}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        attempts = 0;
        setConn('open');
      };
      ws.onerror = () => setConn('error');
      ws.onclose = () => {
        if (disposed) return;
        // The phone↔dev-box TLS link drops periodically; reconnect with backoff
        // so the list self-heals instead of getting stuck (HMR reload is off now).
        setConn('reconnecting');
        const delay = Math.min(1000 * 2 ** attempts, 10000);
        attempts += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
      ws.onmessage = (e: MessageEvent<string>) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(e.data) as ServerMessage;
        } catch {
          return;
        }
        if (msg.type === 'sessions') setSessions(msg.list);
        if (msg.type === 'ping' && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        wsRef.current?.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    };
  }, []);

  return (
    <div className="list-view">
      <header>
        <h1>Switchboard</h1>
        <span className={`status status-${conn}`}>{conn}</span>
        {onCameras && (
          <button type="button" className="btn btn-files" onClick={onCameras}>
            Cameras
          </button>
        )}
        <button type="button" className="btn btn-files" onClick={() => setShowCliScan(true)}>
          Agents
        </button>
        {onWorkgroups && (
          <button type="button" className="btn btn-files" onClick={onWorkgroups}>
            Workgroups
          </button>
        )}
        <AlarmToggle />
        <button type="button" className="btn btn-files" onClick={() => setShowFileManager(true)}>
          Upload
        </button>
      </header>

      <main>
        {sessions.length === 0 ? (
          <EmptyState onCreate={onCreate} />
        ) : (
          <ul className="session-list">
            {sessions.map((s) => (
              <li key={s.id}>
                <button type="button" className="session-card" onClick={() => onAttach(s.id)}>
                  <div className="session-card-row">
                    <span className="session-name">{s.name}</span>
                    <span className={`session-state state-${s.state}`}>{s.state}</span>
                  </div>
                  <div className="session-card-row session-meta">
                    <span className="session-source">{s.source}</span>
                    <span className="session-adapter">{s.adapterDisplayName}</span>
                    <span className="session-cwd" title={s.cwd}>
                      {s.cwd}
                    </span>
                  </div>
                  <div className="session-card-row session-meta">
                    <span className="session-activity">{relativeTime(s.lastActivityAt)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>

      <footer className="list-footer">
        <button type="button" className="btn btn-secondary" onClick={() => onCreate('passthrough')}>
          + New passthrough session
        </button>
      </footer>
      {showFileManager && <FileManager onClose={() => setShowFileManager(false)} />}
      {showCliScan && <CliScan onClose={() => setShowCliScan(false)} />}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate(adapterId: string): void }): JSX.Element {
  return (
    <div className="empty-state">
      <p className="empty-title">No sessions yet</p>
      <p className="empty-hint">
        On your dev box, run:
        <code> switchboard run claude </code>
        (or any other CLI) in a normal terminal. It'll appear here.
      </p>
      <p className="empty-hint">Or start a server-spawned shell from here:</p>
      <button type="button" className="btn" onClick={() => onCreate('passthrough')}>
        + New passthrough session
      </button>
    </div>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleString();
}
