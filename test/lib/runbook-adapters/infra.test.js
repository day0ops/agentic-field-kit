// test/lib/runbook-adapters/infra.test.js
import { test, expect } from 'bun:test';
import { InfraAdapter } from '../../../src/lib/runbook-adapters/infra.js';

const mockSelection = {
  profile: {
    metadata: { name: 'eks-multi-cluster-peering-with-agw-hub-spoke' },
    spec: { mesh: { gatewayApiVersion: 'v1.4.0' } },
  },
  infraProfile: {
    metadata: { name: 'eks-multi-cluster' },
    spec: { name: 'maple', provider: 'eks', clusters: [{ name: 'east' }, { name: 'west' }] },
  },
  environment: { spec: { aws: { region: 'ap-southeast-1' } } },
};

test('InfraAdapter.envVars returns ENTERPRISE_ISTIO_LICENSE and AWS_PROFILE as required', () => {
  const adapter = new InfraAdapter();
  const vars = adapter.envVars(mockSelection);
  const names = vars.map(v => v.name);
  expect(names).toContain('ENTERPRISE_ISTIO_LICENSE');
  expect(names).toContain('AWS_PROFILE');
  expect(vars.every(v => v.required === true)).toBe(true);
});

test('InfraAdapter.envExports returns AWS_REGION and INFRA_NAME', () => {
  const adapter = new InfraAdapter();
  const exports = adapter.envExports(mockSelection);
  const names = exports.map(e => e.name);
  expect(names).toContain('AWS_REGION');
  expect(names).toContain('INFRA_NAME');
  const region = exports.find(e => e.name === 'AWS_REGION');
  expect(region.value).toBe('ap-southeast-1');
});

test('InfraAdapter.generate produces Lab 0 (prereqs) and Lab 1 (auth) only, no provisioning', () => {
  const adapter = new InfraAdapter();
  const md = adapter.generate(0, mockSelection);
  expect(md).toContain('## Lab 0');
  expect(md).toContain('kubectl');
  expect(md).toContain('helm');
  expect(md).toContain('AWS_PROFILE');
  expect(md).not.toContain('terraform');
  expect(md).not.toContain('Infrastructure Provisioning');
});

test('InfraAdapter.generateProvisioning produces terraform instructions and kubeconfig extraction', () => {
  const adapter = new InfraAdapter();
  const md = adapter.generateProvisioning(3, mockSelection);
  expect(md).toContain('## Lab 3');
  expect(md).toContain('terraform');
  expect(md).toContain('github.com/day0ops/terraform-cloud-provisioner');
  expect(md).toContain('environments/eks/terraform.tfvars');
  expect(md).toContain('eks_kubeconfig');
});

test('InfraAdapter.generateProvisioning substitutes region and infra name with env var references', () => {
  const adapter = new InfraAdapter();
  const md = adapter.generateProvisioning(3, mockSelection);
  expect(md).toContain('eks_region          = "$AWS_REGION"');
  expect(md).toContain('eks_cluster_name    = "$INFRA_NAME"');
  expect(md).not.toContain('ap-southeast-1');
  expect(md).not.toContain('"maple"');
});

test('InfraAdapter.generateProvisioning does not forward-reference a lab number in the skip note', () => {
  const adapter = new InfraAdapter();
  const md = adapter.generateProvisioning(3, mockSelection);
  const skipSentence = md.split('\n').find(l => l.includes('Skip this lab'));
  expect(skipSentence).toBeDefined();
  expect(skipSentence).not.toMatch(/Lab \d+/);
});

test('InfraAdapter.generateProvisioning writes terraform.tfvars via an unquoted heredoc, not a plain file listing', () => {
  const adapter = new InfraAdapter();
  const md = adapter.generateProvisioning(3, mockSelection);
  expect(md).toContain('cat > environments/eks/terraform.tfvars <<EOF');
  expect(md).not.toContain('```hcl');
});

test('InfraAdapter.generateProvisioning substitutes DNS zone id/domain/child-zone with env var references', () => {
  const adapter = new InfraAdapter();
  const dnsSelection = {
    ...mockSelection,
    profile: {
      ...mockSelection.profile,
      spec: {
        ...mockSelection.profile.spec,
        addons: { clusters: [{ name: 'east', addons: [{ name: 'external-dns' }] }] },
      },
    },
    environment: {
      spec: {
        aws: { region: 'ap-southeast-1' },
        dns: { parentZone: { domain: 'kasunt.apac.fe.solo.io', hostedZoneId: 'Z12345' }, childZone: 'mesh-demo' },
      },
    },
  };
  const md = adapter.generateProvisioning(3, dnsSelection);
  expect(md).toContain('dns_parent_zone_id  = "$DNS_HOSTED_ZONE_ID"');
  expect(md).toContain('dns_parent_domain   = "$DNS_PARENT_DOMAIN"');
  expect(md).toContain('dns_child_zone_name = "$DNS_CHILD_ZONE_NAME"');
  expect(md).not.toContain('kasunt.apac.fe.solo.io');
  expect(md).not.toContain('"mesh-demo"');
});

test('InfraAdapter.generateCleanupSections produces a terraform destroy step', () => {
  const adapter = new InfraAdapter();
  const sections = adapter.generateCleanupSections(8, mockSelection, 4);
  expect(sections).toHaveLength(1);
  expect(sections[0]).toContain('### Lab 8.4 — Destroy Infrastructure');
  expect(sections[0]).toContain('terraform -chdir=environments/eks destroy');
});
