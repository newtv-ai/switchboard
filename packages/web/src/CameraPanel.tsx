import { useEffect, useRef, useState } from 'react';
import { useCameraPush } from './use-camera-push.js';

export interface CameraPanelProps {
  serverBase: string;
}

export function CameraPanel({ serverBase }: CameraPanelProps): JSX.Element | null {
  const [available, setAvailable] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cam = useCameraPush(serverBase);

  useEffect(() => {
    fetch(`${serverBase}/api/camera/caps`)
      .then((r) => r.json())
      .then((caps: { available: boolean }) => setAvailable(caps.available))
      .catch(() => setAvailable(false));
  }, [serverBase]);

  useEffect(() => {
    if (videoRef.current && cam.localStream) {
      videoRef.current.srcObject = cam.localStream;
    }
    return () => { if (videoRef.current) videoRef.current.srcObject = null; };
  }, [cam.localStream]);

  useEffect(() => {
    return () => { cam.stop(); };
  }, [cam.stop]);

  if (!available) return null;

  const btnStyle: React.CSSProperties = {
    padding: '6px 12px',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '13px',
    color: '#fff',
    background: '#333',
  };

  return (
    <div style={{
      position: 'absolute',
      bottom: 50,
      right: 10,
      zIndex: 100,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: '6px',
    }}>
      {cam.isStreaming && expanded && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{
            width: 160,
            height: 120,
            borderRadius: '6px',
            border: '1px solid #555',
            objectFit: 'cover',
            background: '#000',
          }}
        />
      )}

      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {!cam.isStreaming ? (
          <button
            type="button"
            style={{ ...btnStyle, background: '#2563eb' }}
            onClick={() => cam.start()}
          >
            Camera
          </button>
        ) : (
          <>
            <button
              type="button"
              style={btnStyle}
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? 'Hide' : 'Show'}
            </button>
            <button type="button" style={btnStyle} onClick={() => cam.switchCamera()}>
              Flip
            </button>
            <button
              type="button"
              style={{ ...btnStyle, background: cam.isMuted ? '#dc2626' : '#333' }}
              onClick={() => cam.toggleMute()}
            >
              {cam.isMuted ? 'Unmute' : 'Mute'}
            </button>
            <button
              type="button"
              style={{ ...btnStyle, background: '#dc2626' }}
              onClick={() => cam.stop()}
            >
              Stop
            </button>
          </>
        )}
      </div>

      {cam.error && (
        <div style={{ color: '#f87171', fontSize: '12px', maxWidth: 200, textAlign: 'right' }}>
          {cam.error}
        </div>
      )}
    </div>
  );
}
