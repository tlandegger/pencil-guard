/*
 * Pencil Guard for sudoku.coach
 *
 * sudoku.coach's built-in "AUTO" candidate elimination removes a placed digit
 * from the candidates of every cell in the same row, column and box. It does
 * not honour Anti-Knight or Anti-King constraints. This content script watches
 * the grid and removes candidates that a placed digit rules out by a knight's
 * move (Anti-Knight) or a king's move (Anti-King), and, for Nonconsecutive
 * puzzles, removes the two adjacent digits (d-1, d+1) from orthogonal
 * neighbours. In Odd/Even puzzles it prunes even candidates from odd (circle)
 * cells and odd candidates from even (square) cells.
 *
 * The site's JavaScript is minified with unstable names, so nothing here relies
 * on class names or internals. The grid is read purely geometrically from the
 * SVG (grid lines, text positions, font sizes), and candidates are removed by
 * driving the site's own input handling with synthetic mouse events (to select
 * cells) and a synthetic Ctrl+digit keydown (the site's "toggle cell
 * candidate" shortcut). Every removal therefore lands in the site's undo
 * history like a normal move.
 */
(() => {
  'use strict';

  if (window.__pencilGuardLoaded) return;
  window.__pencilGuardLoaded = true;

  // ------------------------------------------------------------------ settings
  const DEFAULTS = { enabled: true, knight: 'auto', king: 'auto', noncon: 'auto', parity: 'auto', badge: true, warnWrong: true, quadHighlight: true };
  const settings = Object.assign({}, DEFAULTS);
  const hasStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync;

  function loadSettings(cb) {
    if (!hasStorage) { cb(); return; }
    chrome.storage.sync.get(DEFAULTS, (items) => {
      Object.assign(settings, items || {});
      cb();
    });
  }

  if (hasStorage) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const k of Object.keys(changes)) settings[k] = changes[k].newValue;
      history.sig = null; // allow eliminations to be re-evaluated
      updateBadge();
      schedule();
    });
  }

  // ------------------------------------------------------------ rule detection
  // The page lists active global constraints by name (e.g. in the "Constraint
  // Layers" visibility panel and the Rules dialog). Match the English names
  // plus common translations. Our own badge is excluded from the scan.
  const KNIGHT_RE = /anti[\s\-_]*(knight|springer|cavalier|caballo|cavallo|cavalo|paard|ridder)/i;
  const KING_RE = /anti[\s\-_]*(king|k[öo]e?nig|roi|rey|re|rei|koning)\b/i;
  // "Nonconsecutive" / "Non-consecutive" / "Non Consecutive" and a few translations.
  const NONCON_RE = /\b(non[\s\-_]*consecutive|nicht[\s\-_]*aufeinanderfolgend|non[\s\-_]*cons[ée]cutif|no[\s\-_]*consecutivo|non[\s\-_]*consecutivo)/i;
  // Odd / Even cells: the rules panel lists them as bare labels, so match the
  // whole text node rather than a substring.
  const PARITY_RE = /^\s*(odd|even|ungerade|gerade|impair|pair|dispari|pari|impar|par)\s*$/i;

  let rulesCache = { at: 0, knight: false, king: false, noncon: false, parity: false };

  function detectRules() {
    const now = Date.now();
    if (now - rulesCache.at < 1500) return rulesCache;
    let knight = false, king = false, noncon = false, parity = false;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const p = node.parentElement;
      if (!p) continue;
      const tag = p.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
      if (p.closest('#pencil-guard-badge')) continue;
      const t = node.nodeValue;
      if (!t || t.length > 300) continue;
      if (!knight && KNIGHT_RE.test(t)) knight = true;
      if (!king && KING_RE.test(t)) king = true;
      if (!noncon && NONCON_RE.test(t)) noncon = true;
      if (!parity && PARITY_RE.test(t)) parity = true;
      if (knight && king && noncon && parity) break;
    }
    rulesCache = { at: now, knight, king, noncon, parity };
    return rulesCache;
  }

  function resolveRules() {
    const det = detectRules();
    const pick = (mode, auto) => (mode === 'on' ? true : mode === 'off' ? false : auto);
    return {
      knight: pick(settings.knight, det.knight),
      king: pick(settings.king, det.king),
      noncon: pick(settings.noncon, det.noncon),
      parity: pick(settings.parity, det.parity),
      detected: det,
    };
  }

  // ------------------------------------------------------------- grid reading
  function findSvg() {
    let best = null, bestArea = 0;
    for (const svg of document.querySelectorAll('svg')) {
      if (svg.getElementsByTagName('line').length < 8) continue;
      const r = svg.getBoundingClientRect();
      const area = r.width * r.height;
      if (r.width < 120 || area <= bestArea) continue;
      best = svg; bestArea = area;
    }
    return best;
  }

  function num(el, attr) {
    const v = parseFloat(el.getAttribute(attr));
    return Number.isFinite(v) ? v : NaN;
  }

  // Derive the N x N cell lattice from the SVG's vertical and horizontal lines.
  function geometry(svg) {
    const lines = svg.getElementsByTagName('line');
    const vx = [], hy = [];
    let maxLen = 0;
    for (const l of lines) {
      const x1 = num(l, 'x1'), x2 = num(l, 'x2'), y1 = num(l, 'y1'), y2 = num(l, 'y2');
      if ([x1, x2, y1, y2].some((v) => Number.isNaN(v))) continue;
      if (Math.abs(x1 - x2) < 0.01) { vx.push({ p: x1, len: Math.abs(y2 - y1) }); maxLen = Math.max(maxLen, Math.abs(y2 - y1)); }
      else if (Math.abs(y1 - y2) < 0.01) { hy.push({ p: y1, len: Math.abs(x2 - x1) }); maxLen = Math.max(maxLen, Math.abs(x2 - x1)); }
    }
    const uniq = (arr) => {
      const out = [];
      for (const { p, len } of arr) {
        if (len < maxLen * 0.5) continue; // ignore short decorative segments
        if (!out.some((q) => Math.abs(q - p) < 0.5)) out.push(p);
      }
      return out.sort((a, b) => a - b);
    };
    const X = uniq(vx), Y = uniq(hy);
    if (X.length < 4 || X.length !== Y.length) return null;
    const n = X.length - 1;
    const left = X[0], top = Y[0];
    const cellW = (X[n] - left) / n, cellH = (Y[n] - top) / n;
    if (!(cellW > 5) || !(cellH > 5)) return null;
    for (let i = 1; i <= n; i++) {
      if (Math.abs(X[i] - left - i * cellW) > cellW * 0.1) return null;
      if (Math.abs(Y[i] - top - i * cellH) > cellH * 0.1) return null;
    }
    return { n, left, top, cellW, cellH };
  }

  function fontSizeEm(t) {
    const fs = t.getAttribute('font-size') || t.style.fontSize || '';
    const v = parseFloat(fs);
    if (!Number.isFinite(v)) return NaN;
    if (/em$/.test(fs)) return v;
    return NaN;
  }

  // Positions (fraction of a cell) of the 3x3 centre-candidate lattice, as
  // rendered by sudoku.coach. Used to tell centre candidates apart from corner
  // marks or other small text.
  const LATTICE_X = [0.24, 0.50, 0.76];
  const LATTICE_Y = [0.26, 0.52, 0.78];

  function readBoard(svg, geo) {
    const { n, left, top, cellW, cellH } = geo;
    const values = new Array(n * n).fill(0);
    const cands = Array.from({ length: n * n }, () => new Set());
    for (const t of svg.getElementsByTagName('text')) {
      const txt = (t.textContent || '').trim();
      if (!/^\d{1,2}$/.test(txt)) continue;
      const d = +txt;
      if (d < 1 || d > n) continue;
      const x = num(t, 'x'), y = num(t, 'y');
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      const fx = (x - left) / cellW, fy = (y - top) / cellH;
      if (fx < 0 || fy < 0 || fx >= n || fy >= n) continue;
      const c = Math.floor(fx), r = Math.floor(fy);
      const ox = fx - c, oy = fy - r;
      const idx = r * n + c;

      let em = fontSizeEm(t);
      let big;
      if (Number.isFinite(em)) big = em >= 0.8;
      else {
        try { big = t.getBBox().height > cellH * 0.45; } catch (e) { big = false; }
      }

      if (big) {
        if (Math.abs(ox - 0.5) < 0.2 && Math.abs(oy - 0.5) < 0.2) values[idx] = d;
        continue;
      }
      // Small text: accept as a centre candidate only if it sits where the site
      // draws centre candidate `d` (the same 3x3 lattice is used for every grid
      // size up to 9x9).
      const k = d - 1;
      if (Math.abs(ox - LATTICE_X[k % 3]) > 0.09 || Math.abs(oy - LATTICE_Y[Math.floor(k / 3)]) > 0.09) continue;
      cands[idx].add(d);
    }
    return { values, cands };
  }

  // Selected cells are outlined with four thin rects per cell.
  function readSelection(svg, geo) {
    const { n, left, top, cellW, cellH } = geo;
    const set = new Set();
    for (const r of svg.getElementsByTagName('rect')) {
      const w = num(r, 'width'), h = num(r, 'height');
      if (!(w > 0 && h > 0)) continue;
      const thin = Math.min(w, h), long = Math.max(w, h);
      if (thin > cellW * 0.2 || long < cellW * 0.8 || long > cellW * 1.25) continue;
      const cx = num(r, 'x') + w / 2, cy = num(r, 'y') + h / 2;
      const c = Math.floor((cx - left) / cellW), rr = Math.floor((cy - top) / cellH);
      if (c < 0 || rr < 0 || c >= n || rr >= n) continue;
      set.add(rr * n + c);
    }
    return [...set];
  }

  // Odd cells are drawn as a filled circle centred in the cell, even cells as a
  // filled square. Returns parity per cell index: 1 = odd, 2 = even, 0 = none.
  // Quadruple circles sit on grid corners and carry text, so they never match.
  function readParity(svg, geo) {
    const { n, left, top, cellW, cellH } = geo;
    const parity = new Array(n * n).fill(0);
    const centred = (cx, cy) => {
      const fx = (cx - left) / cellW, fy = (cy - top) / cellH;
      const c = Math.floor(fx), r = Math.floor(fy);
      if (c < 0 || r < 0 || c >= n || r >= n) return -1;
      if (Math.abs(fx - c - 0.5) > 0.08 || Math.abs(fy - r - 0.5) > 0.08) return -1;
      return r * n + c;
    };
    const filled = (el) => { const f = el.getAttribute('fill'); return f && f !== 'none' && f !== 'transparent'; };
    for (const c of svg.getElementsByTagName('circle')) {
      const r = num(c, 'r');
      if (!(r > cellW * 0.2 && r < cellW * 0.42) || !filled(c)) continue;
      const idx = centred(num(c, 'cx'), num(c, 'cy'));
      if (idx >= 0) parity[idx] = 1;
    }
    for (const q of svg.getElementsByTagName('rect')) {
      if (q.hasAttribute(QUAD_MARK)) continue;
      const w = num(q, 'width'), h = num(q, 'height');
      if (!(w > cellW * 0.4 && w < cellW * 0.8 && h > cellH * 0.4 && h < cellH * 0.8) || !filled(q)) continue;
      if (Math.abs(w - h) > cellW * 0.05) continue;
      const idx = centred(num(q, 'x') + w / 2, num(q, 'y') + h / 2);
      if (idx >= 0) parity[idx] = 2;
    }
    return parity;
  }

  // ------------------------------------------------------------ neighbourhoods
  const KNIGHT_D = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
  const KING_D = [[-1, -1], [-1, 1], [1, -1], [1, 1]]; // orthogonal neighbours are already row/column peers
  const ORTHO_D = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  // Every (cell, digit) pair that a digit d placed at idx rules out.
  function eliminations(idx, d, n, rules) {
    const r = Math.floor(idx / n), c = idx % n;
    const out = [];
    const add = (dr, dc, digit) => {
      const rr = r + dr, cc = c + dc;
      if (digit >= 1 && digit <= n && rr >= 0 && cc >= 0 && rr < n && cc < n) out.push([rr * n + cc, digit]);
    };
    if (rules.knight) for (const [dr, dc] of KNIGHT_D) add(dr, dc, d);
    if (rules.king) for (const [dr, dc] of KING_D) add(dr, dc, d);
    if (rules.noncon) for (const [dr, dc] of ORTHO_D) { add(dr, dc, d - 1); add(dr, dc, d + 1); }
    return out;
  }

  // ------------------------------------------------------------- input driving
  function toClient(svg, ux, uy) {
    const m = svg.getScreenCTM();
    const p = svg.createSVGPoint();
    p.x = ux; p.y = uy;
    const q = m ? p.matrixTransform(m) : p;
    return [q.x, q.y];
  }

  function clickCell(svg, geo, idx, addToSelection) {
    const { n, left, top, cellW, cellH } = geo;
    const r = Math.floor(idx / n), c = idx % n;
    const [cx, cy] = toClient(svg, left + (c + 0.5) * cellW, top + (r + 0.5) * cellH);
    let el = document.elementFromPoint(cx, cy);
    if (!el || !svg.contains(el)) el = svg;
    const init = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0, ctrlKey: !!addToSelection };
    el.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1 }, init)));
    el.dispatchEvent(new MouseEvent('mouseup', Object.assign({ buttons: 0 }, init)));
  }

  function pressKey(key, mods) {
    const isDigit = /^\d$/.test(key);
    const code = isDigit ? 'Digit' + key : key;
    const keyCode = isDigit ? 48 + Number(key) : key === 'Escape' ? 27 : key.toUpperCase().charCodeAt(0);
    const init = Object.assign({ key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, view: window }, mods || {});
    document.body.dispatchEvent(new KeyboardEvent('keydown', init));
    if (key === 'Escape') keyHighlight = 0; // the site clears its digit highlight on Escape
  }

  // ------------------------------------------------------------------- engine
  // `history` remembers which (cell, digit) pairs we already removed for the
  // current arrangement of placed digits. Without it, the user's Ctrl+Z (which
  // brings the candidates back while the digit is still placed) would be
  // immediately undone by us, and undo could never get past our step.
  const history = { sig: null, done: new Set() };
  const stats = { removed: 0, lastRun: 0, gridFound: false, errors: 0, solution: null };

  // ----------------------------------------------------- solution / warnings
  // Shared puzzles (/s/<id>) of any size from 4x4 to 9x9 get their solution
  // from the site's puzzle API. Classic 9x9 puzzles carry their 81 givens in
  // the URL and are solved locally. The solution is only trusted while its
  // length matches the grid and it agrees with the digits on the board, so a
  // stale one (after in-app navigation to another puzzle) is ignored.
  const solution = { url: null, digits: null, source: null };

  function readSolutionFromPage() {
    for (const sc of document.scripts) {
      const t = sc.textContent;
      if (!t || t.indexOf('"solution"') < 0) continue;
      const m = /"solution"\s*:\s*"(\d+)"/.exec(t);
      if (m) return m[1];
    }
    return null;
  }

  function solveClassic(puzzle) {
    const g = puzzle.split('').map(Number);
    const rows = new Array(9).fill(0), cols = new Array(9).fill(0), boxes = new Array(9).fill(0);
    const boxOf = (i) => (((i / 9) | 0) / 3 | 0) * 3 + ((i % 9) / 3 | 0);
    for (let i = 0; i < 81; i++) {
      const d = g[i];
      if (!d) continue;
      const r = (i / 9) | 0, c = i % 9, b = boxOf(i), bit = 1 << d;
      if ((rows[r] | cols[c] | boxes[b]) & bit) return null;
      rows[r] |= bit; cols[c] |= bit; boxes[b] |= bit;
    }
    let steps = 0;
    function solve() {
      if (++steps > 2000000) return false;
      let best = -1, bestCount = 10, bestMask = 0;
      for (let i = 0; i < 81; i++) {
        if (g[i]) continue;
        const used = rows[(i / 9) | 0] | cols[i % 9] | boxes[boxOf(i)];
        let cnt = 0, mask = 0;
        for (let d = 1; d <= 9; d++) if (!(used & (1 << d))) { cnt++; mask |= 1 << d; }
        if (cnt < bestCount) { best = i; bestCount = cnt; bestMask = mask; if (cnt <= 1) break; }
      }
      if (best < 0) return true;
      if (bestCount === 0) return false;
      const r = (best / 9) | 0, c = best % 9, b = boxOf(best);
      for (let d = 1; d <= 9; d++) {
        const bit = 1 << d;
        if (!(bestMask & bit)) continue;
        g[best] = d; rows[r] |= bit; cols[c] |= bit; boxes[b] |= bit;
        if (solve()) return true;
        rows[r] &= ~bit; cols[c] &= ~bit; boxes[b] &= ~bit; g[best] = 0;
      }
      return false;
    }
    return solve() ? g.join('') : null;
  }

  // (Re)load the solution whenever the URL changes. The inline script is
  // removed by the site shortly after load, so for shared puzzles
  // (/s/<id>) we ask the site's own puzzle API, which returns the solution.
  // The previous solution is dropped on every URL change; the board
  // consistency check below additionally rejects one that contradicts the
  // placed digits.
  function ensureSolution(rules) {
    if (solution.url === location.href) return;
    const url = location.href;
    solution.url = url;
    solution.digits = null; solution.source = null;
    let digits = readSolutionFromPage();
    if (digits) { solution.digits = digits; solution.source = 'page'; return; }
    const play = /\/play\/(\d{81})(?:[/?#]|$)/.exec(url);
    if (play && !rules.knight && !rules.king && !rules.noncon) {
      digits = solveClassic(play[1]);
      if (digits) { solution.digits = digits; solution.source = 'solver'; return; }
    }
    const shared = /\/s\/([A-Za-z0-9_-]+)(?:[/?#]|$)/.exec(url);
    if (shared) {
      fetch(location.origin + '/beapi/get-sudoku/' + shared[1], { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.text() : ''))
        .then((body) => {
          if (solution.url !== url) return;
          const m = /"solution"\s*:\s*"(\d+)"/.exec(body);
          if (m) { solution.digits = m[1]; solution.source = 'page'; schedule(); }
        })
        .catch(() => {});
    }
  }

  // Returns the 81-digit solution if one is known and consistent with the
  // board (a few wrong entries are tolerated), else null.
  function currentSolution(values, rules, n) {
    ensureSolution(rules);
    const s = solution.digits;
    if (!s || s.length !== n * n) return null; // must match the grid size (4x4 .. 9x9)
    let match = 0, miss = 0;
    for (let i = 0; i < n * n; i++) {
      if (!values[i]) continue;
      if (values[i] === +s[i]) match++; else miss++;
    }
    // Puzzles with no givens are common in variants, so no minimum match
    // count; the solution is tied to the URL's puzzle id instead.
    if (miss > Math.max(2, Math.floor((match + miss) * 0.15))) return null;
    return s;
  }

  let toastBox = null;
  function warn(svg, geo, hits) {
    const n = geo.n;
    const rc = (h) => `r${Math.floor(h.cell / n) + 1}c${(h.cell % n) + 1}`;
    let msg;
    if (hits.length === 1) {
      const h = hits[0];
      msg = h.ours
        ? `⚠ Auto-removed ${h.digit} from ${rc(h)}, but ${h.digit} is the solution there. A placed digit must be wrong.`
        : `⚠ Candidate ${h.digit} was removed from ${rc(h)}, but ${h.digit} is the correct value there.`;
    } else {
      const list = hits.slice(0, 6).map((h) => `${h.digit} from ${rc(h)}`).join(', ');
      msg = `⚠ Correct candidates were removed: ${list}${hits.length > 6 ? ', …' : ''}. A placed digit is probably wrong.`;
    }
    if (!toastBox) {
      toastBox = document.createElement('div');
      toastBox.id = 'pencil-guard-toasts';
      toastBox.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;'
        + 'display:flex;flex-direction:column;gap:6px;pointer-events:none;';
      document.documentElement.appendChild(toastBox);
    }
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'font:14px/1.4 system-ui,sans-serif;background:#c62828;color:#fff;padding:8px 14px;'
      + 'border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.4);pointer-events:auto;cursor:pointer;max-width:70vw;';
    t.addEventListener('click', () => t.remove());
    toastBox.appendChild(t);
    setTimeout(() => t.remove(), 8000);
    for (const h of hits) {
      try {
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', geo.left + (h.cell % n) * geo.cellW);
        rect.setAttribute('y', geo.top + Math.floor(h.cell / n) * geo.cellH);
        rect.setAttribute('width', geo.cellW);
        rect.setAttribute('height', geo.cellH);
        rect.setAttribute('fill', 'rgba(220,40,40,.35)');
        rect.setAttribute('pointer-events', 'none');
        rect.setAttribute('class', 'pencil-guard-flash');
        svg.appendChild(rect);
        setTimeout(() => rect.remove(), 4000);
      } catch (e) { /* purely cosmetic */ }
    }
  }

  // Compare the candidates with the previous snapshot and warn when a
  // candidate that equals the cell's solution digit has disappeared.
  const snap = { svg: null, cands: null };
  function checkForWrongRemovals(svg, geo, values, cands, rules) {
    const prev = snap.svg === svg ? snap.cands : null;
    snap.svg = svg;
    snap.cands = cands;
    const sol = currentSolution(values, rules, geo.n);
    stats.solution = sol ? solution.source : null;
    if (!prev || !sol || !settings.warnWrong) return;
    const n = geo.n;
    let emptied = 0;
    const hits = [];
    for (let i = 0; i < n * n; i++) {
      if (values[i]) continue;
      const p = prev[i], c = cands[i];
      if (p.size && !c.size) emptied++;
      const d = +sol[i];
      if (p.has(d) && !c.has(d)) hits.push({ cell: i, digit: d, ours: history.done.has(i + ':' + d) });
    }
    // Many cells emptied at once means "clear all candidates", not a slip.
    if (!hits.length || emptied > 3) return;
    stats.errors += hits.length;
    warn(svg, geo, hits);
  }
  window.__pencilGuardStats = stats; // debugging aid (isolated world; invisible to the page)

  // ------------------------------------------------------ quadruple highlight
  // sudoku.coach's "Highlight Digit" (Alt+digit, or the highlight tool) puts an
  // amber pill behind every candidate of one digit. It does not touch Quadruple
  // clues, so we put a teal pill behind the matching digit(s) inside each clue
  // circle.
  const QUAD_PILL = 'rgb(150, 226, 238)';
  const QUAD_MARK = 'data-pencil-guard-quad';   // marks the pills we insert next to clue text

  // Quadruple clues are a centre-anchored <text> of 1-4 digits sitting on an
  // interior grid intersection, inside a <circle> drawn on that intersection.
  // Killer cage totals also sit near intersections but are start-anchored and
  // have no circle, so both checks are required. Our own pills are skipped.
  function findQuadruples(svg, geo) {
    const { n, left, top, cellW, cellH } = geo;
    const circleAt = new Set();
    for (const c of svg.getElementsByTagName('circle')) {
      const r = num(c, 'r');
      if (!(r > cellW * 0.2 && r < cellW * 0.5)) continue;
      const gx = (num(c, 'cx') - left) / cellW, gy = (num(c, 'cy') - top) / cellH;
      const ix = Math.round(gx), iy = Math.round(gy);
      if (Math.abs(gx - ix) < 0.1 && Math.abs(gy - iy) < 0.1) circleAt.add(ix + ',' + iy);
    }
    const out = [];
    if (!circleAt.size) return out;
    for (const t of svg.getElementsByTagName('text')) {
      if (t.hasAttribute(QUAD_MARK)) continue;
      const txt = (t.textContent || '').trim();
      if (!/^\d{1,4}$/.test(txt)) continue;
      const anchor = t.getAttribute('text-anchor');
      if (anchor && anchor !== 'middle') continue;
      const x = num(t, 'x'), y = num(t, 'y');
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      const gx = (x - left) / cellW, gy = (y - top) / cellH;
      const ix = Math.round(gx), iy = Math.round(gy);
      if (ix < 1 || iy < 1 || ix > n - 1 || iy > n - 1) continue;           // interior corners only
      if (Math.abs(gx - ix) > 0.12 || Math.abs(gy - iy) > 0.12) continue;   // must sit on the corner
      if (!circleAt.has(ix + ',' + iy)) continue;                           // must be inside a clue circle
      const digits = txt.split('').map(Number);
      if (!digits.some((d) => d >= 1 && d <= n)) continue;
      out.push({ ix, iy, digits, x: left + ix * cellW, y: top + iy * cellH, text: t });
    }
    return out;
  }

  // The site leaves no trace of the highlighted digit in the DOM unless that
  // digit has candidates (their fill changes) so, as a fallback, remember the
  // user's own Alt+digit / Escape presses. Our synthetic key events are not
  // trusted events and are ignored here; pressKey keeps this in step instead.
  let keyHighlight = 0;
  window.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) keyHighlight = +e.key;
    else if (e.key === 'Escape') keyHighlight = 0;
    else return;
    schedule(120);
  }, true);

  // Highlighted digit from candidate fills: every candidate of the highlighted
  // digit carries a fill no other digit's candidates use. Falls back to the
  // tracked keyboard state when the DOM gives no answer.
  function highlightedDigit(svg, geo) {
    const { n, left, top, cellW, cellH } = geo;
    const byDigit = new Map(); // digit -> Map(fill -> count)
    const total = new Map();   // fill -> count
    for (const t of svg.getElementsByTagName('text')) {
      const txt = (t.textContent || '').trim();
      if (!/^\d$/.test(txt)) continue;
      const em = fontSizeEm(t);
      if (!Number.isFinite(em) || em >= 0.8) continue;
      const x = num(t, 'x'), y = num(t, 'y');
      const fx = (x - left) / cellW, fy = (y - top) / cellH;
      if (fx < 0 || fy < 0 || fx >= n || fy >= n) continue;
      const fill = t.getAttribute('fill') || '';
      const d = +txt;
      if (!byDigit.has(d)) byDigit.set(d, new Map());
      const m = byDigit.get(d);
      m.set(fill, (m.get(fill) || 0) + 1);
      total.set(fill, (total.get(fill) || 0) + 1);
    }
    if (byDigit.size >= 2) {
      let normal = '', best = 0;
      for (const [f, c] of total) if (c > best) { best = c; normal = f; }
      for (const [d, m] of byDigit) {
        let odd = 0, all = 0;
        for (const [f, c] of m) { all += c; if (f !== normal) odd += c; }
        if (all >= 2 && odd === all) return d;
      }
    }
    return keyHighlight;
  }

  // Idempotent: computes the wanted set of pills and only rebuilds when it
  // changes. Pills are inserted right before the clue text, so they paint
  // above the circle and below the digits.
  function renderQuadHighlight(svg, geo) {
    const digit = settings.quadHighlight ? highlightedDigit(svg, geo) : 0;
    const quads = findQuadruples(svg, geo);
    const active = digit ? quads.filter((q) => q.digits.includes(digit)) : [];
    const want = digit + '|' + active.map((q) => q.ix + ',' + q.iy).join(';') + '|' + geo.cellW.toFixed(2);
    const pills = svg.querySelectorAll('[' + QUAD_MARK + ']');
    const expectPills = active.reduce((a, q) => a + q.digits.filter((d) => d === digit).length, 0);
    if (svg.getAttribute(QUAD_MARK + '-sig') === want && pills.length === expectPills) return;
    svg.setAttribute(QUAD_MARK + '-sig', want);
    pills.forEach((p) => p.remove());
    if (!active.length) return;
    const ns = 'http://www.w3.org/2000/svg';
    for (const q of active) {
      const t = q.text;
      q.digits.forEach((d, i) => {
        if (d !== digit) return;
        let ext;
        try { ext = t.getExtentOfChar(i); } catch (e) { return; }
        if (!ext || !(ext.width > 0)) return;
        const pad = ext.height * 0.08;
        const pill = document.createElementNS(ns, 'rect');
        pill.setAttribute('x', ext.x - pad); pill.setAttribute('y', ext.y + ext.height * 0.12);
        pill.setAttribute('width', ext.width + 2 * pad); pill.setAttribute('height', ext.height * 0.8);
        pill.setAttribute('rx', ext.height * 0.12); pill.setAttribute('fill', QUAD_PILL);
        pill.setAttribute('pointer-events', 'none'); pill.setAttribute(QUAD_MARK, '1');
        t.parentNode.insertBefore(pill, t);
      });
    }
  }

  let busy = false;
  let timer = null;

  function schedule(delay) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, delay == null ? 60 : delay);
  }

  function run() {
    timer = null;
    if (busy) { schedule(80); return; }
    const svg = findSvg();
    stats.gridFound = !!svg;
    if (!svg || !settings.enabled) { updateBadge(); return; }
    const geo = geometry(svg);
    if (!geo || geo.n > 9) { updateBadge(); return; }
    const rules = resolveRules();
    stats.rules = rules;
    const { values, cands } = readBoard(svg, geo);
    const n = geo.n;

    checkForWrongRemovals(svg, geo, values, cands, rules);
    try { renderQuadHighlight(svg, geo); } catch (e) { console.warn('[pencil-guard] quad highlight failed', e); }

    if (!rules.knight && !rules.king && !rules.noncon && !rules.parity) { updateBadge(); return; }
    const sig = values.join(',') + '|' + (rules.knight ? 'N' : '') + (rules.king ? 'K' : '') + (rules.noncon ? 'C' : '') + (rules.parity ? 'P' : '');
    if (sig !== history.sig) { history.sig = sig; history.done.clear(); }

    const targets = new Map(); // digit -> [cell idx]
    const addTarget = (cell, digit) => {
      const key = cell + ':' + digit;
      if (history.done.has(key)) return;
      if (!targets.has(digit)) targets.set(digit, []);
      const arr = targets.get(digit);
      if (!arr.includes(cell)) arr.push(cell);
    };
    if (rules.parity) {
      const parity = readParity(svg, geo);
      stats.parityCells = parity.filter(Boolean).length;
      for (let idx = 0; idx < n * n; idx++) {
        if (!parity[idx] || values[idx]) continue;
        for (const d of cands[idx]) if ((d % 2 === 1) !== (parity[idx] === 1)) addTarget(idx, d);
      }
    }
    for (let idx = 0; idx < n * n; idx++) {
      const d = values[idx];
      if (!d) continue;
      for (const [nb, digit] of eliminations(idx, d, n, rules)) {
        if (values[nb] || !cands[nb].has(digit)) continue;
        addTarget(nb, digit);
      }
    }
    if (targets.size === 0) { updateBadge(); return; }

    busy = true;
    try {
      const saved = readSelection(svg, geo);
      for (const [d, cells] of targets) {
        // Select exactly the cells that still show candidate d, then toggle it.
        // (With a mixed selection the site would ADD the candidate instead.)
        cells.forEach((cell, i) => clickCell(svg, geo, cell, i > 0));
        pressKey(String(d), { ctrlKey: true });
        for (const cell of cells) history.done.add(cell + ':' + d);
        stats.removed += cells.length;
      }
      if (saved.length) saved.forEach((cell, i) => clickCell(svg, geo, cell, i > 0));
      else pressKey('Escape');
      stats.lastRun = Date.now();
    } catch (e) {
      console.warn('[pencil-guard] elimination failed', e);
    } finally {
      setTimeout(() => { busy = false; schedule(20); }, 30);
    }
    updateBadge();
  }

  // -------------------------------------------------------------------- badge
  let badge = null;
  function updateBadge() {
    if (!settings.badge || !settings.enabled || !stats.gridFound) {
      if (badge) badge.style.display = 'none';
      return;
    }
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'pencil-guard-badge';
      badge.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:2147483647;font:12px/1.4 system-ui,sans-serif;'
        + 'background:rgba(20,22,40,.85);color:#eee;padding:4px 8px;border-radius:6px;pointer-events:none;opacity:.85;';
      document.documentElement.appendChild(badge);
    }
    const r = stats.rules || { knight: false, king: false, noncon: false, parity: false };
    const mark = (on) => (on ? '✓' : '–');
    let text = `♞ Knight ${mark(r.knight)}  ♚ King ${mark(r.king)}  ± Noncon ${mark(r.noncon)}  ◯▢ Odd/Even ${mark(r.parity)}  · auto-removed ${stats.removed}`;
    if (settings.warnWrong) text += stats.solution ? `  · errors ${stats.errors}` : '  · no solution';
    if (badge.textContent !== text) badge.textContent = text;
    if (badge.style.display) badge.style.display = '';
  }

  // ------------------------------------------------------------- messaging
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || msg.type !== 'pencil-guard-status') return;
      const svg = findSvg();
      const geo = svg && geometry(svg);
      const rules = resolveRules();
      sendResponse({
        gridFound: !!geo,
        size: geo ? geo.n : 0,
        detected: rules.detected,
        active: { knight: rules.knight, king: rules.king, noncon: rules.noncon, parity: rules.parity },
        parityCells: stats.parityCells || 0,
        removed: stats.removed,
        errors: stats.errors,
        solution: stats.solution,
        quadruples: geo ? findQuadruples(svg, geo).length : 0,
        settings,
      });
    });
  }

  // -------------------------------------------------------------------- start
  loadSettings(() => {
    const obs = new MutationObserver((muts) => {
      if (busy) return;
      // Ignore mutations caused by our own badge or quadruple pills.
      const ours = (el) => !!el && ((badge && (el === badge || badge.contains(el)))
        || (el.hasAttribute && el.hasAttribute(QUAD_MARK)));
      const onlyOurs = (m) => ours(m.target)
        || (m.type === 'childList' && (m.addedNodes.length + m.removedNodes.length) > 0
            && [...m.addedNodes, ...m.removedNodes].every(ours));
      if (muts.every(onlyOurs)) return;
      schedule();
    });
    // `fill` changes are how the site's digit highlight shows up in the SVG.
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['fill'] });
    schedule(300);
  });
})();
