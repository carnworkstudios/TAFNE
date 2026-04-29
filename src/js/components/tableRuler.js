// ===================================================================================
// TABLE RULER — column and row index strips around .tablecoil tables
//   renderTableRulers(table) — builds/rebuilds ruler wrap around a table
//   highlightRuler(table, cells) — highlights ruler segments for selected cells
//   destroyRulers(table) — removes ruler wrap and restores table to original position
// ===================================================================================

window.tableRuler = (function () {

    // ── Measure the rendered width of each visual column ─────────────────────
    function _measureCols(mapper) {
        const widths = new Array(mapper.maxCols).fill(null);
        const seen   = new Array(mapper.maxCols).fill(false);

        mapper.cellMap.forEach((info, cell) => {
            if (info.colspan === 1 && !seen[info.startCol]) {
                const w = cell.getBoundingClientRect().width;
                if (w > 0) {
                    widths[info.startCol] = Math.round(w);
                    seen[info.startCol]   = true;
                }
            }
        });

        // Estimate width for columns that only appear inside merged cells
        const nonNull = widths.filter(w => w !== null);
        const avg     = nonNull.length > 0
            ? Math.round(nonNull.reduce((s, w) => s + w, 0) / nonNull.length)
            : 80;

        return widths.map(w => w !== null ? w : avg);
    }

    // ── Measure the rendered height of each table row ─────────────────────────
    function _measureRows(table) {
        return Array.from(table.rows).map(r => {
            const h = r.getBoundingClientRect().height;
            return h > 0 ? Math.round(h) : 24;
        });
    }

    // ── Build and inject ruler strips around a table ──────────────────────────
    function renderTableRulers(table) {
        const $table = $(table);
        if (!$table.length) return;

        // Skip hidden tables (inside collapsed accordion) — will be rebuilt on open
        if ($table[0].getBoundingClientRect().width === 0) return;

        // Remove any existing ruler wrap for this table
        const $existing = $table.closest('.tafne-ruler-wrap');
        if ($existing.length) {
            $existing.before($table);
            $existing.remove();
        }

        const mapper = new VisualGridMapper(table);
        if (mapper.maxCols === 0 || mapper.maxRows === 0) return;

        const colWidths  = _measureCols(mapper);
        const rowHeights = _measureRows(table);

        // Column ruler segments
        const colSegs = colWidths.map((w, i) =>
            `<div class="ruler-seg" data-col="${i}" style="min-width:${w}px;max-width:${w}px">${i + 1}</div>`
        ).join('');

        // Row ruler segments
        const rowSegs = rowHeights.map((h, i) =>
            `<div class="ruler-seg" data-row="${i}" style="min-height:${h}px;max-height:${h}px">${i + 1}</div>`
        ).join('');

        // Assemble wrapper:
        //   header  = [corner | col-ruler-viewport (overflow:hidden, sync'd by JS)]
        //   body    = [row-ruler (always visible) | table-viewport (overflow-x:auto)]
        // The row ruler is outside the horizontal scroll area — no sticky needed.
        const $wrap = $(`
            <div class="tafne-ruler-wrap">
                <div class="tafne-ruler-header">
                    <div class="tafne-corner"></div>
                    <div class="tafne-col-ruler-vp">
                        <div class="tafne-col-ruler">${colSegs}</div>
                    </div>
                </div>
                <div class="tafne-ruler-body">
                    <div class="tafne-row-ruler">${rowSegs}</div>
                    <div class="tafne-table-vp"></div>
                </div>
            </div>
        `);

        // Move table into the table viewport
        $table.before($wrap);
        $wrap.find('.tafne-table-vp').append($table);

        // Sync horizontal scroll: table-vp → col-ruler-vp
        const tableVp    = $wrap.find('.tafne-table-vp')[0];
        const colRulerVp = $wrap.find('.tafne-col-ruler-vp')[0];
        tableVp.addEventListener('scroll', function () {
            colRulerVp.scrollLeft = this.scrollLeft;
        }, { passive: true });

        // Ruler highlight on cell click
        $table.off('click.ruler mousedown.ruler').on('click.ruler mousedown.ruler', 'td, th', function () {
            requestAnimationFrame(() => {
                if (typeof window.highlightRuler === 'function') {
                    window.highlightRuler(table, window.selectedCells);
                }
            });
        });
    }

    // ── Highlight ruler segments matching the current selection ───────────────
    function highlightRuler(table, cells) {
        const $wrap = $(table).closest('.tafne-ruler-wrap');
        if (!$wrap.length) return;

        $wrap.find('.ruler-seg.ruler-active').removeClass('ruler-active');
        if (!cells || cells.length === 0) return;

        const mapper     = new VisualGridMapper(table);
        const activeRows = new Set();
        const activeCols = new Set();

        cells.forEach(cell => {
            const pos = mapper.getVisualPosition(cell);
            if (!pos) return;
            for (let r = pos.startRow; r < pos.startRow + pos.rowspan; r++) activeRows.add(r);
            for (let c = pos.startCol; c < pos.startCol + pos.colspan; c++) activeCols.add(c);
        });

        activeRows.forEach(r => $wrap.find(`.ruler-seg[data-row="${r}"]`).addClass('ruler-active'));
        activeCols.forEach(c => $wrap.find(`.ruler-seg[data-col="${c}"]`).addClass('ruler-active'));
    }

    // ── Remove ruler and restore table to its original parent ─────────────────
    function destroyRulers(table) {
        const $table = $(table);
        const $wrap  = $table.closest('.tafne-ruler-wrap');
        if ($wrap.length) {
            $wrap.before($table);
            $wrap.remove();
        }
    }

    return { renderTableRulers, highlightRuler, destroyRulers };
})();

window.renderTableRulers = window.tableRuler.renderTableRulers;
window.highlightRuler    = window.tableRuler.highlightRuler;
window.destroyRulers     = window.tableRuler.destroyRulers;
