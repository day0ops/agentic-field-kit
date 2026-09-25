// src/lib/runbook-adapters/template-vars.js
import { TemplateResolver } from '../template-resolver.js';

// env.spec path -> the env var already exported for it (see addons/*/runbook.js,
// src/lib/runbook-adapters/{env,infra}.js). Substituting these keeps generated commands
// portable across environments; every other {{env.*}}/{{cluster.*}} template resolves to
// its real configured value (e.g. an internal mesh.internal DNS name), since there is no
// dedicated env var for it.
const ENV_VAR_PATHS = {
  'domains.app.main': 'AGENTGATEWAY_HOSTNAME',
  'domains.core.grafana': 'GRAFANA_HOSTNAME',
  'domains.core.keycloak': 'KEYCLOAK_HOSTNAME',
  'domains.core.soloUi': 'SOLO_UI_HOSTNAME',
  'domains.core.agentregistryUi': 'AGENTREGISTRY_HOSTNAME',
  'aws.region': 'AWS_REGION',
  'acme.email': 'ACME_EMAIL',
  'dns.parentZone.hostedZoneId': 'DNS_HOSTED_ZONE_ID',
  'dns.parentZone.domain': 'DNS_PARENT_DOMAIN',
  'dns.childZone': 'DNS_CHILD_ZONE_NAME',
};

/**
 * Resolve every {{env.*}} / {{cluster.name}} template in a profile/usecase config
 * fragment, the same way the real installer does via TemplateResolver — except paths
 * with a known exported env var resolve to a "$VAR" reference instead of the literal
 * value, so the generated runbook is portable across environments.
 */
export function resolveRunbookTemplates(obj, { env, clusterName } = {}) {
  if (!obj) return obj;
  const context = TemplateResolver.buildContext({ name: clusterName || '' }, env);
  context.env = _applyVarOverrides(context.env);
  return TemplateResolver.resolveValues(obj, context);
}

// Force each known path to its "$VAR" reference, creating intermediate objects as needed —
// applies regardless of whether the loaded environment actually has that section, so the
// override always wins over a real value.
function _applyVarOverrides(envSpec) {
  const result = envSpec ? JSON.parse(JSON.stringify(envSpec)) : {};
  for (const [path, varName] of Object.entries(ENV_VAR_PATHS)) {
    const parts = path.split('.');
    const last = parts.pop();
    let node = result;
    for (const part of parts) {
      if (node[part] === undefined || node[part] === null || typeof node[part] !== 'object') {
        node[part] = {};
      }
      node = node[part];
    }
    node[last] = `$${varName}`;
  }
  return result;
}
