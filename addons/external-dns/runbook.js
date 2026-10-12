// addons/external-dns/runbook.js

// tpl: return v if it's a real value (not an unresolved {{...}} template), otherwise fb
const tpl = (v, fb) => (v && !/\{\{/.test(v) ? v : fb);

/**
 * One-time GCP Cloud DNS + Workload Identity bootstrap, shared by this addon and
 * cert-manager's clouddns solver -- both read the same GSA via config.gcpServiceAccount.
 * Rendered once, before any addon installs (see runbook-adapters/addon.js generatePreambles).
 */
export async function generatePreamble(instances, selection) {
  const googleInstance = instances.find(
    ({ addon }) => (addon.config?.provider || 'route53') === 'google'
  );
  if (!googleInstance) return null;

  const cfg = googleInstance.addon.config || {};
  const dns = selection?.environment?.spec?.dns || {};
  const project = tpl(cfg.project, null) || '$GCP_PROJECT';
  const gsa = tpl(cfg.gcpServiceAccount, null) || 'agentic-dns@<project>.iam.gserviceaccount.com';
  const gsaName = gsa.split('@')[0];
  const managedZone = dns.managedZone || dns.childZone || '<managed-zone-name>';
  const dnsName =
    dns.childZone && dns.parentZone?.domain
      ? `${dns.childZone}.${dns.parentZone.domain}`
      : '<child>.<parent-domain>';

  return `**GCP Cloud DNS + Workload Identity bootstrap** - one-time, per GCP project. Needed before external-dns or cert-manager (clouddns solver) can run; both assume Workload Identity is already enabled on the cluster (see the GKE infra profile).

\`\`\`bash
# 1. Cloud DNS managed zone (skip if it already exists)
gcloud dns managed-zones create ${managedZone} --project=${project} \\
  --dns-name="${dnsName}." --description="agentic substrate demo"
# Then add the NS delegation records for ${dnsName} in the parent zone.

# 2. Service account + dns.admin
gcloud iam service-accounts create ${gsaName} --project=${project} \\
  --display-name="agentic external-dns + cert-manager"
gcloud projects add-iam-policy-binding ${project} \\
  --member="serviceAccount:${gsa}" --role="roles/dns.admin"

# 3. Workload Identity bindings for the external-dns and cert-manager KSAs
for NSSA in external-dns/external-dns cert-manager/cert-manager; do
  NS=\${NSSA%/*}; SA=\${NSSA#*/}
  gcloud iam service-accounts add-iam-policy-binding \\
    ${gsa} \\
    --role=roles/iam.workloadIdentityUser \\
    --member="serviceAccount:${project}.svc.id.goog[$NS/$SA]"
done
\`\`\`

The KSA annotation (\`iam.gke.io/gcp-service-account=${gsa}\`) is set by each addon's own \`gcpServiceAccount\` config below, not by this bootstrap.`;
}

export function envVarsFor(addonCfg, _clusterName) {
  const cfg = addonCfg.config || {};
  if ((cfg.provider || 'route53') === 'google' && !cfg.project) {
    return [
      {
        name: 'GCP_PROJECT',
        description: 'GCP project the Cloud DNS zone lives in',
        required: true,
      },
    ];
  }
  return [];
}

export function envExportsFor(addonCfg, _profile, env) {
  const cfg = addonCfg.config || {};
  return [
    {
      name: 'EXTERNAL_DNS_VERSION',
      value: addonCfg.version || '1.23.0',
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
  const domainFilter = tpl(cfg.domainFilter, null) || '$EXTERNAL_DNS_DOMAIN_FILTER';
  const txtOwnerId = tpl(cfg.txtOwnerId, null) || '$EXTERNAL_DNS_TXT_OWNER_ID';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;

  const commonArgs = `  --set "domainFilters[0]=${domainFilter}" \\
  --set txtOwnerId=${txtOwnerId} \\
  --set policy=sync \\
  --set "sources[0]=service" \\
  --set "sources[1]=ingress" \\
  --set "sources[2]=gateway-httproute"`;

  if (provider === 'google') {
    const project = tpl(cfg.project, null) || '$GCP_PROJECT';
    const gsa = tpl(cfg.gcpServiceAccount, null) || '<gcp-service-account-email>';

    return `Install external-dns on the **${clusterName}** cluster for automatic Google Cloud DNS record management.

\`\`\`bash
helm repo add external-dns https://kubernetes-sigs.github.io/external-dns/
helm repo update

helm upgrade --install external-dns external-dns/external-dns \\
  --kube-context ${ctx} \\
  --namespace ${ns} \\
  --create-namespace \\
  --version $EXTERNAL_DNS_VERSION \\
  --set provider.name=google \\
  --set google.project=${project} \\
${commonArgs} \\
  --set-string serviceAccount.annotations."iam\\.gke\\.io/gcp-service-account"="${gsa}" \\
  --wait
\`\`\`

> \`${gsa}\` must be bound to \`roles/dns.admin\` and to the external-dns Kubernetes ServiceAccount via Workload Identity (\`gcloud iam service-accounts add-iam-policy-binding ... --role=roles/iam.workloadIdentityUser --member="serviceAccount:${project}.svc.id.goog[${ns}/external-dns]"\`). No key file -- ADC via the annotated ServiceAccount. \`sources[2]=gateway-httproute\` is required for Ambient mesh Gateway API routes.`;
  }

  const region = tpl(cfg.region, null) || '$AWS_REGION';
  const zoneId = tpl(cfg.zoneId, null) || '$DNS_HOSTED_ZONE_ID';

  return `Install external-dns on the **${clusterName}** cluster for automatic Route53 DNS record management.

\`\`\`bash
helm repo add external-dns https://kubernetes-sigs.github.io/external-dns/
helm repo update

helm upgrade --install external-dns external-dns/external-dns \\
  --kube-context ${ctx} \\
  --namespace ${ns} \\
  --create-namespace \\
  --version $EXTERNAL_DNS_VERSION \\
  --set provider.name=aws \\
  --set "env[0].name=AWS_DEFAULT_REGION" \\
  --set "env[0].value=${region}" \\
${commonArgs} \\
  --set "extraArgs[0]=--aws-zone-type=public" \\
  --set "extraArgs[1]=--zone-id-filter=${zoneId}" \\
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
