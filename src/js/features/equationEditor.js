// ===================================================================================
// EQUATION EDITOR — LaTeX authoring + KaTeX rendering for TAFNE
// ===================================================================================
//
// WHAT THIS IS
// TAFNE gained equations because the pipeline needed somewhere to put them: the
// PDF extractor reconstructs display math into LaTeX, and until now the only
// thing the receiving end could do with an equation artifact was show a toast
// saying it had arrived. This is the surface that makes the handoff mean
// something — the LaTeX is editable, the render is live, and the corrected TeX
// can go back where it came from.
//
// It is two things sharing one renderer:
//
//   1. EQUATION MODE — a full-canvas editor (same shape as Node Editor and Lab
//      Mode): a list of equations on the left, the equation itself on the
//      right, a symbol palette for the glyphs nobody remembers the macro for.
//
//      THE RENDERED EQUATION IS THE EDITOR. You click into the typeset maths
//      and a caret appears between the glyphs, as it would in a word
//      processor; arrows walk it atom by atom, typing and Backspace edit the
//      TeX underneath. It never swaps itself for a source field — the LaTeX
//      lives in the "Equation source" disclosure below, closed by default,
//      for the times you want to work on the TeX directly. Two views, one
//      string, and the picture stays on screen while you correct it. See
//      "Source ↔ render mapping" below for how a click becomes an offset.
//
//   2. INLINE CELL MATH — a table cell whose text is `$…$` or `$$…$$` renders
//      as math in the table view. Scientific tables are full of formulas, and a
//      table tool that shows them as raw TeX is asking the reader to be a
//      compiler.
//
// THE SOURCE OF TRUTH IS THE TeX, ALWAYS
// Every store, every export and every send carries `latex`. The rendered markup
// is a view: it is regenerated on demand and never read back. Storing the
// render instead is how a round trip turns an equation into glyph soup — the
// exact failure this tool exists to undo.
//
// DEGRADATION
// KaTeX is vendored (vendor/katex/), so it is present whenever the tool is. If
// it somehow is not, `_render` falls back to showing the TeX in a monospace
// block rather than an empty box: unrendered source is still the content, an
// empty box is a lie.
//
// PUBLIC SURFACE (what other code, including the MCP manifest, drives):
//   window.equations              — the store, [{ id, name, latex, origin, lineage }]
//   window.activeEquationId
//   addEquation(name, latex, meta) createEquation() deleteEquation(id)
//   selectEquation(id) setEquationLatex(id, latex)
//   enableEquationEditor() disableEquationEditor() toggleEquationEditor()
//   renderMathInCells(root)       — inline `$…$` rendering pass
//   window.EquationEditor.*        — the same, namespaced
// ===================================================================================

window.equations = [];
window.activeEquationId = null;
window.equationEditorEnabled = false;
window._equationCounter = 0;

// ──────────────────────────────────────────────────────────────────────────────
// Rendering
// ──────────────────────────────────────────────────────────────────────────────

/**
 * TeX → HTML, or a structured failure.
 *
 * KaTeX's own `throwOnError: false` paints the broken sub-expression red inside
 * an otherwise normal render, which looks like a styling choice rather than an
 * error. The editor needs the MESSAGE — "Undefined control sequence: \fract" is
 * actionable, a red glyph is not — so errors are caught here and returned.
 *
 * @returns {{ ok: boolean, html: string, error: string|null }}
 */
function renderLatex(latex, opts) {
    opts = opts || {};
    var tex = String(latex == null ? '' : latex);
    if (!tex.trim()) return { ok: true, html: '', error: null };

    if (!window.katex || typeof window.katex.renderToString !== 'function') {
        return {
            ok: false,
            html: '<pre class="eq-raw-tex">' + _eqEsc(tex) + '</pre>',
            error: 'KaTeX is not loaded — showing source.',
        };
    }
    try {
        return {
            ok: true,
            html: window.katex.renderToString(tex, {
                displayMode: opts.displayMode !== false,
                output: 'html',
                throwOnError: true,
                strict: false,
                // `\htmlData` is the ONE command this editor is allowed to
                // inject, and only for the source map below. `\url` and
                // `\href` stay untrusted, here and everywhere else.
                trust: opts.mapped ? function (ctx) { return ctx.command === '\\htmlData'; } : false,
            }),
            error: null,
        };
    } catch (e) {
        return {
            ok: false,
            html: '<pre class="eq-raw-tex">' + _eqEsc(tex) + '</pre>',
            error: (e && e.message) ? String(e.message) : 'Could not typeset this expression.',
        };
    }
}

