/**
 * ModuleMap → self-contained HTML/SVG for the VS Code webview.
 * Pure core (R10): string in, string out — no vscode import, no external
 * libraries (webview CSP forbids remote scripts, but inline <script> is
 * allowed and used here for interactivity).
 *
 * Layout: one column per Louvain subsystem, ordered so dependencies flow
 * left → right (columns sorted by dependency layer, deepest consumer first),
 * modules stacked within a column by layer then name, node height scaled by
 * module size. Edges are SVG paths: intra-subsystem muted blue, cross-
 * subsystem (drift) red, cycle-participating amber and dashed — a cycle is a
 * hard structural fact and outranks drift, which is only a clustering
 * judgement.
 *
 * Read-only over the graph — the inline script filters/focuses the view and
 * asks the extension to reveal a module, it never mutates the index.
 */

import type { ModuleMap, ModuleMetric } from './moduleMap';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Keep the tail: module keys share long prefixes ("src/core/…"), the tail is what distinguishes them. */
function shortLabel(name: string, maxChars = MAX_LABEL): string {
  return name.length <= maxChars ? name : '…' + name.slice(name.length - maxChars + 1);
}

/** Deterministic, theme-neutral subsystem hues — mid-lightness reads on both light and dark backgrounds. */
function clusterColor(id: number): string {
  return `hsl(${(id * 67) % 360} 65% 55%)`;
}

const COL_W = 260;
const GAP_X = 84;
const GAP_Y = 12;
const ROW_MIN = 30;
const ROW_MAX = 46;
const PAD_TOP = 74;
const PAD_LEFT = 24;
const MAX_LABEL = 26;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Column {
  id: number;
  x: number;
  w: number;
  top: number;
  bottom: number;
  count: number;
}

interface Layout {
  /** Module boxes, keyed by module. */
  pos: Map<string, Box>;
  /** One column per subsystem, left to right. */
  columns: Column[];
  /** Modules in draw order (column, then row). */
  order: string[];
  metricOf: Map<string, ModuleMetric>;
  clusterOf: Map<string, number>;
  /** Module → index of the cycle (SCC) it belongs to; absent = not in a cycle. */
  cycleOf: Map<string, number>;
  width: number;
  height: number;
}

/**
 * Column order + row order + box geometry. Columns are subsystems sorted by
 * their deepest module's dependency layer, so arrows point right at what they
 * depend on; net flow only breaks ties (it was the whole ordering before
 * layers existed, and it can't tell a chain apart from a fan).
 */
function layout(map: ModuleMap): Layout {
  const metricOf = new Map<string, ModuleMetric>(map.metrics.map((m) => [m.module, m]));
  const clusterOf = new Map<string, number>();
  map.clusters.forEach((c) => c.modules.forEach((m) => clusterOf.set(m, c.id)));
  const cycleOf = new Map<string, number>();
  map.cycles.forEach((cyc, i) => cyc.forEach((m) => cycleOf.set(m, i)));
  const layerOf = (m: string): number => metricOf.get(m)?.layer ?? 0;

  const netFlow = new Map<number, number>();
  for (const e of map.edges) {
    const cf = clusterOf.get(e.from);
    const ct = clusterOf.get(e.to);
    if (cf === undefined || ct === undefined || cf === ct) continue;
    netFlow.set(cf, (netFlow.get(cf) ?? 0) - e.weight);
    netFlow.set(ct, (netFlow.get(ct) ?? 0) + e.weight);
  }
  const depth = new Map<number, number>();
  for (const c of map.clusters) {
    depth.set(c.id, c.modules.length ? Math.max(...c.modules.map(layerOf)) : 0);
  }
  const orderedClusters = [...map.clusters].sort(
    (a, b) =>
      (depth.get(b.id) ?? 0) - (depth.get(a.id) ?? 0) ||
      (netFlow.get(a.id) ?? 0) - (netFlow.get(b.id) ?? 0) ||
      a.id - b.id
  );

  // Node height carries module size (sqrt, so a 400-symbol module doesn't
  // dwarf the rest); no size data → every node at the base height.
  const maxSymbols = map.metrics.reduce((m, x) => Math.max(m, x.symbols), 0);
  const heightOf = (m: string): number => {
    const s = metricOf.get(m)?.symbols ?? 0;
    if (!maxSymbols || !s) return ROW_MIN;
    return Math.round(ROW_MIN + (ROW_MAX - ROW_MIN) * Math.sqrt(s / maxSymbols));
  };

  const pos = new Map<string, Box>();
  const order: string[] = [];
  const columns: Column[] = [];
  let maxBottom = PAD_TOP;
  orderedClusters.forEach((c, col) => {
    const x = PAD_LEFT + col * (COL_W + GAP_X);
    // Deepest (most dependent) module first: within a column the flow reads
    // top-down the same way the columns read left-right.
    const modules = [...c.modules].sort((a, b) => layerOf(b) - layerOf(a) || a.localeCompare(b));
    let y = PAD_TOP;
    for (const m of modules) {
      const h = heightOf(m);
      pos.set(m, { x, y, w: COL_W, h });
      order.push(m);
      y += h + GAP_Y;
    }
    columns.push({ id: c.id, x, w: COL_W, top: PAD_TOP, bottom: y - GAP_Y, count: c.modules.length });
    maxBottom = Math.max(maxBottom, y);
  });

  return {
    pos,
    columns,
    order,
    metricOf,
    clusterOf,
    cycleOf,
    width: Math.max(720, PAD_LEFT * 2 + Math.max(1, orderedClusters.length) * (COL_W + GAP_X) - GAP_X),
    height: maxBottom + 32,
  };
}

