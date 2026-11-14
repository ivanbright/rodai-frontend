import { describe, expect, it } from 'vitest';
import {
  lineForCameraProfile,
  makeCameraProfile,
  parseCameraProfiles,
  serializeCameraProfiles,
} from './cameraProfiles';

describe('fixed camera measurement profiles', () => {
  const line = { start: { x: 100, y: 180 }, end: { x: 900, y: 180 } };

  it('saves normalized line coordinates and restores them at a matching aspect ratio', () => {
    const profile = makeCameraProfile('profile-1', 'North junction', line, 1000, 500, '2026-11-14T00:00:00Z');
    expect(profile).not.toBeNull();
    expect(lineForCameraProfile(profile!, 2000, 1000)).toEqual({
      start: { x: 200, y: 360 },
      end: { x: 1800, y: 360 },
    });
  });

  it('refuses to apply a line to a different aspect ratio', () => {
    const profile = makeCameraProfile('profile-1', 'North junction', line, 1000, 500);
    expect(lineForCameraProfile(profile!, 1280, 720)).toBeNull();
  });

  it('round-trips the versioned local profile document', () => {
    const profile = makeCameraProfile('profile-1', 'North junction', line, 1000, 500)!;
    expect(parseCameraProfiles(serializeCameraProfiles([profile]))).toEqual([profile]);
  });

  it('ignores malformed, unsupported, and out-of-range profile records', () => {
    expect(parseCameraProfiles('{broken')).toEqual([]);
    expect(parseCameraProfiles(JSON.stringify({ version: 2, profiles: [] }))).toEqual([]);
    expect(parseCameraProfiles(JSON.stringify({ version: 1, profiles: [{ id: 'x', name: 'x', referenceWidth: 1, referenceHeight: 1, normalizedLine: { start: { x: 2, y: 0 }, end: { x: 1, y: 1 } }, updatedAt: '' }] }))).toEqual([]);
  });

  it('rejects empty names and lines outside the saved video dimensions', () => {
    expect(makeCameraProfile('profile-1', '  ', line, 1000, 500)).toBeNull();
    expect(makeCameraProfile('profile-1', 'North junction', { ...line, end: { x: 1001, y: 180 } }, 1000, 500)).toBeNull();
  });
});
