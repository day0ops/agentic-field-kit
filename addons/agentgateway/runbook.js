// addons/agentgateway/runbook.js

// tpl: return v if it's a real value (not an unresolved {{...}} template), otherwise fb
const tpl = (v, fb) => (v && !/\{\{/.test(v) ? v : fb);

export function envVarsFor(addonCfg, _clusterName) {
  const cfg = addonCfg.config || {};
  if (!cfg.enterprise) return [];
  return [
    {
      name: 'ENTERPRISE_AGENTGATEWAY_LICENSE',
      description: 'Enterprise Agentgateway license key',
      required: true,
    },
  ];
}

export function envExportsFor(addonCfg, _profile, env) {
  const cfg = addonCfg.config || {};
  const version = addonCfg.version || 'v2026.5.1';
  const exports = [
    { name: 'AGENTGATEWAY_VERSION', value: version, comment: 'Agentgateway Enterprise version' },
    {
      name: 'AGENTGATEWAY_NAMESPACE',
      value: addonCfg.namespace || 'agentgateway-system',
      comment: 'Agentgateway namespace',
    },
  ];
  // Hub only: expose the public hostname for the Gateway address
  const isSpoke = cfg.globalGateway === true;
  if (!isSpoke && cfg.gateway?.hostname) {
    const hostname = tpl(cfg.gateway.hostname, env.spec.domains?.app) || '';
    if (hostname) {
      exports.push({
        name: 'AGENTGATEWAY_HOSTNAME',
        value: hostname,
        comment: 'Hub agentgateway public hostname',
      });
    }
  }
  return exports;
}

export async function generate(_subIndex, addonCfg, clusterName, profile, _env) {
  const cfg = addonCfg.config || {};
  const ns = addonCfg.namespace || 'agentgateway-system';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;
  const isSpoke = cfg.globalGateway === true;
  const role = isSpoke ? 'spoke' : 'hub';
  const gateway = cfg.gateway || {};
  const gwName = gateway.name || (isSpoke ? 'spoke-agentgateway-proxy' : 'hub-agentgateway-proxy');
  const gwNs = gateway.namespace || 'agentgateway-proxy';
  const gwHostname = !isSpoke ? tpl(gateway.hostname, null) || '$AGENTGATEWAY_HOSTNAME' : '';
  const gwPort = gateway.port || 80;
  const gwProtocol = gateway.protocol || 'HTTP';
  const gwFrom = gateway.allowedRoutes?.namespaces?.from || 'All';
  const gatewayApiVersion = profile.spec.mesh?.gatewayApiVersion || 'v1.4.0';
  const soloUiNs = cfg.soloUiNamespace || '';
  const gwServiceType = gateway.serviceType || null;
  const additionalHostnames = gateway.additionalHostnames || [];
  const additionalListenersBlock = additionalHostnames
    .map(
      (h, i) => `
    - name: http-alt-${i}
      port: ${gwPort}
      protocol: ${gwProtocol}
      hostname: ${h}
      allowedRoutes:
        namespaces:
          from: ${gwFrom}`
    )
    .join('');
  const publicHttps = gateway.publicHttps?.enabled ? gateway.publicHttps : null;
  const publicHttpsCertName = publicHttps?.certSecretName || `${gwName}-public-tls`;
  const publicHttpsPort = publicHttps?.port || 443;
  const publicHttpsIssuer = publicHttps?.issuer || 'letsencrypt-dns';
  const publicHttpsDnsNames = publicHttps?.dnsNames || (gwHostname ? [gwHostname] : []);

  // Hub listener matches on the public Host header; spoke has no hostname restriction.
  // (Not `spec.addresses` — that declares a pre-existing address for the controller to bind
  // to, which this Gateway controller rejects for Hostname-type entries: "AddressNotUsable".)
  const listenerHostnameEntry = gwHostname && !isSpoke ? `\n      hostname: ${gwHostname}` : '';

  // Gateway infrastructure block (ambient annotation + optional serviceType parametersRef)
  const infraAnnotation = '    annotations:\n      ambient.istio.io/bypass-inbound-capture: "true"';
  let infraBlock = `  infrastructure:\n${infraAnnotation}`;
  if (gwServiceType) {
    infraBlock += `\n    parametersRef:\n      name: ${gwName}-params\n      group: enterpriseagentgateway.solo.io\n      kind: EnterpriseAgentgatewayParameters`;
  }

  // Helm set flags for tracing collector (hub only — hub has tracesCollectorName in profile)
  const tracesCollectorName = cfg.tracesCollectorName || '';
  const tracesCollectorNs = cfg.tracesCollectorNamespace || '';

  // Enterprise chart identifiers
  const crdsRelease = cfg.enterprise ? 'enterprise-agentgateway-crds' : 'agentgateway-crds';
  const mainRelease = cfg.enterprise ? 'enterprise-agentgateway' : 'agentgateway';
  const registry = cfg.enterprise
    ? 'oci://us-docker.pkg.dev/solo-public/enterprise-agentgateway/charts'
    : 'oci://cr.agentgateway.dev/charts';
  const gatewayClassName = cfg.enterprise ? 'enterprise-agentgateway' : 'agentgateway';

  // CRDs chart install (separate step — must precede main chart)
  const crdsHelmCmd = `helm upgrade --install ${crdsRelease} \\\n  ${registry}/${crdsRelease} \\\n  --version $AGENTGATEWAY_VERSION \\\n  --namespace ${ns} \\\n  --create-namespace \\\n  --wait \\\n  --kube-context ${ctx}`;

  // Namespace ambient labeling (when ambient mode enabled)
  const ambientLabelBlock = cfg.ambientEnabled
    ? `

Label the namespace for Ambient mesh:

\`\`\`bash
kubectl create namespace ${ns} --dry-run=client -o yaml \\
  | kubectl apply --context ${ctx} -f -
kubectl label namespace ${ns} istio.io/dataplane-mode=ambient --overwrite \\
  --context ${ctx}
\`\`\``
    : '';

  // Stage 9 (agentgateway interactive elicitation): starts the controller's own
  // token-exchange/elicitation STS. Mirrors buildTokenExchangeHelmArgs() in
  // index.js exactly -- issuer/actorValidators are both undocumented-but-mandatory
  // once enabled (confirmed live: startup otherwise fails with "issuer is required" /
  // "error creating actor validator: at least one validator is required"). apiValidators
  // additionally needs solo-ui's own realm alongside the customer realm -- solo-ui's
  // ui-backend forwards the browser's session JWT (a different realm) when proxying
  // /api/proxy/cluster/<cluster>/gg/* to this same /elicitations endpoint (confirmed
  // live: an untrusted-realm JWT gets a clean 401 there).
  const tokenExchange = cfg.tokenExchange || null;
  const tokenExchangeArgs = tokenExchange
    ? (() => {
        const jwksPath = tokenExchange.jwksPath || '/protocol/openid-connect/certs';
        const validatorFor = issuer => ({
          validatorType: 'remote',
          remoteConfig: { url: `${issuer}${jwksPath}` },
          issuer,
        });
        const subjectValidators = JSON.stringify([validatorFor(tokenExchange.jwtIssuer)]);
        const apiValidators = JSON.stringify([
          validatorFor(tokenExchange.jwtIssuer),
          ...(tokenExchange.additionalApiValidatorIssuers || []).map(validatorFor),
        ]);
        const actorValidators = JSON.stringify([{ validatorType: 'k8s' }]);
        return [
          `  --set tokenExchange.enabled=true`,
          `  --set-string tokenExchange.issuer="${tokenExchange.issuer}"`,
          `  --set-json 'tokenExchange.subjectValidators=${subjectValidators}'`,
          `  --set-json 'tokenExchange.apiValidators=${apiValidators}'`,
          `  --set-json 'tokenExchange.actorValidators=${actorValidators}'`,
        ];
      })()
    : [];

  // Build helm args as an array — prevents blank-line continuation issues
  const helmArgs = [
    `  ${registry}/${mainRelease}`,
    `  --version $AGENTGATEWAY_VERSION`,
    `  --namespace ${ns}`,
    `  --create-namespace`,
    ...(cfg.enterprise
      ? [`  --set-string licensing.licenseKey="$ENTERPRISE_AGENTGATEWAY_LICENSE"`]
      : []),
    // Both default to "" in the chart, breaking waypoint CSR auth and Service-VIP lookup.
    ...(cfg.enterprise && clusterName
      ? [
          `  --set-string istio.clusterId="${clusterName}"`,
          `  --set-string istio.network="${clusterName}"`,
        ]
      : []),
    `  --set ambient.enabled=${cfg.ambientEnabled === true}`,
    `  --set mode=${role}`,
    ...(soloUiNs ? [`  --set soloUi.namespace="${soloUiNs}"`] : []),
    ...(tracesCollectorName && tracesCollectorNs
      ? [
          `  --set tracing.collectorName="${tracesCollectorName}"`,
          `  --set tracing.collectorNamespace="${tracesCollectorNs}"`,
        ]
      : []),
    ...tokenExchangeArgs,
    `  --wait`,
    `  --kube-context ${ctx}`,
  ];
  const helmCmd = `helm upgrade --install ${mainRelease} \\\n${helmArgs
    .map(a => `${a} \\`)
    .join('\n')
    .replace(/ \\$/, '')}`;

  // EnterpriseAgentgatewayParameters for ClusterIP service type
  const paramsBlock = gwServiceType
    ? `
Apply \`EnterpriseAgentgatewayParameters\` for the \`${gwName}\` gateway (service type override):

\`\`\`bash
kubectl apply --context ${ctx} -f - <<EOF
apiVersion: enterpriseagentgateway.solo.io/v1alpha1
kind: EnterpriseAgentgatewayParameters
metadata:
  name: ${gwName}-params
  namespace: ${gwNs}
spec:
  service:
    spec:
      type: ${gwServiceType}
EOF
\`\`\``
    : '';

  // Public HTTPS listener — real cert-manager cert, no client-cert requirement (see the
  // gateway-mtls addon's publicHttps pattern in agentgateway-field-kit, which this mirrors).
  const publicHttpsCertBlock = publicHttps
    ? `
Provision the public HTTPS certificate \`${publicHttpsCertName}\` (issuer: ${publicHttpsIssuer}):

\`\`\`bash
kubectl apply --context ${ctx} -f - <<EOF
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: ${publicHttpsCertName}
  namespace: ${gwNs}
spec:
  secretName: ${publicHttpsCertName}
  issuerRef:
    name: ${publicHttpsIssuer}
    kind: ClusterIssuer
  dnsNames:
${publicHttpsDnsNames.map(n => `    - ${n}`).join('\n')}
EOF
\`\`\``
    : '';
  const publicHttpsListenerBlock = publicHttps
    ? `
    - name: https
      port: ${publicHttpsPort}
      protocol: HTTPS${publicHttpsDnsNames[0] ? `\n      hostname: ${publicHttpsDnsNames[0]}` : ''}
      tls:
        mode: Terminate
        certificateRefs:
          - name: ${publicHttpsCertName}
            kind: Secret
      allowedRoutes:
        namespaces:
          from: ${gwFrom}`
    : '';

  // Telemetry policies — applied only when a local OTel traces collector is configured
  const telemetryPoliciesBlock =
    tracesCollectorName && soloUiNs
      ? `

Apply OTel telemetry policies (tracing + access log) for the \`${gwName}\` gateway:

\`\`\`bash
# Tracing policy — sends spans to the local OTel traces collector
kubectl apply --context ${ctx} -f - <<EOF
apiVersion: enterpriseagentgateway.solo.io/v1alpha1
kind: EnterpriseAgentgatewayPolicy
metadata:
  name: otel-tracing-policy
  namespace: ${gwNs}
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: ${gwName}
  frontend:
    tracing:
      backendRef:
        name: ${tracesCollectorName || 'opentelemetry-collector-traces'}
        namespace: ${tracesCollectorNs || 'telemetry'}
        port: 4317
      protocol: GRPC
      randomSampling: "${cfg.tracingRandomSampling !== false ? 'true' : 'false'}"
      attributes:
        add:
          - name: user.id
            expression: 'coalesce(jwt.sub, request.headers["x-user-id"])'
EOF

# Access log policy — sends access logs with enriched attributes to the local OTel logs collector
kubectl apply --context ${ctx} -f - <<EOF
apiVersion: enterpriseagentgateway.solo.io/v1alpha1
kind: EnterpriseAgentgatewayPolicy
metadata:
  name: otel-access-log-policy
  namespace: ${gwNs}
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: ${gwName}
  frontend:
    accessLog:
      otlp:
        backendRef:
          name: opentelemetry-collector-logs
          namespace: ${tracesCollectorNs || 'telemetry'}
          port: 4317
      attributes:
        add:
          - name: http.user_agent
            expression: 'request.headers["user-agent"]'
          - name: http.method
            expression: request.method
          - name: http.path
            expression: request.path
          - name: http.host
            expression: request.host
          - name: http.status_code
            expression: string(response.code)
          - name: http.scheme
            expression: request.scheme
          - name: request.start_time
            expression: 'default(string(request.startTime), "")'
          - name: request.end_time
            expression: 'default(string(request.endTime), "")'
          - name: source.address
            expression: source.address
          - name: backend.name
            expression: 'default(backend.name, "")'
          - name: llm.input_tokens
            expression: 'default(string(llm.inputTokens), "0")'
          - name: llm.output_tokens
            expression: 'default(string(llm.outputTokens), "0")'
          - name: llm.total_tokens
            expression: 'default(string(llm.totalTokens), "0")'
          - name: llm.request_model
            expression: 'default(llm.requestModel, "")'
          - name: llm.response_model
            expression: 'default(llm.responseModel, "")'
          - name: extproc_metadata
            expression: 'default(toJson(extproc), "{}")'
          - name: mcp.tool.name
            expression: 'default(mcp.tool.name, "")'
          - name: mcp.tool.target
            expression: 'default(mcp.tool.target, "")'
          - name: mcp.prompt.name
            expression: 'default(mcp.prompt.name, "")'
          - name: mcp.prompt.target
            expression: 'default(mcp.prompt.target, "")'
          - name: mcp.resource.name
            expression: 'default(mcp.resource.name, "")'
          - name: mcp.resource.target
            expression: 'default(mcp.resource.target, "")'
EOF
\`\`\``
      : '';

  // Disable Istio mesh tracing in agentgateway namespaces — agentgateway handles its own tracing
  const istioTelemetryBlock = `

Disable Istio mesh tracing in agentgateway namespaces to prevent duplicate spans:

\`\`\`bash
kubectl apply --context ${ctx} -f - <<EOF
apiVersion: telemetry.istio.io/v1
kind: Telemetry
metadata:
  name: disable-mesh-tracing
  namespace: ${ns}
spec:
  tracing:
    - disableSpanReporting: true
EOF

kubectl apply --context ${ctx} -f - <<EOF
apiVersion: telemetry.istio.io/v1
kind: Telemetry
metadata:
  name: disable-mesh-tracing
  namespace: ${gwNs}
spec:
  tracing:
    - disableSpanReporting: true
EOF
\`\`\``;

  // Label spoke gateway as a global service so hub can reach it via mesh.internal
  const globalServiceBlock = isSpoke
    ? `

Label the gateway service as a global service (required for hub→spoke mesh.internal routing):

\`\`\`bash
kubectl label svc ${gwName} -n ${gwNs} solo.io/service-scope=global --overwrite \\
  --context ${ctx}
\`\`\``
    : '';

  return `Install Agentgateway Enterprise **${role}** on the **${clusterName}** cluster.

Install Gateway API CRDs:

\`\`\`bash
kubectl apply --context ${ctx} \\
  -f https://github.com/kubernetes-sigs/gateway-api/releases/download/${gatewayApiVersion}/standard-install.yaml
\`\`\`

Install the agentgateway CRDs chart:

\`\`\`bash
${crdsHelmCmd}
\`\`\`
${ambientLabelBlock}

Install via Helm:

\`\`\`bash
${helmCmd}
\`\`\`

Create the gateway proxy namespace${cfg.ambientEnabled ? ' (labeled for Ambient mesh)' : ''}:

\`\`\`bash
kubectl create namespace ${gwNs} --dry-run=client -o yaml \\
  | kubectl apply --context ${ctx} -f -${
    cfg.ambientEnabled
      ? `\nkubectl label namespace ${gwNs} istio.io/dataplane-mode=ambient --overwrite \\\n  --context ${ctx}`
      : ''
  }
\`\`\`
${paramsBlock}${publicHttpsCertBlock}
\`\`\`bash
kubectl apply --context ${ctx} -f - <<EOF
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: ${gwName}
  namespace: ${gwNs}
spec:
  gatewayClassName: ${gatewayClassName}
  listeners:
    - name: http
      port: ${gwPort}
      protocol: ${gwProtocol}${listenerHostnameEntry}
      allowedRoutes:
        namespaces:
          from: ${gwFrom}${additionalListenersBlock}${publicHttpsListenerBlock}
${infraBlock}
EOF
\`\`\`
${globalServiceBlock}${telemetryPoliciesBlock}${istioTelemetryBlock}`;
}

export function cleanup(addonCfg, clusterName) {
  const cfg = addonCfg.config || {};
  const ns = addonCfg.namespace || 'agentgateway-system';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;
  const mainRelease = cfg.enterprise ? 'enterprise-agentgateway' : 'agentgateway';
  const crdsRelease = cfg.enterprise ? 'enterprise-agentgateway-crds' : 'agentgateway-crds';
  const gateway = cfg.gateway || {};
  const gwName = gateway.name || 'hub-agentgateway-proxy';
  const gwNs = gateway.namespace || 'agentgateway-proxy';
  const publicHttps = gateway.publicHttps?.enabled ? gateway.publicHttps : null;
  const publicHttpsCertName = publicHttps?.certSecretName || `${gwName}-public-tls`;
  const publicHttpsCleanup = publicHttps
    ? `\nkubectl delete certificate ${publicHttpsCertName} -n ${gwNs} --ignore-not-found=true --context ${ctx}\nkubectl delete secret ${publicHttpsCertName} -n ${gwNs} --ignore-not-found=true --context ${ctx}`
    : '';
  return `\`\`\`bash
helm uninstall ${mainRelease} ${crdsRelease} -n ${ns} --kube-context ${ctx}${publicHttpsCleanup}
\`\`\``;
}
