import { describe, it, expect } from 'bun:test';
import {
  buildServiceLabelArgs,
  buildServiceAnnotationArgs,
  buildServiceLabelRemoveArgs,
  buildServiceAnnotationRemoveArgs,
} from '../../features/multicluster/global-service/index.js';

describe('global-service label/annotate removal args', () => {
  it('never includes --ignore-not-found (unsupported on kubectl label/annotate)', () => {
    const labelArgs = buildServiceLabelRemoveArgs(null, 'bookinfo', 'reviews', [
      'solo.io/service-scope',
    ]);
    const annotationArgs = buildServiceAnnotationRemoveArgs(null, 'bookinfo', 'reviews', ['foo']);
    expect(labelArgs).not.toContain('--ignore-not-found=true');
    expect(annotationArgs).not.toContain('--ignore-not-found=true');
  });

  it('builds a label-removal command appending "-" to each key', () => {
    const args = buildServiceLabelRemoveArgs(null, 'bookinfo', 'reviews', ['a', 'b']);
    expect(args).toEqual(['label', 'service', 'reviews', '-n', 'bookinfo', 'a-', 'b-']);
  });

  it('builds an annotation-removal command appending "-" to each key', () => {
    const args = buildServiceAnnotationRemoveArgs(null, 'bookinfo', 'reviews', ['x']);
    expect(args).toEqual(['annotate', 'service', 'reviews', '-n', 'bookinfo', 'x-']);
  });

  it('includes --context when a cluster context is given', () => {
    const args = buildServiceLabelRemoveArgs('east', 'bookinfo', 'reviews', ['a']);
    expect(args[0]).toBe('--context=east');
  });
});

describe('global-service label/annotate set args', () => {
  it('keeps each key=value pair as its own argv element (no shell join), so values with spaces survive', () => {
    const args = buildServiceLabelArgs(null, 'bookinfo', 'reviews', { team: 'platform eng' });
    expect(args).toEqual([
      'label',
      'service',
      'reviews',
      '-n',
      'bookinfo',
      'team=platform eng',
      '--overwrite',
    ]);
  });

  it('builds annotation set args the same way', () => {
    const args = buildServiceAnnotationArgs(null, 'bookinfo', 'reviews', {
      note: 'needs review',
    });
    expect(args).toEqual([
      'annotate',
      'service',
      'reviews',
      '-n',
      'bookinfo',
      'note=needs review',
      '--overwrite',
    ]);
  });
});
