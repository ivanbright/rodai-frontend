export type ConflictTrack = {
  track_id: number;
  label: string;
  bbox_xyxy: [number, number, number, number];
  center_xy: [number, number];
  velocity_px_s: [number, number];
};

export type PotentialConflict = {
  trackIds: [number, number];
  labels: [string, string];
  timeToClosestApproachSeconds: number;
};

const DEFAULT_HORIZON_SECONDS = 3;
const MIN_TIME_SECONDS = 0.15;
const BOUNDING_BOX_MARGIN_PX = 8;

/**
 * Find pairs whose constant image-plane velocity projects their current boxes
 * into overlap soon. This is a UI warning heuristic, not collision prediction.
 */
export function findPotentialConflicts(
  tracks: ConflictTrack[],
  horizonSeconds = DEFAULT_HORIZON_SECONDS,
): PotentialConflict[] {
  if (!Number.isFinite(horizonSeconds) || horizonSeconds < MIN_TIME_SECONDS) return [];

  const conflicts: PotentialConflict[] = [];
  for (let firstIndex = 0; firstIndex < tracks.length; firstIndex += 1) {
    const first = tracks[firstIndex];
    if (!isValidTrack(first)) continue;
    for (let secondIndex = firstIndex + 1; secondIndex < tracks.length; secondIndex += 1) {
      const second = tracks[secondIndex];
      if (!isValidTrack(second) || first.track_id === second.track_id) continue;

      const relativeX = second.center_xy[0] - first.center_xy[0];
      const relativeY = second.center_xy[1] - first.center_xy[1];
      const relativeVelocityX = second.velocity_px_s[0] - first.velocity_px_s[0];
      const relativeVelocityY = second.velocity_px_s[1] - first.velocity_px_s[1];
      const relativeSpeedSquared = relativeVelocityX ** 2 + relativeVelocityY ** 2;
      if (relativeSpeedSquared < 1) continue;

      const time = -(relativeX * relativeVelocityX + relativeY * relativeVelocityY) / relativeSpeedSquared;
      if (!Number.isFinite(time) || time < MIN_TIME_SECONDS || time > horizonSeconds) continue;

      const closestX = relativeX + relativeVelocityX * time;
      const closestY = relativeY + relativeVelocityY * time;
      const firstWidth = first.bbox_xyxy[2] - first.bbox_xyxy[0];
      const firstHeight = first.bbox_xyxy[3] - first.bbox_xyxy[1];
      const secondWidth = second.bbox_xyxy[2] - second.bbox_xyxy[0];
      const secondHeight = second.bbox_xyxy[3] - second.bbox_xyxy[1];
      if (Math.abs(closestX) > (firstWidth + secondWidth) / 2 + BOUNDING_BOX_MARGIN_PX) continue;
      if (Math.abs(closestY) > (firstHeight + secondHeight) / 2 + BOUNDING_BOX_MARGIN_PX) continue;

      conflicts.push({
        trackIds: [first.track_id, second.track_id],
        labels: [first.label, second.label],
        timeToClosestApproachSeconds: time,
      });
    }
  }
  return conflicts.sort((a, b) => a.timeToClosestApproachSeconds - b.timeToClosestApproachSeconds);
}

function isValidTrack(track: ConflictTrack): boolean {
  return Number.isFinite(track.track_id)
    && track.center_xy.length === 2 && track.center_xy.every(Number.isFinite)
    && track.velocity_px_s.length === 2 && track.velocity_px_s.every(Number.isFinite)
    && track.bbox_xyxy.length === 4 && track.bbox_xyxy.every(Number.isFinite)
    && track.bbox_xyxy[2] > track.bbox_xyxy[0]
    && track.bbox_xyxy[3] > track.bbox_xyxy[1];
}
