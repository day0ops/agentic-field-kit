import { describe, it, expect } from 'bun:test';
import { TokenExchangePolicyFeature } from '../../features/agentic/token-exchange-policy/index.js';

const BASE_CONFIG = {
  policyName: 'agora-chat-auth',
  namespace: 'kagent-system',
  targetHTTPRoute: 'agora-console',
  staticBackendNames: ['kagent-controller-a2a'],
  jwtIssuer: 'https://keycloak.example.com/realms/agora-customers',
  keycloak: { namespace: 'keycloak' },
  jwksPath: '/realms/agora-customers/protocol/openid-connect/certs',
  exchangePath: '/realms/agora-customers/protocol/openid-connect/token',
  clientId: 'agora-console-ui',
  clientSecret: 'secret',
};

describe('token-exchange-policy extraJwtHTTPRoutes', () => {
  it('defaults to empty: JWT policy only targets targetHTTPRoute', () => {
    const f = new TokenExchangePolicyFeature('token-exchange-policy', BASE_CONFIG);
    const jwt = f.buildJwtPolicy();
    expect(jwt.spec.targetRefs).toEqual([
      { group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: 'agora-console' },
    ]);
  });

  it('adds extra HTTPRoute targetRefs for JWT enforcement, independently of staticBackendNames', () => {
    const f = new TokenExchangePolicyFeature('token-exchange-policy', {
      ...BASE_CONFIG,
      extraJwtHTTPRoutes: ['shopping-assistant-a2a', 'listing-pricing-assistant-a2a'],
    });
    const jwt = f.buildJwtPolicy();
    expect(jwt.spec.targetRefs).toEqual([
      { group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: 'agora-console' },
      { group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: 'shopping-assistant-a2a' },
      {
        group: 'gateway.networking.k8s.io',
        kind: 'HTTPRoute',
        name: 'listing-pricing-assistant-a2a',
      },
    ]);
  });

  it('extraJwtHTTPRoutes does not affect the exchange policy, which still targets staticBackendNames only', () => {
    const f = new TokenExchangePolicyFeature('token-exchange-policy', {
      ...BASE_CONFIG,
      extraJwtHTTPRoutes: ['shopping-assistant-a2a'],
    });
    const exchange = f.buildExchangePolicy(f.staticBackendNames);
    expect(exchange.spec.targetRefs).toEqual([
      {
        group: 'enterpriseagentgateway.solo.io',
        kind: 'EnterpriseAgentgatewayBackend',
        name: 'kagent-controller-a2a',
      },
    ]);
  });

  it('combines with a2aAgentNames without duplication or interference', () => {
    const f = new TokenExchangePolicyFeature('token-exchange-policy', {
      ...BASE_CONFIG,
      a2aAgentNames: ['order-lookup'],
      extraJwtHTTPRoutes: ['shopping-assistant-a2a'],
    });
    const jwt = f.buildJwtPolicy();
    expect(jwt.spec.targetRefs.map(r => r.name)).toEqual([
      'agora-console',
      'order-lookup-a2a',
      'shopping-assistant-a2a',
    ]);
  });
});
