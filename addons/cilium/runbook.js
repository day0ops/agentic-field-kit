// addons/cilium/runbook.js

export function envVarsFor(_addonCfg, _clusterName) {
  return [];
}

export function envExportsFor(addonCfg, _profile, _env) {
  return [
    { name: 'CILIUM_VERSION', value: addonCfg.version || '1.19.4', comment: 'Cilium CNI version' },
  ];
}

export async function generate(_subIndex, addonCfg, clusterName, _profile, _env) {
  const addon =
    addonCfg?.config && typeof addonCfg.config === 'object'
      ? { ...addonCfg, ...addonCfg.config }
      : addonCfg;
  const mode = addon.mode || 'chaining';
  const chainingTarget = addon.chainingTarget || 'aws-cni';
  const healthProbe = addon.enableHealthProbePolicy ? '\n  --set healthChecking=true \\' : '';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;

  return `Install Cilium as eBPF-based CNI in ${mode} mode on the **${clusterName}** cluster.

\`\`\`bash
helm repo add cilium https://helm.cilium.io/
helm repo update

helm upgrade --install cilium cilium/cilium \\
  --kube-context ${ctx} \\
  --version $CILIUM_VERSION \\
  --namespace kube-system \\
  --set cni.chainingMode=${chainingTarget} \\
  --set cni.exclusive=false \\
  --set enableIPv4Masquerade=false \\
  --set routingMode=native \\
  --set hostLegacyRouting=true \\
  --set envoy.enabled=false \\${healthProbe}
  --wait
\`\`\`

> \`envoy.enabled=false\` disables Cilium's own Envoy DaemonSet — L7 is handled by Istio Ambient waypoints, so it isn't needed here.`;
}

export function cleanup(_addonCfg, clusterName) {
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;
  return `\`\`\`bash
helm uninstall cilium -n kube-system --kube-context ${ctx}
\`\`\``;
}
