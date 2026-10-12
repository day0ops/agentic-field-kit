// test/lib/provisioner-runners/terraform-cloud.test.js
import { test, expect } from 'bun:test';
import { TerraformCloudRunner } from '../../../src/lib/provisioner-runners/terraform-cloud.js';

function makeRunner(providerType, provisionerOverrides) {
  const clusters = [
    {
      name: 'demo',
      provisioner: { type: providerType, ...provisionerOverrides },
    },
  ];
  return new TerraformCloudRunner('test-profile', clusters, {
    outputDir: '/tmp/terraform-cloud-test-output',
  });
}

test('resolveConfiguration defaults workloadStorageForceDestroy to false', () => {
  const runner = makeRunner('gke', {});
  const config = runner.resolveConfiguration();
  expect(config.workloadStorageForceDestroy).toBe(false);
});

test('resolveConfiguration reads workload_storage_force_destroy: true', () => {
  const runner = makeRunner('gke', { workload_storage_force_destroy: true });
  const config = runner.resolveConfiguration();
  expect(config.workloadStorageForceDestroy).toBe(true);
});

test('gke generateVars emits workload_storage_force_destroy=true when opted in', () => {
  const runner = makeRunner('gke', { workload_storage_force_destroy: true });
  const config = runner.resolveConfiguration();
  const vars = runner.providerConfig.generateVars(config);
  expect(vars.workload_storage_force_destroy).toBe(true);
});

test('gke generateVars omits workload_storage_force_destroy when not opted in', () => {
  const runner = makeRunner('gke', {});
  const config = runner.resolveConfiguration();
  const vars = runner.providerConfig.generateVars(config);
  expect(vars.workload_storage_force_destroy).toBeUndefined();
});

test('eks generateVars emits workload_storage_force_destroy=true when opted in', () => {
  const runner = makeRunner('eks', { workload_storage_force_destroy: true });
  const config = runner.resolveConfiguration();
  const vars = runner.providerConfig.generateVars(config);
  expect(vars.workload_storage_force_destroy).toBe(true);
});

test('eks generateVars omits workload_storage_force_destroy when not opted in', () => {
  const runner = makeRunner('eks', {});
  const config = runner.resolveConfiguration();
  const vars = runner.providerConfig.generateVars(config);
  expect(vars.workload_storage_force_destroy).toBeUndefined();
});