function _eqEsc(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Source ↔ render mapping ────────────────────────────────────────────────
//
// KaTeX hands back a typeset tree with no link to the characters it came from,
// so a click on a glyph cannot be turned into a position in the TeX — which is
// why the rendered box used to give up and swap itself for a source field the
// moment you touched it. Two editors for one string, and the picture you were
// trying to correct disappeared exactly when you went to correct it.
//
// The fix is to make the render carry its own source map. Every atom is wrapped
// in `\htmlData{eqo=<offset>,eql=<length>}` before typesetting, which KaTeX
// emits as data attributes on the span it builds for that atom. The caret is
// then an ordinary integer offset into #eqSource, and the rendered equation is
// a real editing surface rather than a preview.
//
// Two things are deliberately left un-anchored, because a wrapper would change
// the render rather than just annotate it:
//   • anything a script attaches to — `\htmlData{}{\sum}_{k}` sets the limit
//     beside the sigma instead of under it;
//   • text-mode arguments — KaTeX merges adjacent letters into one span and
//     instrumenting inside `\text{...}` splits them.
// Both stay editable in the source field, and the caret still steps over them.
//
// When the TeX uses something this walker cannot instrument safely, it returns
// null and the preview renders plain. A missing caret is a small loss; a
// preview that silently disagrees with the source is not.

var EQ_BARE_CMDS = {
    '\\left': 1, '\\right': 1, '\\middle': 1,
    '\\big': 1, '\\Big': 1, '\\bigg': 1, '\\Bigg': 1,
    '\\bigl': 1, '\\Bigl': 1, '\\biggl': 1, '\\Biggl': 1,
    '\\bigr': 1, '\\Bigr': 1, '\\biggr': 1, '\\Biggr': 1,
    '\\\\': 1, '\\limits': 1, '\\nolimits': 1,
};
var EQ_ARG_CMDS = {
    '\\frac': 1, '\\dfrac': 1, '\\tfrac': 1, '\\cfrac': 1, '\\binom': 1,
    '\\dbinom': 1, '\\tbinom': 1, '\\sqrt': 1, '\\overline': 1, '\\underline': 1,
    '\\hat': 1, '\\bar': 1, '\\vec': 1, '\\tilde': 1, '\\dot': 1, '\\ddot': 1,
    '\\widehat': 1, '\\widetilde': 1, '\\overrightarrow': 1, '\\boxed': 1,
    '\\text': 1, '\\textbf': 1, '\\textit': 1, '\\textrm': 1, '\\mathbb': 1,
    '\\mathbf': 1, '\\mathcal': 1, '\\mathfrak': 1, '\\mathrm': 1, '\\mathsf': 1,
    '\\mathtt': 1, '\\mathit': 1, '\\operatorname': 1, '\\stackrel': 1,
    '\\overset': 1, '\\underset': 1, '\\substack': 1, '\\textcolor': 1,
    '\\colorbox': 1, '\\fcolorbox': 1, '\\phantom': 1, '\\hphantom': 1,
    '\\vphantom': 1, '\\href': 1, '\\htmlData': 1, '\\htmlClass': 1,
    '\\htmlId': 1, '\\htmlStyle': 1, '\\raisebox': 1, '\\rule': 1, '\\color': 1,
};

// Text-mode arguments are left whole. KaTeX merges adjacent letters into one
// span, and instrumenting inside `\text{...}` splits them — identical to read,
// but no longer the same markup. Prose is edited in the source field; the
// rendered caret treats the whole `\text{...}` as one atom.
var EQ_OPAQUE_CMDS = {
    '\\text': 1, '\\textbf': 1, '\\textit': 1, '\\textrm': 1, '\\textsf': 1,
    '\\texttt': 1, '\\textnormal': 1, '\\operatorname': 1, '\\mbox': 1, '\\hbox': 1,
};

function _eqIsSpace(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r'; }

function _eqSkipSpace(src, i) { while (i < src.length && _eqIsSpace(src.charAt(i))) i++; return i; }

/** Find the offset just past the `\end{...}` matching the `\begin` at `from`. */
function _eqEnvEnd(src, from) {
    var depth = 0, i = from;
    while (i < src.length) {
        if (src.charAt(i) === '\\') {
            if (src.substr(i, 6) === '\\begin') { depth++; i += 6; continue; }
            if (src.substr(i, 4) === '\\end') {
                i += 4;
                i = _eqSkipSpace(src, i);
                if (src.charAt(i) !== '{') return -1;
                var close = src.indexOf('}', i);
                if (close < 0) return -1;
                i = close + 1;
                if (--depth === 0) return i;
                continue;
            }
            i += 2; continue;
        }
        i++;
    }
    return -1;
}

/**
 * Walk the TeX into a tree of atoms carrying their source offsets.
 * `st.bad` is set by anything this mapper cannot instrument without changing
 * the render; the caller then falls back to a plain, unmapped typeset.
 */
function _eqScan(st, i) {
    var src = st.src, nodes = [];
    while (i < src.length && !st.bad) {
        var c = src.charAt(i);
        if (c === '}') break;

        if (_eqIsSpace(c) || c === '&' || c === '^' || c === '_') {
            nodes.push({ k: 'raw', s: i, e: i + 1 }); i++; continue;
        }

        if (c === '{') {
            var g = _eqScan(st, i + 1);
            if (src.charAt(g.i) !== '}') { st.bad = true; break; }
            nodes.push({ k: 'group', s: i, e: g.i + 1, kids: g.nodes });
            i = g.i + 1; continue;
        }

        if (c === '\\') {
            var m = /^\\(?:[a-zA-Z]+|[\s\S])/.exec(src.slice(i));
            if (!m) { st.bad = true; break; }
            var name = m[0], j = i + name.length;

            if (name === '\\begin') {
                var end = _eqEnvEnd(src, i);
                if (end < 0) { st.bad = true; break; }
                nodes.push({ k: 'atom', s: i, e: end }); i = end; continue;
            }
            if (name === '\\end') { st.bad = true; break; }

            if (EQ_BARE_CMDS[name]) {
                // `\left` owns the delimiter that follows it; a wrapper between
                // the two is a parse error, not a styling difference.
                var k = _eqSkipSpace(src, j);
                var d = /^(\\[a-zA-Z]+|[\s\S])/.exec(src.slice(k));
                var e2 = /^\\(left|right|middle|big|Big|bigg|Bigg)/.test(name) && d ? k + d[0].length : j;
                nodes.push({ k: 'raw', s: i, e: e2 }); i = e2; continue;
            }

            var opt = null;
            var p = _eqSkipSpace(src, j);
            if (src.charAt(p) === '[') {
                var cb = src.indexOf(']', p);
                if (cb < 0) { st.bad = true; break; }
                opt = [p, cb + 1]; j = cb + 1;
            }

            var args = [];
            for (;;) {
                var q = _eqSkipSpace(src, j);
                if (src.charAt(q) !== '{') break;
                var ag = _eqScan(st, q + 1);
                if (st.bad || src.charAt(ag.i) !== '}') { st.bad = true; break; }
                args.push({ kids: ag.nodes });
                j = ag.i + 1;
            }
            if (st.bad) break;
            // `\frac ab` is legal TeX whose arguments have no braces to wrap.
            if (!args.length && EQ_ARG_CMDS[name]) { st.bad = true; break; }

            if (EQ_OPAQUE_CMDS[name]) nodes.push({ k: 'atom', s: i, e: j });
            else nodes.push({ k: 'cmd', s: i, e: j, name: name, opt: opt, args: args });
            i = j; continue;
        }

        nodes.push({ k: 'atom', s: i, e: i + 1 });
        i++;
    }
    return { nodes: nodes, i: i };
}

function _eqWrap(tex, s, e) {
    return '\\htmlData{eqo=' + s + ',eql=' + (e - s) + '}{' + tex + '}';
}

/**
 * A wrapper turns its contents into an ordinary group, which is invisible for
 * most atoms and wrong for exactly one case: an operator carrying limits.
 * `\sum_{k}` sets its script under the sigma, `\htmlData{}{\sum}_{k}` sets it
 * to the right. Anything a script is about to attach to is therefore emitted
 * bare — it loses its own click target, never its shape.
 */
function _eqScripted(src, e) {
    var k = _eqSkipSpace(src, e);
    var c = src.charAt(k);
    return c === '^' || c === '_' || src.substr(k, 7) === '\\limits' || src.substr(k, 9) === '\\nolimits';
}

function _eqEmit(nodes, st) {
    var out = '', script = false;
    for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i], piece;
        if (n.k === 'raw') {
            piece = st.src.slice(n.s, n.e);
            // `x^\\htmlData{..}{2}` is a parse error: KaTeX will not take a
            // function as a script. Braces make it a group, which it will.
            out += script ? '{' + piece + '}' : piece;
            script = (piece === '^' || piece === '_');
            continue;
        }
        if (n.k === 'group') {
            piece = '{' + _eqEmit(n.kids, st) + '}';
        } else {
            var tex;
            if (n.k === 'atom') {
                tex = st.src.slice(n.s, n.e);
            } else {
                tex = n.name + (n.opt ? st.src.slice(n.opt[0], n.opt[1]) : '');
                for (var a = 0; a < n.args.length; a++) tex += '{' + _eqEmit(n.args[a].kids, st) + '}';
            }
            piece = (st.noWrap || _eqScripted(st.src, n.e)) ? tex : _eqWrap(tex, n.s, n.e);
        }
        out += script ? '{' + piece + '}' : piece;
        script = false;
    }
    return out;
}

