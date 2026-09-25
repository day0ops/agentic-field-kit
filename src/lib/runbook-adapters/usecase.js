// src/lib/runbook-adapters/usecase.js
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { dump as yamlDump } from 'js-yaml';
import { AgentgatewayBackendFeature } from '../../../features/traffic-management/agentgateway-backend/index.js';
import { IngressHttpRouteFeature } from '../../../features/traffic-management/ingress-httproute/index.js';
import { UseCaseTestRunner } from '../usecase-tests.js';
import { resolveRunbookTemplates } from './template-vars.js';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const FEATURE_BUILDERS = {
  'agentgateway-backend': AgentgatewayBackendFeature,
  'ingress-httproute': IngressHttpRouteFeature,
};

export class UseCaseAdapter {
  envVars(_selection) {
    return [];
  }
  envExports(_selection) {
    return [];
  }

  async generate(labNum, selection) {
    const { usecases = [] } = selection;
    if (usecases.length === 0) return '';

    const options = _runbookOptions(selection);
    const usecaseBlocks = [];
    let subIndex = 1;

    for (const usecase of usecases) {
      const heading = `### Lab ${labNum}.${subIndex} — ${usecaseName(usecase)}`;
      subIndex++;

      const sections = [`#### Deploy\n\n${this._renderDeploy(usecase, options)}`];

      const tests = (usecase.spec?.tests || []).map(t =>
        resolveRunbookTemplates(t, { env: options.env })
      );
      const commonNote = _commonClusterNote(tests);
      tests.forEach((test, i) => {
        const content = this._renderSingleTest(test, usecase, i === 0 ? commonNote : '');
        sections.push(`#### ${_testSentence(test)}\n\n${content}`);
      });

      usecaseBlocks.push(`${heading}\n\n${sections.join('\n\n')}`);
    }

    return `## Lab ${labNum} — Use Cases\n\n${usecaseBlocks.join('\n\n---\n\n')}`;
  }

  generateCleanupSections(labNum, selection, startIndex) {
    const { usecases = [] } = selection;
    if (usecases.length === 0) return [];

    const options = _runbookOptions(selection);
    return usecases.map((usecase, i) => {
      const heading = `### Lab ${labNum}.${startIndex + i} — ${usecaseName(usecase)} Cleanup`;
      return `${heading}\n\n${this._renderCleanupSteps(usecase, options)}`;
    });
  }

  _renderDeploy(usecase, options) {
    const lines = [];

    const apps = usecase.spec.requires?.applications || [];
    if (apps.length) {
      lines.push('<div class="test-card">');
      lines.push('');
      lines.push('<div class="test-section-label">Prerequisites</div>');
      lines.push('');
      for (const app of apps) {
        const appPath = join(PROJECT_ROOT, 'extras', 'applications', app.name, `${app.name}.yaml`);
        let appYaml;
        try {
          appYaml = readFileSync(appPath, 'utf8').trim();
        } catch {
          appYaml = `# ${app.name} manifest not found at ${appPath}`;
        }
        lines.push(`**${app.name}**`);
        lines.push('');
        const clusterNames = (app.clusters || []).map(c => c.name);
        const targets = clusterNames.length ? clusterNames : [null];
        for (const clusterName of targets) {
          const ctxFlag = clusterName ? `--context $${clusterName.toUpperCase()}_CONTEXT ` : '';
          if (clusterName) lines.push(`Apply on **${clusterName}** cluster:`);
          lines.push('```bash');
          lines.push(`kubectl apply ${ctxFlag}-f - <<'EOF'`);
          lines.push(appYaml);
          lines.push('EOF');
          lines.push('```');
          lines.push('');
        }
      }
      lines.push('</div>');
      lines.push('');
    }

    if (usecase.spec.features?.length) {
      lines.push('<div class="test-card">');
      lines.push('');
      lines.push('<div class="test-section-label">Steps</div>');
      lines.push('');
      for (const feature of usecase.spec.features) {
        const clusterNames = (feature.clusters || []).map(c => c.name);
        const FeatureClass = FEATURE_BUILDERS[feature.name];

        lines.push(`**${feature.description || feature.name}**`);
        lines.push('');

        if (FeatureClass?.buildRunbook) {
          const resources = FeatureClass.buildRunbook(
            resolveRunbookTemplates(feature.config, { env: options.env }),
            options
          );
          const targets = clusterNames.length ? clusterNames : [null];
          for (const clusterName of targets) {
            const ctxFlag = clusterName ? `--context $${clusterName.toUpperCase()}_CONTEXT ` : '';
            if (clusterName) lines.push(`Apply on **${clusterName}** cluster:`);
            lines.push('```bash');
            lines.push(`kubectl apply ${ctxFlag}-f - <<EOF`);
            for (const resource of resources) {
              lines.push(yamlDump(resource, { lineWidth: -1, indent: 2 }).trimEnd());
            }
            lines.push('EOF');
            lines.push('```');
            lines.push('');
          }
        } else if (feature.config && Object.keys(feature.config).length > 0) {
          lines.push('```yaml');
          lines.push(
            yamlDump(resolveRunbookTemplates(feature.config, { env: options.env })).trim()
          );
          lines.push('```');
          lines.push('');
        }
      }
      lines.push('</div>');
      lines.push('');
    }

    return lines.join('\n').trimEnd();
  }

