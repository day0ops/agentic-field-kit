// test/lib/template-resolver.test.js
import { test, expect } from 'bun:test';
import { TemplateResolver } from '../../src/lib/template-resolver.js';

const mockEnvironment = {
  spec: {
    aws: { region: 'ap-southeast-1' },
    domains: { core: { keycloak: 'keycloak.example.com' } },
  },
};

const mockInfraState = {
  status: {
    clusters: [
      {
        name: 'east',
        context: 'eks-east-abc',
        network: {
          vpcId: 'vpc-0abc123',
          privateSubnetIds: ['subnet-0def456', 'subnet-0ghi789'],
          workerSgId: 'sg-0mno345',
        },
      },
      {
        name: 'west',
        context: 'eks-west-xyz',
        network: {
          vpcId: 'vpc-0xyz999',
          privateSubnetIds: ['subnet-0aaa111'],
          workerSgId: 'sg-0bbb222',
        },
      },
    ],
  },
};

test('buildContext without infraState has no infra key', () => {
  const ctx = TemplateResolver.buildContext(
    { name: 'east', context: 'ctx', role: 'workload' },
    mockEnvironment
  );
  expect(ctx.infra).toBeUndefined();
});

test('buildContext with infraState exposes infra.clusters keyed by name', () => {
  const ctx = TemplateResolver.buildContext(
    { name: 'east', context: 'ctx', role: 'workload' },
    mockEnvironment,
    mockInfraState
  );
  expect(ctx.infra).toBeDefined();
  expect(ctx.infra.clusters.east).toBeDefined();
  expect(ctx.infra.clusters.west).toBeDefined();
});

test('resolveString resolves {{infra.clusters.east.network.vpcId}}', () => {
  const ctx = TemplateResolver.buildContext(
    { name: 'east', context: 'ctx', role: 'workload' },
    mockEnvironment,
    mockInfraState
  );
  const result = TemplateResolver.resolveString('{{infra.clusters.east.network.vpcId}}', ctx);
  expect(result).toBe('vpc-0abc123');
});

test('resolveString resolves {{infra.clusters.east.network.privateSubnetIds}} as array', () => {
  const ctx = TemplateResolver.buildContext(
    { name: 'east', context: 'ctx', role: 'workload' },
    mockEnvironment,
    mockInfraState
  );
  const result = TemplateResolver.resolveString(
    '{{infra.clusters.east.network.privateSubnetIds}}',
    ctx
  );
  expect(result).toEqual(['subnet-0def456', 'subnet-0ghi789']);
});

test('resolveString resolves {{infra.clusters.east.network.privateSubnetIds[0]}} as first element', () => {
  const ctx = TemplateResolver.buildContext(
    { name: 'east', context: 'ctx', role: 'workload' },
    mockEnvironment,
    mockInfraState
  );
  const result = TemplateResolver.resolveString(
    '{{infra.clusters.east.network.privateSubnetIds[0]}}',
    ctx
  );
  expect(result).toBe('subnet-0def456');
});

test('resolveString resolves {{infra.clusters.east.network.workerSgId}}', () => {
  const ctx = TemplateResolver.buildContext(
    { name: 'east', context: 'ctx', role: 'workload' },
    mockEnvironment,
    mockInfraState
  );
  const result = TemplateResolver.resolveString('{{infra.clusters.east.network.workerSgId}}', ctx);
  expect(result).toBe('sg-0mno345');
});

test('resolveString resolves {{infra.clusters.west.network.vpcId}} for west', () => {
  const ctx = TemplateResolver.buildContext(
    { name: 'west', context: 'ctx', role: 'workload' },
    mockEnvironment,
    mockInfraState
  );
  const result = TemplateResolver.resolveString('{{infra.clusters.west.network.vpcId}}', ctx);
  expect(result).toBe('vpc-0xyz999');
});

test('existing env.* templates still resolve with infraState present', () => {
  const ctx = TemplateResolver.buildContext(
    { name: 'east', context: 'ctx', role: 'workload' },
    mockEnvironment,
    mockInfraState
  );
  const result = TemplateResolver.resolveString('{{env.aws.region}}', ctx);
  expect(result).toBe('ap-southeast-1');
});

test('resolveValues resolves nested object with infra templates', () => {
  const ctx = TemplateResolver.buildContext(
    { name: 'east', context: 'ctx', role: 'workload' },
    mockEnvironment,
    mockInfraState
  );
  const values = {
    networkId: '{{infra.clusters.east.network.vpcId}}',
    privateSubnetIds: '{{infra.clusters.east.network.privateSubnetIds}}',
    region: '{{env.aws.region}}',
  };
  const result = TemplateResolver.resolveValues(values, ctx);
  expect(result.networkId).toBe('vpc-0abc123');
  expect(result.privateSubnetIds).toEqual(['subnet-0def456', 'subnet-0ghi789']);
  expect(result.region).toBe('ap-southeast-1');
});
