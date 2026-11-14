import { useEffect, useState } from 'react';

type Health = {
  status: 'healthy' | 'degraded';
  environment: string;
  database: { status: string; error_type: string | null };
  device: { configured: string; selected: string };
  model: { status: string; identifier: string };
  volume: { status: string; free_bytes?: number; error?: string };
};

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand" aria-label="RodAI">
          <img className="brand-mark" src="/brand/rodai-mark.svg" alt="" />
          <span className="brand-wordmark">Rod<span>AI</span></span>
        </div>
        <span className="phase-label">FOUNDATION</span>
      </header>
      <section className="workspace" aria-labelledby="welcome-title">
        <div className="scene">
          <div className="scene-header">
            <div><p className="eyebrow">PERCEPTION WORKSPACE</p><h1 id="welcome-title">Road scene</h1></div>
            <span className="state-pill"><span className="state-dot" /> Viewer ready</span>
          </div>
          <div className="scene-empty">
            <div className="road-icon" aria-hidden="true"><span /></div>
            <h2>Video analysis is not available yet</h2>
            <p>Video upload and camera processing arrive in Phase 2. Detection is unavailable until a model is selected and evaluated.</p>
          </div>
          <footer className="scene-footer">Research and demonstration only. Outputs are experimental and may be wrong.</footer>
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
          <p className="panel-note">Status comes from the running backend. This foundation build does not run inference.</p>
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