/** Every offset in the source a caret may sit at, ascending. */
function _eqBoundaries(nodes, out) {
    for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        out.push(n.s, n.e);
        if (n.k === 'group') _eqBoundaries(n.kids, out);
        else if (n.k === 'cmd') for (var a = 0; a < n.args.length; a++) _eqBoundaries(n.args[a].kids, out);
    }
    return out;
}

function _eqInstrument(tex, noWrap) {
    var st = { src: String(tex == null ? '' : tex), bad: false, noWrap: !!noWrap };
    var r = _eqScan(st, 0);
    if (st.bad || r.i < st.src.length) return null;
    var bounds = _eqBoundaries(r.nodes, [0, st.src.length]);
    bounds = bounds.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort(function (x, y) { return x - y; });
    return { tex: _eqEmit(r.nodes, st), bounds: bounds };
}

// ──────────────────────────────────────────────────────────────────────────────
// Inline cell math
// ──────────────────────────────────────────────────────────────────────────────

// `$$…$$` (display) or `$…$` (inline). The negative lookbehind lets a cell hold
// an escaped literal — "\$40" is money, not the start of an equation — and the
// `\S` after the opener stops "$ 40 and $ 60" pairing up into one bogus
// expression spanning the sentence.
//
// Built with `new RegExp` rather than written as a literal ON PURPOSE. A regex
// LITERAL using syntax the engine does not know is a parse-time SyntaxError,
// which kills this entire file — no editor, no cell maths, nothing — on a
// browser that predates lookbehind (Safari < 16.4). `new RegExp` throws at
// runtime instead, where it can be caught, so an old browser loses only the
// escaping rule.
var MATH_DELIM_RE = (function () {
    var withEscape = '(?<!\\\\)\\$\\$([^$]+?)\\$\\$|(?<!\\\\)\\$(\\S[^$]*?)\\$(?!\\d)';
    var plain      = '\\$\\$([^$]+?)\\$\\$|\\$(\\S[^$]*?)\\$(?!\\d)';
    try { return new RegExp(withEscape, 'g'); } catch (_) { return new RegExp(plain, 'g'); }
})();

/**
 * Render `$…$` spans inside a table (or any subtree) in place.
 *
 * Only TEXT nodes are touched, and the ORIGINAL text is stashed on the wrapper
 * as `data-tex`. That is what makes the pass reversible: a cell being edited
 * has to show its source, not a picture of it, and `unrenderMathInCells` puts
 * the raw text back before the user types into it. Rendering over a cell you
 * cannot then edit is worse than not rendering at all.
 */
function renderMathInCells(root) {
    root = root || document.getElementById('tableContainer');
    if (!root || !window.katex) return 0;

    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
            if (!node.nodeValue || node.nodeValue.indexOf('$') === -1) return NodeFilter.FILTER_REJECT;
            // Never descend into an already-rendered expression, and never
            // rewrite the cell the user is currently typing in.
            var el = node.parentElement;
            while (el && el !== root) {
                if (el.classList && (el.classList.contains('katex') || el.classList.contains('eq-math'))) {
                    return NodeFilter.FILTER_REJECT;
                }
                if (el.isContentEditable && document.activeElement === el) return NodeFilter.FILTER_REJECT;
                el = el.parentElement;
            }
            return NodeFilter.FILTER_ACCEPT;
        },
    });

    var targets = [];
    var n;
    while ((n = walker.nextNode())) targets.push(n);

    var count = 0;
    for (var i = 0; i < targets.length; i++) {
        var node = targets[i];
        var text = node.nodeValue;
        MATH_DELIM_RE.lastIndex = 0;
        if (!MATH_DELIM_RE.test(text)) continue;
        MATH_DELIM_RE.lastIndex = 0;

        var frag = document.createDocumentFragment();
        var last = 0;
        var m;
        while ((m = MATH_DELIM_RE.exec(text)) !== null) {
            if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            var display = m[1] != null;
            var tex = display ? m[1] : m[2];
            var res = renderLatex(tex, { displayMode: display });
            var span = document.createElement('span');
            span.className = 'eq-math' + (res.ok ? '' : ' eq-math-error');
            // The delimiters ride along so the round trip is exact: strip the
            // render and you get back the characters that were typed.
            span.setAttribute('data-tex', m[0]);
            if (!res.ok) span.setAttribute('title', res.error);
            span.innerHTML = res.html;
            frag.appendChild(span);
            last = m.index + m[0].length;
            count++;
        }
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
    }
    return count;
}

