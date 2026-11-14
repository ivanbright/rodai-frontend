import { describe, expect, it } from 'vitest';
import { findPotentialConflicts, type ConflictTrack } from './conflicts';

function track(
  track_id: number,
  center: [number, number],
  velocity: [number, number],
  size: [number, number] = [20, 20],
): ConflictTrack {
  return {
    track_id,
    label: track_id === 1 ? 'car' : 'person',
    center_xy: center,
    velocity_px_s: velocity,
    bbox_xyxy: [center[0] - size[0] / 2, center[1] - size[1] / 2, center[0] + size[0] / 2, center[1] + size[1] / 2],
  };
}

describe('potential trajectory conflicts', () => {
  it('flags converging boxes with a short time to closest approach', () => {
    const conflicts = findPotentialConflicts([
      track(1, [100, 100], [20, 0]),
      track(2, [160, 100], [-20, 0]),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].trackIds).toEqual([1, 2]);
    expect(conflicts[0].timeToClosestApproachSeconds).toBeCloseTo(1.5);
  });

  it('does not flag diverging tracks or paths that miss each other', () => {
    expect(findPotentialConflicts([
      track(1, [100, 100], [-20, 0]),
      track(2, [160, 100], [20, 0]),
    ])).toEqual([]);
    expect(findPotentialConflicts([
      track(1, [100, 100], [20, 0]),
      track(2, [160, 200], [-20, 0]),
    ])).toEqual([]);
  });

  it('ignores stationary, too distant, duplicate and invalid tracks', () => {
    const invalid = track(3, [0, 0], [10, 0]);
    invalid.bbox_xyxy = [0, 0, Number.NaN, 10];
    expect(findPotentialConflicts([
      track(1, [100, 100], [0, 0]),
      track(2, [160, 100], [0, 0]),
      track(4, [100, 100], [0, 0]),
      track(1, [100, 100], [10, 0]),
      invalid,
    ])).toEqual([]);
  });

  it('honors the configured horizon', () => {
    expect(findPotentialConflicts([
      track(1, [100, 100], [10, 0]),
      track(2, [160, 100], [-10, 0]),
    ], 2)).toEqual([]);
  });
});
