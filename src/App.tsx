import { ChangeEvent, useEffect, useRef, useState } from 'react';

type Health = {
  status: 'healthy' | 'degraded';
  environment: string;
  database: { status: string; error_type: string | null };
  device: { configured: string; selected: string };
  model: { status: string; identifier: string };
  volume: { status: string; free_bytes?: number; error?: string };
};

type VideoMetadata = {
  width: number;
  height: number;
  fps: number | null;
  reported_frame_count: number | null;
  duration_ms: number | null;
};

type VideoSession = {
  id: string;
  filename: string;
  source_type: string;
  status: 'uploading' | 'queued' | 'processing' | 'paused' | 'stopping' | 'stopped' | 'completed' | 'failed';
  created_at: string;
  uploaded_bytes: number;
  processed_frames: number;
  metadata: VideoMetadata | null;
  error: string | null;
  result_url: string;
};

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [video, setVideo] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [session, setSession] = useState<VideoSession | null>(null);
  const [recentSessions, setRecentSessions] = useState<VideoSession[]>([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraSocketRef = useRef<WebSocket | null>(null);
  const cameraTimerRef = useRef<number | null>(null);
  const cameraFrameRef = useRef(0);
  const cameraDroppedRef = useRef(0);
  const cameraInFlightRef = useRef(false);
  const cameraPausedRef = useRef(false);

  useEffect(() => {
    let active = true;
    fetch('/api/v1/health')
      .then(async (response) => {
        if (!response.ok) throw new Error(`Health endpoint returned ${response.status}`);
        return (await response.json()) as Health;
      })
      .then((data) => {
        if (active) setHealth(data);
      })
      .catch(() => {
        if (active) setError('RodAI backend is not reachable. Start the local services and refresh.');
      });
    fetch('/api/v1/sessions?limit=20')
      .then(async (response) => {
        if (!response.ok) throw new Error(`Session list returned ${response.status}`);
        return (await response.json()) as VideoSession[];
      })
      .then((items) => {
        if (active) setRecentSessions(items);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!video) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(video);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [video]);

  useEffect(() => {
    const element = cameraVideoRef.current;
    if (element && cameraActive && cameraStreamRef.current) {
      element.srcObject = cameraStreamRef.current;
      void element.play().catch(() => undefined);
    }
  }, [cameraActive, session?.id]);

  useEffect(() => {
    if (!session || ['completed', 'failed', 'stopped'].includes(session.status)) return;
    let active = true;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/v1/sessions/${session.id}`);
        if (!response.ok) throw new Error(`Session status returned ${response.status}`);
        const current = (await response.json()) as VideoSession;
        if (active) setSession(current);
        if (['completed', 'failed', 'stopped'].includes(current.status)) {
          window.clearInterval(timer);
          fetch('/api/v1/sessions?limit=20')
            .then((result) => result.json() as Promise<VideoSession[]>)
            .then((items) => setRecentSessions(items))
            .catch(() => undefined);
        }
      } catch {
        if (active) setSessionError('Could not refresh session progress. Check the backend connection.');
        window.clearInterval(timer);
      }
    }, 700);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [session?.id]);

  useEffect(() => () => {
    if (cameraTimerRef.current !== null) window.clearInterval(cameraTimerRef.current);
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraSocketRef.current?.close();
  }, []);

  function chooseVideo(event: ChangeEvent<HTMLInputElement>) {
    setSession(null);
    setSessionError(null);
    setUploadProgress(0);
    setVideo(event.target.files?.[0] ?? null);
  }

  function uploadVideo() {
    if (!video) return;
    setSessionError(null);
    setUploadProgress(0);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/v1/sessions/video?filename=${encodeURIComponent(video.name)}`);
    xhr.setRequestHeader('Content-Type', video.type || 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        setUploadProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => setSessionError('Upload failed. Check your connection and try again.');
    xhr.onload = () => {
      let payload: VideoSession | { detail?: string };
      try {
        payload = JSON.parse(xhr.responseText) as VideoSession | { detail?: string };
      } catch {
        setSessionError(`The server returned an unreadable response (${xhr.status}).`);
        return;
      }
      if (xhr.status !== 202) {
        setSessionError('detail' in payload ? payload.detail ?? 'Video upload failed.' : 'Video upload failed.');
        return;
      }
      setSession(payload as VideoSession);
      fetch('/api/v1/sessions?limit=20')
        .then((response) => response.json() as Promise<VideoSession[]>)
        .then(setRecentSessions)
        .catch(() => undefined);
    };
    xhr.send(video);
  }

  async function startCamera() {
    setSessionError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setSessionError('This browser does not provide camera access. Use a supported browser on localhost or HTTPS.');
      return;
    }
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      const response = await fetch('/api/v1/sessions/live', { method: 'POST' });
      const payload = await response.json() as VideoSession | { detail?: string };
      if (!response.ok) {
        throw new Error('detail' in payload ? payload.detail ?? 'Could not create camera session.' : 'Could not create camera session.');
      }
      const liveSession = payload as VideoSession;
      cameraStreamRef.current = stream;
      setSession(liveSession);
      setCameraActive(true);
      cameraFrameRef.current = 0;
      cameraDroppedRef.current = 0;
      cameraInFlightRef.current = false;
      cameraPausedRef.current = false;

      const websocketUrl = new URL(`/api/v1/sessions/ws/${liveSession.id}`, window.location.href);
      websocketUrl.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(websocketUrl);
      cameraSocketRef.current = socket;
      socket.onopen = () => {
        cameraTimerRef.current = window.setInterval(() => {
          const videoElement = cameraVideoRef.current;
          const canvas = cameraCanvasRef.current;
          if (cameraPausedRef.current || !videoElement || !canvas || videoElement.readyState < 2) return;
          const frameId = cameraFrameRef.current++;
          if (cameraInFlightRef.current) {
            cameraDroppedRef.current += 1;
            return;
          }
          const context = canvas.getContext('2d');
          if (!context || socket.readyState !== WebSocket.OPEN) return;
          canvas.width = videoElement.videoWidth;
          canvas.height = videoElement.videoHeight;
          context.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
          cameraInFlightRef.current = true;
          canvas.toBlob((blob) => {
            if (!blob || socket.readyState !== WebSocket.OPEN) {
              cameraInFlightRef.current = false;
              return;
            }
            socket.send(JSON.stringify({
              protocol: 'rodai.v1',
              type: 'frame',
              frame_id: frameId,
              capture_timestamp_ms: Date.now(),
              dropped_since_last: cameraDroppedRef.current,
            }));
            socket.send(blob);
            cameraDroppedRef.current = 0;
          }, 'image/jpeg', 0.82);
        }, 200);
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          setSessionError('The camera stream returned an invalid response.');
          return;
        }
        if (message.type === 'frame_result') {
          cameraInFlightRef.current = false;
          setSession((current) => current ? {
            ...current,
            status: 'processing',
            processed_frames: Number(message.processed_frames ?? current.processed_frames),
            metadata: {
              width: Number(message.width ?? current.metadata?.width ?? 0),
              height: Number(message.height ?? current.metadata?.height ?? 0),
              fps: null,
              reported_frame_count: null,
              duration_ms: Number(message.duration_ms ?? current.metadata?.duration_ms ?? 0),
            },
          } : current);
        } else if (message.type === 'error') {
          cameraInFlightRef.current = false;
          setSessionError(`Camera frame rejected (${String(message.code)}).`);
        } else if (message.type === 'session_ended') {
          cameraInFlightRef.current = false;
          setSession((current) => current ? {
            ...current,
            status: message.status === 'failed' ? 'failed' : 'stopped',
            processed_frames: Number(message.processed_frames ?? current.processed_frames),
          } : current);
          releaseCamera();
        }
      };
      socket.onerror = () => setSessionError('The camera stream could not reach the backend.');
      socket.onclose = () => {
        releaseCamera();
        fetch(`/api/v1/sessions/${liveSession.id}`)
          .then((result) => result.ok ? result.json() as Promise<VideoSession> : null)
          .then((current) => { if (current) setSession(current); })
          .catch(() => undefined);
      };
    } catch (cause) {
      stream?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
      setCameraActive(false);
      setSessionError(cause instanceof Error ? cause.message : 'Camera could not be started.');
    }
  }

  function releaseCamera() {
    if (cameraTimerRef.current !== null) window.clearInterval(cameraTimerRef.current);
    cameraTimerRef.current = null;
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    cameraInFlightRef.current = false;
    setCameraActive(false);
  }

  async function deleteSession() {
    if (!session) return;
    try {
      const response = await fetch(`/api/v1/sessions/${session.id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(`Delete returned ${response.status}`);
      setSession(null);
      setVideo(null);
      setRecentSessions((items) => items.filter((item) => item.id !== session.id));
      setUploadProgress(0);
      setSessionError(null);
    } catch {
      setSessionError('Could not delete this session. Please try again.');
    }
  }

  async function controlSession(action: 'pause' | 'resume' | 'stop') {
    if (!session) return;
    setSessionError(null);
    try {
      const response = await fetch(`/api/v1/sessions/${session.id}/${action}`, { method: 'POST' });
      const payload = (await response.json()) as VideoSession | { detail?: string };
      if (!response.ok) {
        throw new Error('detail' in payload ? payload.detail ?? 'Session control failed.' : 'Session control failed.');
      }
      if (action === 'pause') cameraPausedRef.current = true;
      if (action === 'resume') cameraPausedRef.current = false;
      if (action === 'stop' && session.source_type === 'browser_camera' && cameraSocketRef.current?.readyState === WebSocket.OPEN) {
        cameraSocketRef.current.send(JSON.stringify({ protocol: 'rodai.v1', type: 'stop' }));
      }
      setSession(payload as VideoSession);
    } catch (cause) {
      setSessionError(cause instanceof Error ? cause.message : 'Session control failed.');
    }
  }

  async function openSession(sessionId: string) {
    setSessionError(null);
    try {
      const response = await fetch(`/api/v1/sessions/${sessionId}`);
      if (!response.ok) throw new Error(`Session returned ${response.status}`);
      setVideo(null);
      setSession((await response.json()) as VideoSession);
    } catch {
      setSessionError('Could not open this saved session. Refresh the page and try again.');
    }
  }

  const busy = session !== null && !['completed', 'failed', 'stopped'].includes(session.status);

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand" aria-label="RodAI">
          <img className="brand-mark" src="/brand/rodai-mark.svg" alt="" />
          <span className="brand-wordmark">Rod<span>AI</span></span>
        </div>
        <span className="phase-label">VIDEO PIPELINE</span>
      </header>
      <section className="workspace" aria-labelledby="welcome-title">
        <div className="scene">
          <div className="scene-header">
            <div><p className="eyebrow">PERCEPTION WORKSPACE</p><h1 id="welcome-title">Road scene</h1></div>
            <span className="state-pill"><span className="state-dot" />{busy ? friendlyStatus(session.status) : 'Ready for video'}</span>
          </div>
          <section className="video-workspace" aria-label="Video upload and processing">
            <div className="upload-card">
              <label className="eyebrow" htmlFor="road-video">UPLOAD A ROAD VIDEO</label>
              <p className="upload-help">MP4, MOV, MKV, WebM, or AVI. Processing runs locally, frame by frame.</p>
              <div className="upload-controls">
                <input
                  id="road-video"
                  type="file"
                  accept="video/mp4,video/quicktime,video/x-matroska,video/webm,video/x-msvideo,.m4v"
                  onChange={chooseVideo}
                  disabled={busy}
                />
                <button type="button" onClick={uploadVideo} disabled={!video || busy}>
                  {busy ? 'Processing…' : session?.status === 'completed' ? 'Process another video' : 'Process video'}
                </button>
                <button type="button" className="secondary-button" onClick={startCamera} disabled={busy || cameraActive}>
                  Start camera
                </button>
              </div>
              {video && <p className="selected-file">{video.name} · {formatBytes(video.size)}</p>}
              {sessionError && <p className="error-message" role="alert">{sessionError}</p>}
              {uploadProgress > 0 && uploadProgress < 100 && (
                <div className="progress-line" role="status">
                  <span>Uploading video</span><span>{uploadProgress}%</span>
                  <progress max="100" value={uploadProgress} aria-label="Upload progress" />
                </div>
              )}
            </div>

            {previewUrl && (
              <div className="video-preview">
                <video src={previewUrl} controls preload="metadata" aria-label="Selected road video preview" />
              </div>
            )}

            {cameraActive && (
              <div className="video-preview">
                <video ref={cameraVideoRef} autoPlay muted playsInline aria-label="Live browser camera preview" />
                <canvas ref={cameraCanvasRef} hidden />
              </div>
            )}

            {session && (
              <div className="session-card" aria-live="polite">
                <div className="session-heading">
                  <div>
                    <p className="eyebrow">PROCESSING SESSION</p>
                    <h2>{friendlyStatus(session.status)}</h2>
                  </div>
                  <span className={`session-state ${session.status}`}>{session.status}</span>
                </div>
                {session.status === 'uploading' && <p>Receiving {formatBytes(session.uploaded_bytes)}…</p>}
                {session.status === 'queued' && <p>Upload complete. Preparing the video decoder…</p>}
                {session.status === 'processing' && (
                  <p>{session.source_type === 'browser_camera' ? 'Received' : 'Decoded'} {session.processed_frames.toLocaleString()} frames. Inference is not run yet.</p>
                )}
                {session.status === 'paused' && <p>Processing is paused at {session.processed_frames.toLocaleString()} frames.</p>}
                {session.status === 'stopping' && <p>Stopping after the current frame…</p>}
                {session.status === 'stopped' && <p>Session stopped after {session.processed_frames.toLocaleString()} frames. Partial results are available.</p>}
                {session.status === 'failed' && <p className="error-message" role="alert">{session.error}</p>}
                {session.metadata && (
                  <dl className="video-metadata">
                    <div><dt>Video size</dt><dd>{session.metadata.width} × {session.metadata.height}</dd></div>
                    <div><dt>Frame rate</dt><dd>{session.metadata.fps ? `${session.metadata.fps.toFixed(2)} FPS` : 'Unknown'}</dd></div>
                    <div><dt>Frames processed</dt><dd>{session.processed_frames.toLocaleString()}</dd></div>
                    <div><dt>Duration</dt><dd>{session.metadata.duration_ms ? formatDuration(session.metadata.duration_ms) : 'Unknown'}</dd></div>
                  </dl>
                )}
                {session.status === 'processing' && (
                  <div className="session-actions">
                    <button className="secondary-button" type="button" onClick={() => controlSession('pause')}>Pause</button>
                    <button className="secondary-button" type="button" onClick={() => controlSession('stop')}>Stop</button>
                  </div>
                )}
                {session.status === 'paused' && (
                  <div className="session-actions">
                    <button type="button" onClick={() => controlSession('resume')}>Resume</button>
                    <button className="secondary-button" type="button" onClick={() => controlSession('stop')}>Stop</button>
                  </div>
                )}
                {session.status === 'queued' && (
                  <div className="session-actions">
                    <button className="secondary-button" type="button" onClick={() => controlSession('stop')}>Stop</button>
                  </div>
                )}
                {['completed', 'failed', 'stopped'].includes(session.status) && (
                  <div className="session-actions">
                    {['completed', 'stopped'].includes(session.status) && (
                      <a className="download-link" href={session.result_url}>Download frame results (.jsonl)</a>
                    )}
                    <button className="secondary-button" type="button" onClick={deleteSession}>Delete session results</button>
                  </div>
                )}
              </div>
            )}

            {!session && recentSessions.length > 0 && (
              <section className="recent-sessions" aria-label="Recent video sessions">
                <h2>Recent sessions</h2>
                <ul>
                  {recentSessions.map((item) => (
                    <li key={item.id}>
                      <button type="button" className="session-link" onClick={() => openSession(item.id)}>
                        <span>{item.filename}</span>
                        <span className={`session-state ${item.status}`}>{friendlyStatus(item.status)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {!session && !previewUrl && recentSessions.length === 0 && (
              <div className="scene-empty">
                <div className="road-icon" aria-hidden="true"><span /></div>
                <h2>Choose a video to begin</h2>
                <p>RodAI validates the file, decodes every frame, and saves a frame-aligned session export. The detector is not configured yet.</p>
              </div>
            )}
          </section>
          <footer className="scene-footer">Frame decoding only. No detections, tracks, physical speeds, or risk output are generated in this phase.</footer>
        </div>
        <aside className="status-panel" aria-label="System status">
          <h2>System status</h2>
          {error && <p className="error-message" role="status">{error}</p>}
          {!health && !error && <p className="muted">Checking backend status…</p>}
          {health && <dl>
            <div><dt>Environment</dt><dd>{health.environment}</dd></div>
            <div><dt>Backend</dt><dd>{health.status}</dd></div>
            <div><dt>Database</dt><dd>{health.database.status}</dd></div>
            <div><dt>Processing device</dt><dd>{health.device.selected}</dd></div>
            <div><dt>Detector</dt><dd>{health.model.status}</dd></div>
            <div><dt>Data volume</dt><dd>{health.volume.status}</dd></div>
            {health.volume.free_bytes !== undefined && <div><dt>Free space</dt><dd>{formatBytes(health.volume.free_bytes)}</dd></div>}
          </dl>}
          <p className="panel-note">Session status comes from the backend. Detector inference arrives in Phase 3.</p>
        </aside>
      </section>
      <footer className="app-footer">
        <strong>RodAI</strong>
        <span>Local-first road perception laboratory</span>
        <span className="product-credit">
          A product by <a className="parent-brand" href="https://cursorclick.dev" target="_blank" rel="noreferrer" aria-label="CursorClick.dev, the RodAI product studio">
            <img src="/brand/cursorclick-mark.svg" alt="" />
            <span>CursorClick<span className="parent-domain">.dev</span></span>
          </a>
        </span>
      </footer>
    </main>
  );
}

function friendlyStatus(status: VideoSession['status']): string {
  const labels: Record<VideoSession['status'], string> = {
    uploading: 'Uploading',
    queued: 'Waiting to process',
    processing: 'Processing',
    paused: 'Paused',
    stopping: 'Stopping',
    stopped: 'Stopped',
    completed: 'Completed',
    failed: 'Failed',
  };
  return labels[status];
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
