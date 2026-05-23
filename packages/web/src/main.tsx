import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

// Drive a `--app-h` CSS variable from the *visual* viewport so the layout
// shrinks above the virtual keyboard on mobile (CSS `100dvh` is unreliable on
// Android, especially MIUI/Xiaomi browsers, when an IME panel is up).
function trackVisualViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = (): void => {
    document.documentElement.style.setProperty('--app-h', `${vv.height}px`);
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  window.addEventListener('orientationchange', apply);
  apply();
}
trackVisualViewport();

// NOTE: deliberately NOT using StrictMode — the double-mount behavior causes
// duplicate WebSocket sessions, which we'd need a reconnect-with-sessionId flow
// to dedupe. Revisit when the home-screen session picker has session resume.
const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element missing');
createRoot(rootEl).render(<App />);
