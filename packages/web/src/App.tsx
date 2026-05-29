import { useCallback, useEffect, useState } from 'react';
import { CameraViewer } from './CameraViewer.js';
import { SessionList } from './SessionList.js';
import { type TerminalTarget, TerminalView } from './TerminalView.js';
import { HTTP_BASE } from './ws-url.js';

type View = { mode: 'list' } | { mode: 'terminal'; target: TerminalTarget } | { mode: 'cameras' };

const VIEW_KEY = 'switchboard:view';

/** A `?view=camera(s)` param (e.g. from a tapped push notification) overrides
 *  the persisted view so the alarm lands straight on the camera page. */
function viewFromUrl(): View | null {
  try {
    const v = new URLSearchParams(window.location.search).get('view');
    if (v === 'camera' || v === 'cameras') return { mode: 'cameras' };
  } catch {
    // ignore malformed query string
  }
  return null;
}

function loadView(): View {
  const fromUrl = viewFromUrl();
  if (fromUrl) return fromUrl;
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

  // Strip a one-shot ?view= param (from a tapped notification) once consumed,
  // so a later manual reload restores the persisted view instead of being
  // permanently re-forced onto the camera page.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('view')) {
      const url = new URL(window.location.href);
      url.searchParams.delete('view');
      window.history.replaceState({}, '', url);
    }
  }, []);

  // When the app is already open and a push notification is tapped, the service
  // worker posts {type:'navigate'} instead of opening a fresh window.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent): void => {
      const data = e.data as { type?: string; url?: string } | null;
      if (data?.type !== 'navigate') return;
      try {
        const v = new URL(data.url ?? '', window.location.origin).searchParams.get('view');
        if (v === 'camera' || v === 'cameras') setView({ mode: 'cameras' });
      } catch {
        // ignore malformed url
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  // Stable callback so TerminalView's useEffect can list it in deps without
  // re-running on every parent render (which would tear down xterm + WS).
  const handleBack = useCallback(() => setView({ mode: 'list' }), []);

  return (
    <>
      {/* CameraViewer always mounted so phone camera stream persists across navigation */}
      <div style={{ display: view.mode === 'cameras' ? 'contents' : 'none' }}>
        <CameraViewer
          serverBase={HTTP_BASE}
          onBack={handleBack}
          visible={view.mode === 'cameras'}
        />
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
