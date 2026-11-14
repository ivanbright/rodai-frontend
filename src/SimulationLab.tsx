import { useEffect, useMemo, useState } from 'react';
import './simulation.css';

type ScenarioId = 'rear-end' | 'pedestrian' | 'intersection';
type Outcome = 'ready' | 'paused' | 'running' | 'warning' | 'prevented' | 'collision';
type Scenario = {
  id: ScenarioId;
  title: string;
  type: string;
  description: string;
  initialTtc: number;
  actors: Array<{ id: string; label: string; kind: 'car' | 'pedestrian' | 'bus'; x: number; y: number; dx: number; dy: number; color: string }>;
};

const scenarios: Scenario[] = [
  {
    id: 'rear-end', title: 'Sudden braking', type: 'REAR-END CONFLICT',
    description: 'A following car closes too quickly on traffic that has slowed ahead.', initialTtc: 5.2,
    actors: [
      { id: 'V-12', label: 'Car · V-12', kind: 'car', x: 250, y: 300, dx: 27, dy: 0, color: '#51d9c4' },
      { id: 'V-08', label: 'Car · V-08', kind: 'car', x: 429, y: 300, dx: 8, dy: 0, color: '#f9b66c' },
      { id: 'V-21', label: 'Bus · V-21', kind: 'bus', x: 760, y: 300, dx: 8, dy: 0, color: '#8aafff' },
    ],
  },
  {
    id: 'pedestrian', title: 'Pedestrian crossing', type: 'VULNERABLE ROAD USER',
    description: 'A pedestrian enters a marked crossing as a vehicle approaches.', initialTtc: 4.5,
    actors: [
      { id: 'V-04', label: 'Car · V-04', kind: 'car', x: 340, y: 340, dx: 50, dy: 0, color: '#51d9c4' },
      { id: 'P-02', label: 'Person · P-02', kind: 'pedestrian', x: 564, y: 150, dx: 0, dy: 37, color: '#ffdc7b' },
    ],
  },
  {
    id: 'intersection', title: 'Blind intersection', type: 'CROSSING PATHS',
    description: 'Two vehicles approach the same junction from different directions.', initialTtc: 3.9,
    actors: [
      { id: 'V-17', label: 'Car · V-17', kind: 'car', x: 335, y: 300, dx: 50, dy: 0, color: '#51d9c4' },
      { id: 'V-09', label: 'Car · V-09', kind: 'car', x: 530, y: 168, dx: 0, dy: 40, color: '#f9b66c' },
    ],
  },
];

const ALERT_TTC = 3.2;
const BRAKE_SECONDS = 1.4;

