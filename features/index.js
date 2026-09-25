/**
 * Central Feature Registry
 *
 * This file imports and registers all available features with the FeatureManager.
 * Features are organized by category in subdirectories.
 */

import { FeatureManager } from '../src/lib/feature.js';

// Traffic Management Features
import { GatewayFeature } from './traffic-management/gateway/index.js';
import { RequestRoutingFeature } from './traffic-management/request-routing/index.js';
import { TrafficShiftingFeature } from './traffic-management/traffic-shifting/index.js';
import { HeaderRoutingFeature } from './traffic-management/header-routing/index.js';
import { FaultInjectionFeature } from './traffic-management/fault-injection/index.js';
import { RetryPolicyFeature } from './traffic-management/retry-policy/index.js';
import { ServiceEntryFeature } from './traffic-management/service-entry/index.js';
import { DestinationRuleFeature } from './traffic-management/destination-rule/index.js';
import { IngressHttpRouteFeature } from './traffic-management/ingress-httproute/index.js';
import { AgentgatewayBackendFeature } from './traffic-management/agentgateway-backend/index.js';

// Agentic Features
import { McpServerFeature } from './agentic/mcp-server/index.js';
import { AgentregistryRouteFeature } from './agentic/agentregistry-route/index.js';
import { AgentregistryCatalogFeature } from './agentic/agentregistry-catalog/index.js';
import { AgentregistryProviderFeature } from './agentic/agentregistry-provider/index.js';
import { AgentregistryAgentFeature } from './agentic/agentregistry-agent/index.js';
import { AgentregistryMcpServerFeature } from './agentic/agentregistry-mcp-server/index.js';
import { AgentcoreGatewayFeature } from './agentic/agentcore-gateway/index.js';
import { ProvidersFeature } from './agentic/providers/index.js';
import { TokenExchangePolicyFeature } from './agentic/token-exchange-policy/index.js';
import { AgentgatewayA2ARouteFeature } from './agentic/agentgateway-a2a-route/index.js';
import { McpToolPolicyFeature } from './agentic/mcp-tool-policy/index.js';
import { McpCodemodeRouteFeature } from './agentic/mcp-codemode-route/index.js';
import { BudgetPolicyFeature } from './agentic/budget-policy/index.js';
import { PiiGuardrailPolicyFeature } from './agentic/pii-guardrail-policy/index.js';
import { StagePolicyControllerFeature } from './agentic/stage-policy-controller/index.js';
import { McpElicitationPolicyFeature } from './agentic/mcp-elicitation-policy/index.js';
import { EntraOboPolicyFeature } from './agentic/entra-obo-policy/index.js';
import { KagentMcpServerFeature } from './agentic/kagent-mcp-server/index.js';
import { KagentAccessPolicyFeature } from './agentic/kagent-access-policy/index.js';
import { AccessPolicyTestHarnessFeature } from './agentic/access-policy-test-harness/index.js';

// Security Features
import { WaypointFeature } from './security/waypoint/index.js';
import { DenyAllPolicyFeature } from './security/deny-all-policy/index.js';
import { AuthorizationPolicyFeature } from './security/authorization-policy/index.js';
import { EgressWaypointFeature } from './security/egress-waypoint/index.js';
import { EgressAuthorizationFeature } from './security/egress-authorization/index.js';
import { EnvSecretFeature } from './security/env-secret/index.js';
import { NamespaceFeature } from './security/namespace/index.js';
import { OidcGatewayFeature } from './security/oidc-gateway/index.js';

// Multicluster Features
import { GlobalServiceFeature } from './multicluster/global-service/index.js';
import { SegmentFeature } from './multicluster/segment/index.js';
import { GlobalAliasFeature } from './multicluster/global-alias/index.js';

// Observability Features
import { ZtunnelMetricsFeature } from './observability/ztunnel-metrics/index.js';
import { IstiodMetricsFeature } from './observability/istiod-metrics/index.js';

// Register all features
// Traffic Management
FeatureManager.register('gateway', GatewayFeature);
FeatureManager.register('request-routing', RequestRoutingFeature);
FeatureManager.register('traffic-shifting', TrafficShiftingFeature);
FeatureManager.register('header-routing', HeaderRoutingFeature);
FeatureManager.register('fault-injection', FaultInjectionFeature);
FeatureManager.register('retry-policy', RetryPolicyFeature);
FeatureManager.register('service-entry', ServiceEntryFeature);
FeatureManager.register('destination-rule', DestinationRuleFeature);
FeatureManager.register('ingress-httproute', IngressHttpRouteFeature);
FeatureManager.register('agentgateway-backend', AgentgatewayBackendFeature);

