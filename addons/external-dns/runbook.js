// addons/external-dns/runbook.js

// tpl: return v if it's a real value (not an unresolved {{...}} template), otherwise fb
const tpl = (v, fb) => (v && !/\{\{/.test(v) ? v : fb);

export function envVarsFor(_addonCfg, _clusterName) {
  return [];
}

export function envExportsFor(addonCfg, _profile, env) {
  const cfg = addonCfg.config || {};
  return [
    {
      name: 'EXTERNAL_DNS_VERSION',
      value: addonCfg.version || '1.14.5',
      comment: 'external-dns Helm chart version',
    },
    {
      name: 'DNS_PARENT_DOMAIN',
      value: tpl(cfg.parentDomain, env.spec.dns?.parentZone?.domain) || '<parent-domain>',
      comment: 'Parent DNS zone domain (e.g. your Route53 hosted zone)',
    },
    {
      name: 'DNS_CHILD_ZONE_NAME',
      value: tpl(cfg.childZone, env.spec.dns?.childZone) || '<child-zone>',
      comment: 'Child DNS zone/subdomain name for this environment',
    },
    {
      name: 'EXTERNAL_DNS_DOMAIN_FILTER',
      value: tpl(cfg.domainFilter, null) || '$DNS_CHILD_ZONE_NAME.$DNS_PARENT_DOMAIN',
      comment:
        'Domain filter for external-dns (combines DNS_CHILD_ZONE_NAME and DNS_PARENT_DOMAIN)',
      hideFromTable: true,
    },
    {
      name: 'DNS_HOSTED_ZONE_ID',
      value: tpl(cfg.zoneId, env.spec.dns?.parentZone?.hostedZoneId || '<hosted-zone-id>'),
      comment: 'Route53 hosted zone ID for the parent DNS zone',
      hideFromTable: true,
    },
    {
      name: 'EXTERNAL_DNS_TXT_OWNER_ID',
      value: tpl(cfg.txtOwnerId, env.spec.dns?.txtOwnerId || 'agentic-demo'),
      comment: 'TXT registry owner ID external-dns uses to claim/garbage-collect its records',
    },
  ];
}

export async function generate(_subIndex, addonCfg, clusterName, _profile, _env) {
  const ns = addonCfg.namespace || 'external-dns';
  const cfg = addonCfg.config || {};
  const provider = cfg.provider || 'route53';
  const region = tpl(cfg.region, null) || '$AWS_REGION';
  const domainFilter = tpl(cfg.domainFilter, null) || '$EXTERNAL_DNS_DOMAIN_FILTER';
  const zoneId = tpl(cfg.zoneId, null) || '$DNS_HOSTED_ZONE_ID';
  const txtOwnerId = tpl(cfg.txtOwnerId, null) || '$EXTERNAL_DNS_TXT_OWNER_ID';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;

  // external-dns helm chart uses 'aws' for the Route53 provider (not 'route53')
  const helmProvider = provider === 'route53' ? 'aws' : provider;

  return `Install external-dns on the **${clusterName}** cluster for automatic Route53 DNS record management.

\`\`\`bash
helm repo add external-dns https://kubernetes-sigs.github.io/external-dns/
helm repo update

helm upgrade --install external-dns external-dns/external-dns \\
  --kube-context ${ctx} \\
  --namespace ${ns} \\
  --create-namespace \\
  --version $EXTERNAL_DNS_VERSION \\
  --set provider=${helmProvider} \\
  --set "domainFilters[0]=${domainFilter}" \\
  --set "zoneIdFilters[0]=${zoneId}" \\
  --set aws.region=${region} \\
  --set aws.zoneType=public \\
  --set policy=sync \\
  --set registry=txt \\
  --set txtOwnerId=${txtOwnerId} \\
  --set "sources[0]=service" \\
  --set "sources[1]=ingress" \\
  --set "sources[2]=gateway-httproute" \\
  --set serviceAccount.annotations."eks\\.amazonaws\\.com/role-arn"="<IAM_ROLE_ARN>" \\
  --wait
\`\`\`

> The IAM role must have Route53 write permissions for zone \`${zoneId}\`. \`sources[2]=gateway-httproute\` is required for Ambient mesh Gateway API routes.`;
}

export function cleanup(addonCfg, clusterName) {
  const ns = addonCfg.namespace || 'external-dns';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;
  return `\`\`\`bash
helm uninstall external-dns -n ${ns} --kube-context ${ctx}
\`\`\``;
}
