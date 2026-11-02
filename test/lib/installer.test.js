import { test, expect, describe } from 'bun:test';
import { InstallerManager } from '../../src/lib/installer.js';

describe('InstallerManager.orderForCleanup', () => {
  test('defers cert-manager, external-dns, aws-load-balancer-controller, and cilium to the end, in that priority order', () => {
    const addons = [
      { name: 'cilium' },
      { name: 'aws-load-balancer-controller' },
      { name: 'external-dns' },
      { name: 'keycloak' },
      { name: 'cert-manager' },
      { name: 'solo-ui' },
    ];
    const ordered = InstallerManager.orderForCleanup(addons);
    expect(ordered.map(a => a.name)).toEqual([
      'solo-ui',
      'keycloak',
      'cert-manager',
      'external-dns',
      'aws-load-balancer-controller',
      'cilium',
    ]);
  });

  test('reverses install order for the non-deferred addons', () => {
    const addons = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    expect(InstallerManager.orderForCleanup(addons).map(a => a.name)).toEqual(['c', 'b', 'a']);
  });

  test('supports addon entries given as plain strings', () => {
    const addons = ['aws-load-balancer-controller', 'keycloak', 'cilium'];
    expect(InstallerManager.orderForCleanup(addons)).toEqual([
      'keycloak',
      'aws-load-balancer-controller',
      'cilium',
    ]);
  });

  test('cilium is last even when cert-manager/external-dns/aws-load-balancer-controller are absent', () => {
    const addons = [{ name: 'cilium' }, { name: 'keycloak' }];
    expect(InstallerManager.orderForCleanup(addons).map(a => a.name)).toEqual([
      'keycloak',
      'cilium',
    ]);
  });

  test('is a no-op when none of the deferred addons are present', () => {
    const addons = [{ name: 'keycloak' }, { name: 'solo-ui' }];
    expect(InstallerManager.orderForCleanup(addons).map(a => a.name)).toEqual([
      'solo-ui',
      'keycloak',
    ]);
  });

  test('handles an empty list', () => {
    expect(InstallerManager.orderForCleanup([])).toEqual([]);
  });
});