/** Put the raw `$…$` text back, so the cell can be edited or serialized. */
function unrenderMathInCells(root) {
    root = root || document.getElementById('tableContainer');
    if (!root) return 0;
    var spans = root.querySelectorAll('.eq-math[data-tex]');
    for (var i = 0; i < spans.length; i++) {
        spans[i].parentNode.replaceChild(
            document.createTextNode(spans[i].getAttribute('data-tex')), spans[i],
        );
    }
    return spans.length;
}

// ──────────────────────────────────────────────────────────────────────────────
// The store
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Add an equation and make it active.
 *
 * `meta.origin` is the return address — the page and region this TeX was
 * extracted from — and it is the whole reason a correction here can be pushed
 * back rather than just exported. A hand-authored equation has none, and that
 * absence is what tells the panel not to offer the send-back route.
 */
function addEquation(name, latex, meta) {
    meta = meta || {};
    var id = 'eq-' + (++window._equationCounter);
    window.equations.push({
        id: id,
        name: name || ('Equation ' + window._equationCounter),
        latex: String(latex == null ? '' : latex),
        origin: meta.origin || null,
        lineage: meta.lineage || null,
        source: meta.source || null,
    });
    if (window.equationEditorEnabled) _renderEquationList();
    selectEquation(id);
    return id;
}

function createEquation() {
    return addEquation(null, 'E = mc^2', { source: 'authored' });
}

function deleteEquation(id) {
    var idx = window.equations.findIndex(function (e) { return e.id === id; });
    if (idx < 0) return false;
    window.equations.splice(idx, 1);
    if (window.activeEquationId === id) {
        var next = window.equations[Math.min(idx, window.equations.length - 1)];
        window.activeEquationId = next ? next.id : null;
    }
    if (window.equationEditorEnabled) { _renderEquationList(); _renderActiveEquation(); }
    return true;
}

function getEquation(id) {
    return window.equations.find(function (e) { return e.id === id; }) || null;
}

function selectEquation(id) {
    if (!getEquation(id)) return false;
    window.activeEquationId = id;
    if (window.equationEditorEnabled) { _renderEquationList(); _renderActiveEquation(); }
    return true;
}

function setEquationLatex(id, latex) {
    var eq = getEquation(id);
    if (!eq) return false;
    eq.latex = String(latex == null ? '' : latex);
    // Edited here, so it no longer matches the source it came from. Say so:
    // a send-back that silently claims to be the extraction is a lineage lie.
    if (eq.origin) eq.edited = true;
    if (window.equationEditorEnabled) { _renderEquationList(); _renderPreview(); }
    return true;
}

function renameEquation(id, name) {
    var eq = getEquation(id);
    if (!eq) return false;
    eq.name = String(name || eq.name);
    if (window.equationEditorEnabled) _renderEquationList();
    return true;
}

/**
 * Drop the active equation into the selected table cell as `$$…$$`.
 *
 * This is the join between the two halves of the feature: an equation authored
 * or corrected in the editor becomes cell content that the table's own export,
 * history and node pipeline already know how to carry, with no new format.
 */
function insertEquationIntoCell(id) {
    var eq = getEquation(id || window.activeEquationId);
    if (!eq) return false;
    // `.selected-cell` is the class TAFNE's own selection model sets (tifany.js);
    // the last one in document order is the most recently clicked.
    var picked = document.querySelectorAll('#tableContainer td.selected-cell, #tableContainer th.selected-cell');
    var cell = picked.length ? picked[picked.length - 1] : null;
    if (!cell) return false;
    if (typeof window.saveCurrentState === 'function') window.saveCurrentState();
    cell.textContent = '$$' + eq.latex + '$$';
    renderMathInCells(cell);
    return true;
}

// ──────────────────────────────────────────────────────────────────────────────
// Symbol palette
// ──────────────────────────────────────────────────────────────────────────────
//
// The macros people reach for and misremember. `$1` marks where the caret goes
// after insertion — for a fraction that is the numerator, which is where you
// were about to type anyway.
var EQ_PALETTE = [
    { group: 'Structure', items: [
        { label: '¹⁄ₓ', tex: '\\frac{$1}{}', title: 'Fraction' },
        { label: '√',   tex: '\\sqrt{$1}',   title: 'Square root' },
        { label: 'xⁿ',  tex: '^{$1}',        title: 'Superscript' },
        { label: 'xₙ',  tex: '_{$1}',        title: 'Subscript' },
        { label: '∑',   tex: '\\sum_{$1}^{}', title: 'Summation' },
        { label: '∏',   tex: '\\prod_{$1}^{}', title: 'Product' },
        { label: '∫',   tex: '\\int_{$1}^{}', title: 'Integral' },
        { label: 'lim', tex: '\\lim_{$1 \\to }', title: 'Limit' },
        { label: '( )', tex: '\\left( $1 \\right)', title: 'Auto-sized parentheses' },
        { label: '[ ]', tex: '\\begin{bmatrix} $1 \\end{bmatrix}', title: 'Matrix' },
        { label: '{',   tex: '\\begin{cases} $1 & \\text{if } \\\\ & \\text{otherwise} \\end{cases}', title: 'Cases' },
    ] },
    { group: 'Greek', items: [
        { label: 'α', tex: '\\alpha ' }, { label: 'β', tex: '\\beta ' },
        { label: 'γ', tex: '\\gamma ' }, { label: 'δ', tex: '\\delta ' },
        { label: 'ε', tex: '\\epsilon ' }, { label: 'θ', tex: '\\theta ' },
        { label: 'λ', tex: '\\lambda ' }, { label: 'μ', tex: '\\mu ' },
        { label: 'π', tex: '\\pi ' }, { label: 'ρ', tex: '\\rho ' },
        { label: 'σ', tex: '\\sigma ' }, { label: 'τ', tex: '\\tau ' },
        { label: 'φ', tex: '\\phi ' }, { label: 'ω', tex: '\\omega ' },
        { label: 'Δ', tex: '\\Delta ' }, { label: 'Σ', tex: '\\Sigma ' },
        { label: 'Ω', tex: '\\Omega ' },
    ] },
    { group: 'Relations', items: [
        { label: '≤', tex: '\\leq ' }, { label: '≥', tex: '\\geq ' },
        { label: '≠', tex: '\\neq ' }, { label: '≈', tex: '\\approx ' },
        { label: '≡', tex: '\\equiv ' }, { label: '∝', tex: '\\propto ' },
        { label: '±', tex: '\\pm ' }, { label: '×', tex: '\\times ' },
        { label: '÷', tex: '\\div ' }, { label: '·', tex: '\\cdot ' },
        { label: '→', tex: '\\to ' }, { label: '∞', tex: '\\infty ' },
        { label: '∂', tex: '\\partial ' }, { label: '∇', tex: '\\nabla ' },
        { label: '∈', tex: '\\in ' }, { label: '°', tex: '^{\\circ}' },
    ] },
    { group: 'Units & text', items: [
        { label: 'text', tex: '\\text{$1}', title: 'Upright text' },
        { label: 'bold', tex: '\\mathbf{$1}', title: 'Bold' },
        { label: 'vec',  tex: '\\vec{$1}',   title: 'Vector' },
        { label: 'bar',  tex: '\\bar{$1}',   title: 'Overbar' },
        { label: 'hat',  tex: '\\hat{$1}',   title: 'Hat' },
        { label: '\\,',  tex: '\\,',         title: 'Thin space (before a unit)' },
    ] },
];

