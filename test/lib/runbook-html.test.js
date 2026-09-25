// test/lib/runbook-html.test.js
import { test, expect } from 'bun:test';
import { HtmlRenderer } from '../../src/lib/runbook-html.js';

const SYNTHETIC_MARKDOWN = `# Agentic Demo Runbook

Generated: 2026-08-24 10:00:00 (local)

---

## Table of Contents

- [Lab 0 — Prerequisites](#lab-0--prerequisites)
- [Lab 7 — Use Cases](#lab-7--use-cases)

## Lab 0 — Prerequisites

Install some tools.

\`\`\`bash
kubectl version
\`\`\`

### Cluster Topology

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

| Tool | Version |
|------|---------|
| kubectl | v1.33+ |

<details>
<summary>Copy-paste export block</summary>

\`\`\`bash
export FOO="bar"
\`\`\`

</details>

## Lab 7 — Use Cases

### Lab 7.1 — My Use Case

#### Deploy

Steps here.

## Lab 6 — Install Istio Ambient

> **Skip this lab** if clusters are already provisioned — set context variables directly in **Lab 3 — Environment Variables**.

### Install on \`east\`

Install steps here.
`;

const baseSelection = {
  profile: { metadata: { name: 'test-profile' } },
  infraProfile: { spec: { provider: 'eks' } },
  usecases: [],
};

test('HtmlRenderer.render produces a full HTML document', () => {
  const html = new HtmlRenderer().render(SYNTHETIC_MARKDOWN, baseSelection);
  expect(html.trim().startsWith('<!DOCTYPE html>')).toBe(true);
});

test('HtmlRenderer.render wraps each lab in a collapsible details element', () => {
  const html = new HtmlRenderer().render(SYNTHETIC_MARKDOWN, baseSelection);
  expect(html).toContain('<details class="lab" id="lab-0"');
  expect(html).toContain('<details class="lab" id="lab-7"');
  expect(html).toContain('<summary>Lab 0 — Prerequisites</summary>');
});

test('HtmlRenderer.render converts mermaid fences to pre.mermaid, not a highlighted code block', () => {
  const html = new HtmlRenderer().render(SYNTHETIC_MARKDOWN, baseSelection);
  expect(html).toContain('<pre class="mermaid">');
  expect(html).toContain('A --&gt; B');
  expect(html).not.toContain('language-mermaid');
});

test('HtmlRenderer.render preserves raw HTML passthrough (details block) from markdown', () => {
  const html = new HtmlRenderer().render(SYNTHETIC_MARKDOWN, baseSelection);
  expect(html).toContain('Copy-paste export block');
});

test('HtmlRenderer.render includes mermaid and highlight.js CDN scripts', () => {
  const html = new HtmlRenderer().render(SYNTHETIC_MARKDOWN, baseSelection);
  expect(html).toMatch(/<script src="https:\/\/[^"]*mermaid[^"]*"><\/script>/);
  expect(html).toMatch(/<script src="https:\/\/[^"]*highlight[^"]*"><\/script>/);
});

test('HtmlRenderer.render injects a copy-button affordance for code blocks', () => {
  const html = new HtmlRenderer().render(SYNTHETIC_MARKDOWN, baseSelection);
  expect(html).toContain('copy-btn');
  expect(html).toContain('navigator.clipboard.writeText');
});

test('HtmlRenderer.render omits the Table of Contents chunk (superseded by the sidenav)', () => {
  const html = new HtmlRenderer().render(SYNTHETIC_MARKDOWN, baseSelection);
  expect(html).not.toContain('Table of Contents');
});

