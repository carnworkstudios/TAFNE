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
//      Mode): a list of equations on the left, TeX source and live preview on
//      the right, a symbol palette for the glyphs nobody remembers the macro
//      for.
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
                trust: false,
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

/** Insert a palette snippet at the caret, honouring the `$1` caret marker. */
function insertLatexSnippet(snippet) {
    var ta = document.getElementById('eqSource');
    if (!ta) return;
    var caretIn = snippet.indexOf('$1');
    var text = caretIn >= 0 ? snippet.replace('$1', '') : snippet;
    var start = ta.selectionStart, end = ta.selectionEnd;
    // A selection is treated as the thing being wrapped: select `x+1`, press
    // the fraction button, and it becomes the numerator instead of vanishing.
    var selected = ta.value.slice(start, end);
    if (selected && caretIn >= 0) text = snippet.replace('$1', selected);
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    var caret = caretIn >= 0 && !selected ? start + caretIn : start + text.length;
    ta.setSelectionRange(caret, caret);
    ta.focus();
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
        host.innerHTML = '<p class="eq-empty">No equations yet. Press <b>New</b>, or send some over from the PDF Processor.</p>';
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
    _renderPreview();
}

function _renderPreview() {
    var out = document.getElementById('eqPreview');
    var err = document.getElementById('eqError');
    var ta = document.getElementById('eqSource');
    if (!out || !ta) return;
    var res = renderLatex(ta.value, { displayMode: true });
    out.innerHTML = res.html || '<span class="eq-empty">Nothing to render yet.</span>';
    out.classList.toggle('eq-math-error', !res.ok);
    if (err) {
        err.textContent = res.error || '';
        err.style.display = res.error ? 'block' : 'none';
    }
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

    $('#equationCanvas').on('click', '.eq-pal-btn', function () {
        insertLatexSnippet(this.getAttribute('data-tex'));
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
