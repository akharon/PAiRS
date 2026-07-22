/**
 * ModuleMap → self-contained HTML/SVG for the VS Code webview (plan.md 3.5).
 * Pure core (R10): string in, string out — no vscode import, no external
 * libraries (webview CSP forbids remote scripts). Layout is a simple
 * cluster-column arrangement: one column per Louvain subsystem, modules
 * stacked, edges as SVG paths; drift edges (cross-subsystem) drawn red.
 * Read-only by design — the webview never mutates the graph.
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

  // Position every module: clusters as columns, modules as rows.
  const pos = new Map<string, Box>();
  let maxRows = 0;
  map.clusters.forEach((c, col) => {
    c.modules.forEach((m, row) => {
      pos.set(m, { x: 20 + col * (colW + gapX), y: padTop + row * (rowH + gapY), w: colW, h: rowH });
    });
    maxRows = Math.max(maxRows, c.modules.length);
  });
  const width = Math.max(680, 20 + map.clusters.length * (colW + gapX));
  const height = padTop + maxRows * (rowH + gapY) + 40;

  const clusterOf = new Map<string, number>();
  map.clusters.forEach((c) => c.modules.forEach((m) => clusterOf.set(m, c.id)));

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
      return `<path class="${cls}" stroke-width="${wgt}" d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}"><title>${esc(e.from)} → ${esc(e.to)} (×${e.weight})</title></path>`;
    })
    .join('\n');

  const nodeRects = [...pos.entries()]
    .map(
      ([m, b]) =>
        `<g><rect class="mod" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6"/><text x="${b.x + 10}" y="${b.y + b.h / 2 + 4}">${esc(m)}</text></g>`
    )
    .join('\n');

  const clusterLabels = map.clusters
    .map((c, col) => `<text class="cluster" x="${20 + col * (colW + gapX)}" y="${padTop - 14}">subsystem ${c.id + 1} (${c.modules.length})</text>`)
    .join('\n');

  const pct = (map.driftRatio * 100).toFixed(0);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground, #ccc); background: var(--vscode-editor-background, #1e1e1e); margin: 0; padding: 12px; }
  h2 { font-size: 14px; margin: 0 0 4px; }
  .sub { opacity: .7; font-size: 12px; margin-bottom: 8px; }
  svg { max-width: 100%; }
  rect.mod { fill: var(--vscode-editorWidget-background, #252526); stroke: var(--vscode-panel-border, #444); }
  text { fill: var(--vscode-foreground, #ccc); font-size: 12px; }
  text.cluster { opacity: .6; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  path.dep { fill: none; stroke: var(--vscode-charts-blue, #4fc1ff); opacity: .45; }
  path.drift { fill: none; stroke: var(--vscode-charts-red, #f48771); opacity: .8; }
</style></head><body>
  <h2>Module map — ${map.modules.length} modules, ${map.clusters.length} subsystem(s)</h2>
  <div class="sub">drift ${pct}% of dependency weight crosses subsystem boundaries · red = cross-subsystem</div>
  <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
${clusterLabels}
${edgePaths}
${nodeRects}
  </svg>
</body></html>`;
}
