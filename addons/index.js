/**
 * Addon Registry
 *
 * Central registry for all profile-based addons.
 * Addons are infrastructure components installed alongside Istio Ambient
 * (e.g., cert-manager, keycloak, solo-ui, etc.)
 */

import { FeatureManager } from '../src/lib/feature.js';
import { CertManagerFeature } from './cert-manager/index.js';
import { ExternalDnsFeature } from './external-dns/index.js';
import { SoloUIFeature } from './solo-ui/index.js';
import { KeycloakFeature } from './keycloak/index.js';
import { CiliumFeature } from './cilium/index.js';
import { TelemetryFeature } from './telemetry/index.js';
import { AgentgatewayFeature } from './agentgateway/index.js';
import { AgentregistryFeature } from './agentregistry/index.js';
import { KagentFeature } from './kagent/index.js';
import { SpireFeature } from './spire/index.js';
import { AwsLoadBalancerControllerFeature } from './aws-load-balancer-controller/index.js';

// Register all addons
FeatureManager.register('cert-manager', CertManagerFeature);
FeatureManager.register('external-dns', ExternalDnsFeature);
FeatureManager.register('solo-ui', SoloUIFeature);
FeatureManager.register('keycloak', KeycloakFeature);
FeatureManager.register('cilium', CiliumFeature);
FeatureManager.register('telemetry', TelemetryFeature);
FeatureManager.register('agentgateway', AgentgatewayFeature);
FeatureManager.register('agentregistry', AgentregistryFeature);
FeatureManager.register('kagent', KagentFeature);
FeatureManager.register('spire', SpireFeature);
FeatureManager.register('aws-load-balancer-controller', AwsLoadBalancerControllerFeature);

// Export for direct use if needed
export {
  CertManagerFeature,
  ExternalDnsFeature,
  SoloUIFeature,
  KeycloakFeature,
  CiliumFeature,
  TelemetryFeature,
  AgentgatewayFeature,
  AgentregistryFeature,
  KagentFeature,
  SpireFeature,
  AwsLoadBalancerControllerFeature,
};