/** Dashed frame + collapsible header behind each subsystem column. */
function renderPanels(columns: Column[]): string {
  return columns
    .map(
      (c) =>
        `<g class="panel" data-cluster="${c.id}">` +
        `<rect class="panelbg" x="${c.x - 12}" y="${c.top - 30}" width="${c.w + 24}" height="${Math.max(0, c.bottom - c.top) + 42}" rx="10" stroke="${clusterColor(c.id)}"/>` +
        `<text class="cluster" data-cluster="${c.id}" x="${c.x - 2}" y="${c.top - 12}" tabindex="0" role="button">` +
        `<tspan fill="${clusterColor(c.id)}">■</tspan><tspan> subsystem ${c.id + 1} (${c.count}) ▾</tspan></text>` +
        `</g>`
    )
    .join('\n');
}

/**
 * Three routings, so direction stays readable instead of every edge being a
 * left-to-right blob: forward (target column to the right), lateral (same
 * column — arc out the right side), backward (target to the left — leave from
 * the left side, dip under, arrive at the target's right side). Backward and
 * lateral edges are exactly the ones worth noticing, so they must not look
 * like the forward ones. The 7px inset leaves room for the arrow marker.
 */
function edgePath(a: Box, b: Box): string {
  const y1 = a.y + a.h / 2;
  const y2 = b.y + b.h / 2;
  if (b.x > a.x) {
    const x1 = a.x + a.w;
    const mx = (x1 + b.x) / 2;
    return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${b.x - 7} ${y2}`;
  }
  if (b.x === a.x) {
    const x1 = a.x + a.w;
    const bow = x1 + 28 + Math.min(40, Math.abs(y2 - y1) / 4);
    return `M ${x1} ${y1} C ${bow} ${y1}, ${bow} ${y2}, ${x1 + 7} ${y2}`;
  }
  const x2 = b.x + b.w;
  const mx = (a.x + x2) / 2;
  const dip = Math.max(y1, y2) + 26;
  return `M ${a.x} ${y1} C ${mx} ${dip}, ${mx} ${dip}, ${x2 + 7} ${y2}`;
}

function renderEdges(map: ModuleMap, l: Layout): string {
  const cuts = new Set(map.cycleCuts.map((e) => `${e.from} ${e.to}`));
  return map.edges
    .map((e) => {
      const a = l.pos.get(e.from);
      const b = l.pos.get(e.to);
      if (!a || !b) return '';
      const cut = cuts.has(`${e.from} ${e.to}`);
      // A cycle outranks drift: both endpoints in one SCC means this edge is
      // part of a real circular dependency, which is a fact, not a judgement.
      const inCycle = l.cycleOf.has(e.from) && l.cycleOf.get(e.from) === l.cycleOf.get(e.to);
      const drift = l.clusterOf.get(e.from) !== l.clusterOf.get(e.to);
      const kind = inCycle ? 'cyc' : drift ? 'drift' : 'dep';
      const sw = Math.min(1 + Math.log2(e.weight + 1), 5).toFixed(1);
      const why = cut
        ? ', in a cycle — cutting this edge helps break it'
        : inCycle
          ? ', in a cycle'
          : drift
            ? ', cross-subsystem'
            : '';
      return (
        `<path class="edge ${kind}${cut ? ' cut' : ''}" data-weight="${e.weight}" data-from="${esc(e.from)}" data-to="${esc(e.to)}"` +
        ` marker-end="url(#arrow-${kind})" stroke-width="${sw}" d="${edgePath(a, b)}">` +
        `<title>${esc(e.from)} → ${esc(e.to)} (×${e.weight}${why})</title></path>`
      );
    })
    .join('\n');
}

function nodeTooltip(m: string, k: ModuleMetric | undefined, cluster: number, inCycle: boolean): string {
  if (!k) return m;
  return (
    `${m}\nsubsystem ${cluster + 1} · layer ${k.layer}${inCycle ? ' · in a cycle' : ''}\n` +
    `${k.fanIn} module(s) depend on it, it depends on ${k.fanOut}\n` +
    `instability ${k.instability.toFixed(2)} (0 = foundation, 1 = leaf)` +
    (k.cohesion === null ? '' : `\ncohesion ${k.cohesion.toFixed(2)} (share of its dependencies that stay inside)`) +
    (k.files ? `\n${k.files} file(s), ${k.symbols} symbol(s)` : '')
  );
}

function renderNodes(l: Layout): string {
  return l.order
    .map((m) => {
      const b = l.pos.get(m)!;
      const k = l.metricOf.get(m);
      const cid = l.clusterOf.get(m) ?? 0;
      const cyc = l.cycleOf.has(m);
      const meta = k ? `${k.fanIn}←  →${k.fanOut}` : '';
      return (
        `<g class="modrow${cyc ? ' incycle' : ''}" data-module="${esc(m)}" data-cluster="${cid}"` +
        ` data-layer="${k?.layer ?? 0}" data-search="${esc(m.toLowerCase())}" tabindex="0" role="button">` +
        `<title>${esc(nodeTooltip(m, k, cid, cyc))}</title>` +
        `<rect class="mod" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6"/>` +
        `<rect class="accent" x="${b.x}" y="${b.y}" width="4" height="${b.h}" fill="${clusterColor(cid)}"/>` +
        `<text class="name" x="${b.x + 12}" y="${b.y + b.h / 2 + 4}">${esc(shortLabel(m))}</text>` +
        `<text class="meta" x="${b.x + b.w - 10}" y="${b.y + b.h / 2 + 4}" text-anchor="end">${esc(meta)}</text>` +
        `</g>`
      );
    })
    .join('\n');
}

