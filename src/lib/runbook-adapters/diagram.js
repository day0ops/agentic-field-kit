// src/lib/runbook-adapters/diagram.js

export class DiagramAdapter {
  envVars(_selection) {
    return [];
  }
  envExports(_selection) {
    return [];
  }

  generate(labNum, selection) {
    const { profile, infraProfile } = selection;
    const diagram1 = this._topologyDiagram(profile, infraProfile);
    const descriptions = this._descriptions(profile, infraProfile);

    return `## Lab ${labNum} — Architecture Overview

### Cluster Topology

\`\`\`mermaid
${diagram1}
\`\`\`

### Component Descriptions

${descriptions}`;
  }

  _topologyDiagram(profile, infraProfile) {
    const globalAddons = profile.spec.addons?.global || [];
    const clusterAddonDefs = profile.spec.addons?.clusters || [];
    const lines = [`graph TD`];

    // Global addons node
    if (globalAddons.length > 0) {
      const label = globalAddons.map(a => a.name).join(' · ');
      lines.push(`  GLOBAL["Global addons<br>${label}"]`);
    }

    // Cluster subgraphs
    for (const cluster of infraProfile.spec.clusters || []) {
      const clusterDef = clusterAddonDefs.find(c => c.name === cluster.name);
      const addons = clusterDef?.addons || [];
      lines.push(`  subgraph ${cluster.name.toUpperCase()}["${cluster.name} cluster"]`);
      for (const addon of addons) {
        const nodeId = `${cluster.name.toUpperCase()}_${addon.name.replace(/-/g, '_').toUpperCase()}`;
        const desc = addon.description ? `<br>${_truncateAtWord(addon.description, 50)}` : '';
        lines.push(`    ${nodeId}["${addon.name}${desc}"]`);
      }
      lines.push(`  end`);
    }

    // Global → each cluster
    if (globalAddons.length > 0) {
      for (const cluster of infraProfile.spec.clusters || []) {
        lines.push(`  GLOBAL --> ${cluster.name.toUpperCase()}`);
      }
    }

    return lines.join('\n');
  }

  _interactionDiagram(profile, _infraProfile) {
    const clusterAddonDefs = profile.spec.addons?.clusters || [];
    const lines = [`graph LR`];

    // Identify hub/spoke agentgateway clusters
    let hubCluster = null;
    let spokeCluster = null;
    let hubHasAR = false;
    let hasKeycloak = false;

    for (const clusterDef of clusterAddonDefs) {
      const agw = clusterDef.addons?.find(a => a.name === 'agentgateway');
      if (agw && !agw.config?.globalGateway) hubCluster = clusterDef.name;
      if (agw && agw.config?.globalGateway === true) spokeCluster = clusterDef.name;
      if (clusterDef.addons?.some(a => a.name === 'agentregistry')) hubHasAR = true;
      if (clusterDef.addons?.some(a => a.name === 'keycloak')) hasKeycloak = true;
    }

    // AGW hub
    if (hubCluster) {
      lines.push(`  Client -->|HTTP| AGW_H["agentgateway hub\\n(${hubCluster})"]`);
      if (spokeCluster) {
        lines.push(
          `  AGW_H -->|"ambient mesh\\nztunnel L4/L7"| AGW_S["agentgateway spoke\\n(${spokeCluster})"]`
        );
      }
      if (hasKeycloak) {
        lines.push(`  AGW_H -->|OIDC| KC["keycloak\\n(${hubCluster})"]`);
      }
      if (hubHasAR) {
        lines.push(`  AGW_H -->|"MCP registry"| AR["agentregistry\\n(${hubCluster})"]`);
      }
    }

    // Solo-UI relay → mgmt
    let soloUiMgmtCluster = null;
    let soloUiRelayCluster = null;
    for (const clusterDef of clusterAddonDefs) {
      const sui = clusterDef.addons?.find(a => a.name === 'solo-ui');
      if (sui?.mode === 'management') soloUiMgmtCluster = clusterDef.name;
      if (sui?.mode === 'relay') soloUiRelayCluster = clusterDef.name;
    }
    if (soloUiMgmtCluster && soloUiRelayCluster) {
      lines.push(
        `  SUI_M["solo-ui mgmt\\n(${soloUiMgmtCluster})"] -->|"relay tunnel\\nmesh.internal"| SUI_R["solo-ui relay\\n(${soloUiRelayCluster})"]`
      );
    }

    // Telemetry agent → gateway
    let telGatewayCluster = null;
    let telAgentCluster = null;
    for (const clusterDef of clusterAddonDefs) {
      const tel = clusterDef.addons?.find(a => a.name === 'telemetry');
      if (tel && !tel.config?.mode) telGatewayCluster = clusterDef.name;
      if (tel?.config?.mode === 'agent') telAgentCluster = clusterDef.name;
    }
    if (telGatewayCluster && telAgentCluster) {
      lines.push(
        `  TEL_A["telemetry agent\\n(${telAgentCluster})"] -->|"OTLP\\nmesh.internal"| TEL_G["telemetry gateway\\n(${telGatewayCluster})"]`
      );
    }

    return lines.join('\n');
  }

  _descriptions(profile, _infraProfile) {
    const globalAddons = profile.spec.addons?.global || [];
    const clusterAddonDefs = profile.spec.addons?.clusters || [];
    const cards = [];

    for (const addon of globalAddons) {
      if (addon.description) cards.push(_componentCard(addon.name, 'global', addon.description));
    }
    for (const clusterDef of clusterAddonDefs) {
      for (const addon of clusterDef.addons || []) {
        if (addon.description) {
          cards.push(_componentCard(addon.name, clusterDef.name, addon.description));
        }
      }
    }

    if (!cards.length) return '';
    return `<div class="component-grid">\n${cards.join('\n')}\n</div>`;
  }

  cleanup(_selection) {
    return '';
  }
}

function _truncateAtWord(text, maxLen) {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function _componentCard(name, scope, description) {
  return (
    '<div class="component-card">' +
    '<div class="component-card-head">' +
    `<span class="component-name">${_escapeHtml(name)}</span>` +
    `<span class="component-scope">${_escapeHtml(scope)}</span>` +
    '</div>' +
    `<p class="component-desc">${_escapeHtml(description)}</p>` +
    '</div>'
  );
}

function _escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
