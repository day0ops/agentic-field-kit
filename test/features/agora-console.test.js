import { describe, it, expect } from 'bun:test';
import { AgoraConsoleFeature } from '../../features/agentic/agora-console/index.js';

describe('agora-console', () => {
  const f = new AgoraConsoleFeature('agora-console', {
    namespace: 'agora-demo',
    catalogApiImage: 'example.com/agora-demo/catalog-api:v0.1.0',
    consoleImage: 'example.com/agora-demo/console:v0.1.0',
    hostname: 'agora.example.com',
  });

  it('builds a catalog-api Deployment with no public exposure', () => {
    const d = f.buildCatalogApiDeployment();
    expect(d.kind).toBe('Deployment');
    expect(d.metadata.name).toBe('catalog-api');
    expect(d.metadata.namespace).toBe('agora-demo');
    expect(d.spec.template.spec.containers[0].image).toBe(
      'example.com/agora-demo/catalog-api:v0.1.0'
    );
    expect(d.spec.template.spec.containers[0].ports[0].containerPort).toBe(18080);
  });

  it('builds a catalog-api Service, ClusterIP only', () => {
    const s = f.buildCatalogApiService();
    expect(s.kind).toBe('Service');
    expect(s.metadata.name).toBe('catalog-api');
    expect(s.spec.ports[0].port).toBe(18080);
    expect(s.spec.type).toBeUndefined();
  });

  it('builds a console Deployment with CATALOG_API_URL pointed at the in-cluster catalog-api Service', () => {
    const d = f.buildConsoleDeployment();
    expect(d.kind).toBe('Deployment');
    expect(d.metadata.name).toBe('console');
    expect(d.spec.template.spec.containers[0].image).toBe('example.com/agora-demo/console:v0.1.0');
    const env = d.spec.template.spec.containers[0].env;
    expect(env).toContainEqual({ name: 'PORT', value: '18090' });
    expect(env).toContainEqual({
      name: 'CATALOG_API_URL',
      value: 'http://catalog-api.agora-demo.svc.cluster.local:18080',
    });
  });

  it('builds a console Service on the console port', () => {
    const s = f.buildConsoleService();
    expect(s.metadata.name).toBe('console');
    expect(s.spec.ports[0].port).toBe(18090);
  });

  it('builds a Certificate for the public hostname', () => {
    const c = f.buildCertificate();
    expect(c.kind).toBe('Certificate');
    expect(c.spec.dnsNames).toEqual(['agora.example.com']);
    expect(c.spec.issuerRef.name).toBe('letsencrypt-dns');
  });

  it('builds a Gateway with no infrastructure.parametersRef when sourceRanges is not set', () => {
    const g = f.buildGateway();
    expect(g.kind).toBe('Gateway');
    expect(g.spec.gatewayClassName).toBe('enterprise-agentgateway');
    expect(g.spec.listeners[0].hostname).toBe('agora.example.com');
    expect(g.spec.infrastructure).toBeUndefined();
  });

  it('builds no GatewayParameters when sourceRanges is not set', () => {
    expect(f.buildGatewayParameters()).toBeUndefined();
  });

  it('builds an HTTPRoute with a public rule and a gated /account rule, both pointing at the console Service', () => {
    const r = f.buildHTTPRoute();
    expect(r.kind).toBe('HTTPRoute');
    expect(r.spec.hostnames).toEqual(['agora.example.com']);
    expect(r.spec.rules).toEqual([
      {
        name: 'public',
        matches: [{ path: { type: 'PathPrefix', value: '/' } }],
        backendRefs: [{ group: '', kind: 'Service', name: 'console', port: 18090 }],
      },
      {
        name: 'gated',
        matches: [{ path: { type: 'PathPrefix', value: '/account' } }],
        backendRefs: [{ group: '', kind: 'Service', name: 'console', port: 18090 }],
      },
    ]);
  });

  it('validate throws when a required field is missing', () => {
    const bad = new AgoraConsoleFeature('agora-console', {
      namespace: 'agora-demo',
      catalogApiImage: 'example.com/catalog-api:v1',
    });
    expect(() => bad.validate()).toThrow('consoleImage');
  });
});

describe('agora-console with sourceRanges', () => {
  const f = new AgoraConsoleFeature('agora-console', {
    namespace: 'agora-demo',
    catalogApiImage: 'example.com/catalog-api:v1',
    consoleImage: 'example.com/console:v1',
    hostname: 'agora.example.com',
    sourceRanges: ['10.0.0.0/8'],
  });

  it('builds GatewayParameters restricting the LoadBalancer Service', () => {
    const p = f.buildGatewayParameters();
    expect(p.kind).toBe('EnterpriseAgentgatewayParameters');
    expect(p.spec.service.spec.loadBalancerSourceRanges).toEqual(['10.0.0.0/8']);
  });

  it('references the GatewayParameters from the Gateway', () => {
    const g = f.buildGateway();
    expect(g.spec.infrastructure.parametersRef.name).toBe('agora-console-https-params');
  });
});

describe('agora-console with exposeDirectly: false', () => {
  const f = new AgoraConsoleFeature('agora-console', {
    namespace: 'agora-demo',
    catalogApiImage: 'example.com/agora-demo/catalog-api:v0.1.0',
    consoleImage: 'example.com/agora-demo/console:v0.1.0',
    hostname: 'agora.example.com',
    exposeDirectly: false,
  });

  it('skips building its own Gateway/Certificate/HTTPRoute', async () => {
    const applied = [];
    f.applyResource = async resource => applied.push(resource.kind);
    f.deleteResource = async () => {};
    f.log = () => {};
    await f.deploy();
    expect(applied).toEqual(['Deployment', 'Service', 'Deployment', 'Service']);
    expect(applied).not.toContain('Certificate');
    expect(applied).not.toContain('Gateway');
    expect(applied).not.toContain('HTTPRoute');
  });

  it('skips deleting its own Gateway/Certificate/HTTPRoute on cleanup', async () => {
    const deleted = [];
    f.deleteResource = async kind => deleted.push(kind);
    f.log = () => {};
    await f.cleanup();
    expect(deleted).toEqual(['service', 'deployment', 'service', 'deployment']);
  });
});
