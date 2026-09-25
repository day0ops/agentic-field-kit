// test/lib/runbook-adapters/usecase.test.js
import { test, expect } from 'bun:test';
import { UseCaseAdapter } from '../../../src/lib/runbook-adapters/usecase.js';

const baseUsecase = {
  metadata: { name: 'my-usecase', description: 'A test use case.' },
  spec: {
    tests: [
      {
        name: 'exec-and-verify-resource',
        description: 'Runs an exec step then checks a resource field',
        clusters: [{ name: 'east' }],
        steps: [
          {
            action: 'exec',
            command:
              "kubectl get serviceentry -n istio-system -o jsonpath='{.items[*].spec.hosts[*]}'",
            retries: 5,
            retryDelay: 6000,
            timeout: '30s',
          },
          {
            action: 'verify-resource',
            kind: 'ServiceEntry',
            name: 'reviews',
            namespace: 'istio-system',
            expect: [{ jsonpath: '{.spec.hosts[0]}', value: 'reviews.bookinfo.mesh.internal' }],
          },
        ],
      },
      {
        name: 'send-request-and-verify',
        description: 'Sends a request and verifies the response',
        clusters: [{ name: 'east' }],
        steps: [
          {
            action: 'send-request',
            hostname: 'app.example.com',
            path: '/mcp',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: { hello: 'world' },
          },
          {
            action: 'verify',
            expect: { statusCode: 200, contains: ['tools'] },
          },
        ],
      },
    ],
  },
};

const options = { env: null };

test('UseCaseAdapter._renderDeploy targets the application manifest at the cluster(s) named in requires.applications', () => {
  const adapter = new UseCaseAdapter();
  const usecase = {
    metadata: { name: 'my-usecase' },
    spec: { requires: { applications: [{ name: 'bookinfo', clusters: [{ name: 'west' }] }] } },
  };
  const md = adapter._renderDeploy(usecase, options);
  expect(md).toContain("kubectl apply --context $WEST_CONTEXT -f - <<'EOF'");
});

test('UseCaseAdapter._renderDeploy renders feature steps without a heading for tests or cleanup', () => {
  const adapter = new UseCaseAdapter();
  const usecase = {
    metadata: { name: 'my-usecase' },
    spec: {
      features: [
        { name: 'mcp-server', description: 'Deploy MCP server', config: { namespace: 'mcp' } },
      ],
    },
  };
  const md = adapter._renderDeploy(usecase, options);
  expect(md).toContain('<div class="test-card">');
  expect(md).toContain('<div class="test-section-label">Steps</div>');
  expect(md).toContain('Deploy MCP server');
  expect(md).not.toContain('#### Cleanup');
  expect(md).not.toContain('Expect:');
});

test('UseCaseAdapter._renderDeploy resolves {{env.domains.*}} templates to $ENV_VAR refs in an unquoted heredoc for registered features', () => {
  const adapter = new UseCaseAdapter();
  const usecase = {
    metadata: { name: 'my-usecase' },
    spec: {
      features: [
        {
          name: 'ingress-httproute',
          config: {
            routeName: 'r',
            gatewayName: 'g',
            namespace: 'ns',
            hostname: '{{env.domains.app.main}}',
            rules: [
              {
                matches: [{ path: { type: 'PathPrefix', value: '/' } }],
                backendRefs: [{ name: 'b' }],
              },
            ],
          },
          clusters: [{ name: 'east' }],
        },
      ],
    },
  };
  const md = adapter._renderDeploy(usecase, { env: null });
  expect(md).toContain('<<EOF');
  expect(md).not.toContain("<<'EOF'");
  expect(md).toContain('$AGENTGATEWAY_HOSTNAME');
  expect(md).not.toContain('{{env.');
});

test('UseCaseAdapter._renderDeploy resolves {{env.*}} templates for features without a registered builder (plain yaml block)', () => {
  const adapter = new UseCaseAdapter();
  const usecase = {
    metadata: { name: 'my-usecase' },
    spec: {
      features: [
        {
          name: 'some-custom-feature',
          config: {
            keycloakHostname: '{{env.domains.core.keycloak}}',
            registryUrl: '{{env.agentregistry.scheme}}://{{env.domains.core.agentregistryUi}}',
          },
        },
      ],
    },
  };
  const env = { spec: { agentregistry: { scheme: 'https' } } };
  const md = adapter._renderDeploy(usecase, { env });
  expect(md).not.toContain('{{env.');
  expect(md).toContain('$KEYCLOAK_HOSTNAME');
  expect(md).toContain('https://$AGENTREGISTRY_HOSTNAME');
});

