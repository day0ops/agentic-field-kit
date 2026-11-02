import { describe, it, expect } from 'bun:test';
import { KagentRbacPolicyFeature } from '../../features/agentic/kagent-rbac-policy/index.js';

describe('kagent-rbac-policy', () => {
  const f = new KagentRbacPolicyFeature('kagent-rbac-policy', {
    policyName: 'agora-customers-view-agents',
    namespace: 'kagent-system',
    groups: ['customers'],
    grants: [{ resource: 'agents', accessLevel: 'view' }],
  });

  it('builds an EnterpriseKagentRBACPolicy matching the given groups and grants', () => {
    const policy = f.buildPolicy();
    expect(policy.apiVersion).toBe('kagent-enterprise.solo.io/v1alpha1');
    expect(policy.kind).toBe('EnterpriseKagentRBACPolicy');
    expect(policy.metadata.name).toBe('agora-customers-view-agents');
    expect(policy.metadata.namespace).toBe('kagent-system');
    expect(policy.spec.principals).toEqual([
      { all: [{ attribute: 'groups', values: ['customers'] }] },
    ]);
    expect(policy.spec.grants).toEqual([
      { name: 'view-agents', resource: 'kagent:agents', accessLevel: 'view' },
    ]);
  });

  it('supports multiple groups and multiple grants', () => {
    const multi = new KagentRbacPolicyFeature('kagent-rbac-policy', {
      policyName: 'multi',
      namespace: 'kagent-system',
      groups: ['customers', 'operators'],
      grants: [
        { resource: 'agents', accessLevel: 'view' },
        { resource: 'harnesses', accessLevel: 'manage' },
      ],
    });
    const policy = multi.buildPolicy();
    expect(policy.spec.principals[0].all[0].values).toEqual(['customers', 'operators']);
    expect(policy.spec.grants).toEqual([
      { name: 'view-agents', resource: 'kagent:agents', accessLevel: 'view' },
      { name: 'manage-harnesses', resource: 'kagent:harnesses', accessLevel: 'manage' },
    ]);
  });

  it('allows a wildcard resource grant', () => {
    const wildcard = new KagentRbacPolicyFeature('kagent-rbac-policy', {
      policyName: 'admins',
      namespace: 'kagent-system',
      groups: ['admins'],
      grants: [{ resource: '*', accessLevel: 'manage' }],
    });
    expect(wildcard.buildPolicy().spec.grants).toEqual([
      { name: 'manage-*', resource: 'kagent:*', accessLevel: 'manage' },
    ]);
  });

  it('validate requires policyName, groups, grants', () => {
    expect(() =>
      new KagentRbacPolicyFeature('kagent-rbac-policy', {
        groups: ['customers'],
        grants: [{ resource: 'agents', accessLevel: 'view' }],
      }).validate()
    ).toThrow('policyName');
    expect(() =>
      new KagentRbacPolicyFeature('kagent-rbac-policy', {
        policyName: 'p',
        grants: [{ resource: 'agents', accessLevel: 'view' }],
      }).validate()
    ).toThrow('groups');
    expect(() =>
      new KagentRbacPolicyFeature('kagent-rbac-policy', {
        policyName: 'p',
        groups: ['customers'],
      }).validate()
    ).toThrow('grants');
    expect(f.validate()).toBe(true);
  });

  it('allows a sessions grant, distinct from the addon-level catalog resource list', () => {
    const sessions = new KagentRbacPolicyFeature('kagent-rbac-policy', {
      policyName: 'customers-sessions',
      namespace: 'kagent-system',
      groups: ['customers'],
      grants: [{ resource: 'sessions', accessLevel: 'manage' }],
    });
    expect(sessions.validate()).toBe(true);
    expect(sessions.buildPolicy().spec.grants).toEqual([
      { name: 'manage-sessions', resource: 'kagent:sessions', accessLevel: 'manage' },
    ]);
  });

  it('allows a sessions-all-creators grant, for operator oversight across every user', () => {
    const oversight = new KagentRbacPolicyFeature('kagent-rbac-policy', {
      policyName: 'operators-sessions-oversight',
      namespace: 'kagent-system',
      groups: ['operators'],
      grants: [{ resource: 'sessions-all-creators', accessLevel: 'view' }],
    });
    expect(oversight.validate()).toBe(true);
    expect(oversight.buildPolicy().spec.grants).toEqual([
      { name: 'view-sessions-all-creators', resource: 'kagent:sessions-all-creators', accessLevel: 'view' },
    ]);
  });

  it('validate rejects an unknown resource or accessLevel', () => {
    expect(() =>
      new KagentRbacPolicyFeature('kagent-rbac-policy', {
        policyName: 'p',
        groups: ['customers'],
        grants: [{ resource: 'bogus', accessLevel: 'view' }],
      }).validate()
    ).toThrow('bogus');
    expect(() =>
      new KagentRbacPolicyFeature('kagent-rbac-policy', {
        policyName: 'p',
        groups: ['customers'],
        grants: [{ resource: 'agents', accessLevel: 'delete' }],
      }).validate()
    ).toThrow("'view' or 'manage'");
  });
});
