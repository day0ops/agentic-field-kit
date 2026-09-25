import { test, expect } from 'bun:test';
import {
  generate as certManagerRunbookGenerate,
  cleanup as certManagerRunbookCleanup,
} from '../../addons/cert-manager/runbook.js';

test('cert-manager runbook generate targets the cluster it is installed on', async () => {
  const md = await certManagerRunbookGenerate(1, { config: {} }, 'east', {}, { spec: {} });
  expect(md).toContain('--kube-context $EAST_CONTEXT');
  expect(md).toContain('kubectl apply --context $EAST_CONTEXT -f - <<EOF');
});

test("cert-manager runbook generate creates the Let's Encrypt ClusterIssuer on the target cluster", async () => {
  const addonCfg = {
    config: { letsencrypt: { enabled: true, email: 'a@b.com', region: 'us-east-1' } },
  };
  const md = await certManagerRunbookGenerate(1, addonCfg, 'west', {}, { spec: {} });
  const occurrences = md.split('kubectl apply --context $WEST_CONTEXT -f - <<EOF').length - 1;
  expect(occurrences).toBe(2); // self-signed issuer + letsencrypt-dns issuer
});

test('cert-manager runbook cleanup targets the cluster it is installed on', () => {
  const md = certManagerRunbookCleanup({ namespace: 'cert-manager' }, 'west');
  expect(md).toContain('helm uninstall cert-manager -n cert-manager --kube-context $WEST_CONTEXT');
});