test('UseCaseAdapter._renderSingleTest wraps the test in a labeled test-card with Goal/Run/Expect', () => {
  const adapter = new UseCaseAdapter();
  const md = adapter._renderSingleTest(baseUsecase.spec.tests[0], baseUsecase, '');
  expect(md).toContain('<div class="test-card">');
  expect(md).toContain('<div class="test-section-label">Goal</div>');
  expect(md).toContain('<div class="test-section-label">Run</div>');
  expect(md).toContain('<div class="test-section-label">Expect</div>');
  expect(md).toContain(baseUsecase.spec.tests[0].description);
  expect(md.trim().endsWith('</div>')).toBe(true);
});

test('UseCaseAdapter._renderSingleTest renders exec step with cluster context and trailer comment', () => {
  const adapter = new UseCaseAdapter();
  const md = adapter._renderSingleTest(baseUsecase.spec.tests[0], baseUsecase, '');
  expect(md).toContain('kubectl --context $EAST_CONTEXT get serviceentry');
  expect(md).toContain('# retries: 5, retryDelay: 6s, timeout: 30s');
});

test('UseCaseAdapter._renderSingleTest renders verify-resource as a kubectl jsonpath check under Run, and its expected value under Expect', () => {
  const adapter = new UseCaseAdapter();
  const md = adapter._renderSingleTest(baseUsecase.spec.tests[0], baseUsecase, '');
  expect(md).toContain(
    "kubectl --context $EAST_CONTEXT get ServiceEntry reviews -n istio-system -o jsonpath='{.spec.hosts[0]}'"
  );
  expect(md).not.toContain('# expect:');
  expect(md).toContain(
    '`ServiceEntry/reviews` (`istio-system`) at `{.spec.hosts[0]}` is `reviews.bookinfo.mesh.internal`'
  );
});

test('UseCaseAdapter._renderSingleTest reconstructs the send-request curl invocation', () => {
  const adapter = new UseCaseAdapter();
  const md = adapter._renderSingleTest(baseUsecase.spec.tests[1], baseUsecase, '');
  expect(md).toContain('curl -X POST http://$GATEWAY_ADDRESS/mcp');
  expect(md).toContain('-H "Host: app.example.com"');
  expect(md).toContain('-H "Content-Type: application/json"');
  expect(md).toContain(`-d '{"hello":"world"}'`);
  expect(md).toContain('$GATEWAY_ADDRESS` is auto-detected');
});

test('UseCaseAdapter._renderSingleTest renders verify expectations as a bullet list under Expect', () => {
  const adapter = new UseCaseAdapter();
  const md = adapter._renderSingleTest(baseUsecase.spec.tests[1], baseUsecase, '');
  expect(md).toContain('Status code is `200`');
  expect(md).toContain('Response contains `tools`');
  const expectIdx = md.indexOf('<div class="test-section-label">Expect</div>');
  const bulletIdx = md.indexOf('Status code is `200`');
  expect(expectIdx).toBeGreaterThan(-1);
  expect(expectIdx).toBeLessThan(bulletIdx);
});

test('UseCaseAdapter._renderSingleTest includes the leading note before the test-card', () => {
  const adapter = new UseCaseAdapter();
  const md = adapter._renderSingleTest(
    baseUsecase.spec.tests[0],
    baseUsecase,
    '_Some shared note._'
  );
  expect(md.startsWith('_Some shared note._')).toBe(true);
  expect(md.indexOf('_Some shared note._')).toBeLessThan(md.indexOf('<div class="test-card">'));
});

