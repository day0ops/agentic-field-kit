import yaml from 'js-yaml';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function renderTemplate(filename, vars) {
  const raw = readFileSync(join(__dirname, filename), 'utf8');
  return raw.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => vars[key] ?? '');
}

/**
 * Build an istio-remote-peer Gateway resource for declarative multicluster linking.
 *
 * @param {object} params
 * @param {string} params.peerName               - Remote cluster name
 * @param {string} [params.namespace]            - Namespace (default: istio-eastwest)
 * @param {string} params.address                - Remote east-west gateway address
 * @param {string} [params.addressType]          - 'IPAddress' or 'Hostname' (default: IPAddress)
 * @param {string} [params.trustDomain]          - Remote cluster trust domain (default: peerName)
 * @param {string} [params.region]               - Remote cluster region label (optional)
 * @param {string} [params.zone]                 - Remote cluster zone label (optional)
 * @param {string} [params.preferredServiceType] - peering.solo.io/preferred-data-plane-service-type (optional)
 */
export function buildRemotePeerGateway({
  peerName,
  namespace = 'istio-eastwest',
  address,
  addressType = 'IPAddress',
  trustDomain,
  region,
  zone,
  preferredServiceType,
}) {
  const gateway = yaml.load(
    renderTemplate('gateway-remote-peer.yaml', {
      peerName,
      namespace,
      address,
      addressType,
      trustDomain: trustDomain || peerName,
    })
  );

  if (region) {
    gateway.metadata.labels['topology.kubernetes.io/region'] = region;
  }
  if (zone) {
    gateway.metadata.labels['topology.kubernetes.io/zone'] = zone;
  }
  if (preferredServiceType) {
    gateway.metadata.annotations['peering.solo.io/preferred-data-plane-service-type'] =
      preferredServiceType;
  }

  return gateway;
}
