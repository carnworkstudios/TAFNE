// ===================================================================================
// TABLE RENDER — cell grid → text, in the formats that can hold a merged cell
// and the ones that cannot.
// ===================================================================================
// Pure string building. No DOM, no jQuery, no globals. Browser and the headless
// TableDriver load the SAME file, because a second renderer is a second answer:
// the whole point of this tool is that a merged header cell survives, and two
// implementations of that would eventually disagree about it.
//
// The input is a `gx-tables/2` cell grid — `Cell = {text, colSpan, rowSpan,
// header}` — where a merged cell appears ONCE, at its origin, and claims the
// slots below and right of it (the HTML table model). See assets/os/tables.js.
//
// ── The honest-loss rule ────────────────────────────────────────────────────────
// HTML holds spans. Markdown and CSV cannot express them at all — there is no
// syntax for it. So those renderers report what they had to drop rather than
// flattening quietly: a caller who asked for markdown and got a grid where a
// 2-column header silently became one column has been told something untrue
// about their document. Every renderer returns `{ text, lost }`, and `lost` is
// empty when nothing was.
// ===================================================================================
//
// ── Do not `require()` this file from Node ──────────────────────────────────────
// `tools/table-formatter/package.json` declares "type": "module", so every .js
// in this submodule is ESM. The UMD probe below is therefore FALSE under a Node
// require(): the file exports nothing and require() returns `{}` with no error.
// Load it the way a browser does — evaluate it against a `window` object (see
// `packages/shared/src/table/TableDriver.cjs`). The module.exports branch is
// kept only for a fork that vendors this file into a CommonJS package.

