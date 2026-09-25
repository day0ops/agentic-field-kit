// src/lib/runbook-adapters/env.js

const CATEGORY_RULES = [
  { name: 'Licenses', pattern: /LICENSE/ },
  { name: 'Credentials', pattern: /PASSWORD|USERNAME|_USER$|PROFILE/ },
  { name: 'Hostnames & Domains', pattern: /HOSTNAME|DOMAIN/ },
  { name: 'Namespaces', pattern: /NAMESPACE/ },
  { name: 'Versions', pattern: /VERSION/ },
];
const CATEGORY_ORDER = [...CATEGORY_RULES.map(r => r.name), 'Other'];

function _categorize(name) {
  const rule = CATEGORY_RULES.find(r => r.pattern.test(name));
  return rule ? rule.name : 'Other';
}

function _varsTable(vars) {
  return [
    '| Variable | Value | Description |',
    '|----------|-------|-------------|',
    ...vars.map(
      v => `| \`${v.name}\` | ${v.value != null ? `\`${v.value}\`` : ''} | ${v.description} |`
    ),
  ].join('\n');
}

export class EnvAdapter {
  envVars(_selection) {
    return [];
  }

  envExports(_selection) {
    return [];
  }

  // Note: special signature — receives consolidated vars from RunbookBuilder
  generate(labNum, selection, consolidatedVars = [], consolidatedExports = []) {
    // Merge: user-supplied vars first, then computed exports not already listed.
    // Exports marked hideFromTable are fully computed from profile/environment config
    // (nothing for the user to decide) — they still appear in the export block below,
    // just not as a row in the "what do I need to set" table.
    const varNames = new Set(consolidatedVars.map(v => v.name));
    const allTableVars = [
      ...consolidatedVars,
      ...consolidatedExports
        .filter(e => !varNames.has(e.name) && !e.hideFromTable)
        .map(e => ({
          name: e.name,
          value: e.value,
          description: e.comment || '',
          required: false,
        })),
    ];

    const grouped = new Map();
    for (const v of allTableVars) {
      const category = _categorize(v.name);
      if (!grouped.has(category)) grouped.set(category, []);
      grouped.get(category).push(v);
    }

    const table = CATEGORY_ORDER.filter(category => grouped.has(category))
      .map(category => {
        const vars = [...grouped.get(category)].sort((a, b) => a.name.localeCompare(b.name));
        return `#### ${category}\n\n${_varsTable(vars)}`;
      })
      .join('\n\n');

    const exportLines = consolidatedExports
      .map(e => `${e.comment ? `# ${e.comment}\n` : ''}export ${e.name}="${e.value}"`)
      .join('\n');

    return `## Lab ${labNum} — Environment Variables

Set all required credentials and computed values before proceeding.

### All Variables

${table}

<details>
<summary>Copy-paste export block</summary>

\`\`\`bash
${exportLines}
\`\`\`

</details>`;
  }

  cleanup(_selection) {
    return '';
  }
}
