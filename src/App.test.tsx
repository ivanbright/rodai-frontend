import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { App } from './App';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('road video workspace', () => {
  it('shows backend failure without inventing system state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<App />);
    expect(await screen.findByText(/backend is not reachable/i)).toBeTruthy();
  });

  it('offers a camera-first workspace without inventing detector output', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input).includes('/sessions?limit=20')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          status: 'healthy',
          environment: 'local',
          database: { status: 'available', error_type: null },
          device: { configured: 'cpu', selected: 'cpu' },
          model: { status: 'unavailable', identifier: 'unavailable' },
          retention: { status: 'available', failed_deletions: 0 },
          volume: { status: 'available', free_bytes: 1024 },
        }),
      });
    }));
    render(<App />);
    expect(await screen.findByRole('heading', { name: /video analysis workspace/i })).toBeTruthy();
    expect(screen.queryByText(/simulation lab/i)).toBeNull();
    expect(screen.getByRole('heading', { name: /choose a road video/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /your road footage appears here/i })).toBeTruthy();
    expect(screen.queryByText(/trajectory review/i)).toBeNull();
    expect(screen.getByText(/do not predict or prevent crashes/i)).toBeTruthy();
  });
});