test('UseCaseAdapter._renderCleanupSteps deletes features in reverse order via a simple one-liner (not a full manifest)', () => {
  const adapter = new UseCaseAdapter();
  const usecase = {
    metadata: { name: 'my-usecase' },
    spec: {
      features: [
        {
          name: 'ingress-httproute',
          description: 'Route traffic',
          config: { routeName: 'mcp-hub-route', gatewayName: 'g', namespace: 'agentgateway-proxy' },
          clusters: [{ name: 'west' }],
        },
      ],
    },
  };
  const md = adapter._renderCleanupSteps(usecase, options);
  expect(md).toContain('#### Delete Features');
  expect(md).toContain('<div class="test-card">');
  expect(md).toContain('**Route traffic**');
  expect(md).toContain(
    'kubectl delete --context $WEST_CONTEXT httproute mcp-hub-route -n agentgateway-proxy --ignore-not-found=true'
  );
  expect(md).not.toContain('-f - <<');
  expect(md).not.toContain('apiVersion:');
});

test('UseCaseAdapter._renderCleanupSteps deletes prerequisite applications using the same manifest as deploy', () => {
  const adapter = new UseCaseAdapter();
  const usecase = {
    metadata: { name: 'my-usecase' },
    spec: { requires: { applications: [{ name: 'bookinfo' }] } },
  };
  const md = adapter._renderCleanupSteps(usecase, options);
  expect(md).toContain('#### Delete Prerequisite Applications');
  expect(md).toContain("kubectl delete --ignore-not-found=true -f - <<'EOF'");
});

test('UseCaseAdapter._renderCleanupSteps targets the application manifest deletion at the cluster(s) named in requires.applications', () => {
  const adapter = new UseCaseAdapter();
  const usecase = {
    metadata: { name: 'my-usecase' },
    spec: { requires: { applications: [{ name: 'bookinfo', clusters: [{ name: 'west' }] }] } },
  };
  const md = adapter._renderCleanupSteps(usecase, options);
  expect(md).toContain(
    "kubectl delete --context $WEST_CONTEXT --ignore-not-found=true -f - <<'EOF'"
  );
});

test('UseCaseAdapter._renderCleanupSteps deletes just the namespace when the application pins one (matches UseCaseManager.cleanup)', () => {
  const adapter = new UseCaseAdapter();
  const usecase = {
    metadata: { name: 'my-usecase' },
    spec: {
      requires: {
        applications: [
          { name: 'mcp-server-everything', namespace: 'mcp-backend', clusters: [{ name: 'west' }] },
        ],
      },
    },
  };
  const md = adapter._renderCleanupSteps(usecase, options);
  expect(md).toContain(
    'kubectl delete --context $WEST_CONTEXT namespace mcp-backend --ignore-not-found=true'
  );
  expect(md).not.toContain('apiVersion:');
  expect(md).not.toContain('<<');
});

test('UseCaseAdapter._renderCleanupSteps notes when a feature has no generated manifest to reverse', () => {
  const adapter = new UseCaseAdapter();
  const usecase = {
    metadata: { name: 'my-usecase' },
    spec: { features: [{ name: 'some-unbuildable-feature', config: {} }] },
  };
  const md = adapter._renderCleanupSteps(usecase, options);
  expect(md).toContain('No generated manifest for this feature');
});

test('UseCaseAdapter._renderRunStep falls back to yamlDump for unknown actions', () => {
  const adapter = new UseCaseAdapter();
  const md = adapter._renderRunStep({ action: 'mystery-action', foo: 'bar' }, {}, baseUsecase, {
    sentRequestExplained: false,
  });
  expect(md).toContain('```yaml');
  expect(md).toContain('action: mystery-action');
  expect(md).toContain('foo: bar');
});

test('UseCaseAdapter._renderExpectBullets returns empty string for steps with no assertion', () => {
  const adapter = new UseCaseAdapter();
  expect(adapter._renderExpectBullets({ action: 'exec', command: 'true' })).toBe('');
  expect(adapter._renderExpectBullets({ action: 'wait', duration: 100 })).toBe('');
});

