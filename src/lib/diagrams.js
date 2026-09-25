import chalk from 'chalk';
import stringWidth from 'string-width';
import logSymbols from 'log-symbols';
import { formatDescription } from './common.js';

const DIM = chalk.dim;
const CYAN = chalk.cyan;
const YELLOW = chalk.yellow;
const BOLD = chalk.bold;
const WHITE = chalk.white;

const BOX_INNER_WIDTH = 73;

function padVisual(str, width) {
  const w = stringWidth(str);
  if (w >= width) return str;
  return str + ' '.repeat(width - w);
}

function boxLine(content) {
  return `│${padVisual(content, BOX_INNER_WIDTH)}│`;
}

function sanitizeMermaidLabel(s) {
  return String(s).replace(/\x22/g, '\u0027').replace(/[<>]/g, '').replace(/\n/g, ' ');
}

/**
 * Generate a fallback Mermaid flowchart from use case steps and features.
 * Used only when spec.diagram is not set and no companion .md is found.
 * @param {Object} metadata - Use case metadata (name)
 * @param {Object} spec - Use case spec
 * @param {Array<{ title: string, features: Array<{name: string}> }>} steps - Resolved steps
 * @returns {string} Mermaid diagram source
 */
export function generateMermaidForUseCase(metadata, spec, steps) {
  if (!steps || steps.length === 0) return '';
  const lines = ['flowchart LR'];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const featureNames = (step.features || []).map(f => f.name).filter(Boolean);
    const title = sanitizeMermaidLabel(step.title || 'Step');
    const featSuffix = featureNames.length ? ` - ${featureNames.join(', ')}` : '';
    const label = sanitizeMermaidLabel(`${i + 1}) ${title}${featSuffix}`);
    const id = `S${i}`;
    lines.push(`  ${id}["${label}"]`);
    if (i > 0) {
      lines.push(`  S${i - 1} --> ${id}`);
    }
  }
  return lines.join('\n');
}

async function renderMermaidToAscii(mermaidText) {
  if (!mermaidText || typeof mermaidText !== 'string') return null;
  const trimmed = mermaidText.trim();
  if (!trimmed) return null;
  try {
    const { renderMermaidAscii } = await import('beautiful-mermaid');
    return renderMermaidAscii(trimmed, {
      useAscii: false,
      colorMode: 'none',
    });
  } catch {
    return null;
  }
}

/**
 * Show use case overview before first step: description, step list, and ASCII diagram.
 * @param {Object} metadata - Use case metadata (name, description)
 * @param {Object} spec - Use case spec
 * @param {Array<{ title: string, features: Array }>} steps - Resolved steps
 * @param {string|null} mermaidText - Mermaid source (from spec.diagram or companion .md)
 */
export async function showUseCaseOverview(metadata, spec, steps, mermaidText) {
  const top = '┌' + '─'.repeat(BOX_INNER_WIDTH) + '┐';
  const bot = '└' + '─'.repeat(BOX_INNER_WIDTH) + '┘';

  console.log('');
  console.log(
    CYAN(BOLD('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))
  );
  console.log(CYAN(BOLD(`  Use case: ${metadata.name || 'Unnamed'}`)));
  console.log(
    CYAN(BOLD('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))
  );
  console.log('');

  if (spec.deprecated) {
    console.log(
      `${logSymbols.warning} ` +
        chalk.bgYellow.black.bold(' DEPRECATED ') +
        ' ' +
        chalk.yellow(`${spec.deprecated.reason} Use '${spec.deprecated.replacedBy}' instead.`)
    );
    console.log('');
  }

  if (metadata.description) {
    console.log(WHITE(formatDescription(metadata.description, '')));
    console.log('');
  }

  if (steps.length > 0) {
    console.log(DIM('  Steps:'));
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const featureList = (s.features || []).map(f => f.name).filter(Boolean);
      const suffix = featureList.length ? `  [${featureList.join(', ')}]` : '';
      console.log(DIM(`    ${i + 1}. ${s.title}${suffix}`));
    }
    console.log('');
  }

  const asciiDiagram = mermaidText ? await renderMermaidToAscii(mermaidText) : null;
  if (asciiDiagram) {
    console.log(DIM('  Data flow:'));
    console.log(DIM(asciiDiagram));
    console.log('');
  } else if (mermaidText && steps.length > 0) {
    const featureList = [...new Set(steps.flatMap(s => s.features.map(f => f.name)))].join(', ');
    console.log(DIM(top));
    console.log(DIM(boxLine('  Features: ' + featureList)));
    console.log(DIM(bot));
    console.log('');
  }
}

/**
 * Print step header (step N of M, title, optional description)
 * @param {number} stepIndex - 1-based
 * @param {number} totalSteps
 * @param {string} title
 * @param {string} [description]
 */
export function showStepHeader(stepIndex, totalSteps, title, description) {
  console.log('');
  console.log(
    YELLOW(BOLD('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))
  );
  console.log(YELLOW(BOLD(`  Step ${stepIndex} of ${totalSteps}: ${title}`)));
  console.log(
    YELLOW(BOLD('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))
  );
  console.log('');
  if (description) {
    console.log(WHITE(formatDescription(description, '')));
    console.log('');
  }
}

/**
 * Print "press Space to continue" prompt
 */
export function showWaitPrompt() {
  console.log(DIM('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(YELLOW('👉 Press SPACE or ENTER to continue...'));
}
