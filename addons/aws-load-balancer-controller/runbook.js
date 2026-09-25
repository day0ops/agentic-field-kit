// addons/aws-load-balancer-controller/runbook.js

// tpl: return v if it's a real value (not an unresolved {{...}} template), otherwise fb
const tpl = (v, fb) => (v && !/\{\{/.test(v) ? v : fb);

export function envVarsFor(_addonCfg, _clusterName) {
  return [];
}

export function envExportsFor(addonCfg, _profile, _env) {
  return [
    {
      name: 'AWS_LOAD_BALANCER_CONTROLLER_VERSION',
      value: addonCfg.version || '3.5.0',
      comment: 'aws-load-balancer-controller chart version',
    },
  ];
}

export async function generate(_subIndex, addonCfg, clusterName, _profile, _env) {
  const ns = addonCfg.namespace || 'kube-system';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;
  const config = addonCfg.config || {};

  const clusterNameValue = tpl(config.clusterName, '<eks-cluster-name>');
  const roleArn = tpl(config.serviceAccountRoleArn, '<alb-controller-irsa-role-arn>');
  const vpcId = tpl(config.vpcId, null);

  const vpcIdFlag = vpcId
    ? ` \\
  --set vpcId=${vpcId}`
    : '';

  return `Install the AWS Load Balancer Controller on the **${clusterName}** cluster.

\`\`\`bash
helm repo add eks https://aws.github.io/eks-charts
helm repo update

helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller \\
  --kube-context ${ctx} \\
  --namespace ${ns} \\
  --version $AWS_LOAD_BALANCER_CONTROLLER_VERSION \\
  --set clusterName=${clusterNameValue} \\
  --set serviceAccount.annotations."eks\\.amazonaws\\.com/role-arn"=${roleArn}${vpcIdFlag} \\
  --wait
\`\`\``;
}

export function cleanup(addonCfg, clusterName) {
  const ns = addonCfg.namespace || 'kube-system';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;
  return `\`\`\`bash
helm uninstall aws-load-balancer-controller -n ${ns} --kube-context ${ctx}
\`\`\``;
}
