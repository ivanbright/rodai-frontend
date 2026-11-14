export type ImagePoint = { x: number; y: number };
export type CountingLine = { start: ImagePoint; end: ImagePoint };
export type TrackSample = {
  track_id: number;
  label: string;
  center_xy: [number, number];
};
export type MovementFrame = { timestamp_ms: number | null; tracks: TrackSample[] };
export type CrossingEvent = {
  trackId: number;
  label: string;
  direction: 'negative_to_positive' | 'positive_to_negative';
  timestampMs: number | null;
};

export type FlowSummary = {
  total: number;
  negativeToPositive: number;
  positiveToNegative: number;
  events: CrossingEvent[];
};

type TrackState = { point: ImagePoint; side: -1 | 1 };

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

function sideOfLine(point: ImagePoint, line: CountingLine, lineLength: number): number {
  return cross(
    line.end.x - line.start.x,
    line.end.y - line.start.y,
    point.x - line.start.x,
    point.y - line.start.y,
  ) / lineLength;
}

function segmentsIntersectWithinLine(
  from: ImagePoint,
  to: ImagePoint,
  line: CountingLine,
): boolean {
  const motionX = to.x - from.x;
  const motionY = to.y - from.y;
  const lineX = line.end.x - line.start.x;
  const lineY = line.end.y - line.start.y;
  const denominator = cross(motionX, motionY, lineX, lineY);
  if (Math.abs(denominator) < 1e-8) return false;
  const offsetX = line.start.x - from.x;
  const offsetY = line.start.y - from.y;
  const motionPosition = cross(offsetX, offsetY, lineX, lineY) / denominator;
  const linePosition = cross(offsetX, offsetY, motionX, motionY) / denominator;
  return motionPosition >= 0 && motionPosition <= 1 && linePosition >= 0 && linePosition <= 1;
}

/** Count each tracked identity once when its sampled path crosses a finite image-space line. */
export function countLineCrossings(
  frames: MovementFrame[],
  line: CountingLine,
  deadbandPx = 3,
): FlowSummary {
  const lineLength = Math.hypot(line.end.x - line.start.x, line.end.y - line.start.y);
  const result: FlowSummary = {
    total: 0,
    negativeToPositive: 0,
    positiveToNegative: 0,
    events: [],
  };
  if (!Number.isFinite(lineLength) || lineLength < 1) return result;

  const states = new Map<number, TrackState>();
  const counted = new Set<number>();
  for (const frame of frames) {
    for (const track of frame.tracks) {
      if (counted.has(track.track_id)) continue;
      const point = { x: track.center_xy[0], y: track.center_xy[1] };
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      const distance = sideOfLine(point, line, lineLength);
      if (Math.abs(distance) < deadbandPx) continue;
      const side: -1 | 1 = distance < 0 ? -1 : 1;
      const previous = states.get(track.track_id);
      if (!previous) {
        states.set(track.track_id, { point, side });
        continue;
      }

      if (previous.side !== side && segmentsIntersectWithinLine(previous.point, point, line)) {
        const direction = previous.side < side ? 'negative_to_positive' : 'positive_to_negative';
        result.events.push({
          trackId: track.track_id,
          label: track.label,
          direction,
          timestampMs: frame.timestamp_ms,
        });
        counted.add(track.track_id);
        if (direction === 'negative_to_positive') result.negativeToPositive += 1;
        else result.positiveToNegative += 1;
      }
      states.set(track.track_id, { point, side });
    }
  }
  result.total = result.events.length;
  return result;
}