// Agentic
FeatureManager.register('mcp-server', McpServerFeature);
FeatureManager.register('agentregistry-route', AgentregistryRouteFeature);
FeatureManager.register('agentregistry-catalog', AgentregistryCatalogFeature);
FeatureManager.register('agentregistry-provider', AgentregistryProviderFeature);
FeatureManager.register('agentregistry-agent', AgentregistryAgentFeature);
FeatureManager.register('agentregistry-mcp-server', AgentregistryMcpServerFeature);
FeatureManager.register('agentcore-gateway', AgentcoreGatewayFeature);
FeatureManager.register('providers', ProvidersFeature);
FeatureManager.register('token-exchange-policy', TokenExchangePolicyFeature);
FeatureManager.register('agentgateway-a2a-route', AgentgatewayA2ARouteFeature);
FeatureManager.register('mcp-tool-policy', McpToolPolicyFeature);
FeatureManager.register('mcp-codemode-route', McpCodemodeRouteFeature);
FeatureManager.register('budget-policy', BudgetPolicyFeature);
FeatureManager.register('pii-guardrail-policy', PiiGuardrailPolicyFeature);
FeatureManager.register('stage-policy-controller', StagePolicyControllerFeature);
FeatureManager.register('mcp-elicitation-policy', McpElicitationPolicyFeature);
FeatureManager.register('entra-obo-policy', EntraOboPolicyFeature);
FeatureManager.register('kagent-mcp-server', KagentMcpServerFeature);
FeatureManager.register('kagent-access-policy', KagentAccessPolicyFeature);
FeatureManager.register('access-policy-test-harness', AccessPolicyTestHarnessFeature);

// Security
FeatureManager.register('waypoint', WaypointFeature);
FeatureManager.register('deny-all-policy', DenyAllPolicyFeature);
FeatureManager.register('authorization-policy', AuthorizationPolicyFeature);
FeatureManager.register('egress-waypoint', EgressWaypointFeature);
FeatureManager.register('egress-authorization', EgressAuthorizationFeature);
FeatureManager.register('env-secret', EnvSecretFeature);
FeatureManager.register('namespace', NamespaceFeature);
FeatureManager.register('oidc-gateway', OidcGatewayFeature);

// Multicluster
FeatureManager.register('global-service', GlobalServiceFeature);
FeatureManager.register('segment', SegmentFeature);
FeatureManager.register('global-alias', GlobalAliasFeature);

// Observability
FeatureManager.register('ztunnel-metrics', ZtunnelMetricsFeature);
FeatureManager.register('istiod-metrics', IstiodMetricsFeature);

// Re-export for convenience
export { FeatureManager };

// Traffic Management
export { GatewayFeature } from './traffic-management/gateway/index.js';
export { RequestRoutingFeature } from './traffic-management/request-routing/index.js';
export { TrafficShiftingFeature } from './traffic-management/traffic-shifting/index.js';
export { HeaderRoutingFeature } from './traffic-management/header-routing/index.js';
export { FaultInjectionFeature } from './traffic-management/fault-injection/index.js';
export { RetryPolicyFeature } from './traffic-management/retry-policy/index.js';
export { ServiceEntryFeature } from './traffic-management/service-entry/index.js';
export { DestinationRuleFeature } from './traffic-management/destination-rule/index.js';
export { IngressHttpRouteFeature } from './traffic-management/ingress-httproute/index.js';
export { AgentgatewayBackendFeature } from './traffic-management/agentgateway-backend/index.js';

// Agentic
export { McpServerFeature } from './agentic/mcp-server/index.js';
export { AgentregistryRouteFeature } from './agentic/agentregistry-route/index.js';
export { AgentregistryCatalogFeature } from './agentic/agentregistry-catalog/index.js';
export { AgentregistryProviderFeature } from './agentic/agentregistry-provider/index.js';
export { AgentregistryAgentFeature } from './agentic/agentregistry-agent/index.js';
export { AgentregistryMcpServerFeature } from './agentic/agentregistry-mcp-server/index.js';
export { AgentcoreGatewayFeature } from './agentic/agentcore-gateway/index.js';
export { ProvidersFeature } from './agentic/providers/index.js';
export { TokenExchangePolicyFeature } from './agentic/token-exchange-policy/index.js';
export { AgentgatewayA2ARouteFeature } from './agentic/agentgateway-a2a-route/index.js';
export { McpToolPolicyFeature } from './agentic/mcp-tool-policy/index.js';
export { McpCodemodeRouteFeature } from './agentic/mcp-codemode-route/index.js';
export { BudgetPolicyFeature } from './agentic/budget-policy/index.js';
export { PiiGuardrailPolicyFeature } from './agentic/pii-guardrail-policy/index.js';
export { StagePolicyControllerFeature } from './agentic/stage-policy-controller/index.js';
export { McpElicitationPolicyFeature } from './agentic/mcp-elicitation-policy/index.js';
export { EntraOboPolicyFeature } from './agentic/entra-obo-policy/index.js';
export { KagentMcpServerFeature } from './agentic/kagent-mcp-server/index.js';
export { KagentAccessPolicyFeature } from './agentic/kagent-access-policy/index.js';
export { AccessPolicyTestHarnessFeature } from './agentic/access-policy-test-harness/index.js';

// Security
export { WaypointFeature } from './security/waypoint/index.js';
export { DenyAllPolicyFeature } from './security/deny-all-policy/index.js';
export { AuthorizationPolicyFeature } from './security/authorization-policy/index.js';
export { EgressWaypointFeature } from './security/egress-waypoint/index.js';
export { EgressAuthorizationFeature } from './security/egress-authorization/index.js';
export { EnvSecretFeature } from './security/env-secret/index.js';
export { NamespaceFeature } from './security/namespace/index.js';
export { OidcGatewayFeature } from './security/oidc-gateway/index.js';

// Multicluster
export { GlobalServiceFeature } from './multicluster/global-service/index.js';
export { SegmentFeature } from './multicluster/segment/index.js';
export { GlobalAliasFeature } from './multicluster/global-alias/index.js';

// Observability
export { ZtunnelMetricsFeature } from './observability/ztunnel-metrics/index.js';
export { IstiodMetricsFeature } from './observability/istiod-metrics/index.js';
