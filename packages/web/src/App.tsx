import { useCallback, useEffect, useState } from 'react';
import { CameraViewer } from './CameraViewer.js';
import { SessionList } from './SessionList.js';
import { type TerminalTarget, TerminalView } from './TerminalView.js';
import { HTTP_BASE } from './ws-url.js';

type View = { mode: 'list' } | { mode: 'terminal'; target: TerminalTarget } | { mode: 'cameras' };

const VIEW_KEY = 'switchboard:view';

function loadView(): View {
  try {
    const raw = sessionStorage.getItem(VIEW_KEY);
    if (!raw) return { mode: 'list' };
    const parsed = JSON.parse(raw) as View;
    if (parsed?.mode === 'list') return { mode: 'list' };
    if (parsed?.mode === 'cameras') return parsed;
    if (
      parsed?.mode === 'terminal' &&
      (parsed.target?.kind === 'attach' || parsed.target?.kind === 'create')
    ) {
      return parsed;
    }
  } catch {
    // corrupted entry — fall through to list
  }
  return { mode: 'list' };
}

export function App(): JSX.Element {
  // Persist view to sessionStorage so a page reload (Vite HMR, mobile browser
  // memory recycle, etc.) doesn't kick the user back to the session list when
  // they were in the middle of a terminal view.
  const [view, setView] = useState<View>(loadView);

  useEffect(() => {
    try {
      sessionStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch {
      // ignore quota errors
    }
  }, [view]);

  // Stable callback so TerminalView's useEffect can list it in deps without
  // re-running on every parent render (which would tear down xterm + WS).
  const handleBack = useCallback(() => setView({ mode: 'list' }), []);

  return (
    <>
      {/* CameraViewer always mounted so phone camera stream persists across navigation */}
      <div style={{ display: view.mode === 'cameras' ? 'contents' : 'none' }}>
        <CameraViewer serverBase={HTTP_BASE} onBack={handleBack} visible={view.mode === 'cameras'} />
      </div>
      {view.mode === 'list' && (
        <SessionList
          onAttach={(sessionId) =>
            setView({ mode: 'terminal', target: { kind: 'attach', sessionId } })
          }
          onCreate={(adapterId) =>
            setView({ mode: 'terminal', target: { kind: 'create', adapterId } })
          }
          onCameras={() => setView({ mode: 'cameras' })}
        />
      )}
      {view.mode === 'terminal' && <TerminalView target={view.target} onBack={handleBack} />}
    </>
  );
}
