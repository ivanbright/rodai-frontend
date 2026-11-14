import type { CountingLine } from './movement';

export const CAMERA_PROFILES_STORAGE_KEY = 'rodai.camera-measurement-profiles.v1';
const PROFILE_FORMAT_VERSION = 1;
const MAX_PROFILES = 100;

export type CameraMeasurementProfile = {
  id: string;
  name: string;
  referenceWidth: number;
  referenceHeight: number;
  normalizedLine: CountingLine;
  updatedAt: string;
};

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNormalizedLine(value: unknown): value is CountingLine {
  if (!value || typeof value !== 'object') return false;
  const line = value as CountingLine;
  return [line.start?.x, line.start?.y, line.end?.x, line.end?.y]
    .every((point) => typeof point === 'number' && Number.isFinite(point) && point >= 0 && point <= 1);
}

function isProfile(value: unknown): value is CameraMeasurementProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as CameraMeasurementProfile;
  return typeof profile.id === 'string' && profile.id.length > 0
    && typeof profile.name === 'string' && profile.name.trim().length > 0
    && isFinitePositive(profile.referenceWidth)
    && isFinitePositive(profile.referenceHeight)
    && isNormalizedLine(profile.normalizedLine)
    && typeof profile.updatedAt === 'string';
}

export function parseCameraProfiles(serialized: string | null): CameraMeasurementProfile[] {
  if (!serialized) return [];
  try {
    const value: unknown = JSON.parse(serialized);
    if (!value || typeof value !== 'object') return [];
    const document = value as { version?: unknown; profiles?: unknown };
    if (document.version !== PROFILE_FORMAT_VERSION || !Array.isArray(document.profiles)) return [];
    return document.profiles.filter(isProfile).slice(0, MAX_PROFILES);
  } catch {
    return [];
  }
}

export function serializeCameraProfiles(profiles: CameraMeasurementProfile[]): string {
  return JSON.stringify({ version: PROFILE_FORMAT_VERSION, profiles: profiles.slice(0, MAX_PROFILES) });
}

export function makeCameraProfile(
  id: string,
  name: string,
  line: CountingLine,
  width: number,
  height: number,
  updatedAt = new Date().toISOString(),
): CameraMeasurementProfile | null {
  const trimmedName = name.trim();
  if (!trimmedName || !id || !isFinitePositive(width) || !isFinitePositive(height)) return null;
  if (![line.start.x, line.start.y, line.end.x, line.end.y].every(Number.isFinite)) return null;
  if ([line.start.x, line.start.y, line.end.x, line.end.y].some((point) => point < 0)) return null;
  if (line.start.x > width || line.end.x > width || line.start.y > height || line.end.y > height) return null;
  return {
    id,
    name: trimmedName,
    referenceWidth: width,
    referenceHeight: height,
    normalizedLine: {
      start: { x: line.start.x / width, y: line.start.y / height },
      end: { x: line.end.x / width, y: line.end.y / height },
    },
    updatedAt,
  };
}

export function lineForCameraProfile(
  profile: CameraMeasurementProfile,
  width: number,
  height: number,
): CountingLine | null {
  if (!isFinitePositive(width) || !isFinitePositive(height)) return null;
  const profileRatio = profile.referenceWidth / profile.referenceHeight;
  const currentRatio = width / height;
  if (Math.abs(profileRatio - currentRatio) / profileRatio > 0.01) return null;
  return {
    start: { x: profile.normalizedLine.start.x * width, y: profile.normalizedLine.start.y * height },
    end: { x: profile.normalizedLine.end.x * width, y: profile.normalizedLine.end.y * height },
  };
}
