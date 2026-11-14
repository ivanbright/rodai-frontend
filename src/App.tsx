import { ChangeEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { SimulationLab } from './SimulationLab';
import { apiUrl, apiWebSocketUrl } from './api';
import { countLineCrossings, type CountingLine, type ImagePoint } from './movement';

type Health = {
  status: 'healthy' | 'degraded';
  environment: string;
  database: { status: string; error_type: string | null };
  device: { configured: string; selected: string };
  model: { status: string; identifier: string };
  retention: { status: string; failed_deletions: number | null; error_type?: string };
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
  analysis_fps?: number | null;
  metadata: VideoMetadata | null;
  error: string | null;
  result_url: string;
  camera_settings?: { max_width: number; max_height: number; jpeg_quality: number } | null;
  dropped_frames?: number;
};
type RoadTrack = {
  track_id: number;
  label: string;
  confidence: number;
  bbox_xyxy: [number, number, number, number];
  center_xy: [number, number];
  velocity_px_s: [number, number];
  speed_px_s: number | null;
  trail_xy: [number, number][];
};
type DetectionFrame = { timestamp_ms: number | null; tracks: RoadTrack[] };
type TrackingSummary = { trackIds: number; peakInFrame: number; classes: Record<string, number> };

const CAMERA_SIZES = [{ width: 640, height: 360 }, { width: 960, height: 540 }, { width: 1280, height: 720 }];

export function App() {
  const [activeWorkspace, setActiveWorkspace] = useState<'lab' | 'video'>('video');
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [video, setVideo] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [savedVideoUrl, setSavedVideoUrl] = useState<string | null>(null);
  const videoSourceUrl = previewUrl ?? savedVideoUrl;
  const [session, setSession] = useState<VideoSession | null>(null);
  const [recentSessions, setRecentSessions] = useState<VideoSession[]>([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraSize, setCameraSize] = useState(CAMERA_SIZES[2]);
  const [cameraQuality, setCameraQuality] = useState(0.82);
  const [analysisFps, setAnalysisFps] = useState(2);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
  const uploadCardRef = useRef<HTMLDivElement | null>(null);
  const cameraCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraSocketRef = useRef<WebSocket | null>(null);
  const cameraTimerRef = useRef<number | null>(null);
  const cameraFrameRef = useRef(0);
  const cameraDroppedRef = useRef(0);
  const cameraInFlightRef = useRef(false);
  const cameraPausedRef = useRef(false);
  const [cameraTracks, setCameraTracks] = useState<RoadTrack[]>([]);
  const [videoTracks, setVideoTracks] = useState<RoadTrack[]>([]);
  const [videoSummary, setVideoSummary] = useState<TrackingSummary | null>(null);
  const [countingLine, setCountingLine] = useState<CountingLine | null>(null);
  const [lineDraft, setLineDraft] = useState<CountingLine | null>(null);
  const [settingCountingLine, setSettingCountingLine] = useState(false);
  const lineStartRef = useRef<ImagePoint | null>(null);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const detectionFramesRef = useRef<DetectionFrame[]>([]);
  const uploadedVideoRef = useRef<HTMLVideoElement | null>(null);
  const videoStageRef = useRef<HTMLDivElement | null>(null);
  const overlayAnimationRef = useRef<number | null>(null);
  const [videoFullscreen, setVideoFullscreen] = useState(false);
  const flowSummary = useMemo(
    () => countingLine ? countLineCrossings(detectionFramesRef.current, countingLine) : null,
    [countingLine, videoSummary],
  );

  useEffect(() => {
    const updateFullscreen = () => setVideoFullscreen(document.fullscreenElement === videoStageRef.current);
    document.addEventListener('fullscreenchange', updateFullscreen);
    return () => document.removeEventListener('fullscreenchange', updateFullscreen);
  }, []);

  useEffect(() => {
    let active = true;
    fetch(apiUrl('/api/v1/health'))
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
    fetch(apiUrl('/api/v1/sessions?limit=20'))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Session list returned ${response.status}`);
        return (await response.json()) as VideoSession[];
      })
      .then((items) => {
        if (!active) return;
        setRecentSessions(items);
        const latestVideo = items.find((item) => item.source_type === 'video' && (
          ['uploading', 'queued', 'processing', 'paused', 'stopping'].includes(item.status)
          || (['completed', 'stopped'].includes(item.status) && item.processed_frames > 0)
        ));
        if (latestVideo) void openSession(latestVideo.id);
      })
      .catch(() => undefined);
    const healthTimer = window.setInterval(() => {
      fetch(apiUrl('/api/v1/health'))
        .then((response) => response.ok ? response.json() as Promise<Health> : null)
        .then((data) => { if (active && data) setHealth(data); })
        .catch(() => undefined);
    }, 3000);
    return () => {
      active = false;
      window.clearInterval(healthTimer);
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
        const response = await fetch(apiUrl(`/api/v1/sessions/${session.id}`));
        if (!response.ok) throw new Error(`Session status returned ${response.status}`);
        const current = (await response.json()) as VideoSession;
        if (active) setSession(current);
        if (['completed', 'failed', 'stopped'].includes(current.status)) {
          window.clearInterval(timer);
          fetch(apiUrl('/api/v1/sessions?limit=20'))
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

  useEffect(() => {
    if (!session || session.source_type === 'browser_camera' || !videoSourceUrl
      || !['completed', 'stopped'].includes(session.status) || session.processed_frames === 0) return;
    let active = true;
    fetch(apiUrl(session.result_url))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Results returned ${response.status}`);
        return response.text();
      })
      .then((body) => {
        if (!active) return;
        detectionFramesRef.current = body.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as {
          type: string; timestamp_ms?: number | null; tracks?: RoadTrack[];
        }).filter((record) => record.type === 'frame').map((record) => ({
          timestamp_ms: record.timestamp_ms ?? null, tracks: record.tracks ?? [],
        }));
        const identities = new Map<number, string>();
        let peakInFrame = 0;
        for (const frame of detectionFramesRef.current) {
          peakInFrame = Math.max(peakInFrame, frame.tracks.length);
          for (const track of frame.tracks) identities.set(track.track_id, track.label);
        }
        const classes: Record<string, number> = {};
        for (const label of identities.values()) classes[label] = (classes[label] ?? 0) + 1;
        setVideoSummary({ trackIds: identities.size, peakInFrame, classes });
        updateVideoDetections();
      })
      .catch(() => { if (active) setSessionError('Analysis finished, but RodAI could not load the video overlay. Refresh this session to try again.'); });
    return () => { active = false; };
  }, [session?.id, session?.status, videoSourceUrl]);

  useEffect(() => () => {
    if (cameraTimerRef.current !== null) window.clearInterval(cameraTimerRef.current);
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraSocketRef.current?.close();
  }, []);

  function chooseVideo(event: ChangeEvent<HTMLInputElement>) {
    setSession(null);
    setSessionError(null);
    setUploadProgress(0);
    setVideoSummary(null);
    setCountingLine(null);
    setLineDraft(null);
    setSettingCountingLine(false);
    setVideoTracks([]);
    setExportError(null);
    setExportProgress(null);
    setSavedVideoUrl(null);
    setVideo(event.target.files?.[0] ?? null);
  }

  function getImagePoint(event: ReactPointerEvent<SVGSVGElement>, width: number, height: number): ImagePoint {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(width, (event.clientX - bounds.left) / bounds.width * width)),
      y: Math.max(0, Math.min(height, (event.clientY - bounds.top) / bounds.height * height)),
    };
  }

  function startCountingLine(event: ReactPointerEvent<SVGSVGElement>, width: number, height: number) {
    if (!settingCountingLine) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = getImagePoint(event, width, height);
    lineStartRef.current = point;
    setLineDraft({ start: point, end: point });
  }

  function moveCountingLine(event: ReactPointerEvent<SVGSVGElement>, width: number, height: number) {
    if (!settingCountingLine || !lineStartRef.current) return;
    setLineDraft({ start: lineStartRef.current, end: getImagePoint(event, width, height) });
  }

  function finishCountingLine(event: ReactPointerEvent<SVGSVGElement>, width: number, height: number) {
    const start = lineStartRef.current;
    if (!settingCountingLine || !start) return;
    const end = getImagePoint(event, width, height);
    lineStartRef.current = null;
    setLineDraft(null);
    if (Math.hypot(end.x - start.x, end.y - start.y) < 24) {
      setSessionError('Drag a line across the road in the video to set a count line.');
      return;
    }
    setSessionError(null);
    setCountingLine({ start, end });
    setSettingCountingLine(false);
  }

  function uploadVideo() {
    if (!video) return;
    setSessionError(null);
    setUploadProgress(0);
    const xhr = new XMLHttpRequest();
    const query = new URLSearchParams({ filename: video.name, analysis_fps: String(analysisFps) });
    xhr.open('POST', apiUrl(`/api/v1/sessions/video?${query.toString()}`));
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
      fetch(apiUrl('/api/v1/sessions?limit=20'))
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
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: cameraSize.width }, height: { ideal: cameraSize.height } }, audio: false,
      });
      const response = await fetch(apiUrl('/api/v1/sessions/live'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_width: cameraSize.width, max_height: cameraSize.height, jpeg_quality: cameraQuality }),
      });
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

      const socket = new WebSocket(apiWebSocketUrl(`/api/v1/sessions/ws/${liveSession.id}`));
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
          const settings = liveSession.camera_settings ?? { max_width: cameraSize.width, max_height: cameraSize.height, jpeg_quality: cameraQuality };
          const scale = Math.min(1, settings.max_width / videoElement.videoWidth, settings.max_height / videoElement.videoHeight);
          canvas.width = Math.max(1, Math.round(videoElement.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(videoElement.videoHeight * scale));
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
          }, 'image/jpeg', settings.jpeg_quality);
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
            dropped_frames: Number(message.dropped_frames ?? current.dropped_frames ?? 0),
            metadata: {
              width: Number(message.width ?? current.metadata?.width ?? 0),
              height: Number(message.height ?? current.metadata?.height ?? 0),
              fps: null,
              reported_frame_count: null,
              duration_ms: Number(message.duration_ms ?? current.metadata?.duration_ms ?? 0),
            },
          } : current);
          setCameraTracks(Array.isArray(message.tracks) ? message.tracks as RoadTrack[] : []);
        } else if (message.type === 'error') {
          cameraInFlightRef.current = false;
          setSessionError(`Camera frame rejected (${String(message.code)}).`);
        } else if (message.type === 'session_ended') {
          cameraInFlightRef.current = false;
          setSession((current) => current ? {
            ...current,
            status: message.status === 'failed' ? 'failed' : 'stopped',
            processed_frames: Number(message.processed_frames ?? current.processed_frames),
            dropped_frames: Number(message.dropped_frames ?? current.dropped_frames ?? 0),
          } : current);
          setCameraTracks([]);
          releaseCamera();
        }
      };
      socket.onerror = () => setSessionError('The camera stream could not reach the backend.');
      socket.onclose = () => {
        releaseCamera();
        fetch(apiUrl(`/api/v1/sessions/${liveSession.id}`))
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

  function updateVideoDetections() {
    const target = (uploadedVideoRef.current?.currentTime ?? 0) * 1000;
    const frames = detectionFramesRef.current;
    let selectedIndex = -1;
    for (const frame of frames) {
      if (frame.timestamp_ms !== null && frame.timestamp_ms <= target) selectedIndex = frames.indexOf(frame);
      else if (frame.timestamp_ms !== null && frame.timestamp_ms > target) break;
    }
    const selected = frames[selectedIndex];
    const next = frames[selectedIndex + 1];
    const frameRate = session?.analysis_fps ?? 2;
    const maxGapMs = Math.max(1000 / frameRate * 1.6, 700);
    if (!selected || selected.timestamp_ms === null || target - selected.timestamp_ms > maxGapMs) {
      setVideoTracks([]);
      return;
    }
    const canInterpolate = next?.timestamp_ms !== null && next?.timestamp_ms !== undefined
      && next.timestamp_ms > selected.timestamp_ms && next.timestamp_ms - selected.timestamp_ms <= maxGapMs;
    const progress = canInterpolate
      ? Math.max(0, Math.min(1, (target - selected.timestamp_ms) / (next.timestamp_ms! - selected.timestamp_ms)))
      : 0;
    const nextTracks = new Map((canInterpolate ? next.tracks : []).map((track) => [track.track_id, track]));
    const tracks = selected.tracks.map((track) => {
      const following = nextTracks.get(track.track_id);
      if (!following || progress === 0) return track;
      const mix = (a: number, b: number) => a + (b - a) * progress;
      return {
        ...track,
        bbox_xyxy: track.bbox_xyxy.map((value, index) => mix(value, following.bbox_xyxy[index])) as RoadTrack['bbox_xyxy'],
        center_xy: track.center_xy.map((value, index) => mix(value, following.center_xy[index])) as RoadTrack['center_xy'],
      };
    });
    setVideoTracks(tracks);
  }

  function animateVideoDetections() {
    if (overlayAnimationRef.current !== null) window.cancelAnimationFrame(overlayAnimationRef.current);
    const tick = () => {
      updateVideoDetections();
      if (uploadedVideoRef.current && !uploadedVideoRef.current.paused && !uploadedVideoRef.current.ended) {
        overlayAnimationRef.current = window.requestAnimationFrame(tick);
      } else overlayAnimationRef.current = null;
    };
    overlayAnimationRef.current = window.requestAnimationFrame(tick);
  }

  async function toggleVideoFullscreen() {
    const stage = videoStageRef.current;
    if (!stage) return;
    try {
      if (document.fullscreenElement === stage) await document.exitFullscreen();
      else await stage.requestFullscreen();
    } catch {
      setSessionError('Fullscreen is unavailable in this browser.');
    }
  }

  async function exportAnnotatedVideo() {
    const videoElement = uploadedVideoRef.current;
    if (!videoElement || !session?.metadata || !videoSourceUrl || exportProgress !== null) return;
    const metadata = session.metadata;
    if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
      setExportError('This browser cannot export an annotated video. You can still play the annotated preview here.');
      return;
    }

    setExportError(null);
    setExportProgress(0);
    const width = videoElement.videoWidth || metadata.width;
    const height = videoElement.videoHeight || metadata.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      setExportError('The browser could not prepare the annotated video.');
      setExportProgress(null);
      return;
    }

    const mimeType = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ].find((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!mimeType) {
      setExportError('This browser does not support an export format for the annotated video.');
      setExportProgress(null);
      return;
    }

    const canvasStream = canvas.captureStream(metadata.fps || 30);
    const videoWithCapture = videoElement as HTMLVideoElement & { captureStream?: () => MediaStream };
    const sourceStream = videoWithCapture.captureStream?.() ?? null;
    const stream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...(sourceStream?.getAudioTracks() ?? []),
    ]);
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: Blob[] = [];
    const originalTime = videoElement.currentTime;
    const wasPlaying = !videoElement.paused;
    const analyzedFrames = detectionFramesRef.current.filter((frame) => frame.timestamp_ms !== null);
    const lastAnalyzedMs = analyzedFrames.reduce(
      (latest, frame) => Math.max(latest, frame.timestamp_ms ?? 0),
      0,
    );
    const exportEndSeconds = session.status === 'stopped'
      ? lastAnalyzedMs / 1000
      : videoElement.duration;
    let selectedFrameIndex = 0;
    let animationFrame = 0;
    let failed = false;

    const seekToStart = async () => {
      if (videoElement.currentTime < 0.01) return;
      await new Promise<void>((resolve) => {
        const onSeeked = () => {
          videoElement.removeEventListener('seeked', onSeeked);
          resolve();
        };
        videoElement.addEventListener('seeked', onSeeked, { once: true });
        videoElement.currentTime = 0;
      });
    };

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => {
      failed = true;
      setExportError('The browser stopped recording the annotated video. Please try again.');
      if (recorder.state !== 'inactive') recorder.stop();
    };
    recorder.onstop = () => {
      cancelAnimationFrame(animationFrame);
      stream.getTracks().forEach((track) => track.stop());
      sourceStream?.getTracks().forEach((track) => track.stop());
      if (!failed && chunks.length > 0) {
        const output = new Blob(chunks, { type: mimeType });
        const objectUrl = URL.createObjectURL(output);
        const anchor = document.createElement('a');
        const baseName = (session.filename || 'road-video').replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '-');
        anchor.href = objectUrl;
        anchor.download = `${baseName}-rodai-annotated.webm`;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
        setExportProgress(100);
      }
      videoElement.currentTime = originalTime;
      if (wasPlaying) void videoElement.play().catch(() => undefined);
      else videoElement.pause();
      setExportProgress(null);
    };

    const drawFrame = () => {
      if (videoElement.readyState >= 2) {
        context.drawImage(videoElement, 0, 0, width, height);
        const target = videoElement.currentTime * 1000;
        while (
          selectedFrameIndex + 1 < analyzedFrames.length
          && (analyzedFrames[selectedFrameIndex + 1].timestamp_ms ?? Infinity) <= target
        ) selectedFrameIndex += 1;
        const selected = analyzedFrames[selectedFrameIndex];
        const frameRate = session.analysis_fps ?? metadata.fps ?? 30;
        const maximumHoldMs = 1500 / frameRate;
        const tracks = selected?.timestamp_ms !== null && selected?.timestamp_ms !== undefined
          && target - selected.timestamp_ms <= maximumHoldMs
          ? selected.tracks
          : [];
        context.lineWidth = Math.max(2, width / 640 * 2);
        context.font = `700 ${Math.max(13, width / 64)}px system-ui, sans-serif`;
        for (const track of tracks) {
          const [x1, y1, x2, y2] = track.bbox_xyxy;
          if (track.trail_xy.length > 1) {
            context.beginPath();
            track.trail_xy.forEach(([x, y], index) => index === 0 ? context.moveTo(x, y) : context.lineTo(x, y));
            context.strokeStyle = '#ffbd62';
            context.stroke();
          }
          context.strokeStyle = '#49e0bc';
          context.strokeRect(x1, y1, x2 - x1, y2 - y1);
          const motion = track.speed_px_s === null ? '' : ` · ${track.speed_px_s.toFixed(0)} px/s`;
          const label = `#${track.track_id} ${track.label}${motion}`;
          const labelY = Math.max(22, y1 - 7);
          const labelWidth = context.measureText(label).width + 12;
          context.fillStyle = '#081421dc';
          context.fillRect(x1, labelY - Math.max(16, width / 80), labelWidth, Math.max(20, width / 50));
          context.fillStyle = '#eff8ff';
          context.fillText(label, x1 + 6, labelY);
        }
        if (countingLine) {
          context.beginPath();
          context.moveTo(countingLine.start.x, countingLine.start.y);
          context.lineTo(countingLine.end.x, countingLine.end.y);
          context.strokeStyle = '#ffd166';
          context.lineWidth = Math.max(3, width / 320);
          context.stroke();
          context.fillStyle = '#ffd166';
          context.beginPath();
          context.arc(countingLine.start.x, countingLine.start.y, Math.max(5, width / 100), 0, Math.PI * 2);
          context.arc(countingLine.end.x, countingLine.end.y, Math.max(5, width / 100), 0, Math.PI * 2);
          context.fill();
        }
        context.fillStyle = '#081421c9';
        context.fillRect(0, height - 38, Math.min(width, 340), 38);
        context.fillStyle = '#eff8ff';
        context.font = `600 ${Math.max(12, width / 100)}px system-ui, sans-serif`;
        context.fillText(`RODAI · EXPERIMENTAL TRACKING · ${(target / 1000).toFixed(1)}s`, 12, height - 14);
        const duration = exportEndSeconds || videoElement.duration || 0;
        setExportProgress(duration > 0 ? Math.min(99, Math.round(videoElement.currentTime / duration * 100)) : 0);
      }
      const reachedEnd = exportEndSeconds > 0 && videoElement.currentTime >= exportEndSeconds;
      if (!videoElement.ended && !reachedEnd && recorder.state === 'recording') {
        animationFrame = requestAnimationFrame(drawFrame);
      } else if (recorder.state === 'recording') {
        recorder.stop();
      }
    };

    try {
      await seekToStart();
      if (exportEndSeconds === 0) throw new Error('No analyzed frames are available to export.');
      updateVideoDetections();
      recorder.start(500);
      await videoElement.play();
      animationFrame = requestAnimationFrame(drawFrame);
      videoElement.addEventListener('ended', () => {
        if (recorder.state === 'recording') recorder.stop();
      }, { once: true });
    } catch {
      failed = true;
      if (recorder.state !== 'inactive') recorder.stop();
      setExportError('Could not start annotated video export. Try playing the preview, then export again.');
      setExportProgress(null);
      stream.getTracks().forEach((track) => track.stop());
      sourceStream?.getTracks().forEach((track) => track.stop());
    }
  }

  async function deleteSession() {
    if (!session) return;
    try {
      const response = await fetch(apiUrl(`/api/v1/sessions/${session.id}`), { method: 'DELETE' });
      if (!response.ok) throw new Error(`Delete returned ${response.status}`);
      setSession(null);
      setVideo(null);
      setSavedVideoUrl(null);
      setVideoSummary(null);
      setVideoTracks([]);
      setCountingLine(null);
      setLineDraft(null);
      setSettingCountingLine(false);
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
      const response = await fetch(apiUrl(`/api/v1/sessions/${session.id}/${action}`), { method: 'POST' });
      const payload = (await response.json()) as VideoSession | { detail?: string };
      if (!response.ok) {
        throw new Error('detail' in payload ? payload.detail ?? 'Session control failed.' : 'Session control failed.');
      }
      if (action === 'pause') cameraPausedRef.current = true;
      if (action === 'resume') cameraPausedRef.current = false;
      if (action === 'stop' && session.source_type === 'browser_camera' && cameraSocketRef.current?.readyState === WebSocket.OPEN) {
        cameraSocketRef.current.send(JSON.stringify({
          protocol: 'rodai.v1', type: 'stop', dropped_since_last: cameraDroppedRef.current,
        }));
      }
      setSession(payload as VideoSession);
    } catch (cause) {
      setSessionError(cause instanceof Error ? cause.message : 'Session control failed.');
    }
  }

  async function openSession(sessionId: string) {
    setSessionError(null);
    try {
      const response = await fetch(apiUrl(`/api/v1/sessions/${sessionId}`));
      if (!response.ok) throw new Error(`Session returned ${response.status}`);
      const savedSession = (await response.json()) as VideoSession;
      setVideo(null);
      setCountingLine(null);
      setLineDraft(null);
      setSettingCountingLine(false);
      setSavedVideoUrl(savedSession.source_type === 'video' ? apiUrl(`/api/v1/sessions/${sessionId}/video`) : null);
      setSession(savedSession);
    } catch {
      setSessionError('Could not open this saved session. Refresh the page and try again.');
    }
  }

  function returnToVideoWorkspace() {
    const uploadCard = uploadCardRef.current;
    if (!uploadCard) return;
    uploadCard.focus({ preventScroll: true });
    uploadCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const busy = session !== null && !['completed', 'failed', 'stopped'].includes(session.status);

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand" aria-label="RodAI">
          <img className="brand-mark" src="/brand/rodai-mark.svg" alt="" />
          <span className="brand-wordmark">Rod<span>AI</span></span>
        </div>
        <nav className="workspace-tabs" aria-label="RodAI workspaces">
          <button type="button" className={activeWorkspace === 'lab' ? 'active' : ''} onClick={() => setActiveWorkspace('lab')}>Simulation lab</button>
          <button type="button" className={activeWorkspace === 'video' ? 'active' : ''} onClick={() => setActiveWorkspace('video')}>Video analysis</button>
        </nav>
      </header>
      {activeWorkspace === 'lab' ? <SimulationLab /> : <section className="workspace video-layout" aria-labelledby="welcome-title">
        <div className="scene">
          <div className="scene-header">
            <div><p className="eyebrow">PERCEPTION WORKSPACE</p><h1 id="welcome-title">Road scene</h1></div>
            <span className="state-pill"><span className="state-dot" />{busy ? friendlyStatus(session.status) : 'Ready for video'}</span>
          </div>
          <section className="video-workspace" aria-label="Video upload and processing">
            <div className="upload-card" id="video-workspace" ref={uploadCardRef} tabIndex={-1}>
              <label className="eyebrow" htmlFor="road-video">UPLOAD A ROAD VIDEO</label>
              <p className="upload-help">MP4, MOV, MKV, WebM, or AVI. The CPU analyzes selected frames; more samples take longer and can still miss fast events.</p>
              <div className="upload-controls">
                <input
                  id="road-video"
                  type="file"
                  accept="video/mp4,video/quicktime,video/x-matroska,video/webm,video/x-msvideo,.m4v"
                  onChange={chooseVideo}
                  disabled={busy}
                />
                <button type="button" onClick={uploadVideo} disabled={!video || busy}>
                  {busy ? 'Processing…' : session && ['completed', 'stopped', 'failed'].includes(session.status) ? 'Process another video' : 'Process video'}
                </button>
                <button type="button" className="secondary-button" onClick={startCamera} disabled={busy || cameraActive}>
                  Start camera
                </button>
              </div>
              <div className="camera-settings">
                <label>Video analysis rate
                  <select value={analysisFps} onChange={(event) => setAnalysisFps(Number(event.target.value))} disabled={busy}>
                    <option value={1}>1 FPS · fastest</option>
                    <option value={2}>2 FPS · balanced</option>
                    <option value={5}>5 FPS · more detail</option>
                    <option value={10}>10 FPS · slowest</option>
                  </select>
                </label>
                <label>Camera maximum size
                  <select value={`${cameraSize.width}x${cameraSize.height}`} onChange={(event) => {
                    const selected = CAMERA_SIZES.find((size) => `${size.width}x${size.height}` === event.target.value);
                    if (selected) setCameraSize(selected);
                  }} disabled={busy || cameraActive}>
                    {CAMERA_SIZES.map((size) => <option key={size.width} value={`${size.width}x${size.height}`}>{size.width} Ã— {size.height}</option>)}
                  </select>
                </label>
                <label>JPEG quality: {cameraQuality.toFixed(2)}
                  <input type="range" min="0.5" max="0.95" step="0.05" value={cameraQuality}
                    onChange={(event) => setCameraQuality(Number(event.target.value))} disabled={busy || cameraActive} />
                </label>
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

            {videoSourceUrl && (
              <div className="video-viewer">
              <div className="video-preview live-video video-stage" ref={videoStageRef} style={{ aspectRatio: session?.metadata ? `${session.metadata.width} / ${session.metadata.height}` : '16 / 9' }}>
                <video ref={uploadedVideoRef} src={videoSourceUrl} controls controlsList="nofullscreen" preload="metadata" onTimeUpdate={updateVideoDetections} onPlay={animateVideoDetections} onPause={updateVideoDetections} onSeeked={updateVideoDetections} onError={() => setSessionError('The original upload is no longer available. It may have expired; upload the video again to review the overlay.')} aria-label="Road video preview with detection overlay" />
                {session && ['completed', 'stopped'].includes(session.status) && session.processed_frames > 0 && session.metadata && (
                  <svg
                    className={`detection-overlay${settingCountingLine ? ' count-line-editor' : ''}`}
                    viewBox={`0 0 ${session.metadata.width} ${session.metadata.height}`}
                    aria-label={settingCountingLine ? 'Drag to draw a traffic count line' : 'Detected road objects'}
                    onPointerDown={settingCountingLine ? (event) => startCountingLine(event, session.metadata!.width, session.metadata!.height) : undefined}
                    onPointerMove={settingCountingLine ? (event) => moveCountingLine(event, session.metadata!.width, session.metadata!.height) : undefined}
                    onPointerUp={settingCountingLine ? (event) => finishCountingLine(event, session.metadata!.width, session.metadata!.height) : undefined}
                  >
                    {videoTracks.map((track) => {
                      const [x1, y1, x2, y2] = track.bbox_xyxy;
                      const points = track.trail_xy.map(([x, y]) => `${x},${y}`).join(' ');
                      return <g key={track.track_id}>
                        {track.trail_xy.length > 1 && <polyline className="track-trail" points={points} />}
                        <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} />
                        <text x={x1} y={Math.max(18, y1 - 5)}>#{track.track_id} {track.label}{track.speed_px_s === null ? '' : ` · ${track.speed_px_s.toFixed(0)} px/s`}</text>
                      </g>;
                    })}
                    {(lineDraft ?? countingLine) && (() => {
                      const line = lineDraft ?? countingLine!;
                      return <g className="count-line-mark">
                        <line x1={line.start.x} y1={line.start.y} x2={line.end.x} y2={line.end.y} />
                        <circle cx={line.start.x} cy={line.start.y} r="9" />
                        <circle cx={line.end.x} cy={line.end.y} r="9" />
                        <text x={line.start.x + 12} y={line.start.y - 12}>A</text>
                        <text x={line.end.x + 12} y={line.end.y - 12}>B</text>
                      </g>;
                    })()}
                  </svg>
                )}
                <button type="button" className="fullscreen-button" onClick={toggleVideoFullscreen} aria-label={videoFullscreen ? 'Exit fullscreen video' : 'View video fullscreen'}>{videoFullscreen ? 'Exit fullscreen' : '⛶ Fullscreen'}</button>
                {session && ['completed', 'stopped'].includes(session.status) && session.processed_frames > 0 && <div className="tracking-readout">
                  <span>{videoTracks.length} tracked in this frame</span>
                  <span>{session.analysis_fps ?? 2} analyzed FPS · boxes interpolate between samples</span>
                </div>}
              </div>
              {session && ['completed', 'stopped'].includes(session.status) && session.processed_frames > 0 && session.source_type !== 'browser_camera' && (
                <div className="count-line-tools">
                  <button type="button" className="secondary-button" aria-pressed={settingCountingLine}
                    onClick={() => { setSettingCountingLine((active) => !active); setLineDraft(null); lineStartRef.current = null; }}>
                    {settingCountingLine ? 'Cancel line drawing' : countingLine ? 'Redraw count line' : 'Add traffic count line'}
                  </button>
                  {countingLine && <button type="button" className="secondary-button" onClick={() => setCountingLine(null)}>Clear line</button>}
                  <p>{settingCountingLine
                    ? 'Drag across the road in the video. The line counts each tracked ID once when its sampled path crosses.'
                    : 'Set a line across one road segment. Direction is reported as − to + or + to − relative to the A→B line.'}</p>
                </div>
              )}
              <p className="viewer-caption">Tracks are drawn from sampled detections. Box motion is interpolated between detector samples for smoother viewing; it does not add new detections.</p>
              </div>
            )}

            {cameraActive && (
              <div className="video-preview live-video">
                <video ref={cameraVideoRef} autoPlay muted playsInline aria-label="Live browser camera preview" />
                {session?.metadata && (
                  <svg className="detection-overlay" viewBox={`0 0 ${session.metadata.width} ${session.metadata.height}`} aria-label="Live object detections">
                    {cameraTracks.map((track) => {
                      const [x1, y1, x2, y2] = track.bbox_xyxy;
                      const points = track.trail_xy.map(([x, y]) => `${x},${y}`).join(' ');
                      return <g key={track.track_id}>
                        {track.trail_xy.length > 1 && <polyline className="track-trail" points={points} />}
                        <rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} />
                        <text x={x1} y={Math.max(18, y1 - 5)}>#{track.track_id} {track.label}{track.speed_px_s === null ? '' : ` · ${track.speed_px_s.toFixed(0)} px/s`}</text>
                      </g>;
                    })}
                  </svg>
                )}
                <canvas ref={cameraCanvasRef} hidden />
              </div>
            )}

            {session && (
              <div className="session-card" aria-live="polite">
                <div className="session-navigation">
                  <button type="button" className="secondary-button" onClick={returnToVideoWorkspace}>
                    <span aria-hidden="true">←</span> Back to video workspace
                  </button>
                  <span>Your analysis stays available while you move around this page.</span>
                </div>
                <div className="session-heading">
                  <div>
                    <p className="eyebrow">VIDEO ANALYSIS</p>
                    <h2>{session.status === 'stopped' && session.processed_frames === 0 ? 'No frames analyzed' : friendlyStatus(session.status)}</h2>
                  </div>
                  <span className={`session-state ${session.status}`}>{session.status}</span>
                </div>
                {session.status === 'uploading' && <p>Receiving {formatBytes(session.uploaded_bytes)}…</p>}
                {session.status === 'queued' && <p>Upload complete. Preparing the video decoder…</p>}
                {session.status === 'processing' && (
                  <p>{session.processed_frames === 0
                    ? 'Starting the vision model. First startup can take longer, especially if the model still needs to download. Keep this page open while RodAI prepares the analysis.'
                    : `Analyzed ${session.processed_frames.toLocaleString()} frames${session.analysis_fps ? ` at ${session.analysis_fps} samples per second` : ''}. Detecting road users and building track trails…`}</p>
                )}
                {session.source_type === 'browser_camera' && session.dropped_frames !== undefined && (
                  <p>Live preview frames dropped: {session.dropped_frames.toLocaleString()}</p>
                )}
                {session.source_type === 'browser_camera' && session.status === 'processing' && (
                  <p>{cameraTracks.length} tracked road users in the latest frame · movement is in pixels, not calibrated speed</p>
                )}
                {session.status === 'paused' && <p>Processing is paused at {session.processed_frames.toLocaleString()} frames.</p>}
                {session.status === 'stopping' && <p>Stopping after the current frame…</p>}
                {session.status === 'stopped' && session.processed_frames === 0 && (
                  <p className="no-results-message">RodAI stopped before it analyzed the first frame, so there is no video analysis or report to view. On first use the model must start before processing begins. Start the video again and wait until the frame count increases.</p>
                )}
                {session.status === 'stopped' && session.processed_frames > 0 && (
                  <p>Stopped after analyzing {session.processed_frames.toLocaleString()} frames. The annotated preview and partial frame report cover the portion analyzed.</p>
                )}
                {session.status === 'failed' && <p className="error-message" role="alert">{session.error}</p>}
                {session.source_type !== 'browser_camera' && videoSummary && (
                  <section className="tracking-summary" aria-label="Road user tracking summary">
                    <div><span>Track IDs</span><strong>{videoSummary.trackIds.toLocaleString()}</strong></div>
                    <div><span>Peak in frame</span><strong>{videoSummary.peakInFrame.toLocaleString()}</strong></div>
                    <div><span>Tracked classes</span><strong>{Object.entries(videoSummary.classes).map(([label, count]) => `${label} ${count}`).join(' · ') || 'None'}</strong></div>
                    <p>Prototype image-plane tracking. IDs may switch or split; motion is not calibrated to metres or km/h.</p>
                  </section>
                )}
                {flowSummary && (
                  <section className="flow-summary" aria-label="Traffic crossing counts">
                    <div className="flow-heading"><div><p className="eyebrow">MOVEMENT MEASUREMENT</p><h3>Observed line crossings</h3></div><span>{flowSummary.total} total</span></div>
                    <div className="flow-counts">
                      <div><span>− to +</span><strong>{flowSummary.negativeToPositive.toLocaleString()}</strong></div>
                      <div><span>+ to −</span><strong>{flowSummary.positiveToNegative.toLocaleString()}</strong></div>
                    </div>
                    {flowSummary.events.length > 0 && <ul aria-label="Recent line crossings">
                      {flowSummary.events.slice(-5).reverse().map((event, index) => (
                        <li key={`${event.trackId}-${event.timestampMs}-${index}`}>
                          <span>#{event.trackId} {event.label}</span>
                          <span>{event.direction === 'negative_to_positive' ? '− to +' : '+ to −'} · {event.timestampMs === null ? 'time unknown' : `${(event.timestampMs / 1000).toFixed(1)} s`}</span>
                        </li>
                      ))}
                    </ul>}
                    <p>Counts come from sampled detections and prototype track IDs. Missed detections or ID switches can undercount or double-count traffic. This is not a calibrated vehicle speed or validated traffic count.</p>
                  </section>
                )}
                {session.metadata && (
                  <dl className="video-metadata">
                    <div><dt>Video size</dt><dd>{session.metadata.width} × {session.metadata.height}</dd></div>
                    <div><dt>Frame rate</dt><dd>{session.metadata.fps ? `${session.metadata.fps.toFixed(2)} FPS` : 'Unknown'}</dd></div>
                    <div><dt>{session.source_type === 'browser_camera' ? 'Frames received' : 'Frames analyzed'}</dt><dd>{session.processed_frames.toLocaleString()}</dd></div>
                    {session.analysis_fps && <div><dt>Analysis sampling</dt><dd>{session.analysis_fps} FPS</dd></div>}
                    <div><dt>Duration</dt><dd>{session.metadata.duration_ms ? formatDuration(session.metadata.duration_ms) : 'Unknown'}</dd></div>
                  </dl>
                )}
                {session.status === 'processing' && (
                  <div className="session-actions">
                    <button className="secondary-button" type="button" onClick={() => controlSession('pause')}>Pause</button>
                    <button className="secondary-button" type="button" onClick={() => controlSession('stop')}>
                      {session.processed_frames === 0 ? 'Cancel startup' : 'Stop analysis'}
                    </button>
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
                    {session.processed_frames > 0 && session.source_type !== 'browser_camera' && (
                      <button className="secondary-button" type="button" onClick={exportAnnotatedVideo} disabled={exportProgress !== null}>
                        {exportProgress === null ? 'Export annotated video (.webm)' : `Creating export… ${exportProgress}%`}
                      </button>
                    )}
                    <button className="secondary-button" type="button" onClick={deleteSession}>Delete session results</button>
                  </div>
                )}
                {exportError && <p className="error-message" role="alert">{exportError}</p>}
                {exportProgress !== null && <div className="progress-line" role="status">
                  <span>Rendering the annotated video in this browser</span><span>{exportProgress}%</span>
                  <progress max="100" value={exportProgress} aria-label="Annotated video export progress" />
                </div>}
                {['completed', 'stopped'].includes(session.status) && session.processed_frames > 0 && session.source_type !== 'browser_camera' && (
                  <details className="technical-results">
                    <summary>Technical data for developers</summary>
                    <p>JSONL is a machine-readable record with one line per analyzed video frame. It helps inspect detections and build integrations; you do not need it to watch the annotated video.</p>
                    <a className="download-link" href={apiUrl(session.result_url)}>Download frame data (.jsonl)</a>
                  </details>
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
                <p>RodAI runs the configured detector on every frame and saves frame-aligned results. Detection outputs can be wrong and are not safety advice.</p>
              </div>
            )}
          </section>
          <footer className="scene-footer">Object detection is enabled in the Compose demo. Tracking, physical speed estimation and crash prediction are not implemented.</footer>
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
            <div><dt>Retention cleanup</dt><dd>{health.retention.status}{health.retention.failed_deletions ? ` · ${health.retention.failed_deletions} retry` : ''}</dd></div>
            <div><dt>Data volume</dt><dd>{health.volume.status}</dd></div>
            {health.volume.free_bytes !== undefined && <div><dt>Free space</dt><dd>{formatBytes(health.volume.free_bytes)}</dd></div>}
          </dl>}
          <p className="panel-note">DETR detects common road users in video. It does not predict crashes or support safety decisions.</p>
        </aside>
      </section>}
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
