import { useEffect, useMemo, useRef, useState } from 'react';
import { apiUrl, apiWebSocketUrl } from './api';
import scenarioLibrary from './scenarios/road-conflicts.v1.json';
import './simulation.css';

type ScenarioId = 'rear-end' | 'pedestrian' | 'intersection';
type Outcome = 'ready' | 'paused' | 'running' | 'warning' | 'prevented' | 'collision';
type Scenario = {
  id: ScenarioId;
  title: string;
  event_type: string;
  road_layout: 'straight_road' | 'marked_crossing' | 'four_way_intersection';
  description: string;
  initial_ttc_seconds: number;
  conflict_point: { x: number; y: number };
  expected_with_response: string;
  expected_without_response: string;
  actors: Array<{ id: string; label: string; kind: 'car' | 'pedestrian' | 'bus'; role: string; x: number; y: number; dx: number; dy: number; color: string }>;
};

const scenarios = scenarioLibrary.cases as Scenario[];

const ALERT_TTC = 3.2;
const BRAKE_SECONDS = 1.4;
const SIMULATION_TICK_MS = 1000 / scenarioLibrary.simulation_tick_hz;

export function SimulationLab() {
  const [scenarioId, setScenarioId] = useState<ScenarioId>('intersection');
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [automaticResponse, setAutomaticResponse] = useState(true);
  const [detectorState, setDetectorState] = useState<'idle' | 'connecting' | 'streaming' | 'stopping' | 'stopped' | 'failed'>('idle');
  const [detectorError, setDetectorError] = useState<string | null>(null);
  const [detectorDetections, setDetectorDetections] = useState<Array<{ label: string; confidence: number; bbox_xyxy: [number, number, number, number] }>>([]);
  const [detectorFrames, setDetectorFrames] = useState(0);
  const [detectorDropped, setDetectorDropped] = useState(0);
  const [inferenceAvailable, setInferenceAvailable] = useState<boolean | null>(null);
  const scenario = scenarios.find((item) => item.id === scenarioId)!;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const frameCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const detectorSocketRef = useRef<WebSocket | null>(null);
  const detectorTimerRef = useRef<number | null>(null);
  const detectorFrameIdRef = useRef(0);
  const detectorDroppedRef = useRef(0);
  const detectorInFlightRef = useRef(false);

  const alertAt = Math.max(0, scenario.initial_ttc_seconds - ALERT_TTC);
  const resolveAt = automaticResponse ? alertAt + BRAKE_SECONDS : scenario.initial_ttc_seconds;
  const outcome: Outcome = elapsed >= resolveAt && elapsed > 0
    ? automaticResponse ? 'prevented' : 'collision'
    : running ? elapsed >= alertAt && elapsed > 0 ? 'warning' : 'running'
    : elapsed > 0 ? 'paused' : 'ready';
  const ttc = Math.max(0, scenario.initial_ttc_seconds - elapsed);
  const risk = outcome === 'prevented' ? 8 : outcome === 'collision' ? 100 : Math.min(99, Math.max(4, Math.round((1 - ttc / scenario.initial_ttc_seconds) * 100 + 15)));

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      setElapsed((previous) => Math.min(resolveAt, previous + 0.1));
    }, SIMULATION_TICK_MS);
    return () => window.clearInterval(timer);
  }, [running, resolveAt]);

  useEffect(() => {
    if (running && elapsed >= resolveAt) setRunning(false);
  }, [running, elapsed, resolveAt]);

  useEffect(() => () => {
    if (detectorTimerRef.current !== null) window.clearInterval(detectorTimerRef.current);
    const socket = detectorSocketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ protocol: 'rodai.v1', type: 'stop', dropped_since_last: detectorDroppedRef.current }));
      socket.close();
    }
  }, []);

  const status = useMemo(() => {
    if (outcome === 'prevented') return { title: 'Simulated conflict avoided', tone: 'safe', detail: `Expected: ${scenario.expected_with_response}. The scripted response reduced speed before the conflict point.` };
    if (outcome === 'collision') return { title: 'Impact point reached', tone: 'danger', detail: `Expected: ${scenario.expected_without_response}. No automatic response was enabled for this run.` };
    if (outcome === 'warning') return { title: automaticResponse ? 'Conflict developing' : 'Conflict developing · response off', tone: 'warning', detail: automaticResponse ? 'Risk rule triggered; simulated braking is active.' : 'The conflict is not being mitigated in this run.' };
    if (outcome === 'running') return { title: 'Scenario running', tone: 'neutral', detail: 'Monitoring scripted agent paths and time to conflict.' };
    if (outcome === 'paused') return { title: 'Scenario paused', tone: 'neutral', detail: 'Resume the run or reset it to the start.' };
    return { title: 'Scenario ready', tone: 'neutral', detail: 'Start the scenario to run the real-time risk demonstration.' };
  }, [outcome, automaticResponse, scenario]);

  function reset(nextScenario = scenarioId) {
    setScenarioId(nextScenario);
    setRunning(false);
    setElapsed(0);
  }

  async function startDetector() {
    setDetectorError(null);
    setDetectorDetections([]);
    setDetectorFrames(0);
    setDetectorDropped(0);
    setInferenceAvailable(null);
    setDetectorState('connecting');
    try {
      const response = await fetch(apiUrl('/api/v1/sessions/live'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_width: 1000, max_height: 560, jpeg_quality: 0.75 }),
      });
      const session = await response.json() as { id?: string; detail?: string };
      if (!response.ok || !session.id) throw new Error(session.detail ?? `Could not start detector session (${response.status}).`);
      const socket = new WebSocket(apiWebSocketUrl(`/api/v1/sessions/ws/${session.id}`));
      detectorSocketRef.current = socket;
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        let message: Record<string, unknown>;
        try { message = JSON.parse(event.data) as Record<string, unknown>; }
        catch { setDetectorError('The detector returned an unreadable message.'); return; }
        if (message.type === 'session_started') {
          setDetectorState('streaming');
          detectorTimerRef.current = window.setInterval(captureSimulationFrame, 250);
        } else if (message.type === 'frame_result') {
          detectorInFlightRef.current = false;
          setDetectorFrames(Number(message.processed_frames ?? 0));
          setDetectorDropped(Number(message.dropped_frames ?? 0));
          setInferenceAvailable(message.inference === 'complete');
          setDetectorDetections(Array.isArray(message.detections) ? message.detections as typeof detectorDetections : []);
        } else if (message.type === 'session_ended') {
          if (detectorTimerRef.current !== null) window.clearInterval(detectorTimerRef.current);
          detectorTimerRef.current = null;
          detectorInFlightRef.current = false;
          setDetectorState('stopped');
          socket.close();
        } else if (message.type === 'error') {
          detectorInFlightRef.current = false;
          setDetectorError(`The detector rejected a synthetic frame (${String(message.code)}).`);
        }
      };
      socket.onerror = () => {
        if (detectorTimerRef.current !== null) window.clearInterval(detectorTimerRef.current);
        detectorTimerRef.current = null;
        setDetectorState('failed');
        setDetectorError('Could not connect the simulation to the detector. Check backend readiness and the active-session limit.');
      };
      socket.onclose = () => {
        if (detectorTimerRef.current !== null) window.clearInterval(detectorTimerRef.current);
        detectorTimerRef.current = null;
        detectorInFlightRef.current = false;
        setDetectorState((current) => current === 'failed' ? current : 'stopped');
      };
    } catch (cause) {
      setDetectorState('failed');
      setDetectorError(cause instanceof Error ? cause.message : 'Could not start detector session.');
    }
  }

  function captureSimulationFrame() {
    const socket = detectorSocketRef.current;
    const sourceSvg = svgRef.current;
    const canvas = frameCanvasRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !sourceSvg || !canvas) return;
    const frameId = detectorFrameIdRef.current++;
    if (detectorInFlightRef.current) {
      detectorDroppedRef.current += 1;
      return;
    }
    detectorInFlightRef.current = true;
    const clonedSvg = sourceSvg.cloneNode(true) as SVGSVGElement;
    clonedSvg.setAttribute('width', String(scenarioLibrary.scene_size.width));
    clonedSvg.setAttribute('height', String(scenarioLibrary.scene_size.height));
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = '.conflict-label{fill:#ffafb0;font:800 12px sans-serif;letter-spacing:1.4px}.agent-label{fill:#f5f8fc;font:750 12px sans-serif;paint-order:stroke;stroke:#172335;stroke-width:4px}.scene-legend text{fill:#dbe4ee;font:700 10px sans-serif;letter-spacing:.9px}';
    clonedSvg.prepend(style);
    const imageUrl = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clonedSvg)], { type: 'image/svg+xml;charset=utf-8' }));
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(imageUrl);
      canvas.width = scenarioLibrary.scene_size.width;
      canvas.height = scenarioLibrary.scene_size.height;
      const context = canvas.getContext('2d');
      if (!context) { detectorInFlightRef.current = false; return; }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (!blob || socket.readyState !== WebSocket.OPEN) { detectorInFlightRef.current = false; return; }
        socket.send(JSON.stringify({
          protocol: 'rodai.v1', type: 'frame', frame_id: frameId,
          capture_timestamp_ms: Date.now(), dropped_since_last: detectorDroppedRef.current,
        }));
        socket.send(blob);
        detectorDroppedRef.current = 0;
      }, 'image/jpeg', 0.75);
    };
    image.onerror = () => { URL.revokeObjectURL(imageUrl); detectorInFlightRef.current = false; setDetectorError('Could not render a simulation frame for the detector.'); };
    image.src = imageUrl;
  }

  function stopDetector() {
    if (detectorTimerRef.current !== null) window.clearInterval(detectorTimerRef.current);
    detectorTimerRef.current = null;
    const socket = detectorSocketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      setDetectorState('stopping');
      socket.send(JSON.stringify({ protocol: 'rodai.v1', type: 'stop', dropped_since_last: detectorDroppedRef.current }));
    } else {
      setDetectorState('stopped');
    }
  }

  const simulatedBrake = outcome === 'warning' || outcome === 'prevented';
  const brakeElapsed = Math.max(0, elapsed - alertAt);
  const brakeProgress = simulatedBrake ? Math.min(1, brakeElapsed / BRAKE_SECONDS) : 0;
  const agents = scenario.actors.map((actor) => {
    const movementTime = actor.id === scenario.actors[0].id && simulatedBrake
      ? alertAt + brakeElapsed * (1 - brakeProgress * 0.5)
      : elapsed;
    const stopAt = actor.id === scenario.actors[0].id && outcome === 'prevented' ? alertAt + BRAKE_SECONDS * 0.6 : Infinity;
    const t = Math.min(movementTime, stopAt);
    return { ...actor, x: actor.x + actor.dx * t, y: actor.y + actor.dy * t };
  });

  return (
    <main className="simulation-lab" aria-label="RodAI simulation lab">
      <section className="lab-heading">
          <div><p className="lab-kicker">CONTROLLED SCENARIO LIBRARY · {scenarioLibrary.library_version}</p><h1>Road Safety Lab</h1><p>Run repeatable traffic conflicts and observe an early-warning rule and simulated response in real time.</p></div>
        <span className="synthetic-stamp"><span /> SYNTHETIC · RULE-BASED</span>
      </section>

      <div className="lab-layout">
        <section className="lab-stage-card" aria-label="Live scenario simulation">
          <div className="lab-stage-top"><div><span className="stage-overline">LIVE SIMULATION</span><h2>{scenario.event_type}</h2></div><span className={`lab-outcome-pill ${status.tone}`}>{status.title}</span></div>
          <div className="road-stage-wrap">
          <svg ref={svgRef} className="road-stage" viewBox={`0 0 ${scenarioLibrary.scene_size.width} ${scenarioLibrary.scene_size.height}`} role="img" aria-label={`${scenario.title} synthetic road scene`}>
            <defs><pattern id="grid" width="42" height="42" patternUnits="userSpaceOnUse"><path d="M 42 0 L 0 0 0 42" fill="none" stroke="#213047" strokeWidth="1" /></pattern></defs>
            <rect width="1000" height="560" fill="#101c2b" /><rect width="1000" height="560" fill="url(#grid)" />
            {scenario.road_layout === 'four_way_intersection' ? <>
              <rect x="0" y="214" width="1000" height="220" fill="#303b49" /><rect x="420" y="0" width="220" height="560" fill="#303b49" />
              <path d="M0 324H1000M530 0V560" stroke="#8c9298" strokeWidth="3" strokeDasharray="30 24" />
              <path d="M392 214v220m276-220v220M420 188h220m-220 272h220" stroke="#f4f1e8" strokeWidth="5" strokeDasharray="10 10" />
              <rect x={scenario.conflict_point.x - 88} y={scenario.conflict_point.y - 88} width="176" height="176" rx="20" fill="#4a3039" stroke="#fd6d72" strokeDasharray="9 7" />
              <text x={scenario.conflict_point.x} y={scenario.conflict_point.y + 4} textAnchor="middle" className="conflict-label">CONFLICT ZONE</text>
            </> : <>
              <rect x="0" y="205" width="1000" height="220" fill="#303b49" />
              <path d="M0 315H1000" stroke="#c5c7c6" strokeWidth="3" strokeDasharray="30 24" />
              {scenario.road_layout === 'marked_crossing' && <>
                <rect x={scenario.conflict_point.x - 64} y="205" width="128" height="220" fill="#495461" />
                {[510, 532, 554, 576, 598, 620].map((x) => <rect key={x} x={x} y="205" width="12" height="220" fill="#f7f5ef" opacity=".9" />)}
                <rect x={scenario.conflict_point.x - 64} y={scenario.conflict_point.y - 55} width="128" height="116" rx="8" fill="none" stroke="#fdc86c" strokeWidth="3" strokeDasharray="8 7" />
                <text x={scenario.conflict_point.x} y={scenario.conflict_point.y - 63} textAnchor="middle" className="conflict-label">CROSSING</text>
              </>}
              {scenario.road_layout === 'straight_road' && <>
                <path d={`M${scenario.conflict_point.x - 55} ${scenario.conflict_point.y}h110`} stroke="#fd6d72" strokeWidth="3" strokeDasharray="8 7" />
                <text x={scenario.conflict_point.x} y={scenario.conflict_point.y - 30} textAnchor="middle" className="conflict-label">CLOSING GAP</text>
              </>}
            </>}
            {agents.map((actor) => <g key={actor.id} transform={`translate(${Math.min(920, actor.x)},${Math.min(500, actor.y)}) rotate(${actor.kind !== 'pedestrian' && actor.dy !== 0 ? 90 : 0})`}>
              {actor.kind === 'pedestrian' ? <>
                <circle r="13" fill={actor.color} /><path d="M0 14v38m0-26-16 17m16-17 16 17m-16 9-13 23m13-23 14 23" stroke={actor.color} strokeWidth="8" strokeLinecap="round" />
                <rect x="-29" y="-22" width="58" height="92" rx="24" fill="none" stroke="#ffdc7b" strokeWidth="2" strokeDasharray="5 5" />
              </> : <>
                <rect x={actor.kind === 'bus' ? -58 : -40} y="-23" width={actor.kind === 'bus' ? 116 : 80} height="46" rx="9" fill={actor.color} />
                <rect x={actor.kind === 'bus' ? -41 : -25} y="-16" width={actor.kind === 'bus' ? 32 : 24} height="13" rx="3" fill="#24354a" />
                <rect x="4" y="-16" width="23" height="13" rx="3" fill="#24354a" />
                <circle cx="-23" cy="24" r="7" fill="#0d1724" /><circle cx="23" cy="24" r="7" fill="#0d1724" />
                <rect x="-48" y="-37" width={actor.kind === 'bus' ? 96 : 86} height="78" rx="12" fill="none" stroke={actor.color} strokeWidth="2" strokeDasharray="6 5" />
              </>}
              <text x="0" y={actor.kind === 'pedestrian' ? 92 : -46} textAnchor="middle" className="agent-label">{actor.id}</text>
            </g>)}
            <g className="scene-legend"><circle cx="28" cy="524" r="6" fill="#51d9c4" /><text x="42" y="529">SCRIPTED AGENT</text><rect x="176" y="518" width="21" height="13" fill="none" stroke="#fd6d72" strokeDasharray="3 3" /><text x="205" y="529">CONFLICT POINT</text></g>
          </svg>
          <svg className="simulation-detections" viewBox={`0 0 ${scenarioLibrary.scene_size.width} ${scenarioLibrary.scene_size.height}`} aria-label="Object detector results">
            {detectorDetections.map((detection, index) => {
              const [x1, y1, x2, y2] = detection.bbox_xyxy;
              return <g key={`${detection.label}-${index}`}><rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} /><text x={x1} y={Math.max(18, y1 - 5)}>{detection.label} {(detection.confidence * 100).toFixed(0)}%</text></g>;
            })}
          </svg>
          <canvas ref={frameCanvasRef} hidden />
          </div>
          <div className="lab-controls">
            <button type="button" onClick={() => {
              if (running) setRunning(false);
              else {
                if (outcome === 'prevented' || outcome === 'collision') setElapsed(0);
                setRunning(true);
              }
            }}>
              {running ? 'Pause run' : outcome === 'ready' || outcome === 'paused' ? '▶ Run scenario' : '↻ Run again'}
            </button>
            <button type="button" className="lab-secondary" onClick={() => reset()}>Reset</button>
            <label className="auto-response"><input type="checkbox" checked={automaticResponse} onChange={(event) => setAutomaticResponse(event.target.checked)} /> Simulate automatic braking</label>
            <span className="sim-clock">SIM {elapsed.toFixed(1)}s</span>
          </div>
          <div className="synthetic-detector-panel">
            <div><strong>Model perception</strong><span>Actual DETR output on generated frames</span></div>
            <div className="detector-frame-stat"><strong>{detectorFrames}</strong><span>frames</span><i>·</i><strong>{detectorDetections.length}</strong><span>objects now</span></div>
            <button type="button" className={detectorState === 'streaming' ? 'lab-secondary' : ''} disabled={detectorState === 'connecting' || detectorState === 'stopping'} onClick={detectorState === 'streaming' ? stopDetector : startDetector}>
              {detectorState === 'connecting' ? 'Connecting…' : detectorState === 'streaming' ? 'Stop detector' : detectorState === 'stopping' ? 'Stopping…' : detectorState === 'stopped' ? 'Run detector again' : 'Run detector on these frames'}
            </button>
            {detectorState === 'streaming' && <span className="detector-state">{inferenceAvailable === false ? 'Model unavailable; frames are passing through.' : 'Detector connected'}{detectorDropped ? ` · ${detectorDropped} frames skipped` : ''}</span>}
            {detectorError && <p className="error-message" role="alert">{detectorError}</p>}
          </div>
        </section>

        <aside className="lab-side-panel">
          <section className={`risk-card ${status.tone}`}><div className="risk-card-top"><span>CONFLICT RISK INDEX</span><span className="risk-live"><i /> {outcome === 'running' || outcome === 'warning' ? 'LIVE' : 'SIM'}</span></div><div className="risk-number">{risk}<small>/ 100</small></div><div className="risk-meter"><span style={{ width: `${risk}%` }} /></div><p>{status.detail}</p><div className="metric-row"><span>Time to conflict</span><strong>{outcome === 'prevented' ? 'AVOIDED' : `${ttc.toFixed(1)} s`}</strong></div><div className="metric-row"><span>Response</span><strong>{outcome === 'prevented' ? 'BRAKE APPLIED' : simulatedBrake ? 'BRAKING' : automaticResponse ? 'ARMED' : 'DISABLED'}</strong></div></section>
          <section className="scenario-library"><div className="library-heading"><span>SCENARIO LIBRARY</span><span>{scenarios.length.toString().padStart(2, '0')} CASES</span></div>{scenarios.map((item, index) => <button type="button" key={item.id} className={`scenario-option ${scenarioId === item.id ? 'selected' : ''}`} onClick={() => reset(item.id)}><span className="scenario-index">0{index + 1}</span><span><strong>{item.title}</strong><small>{item.description}</small></span><span className="scenario-arrow">↗</span></button>)}</section>
        </aside>
      </div>
      <section className="lab-disclosure"><strong>Prototype boundary</strong><span>This lab uses scripted agents and known scenario ground truth. The conflict score and braking response are deterministic simulation rules, not a trained accident-prediction model. It demonstrates a test workflow; it does not establish real-world accuracy or prevent real crashes.</span></section>
    </main>
  );
}