/** Header chips: the three numbers worth acting on, each with its definition in the tooltip. */
function renderStats(map: ModuleMap): string {
  const pct = (map.driftRatio * 100).toFixed(0);
  const layoutPct = (map.layoutDrift * 100).toFixed(0);
  const cycleModules = map.cycles.reduce((s, c) => s + c.length, 0);
  const cycles = map.cycles.length;
  return (
    `<span class="chip${map.driftRatio > 0.3 ? ' warn' : ''}" title="Share of dependency weight that crosses a detected subsystem boundary.">drift ${pct}%</span>` +
    `<span class="chip" title="Adjusted Rand Index between the detected subsystems and the folder layout. 100% = the folders are the architecture.">layout agreement ${layoutPct}%</span>` +
    `<span class="chip${cycles ? ' cyc' : ''}" title="Strongly-connected groups of modules — no layering can be valid while these exist.">${cycles} cycle(s)${cycles ? ` over ${cycleModules} modules` : ''}</span>` +
    (cycles
      ? `<span class="chip cyc" title="${map.cycleCuts.map((e) => `${e.from} → ${e.to} (×${e.weight})`).join(', ')}">${map.cycleCuts.length} edge(s) to cut</span>`
      : '')
  );
}

const STYLE = `
  body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground, #ccc); background: var(--vscode-editor-background, #1e1e1e); margin: 0; padding: 12px; overflow: hidden; }
  h2 { font-size: 14px; margin: 0 0 6px; font-weight: 600; }
  .stats { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .chip { font-size: 11px; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--vscode-panel-border, #444); opacity: .9; }
  .chip.warn { border-color: var(--vscode-charts-red, #f48771); color: var(--vscode-charts-red, #f48771); }
  .chip.cyc { border-color: var(--vscode-charts-yellow, #d7ba7d); color: var(--vscode-charts-yellow, #d7ba7d); }
  .controls { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; font-size: 12px; margin-bottom: 6px; }
  .controls input[type="range"] { width: 120px; vertical-align: middle; }
  .controls input[type="search"], .controls select, .controls button {
    font-family: inherit; font-size: 12px; padding: 2px 6px;
    color: var(--vscode-input-foreground, #ccc); background: var(--vscode-input-background, #3c3c3c);
    border: 1px solid var(--vscode-input-border, #555); border-radius: 3px;
  }
  .controls button { cursor: pointer; background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ccc); }
  .hint { font-size: 11px; opacity: .65; margin-bottom: 6px; }
  .legend { display: inline-flex; align-items: center; gap: 12px; font-size: 11px; opacity: .8; margin-left: auto; }
  .legend i { display: inline-block; width: 16px; height: 0; border-top: 2px solid; margin-right: 4px; vertical-align: middle; }
  svg { width: 100%; height: calc(100vh - 160px); display: block; cursor: grab; touch-action: none; }
  svg.panning { cursor: grabbing; }
  rect.mod { fill: var(--vscode-editorWidget-background, #252526); stroke: var(--vscode-panel-border, #444); cursor: pointer; }
  rect.panelbg { fill: none; stroke-opacity: .25; stroke-dasharray: 4 4; pointer-events: none; }
  .modrow:hover rect.mod, .modrow:focus rect.mod { stroke: var(--vscode-focusBorder, #4fc1ff); stroke-width: 1.5; }
  .modrow.incycle rect.mod { stroke: var(--vscode-charts-yellow, #d7ba7d); stroke-dasharray: 3 2; }
  .modrow.off, .edge.off { display: none; }
  text { fill: var(--vscode-foreground, #ccc); font-size: 12px; }
  text.meta { font-size: 10px; opacity: .55; }
  text.cluster { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; cursor: pointer; opacity: .8; }
  .edge { fill: none; }
  .edge.dep { stroke: var(--vscode-charts-blue, #4fc1ff); opacity: .35; }
  .edge.drift { stroke: var(--vscode-charts-red, #f48771); opacity: .75; }
  .edge.cyc { stroke: var(--vscode-charts-yellow, #d7ba7d); opacity: .85; stroke-dasharray: 6 3; }
  /* The suggested cut: the lightest edges whose removal makes the graph acyclic. */
  .edge.cut { stroke: var(--vscode-charts-orange, #d18616); opacity: 1; stroke-dasharray: 2 3; }
  /* Focus mode: everything off the focused module's neighbourhood recedes. */
  svg.focusing .modrow:not(.hit), svg.focusing .edge:not(.hit) { opacity: .07; }
  svg.focusing .modrow.hit rect.mod { stroke: var(--vscode-focusBorder, #4fc1ff); }
`;

