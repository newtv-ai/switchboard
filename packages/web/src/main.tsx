import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

// Drive a `--app-h` CSS variable from the *visual* viewport so the layout
// shrinks above the virtual keyboard on mobile (CSS `100dvh` is unreliable on
// Android, especially MIUI/Xiaomi browsers, when an IME panel is up).
function trackVisualViewport(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  let lastH = 0;
  let raf = 0;
  const apply = (): void => {
    // Debounce with rAF — mobile browsers fire resize/scroll events in rapid
    // succession when the address bar animates.  Without this, the CSS var
    // update triggers a full layout every frame, causing the visible "refresh"
    // flicker on the home page even when idle.
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const h = vv.height;
      // Only write the CSS property when the height actually changes by more
      // than 1 CSS-px.  Sub-pixel jitter from the browser chrome sliding in
      // and out is imperceptible but triggers expensive relayouts.
      if (Math.abs(h - lastH) < 1) return;
      lastH = h;
      document.documentElement.style.setProperty('--app-h', `${h}px`);
    });
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  window.addEventListener('orientationchange', apply);
  // Initial measurement — no debounce needed.
  lastH = vv.height;
  document.documentElement.style.setProperty('--app-h', `${vv.height}px`);
}
trackVisualViewport();

// NOTE: deliberately NOT using StrictMode — the double-mount behavior causes
// duplicate WebSocket sessions, which we'd need a reconnect-with-sessionId flow
// to dedupe. Revisit when the home-screen session picker has session resume.
const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element missing');
createRoot(rootEl).render(<App />);
