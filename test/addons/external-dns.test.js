import { test, expect } from 'bun:test';
import {
  generate as externalDnsRunbookGenerate,
  cleanup as externalDnsRunbookCleanup,
} from '../../addons/external-dns/runbook.js';

test('external-dns runbook generate targets the cluster it is installed on', async () => {
  const md = await externalDnsRunbookGenerate(1, { namespace: 'external-dns', config: {} }, 'east', {}, { spec: {} });
  expect(md).toContain('--kube-context $EAST_CONTEXT');
});

test('external-dns runbook cleanup targets the cluster it is installed on', () => {
  const md = externalDnsRunbookCleanup({ namespace: 'external-dns' }, 'east');
  expect(md).toContain('helm uninstall external-dns -n external-dns --kube-context $EAST_CONTEXT');
});