const MARKERS = ['dep', 'drift', 'cyc']
  .map((kind) => {
    const fill =
      kind === 'dep'
        ? 'var(--vscode-charts-blue, #4fc1ff)'
        : kind === 'drift'
          ? 'var(--vscode-charts-red, #f48771)'
          : 'var(--vscode-charts-yellow, #d7ba7d)';
    return `<marker id="arrow-${kind}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 8 4 L 0 7 z" fill="${fill}"${kind === 'dep' ? ' opacity=".6"' : ''}/></marker>`;
  })
  .join('');

/**
 * The whole interaction layer. One `apply()` pass drives every control (a node
 * hides if its subsystem is collapsed or the search excludes it; an edge hides
 * unless it passes kind + weight AND both endpoints are visible) — keeping it
 * in one place is what makes the controls composable instead of each toggling
 * its own class and fighting the others.
 */
const SCRIPT = String.raw`
(function () {
  var vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  var svg = document.querySelector('svg');
  var viewport = document.getElementById('viewport');
  var slider = document.getElementById('minWeight');
  var sliderVal = document.getElementById('minWeightVal');
  var search = document.getElementById('search');
  var show = document.getElementById('show');
  var edges = Array.prototype.slice.call(svg.querySelectorAll('.edge'));
  var rows = Array.prototype.slice.call(svg.querySelectorAll('.modrow'));
  var collapsed = {};
  var pinned = null;

  function apply() {
    var min = Number(slider.value);
    var q = search.value.trim().toLowerCase();
    var kind = show.value;
    sliderVal.textContent = String(min);

    var visible = {};
    rows.forEach(function (g) {
      var hidden = collapsed[g.getAttribute('data-cluster')] ||
        (q && g.getAttribute('data-search').indexOf(q) < 0);
      g.classList.toggle('off', !!hidden);
      visible[g.getAttribute('data-module')] = !hidden;
    });
    edges.forEach(function (p) {
      var okKind = kind === 'all' || p.classList.contains(kind);
      var okWeight = Number(p.getAttribute('data-weight')) >= min;
      var ends = visible[p.getAttribute('data-from')] && visible[p.getAttribute('data-to')];
      p.classList.toggle('off', !(okKind && okWeight && ends));
    });
    if (pinned) focus(pinned);
  }

  function focus(mod) {
    var keep = {};
    keep[mod] = true;
    edges.forEach(function (p) {
      if (p.classList.contains('off')) return;
      var f = p.getAttribute('data-from'), t = p.getAttribute('data-to');
      if (f === mod) keep[t] = true;
      else if (t === mod) keep[f] = true;
    });
    edges.forEach(function (p) {
      var f = p.getAttribute('data-from'), t = p.getAttribute('data-to');
      p.classList.toggle('hit', !p.classList.contains('off') && (f === mod || t === mod));
    });
    rows.forEach(function (g) { g.classList.toggle('hit', !!keep[g.getAttribute('data-module')]); });
    svg.classList.add('focusing');
  }

  function unfocus() {
    if (pinned) return;
    svg.classList.remove('focusing');
    rows.forEach(function (g) { g.classList.remove('hit'); });
    edges.forEach(function (p) { p.classList.remove('hit'); });
  }

  function reveal(mod) {
    if (vscode) vscode.postMessage({ type: 'reveal', module: mod });
  }

  slider.addEventListener('input', apply);
  search.addEventListener('input', apply);
  show.addEventListener('change', apply);

  rows.forEach(function (g) {
    var mod = g.getAttribute('data-module');
    g.addEventListener('mouseenter', function () { if (!pinned) focus(mod); });
    g.addEventListener('mouseleave', unfocus);
    g.addEventListener('click', function (e) {
      e.stopPropagation();
      pinned = pinned === mod ? null : mod;
      if (pinned) focus(mod); else unfocus();
    });
    g.addEventListener('dblclick', function () { reveal(mod); });
    g.addEventListener('focus', function () { if (!pinned) focus(mod); });
    g.addEventListener('blur', unfocus);
    g.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reveal(mod); }
    });
  });

  svg.querySelectorAll('.cluster').forEach(function (labelEl) {
    var caption = labelEl.lastChild;
    function toggle() {
      var id = labelEl.getAttribute('data-cluster');
      collapsed[id] = !collapsed[id];
      caption.textContent = caption.textContent.replace(/[▾▸]/, collapsed[id] ? '▸' : '▾');
      apply();
    }
    labelEl.addEventListener('click', toggle);
    labelEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  });

  // Pan/zoom is a transform on the viewport group, so the SVG keeps its
  // viewBox and nothing is re-laid-out. Wheel zoom is gated on ctrl/meta so
  // plain scrolling still scrolls.
  var tx = 0, ty = 0, k = 1;
  function render() {
    viewport.setAttribute('transform', 'translate(' + tx + ',' + ty + ') scale(' + k + ')');
  }
  function zoomBy(factor, cx, cy) {
    var next = Math.min(4, Math.max(0.15, k * factor));
    tx = cx - (cx - tx) * (next / k);
    ty = cy - (cy - ty) * (next / k);
    k = next;
    render();
  }
  function centre() { var r = svg.getBoundingClientRect(); return [r.width / 2, r.height / 2]; }

  document.getElementById('zoomIn').addEventListener('click', function () { var c = centre(); zoomBy(1.2, c[0], c[1]); });
  document.getElementById('zoomOut').addEventListener('click', function () { var c = centre(); zoomBy(1 / 1.2, c[0], c[1]); });
  document.getElementById('reset').addEventListener('click', function () {
    tx = 0; ty = 0; k = 1; render();
    pinned = null; unfocus();
    search.value = ''; slider.value = 1; show.value = 'all'; apply();
  });

  svg.addEventListener('wheel', function (e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    var r = svg.getBoundingClientRect();
    zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  var drag = null;
  svg.addEventListener('pointerdown', function (e) {
    if (e.target.closest('.modrow') || e.target.closest('.cluster')) return;
    drag = { x: e.clientX - tx, y: e.clientY - ty };
    svg.classList.add('panning');
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', function (e) {
    if (!drag) return;
    tx = e.clientX - drag.x;
    ty = e.clientY - drag.y;
    render();
  });
  svg.addEventListener('pointerup', function (e) {
    drag = null;
    svg.classList.remove('panning');
    if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
  });
  svg.addEventListener('click', function (e) {
    if (e.target.closest('.modrow')) return;
    pinned = null;
    unfocus();
  });

  apply();
})();
`;

