import { test, expect, describe } from 'bun:test';
import { TerraformCloudRunner } from '../../src/lib/provisioner-runners/terraform-cloud.js';

function eksRunner(provisionerOverrides = {}) {
  const clusters = [
    {
      name: 'demo',
      provisioner: {
        type: 'eks',
        owner: 'test-owner',
        aws_profile: 'default',
        ...provisionerOverrides,
      },
    },
  ];
  return new TerraformCloudRunner('test-profile', clusters, {
    outputDir: '/tmp/unused',
    kubeconfigDir: '/tmp/unused',
  });
}

describe('TerraformCloudRunner node sleep schedule', () => {
  test('is omitted from generated vars when not configured', () => {
    const runner = eksRunner();
    const config = runner.resolveConfiguration();
    const vars = runner.providerConfig.generateVars(config);

    expect(config.enableNodeSleepSchedule).toBeUndefined();
    expect(vars.enable_node_sleep_schedule).toBeUndefined();
    expect(vars.node_sleep_cron).toBeUndefined();
    expect(vars.node_wake_cron).toBeUndefined();
    expect(vars.node_sleep_timezone).toBeUndefined();
  });

  test('flows through to generated vars when enabled with min nodes 0', () => {
    const runner = eksRunner({
      nodes: { desired: 2, min: 0, max: 2 },
      enable_node_sleep_schedule: true,
      node_sleep_cron: '30 18 * * MON-FRI',
      node_wake_cron: '0 8 * * MON-FRI',
      node_sleep_timezone: 'Pacific/Auckland',
    });
    const config = runner.resolveConfiguration();
    const vars = runner.providerConfig.generateVars(config);

    expect(vars.enable_node_sleep_schedule).toBe(true);
    expect(vars.node_sleep_cron).toBe('30 18 * * MON-FRI');
    expect(vars.node_wake_cron).toBe('0 8 * * MON-FRI');
    expect(vars.node_sleep_timezone).toBe('Pacific/Auckland');
    expect(vars.eks_min_nodes).toBe(0);
  });

  test('rejects enable_node_sleep_schedule without nodes.min: 0', () => {
    const runner = eksRunner({
      nodes: { desired: 2 },
      enable_node_sleep_schedule: true,
    });

    expect(() => runner.resolveConfiguration()).toThrow(/nodes\.min: 0/);
  });
});

describe('TerraformCloudRunner.nodeSleep', () => {
  test('rejects non-eks providers', async () => {
    const clusters = [{ name: 'demo', provisioner: { type: 'gke', owner: 'test-owner' } }];
    const runner = new TerraformCloudRunner('test-profile', clusters, {
      outputDir: '/tmp/unused',
      kubeconfigDir: '/tmp/unused',
    });

    await expect(runner.nodeSleep('sleep')).rejects.toThrow(/only supported for 'eks'/);
  });

  test('rejects when no terraform state file exists', async () => {
    const runner = eksRunner({ nodes: { desired: 2, min: 0 } });

    await expect(runner.nodeSleep('sleep')).rejects.toThrow(/No terraform state file/);
  });

  test('rejects sleep when nodes.min is not 0', async () => {
    const runner = eksRunner({ nodes: { desired: 2 } });
    runner.stateFile = import.meta.path; // any file that exists, to pass the state-file check

    await expect(runner.nodeSleep('sleep')).rejects.toThrow(/nodes\.min: 0/);
  });
});