/**
 * Insert a palette snippet at the caret, honouring the `$1` caret marker.
 *
 * Two surfaces can own the caret — the rendered equation and the source field —
 * and both write to the same string. `#eqSource.value` is that string, so the
 * insertion is done there either way and the two views are never out of step.
 */
function insertLatexSnippet(snippet) {
    var ta = document.getElementById('eqSource');
    if (!ta) return;
    var caretIn = snippet.indexOf('$1');
    var text = caretIn >= 0 ? snippet.replace('$1', '') : snippet;

    var out = document.getElementById('eqPreview');
    if (out && out.classList.contains('eq-focus')) {
        var at = _eqClamp(_eqCaret, ta.value.length);
        _eqSplice(at, at, text, caretIn >= 0 ? at + caretIn : at + text.length);
        out.focus();
        return;
    }

    var start = ta.selectionStart, end = ta.selectionEnd;
    // A selection is treated as the thing being wrapped: select `x+1`, press
    // the fraction button, and it becomes the numerator instead of vanishing.
    var selected = ta.value.slice(start, end);
    if (selected && caretIn >= 0) text = snippet.replace('$1', selected);
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    var caret = caretIn >= 0 && !selected ? start + caretIn : start + text.length;
    ta.setSelectionRange(caret, caret);
    ta.focus();
    _eqCaret = caret;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}

// ──────────────────────────────────────────────────────────────────────────────
// Mode
// ──────────────────────────────────────────────────────────────────────────────

function enableEquationEditor() {
    if (window.equationEditorEnabled) return;
    window.equationEditorEnabled = true;

    $('#equationEditorToggle').addClass('active').attr('title', 'Equation Editor: ON');
    $('#selectToolToggle').removeClass('active');

    // One canvas at a time — the other two modes hide the same surfaces.
    if (window.labModeEnabled && typeof disableLab === 'function') disableLab();
    if (window.nodeEditorEnabled && typeof disableNodeEditor === 'function') disableNodeEditor();

    if (typeof _saveActiveSheetState === 'function') _saveActiveSheetState();

    $('.table-wrapper').hide();
    $('#sheetTabBar').hide();
    $('.tifany-left-panel, .tifany-right-panel').hide();
    $('#equationCanvas').css('display', 'flex');
    document.body.classList.add('equation-editor-active');

    // An empty editor is a dead end. Opening it with one equation gives the
    // palette and the preview something to act on immediately.
    if (!window.equations.length) createEquation();

    _renderPalette();
    _renderEquationList();
    _renderActiveEquation();

    // Open with the caret already in the equation. The rendered box is the
    // editor now, so landing in it is the same courtesy as putting the cursor
    // in a text field when a form opens.
    var preview = document.getElementById('eqPreview');
    if (preview && (!window.matchMedia || !window.matchMedia('(max-width: 900px)').matches)) preview.focus();

    $.toast({ heading: 'Equation Editor', text: 'Equation Editor activated', icon: 'info', loader: false, stack: false });
}

function disableEquationEditor() {
    if (!window.equationEditorEnabled) return;
    window.equationEditorEnabled = false;

    $('#equationEditorToggle').removeClass('active').attr('title', 'Equation Editor: OFF');
    $('#selectToolToggle').addClass('active');

    $('#equationCanvas').hide();
    $('.table-wrapper').show();
    $('#sheetTabBar').show();
    $('.tifany-left-panel, .tifany-right-panel').show();
    document.body.classList.remove('equation-editor-active');

    $.toast({ heading: 'Equation Editor', text: 'Returned to table view', icon: 'info', loader: false, stack: false });
}

function toggleEquationEditor() {
    if (window.equationEditorEnabled) disableEquationEditor();
    else enableEquationEditor();
}

// ──────────────────────────────────────────────────────────────────────────────
// Views
// ──────────────────────────────────────────────────────────────────────────────

function _renderPalette() {
    var host = document.getElementById('eqPalette');
    if (!host || host.dataset.built === '1') return;
    host.innerHTML = EQ_PALETTE.map(function (g) {
        return '<div class="eq-pal-group"><div class="eq-pal-label">' + _eqEsc(g.group) + '</div>' +
            g.items.map(function (it) {
                return '<button type="button" class="eq-pal-btn" data-tex="' + _eqEsc(it.tex) + '"' +
                    ' title="' + _eqEsc(it.title || it.tex.trim()) + '">' + _eqEsc(it.label) + '</button>';
            }).join('') + '</div>';
    }).join('');
    host.dataset.built = '1';
}

