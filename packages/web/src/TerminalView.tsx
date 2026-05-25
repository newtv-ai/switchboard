import { CanvasAddon } from '@xterm/addon-canvas';
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

type ConnStatus = 'connecting' | 'open' | 'closed' | 'error' | 'reconnecting';

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
    const terminalEl = containerRef.current;
    if (!terminalEl) return;

    const isNarrow = window.matchMedia('(max-width: 600px)').matches;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "Cascadia Code", "Courier New", monospace',
      fontSize: isNarrow ? 12 : 14,
      letterSpacing: 0,
      // Default scrollback (1000 lines) silently truncates long pre-TUI
      // dumps (claude-mem SessionStart hook output etc.) — on phone with
      // narrow columns those dumps wrap heavily, so 1000 lines is exhausted
      // before the user can scroll to the top. 10k covers normal sessions.
      scrollback: 10000,
      theme: {
        background: '#0c0c0c',
        foreground: '#d4d4d4',
        cursor: '#ffffff',
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(terminalEl);

    // load CanvasAddon to prevent DOM Text Selection deadlocks on mobile
    // and improve rendering performance during scroll refits.
    const canvasAddon = new CanvasAddon();
    term.loadAddon(canvasAddon);

    // xterm.js's built-in touch handler manually does `scrollTop += deltaY`
    // (1:1 finger-to-pixel, NO momentum) and preventDefaults touchmove in
    // mid-buffer — that kills the browser's native momentum scrolling and
    // makes phone scrolling feel like dragging-line-by-line. The reason xterm
    // does this is to forward touch as mouse clicks in mouse-mode TUIs (vim),
    // which Claude/Codex don't use. Intercept in capture phase before xterm's
    // bubble-phase listeners fire, stopImmediatePropagation, and let the
    // browser scroll the .xterm-viewport natively (it's overflow-y:scroll).
    // xterm's Viewport subscribes to the viewport's native `scroll` event
    // (Viewport.ts:71), so re-rendering still works — we just get momentum
    // for free.
    const bypassXtermTouch = (e: Event): void => e.stopImmediatePropagation();
    const viewportEl = terminalEl.querySelector('.xterm-viewport');
    viewportEl?.addEventListener('touchstart', bypassXtermTouch, { capture: true });
    viewportEl?.addEventListener('touchmove', bypassXtermTouch, { capture: true });
    // Note: removed pointerdown/pointermove interception to prevent
    // native Pointer Event State Machine deadlocks on some Android devices.
    const safeFit = (): void => {
      try {
        fit.fit();
      } catch {
        // ignore — container might be 0×0 mid-layout
      }
    };
    requestAnimationFrame(safeFit);

    termRef.current = term;

    // Last cols/rows reported to server. Resize events that don't change
    // these are dropped; rows-only changes are debounced (see resizeSub).
    let lastReportedCols = -1;
    let lastReportedRows = -1;

    let isUnmounted = false;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let activeSessionId = target.kind === 'attach' ? target.sessionId : undefined;

    const sendWs = (msg: ClientMessage): void => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    const connectWs = () => {
      if (isUnmounted) return;
      const ws = new WebSocket(`${WS_BASE}/ws`);
      wsRef.current = ws;
      let opened = false;

      ws.onopen = () => {
        opened = true;
        reconnectAttempts = 0;
        setStatus('open');
        if (activeSessionId) {
          sendWs({
            type: 'attach',
            sessionId: activeSessionId,
            cols: term.cols,
            rows: term.rows,
          });
        } else if (target.kind === 'create') {
          sendWs({
            type: 'create',
            adapterId: target.adapterId,
            cols: term.cols,
            rows: term.rows,
          });
        }
        lastReportedCols = term.cols;
        lastReportedRows = term.rows;
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
            return;
          case 'ready':
            activeSessionId = msg.sessionId;
            setLabel(msg.summary.name);
            setSessionState(msg.summary.state);
            if (msg.replay) {
              // Wipe xterm before replaying. 'ready' fires on EVERY (re)attach,
              // including auto-reconnect after a transient WS drop. The server's
              // replay buffer is the full source of truth for what should be on
              // screen — writing it on top of whatever xterm already contains
              // is what makes "刷新越多重复越多" happen.
              term.reset();
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
            if (msg.message.startsWith('unknown session:')) {
              setTimeout(onBack, 1500);
            }
            return;
        }
      };

      ws.onerror = () => {
        if (!opened) setStatus('error');
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (isUnmounted) return;
        setStatus('reconnecting');
        if (opened) term.write('\r\n\x1b[33m[disconnected, reconnecting...]\x1b[0m\r\n');

        reconnectAttempts++;
        const delay = Math.min(10000, 1000 * 1.5 ** (reconnectAttempts - 1));
        reconnectTimer = setTimeout(connectWs, delay);
      };
    };

    connectWs();

    const dataSub = term.onData((data) => {
      sendWs({ type: 'input', data });
      // DO NOT scrollToBottom here. If the buffer (esp. main-screen from
      // pre-TUI hook output like claude-mem's SessionStart dump) is longer
      // than the viewport, scrolling on every keystroke yanks the user out
      // of whatever they were looking at.
    });
    // Resize reporting is layered: cols changes propagate immediately (real
    // reorientation — user expects the TUI to adapt), but rows-only changes
    // are debounced 500ms. Two sources of rows-only churn on phone:
    //   - mobile address-bar collapse during scroll (transient, NOT a real
    //     intent — user gains 5 rows for ~200ms while scrolling, then either
    //     keeps scrolling or stops)
    //   - IME keyboard show/hide (real, but settles in ~300ms)
    // Each unsuppressed report → server refit → pty.resize() → SIGWINCH →
    // Claude redraws the visible conversation tail. Because claude's TUI is
    // main-screen (not alt-screen) for history, every redraw APPENDS another
    // copy of the conversation to scrollback. Without debounce, scrolling
    // accumulates a duplicate per fit. The 500ms window absorbs scroll-driven
    // address-bar churn entirely and adds tolerable latency to keyboard pop.
    let reportTimer: ReturnType<typeof setTimeout> | undefined;
    const flushReport = (cols: number, rows: number): void => {
      lastReportedCols = cols;
      lastReportedRows = rows;
      sendWs({ type: 'resize', cols, rows });
    };
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (cols === lastReportedCols && rows === lastReportedRows) return;
      if (cols !== lastReportedCols) {
        if (reportTimer !== undefined) {
          clearTimeout(reportTimer);
          reportTimer = undefined;
        }
        flushReport(cols, rows);
        return;
      }

      const isNarrow = window.matchMedia('(max-width: 600px)').matches;
      // On mobile, ignore small row changes (e.g. <= 15 rows caused by large address bars hide/show)
      // to prevent PTY resize storms (which causes history to append duplicate dumps).
      // We don't update lastReportedRows here so cumulative small changes are still measured against the last "valid" fit height.
      if (
        isNarrow &&
        Math.abs(rows - lastReportedRows) <= 15 &&
        Math.abs(rows - lastReportedRows) > 0
      ) {
        // Do not trigger flushReport for tiny vertical resizes on mobile
        return;
      }

      if (reportTimer !== undefined) clearTimeout(reportTimer);
      reportTimer = setTimeout(() => {
        reportTimer = undefined;
        flushReport(cols, rows);
      }, 500);
    });

    // Refit is debounced so a burst of size-change events collapses to one
    // fit AFTER layout settles. Without this, mobile scroll → address bar
    // collapse fires visualViewport.scroll + ResizeObserver (height tracks
    // vv via --app-h in main.tsx) repeatedly during one finger swipe → each
    // fit changes xterm rows → resize sent to server → MIN-policy refit →
    // pty.resize() → SIGWINCH → TUI redraw → bytes pile up in the replay
    // ring buffer (visible to the user as the SAME TUI frame stacked N
    // times in scrollback). Debounce kills the storm at the source.
    //
    // Earlier this also subscribed to visualViewport.scroll and touchend
    // directly, citing MIUI / Android Chrome being slow to propagate
    // address-bar-collapse through ResizeObserver. The cost-benefit flipped
    // once we noticed those handlers were the primary driver of the refit
    // storm — main.tsx already drives --app-h from vv.scroll, and CSS height
    // → ResizeObserver eventually fires. A 150ms trailing debounce trades a
    // brief layout lag during scroll for stable PTY/scrollback behaviour.
    let refitTimer: ReturnType<typeof setTimeout> | undefined;
    let rafId = 0;
    const refit = (): void => {
      if (refitTimer !== undefined) clearTimeout(refitTimer);
      refitTimer = setTimeout(() => {
        refitTimer = undefined;
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(safeFit);
      }, 150);
    };

    const ro = new ResizeObserver(refit);
    ro.observe(containerRef.current);

    const vv = window.visualViewport;
    vv?.addEventListener('resize', refit);

    return () => {
      isUnmounted = true;
      ro.disconnect();
      vv?.removeEventListener('resize', refit);
      viewportEl?.removeEventListener('touchstart', bypassXtermTouch, { capture: true });
      viewportEl?.removeEventListener('touchmove', bypassXtermTouch, { capture: true });
      if (refitTimer !== undefined) clearTimeout(refitTimer);
      if (reportTimer !== undefined) clearTimeout(reportTimer);
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      cancelAnimationFrame(rafId);
      dataSub.dispose();
      resizeSub.dispose();
      try {
        wsRef.current?.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
      termRef.current = null;
      canvasAddon.dispose();
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