  _renderSingleTest(test, usecase, leadingNote) {
    const lines = [];

    if (leadingNote) {
      lines.push(leadingNote);
      lines.push('');
    }

    const state = { sentRequestExplained: false };
    const runLines = [];
    const expectLines = [];

    if (test.setup?.length) {
      runLines.push('_Setup:_');
      runLines.push('');
      for (const step of test.setup) {
        runLines.push(this._renderRunStep(step, test, usecase, state));
      }
    }

    for (const step of test.steps || []) {
      // 'verify' only asserts on the prior step's response (no command of its own);
      // 'verify-resource' both runs a kubectl check and asserts its result, so it
      // contributes to both Run and Expect.
      if (step.action !== 'verify') {
        const run = this._renderRunStep(step, test, usecase, state);
        if (run.trim()) runLines.push(run);
      }
      const bullets = this._renderExpectBullets(step);
      if (bullets) expectLines.push(bullets);
    }

    if (test.teardown?.length) {
      runLines.push('_Teardown:_');
      runLines.push('');
      for (const step of test.teardown) {
        runLines.push(this._renderRunStep(step, test, usecase, state));
      }
    }

    lines.push('<div class="test-card">');
    lines.push('');

    if (test.description) {
      lines.push('<div class="test-section-label">Goal</div>');
      lines.push('');
      lines.push(test.description);
      lines.push('');
    }

    if (runLines.some(l => l.trim())) {
      lines.push('<div class="test-section-label">Run</div>');
      lines.push('');
      lines.push(runLines.join('\n').trim());
      lines.push('');
    }

    if (expectLines.length) {
      lines.push('<div class="test-section-label">Expect</div>');
      lines.push('');
      lines.push(expectLines.join('\n').trim());
      lines.push('');
    }

    lines.push('</div>');

    return lines.join('\n').trimEnd();
  }