function _renderEquationList() {
    var host = document.getElementById('eqList');
    if (!host) return;
    if (!window.equations.length) {
        host.innerHTML = '<p class="eq-empty">No equations yet. Press <b>New</b>, or send some over from the Document Workbench.</p>';
        return;
    }
    host.innerHTML = window.equations.map(function (eq) {
        var res = renderLatex(eq.latex, { displayMode: false });
        var active = eq.id === window.activeEquationId ? ' active' : '';
        var badge = eq.origin
            ? '<span class="eq-badge" title="Extracted from ' + _eqEsc(_originLabel(eq.origin)) + '">' +
              _eqEsc(_originLabel(eq.origin)) + (eq.edited ? ' · edited' : '') + '</span>'
            : '';
        return '<div class="eq-item' + active + '" data-id="' + _eqEsc(eq.id) + '">' +
            '<div class="eq-item-head"><span class="eq-item-name">' + _eqEsc(eq.name) + '</span>' + badge + '</div>' +
            '<div class="eq-item-thumb' + (res.ok ? '' : ' eq-math-error') + '">' + res.html + '</div>' +
            '<button type="button" class="eq-item-del" data-id="' + _eqEsc(eq.id) + '" title="Delete">&times;</button>' +
            '</div>';
    }).join('');
}

function _originLabel(origin) {
    if (!origin) return '';
    var page = origin.page != null ? 'p' + origin.page : '';
    var tool = origin.tool || origin.source || 'upstream';
    return [tool, page].filter(Boolean).join(' · ');
}

function _renderActiveEquation() {
    var eq = getEquation(window.activeEquationId);
    var ta = document.getElementById('eqSource');
    var name = document.getElementById('eqName');
    if (ta) ta.value = eq ? eq.latex : '';
    if (name) name.value = eq ? eq.name : '';
    _eqCaret = ta ? ta.value.length : 0;
    _renderPreview();
}

// The caret is an offset into #eqSource — the same number the textarea's own
// selectionStart holds — so the two surfaces hand it back and forth untouched.
// `_eqStops` are the offsets it is allowed to land on: every atom boundary the
// walker found, which is what makes an arrow key step over `\alpha` in one
// press instead of six.
var _eqCaret = 0;
var _eqStops = [0];

function _eqClamp(n, max) { return n < 0 ? 0 : (n > max ? max : n); }

function _renderPreview() {
    var out = document.getElementById('eqPreview');
    var err = document.getElementById('eqError');
    var ta = document.getElementById('eqSource');
    if (!out || !ta) return;

    var src = ta.value;
    var map = _eqInstrument(src);
    var res = renderLatex(map ? map.tex : src, { displayMode: true, mapped: !!map });
    // An anchor is never worth a broken render, and it must never be what the
    // error is about. If the instrumented pass failed, the plain pass replaces
    // it whether or not THAT succeeds — otherwise a typo in the user's TeX is
    // reported at some position inside an `\htmlData` wrapper they never wrote,
    // and the raw-source fallback shows them our annotation instead of their
    // equation.
    if (!res.ok && map) {
        res = renderLatex(src, { displayMode: true });
        map = null;
    }

    _eqStops = map ? map.bounds : [0, src.length];
    _eqCaret = _eqClamp(_eqCaret, src.length);

    out.innerHTML = res.html || '<span class="eq-empty">Nothing to render yet.</span>';
    out.classList.toggle('eq-math-error', !res.ok);
    out.classList.toggle('eq-unanchored', !map && !!src.trim());
    if (err) {
        err.textContent = res.error || '';
        err.style.display = res.error ? 'block' : 'none';
    }
    _eqDrawCaret();
}

