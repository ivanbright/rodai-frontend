import { describe, expect, it } from 'vitest';
import { summarizeRiskCueEvents, type DetectionFrame, type RiskCue } from './riskCues';

function cue(frameId: number, timestamp: number, trackIds: [number, number]): RiskCue {
  return {
    cue_id: `${frameId}:${trackIds.join(':')}`,
    cue_type: 'trajectory_convergence',
    status: 'review',
    frame_id: frameId,
    timestamp_ms: timestamp,
    track_ids: trackIds,
    labels: ['car', 'car'],
    time_to_closest_approach_seconds: 1.1,
    closest_center_separation_px: 9,
    projected_box_margin_px: [5, 3],
    method: 'constant_velocity_image_plane',
    calibrated: false,
  };
}

function frame(timestamp: number, riskCues: RiskCue[]): DetectionFrame {
  return { timestamp_ms: timestamp, tracks: [], risk_cues: riskCues };
}

describe('trajectory review cue grouping', () => {
  it('keeps only pairs repeated in nearby analyzed samples', () => {
    const events = summarizeRiskCueEvents([
      frame(1000, [cue(1, 1000, [7, 2]), cue(1, 1000, [3, 4])]),
      frame(2000, [cue(2, 2000, [2, 7])]),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ trackIds: [2, 7], startMs: 1000, endMs: 2000, samples: 2 });
  });

  it('discards one-sample candidates from the operator review list', () => {
    expect(summarizeRiskCueEvents([frame(1000, [cue(1, 1000, [1, 2])])])).toEqual([]);
  });
});