export function moduleMapHtml(map: ModuleMap): string {
  const l = layout(map);
  const maxWeight = Math.max(1, ...map.edges.map((e) => e.weight));

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>
  <h2>Module map — ${map.modules.length} modules, ${map.clusters.length} subsystem(s)</h2>
  <div class="stats">${renderStats(map)}</div>
  <div class="controls">
    <input id="search" type="search" placeholder="filter modules…" aria-label="filter modules"/>
    <label for="show">show</label>
    <select id="show">
      <option value="all">all edges</option>
      <option value="drift">cross-subsystem only</option>
      <option value="cyc">cycles only</option>
      <option value="cut">cycle-breaking cuts only</option>
    </select>
    <label for="minWeight">min weight</label>
    <input id="minWeight" type="range" min="1" max="${maxWeight}" value="1" step="1"/>
    <span id="minWeightVal">1</span>
    <button id="zoomOut" title="zoom out">−</button>
    <button id="zoomIn" title="zoom in">+</button>
    <button id="reset">reset view</button>
    <span class="legend">
      <span><i style="border-color: var(--vscode-charts-blue, #4fc1ff)"></i>in-subsystem</span>
      <span><i style="border-color: var(--vscode-charts-red, #f48771)"></i>drift</span>
      <span><i style="border-color: var(--vscode-charts-yellow, #d7ba7d)"></i>cycle</span>
      <span><i style="border-color: var(--vscode-charts-orange, #d18616)"></i>suggested cut</span>
    </span>
  </div>
  <div class="hint">columns flow left → right toward what they depend on · node height = module size · <b>hover</b>/<b>click</b> a module to isolate its neighbourhood · <b>Enter</b> or double-click reveals it · click a subsystem header to collapse it · drag to pan, ctrl/⌘+wheel to zoom</div>
  <svg viewBox="0 0 ${l.width} ${l.height}" preserveAspectRatio="xMinYMin meet">
    <defs>${MARKERS}</defs>
    <g id="viewport">
${renderPanels(l.columns)}
${renderEdges(map, l)}
${renderNodes(l)}
    </g>
  </svg>
<script>${SCRIPT}</script>
</body></html>`;
}