export function SimulationLab() {
  const [scenarioId, setScenarioId] = useState<ScenarioId>('intersection');
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [automaticResponse, setAutomaticResponse] = useState(true);
  const scenario = scenarios.find((item) => item.id === scenarioId)!;

  const alertAt = Math.max(0, scenario.initialTtc - ALERT_TTC);
  const resolveAt = automaticResponse ? alertAt + BRAKE_SECONDS : scenario.initialTtc;
  const outcome: Outcome = elapsed >= resolveAt && elapsed > 0
    ? automaticResponse ? 'prevented' : 'collision'
    : running ? elapsed >= alertAt && elapsed > 0 ? 'warning' : 'running'
    : elapsed > 0 ? 'paused' : 'ready';
  const ttc = Math.max(0, scenario.initialTtc - elapsed);
  const risk = outcome === 'prevented' ? 8 : outcome === 'collision' ? 100 : Math.min(99, Math.max(4, Math.round((1 - ttc / scenario.initialTtc) * 100 + 15)));

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      setElapsed((previous) => Math.min(resolveAt, previous + 0.1));
    }, 100);
    return () => window.clearInterval(timer);
  }, [running, resolveAt]);

  useEffect(() => {
    if (running && elapsed >= resolveAt) setRunning(false);
  }, [running, elapsed, resolveAt]);

  const status = useMemo(() => {
    if (outcome === 'prevented') return { title: 'Simulated conflict avoided', tone: 'safe', detail: 'The scripted response reduced speed before the conflict point.' };
    if (outcome === 'collision') return { title: 'Impact point reached', tone: 'danger', detail: 'No automatic response was enabled for this run.' };
    if (outcome === 'warning') return { title: automaticResponse ? 'Conflict developing' : 'Conflict developing · response off', tone: 'warning', detail: automaticResponse ? 'Risk rule triggered; simulated braking is active.' : 'The conflict is not being mitigated in this run.' };
    if (outcome === 'running') return { title: 'Scenario running', tone: 'neutral', detail: 'Monitoring scripted agent paths and time to conflict.' };
    if (outcome === 'paused') return { title: 'Scenario paused', tone: 'neutral', detail: 'Resume the run or reset it to the start.' };
    return { title: 'Scenario ready', tone: 'neutral', detail: 'Start the scenario to run the real-time risk demonstration.' };
  }, [outcome, automaticResponse]);

  function reset(nextScenario = scenarioId) {
    setScenarioId(nextScenario);
    setRunning(false);
    setElapsed(0);
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
        <div><p className="lab-kicker">CONTROLLED SCENARIO LIBRARY</p><h1>Road Safety Lab</h1><p>Run repeatable traffic conflicts and observe an early-warning rule and simulated response in real time.</p></div>
        <span className="synthetic-stamp"><span /> SYNTHETIC · RULE-BASED</span>
      </section>

      <div className="lab-layout">
        <section className="lab-stage-card" aria-label="Live scenario simulation">
          <div className="lab-stage-top"><div><span className="stage-overline">LIVE SIMULATION</span><h2>{scenario.type}</h2></div><span className={`lab-outcome-pill ${status.tone}`}>{status.title}</span></div>
          <svg className="road-stage" viewBox="0 0 1000 560" role="img" aria-label={`${scenario.title} synthetic road scene`}>
            <defs><pattern id="grid" width="42" height="42" patternUnits="userSpaceOnUse"><path d="M 42 0 L 0 0 0 42" fill="none" stroke="#213047" strokeWidth="1" /></pattern></defs>
            <rect width="1000" height="560" fill="#101c2b" /><rect width="1000" height="560" fill="url(#grid)" />
            {scenarioId === 'intersection' ? <>
              <rect x="0" y="214" width="1000" height="220" fill="#303b49" /><rect x="420" y="0" width="220" height="560" fill="#303b49" />
              <path d="M0 324H1000M530 0V560" stroke="#8c9298" strokeWidth="3" strokeDasharray="30 24" />
              <path d="M392 214v220m276-220v220M420 188h220m-220 272h220" stroke="#f4f1e8" strokeWidth="5" strokeDasharray="10 10" />
              <rect x="442" y="236" width="176" height="176" rx="20" fill="#4a3039" stroke="#fd6d72" strokeDasharray="9 7" />
              <text x="530" y="326" textAnchor="middle" className="conflict-label">CONFLICT ZONE</text>
            </> : <>
              <rect x="0" y="205" width="1000" height="220" fill="#303b49" />
              <path d="M0 315H1000" stroke="#c5c7c6" strokeWidth="3" strokeDasharray="30 24" />
              {scenarioId === 'pedestrian' && <>
                <rect x="500" y="205" width="128" height="220" fill="#495461" />
                {[510, 532, 554, 576, 598, 620].map((x) => <rect key={x} x={x} y="205" width="12" height="220" fill="#f7f5ef" opacity=".9" />)}
                <rect x="500" y="260" width="128" height="116" rx="8" fill="none" stroke="#fdc86c" strokeWidth="3" strokeDasharray="8 7" />
                <text x="564" y="252" textAnchor="middle" className="conflict-label">CROSSING</text>
              </>}
              {scenarioId === 'rear-end' && <>
                <path d="M434 300h110" stroke="#fd6d72" strokeWidth="3" strokeDasharray="8 7" />
                <text x="488" y="270" textAnchor="middle" className="conflict-label">CLOSING GAP</text>
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
            <g className="scene-legend"><circle cx="28" cy="524" r="6" fill="#51d9c4" /><text x="42" y="529">TRACKED AGENT</text><rect x="176" y="518" width="21" height="13" fill="none" stroke="#fd6d72" strokeDasharray="3 3" /><text x="205" y="529">PREDICTED CONFLICT</text></g>
          </svg>
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
        </section>

        <aside className="lab-side-panel">
          <section className={`risk-card ${status.tone}`}><div className="risk-card-top"><span>CONFLICT RISK INDEX</span><span className="risk-live"><i /> {outcome === 'running' || outcome === 'warning' ? 'LIVE' : 'SIM'}</span></div><div className="risk-number">{risk}<small>/ 100</small></div><div className="risk-meter"><span style={{ width: `${risk}%` }} /></div><p>{status.detail}</p><div className="metric-row"><span>Time to conflict</span><strong>{outcome === 'prevented' ? 'AVOIDED' : `${ttc.toFixed(1)} s`}</strong></div><div className="metric-row"><span>Response</span><strong>{outcome === 'prevented' ? 'BRAKE APPLIED' : simulatedBrake ? 'BRAKING' : automaticResponse ? 'ARMED' : 'DISABLED'}</strong></div></section>
          <section className="scenario-library"><div className="library-heading"><span>SCENARIO LIBRARY</span><span>03 CASES</span></div>{scenarios.map((item, index) => <button type="button" key={item.id} className={`scenario-option ${scenarioId === item.id ? 'selected' : ''}`} onClick={() => reset(item.id)}><span className="scenario-index">0{index + 1}</span><span><strong>{item.title}</strong><small>{item.description}</small></span><span className="scenario-arrow">↗</span></button>)}</section>
        </aside>
      </div>
      <section className="lab-disclosure"><strong>Prototype boundary</strong><span>This lab uses scripted agents and known scenario ground truth. The conflict score and braking response are deterministic simulation rules, not a trained accident-prediction model. It demonstrates a test workflow; it does not establish real-world accuracy or prevent real crashes.</span></section>
    </main>
  );
}
