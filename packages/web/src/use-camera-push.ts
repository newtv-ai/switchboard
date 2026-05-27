import { useCallback, useRef, useState } from 'react';

export interface CameraPushState {
  isStreaming: boolean;
  localStream: MediaStream | null;
  error: string | null;
}

export interface CameraPushActions {
  start: (facingMode?: 'user' | 'environment') => Promise<void>;
  stop: () => void;
  switchCamera: () => Promise<void>;
  toggleMute: () => void;
  isMuted: boolean;
}

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];

/**
 * React hook: push phone camera+mic to go2rtc via WHIP.
 * The server proxies /api/camera/webrtc to go2rtc's WHIP endpoint.
 */
export function useCameraPush(serverBase: string): CameraPushState & CameraPushActions {
  const [isStreaming, setIsStreaming] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const facingRef = useRef<'user' | 'environment'>('environment');

  const stop = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    setLocalStream(null);
    setIsStreaming(false);
    setIsMuted(false);
  }, []);

  const start = useCallback(async (facingMode: 'user' | 'environment' = 'environment') => {
    stop();
    setError(null);
    facingRef.current = facingMode;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: true,
      });
      streamRef.current = stream;
      setLocalStream(stream);

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;

      for (const track of stream.getTracks()) {
        pc.addTransceiver(track, { direction: 'sendonly' });
      }

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Wait briefly for host ICE candidates (local network, instant).
      // Don't wait for STUN — often unreachable in China / corporate networks.
      await Promise.race([
        new Promise<void>((resolve) => {
          if (pc.iceGatheringState === 'complete') { resolve(); return; }
          pc.addEventListener('icegatheringstatechange', () => {
            if (pc.iceGatheringState === 'complete') resolve();
          });
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);

      const sdpOffer = pc.localDescription?.sdp;
      if (!sdpOffer) throw new Error('No local SDP');

      const resp = await fetch(`${serverBase}/api/camera/webrtc?dst=phone_cam`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: sdpOffer,
      });

      if (!resp.ok) {
        throw new Error(`WHIP failed: ${resp.status} ${await resp.text()}`);
      }

      const sdpAnswer = await resp.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: sdpAnswer });

      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'failed') {
          setError('WebRTC connection lost');
          stop();
        }
      });

      setIsStreaming(true);
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      stop();
    }
  }, [serverBase, stop]);

  const switchCamera = useCallback(async () => {
    const newFacing = facingRef.current === 'user' ? 'environment' : 'user';
    if (isStreaming) {
      await start(newFacing);
    }
  }, [isStreaming, start]);

  const toggleMute = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    for (const track of stream.getAudioTracks()) {
      track.enabled = !track.enabled;
    }
    setIsMuted((m) => !m);
  }, []);

  return { isStreaming, localStream, error, start, stop, switchCamera, toggleMute, isMuted };
}
