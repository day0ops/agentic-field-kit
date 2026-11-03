import { describe, it, expect } from 'bun:test';
import { OidcGatewayFeature } from '../../features/security/oidc-gateway/index.js';

const baseConfig = {
  namespace: 'kagent-system',
  hostname: 'app.example.com',
  gatewayName: 'app-https',
  routeName: 'app',
  backend: { name: 'app', port: 8080 },
};

describe('oidc-gateway, createGateway: true (default)', () => {
  const f = new OidcGatewayFeature('oidc-gateway', baseConfig);

  it('validate passes with no oidc.* config (plain public gateway)', () => {
    expect(f.validate()).toBe(true);
  });

  it('builds its own Certificate/Gateway/HTTPRoute', () => {
    expect(f.buildCertificate().kind).toBe('Certificate');
    expect(f.buildGateway().kind).toBe('Gateway');
    expect(f.buildHttpRoute().spec.hostnames).toEqual(['app.example.com']);
  });

  it('deploy applies Certificate/GatewayParameters/Gateway/HTTPRoute but no OIDC resources', async () => {
    const applied = [];
    f.applyResource = async resource => applied.push(resource.kind);
    f.log = () => {};
    await f.deploy();
    expect(applied).toEqual([
      'Certificate',
      'EnterpriseAgentgatewayParameters',
      'Gateway',
      'HTTPRoute',
    ]);
  });
});

describe('oidc-gateway, createGateway: true, with oidc.*', () => {
  const f = new OidcGatewayFeature('oidc-gateway', {
    ...baseConfig,
    oidc: {
      clientId: 'app-ui',
      clientSecret: 'app-ui-secret',
      issuerUrl: 'https://keycloak.example.com/realms/app',
    },
  });

  it('buildExtAuthPolicy targets the HTTPRoute with no sectionName', () => {
    const p = f.buildExtAuthPolicy();
    expect(p.spec.targetRefs).toEqual([
      { group: 'gateway.networking.k8s.io', kind: 'HTTPRoute', name: 'app' },
    ]);
  });
});

describe('oidc-gateway, createGateway: false (attach-only)', () => {
  const f = new OidcGatewayFeature('oidc-gateway', {
    namespace: 'kagent-system',
    routeName: 'agora-console',
    createGateway: false,
    sectionName: 'gated',
    oidc: {
      clientId: 'agora-console-ui',
      clientSecret: 'agora-console-ui-secret',
      issuerUrl: 'https://keycloak.example.com/realms/kagent',
      appUrl: 'https://agora.example.com',
    },
  });

  it('validate passes without hostname/gatewayName/backend', () => {
    expect(f.validate()).toBe(true);
  });

  it('validate requires oidc.appUrl when createGateway is false', () => {
    const bad = new OidcGatewayFeature('oidc-gateway', {
      namespace: 'kagent-system',
      routeName: 'agora-console',
      createGateway: false,
      oidc: {
        clientId: 'agora-console-ui',
        clientSecret: 'agora-console-ui-secret',
        issuerUrl: 'https://keycloak.example.com/realms/kagent',
      },
    });
    expect(() => bad.validate()).toThrow('appUrl');
  });

  it('validate requires oidc.* when createGateway is false', () => {
    const bad = new OidcGatewayFeature('oidc-gateway', {
      namespace: 'kagent-system',
      routeName: 'agora-console',
      createGateway: false,
    });
    expect(() => bad.validate()).toThrow('oidc');
  });

  it('buildExtAuthPolicy targets the existing HTTPRoute with the given sectionName', () => {
    const p = f.buildExtAuthPolicy();
    expect(p.spec.targetRefs).toEqual([
      {
        group: 'gateway.networking.k8s.io',
        kind: 'HTTPRoute',
        name: 'agora-console',
        sectionName: 'gated',
      },
    ]);
  });

  it('deploy applies only Secret/AuthConfig/EnterpriseAgentgatewayPolicy, nothing route/gateway/cert related', async () => {
    const applied = [];
    f.applyResource = async resource => applied.push(resource.kind);
    f.log = () => {};
    await f.deploy();
    expect(applied).toEqual(['Secret', 'AuthConfig', 'EnterpriseAgentgatewayPolicy']);
  });

  it('cleanup deletes only the OIDC resources, not any Gateway/Certificate/HTTPRoute', async () => {
    const deleted = [];
    f.deleteResource = async kind => deleted.push(kind);
    f.log = () => {};
    await f.cleanup();
    expect(deleted).toEqual(['enterpriseagentgatewaypolicy', 'authconfig', 'secret']);
  });
});
