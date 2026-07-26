/**
 * A SessionBackend is anything that looks like a PTY from the Session's POV.
 *
 * Two implementations ship in v1:
 *  - LocalPtyBackend   — wraps node-pty (used by server-spawned sessions, Mode B)
 *  - WrapperBackend    — wraps a WebSocket from a `switchboard run` wrapper
 *                        process (used by wrapped sessions, Mode A — primary)
 *
 * Future backends (SSH-tunneled wrappers, container exec, etc.) just implement
 * this interface — the rest of the system doesn't care which kind it is.
 */
export interface SessionBackend {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(handler: (chunk: Buffer) => void): void;
  onExit(handler: (code: number, signal?: number) => void): void;
  /** Release native resources, listeners, sockets. Called once on Session shutdown. */
  dispose(): void;
  /**
   * Optional. If the backend has its OWN viewport (e.g. a wrapper process's
   * local terminal), return its size so Session can include it in PTY-size
   * negotiation alongside attached browser clients. Return undefined when no
   * local viewport applies (server-spawned PTY, headless wrapper, etc.).
   */
  getOwnSize?(): { cols: number; rows: number } | undefined;
  /**
   * Optional. Backends with a fluctuating own size (e.g. user resizes their
   * local terminal) call this listener when the size changes so the Session
   * can re-fit.
   */
  setOwnSizeListener?(listener: () => void): void;
  /**
   * Optional. Backends whose transport can come and go (WrapperBackend, whose
   * wrapper may be mid-reconnect) report whether writes can reach the PTY right
   * now. Backends that own the PTY directly omit it and count as connected.
   */
  isConnected?(): boolean;
  /**
   * Optional. Called when isConnected() flips, so the Session can tell clients
   * that input is (or is no longer) going anywhere.
   */
  setConnectionListener?(listener: () => void): void;
}
