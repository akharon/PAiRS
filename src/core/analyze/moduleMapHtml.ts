/**
 * ModuleMap → self-contained HTML/SVG for the VS Code webview (plan.md 3.5).
 * Pure core (R10): string in, string out — no vscode import, no external
 * libraries (webview CSP forbids remote scripts, but inline <script> is
 * allowed and used here for interactivity). Layout is a simple
 * cluster-column arrangement: one column per Louvain subsystem, modules
 * stacked, edges as SVG paths; drift edges (cross-subsystem) drawn red.
 * Read-only over the graph — the inline script only reveals files via
 * postMessage, it never mutates the index.
 */

import type { ModuleMap } from './moduleMap';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function moduleMapHtml(map: ModuleMap): string {
  const colW = 240;
  const rowH = 34;
  const gapX = 60;
  const gapY = 10;
  const padTop = 56;

  // Order clusters to minimize backward (right-to-left) edge flow: sort by
  // net outbound-minus-inbound weight so producers sit left of consumers.
  const clusterOf = new Map<string, number>();
  map.clusters.forEach((c) => c.modules.forEach((m) => clusterOf.set(m, c.id)));
  const netFlow = new Map<number, number>();
  for (const e of map.edges) {
    const cf = clusterOf.get(e.from);
    const ct = clusterOf.get(e.to);
    if (cf === undefined || ct === undefined || cf === ct) continue;
    netFlow.set(cf, (netFlow.get(cf) ?? 0) - e.weight);
    netFlow.set(ct, (netFlow.get(ct) ?? 0) + e.weight);
  }
  const orderedClusters = [...map.clusters].sort((a, b) => (netFlow.get(a.id) ?? 0) - (netFlow.get(b.id) ?? 0));

  // Position every module: clusters as columns, modules as rows.
  const pos = new Map<string, Box>();
  let maxRows = 0;
  orderedClusters.forEach((c, col) => {
    c.modules.forEach((m, row) => {
      pos.set(m, { x: 20 + col * (colW + gapX), y: padTop + row * (rowH + gapY), w: colW, h: rowH });
    });
    maxRows = Math.max(maxRows, c.modules.length);
  });
  const width = Math.max(680, 20 + orderedClusters.length * (colW + gapX));
  const height = padTop + maxRows * (rowH + gapY) + 40;

  const maxWeight = map.edges.reduce((m, e) => Math.max(m, e.weight), 0);

  const edgePaths = map.edges
    .map((e) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) return '';
      const drift = clusterOf.get(e.from) !== clusterOf.get(e.to);
      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const x2 = b.x;
      const y2 = b.y + b.h / 2;
      const mx = (x1 + x2) / 2;
      const wgt = Math.min(1 + Math.log2(e.weight + 1), 5).toFixed(1);
      const cls = drift ? 'drift' : 'dep';
      return `<path class="${cls}" data-weight="${e.weight}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" stroke-width="${wgt}" d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}"><title>${esc(e.from)} → ${esc(e.to)} (×${e.weight})</title></path>`;
    })
    .join('\n');

  const nodeRects = [...pos.entries()]
    .map(
      ([m, b]) =>
        `<g class="modrow" data-module="${esc(m)}" data-cluster="${clusterOf.get(m)}" tabindex="0"><rect class="mod" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6"/><text x="${b.x + 10}" y="${b.y + b.h / 2 + 4}">${esc(m)}</text></g>`
    )
    .join('\n');

  const clusterLabels = orderedClusters
    .map((c, col) => `<text class="cluster" data-cluster="${c.id}" x="${20 + col * (colW + gapX)}" y="${padTop - 14}" tabindex="0">subsystem ${c.id + 1} (${c.modules.length}) ▾</text>`)
    .join('\n');

  const pct = (map.driftRatio * 100).toFixed(0);
  const layoutPct = (map.layoutDrift * 100).toFixed(0);
  const maxWeightAttr = maxWeight || 1;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground, #ccc); background: var(--vscode-editor-background, #1e1e1e); margin: 0; padding: 12px; }
  h2 { font-size: 14px; margin: 0 0 4px; }
  .sub { opacity: .7; font-size: 12px; margin-bottom: 4px; }
  .controls { display: flex; align-items: center; gap: 8px; font-size: 12px; margin-bottom: 8px; }
  .controls input[type="range"] { width: 160px; }
  svg { max-width: 100%; }
  rect.mod { fill: var(--vscode-editorWidget-background, #252526); stroke: var(--vscode-panel-border, #444); cursor: pointer; }
  .modrow:hover rect.mod, .modrow:focus rect.mod { stroke: var(--vscode-focusBorder, #4fc1ff); }
  .modrow.collapsed { display: none; }
  text { fill: var(--vscode-foreground, #ccc); font-size: 12px; }
  text.cluster { opacity: .7; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; cursor: pointer; }
  path.dep { fill: none; stroke: var(--vscode-charts-blue, #4fc1ff); opacity: .45; }
  path.drift { fill: none; stroke: var(--vscode-charts-red, #f48771); opacity: .8; }
  path.hidden-weight { display: none; }
</style></head><body>
  <h2>Module map — ${map.modules.length} modules, ${map.clusters.length} subsystem(s)</h2>
  <div class="sub">drift ${pct}% of dependency weight crosses subsystem boundaries · layout agreement ${layoutPct}% (subsystems vs folder layout) · red = cross-subsystem · click a module to reveal it, click a subsystem header to collapse it</div>
  <div class="controls">
    <label for="minWeight">min edge weight</label>
    <input id="minWeight" type="range" min="1" max="${maxWeightAttr}" value="1" step="1"/>
    <span id="minWeightVal">1</span>
  </div>
  <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
${clusterLabels}
${edgePaths}
${nodeRects}
  </svg>
<script>
(function () {
  var vscode = acquireVsCodeApi ? acquireVsCodeApi() : null;
  var svg = document.querySelector('svg');
  var slider = document.getElementById('minWeight');
  var sliderVal = document.getElementById('minWeightVal');

  function applyWeightFilter() {
    var min = Number(slider.value);
    sliderVal.textContent = String(min);
    svg.querySelectorAll('path[data-weight]').forEach(function (p) {
      var w = Number(p.getAttribute('data-weight'));
      p.classList.toggle('hidden-weight', w < min);
    });
  }
  slider.addEventListener('input', applyWeightFilter);

  svg.querySelectorAll('.modrow').forEach(function (g) {
    function reveal() {
      var mod = g.getAttribute('data-module');
      if (vscode) vscode.postMessage({ type: 'reveal', module: mod });
    }
    g.addEventListener('click', reveal);
    g.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') reveal(); });
  });

  svg.querySelectorAll('.cluster').forEach(function (label) {
    function toggle() {
      var id = label.getAttribute('data-cluster');
      var rows = svg.querySelectorAll('.modrow[data-cluster="' + id + '"]');
      var willCollapse = !rows[0] || !rows[0].classList.contains('collapsed');
      rows.forEach(function (g) { g.classList.toggle('collapsed', willCollapse); });
      label.textContent = label.textContent.replace(/[▾▸]/, willCollapse ? '▸' : '▾');
    }
    label.addEventListener('click', toggle);
    label.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') toggle(); });
  });
})();
</script>
</body></html>`;
}
