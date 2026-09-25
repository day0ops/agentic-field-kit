// test/lib/infra-state.test.js
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { InfraStateManager } from '../../src/lib/infra-state.js';

const TEST_INFRA_NAME = '__test-infra-network__';

beforeEach(() => {
  const dir = InfraStateManager.getOutputDir(TEST_INFRA_NAME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  const dir = InfraStateManager.getOutputDir(TEST_INFRA_NAME);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

test('setProvisioned stores network block per cluster', async () => {
  const clusters = [
    {
      name: 'east',
      context: 'eks-east-abc',
      cluster: 'east-cluster',
      kubeconfig: '/tmp/east.yaml',
      provisioned: true,
      network: {
        vpcId: 'vpc-0abc123',
        privateSubnetIds: ['subnet-0def456', 'subnet-0ghi789'],
        workerSgId: 'sg-0mno345',
      },
    },
  ];

  const state = await InfraStateManager.setProvisioned(TEST_INFRA_NAME, 'eks', clusters);

  expect(state.status.clusters[0].network).toBeDefined();
  expect(state.status.clusters[0].network.vpcId).toBe('vpc-0abc123');
  expect(state.status.clusters[0].network.privateSubnetIds).toEqual([
    'subnet-0def456',
    'subnet-0ghi789',
  ]);
  expect(state.status.clusters[0].network.workerSgId).toBe('sg-0mno345');
});

test('setProvisioned without network block does not store undefined', async () => {
  const clusters = [
    {
      name: 'west',
      context: 'eks-west-abc',
      cluster: 'west-cluster',
      kubeconfig: '/tmp/west.yaml',
      provisioned: true,
    },
  ];

  const state = await InfraStateManager.setProvisioned(TEST_INFRA_NAME, 'eks', clusters);

  expect(state.status.clusters[0].network).toBeUndefined();
});

test('getClusterNetwork returns network for named cluster', async () => {
  const clusters = [
    {
      name: 'east',
      context: 'eks-east-abc',
      cluster: 'east-cluster',
      kubeconfig: '/tmp/east.yaml',
      provisioned: true,
      network: {
        vpcId: 'vpc-0abc123',
        privateSubnetIds: ['subnet-0def456'],
        workerSgId: 'sg-0mno345',
      },
    },
  ];

  await InfraStateManager.setProvisioned(TEST_INFRA_NAME, 'eks', clusters);
  const state = await InfraStateManager.load(TEST_INFRA_NAME);

  const network = InfraStateManager.getClusterNetwork(state, 'east');
  expect(network).not.toBeNull();
  expect(network.vpcId).toBe('vpc-0abc123');
});

test('getClusterNetwork returns null for unknown cluster', async () => {
  const clusters = [
    {
      name: 'east',
      context: 'eks-east-abc',
      cluster: 'east-cluster',
      kubeconfig: '/tmp/east.yaml',
      provisioned: true,
    },
  ];

  await InfraStateManager.setProvisioned(TEST_INFRA_NAME, 'eks', clusters);
  const state = await InfraStateManager.load(TEST_INFRA_NAME);

  const network = InfraStateManager.getClusterNetwork(state, 'nonexistent');
  expect(network).toBeNull();
});

test('formatProjectPath returns relative path inside project root', () => {
  const absPath = join(
    InfraStateManager.INFRA_OUTPUT_BASE,
    'some-profile',
    'kubeconfig',
    'demo.yaml'
  );
  const result = InfraStateManager.formatProjectPath(absPath);
  expect(result.startsWith('._output')).toBe(true);
  expect(result).not.toContain(InfraStateManager.PROJECT_ROOT);
});

test('formatProjectPath returns path unchanged when outside project root', () => {
  const outsidePath = '/tmp/some/path.yaml';
  expect(InfraStateManager.formatProjectPath(outsidePath)).toBe('/tmp/some/path.yaml');
});

test('formatProjectPath returns null/undefined unchanged', () => {
  expect(InfraStateManager.formatProjectPath(null)).toBeNull();
  expect(InfraStateManager.formatProjectPath(undefined)).toBeUndefined();
});

test('profileMatchesKubeContext returns true when cluster context matches', () => {
  const state = {
    status: {
      clusters: [{ name: 'demo', context: 'eks-demo-abc123' }],
    },
  };
  expect(InfraStateManager.profileMatchesKubeContext(state, 'eks-demo-abc123')).toBe(true);
});

test('profileMatchesKubeContext returns false when no cluster matches', () => {
  const state = {
    status: {
      clusters: [{ name: 'demo', context: 'eks-demo-abc123' }],
    },
  };
  expect(InfraStateManager.profileMatchesKubeContext(state, 'eks-other-xyz')).toBe(false);
});

test('profileMatchesKubeContext returns false for null kubeContext', () => {
  const state = { status: { clusters: [{ name: 'demo', context: 'eks-demo-abc123' }] } };
  expect(InfraStateManager.profileMatchesKubeContext(state, null)).toBe(false);
});

test('profileMatchesKubeContext returns false for null state', () => {
  expect(InfraStateManager.profileMatchesKubeContext(null, 'eks-demo-abc123')).toBe(false);
});
