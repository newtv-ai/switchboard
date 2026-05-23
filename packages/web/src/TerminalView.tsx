import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { QuickActions } from './QuickActions.js';
import type { ClientMessage, ServerMessage } from './protocol.js';
import { WS_BASE } from './ws-url.js';

export type TerminalTarget =
  | { kind: 'attach'; sessionId: string }
  | { kind: 'create'; adapterId: string };

export interface TerminalViewProps {
  target: TerminalTarget;
  onBack(): void;
}

type ConnStatus = 'connecting' | 'open' | 'closed' | 'error';

export function TerminalView({ target, onBack }: TerminalViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [label, setLabel] = useState<string>('…');
  const [sessionState, setSessionState] = useState<string>('starting');

  const sendInput = useCallback((data: string): void => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      const msg: ClientMessage = { type: 'input', data };
      ws.send(JSON.stringify(msg));
    }
    termRef.current?.focus();
    // On phone, accidental drag can scroll the terminal into scrollback so the
    // user is "looking at history" of a dismissed modal etc. Any deliberate
    // input means they want to see what they're doing — jump back to live.
    termRef.current?.scrollToBottom();
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const isNarrow = window.matchMedia('(max-width: 600px)').matches;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "Cascadia Code", "Courier New", monospace',
      fontSize: isNarrow ? 12 : 14,
      letterSpacing: 0,
      theme: {
        background: '#0c0c0c',
        foreground: '#d4d4d4',
        cursor: '#ffffff',
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    const safeFit = (): void => {
      try {
        fit.fit();
      } catch {
        // ignore — container might be 0×0 mid-layout
      }
    };
    requestAnimationFrame(safeFit);

    termRef.current = term;

    const ws = new WebSocket(`${WS_BASE}/ws`);
    wsRef.current = ws;
    let opened = false;

    const sendWs = (msg: ClientMessage): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    ws.onopen = () => {
      opened = true;
      setStatus('open');
      if (target.kind === 'attach') {
        sendWs({
          type: 'attach',
          sessionId: target.sessionId,
          cols: term.cols,
          rows: term.rows,
        });
      } else {
        sendWs({
          type: 'create',
          adapterId: target.adapterId,
          cols: term.cols,
          rows: term.rows,
        });
      }
    };

    ws.onmessage = (e: MessageEvent<string>) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data) as ServerMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'sessions':
          // Initial list push on connect — ignore in terminal view.
          return;
        case 'ready':
          setLabel(msg.summary.name);
          setSessionState(msg.summary.state);
          if (msg.replay) {
            term.write(msg.replay, () => term.scrollToBottom());
          }
          return;
        case 'pty':
          term.write(msg.data);
          return;
        case 'state':
          setSessionState(msg.state);
          return;
        case 'exit':
          term.write(`\r\n\x1b[33m[process exited with code ${msg.code}]\x1b[0m\r\n`);
          return;
        case 'error':
          term.write(`\r\n\x1b[31m[error: ${msg.message}]\x1b[0m\r\n`);
          // Session is gone (wrapper exited or server restarted) and our
          // sessionStorage points at a dead id — bounce back to the list so
          // the user picks a live session instead of staring at the error.
          if (msg.message.startsWith('unknown session:')) {
            setTimeout(onBack, 1500);
          }
          return;
      }
    };

    ws.onerror = () => setStatus('error');
    ws.onclose = () => {
      setStatus('closed');
      if (opened) term.write('\r\n\x1b[33m[disconnected]\x1b[0m\r\n');
    };

    const dataSub = term.onData((data) => {
      sendWs({ type: 'input', data });
      // DO NOT scrollToBottom here. If the buffer (esp. main-screen from
      // pre-TUI hook output like claude-mem's SessionStart dump) is longer
      // than the viewport, scrolling on every keystroke yanks the user out
      // of whatever they were looking at.
    });
    const resizeSub = term.onResize(({ cols, rows }) => sendWs({ type: 'resize', cols, rows }));

    let rafId = 0;
    const refit = (): void => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(safeFit);
    };

    const ro = new ResizeObserver(refit);
    ro.observe(containerRef.current);

    // MIUI / Android Chrome do not always relay address-bar-collapse height
    // changes to the container's ResizeObserver fast enough, leaving xterm at
    // an old small row count with empty black space below the content. Subscribe
    // directly to visualViewport AND touchend so we refit the moment the
    // visible viewport (or any user gesture) hints that layout changed.
    const vv = window.visualViewport;
    vv?.addEventListener('resize', refit);
    vv?.addEventListener('scroll', refit);
    const onTouchEnd = (): void => refit();
    containerRef.current.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      ro.disconnect();
      vv?.removeEventListener('resize', refit);
      vv?.removeEventListener('scroll', refit);
      containerRef.current?.removeEventListener('touchend', onTouchEnd);
      cancelAnimationFrame(rafId);
      dataSub.dispose();
      resizeSub.dispose();
      try {
        ws.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
      termRef.current = null;
      term.dispose();
    };
    // App.tsx keeps `target` reference-stable until the user navigates back,
    // so depending on the whole object is correct: same reference → no re-run.
  }, [target, onBack]);

  return (
    <div className="terminal-view">
      <header>
        <button type="button" className="btn btn-back" onClick={onBack} aria-label="Back to list">
          ←
        </button>
        <h1>{label}</h1>
        <span className={`status status-${status}`}>{status}</span>
        <span className={`session-state state-${sessionState}`}>{sessionState}</span>
      </header>
      <QuickActions onSend={sendInput} />
      <div ref={containerRef} className="terminal" />
    </div>
  );
}
