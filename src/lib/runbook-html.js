// src/lib/runbook-html.js
import { Marked } from 'marked';
import { scanHeadings, slugify } from './runbook.js';
import { usecaseTitle } from './runbook-adapters/usecase.js';

const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
const HLJS_JS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/highlight.min.js';
const HLJS_CSS_CDN =
  'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.10.0/styles/github-dark.min.css';

export class HtmlRenderer {
  render(markdownContent, selection) {
    const { preamble, chunks } = _splitIntoChunks(markdownContent);
    const timestamp = _extractTimestamp(preamble);
    const labChunks = chunks.filter(c => !/^## Table of Contents\s*$/m.test(c.split('\n')[0]));

    const marked = _buildMarked();
    const { entries, htmlChunks } = _renderChunks(labChunks, marked);
    const hero = _renderHero(selection, marked);
    const nav = _renderSidenav(entries, marked);

    const profile = selection?.profile;
    const pageTitle = profile?.metadata?.name || 'Agentic Demo Runbook';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${_escapeHtml(pageTitle)} — Runbook</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${HLJS_CSS_CDN}">
<style>${_css()}</style>
<script>
  (function () {
    var stored = null;
    try { stored = localStorage.getItem('runbook-theme'); } catch (e) {}
    var theme = stored === 'light' || stored === 'dark'
      ? stored
      : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  })();
</script>
</head>
<body>
<header class="page-header" id="top">
  <div class="page-header-main">
    <h1>Agentic Demo Runbook</h1>
    <dl class="page-meta">
      <div><dt>Generated</dt><dd>${_escapeHtml(timestamp || '—')}</dd></div>
    </dl>
  </div>
  <label class="theme-switch" title="Toggle dark mode">
    <span class="theme-switch-label">Dark mode</span>
    <input type="checkbox" id="theme-toggle">
    <span class="theme-switch-track"><span class="theme-switch-thumb"></span></span>
  </label>
</header>
${hero}
<div class="layout">
<nav class="sidenav">
${nav}
</nav>
<main class="labs">
${htmlChunks.join('\n')}
</main>
</div>
<a class="back-to-top" href="#top">Back to top</a>
<script src="${MERMAID_CDN}"></script>
<script src="${HLJS_JS_CDN}"></script>
<script>
  // Mermaid auto-runs on its own DOMContentLoaded listener (registered when its
  // script tag loads, before ours) unless startOnLoad is disabled synchronously
  // here — otherwise it renders once with default theme before we get a chance
  // to configure it, corrupting the pristine source text we rely on for re-theming.
  mermaid.initialize({ startOnLoad: false });

  const MERMAID_BASE_CONFIG = {
    startOnLoad: false,
    theme: 'base',
    themeCSS: \`
      .node rect, .node polygon, .node ellipse, .node circle {
        rx: 10px; ry: 10px;
        stroke-width: 1.5px;
        filter: drop-shadow(0 2px 4px rgba(30, 30, 70, 0.12));
      }
      .cluster rect { rx: 10px; ry: 10px; }
      .edgeLabel {
        border-radius: 6px;
        font-weight: 500;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
      }
      .edgePath .path { stroke-width: 1.75px; }
      .flowchart-link { stroke-width: 1.75px; }
    \`,
    flowchart: {
      curve: 'basis',
      htmlLabels: true,
      padding: 20,
      nodeSpacing: 55,
      rankSpacing: 70,
      wrappingWidth: 320,
    },
  };

  const MERMAID_THEME_VARS = {
    light: {
      fontFamily: 'Inter, sans-serif',
      fontSize: '15px',
      primaryColor: '#eef0fd',
      primaryBorderColor: '#5b5bd6',
      primaryTextColor: '#1c1c24',
      lineColor: '#7a7ac2',
      secondaryColor: '#f7f7fa',
      secondaryBorderColor: '#c9c9ec',
      tertiaryColor: '#ffffff',
      tertiaryBorderColor: '#5b5bd6',
      clusterBkg: '#f7f7fb',
      clusterBorder: '#c9c9ec',
      edgeLabelBackground: '#ffffff',
      titleColor: '#1c1c24',
    },
    dark: {
      fontFamily: 'Inter, sans-serif',
      fontSize: '15px',
      primaryColor: '#2a2a45',
      primaryBorderColor: '#8f8ff5',
      primaryTextColor: '#e8e8f0',
      lineColor: '#8f8ff5',
      secondaryColor: '#20202e',
      secondaryBorderColor: '#3a3a55',
      tertiaryColor: '#1c1c26',
      tertiaryBorderColor: '#8f8ff5',
      clusterBkg: '#20202e',
      clusterBorder: '#3a3a55',
      edgeLabelBackground: '#1c1c26',
      titleColor: '#e8e8f0',
    },
  };

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  async function renderMermaidDiagrams() {
    const nodes = Array.from(document.querySelectorAll('pre.mermaid'));
    if (nodes.length === 0) return;
    nodes.forEach((node) => {
      if (node.dataset.mermaidSrc === undefined) {
        node.dataset.mermaidSrc = node.textContent;
      }
      node.removeAttribute('data-processed');
      node.innerHTML = node.dataset.mermaidSrc;
    });
    mermaid.initialize({
      ...MERMAID_BASE_CONFIG,
      themeVariables: MERMAID_THEME_VARS[currentTheme()],
    });
    await mermaid.run({ nodes });
  }

  var KEY_TERMS = [
    'EnterpriseAgentgatewayBackend',
    'EnterpriseAgentgatewayPolicy',
    'EnterpriseAgentgatewayParameters',
    'AgentgatewayBackend',
    'MCPServer',
    'HTTPRoute',
    'GatewayClass',
    'Gateway',
    'ReferenceGrant',
    'Backend',
    'ClusterIssuer',
    'Issuer',
    'Certificate',
    'AuthorizationPolicy',
    'DestinationRule',
    'ServiceEntry',
    'VirtualService',
    'Telemetry',
    'ClusterSPIFFEID',
    'CiliumClusterwideNetworkPolicy',
    'ListenerPolicy',
    'ServiceMeshController',
    'Segment',
  ];

  function highlightKeyTerms() {
    var pattern = new RegExp('\\\\b(' + KEY_TERMS.join('|') + ')\\\\b', 'g');
    document.querySelectorAll('pre code').forEach((code) => {
      var walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      var textNodes = [];
      var node;
      while ((node = walker.nextNode())) textNodes.push(node);
      textNodes.forEach((textNode) => {
        var text = textNode.nodeValue;
        pattern.lastIndex = 0;
        if (!pattern.test(text)) return;
        pattern.lastIndex = 0;
        var frag = document.createDocumentFragment();
        var lastIndex = 0;
        var match;
        while ((match = pattern.exec(text))) {
          if (match.index > lastIndex) {
            frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
          }
          var mark = document.createElement('mark');
          mark.className = 'key-term';
          mark.textContent = match[0];
          frag.appendChild(mark);
          lastIndex = match.index + match[0].length;
        }
        if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
        textNode.parentNode.replaceChild(frag, textNode);
      });
    });
  }

  function initCopyButtons() {
    document.querySelectorAll('pre').forEach((pre) => {
      if (pre.classList.contains('mermaid')) return;
      const codeText = pre.innerText;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'copy-btn';
      btn.textContent = 'Copy';
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(codeText).then(() => {
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        });
      });
      pre.appendChild(btn);
    });
  }

  function initScrollSpy() {
    const navLinks = Array.from(document.querySelectorAll('.sidenav a'));
    const linkByHash = new Map(navLinks.map((a) => [a.getAttribute('href'), a]));
    const headings = Array.from(document.querySelectorAll('.labs h2[id], .labs h3[id], .labs h4[id]'))
      .filter((h) => linkByHash.has('#' + h.id));
    if (!navLinks.length || !headings.length) return;

    let currentId = null;
    const setActive = (id) => {
      if (!id || id === currentId) return;
      currentId = id;
      navLinks.forEach((a) => a.classList.remove('active'));
      const link = linkByHash.get('#' + id);
      if (link) {
        link.classList.add('active');
        link.scrollIntoView({ block: 'nearest' });
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (!visible.length) return;
        visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        setActive(visible[0].target.id);
      },
      { rootMargin: '0px 0px -70% 0px', threshold: 0 }
    );
    headings.forEach((h) => observer.observe(h));
  }

  document.addEventListener('DOMContentLoaded', async () => {
    hljs.highlightAll();
    highlightKeyTerms();
    initCopyButtons();
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch (e) {}
    }
    await renderMermaidDiagrams();
    initScrollSpy();

    const toggle = document.getElementById('theme-toggle');
    toggle.checked = currentTheme() === 'dark';
    toggle.addEventListener('change', async () => {
      const theme = toggle.checked ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', theme);
      try { localStorage.setItem('runbook-theme', theme); } catch (e) {}
      await renderMermaidDiagrams();
    });
  });
</script>
</body>
</html>
`;
  }
}

function _splitIntoChunks(content) {
  const lines = content.split('\n');
  const headingIdx = [];
  lines.forEach((line, i) => {
    if (/^## .+$/.test(line)) headingIdx.push(i);
  });

  const preamble = lines.slice(0, headingIdx[0] ?? lines.length).join('\n');
  const chunks = headingIdx.map((start, i) => {
    const end = i + 1 < headingIdx.length ? headingIdx[i + 1] : lines.length;
    return lines.slice(start, end).join('\n');
  });

  return { preamble, chunks };
}

function _extractTimestamp(preamble) {
  const match = preamble.match(/^Generated:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

function _labId(headingText, index) {
  const match = headingText.match(/^Lab\s+(\d+)/);
  return match ? `lab-${match[1]}` : `lab-${index}`;
}

function _renderChunks(chunks, marked) {
  const entries = [];

  const htmlChunks = chunks.map((chunk, idx) => {
    const lines = chunk.split('\n');
    const title = lines[0].replace(/^## /, '');
    const body = lines.slice(1).join('\n');
    const labId = _labId(title, idx);

    entries.push({ level: 2, text: title, anchor: labId });
    for (const heading of scanHeadings(body)) {
      if (heading.level === 3 || heading.level === 4) entries.push(heading);
    }

    const { replaced, blocks } = _extractMermaidBlocks(body);
    const html = _reinsertMermaidBlocks(marked.parse(replaced), blocks);

    return `<details class="lab" id="${labId}" open>
<summary>${_escapeHtml(title)}</summary>
<div class="lab-body">
${html}
</div>
</details>`;
  });

  return { entries, htmlChunks };
}

function _renderSidenav(entries, marked) {
  return entries
    .map(e => `<a class="nav-h${e.level}" href="#${e.anchor}">${marked.parseInline(e.text)}</a>`)
    .join('\n');
}

function _renderHero(selection, marked) {
  const usecases = selection?.usecases || [];
  if (usecases.length !== 1) return '';

  const usecase = usecases[0];
  const description = usecase.metadata?.description;
  const diagram = usecase.spec?.diagram;

  const descriptionHtml = description ? marked.parse(description) : '';
  const diagramHtml = diagram
    ? `<pre class="mermaid">${_escapeMermaid(
        diagram
          .replace(/\\n/g, '<br>')
          .replace(/\s*·\s*/g, '<br>')
          .trim()
      )}</pre>`
    : '';

  return `<header class="hero">
<h2>${_escapeHtml(usecaseTitle(usecase))}</h2>
${descriptionHtml}
${diagramHtml}
</header>`;
}

function _buildMarked() {
  return new Marked({
    renderer: {
      heading(token) {
        const html = this.parser.parseInline(token.tokens);
        if (token.depth === 2 || token.depth === 3 || token.depth === 4) {
          return `<h${token.depth} id="${slugify(token.text)}">${html}</h${token.depth}>\n`;
        }
        return `<h${token.depth}>${html}</h${token.depth}>\n`;
      },
    },
  });
}

function _extractMermaidBlocks(markdown) {
  const blocks = [];
  const replaced = markdown.replace(/```mermaid\n([\s\S]*?)```/g, (_, code) => {
    const token = `@@MERMAID_BLOCK_${blocks.length}@@`;
    blocks.push(code.trim());
    return token;
  });
  return { replaced, blocks };
}

function _reinsertMermaidBlocks(html, blocks) {
  return blocks.reduce((acc, code, i) => {
    const token = `@@MERMAID_BLOCK_${i}@@`;
    const pre = `<pre class="mermaid">${_escapeMermaid(code)}</pre>`;
    return acc.includes(`<p>${token}</p>`) ? acc.replace(`<p>${token}</p>`, pre) : acc.replace(token, pre);
  }, html);
}

function _escapeMermaid(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _css() {
  return `
:root {
  color-scheme: light;
  --font-body: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
  --bg: #f7f7fa;
  --surface: #ffffff;
  --border: #e2e2ea;
  --text: #1c1c24;
  --text-dim: #6b6b7a;
  --accent: #5b5bd6;
  --accent-dim: #ededfb;
  --code-bg: #0d1117;
}
:root[data-theme='dark'] {
  color-scheme: dark;
  --bg: #14141c;
  --surface: #1c1c26;
  --border: #33333f;
  --text: #e8e8f0;
  --text-dim: #9a9aab;
  --accent: #8f8ff5;
  --accent-dim: #24243a;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: var(--font-body);
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
}
h1, h2, h3, h4 { font-family: var(--font-body); font-weight: 600; line-height: 1.3; }
code, pre, .nav-h2, .nav-h3, .nav-h4 { font-family: var(--font-mono); }
a { color: var(--accent); }

code {
  background: var(--accent-dim);
  padding: 0.15em 0.4em;
  border-radius: 4px;
  font-size: 0.85em;
}

blockquote {
  margin: 1rem 0;
  padding: 0.85rem 1.1rem;
  background: var(--accent-dim);
  border-left: 4px solid var(--accent);
  border-radius: 0 8px 8px 0;
}
blockquote p { margin: 0; }
blockquote p + p { margin-top: 0.5rem; }

.back-to-top {
  position: fixed;
  right: 1.5rem;
  bottom: 1.5rem;
  padding: 0.5rem 1rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--text-dim);
  text-decoration: none;
  z-index: 10;
}
.back-to-top:hover { color: var(--accent); border-color: var(--accent); }

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1.5rem;
  padding: 2.5rem 3rem 1.5rem;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.page-header h1 { margin: 0 0 0.75rem; font-size: 1.75rem; }
.page-meta { display: flex; gap: 2rem; margin: 0; flex-wrap: wrap; }
.page-meta dt { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim); margin: 0; }
.page-meta dd { margin: 0.15rem 0 0; font-weight: 500; }

.theme-switch {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-shrink: 0;
  margin-top: 0.25rem;
  cursor: pointer;
  user-select: none;
}
.theme-switch-label { font-size: 0.8rem; color: var(--text-dim); }
.theme-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.theme-switch-track {
  position: relative;
  width: 42px;
  height: 24px;
  border-radius: 999px;
  background: var(--border);
  transition: background 0.2s ease;
}
.theme-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  transition: transform 0.2s ease;
}
.theme-switch input:checked ~ .theme-switch-track { background: var(--accent); }
.theme-switch input:checked ~ .theme-switch-track .theme-switch-thumb { transform: translateX(18px); }

.hero {
  margin: 1.5rem 3rem 0;
  padding: 1.75rem 2rem;
  background: linear-gradient(135deg, var(--accent-dim), var(--surface));
  border: 1px solid var(--border);
  border-radius: 12px;
}
.hero h2 { margin-top: 0; }

.layout {
  display: flex;
  align-items: flex-start;
  gap: 2.5rem;
  max-width: 1400px;
  margin: 2rem auto;
  padding: 0 3rem;
}
.sidenav {
  flex: 0 0 260px;
  position: sticky;
  top: 1.5rem;
  max-height: calc(100vh - 3rem);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding-right: 0.5rem;
}
.sidenav a { text-decoration: none; color: var(--text-dim); font-size: 0.85rem; border-left: 2px solid transparent; padding-left: 0.5rem; margin-left: -0.5rem; }
.sidenav a:hover { color: var(--accent); }
.sidenav a.nav-h3 { padding-left: 1.5rem; font-size: 0.8rem; }
.sidenav a.nav-h4 { padding-left: 2.5rem; font-size: 0.78rem; }
.sidenav a.active { color: var(--accent); font-weight: 600; border-left-color: var(--accent); }

.labs { flex: 1; min-width: 0; }

details.lab {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  margin-bottom: 1.25rem;
  padding: 0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
  overflow: hidden;
}
details.lab > summary {
  cursor: pointer;
  padding: 1.1rem 1.5rem;
  font-size: 1.1rem;
  font-weight: 600;
  list-style: none;
  background: var(--surface);
  border-bottom: 1px solid transparent;
}
details.lab[open] > summary { border-bottom-color: var(--border); }
details.lab > summary::-webkit-details-marker { display: none; }
details.lab > summary::before { content: '▸ '; color: var(--text-dim); }
details.lab[open] > summary::before { content: '▾ '; }
.lab-body { padding: 0.5rem 1.5rem 1.5rem; }

table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.9rem; }
th, td { border: 1px solid var(--border); padding: 0.5rem 0.75rem; text-align: left; }
th { background: var(--accent-dim); }

pre {
  position: relative;
  background: var(--code-bg);
  border-radius: 8px;
  padding: 1rem 1.1rem;
  overflow-x: auto;
  font-size: 0.85rem;
}
pre code { font-family: var(--font-mono); background: none; padding: 0; border-radius: 0; font-size: inherit; }
pre.mermaid {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1.75rem 1.25rem;
  text-align: center;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

.copy-btn {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  font-family: var(--font-body);
  font-size: 0.75rem;
  padding: 0.25rem 0.6rem;
  border-radius: 6px;
  border: 1px solid #3a3a44;
  background: #1c1c24;
  color: #d5d5e0;
  cursor: pointer;
}
.copy-btn:hover { background: #2a2a34; }

/* Code block backgrounds are always dark (see --code-bg), regardless of page theme. */
mark.key-term {
  background: rgba(245, 217, 10, 0.16);
  color: #f5d90a;
  padding: 0.05em 0.3em;
  border-radius: 4px;
  font-weight: 600;
}

details {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  margin: 1rem 0;
}

.component-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 0.75rem;
  margin: 1rem 0;
}
.component-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.85rem 1rem;
}
.component-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.4rem;
}
.component-name { font-family: var(--font-mono); font-weight: 600; font-size: 0.85rem; color: var(--accent); }
.component-scope {
  font-size: 0.68rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  background: var(--accent-dim);
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  white-space: nowrap;
}
.component-desc { margin: 0; font-size: 0.85rem; color: var(--text-dim); line-height: 1.5; }

.test-card {
  background: var(--accent-dim);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.1rem 1.25rem 1.25rem;
  margin: 1rem 0;
}
.test-section-label {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--accent);
  margin: 1.1rem 0 0.5rem;
}
.test-card pre { background: var(--code-bg); }
`;
}