/** Rewrite [from, to) and put the caret at `caret`, through the one source. */
function _eqSplice(from, to, insert, caret) {
    var ta = document.getElementById('eqSource');
    if (!ta) return;
    ta.value = ta.value.slice(0, from) + insert + ta.value.slice(to);
    _eqCaret = _eqClamp(caret, ta.value.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function _eqStopBefore(n) {
    var best = 0;
    for (var i = 0; i < _eqStops.length; i++) if (_eqStops[i] < n && _eqStops[i] > best) best = _eqStops[i];
    return best;
}

function _eqStopAfter(n) {
    var ta = document.getElementById('eqSource');
    var best = ta ? ta.value.length : n;
    for (var i = 0; i < _eqStops.length; i++) if (_eqStops[i] > n && _eqStops[i] < best) best = _eqStops[i];
    return best;
}

/**
 * Where the caret sits on screen.
 *
 * Anchors nest — the `a` inside `\frac{a}{b}` is inside the span for the whole
 * fraction — so the SMALLEST anchor at an offset is the right one: it is the
 * innermost atom, and the one whose edge a person means when they click there.
 *
 * Not every stop has an anchor. A superscript base is deliberately left
 * un-wrapped, so the caret can legitimately be asked to sit somewhere no span
 * reports. It then takes the nearest anchor on either side, which lands it on
 * the correct glyph edge in every case that matters and never on the far edge
 * of the box.
 */
function _eqCaretSpot(out) {
    var host = out.getBoundingClientRect();
    var spans = out.querySelectorAll('[data-eqo]');
    var exactAfter = null, exactBefore = null, prev = null, next = null;

    for (var i = 0; i < spans.length; i++) {
        var el = spans[i];
        var o = +el.getAttribute('data-eqo'), l = +el.getAttribute('data-eql');
        if (o === _eqCaret && (!exactAfter || l < exactAfter.l)) exactAfter = { el: el, l: l };
        if (o + l === _eqCaret && (!exactBefore || l < exactBefore.l)) exactBefore = { el: el, l: l };
        if (o + l <= _eqCaret && (!prev || o + l > prev.end)) prev = { el: el, end: o + l };
        if (o >= _eqCaret && (!next || o < next.start)) next = { el: el, start: o };
    }

    var pick = exactAfter || exactBefore || prev || next;
    if (!pick) {
        // Nothing to measure — an empty equation, or one with no anchors at
        // all. The caret belongs where the equation would start, not pinned to
        // whichever edge the box happens to have.
        var box = (out.querySelector('.katex-html') || out).getBoundingClientRect();
        return {
            left: (box.width ? box.left : host.left + host.width / 2) - host.left + out.scrollLeft,
            top: (box.height ? box.top : host.top + host.height / 2 - 11) - host.top + out.scrollTop,
            height: box.height || 22,
        };
    }

    var leftEdge = !!(exactAfter || (!exactBefore && !prev && next));
    var r = pick.el.getBoundingClientRect();
    return {
        left: (leftEdge ? r.left : r.right) - host.left + out.scrollLeft,
        top: r.top - host.top + out.scrollTop,
        height: r.height || 22,
    };
}

function _eqDrawCaret() {
    var out = document.getElementById('eqPreview');
    if (!out) return;
    var bar = out.querySelector('.eq-caret');
    if (!out.classList.contains('eq-focus')) { if (bar) bar.parentNode.removeChild(bar); return; }
    if (!bar) {
        bar = document.createElement('span');
        bar.className = 'eq-caret';
        out.appendChild(bar);
    }
    var spot = _eqCaretSpot(out);
    bar.style.left = spot.left + 'px';
    bar.style.top = spot.top + 'px';
    bar.style.height = spot.height + 'px';
}

/** Turn a click anywhere in the box into an offset in the source. */
function _eqCaretFromPoint(out, x, y) {
    var hit = null;
    var spans = out.querySelectorAll('[data-eqo]');
    for (var i = 0; i < spans.length; i++) {
        var el = spans[i];
        var l = +el.getAttribute('data-eql');
        var r = el.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
            if (!hit || l < hit.l) hit = { el: el, l: l, r: r };
        }
    }
    if (!hit) {
        // Clicking past the end of the equation is the commonest way to ask for
        // the end of the equation, so fall back to the nearest atom rather than
        // to nothing.
        var bestD = Infinity;
        for (var k = 0; k < spans.length; k++) {
            var re = spans[k].getBoundingClientRect();
            var dx = x < re.left ? re.left - x : (x > re.right ? x - re.right : 0);
            var dy = y < re.top ? re.top - y : (y > re.bottom ? y - re.bottom : 0);
            var d = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; hit = { el: spans[k], l: +spans[k].getAttribute('data-eql'), r: re }; }
        }
    }
    if (!hit) return _eqCaret;
    var o = +hit.el.getAttribute('data-eqo');
    return x > hit.r.left + hit.r.width / 2 ? o + hit.l : o;
}

// ──────────────────────────────────────────────────────────────────────────────
// Wiring
// ──────────────────────────────────────────────────────────────────────────────

