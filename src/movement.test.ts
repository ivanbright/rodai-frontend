import { describe, expect, it } from 'vitest';
import { countLineCrossings, type CountingLine, type MovementFrame } from './movement';

const horizontalLine: CountingLine = { start: { x: 10, y: 50 }, end: { x: 90, y: 50 } };

function frame(timestamp_ms: number, ...samples: Array<[number, number, number, string?]>): MovementFrame {
  return {
    timestamp_ms,
    tracks: samples.map(([track_id, x, y, label = 'car']) => ({ track_id, label, center_xy: [x, y] as [number, number] })),
  };
}

describe('countLineCrossings', () => {
  it('counts a track crossing in either direction once with its observed time', () => {
    const frames = [
      frame(0, [1, 40, 20], [2, 60, 80]),
      frame(500, [1, 42, 78], [2, 62, 22]),
      frame(1000, [1, 44, 20], [2, 64, 80]),
    ];

    expect(countLineCrossings(frames, horizontalLine)).toEqual({
      total: 2,
      negativeToPositive: 1,
      positiveToNegative: 1,
      events: [
        { trackId: 1, label: 'car', direction: 'negative_to_positive', timestampMs: 500 },
        { trackId: 2, label: 'car', direction: 'positive_to_negative', timestampMs: 500 },
      ],
    });
  });

  it('ignores paths that cross the infinite extension outside the drawn line', () => {
    const result = countLineCrossings([
      frame(0, [1, 2, 20]),
      frame(500, [1, 2, 80]),
    ], horizontalLine);

    expect(result.total).toBe(0);
  });

  it('uses a deadband to avoid counting jitter near the line', () => {
    const result = countLineCrossings([
      frame(0, [1, 40, 49]),
      frame(100, [1, 41, 52]),
      frame(200, [1, 42, 48]),
      frame(300, [1, 43, 51]),
    ], horizontalLine);

    expect(result.total).toBe(0);
  });

  it('returns an empty summary for a degenerate line', () => {
    const result = countLineCrossings([frame(0, [1, 40, 20])], {
      start: { x: 20, y: 20 }, end: { x: 20, y: 20 },
    });

    expect(result).toEqual({ total: 0, negativeToPositive: 0, positiveToNegative: 0, events: [] });
  });
});