test('UseCaseAdapter.generate gives one heading per usecase, with Deploy/test sub-headings nested under it (Cleanup lives in Lab 8)', async () => {
  const adapter = new UseCaseAdapter();
  const md = await adapter.generate(7, { usecases: [baseUsecase] });
  expect(md).toContain('### Lab 7.1 — My Usecase');
  expect(md).not.toContain('Lab 7.2');
  expect(md).toContain('#### Deploy');
  expect(md).toContain('#### Exec and verify resource');
  expect(md).toContain('#### Send request and verify');
  expect(md).not.toContain('Cleanup');

  // Deploy and each test are h4 sub-headings nested inside the one h3 usecase heading
  const usecaseIdx = md.indexOf('### Lab 7.1 — My Usecase');
  const deployIdx = md.indexOf('#### Deploy');
  const test1Idx = md.indexOf('#### Exec and verify resource');
  const test2Idx = md.indexOf('#### Send request and verify');
  expect(usecaseIdx).toBeLessThan(deployIdx);
  expect(deployIdx).toBeLessThan(test1Idx);
  expect(test1Idx).toBeLessThan(test2Idx);
});

test('UseCaseAdapter.generate does not repeat the description or diagram in the Deploy section', async () => {
  const adapter = new UseCaseAdapter();
  const usecase = {
    ...baseUsecase,
    spec: { ...baseUsecase.spec, diagram: 'flowchart LR\n  A --> B' },
  };
  const md = await adapter.generate(7, { usecases: [usecase] });
  expect(md).not.toContain(baseUsecase.metadata.description);
  expect(md).not.toContain('```mermaid');
  expect(md).not.toContain('automated test');
});

test('UseCaseAdapter.generate adds a common-cluster note once, before the first test only', async () => {
  const adapter = new UseCaseAdapter();
  const md = await adapter.generate(7, { usecases: [baseUsecase] });
  const note = 'All tests in this section run against the **east** cluster.';
  const firstIdx = md.indexOf(note);
  const lastIdx = md.lastIndexOf(note);
  expect(firstIdx).toBeGreaterThan(-1);
  expect(firstIdx).toBe(lastIdx);
  expect(md.indexOf('#### Exec and verify resource')).toBeLessThan(firstIdx);
  expect(firstIdx).toBeLessThan(md.indexOf('#### Send request and verify'));
});

test('UseCaseAdapter.generate omits the common-cluster note when tests target different clusters', async () => {
  const adapter = new UseCaseAdapter();
  const usecase = {
    metadata: { name: 'mixed-clusters' },
    spec: {
      tests: [
        {
          name: 'test-a',
          clusters: [{ name: 'east' }],
          steps: [{ action: 'wait', duration: 100 }],
        },
        {
          name: 'test-b',
          clusters: [{ name: 'west' }],
          steps: [{ action: 'wait', duration: 100 }],
        },
      ],
    },
  };
  const md = await adapter.generate(7, { usecases: [usecase] });
  expect(md).not.toContain('All tests in this section run against');
});

test('UseCaseAdapter.generate handles a usecase with no tests (just the Deploy sub-heading)', async () => {
  const adapter = new UseCaseAdapter();
  const usecase = { metadata: { name: 'no-tests' }, spec: {} };
  const md = await adapter.generate(7, { usecases: [usecase] });
  expect(md).toContain('### Lab 7.1 — No Tests');
  expect(md).toContain('#### Deploy');
  expect(md).not.toContain('Lab 7.2');
});

test('UseCaseAdapter.generateCleanupSections produces one heading per usecase at the given startIndex', () => {
  const adapter = new UseCaseAdapter();
  const usecase = {
    metadata: { name: 'my-usecase' },
    spec: { features: [{ name: 'ingress-httproute', config: {}, clusters: [{ name: 'west' }] }] },
  };
  const sections = adapter.generateCleanupSections(8, { usecases: [usecase] }, 1);
  expect(sections).toHaveLength(1);
  expect(sections[0]).toContain('### Lab 8.1 — My Usecase Cleanup');
  expect(sections[0]).not.toContain('bun run src/cli.js usecase clean');
});

test('UseCaseAdapter.generateCleanupSections returns an empty array when no usecases selected', () => {
  const adapter = new UseCaseAdapter();
  const sections = adapter.generateCleanupSections(8, { usecases: [] }, 1);
  expect(sections).toEqual([]);
});

test('UseCaseAdapter.generate returns empty string when no usecases selected', async () => {
  const adapter = new UseCaseAdapter();
  const md = await adapter.generate(7, { usecases: [] });
  expect(md).toBe('');
});
