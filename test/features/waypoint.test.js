import { describe, it, expect } from 'bun:test';
import {
  buildNamespaceLabelRemoveCommand,
  buildServiceLabelRemoveCommand,
} from '../../features/security/waypoint/index.js';

describe('waypoint cleanup label-removal commands', () => {
  it('does not use --ignore-not-found on kubectl label namespace (unsupported flag)', () => {
    const cmd = buildNamespaceLabelRemoveCommand('', 'bookinfo');
    expect(cmd).not.toContain('--ignore-not-found');
    expect(cmd).toBe('kubectl label namespace bookinfo istio.io/use-waypoint-');
  });

  it('does not use --ignore-not-found on kubectl label service (unsupported flag)', () => {
    const cmd = buildServiceLabelRemoveCommand('', 'reviews', 'bookinfo');
    expect(cmd).not.toContain('--ignore-not-found');
    expect(cmd).toBe('kubectl label service reviews -n bookinfo istio.io/use-waypoint-');
  });

  it('preserves the context flag when a cluster context is set', () => {
    const cmd = buildNamespaceLabelRemoveCommand('--context=east ', 'bookinfo');
    expect(cmd).toBe('kubectl --context=east label namespace bookinfo istio.io/use-waypoint-');
  });
});