(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.GxTableRender = api;
    // eslint-disable-next-line no-undef
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    function _escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function _cellText(c) {
        if (c == null) return '';
        return String((typeof c === 'object' ? c.text : c) ?? '');
    }

    function _span(c, which) {
        var v = c && typeof c === 'object' ? c[which] : 1;
        return typeof v === 'number' && v > 1 ? v : 1;
    }

    /** Cells that claim more than one slot, as `r{row}c{col}` addresses. */
    function _mergedCells(rows) {
        var out = [];
        (rows || []).forEach(function (row, ri) {
            (row || []).forEach(function (c, ci) {
                var cs = _span(c, 'colSpan'), rs = _span(c, 'rowSpan');
                if (cs > 1 || rs > 1) {
                    out.push({ row: ri, col: ci, colSpan: cs, rowSpan: rs, text: _cellText(c) });
                }
            });
        });
        return out;
    }

    /**
     * The widest row, counting a span as the slots it occupies.
     *
     * Counting cells instead of slots is the classic off-by-a-merge: a header
     * row of two cells where one spans three columns is five columns wide, not
     * two, and every downstream padding decision made from the wrong number is
     * wrong in the same direction.
     */
    function gridWidth(rows) {
        var max = 0;
        (rows || []).forEach(function (row) {
            var w = 0;
            (row || []).forEach(function (c) { w += _span(c, 'colSpan'); });
            if (w > max) max = w;
        });
        return max;
    }

    /** HTML — the only one of the three that can hold a span. */
    function toHtml(rows, opts) {
        opts = opts || {};
        var cls = opts.className || 'tablecoil crosshair-table';
        var html = '<table class="' + _escHtml(cls) + '">';
        (rows || []).forEach(function (row) {
            html += '<tr>';
            (row || []).forEach(function (c) {
                var tag = (c && typeof c === 'object' && c.header) ? 'th' : 'td';
                var attrs = '';
                var cs = _span(c, 'colSpan'), rs = _span(c, 'rowSpan');
                if (cs > 1) attrs += ' colspan="' + cs + '"';
                if (rs > 1) attrs += ' rowspan="' + rs + '"';
                html += '<' + tag + attrs + '>' + _escHtml(_cellText(c)) + '</' + tag + '>';
            });
            html += '</tr>';
        });
        return { text: html + '</table>', lost: [] };
    }

    /**
     * Expand the grid so every slot a span covers is a real position.
     *
     * Needed by the flat formats: markdown and CSV are positional, so a cell
     * that claims three slots has to become three positions or every column
     * after it shifts left and the file silently misaligns.
     *
     * The repeated slots carry `''`, not a copy of the text. Copying is how a
     * "Q1 2026" header spanning three months becomes three columns all called
     * "Q1 2026", which reads as real data and is not.
     */
    function expand(rows) {
        var out = [];
        var pending = {};   // "row,col" → filler owed by a rowSpan above
        var width = gridWidth(rows);

        (rows || []).forEach(function (row, ri) {
            var line = [];
            var ci = 0;
            (row || []).forEach(function (c) {
                while (pending[ri + ',' + ci]) { line.push(''); delete pending[ri + ',' + ci]; ci++; }
                line.push(_cellText(c));
                var cs = _span(c, 'colSpan'), rs = _span(c, 'rowSpan');
                for (var k = 1; k < cs; k++) { line.push(''); }
                for (var dr = 1; dr < rs; dr++) {
                    for (var dc = 0; dc < cs; dc++) pending[(ri + dr) + ',' + (ci + dc)] = true;
                }
                ci += cs;
            });
            while (pending[ri + ',' + ci]) { line.push(''); delete pending[ri + ',' + ci]; ci++; }
            while (line.length < width) line.push('');
            out.push(line);
        });
        return out;
    }

    /**
     * Which row carries the real column names.
     *
     * The LAST header row, not the first. A two-tier header — "Q1 2026"
     * spanning three columns above "Jan | Feb | Mar" — has its actual column
     * names on the lower tier, and taking the first header row makes the
     * output claim the table has one column called "Q1 2026" and two blanks.
     * Earlier tiers are kept as body rows (their text is real) and reported,
     * because neither markdown nor CSV can put a row above the header.
     */
    function headerRowIndex(rows) {
        var last = -1;
        (rows || []).forEach(function (r, i) {
            if ((r || []).some(function (c) { return c && typeof c === 'object' && c.header; })) last = i;
        });
        return last >= 0 ? last : 0;
    }

    function _tierLoss(rows, hi) {
        var out = [];
        for (var i = 0; i < hi; i++) {
            var isHeaderTier = (rows[i] || []).some(function (c) { return c && typeof c === 'object' && c.header; });
            if (isHeaderTier) {
                out.push('header tier at row ' + i + ' could not stay above the header — ' +
                    'kept as a body row when rendering, dropped when producing data rows');
            }
        }
        return out;
    }

    function toMarkdown(rows) {
        var merged = _mergedCells(rows);
        var grid = expand(rows);
        if (!grid.length) return { text: '', lost: [] };

        var esc = function (s) { return String(s).replace(/\|/g, '\\|'); };
        var hi = headerRowIndex(rows);

        var lines = [];
        lines.push('| ' + grid[hi].map(esc).join(' | ') + ' |');
        lines.push('| ' + grid[hi].map(function () { return '---'; }).join(' | ') + ' |');
        grid.forEach(function (r, i) {
            if (i === hi) return;
            lines.push('| ' + r.map(esc).join(' | ') + ' |');
        });

        return {
            text: lines.join('\n'),
            // Named, not counted: "3 merged cells were flattened" is a fact the
            // caller can act on; a silent flatten is one they cannot.
            lost: merged.map(function (m) {
                return 'merged cell "' + m.text + '" at r' + m.row + 'c' + m.col +
                    ' (' + m.colSpan + '×' + m.rowSpan + ') — markdown has no span syntax';
            }).concat(_tierLoss(rows, hi)),
        };
    }

    function toCsv(rows, opts) {
        opts = opts || {};
        var sep = opts.delimiter || ',';
        var merged = _mergedCells(rows);
        var grid = expand(rows);
        var q = function (s) {
            s = String(s);
            return /["\n\r]/.test(s) || s.indexOf(sep) >= 0
                ? '"' + s.replace(/"/g, '""') + '"'
                : s;
        };
        return {
            text: grid.map(function (r) { return r.map(q).join(sep); }).join('\n'),
            lost: merged.map(function (m) {
                return 'merged cell "' + m.text + '" at r' + m.row + 'c' + m.col +
                    ' (' + m.colSpan + '×' + m.rowSpan + ') — CSV has no span syntax';
            }),
        };
    }

    /** Rows of objects keyed by the header row — the flat shape most callers expect. */
    function toObjects(rows) {
        var merged = _mergedCells(rows);
        var grid = expand(rows);
        if (!grid.length) return { rows: [], lost: [] };
        var hi = headerRowIndex(rows);
        var seen = {};
        var headers = grid[hi].map(function (h, j) {
            var name = String(h || '').trim() || ('column_' + (j + 1));
            // Object keys must be unique or a duplicate header silently eats the
            // column before it.
            if (seen[name] != null) { seen[name]++; name = name + '_' + seen[name]; }
            else seen[name] = 1;
            return name;
        });
        // Every header row is skipped, not just the one supplying the names.
        // The flat renderers DEMOTE an upper tier to a body row because the text
        // is still worth showing; object rows are DATA, and a "Q1 2026" tier
        // entering a consolidation as a record with every other field blank is
        // a phantom row that silently becomes its own group.
        var out = [];
        grid.forEach(function (r, i) {
            if (i === hi) return;
            var srcRow = (rows || [])[i] || [];
            var isHeaderTier = srcRow.some(function (c) { return c && typeof c === 'object' && c.header; });
            if (isHeaderTier) return;
            var o = {};
            headers.forEach(function (h, j) { o[h] = r[j] ?? ''; });
            out.push(o);
        });
        return {
            rows: out, headers: headers,
            lost: (merged.length
                ? ['flattened ' + merged.length + ' merged cell(s) — an object row has no span']
                : []).concat(_tierLoss(rows, hi)),
        };
    }

    /** Objects (the legacy flat shape) → a cell grid, so one path serves both. */
    function fromObjects(objRows) {
        objRows = objRows || [];
        if (!objRows.length) return [];
        var headers = Object.keys(objRows[0]);
        var grid = [headers.map(function (h) {
            return { text: String(h), colSpan: 1, rowSpan: 1, header: true };
        })];
        objRows.forEach(function (o) {
            grid.push(headers.map(function (h) {
                return { text: String(o[h] ?? ''), colSpan: 1, rowSpan: 1, header: false };
            }));
        });
        return grid;
    }

    return {
        toHtml: toHtml,
        toMarkdown: toMarkdown,
        toCsv: toCsv,
        toObjects: toObjects,
        fromObjects: fromObjects,
        expand: expand,
        gridWidth: gridWidth,
        headerRowIndex: headerRowIndex,
    };
});