test('HtmlRenderer.render includes a dark-mode toggle switch and theme CSS variables', () => {
  const html = new HtmlRenderer().render(SYNTHETIC_MARKDOWN, baseSelection);
  expect(html).toContain('id="theme-toggle"');
  expect(html).toContain('class="theme-switch"');
  expect(html).toMatch(/:root\[data-theme=['"]dark['"]\]/);
  expect(html).toContain("localStorage.setItem('runbook-theme'");
});

test('HtmlRenderer.render wires up key-term highlighting for code blocks with a curated term list', () => {
  const html = new HtmlRenderer().render(SYNTHETIC_MARKDOWN, baseSelection);
  expect(html).toContain('highlightKeyTerms()');
  expect(html).toContain('EnterpriseAgentgatewayBackend');
  expect(html).toContain('mark.key-term');
  const highlightCallIdx = html.indexOf('highlightKeyTerms();');
  const hljsCallIdx = html.indexOf('hljs.highlightAll();');
  expect(hljsCallIdx).toBeGreaterThan(-1);
  expect(hljsCallIdx).toBeLessThan(highlightCallIdx);
});

test('HtmlRenderer.render wires up an IntersectionObserver-based scroll spy for the sidenav', () => {
  const html = new HtmlRenderer().render(SYNTHETIC_MARKDOWN, baseSelection);
  expect(html).toContain('new IntersectionObserver');
  expect(html).toContain('initScrollSpy()');
  expect(html).toContain('.sidenav a.active { color: var(--accent)');
});

test('HtmlRenderer.render disables mermaid auto-init before DOMContentLoaded to avoid a render race', () => {
  const html = new HtmlRenderer().render(SYNTHETIC_MARKDOWN, baseSelection);
  const initCallIdx = html.indexOf('mermaid.initialize({ startOnLoad: false });');
  const domContentLoadedIdx = html.indexOf("addEventListener('DOMContentLoaded'");
  expect(initCallIdx).toBeGreaterThan(-1);
  expect(domContentLoadedIdx).toBeGreaterThan(-1);
  expect(initCallIdx).toBeLessThan(domContentLoadedIdx);
});

test('HtmlRenderer.render renders a hero above the first Lab heading for a single-usecase selection', () => {
  const selection = {
    ...baseSelection,
    usecases: [
      {
        metadata: { name: 'my-usecase', description: 'A great demo of things.' },
        spec: {},
      },
    ],
  };
  const html = new HtmlRenderer().render(SYNTHETIC_MARKDOWN, selection);
  const heroIdx = html.indexOf('A great demo of things.');
  const firstLabIdx = html.indexOf('Lab 0 — Prerequisites');
  expect(heroIdx).toBeGreaterThan(-1);
  expect(firstLabIdx).toBeGreaterThan(-1);
  expect(heroIdx).toBeLessThan(firstLabIdx);
});

test('HtmlRenderer.render omits the hero when zero or multiple use cases are selected', () => {
  const html = new HtmlRenderer().render(SYNTHETIC_MARKDOWN, baseSelection);
  expect(html).not.toContain('class="hero"');
});

test('HtmlRenderer.render uses a friendly title (not the raw dashed name) in the hero heading', () => {
  const selection = {
    ...baseSelection,
    usecases: [
      {
        metadata: {
          name: 'hub-spoke-mcp-connectivity',
          description: 'Cross-cluster MCP tool access.',
        },
        spec: {},
      },
    ],
  };
  const html = new HtmlRenderer().render(SYNTHETIC_MARKDOWN, selection);
  expect(html).toContain('<h2>Cross-cluster MCP tool access</h2>');
  expect(html).not.toContain('<h2>hub-spoke-mcp-connectivity</h2>');
});

test('HtmlRenderer.render falls back to a title-cased name in the hero when no description exists', () => {
  const selection = {
    ...baseSelection,
    usecases: [{ metadata: { name: 'hub-spoke-mcp-connectivity' }, spec: {} }],
  };
  const html = new HtmlRenderer().render(SYNTHETIC_MARKDOWN, selection);
  expect(html).toContain('<h2>Hub Spoke Mcp Connectivity</h2>');
});

test('HtmlRenderer.render omits Profile and Infra Provider from the page header', () => {
  const html = new HtmlRenderer().render(SYNTHETIC_MARKDOWN, baseSelection);
  expect(html).not.toContain('<dt>Profile</dt>');
  expect(html).not.toContain('<dt>Infra Provider</dt>');
  expect(html).toContain('<dt>Generated</dt>');
});

test('HtmlRenderer.render includes a back-to-top link anchored to the page header', () => {
  const html = new HtmlRenderer().render(SYNTHETIC_MARKDOWN, baseSelection);
  expect(html).toContain('id="top"');
  expect(html).toContain('class="back-to-top" href="#top"');
});

test('HtmlRenderer.render renders sidenav heading text as markdown, not literal backticks', () => {
  const html = new HtmlRenderer().render(SYNTHETIC_MARKDOWN, baseSelection);
  const navStart = html.indexOf('<nav class="sidenav">');
  const navEnd = html.indexOf('</nav>');
  const navHtml = html.slice(navStart, navEnd);
  expect(navHtml).toContain('Install on <code>east</code>');
  expect(navHtml).not.toContain('`east`');
});

test('HtmlRenderer.render styles markdown blockquotes as info boxes', () => {
  const html = new HtmlRenderer().render(SYNTHETIC_MARKDOWN, baseSelection);
  expect(html).toContain('<blockquote>');
  expect(html).toMatch(/blockquote\s*{[^}]*border-left/);
});

test('HtmlRenderer.render indexes h4 headings in the sidenav, nested under their h3 parent', () => {
  const html = new HtmlRenderer().render(SYNTHETIC_MARKDOWN, baseSelection);
  const navStart = html.indexOf('<nav class="sidenav">');
  const navEnd = html.indexOf('</nav>');
  const navHtml = html.slice(navStart, navEnd);
  expect(navHtml).toContain('class="nav-h4"');
  expect(navHtml).toContain('>Deploy<');
  const h3Idx = navHtml.indexOf('My Use Case');
  const h4Idx = navHtml.indexOf('>Deploy<');
  expect(h3Idx).toBeGreaterThan(-1);
  expect(h3Idx).toBeLessThan(h4Idx);
});

test('HtmlRenderer.render gives the h4 "Deploy" heading in the lab body a matching id', () => {
  const html = new HtmlRenderer().render(SYNTHETIC_MARKDOWN, baseSelection);
  expect(html).toMatch(/<h4 id="deploy">Deploy<\/h4>/);
});