function initEquationEditor() {
    $('#equationEditorToggle').on('click', toggleEquationEditor);
    $('#eqExit').on('click', disableEquationEditor);
    $('#eqNew').on('click', function () { createEquation(); });
    $('#eqInsertCell').on('click', function () {
        if (insertEquationIntoCell()) {
            disableEquationEditor();
            $.toast({ heading: 'Equation Editor', text: 'Inserted into the selected cell', icon: 'success', loader: false, stack: false });
        } else {
            $.toast({ heading: 'Equation Editor', text: 'Select a cell in the table first', icon: 'warning', loader: false, stack: false });
        }
    });
    $('#eqCopy').on('click', function () {
        var ta = document.getElementById('eqSource');
        if (!ta) return;
        navigator.clipboard.writeText(ta.value).then(function () {
            $.toast({ heading: 'Equation Editor', text: 'LaTeX copied', icon: 'success', loader: false, stack: false });
        });
    });

    // Live preview. Debounced by a frame rather than a timer: typing produces
    // one render per paint, which is already the fastest a person can see.
    var pending = false;
    $('#equationCanvas').on('input', '#eqSource', function () {
        var val = this.value;
        if (window.activeEquationId) {
            var eq = getEquation(window.activeEquationId);
            if (eq) { eq.latex = val; if (eq.origin) eq.edited = true; }
        }
        if (pending) return;
        pending = true;
        requestAnimationFrame(function () {
            pending = false;
            _renderPreview();
            _renderEquationList();
        });
    });

    $('#equationCanvas').on('change', '#eqName', function () {
        if (window.activeEquationId) renameEquation(window.activeEquationId, this.value);
    });

    $('#equationCanvas').on('pointerdown mousedown', '.eq-pal-btn', function (e) {
        // Do not blur the rendered box before its palette insertion lands.
        if (document.querySelector('#eqPreview.eq-focus')) e.preventDefault();
    });

    $('#equationCanvas').on('click', '.eq-pal-btn', function () {
        insertLatexSnippet(this.getAttribute('data-tex'));
    });

    // ── The rendered equation is the editing surface ─────────────────────────
    //
    // It is NOT contenteditable, and that is the point: a contenteditable
    // KaTeX tree can be typed into but not read back — the browser would let
    // you edit glyph soup that no longer has a TeX to go with it. Clicks and
    // keys are translated into edits of #eqSource instead, and the box is
    // re-typeset from that. What you see is always the render of what is
    // actually stored.
    //
    // A phone gets the source field instead: a div with no contenteditable
    // never raises the soft keyboard, and a caret you cannot type into is
    // worse than an honest text box.
    $('#equationCanvas').on('mousedown', '#eqPreview', function (e) {
        if (window.matchMedia && window.matchMedia('(max-width: 900px)').matches) return;
        e.preventDefault();
        _eqCaret = _eqCaretFromPoint(this, e.clientX, e.clientY);
        this.focus();
        _eqDrawCaret();
    });

    $('#equationCanvas').on('click', '#eqPreview', function () {
        if (!window.matchMedia || !window.matchMedia('(max-width: 900px)').matches) return;
        var wrap = document.querySelector('.eq-source-wrap');
        if (wrap) wrap.classList.add('eq-source-open');
        var ta = document.getElementById('eqSource');
        if (ta) { ta.focus(); ta.setSelectionRange(_eqCaret, _eqCaret); }
    });

    $('#equationCanvas').on('focus', '#eqPreview', function () {
        this.classList.add('eq-focus');
        _eqDrawCaret();
    });

    $('#equationCanvas').on('blur', '#eqPreview', function () {
        this.classList.remove('eq-focus');
        _eqDrawCaret();
    });

    $('#equationCanvas').on('keydown', '#eqPreview', function (e) {
        var ta = document.getElementById('eqSource');
        if (!ta) return;
        var len = ta.value.length;

        if (e.key === 'ArrowLeft')  { e.preventDefault(); _eqCaret = _eqStopBefore(_eqCaret); _eqDrawCaret(); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); _eqCaret = _eqStopAfter(_eqCaret);  _eqDrawCaret(); return; }
        if (e.key === 'Home')       { e.preventDefault(); _eqCaret = 0;   _eqDrawCaret(); return; }
        if (e.key === 'End')        { e.preventDefault(); _eqCaret = len; _eqDrawCaret(); return; }
        if (e.key === 'Escape')     { this.blur(); return; }

        // Backspace takes the whole atom to the left, so `\alpha` goes in one
        // press. Deleting it a character at a time would spend five of those
        // presses rendering `\alph`, `\alp`, `\al` — none of which is anything.
        if (e.key === 'Backspace') {
            e.preventDefault();
            if (!_eqCaret) return;
            _eqSplice(_eqStopBefore(_eqCaret), _eqCaret, '', _eqStopBefore(_eqCaret));
            return;
        }
        if (e.key === 'Delete') {
            e.preventDefault();
            if (_eqCaret >= len) return;
            _eqSplice(_eqCaret, _eqStopAfter(_eqCaret), '', _eqCaret);
            return;
        }

        if (e.key === 'Enter' || e.key === 'Tab') return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key.length !== 1) return;
        e.preventDefault();
        _eqSplice(_eqCaret, _eqCaret, e.key, _eqCaret + e.key.length);
    });

    $('#equationCanvas').on('paste', '#eqPreview', function (e) {
        var cb = (e.originalEvent || e).clipboardData;
        if (!cb) return;
        e.preventDefault();
        var text = cb.getData('text/plain') || '';
        if (text) _eqSplice(_eqCaret, _eqCaret, text, _eqCaret + text.length);
    });

    // Moving the text cursor in the source field moves the rendered one too, so
    // switching between the two surfaces does not lose your place.
    $('#equationCanvas').on('keyup click select', '#eqSource', function () {
        _eqCaret = this.selectionStart;
    });

    $('#equationCanvas').on('click', '.eq-source-label', function () {
        var wrap = document.querySelector('.eq-source-wrap');
        if (!wrap) return;
        var open = wrap.classList.toggle('eq-source-open');
        this.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    // The caret is placed from measured rectangles, so it has to be redrawn
    // when those move.
    window.addEventListener('resize', function () {
        if (window.equationEditorEnabled) _eqDrawCaret();
    });

    $('#equationCanvas').on('click', '.eq-item-del', function (e) {
        e.stopPropagation();
        deleteEquation(this.getAttribute('data-id'));
    });

    $('#equationCanvas').on('click', '.eq-item', function () {
        selectEquation(this.getAttribute('data-id'));
    });

    // Tab inserts a tab, not a focus change — this is a code editor, and losing
    // your place mid-expression to move focus is never what you meant.
    $('#equationCanvas').on('keydown', '#eqSource', function (e) {
        if (e.key !== 'Tab') return;
        e.preventDefault();
        insertLatexSnippet('  ');
    });

    var preview = document.getElementById('eqPreview');
    if (preview) preview.addEventListener('scroll', _eqDrawCaret);

    _watchTableContainer();
}

// ──────────────────────────────────────────────────────────────────────────────
// Inline cell math: keeping the table view in sync
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Re-render `$…$` whenever the table changes, and hand back the SOURCE whenever
 * a cell is opened for editing.
 *
 * A MutationObserver rather than a render event, because a dozen call sites
 * rebuild #tableContainer (sheet switch, undo, transpose, every Lab transform,
 * node-editor build) and adding a trigger to each is a list that goes stale the
 * first time someone adds a thirteenth. The observer cannot go stale.
 *
 * It is re-entrant by construction — the render pass mutates the container,
 * which fires the observer again — so it is guarded twice: a flag around our
 * own writes, and a render pass that skips subtrees it has already rendered.
 */
function _watchTableContainer() {
    var host = document.getElementById('tableContainer');
    if (!host || host.dataset.eqWatched === '1') return;
    host.dataset.eqWatched = '1';

    var rendering = false;
    var queued = false;
    var observer = new MutationObserver(function () {
        if (rendering || queued) return;
        queued = true;
        requestAnimationFrame(function () {
            queued = false;
            rendering = true;
            try { renderMathInCells(host); } finally { rendering = false; }
        });
    });
    observer.observe(host, { childList: true, subtree: true, characterData: true });

    // Editing a cell must show the TeX, not a picture of it. TAFNE opens a cell
    // by reading its text into a textarea, and the text of a rendered
    // expression is KaTeX's glyph soup — so the render has to come off BEFORE
    // that handler runs. Capture phase guarantees the ordering without
    // depending on which file bound its dblclick handler first.
    host.addEventListener('dblclick', function (e) {
        var cell = e.target && e.target.closest ? e.target.closest('td, th') : null;
        if (cell) unrenderMathInCells(cell);
    }, true);

    renderMathInCells(host);
}

window.EquationEditor = {
    renderLatex: renderLatex,
    renderMathInCells: renderMathInCells,
    unrenderMathInCells: unrenderMathInCells,
    add: addEquation,
    create: createEquation,
    remove: deleteEquation,
    get: getEquation,
    select: selectEquation,
    setLatex: setEquationLatex,
    rename: renameEquation,
    insertIntoCell: insertEquationIntoCell,
    enable: enableEquationEditor,
    disable: disableEquationEditor,
    toggle: toggleEquationEditor,
    list: function () { return window.equations.slice(); },
};

if (typeof $ !== 'undefined') $(document).ready(initEquationEditor);