  // Commands to run for a step — everything except pure assertions (see _renderExpectBullets).
  _renderRunStep(step, test, usecase, state) {
    const lines = [];
    const trailer = _stepTrailerComment(step);

    switch (step.action) {
      case 'exec': {
        const command = step.command || step.cmd || '';
        const clusterName = _stepClusterName(step, test, usecase);
        const ctxFlag = clusterName ? `--context $${clusterName.toUpperCase()}_CONTEXT ` : '';
        const finalCmd =
          clusterName && command.startsWith('kubectl ') && !command.includes('--context')
            ? command.replace('kubectl ', `kubectl ${ctxFlag}`)
            : command;
        lines.push('```bash');
        lines.push(finalCmd + (trailer ? `  ${trailer}` : ''));
        lines.push('```');
        lines.push('');
        break;
      }

      case 'send-request': {
        if (!state.sentRequestExplained) {
          lines.push(
            '_`$GATEWAY_ADDRESS` is auto-detected from the Gateway resource at test runtime; substitute the actual address when running manually._'
          );
          lines.push('');
          state.sentRequestExplained = true;
        }
        const method = (step.method || 'GET').toUpperCase();
        const url = `http://$GATEWAY_ADDRESS${step.path || '/'}`;
        const parts = ['curl', '-X', method, url];
        if (step.hostname) parts.push('-H', `"Host: ${step.hostname}"`);
        for (const [k, v] of Object.entries(step.headers || {})) {
          parts.push('-H', `"${k}: ${v}"`);
        }
        if (step.body) {
          const bodyStr = typeof step.body === 'string' ? step.body : JSON.stringify(step.body);
          parts.push('-d', `'${bodyStr}'`);
        }
        lines.push('```bash');
        lines.push(parts.join(' ') + (trailer ? `  ${trailer}` : ''));
        lines.push('```');
        lines.push('');
        break;
      }

      case 'check-public-endpoint': {
        const protocol = step.protocol || 'https';
        const url = `${protocol}://${step.hostname}${step.path || '/'}`;
        lines.push(
          '_Waits indefinitely for DNS to resolve and the endpoint to respond -- child-zone propagation can lag well past a fixed retry budget._'
        );
        lines.push('');
        lines.push('```bash');
        lines.push(`curl -sI ${url}` + (trailer ? `  ${trailer}` : ''));
        lines.push('```');
        lines.push('');
        break;
      }

      case 'verify-resource': {
        const { kind, name, namespace = 'default', expect: resExpect = [] } = step;
        const clusterName = _stepClusterName(step, test, usecase);
        const ctxFlag = clusterName ? `--context $${clusterName.toUpperCase()}_CONTEXT ` : '';
        for (const check of resExpect) {
          lines.push('```bash');
          lines.push(
            `kubectl ${ctxFlag}get ${kind} ${name} -n ${namespace} -o jsonpath='${check.jsonpath}'`
          );
          lines.push('```');
          lines.push('');
        }
        break;
      }

      case 'wait': {
        const duration = step.duration || 1000;
        lines.push(`_Wait ${duration}ms before continuing._`);
        lines.push('');
        break;
      }

      case 'istioctl-zc-endpoints': {
        const clusterName = _stepClusterName(step, test, usecase);
        const ctxFlag = clusterName ? ` --context $${clusterName.toUpperCase()}_CONTEXT` : '';
        const namespace = step.serviceNamespace || step.namespace;
        lines.push('```bash');
        lines.push(
          `istioctl zc endpoints --service ${step.service} --service-namespace ${namespace}${ctxFlag}` +
            (trailer ? `  ${trailer}` : '')
        );
        lines.push('```');
        lines.push('');
        break;
      }

      case 'verify':
        break;

      default: {
        lines.push('```yaml');
        lines.push(yamlDump(step, { lineWidth: -1 }).trim());
        lines.push('```');
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  // The expected outcome for a step — a bullet list, or '' if this step has no assertion.
  _renderExpectBullets(step) {
    if (step.action === 'verify') {
      const expect = step.expect || {};
      const bullets = [];
      if (expect.statusCode !== undefined) bullets.push(`Status code is \`${expect.statusCode}\``);
      if (expect.status !== undefined) bullets.push(`Status is \`${expect.status}\``);
      if (expect.contains !== undefined) {
        for (const item of Array.isArray(expect.contains) ? expect.contains : [expect.contains]) {
          bullets.push(`Response contains \`${item}\``);
        }
      }
      if (expect.notContains !== undefined) {
        for (const item of Array.isArray(expect.notContains)
          ? expect.notContains
          : [expect.notContains]) {
          bullets.push(`Response does not contain \`${item}\``);
        }
      }
      if (expect.exitCode !== undefined) bullets.push(`Exit code is \`${expect.exitCode}\``);
      if (expect.headers) {
        for (const [k, v] of Object.entries(expect.headers)) {
          bullets.push(`Header \`${k}\` is \`${v}\``);
        }
      }
      return bullets.map(b => `- ${b}`).join('\n');
    }

    if (step.action === 'verify-resource') {
      const { kind, name, namespace = 'default', expect: resExpect = [] } = step;
      return resExpect
        .map(
          check =>
            `- \`${kind}/${name}\` (\`${namespace}\`) at \`${check.jsonpath}\` is \`${check.value}\``
        )
        .join('\n');
    }

    return '';
  }

  _renderCleanupSteps(usecase, options) {
    const lines = [];

    const features = usecase.spec.features || [];
    if (features.length) {
      lines.push('#### Delete Features');
      lines.push('');
      lines.push('<div class="test-card">');
      lines.push('');
      lines.push('<div class="test-section-label">Reverse order of creation</div>');
      lines.push('');
      for (const feature of [...features].reverse()) {
        const clusterNames = (feature.clusters || []).map(c => c.name);
        const FeatureClass = FEATURE_BUILDERS[feature.name];

        lines.push(`**${feature.description || feature.name}**`);
        lines.push('');

        if (FeatureClass?.buildRunbook) {
          const resources = FeatureClass.buildRunbook(
            resolveRunbookTemplates(feature.config, { env: options.env }),
            options
          );
          const targets = clusterNames.length ? clusterNames : [null];
          const cmds = [];
          for (const clusterName of targets) {
            const ctxFlag = clusterName ? `--context $${clusterName.toUpperCase()}_CONTEXT ` : '';
            for (const resource of resources) {
              const kind = (resource.kind || '').toLowerCase();
              const name = resource.metadata?.name;
              const nsFlag = resource.metadata?.namespace
                ? `-n ${resource.metadata.namespace} `
                : '';
              cmds.push(
                `kubectl delete ${ctxFlag}${kind} ${name} ${nsFlag}--ignore-not-found=true`
              );
            }
          }
          lines.push('```bash');
          lines.push(cmds.join('\n'));
          lines.push('```');
          lines.push('');
        } else {
          lines.push('_No generated manifest for this feature — remove it manually if needed._');
          lines.push('');
        }
      }
      lines.push('</div>');
      lines.push('');
    }

    const apps = usecase.spec.requires?.applications || [];
    if (apps.length) {
      lines.push('#### Delete Prerequisite Applications');
      lines.push('');
      lines.push('<div class="test-card">');
      lines.push('');
      for (const app of [...apps].reverse()) {
        lines.push(`**${app.name}**`);
        lines.push('');

        // Mirrors UseCaseManager.cleanup(): when the usecase pins an explicit namespace for
        // this application, deleting that namespace alone is enough (and is what actually runs).
        if (app.namespace) {
          const clusterNames = (app.clusters || []).map(c => c.name);
          const targets = clusterNames.length ? clusterNames : [null];
          const cmds = targets.map(clusterName => {
            const ctxFlag = clusterName ? `--context $${clusterName.toUpperCase()}_CONTEXT ` : '';
            return `kubectl delete ${ctxFlag}namespace ${app.namespace} --ignore-not-found=true`;
          });
          lines.push('```bash');
          lines.push(cmds.join('\n'));
          lines.push('```');
          lines.push('');
          continue;
        }

        const appPath = join(PROJECT_ROOT, 'extras', 'applications', app.name, `${app.name}.yaml`);
        let appYaml;
        try {
          appYaml = readFileSync(appPath, 'utf8').trim();
        } catch {
          appYaml = `# ${app.name} manifest not found at ${appPath}`;
        }
        const clusterNames = (app.clusters || []).map(c => c.name);
        const targets = clusterNames.length ? clusterNames : [null];
        for (const clusterName of targets) {
          const ctxFlag = clusterName ? `--context $${clusterName.toUpperCase()}_CONTEXT ` : '';
          if (clusterName) lines.push(`Delete on **${clusterName}** cluster:`);
          lines.push('```bash');
          lines.push(`kubectl delete ${ctxFlag}--ignore-not-found=true -f - <<'EOF'`);
          lines.push(appYaml);
          lines.push('EOF');
          lines.push('```');
          lines.push('');
        }
      }
      lines.push('</div>');
    }

    return lines.join('\n').trimEnd();
  }

  cleanup(_selection) {
    return '';
  }
}

export function usecaseTitle(usecase) {
  return usecase.metadata.description
    ? usecase.metadata.description.split('\n')[0].trim().replace(/\.$/, '')
    : usecaseName(usecase);
}

export function usecaseName(usecase) {
  return usecase.metadata.name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function _testSentence(test) {
  const humanized = (test.name || 'unnamed test').replace(/-/g, ' ');
  return humanized.charAt(0).toUpperCase() + humanized.slice(1);
}

function _commonClusterNote(tests) {
  if (tests.length < 2) return '';
  const clusterKeys = tests.map(t => (t.clusters || []).map(c => c.name).join(','));
  if (!clusterKeys[0] || !clusterKeys.every(k => k === clusterKeys[0])) return '';

  const names = tests[0].clusters.map(c => c.name);
  const label =
    names.length === 1
      ? `the **${names[0]}** cluster`
      : `clusters ${names.map(n => `**${n}**`).join(', ')}`;
  return `_All tests in this section run against ${label}._`;
}

function _runbookOptions(selection) {
  const profile = selection.profile || {};
  const allAddons = [
    ...(profile.spec?.addons?.global || []),
    ...(profile.spec?.addons?.clusters || []).flatMap(c => c.addons || []),
  ];
  const agwAddon = allAddons.find(a => (typeof a === 'string' ? a : a.name) === 'agentgateway');
  const enterprise =
    agwAddon && typeof agwAddon !== 'string' && agwAddon.config?.enterprise === true;
  return { enterprise, env: selection.environment };
}

function _stepClusterName(step, test, usecase) {
  const clusters = step.clusters || test.clusters || usecase.spec.clusters;
  return clusters?.[0]?.name || null;
}

function _stepTrailerComment(step) {
  const parts = [];
  if (step.retries !== undefined) parts.push(`retries: ${step.retries}`);
  if (step.retryDelay !== undefined) {
    parts.push(`retryDelay: ${UseCaseTestRunner.parseTimeoutSecs(step.retryDelay)}s`);
  }
  if (step.timeout !== undefined) {
    parts.push(`timeout: ${UseCaseTestRunner.parseTimeoutSecs(step.timeout)}s`);
  }
  return parts.length ? `# ${parts.join(', ')}` : '';
}
