export type RoadTrack = {
  track_id: number;
  label: string;
  confidence: number;
  bbox_xyxy: [number, number, number, number];
  center_xy: [number, number];
  velocity_px_s: [number, number];
  speed_px_s: number | null;
  trail_xy: [number, number][];
};

export type RiskCue = {
  cue_id: string;
  cue_type: 'trajectory_convergence';
  status: 'review';
  frame_id: number;
  timestamp_ms: number | null;
  track_ids: [number, number];
  labels: [string, string];
  time_to_closest_approach_seconds: number;
  closest_center_separation_px: number;
  projected_box_margin_px: [number, number];
  method: 'constant_velocity_image_plane';
  calibrated: false;
};

export type DetectionFrame = {
  timestamp_ms: number | null;
  tracks: RoadTrack[];
  risk_cues: RiskCue[];
};

export type RiskCueEvent = {
  trackIds: [number, number];
  labels: [string, string];
  startMs: number | null;
  endMs: number | null;
  samples: number;
  latestTtc: number;
};

export function riskCuePairKey(trackIds: readonly [number, number]): string {
  return [...trackIds].sort((left, right) => left - right).join(':');
}

export function summarizeRiskCueEvents(frames: DetectionFrame[]): RiskCueEvent[] {
  const events: RiskCueEvent[] = [];
  const latestByPair = new Map<string, RiskCueEvent>();
  for (const frame of frames) {
    for (const cue of frame.risk_cues) {
      const trackIds = [...cue.track_ids].sort((left, right) => left - right) as [number, number];
      const key = riskCuePairKey(trackIds);
      const timestamp = cue.timestamp_ms ?? frame.timestamp_ms;
      const previous = latestByPair.get(key);
      if (previous && timestamp !== null && previous.endMs !== null && timestamp - previous.endMs <= 2500) {
        previous.endMs = timestamp;
        previous.samples += 1;
        previous.latestTtc = cue.time_to_closest_approach_seconds;
        continue;
      }
      const event: RiskCueEvent = {
        trackIds,
        labels: cue.labels,
        startMs: timestamp,
        endMs: timestamp,
        samples: 1,
        latestTtc: cue.time_to_closest_approach_seconds,
      };
      events.push(event);
      latestByPair.set(key, event);
    }
  }
  return events
    .filter((event) => event.samples >= 2)
    .sort((left, right) => (left.startMs ?? 0) - (right.startMs ?? 0));
}
