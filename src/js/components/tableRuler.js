// ===================================================================================
// TABLE RULER — column and row index strips around .tablecoil tables
//   renderTableRulers(table) — builds/rebuilds ruler wrap around a table
//   highlightRuler(table, cells) — highlights ruler segments for selected cells
//   destroyRulers(table) — removes ruler wrap and restores table to original position
// ===================================================================================

window.tableRuler = (function () {

    const DRAG_THRESHOLD_PX = 4; // pixels of movement before a mousedown becomes a reorder drag

    // Duplicate-mode flag: when true the insert pill duplicates the row/col instead of inserting blank
    let _duplicateMode = false;

    // ── Sync ruler segment sizes to live cell dimensions post-layout ─────────
    // Called after the wrap is in the DOM so getBoundingClientRect is accurate.
    // Row segments: height matches each <tr> height.
    // Col segments: width matches each visual column width (first non-spanning cell wins).
    function _syncRulerSegments(wrap, table) {
        const mapper   = new window.VisualGridMapper(table);
        const $rowSegs = $(wrap).find('.tafne-row-ruler .ruler-seg');
        const $colSegs = $(wrap).find('.tafne-col-ruler .ruler-seg');

        // Row heights — read from live <tr> rects
        const rows = Array.from(table.rows).filter(r => !r.classList.contains('tifany-drag-row') && !r.classList.contains('drop-indicator-row'));
        $rowSegs.each(function (i) {
            const row = rows[i];
            if (!row) return;
            const h = row.getBoundingClientRect().height;
            if (h > 0) $(this).css({ 'min-height': h + 'px', 'max-height': h + 'px', height: h + 'px' });
        });

        // Col widths — for each visual col, find the first non-spanning origin cell and read its width
        const seen = new Array(mapper.maxCols).fill(false);
        mapper.cellMap.forEach((info, cell) => {
            if (info.colspan === 1 && !seen[info.startCol]) {
                const w = cell.getBoundingClientRect().width;
                if (w > 0) {
                    seen[info.startCol] = true;
                    const $seg = $colSegs.filter(`[data-col="${info.startCol}"]`);
                    $seg.css({ 'min-width': w + 'px', 'max-width': w + 'px', width: w + 'px' });
                }
            }
        });
        // Fallback for any unseen cols (all cells spanning): use average of seen
        const seenWidths = $colSegs.toArray().map((s, i) => seen[i] ? parseFloat($(s).css('min-width')) || 0 : 0).filter(w => w > 0);
        const avg = seenWidths.length ? Math.round(seenWidths.reduce((a, b) => a + b, 0) / seenWidths.length) : 80;
        $colSegs.each(function (i) {
            if (!seen[i]) $(this).css({ 'min-width': avg + 'px', 'max-width': avg + 'px', width: avg + 'px' });
        });
    }

    // ── Apply a ruler-driven selection (row or column) ────────────────────────
    function _applyRulerSelection(table, cells, type) {
        const filtered = cells.filter(c => !$(c).hasClass('drag-handle'));
        $(table).find('.selected-cell').removeClass('selected-cell');
        filtered.forEach(c => $(c).addClass('selected-cell'));
        window.selectedCells       = filtered;
        window.selectionAnchorCell = filtered[0]                    || null;
        window.selectionHeadCell   = filtered[filtered.length - 1]  || null;
        window.currentTable        = table;
        const $dd = $('#elementType');
        if ($dd.length) $dd.val(type);
        requestAnimationFrame(() => {
            if (typeof window.highlightRuler === 'function') {
                window.highlightRuler(table, window.selectedCells);
            }
        });
    }

    // ── Click-to-select with optional shift-extend ───────────────────────────
    // anchorRow/Col is stored on the wrap so shift-click can extend from it.
    function _handleRulerRowClick($wrap, table, rowIdx, e) {
        const mapper = new window.VisualGridMapper(table);
        if (e.shiftKey && $wrap[0]._rulerRowAnchor != null) {
            const from = $wrap[0]._rulerRowAnchor;
            const min  = Math.min(from, rowIdx);
            const max  = Math.max(from, rowIdx);
            const cells = [];
            for (let r = min; r <= max; r++) {
                mapper.getCellsInRow(r).forEach(c => { if (!$(c).hasClass('drag-handle')) cells.push(c); });
            }
            _applyRulerSelection(table, cells, 'row');
        } else {
            $wrap[0]._rulerRowAnchor = rowIdx;
            const cells = mapper.getCellsInRow(rowIdx).filter(c => !$(c).hasClass('drag-handle'));
            _applyRulerSelection(table, cells, 'row');
        }
    }

    function _handleRulerColClick($wrap, table, colIdx, e) {
        const mapper = new window.VisualGridMapper(table);
        if (e.shiftKey && $wrap[0]._rulerColAnchor != null) {
            const from = $wrap[0]._rulerColAnchor;
            const min  = Math.min(from, colIdx);
            const max  = Math.max(from, colIdx);
            const cells = [];
            for (let c = min; c <= max; c++) {
                mapper.getCellsInColumn(c).forEach(cell => { if (!$(cell).hasClass('drag-handle')) cells.push(cell); });
            }
            _applyRulerSelection(table, cells, 'column');
        } else {
            $wrap[0]._rulerColAnchor = colIdx;
            const cells = mapper.getCellsInColumn(colIdx).filter(c => !$(c).hasClass('drag-handle'));
            _applyRulerSelection(table, cells, 'column');
        }
    }

    // ── Move row by visual index (insertBefore = target position 0..N) ────────
    function _moveRowByIndex(table, fromIdx, insertBefore) {
        if (insertBefore === fromIdx || insertBefore === fromIdx + 1) return;
        const $rows = $(table).find('tr').not('.tifany-drag-row').not('.drop-indicator-row');
        const $from = $rows.eq(fromIdx);
        if (!$from.length) return;
        if (typeof window.saveCurrentState === 'function') window.saveCurrentState();
        if (insertBefore <= 0) {
            $rows.first().before($from);
        } else if (insertBefore >= $rows.length) {
            $rows.last().after($from);
        } else {
            $rows.eq(insertBefore).before($from);
        }
        requestAnimationFrame(() => renderTableRulers(table));
    }

    // ── Move col by mapper index — no row-handle offset (ruler context) ───────
    function _moveColByIndex(table, fromIdx, insertBefore) {
        if (fromIdx === insertBefore || fromIdx + 1 === insertBefore) return;
        const mapper  = new window.VisualGridMapper(table);
        const moved   = new Set();
        // toIdx: the mapper column before which the dragged column should land
        const toIdx   = insertBefore > fromIdx ? insertBefore - 1 : insertBefore;
        if (typeof window.saveCurrentState === 'function') window.saveCurrentState();

        for (let r = 0; r < mapper.maxRows; r++) {
            const row = mapper.grid[r];
            if (!row) continue;
            const src = row[fromIdx];
            if (!src || !src.isOrigin || moved.has(src.element)) continue;
            moved.add(src.element);
            const $el = $(src.element);
            if ($el.hasClass('drag-handle')) continue;
            const dst = row[toIdx];
            if (dst && dst.isOrigin && dst.element !== src.element) {
                // Insert before (toIdx < fromIdx) or after (toIdx > fromIdx) the destination
                if (insertBefore > fromIdx) {
                    $(dst.element).after($el);
                } else {
                    $(dst.element).before($el);
                }
            } else if (!dst) {
                $el.closest('tr').append($el);
            } else {
                // Target is inside a colspan span — find next origin to the right
                let found = null;
                for (let c = toIdx + 1; c < mapper.maxCols; c++) {
                    if (row[c] && row[c].isOrigin && row[c].element !== src.element) {
                        found = row[c].element;
                        break;
                    }
                }
                if (found) $(found).before($el);
                else $el.closest('tr').append($el);
            }
        }

        requestAnimationFrame(() => renderTableRulers(table));
    }

    // ── Row ruler drag ────────────────────────────────────────────────────────
    function _startRulerRowDrag($wrap, table, rowIdx, e) {
        e.preventDefault();
        e.stopPropagation();
        const $segs = $wrap.find('.tafne-row-ruler .ruler-seg');
        const n     = $segs.length;
        let insertBefore = rowIdx;

        $segs.eq(rowIdx).addClass('ruler-drag-src');

        function onMove(mv) {
            let ib = 0;
            $segs.each(function (i) {
                const rect = this.getBoundingClientRect();
                if (mv.clientY > rect.top + rect.height / 2) ib = i + 1;
            });
            if (ib > n) ib = n;
            insertBefore = ib;
            $segs.removeClass('ruler-drop-before ruler-drop-after');
            if (ib !== rowIdx && ib !== rowIdx + 1) {
                if (ib < n) $segs.eq(ib).addClass('ruler-drop-before');
                else        $segs.eq(n - 1).addClass('ruler-drop-after');
            }
        }

        $(document).on('mousemove.rulerdrag', onMove);
        $(document).one('mouseup.rulerdrag', function () {
            $(document).off('mousemove.rulerdrag');
            $segs.removeClass('ruler-drag-src ruler-drop-before ruler-drop-after');
            _moveRowByIndex(table, rowIdx, insertBefore);
        });
    }

    // ── Col ruler drag ────────────────────────────────────────────────────────
    function _startRulerColDrag($wrap, table, colIdx, e) {
        e.preventDefault();
        e.stopPropagation();
        const $segs  = $wrap.find('.tafne-col-ruler .ruler-seg');
        const n      = $segs.length;
        let insertBefore = colIdx;

        $segs.eq(colIdx).addClass('ruler-drag-src');
        const mapper = new window.VisualGridMapper(table);
        $(mapper.getCellsInColumn(colIdx)).not('.drag-handle').addClass('column-dragging');

        function onMove(mv) {
            let ib = 0;
            $segs.each(function (i) {
                const rect = this.getBoundingClientRect();
                if (mv.clientX > rect.left + rect.width / 2) ib = i + 1;
            });
            if (ib > n) ib = n;
            insertBefore = ib;
            $segs.removeClass('ruler-drop-before ruler-drop-after');
            if (ib !== colIdx && ib !== colIdx + 1) {
                if (ib < n) $segs.eq(ib).addClass('ruler-drop-before');
                else        $segs.eq(n - 1).addClass('ruler-drop-after');
            }
        }

        $(document).on('mousemove.rulerdrag', onMove);
        $(document).one('mouseup.rulerdrag', function () {
            $(document).off('mousemove.rulerdrag');
            $segs.removeClass('ruler-drag-src ruler-drop-before ruler-drop-after');
            $(mapper.getCellsInColumn(colIdx)).removeClass('column-dragging');
            _moveColByIndex(table, colIdx, insertBefore);
        });
    }

    // ── Pill label for current mode ───────────────────────────────────────────
    function _pillLabel() { return _duplicateMode ? '⎘' : '+'; }
    function _pillRowTitle() { return _duplicateMode ? 'Duplicate row below' : 'Insert row after'; }
    function _pillColTitle() { return _duplicateMode ? 'Duplicate column after' : 'Insert column after'; }
    function _cornerTitle()  { return _duplicateMode ? 'Mode: Duplicate — click to switch to Insert' : 'Mode: Insert — click to switch to Duplicate'; }

    // Update every pill label + corner tooltip across all ruler wraps
    function _syncModeUI() {
        const label = _pillLabel();
        $('.tafne-row-ruler .ruler-insert-pill').text(label).attr('title', _pillRowTitle());
        $('.tafne-col-ruler .ruler-insert-pill').text(label).attr('title', _pillColTitle());
        $('.tafne-corner').attr('title', _cornerTitle());
        $('.tafne-ruler-wrap').toggleClass('ruler-dup-mode', _duplicateMode);
    }

    // ── Show the cell context menu at a given viewport position ──────────────
    function _showContextMenuAt(x, y) {
        const $menu = $('#cellContextMenu');
        if (!$menu.length) return;
        $menu.show();
        const menuW = $menu.outerWidth();
        const menuH = $menu.outerHeight();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const pad = 8;
        if (x + menuW + pad > vw) x = Math.max(pad, x - menuW);
        if (y + menuH + pad > vh) y = Math.max(pad, vh - menuH - pad);
        if (y < pad) y = pad;
        $menu.css({ top: y + 'px', left: x + 'px', display: 'grid', position: 'fixed' });
    }

    // ── Build and inject ruler strips around a table ──────────────────────────
    function renderTableRulers(table) {
        const $table = $(table);
        if (!$table.length) return;

        // Skip hidden tables (inside collapsed accordion) — will be rebuilt on open
        if ($table[0].getBoundingClientRect().width === 0) return;

        // Guard against re-entrant calls from ResizeObserver
        if (table._tafneRulerRebuilding) return;

        // Remove any existing ruler wrap for this table
        const $existing = $table.closest('.tafne-ruler-wrap');
        if ($existing.length) {
            $existing.before($table);
            $existing.remove();
        }

        // Disconnect previous MutationObserver (row/col add/delete watcher)
        if (table._tafneStructObs) {
            table._tafneStructObs.disconnect();
            delete table._tafneStructObs;
        }

        const mapper = new VisualGridMapper(table);
        if (mapper.maxCols === 0 || mapper.maxRows === 0) return;

        const nCols = mapper.maxCols;
        const rows  = Array.from(table.rows).filter(r => !r.classList.contains('tifany-drag-row') && !r.classList.contains('drop-indicator-row'));
        const nRows = rows.length;

        const pillLabel = _pillLabel();

        // Build segments without fixed sizes — _syncRulerSegments sets them after DOM insertion
        const colSegs = Array.from({ length: nCols }, (_, i) =>
            `<div class="ruler-seg" data-col="${i}" title="Col ${i + 1}">${i + 1}<span class="ruler-insert-pill" data-col="${i}" title="${_pillColTitle()}">${pillLabel}</span></div>`
        ).join('');

        const rowSegs = Array.from({ length: nRows }, (_, i) =>
            `<div class="ruler-seg" data-row="${i}" title="Row ${i + 1}">${i + 1}<span class="ruler-insert-pill" data-row="${i}" title="${_pillRowTitle()}">${pillLabel}</span></div>`
        ).join('');

        // Assemble wrapper:
        //   header  = [corner | col-ruler-viewport (overflow:hidden, sync'd by JS)]
        //   body    = [row-ruler (always visible) | table-viewport (overflow-x:auto)]
        const $wrap = $(`
            <div class="tafne-ruler-wrap">
                <div class="tafne-ruler-header">
                    <div class="tafne-corner" title="${_cornerTitle()}"></div>
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

        // Sync segment sizes after the browser has laid out the new DOM
        requestAnimationFrame(() => _syncRulerSegments($wrap[0], table));

        // Sync horizontal scroll: table-vp → col-ruler-vp
        const tableVp    = $wrap.find('.tafne-table-vp')[0];
        const colRulerVp = $wrap.find('.tafne-col-ruler-vp')[0];
        tableVp.addEventListener('scroll', function () {
            colRulerVp.scrollLeft = this.scrollLeft;
        }, { passive: true });

        // Apply current dup-mode state
        $wrap.toggleClass('ruler-dup-mode', _duplicateMode);

        // ── Corner: left-click toggles insert/duplicate mode ─────────────────
        const $corner = $wrap.find('.tafne-corner');
        $corner.on('click.ruler', function (e) {
            e.stopPropagation();
            _duplicateMode = !_duplicateMode;
            _syncModeUI();
        });

        // ── Stop pill mousedown from bubbling into the seg drag/select handler ──
        $wrap.on('mousedown.ruler', '.ruler-insert-pill', function (e) {
            e.stopPropagation();
        });

        // ── Row pill: insert or duplicate row after index ─────────────────────
        $wrap.find('.tafne-row-ruler').on('click.ruler', '.ruler-insert-pill', function (e) {
            e.stopPropagation();
            e.preventDefault();
            const idx = parseInt($(this).attr('data-row'), 10);
            const $rows = $(table).find('tr').not('.tifany-drag-row').not('.drop-indicator-row');
            const $target = $rows.eq(idx);
            if (!$target.length) return;
            if (typeof window.saveCurrentState === 'function') window.saveCurrentState();
            if (_duplicateMode) {
                $target.after($target.clone(false));
            } else {
                const colCount = new window.VisualGridMapper(table).maxCols;
                let newRow = '<tr>';
                for (let i = 0; i < colCount; i++) newRow += '<td></td>';
                newRow += '</tr>';
                $target.after(newRow);
            }
            if (typeof window.setupTableInteraction === 'function') window.setupTableInteraction();
        });

        // ── Col pill: insert or duplicate column after index ──────────────────
        $wrap.find('.tafne-col-ruler').on('click.ruler', '.ruler-insert-pill', function (e) {
            e.stopPropagation();
            e.preventDefault();
            const colIdx = parseInt($(this).attr('data-col'), 10);
            const mapper = new window.VisualGridMapper(table);
            if (typeof window.saveCurrentState === 'function') window.saveCurrentState();
            if (_duplicateMode) {
                for (let r = 0; r < mapper.maxRows; r++) {
                    const rowGrid = mapper.grid[r];
                    if (!rowGrid) continue;
                    const gc = rowGrid[colIdx];
                    if (!gc || !gc.isOrigin) continue;
                    $(gc.element).after($(gc.element).clone(false));
                }
            } else {
                for (let r = 0; r < mapper.maxRows; r++) {
                    const rowGrid = mapper.grid[r];
                    if (!rowGrid) continue;
                    const gc = rowGrid[colIdx];
                    if (!gc || !gc.isOrigin) continue;
                    const tag = gc.element.tagName.toLowerCase();
                    $(gc.element).after(`<${tag}></${tag}>`);
                }
            }
            if (typeof window.setupTableInteraction === 'function') window.setupTableInteraction();
        });

        // ── Row ruler: right-click → select row + open cell context menu ─────
        $wrap.find('.tafne-row-ruler').on('contextmenu.ruler', '.ruler-seg', function (e) {
            e.preventDefault();
            e.stopPropagation();
            const rowIdx = parseInt($(this).attr('data-row'), 10);
            _handleRulerRowClick($wrap, table, rowIdx, { shiftKey: false });
            window.cellBeingEdited = table.rows[rowIdx] ? table.rows[rowIdx].cells[0] : null;
            _showContextMenuAt(e.clientX, e.clientY);
        });

        // ── Col ruler: right-click → select column + open cell context menu ──
        $wrap.find('.tafne-col-ruler-vp').on('contextmenu.ruler', '.ruler-seg', function (e) {
            e.preventDefault();
            e.stopPropagation();
            const colIdx = parseInt($(this).attr('data-col'), 10);
            _handleRulerColClick($wrap, table, colIdx, { shiftKey: false });
            const m2 = new window.VisualGridMapper(table);
            const firstCell = m2.getCellsInColumn(colIdx)[0] || null;
            window.cellBeingEdited = firstCell;
            _showContextMenuAt(e.clientX, e.clientY);
        });

        // Ruler highlight on cell click
        $table.off('click.ruler mousedown.ruler').on('click.ruler mousedown.ruler', 'td, th', function () {
            requestAnimationFrame(() => {
                if (typeof window.highlightRuler === 'function') {
                    window.highlightRuler(table, window.selectedCells);
                }
            });
        });

        // ── Row ruler: mousedown → watch for movement threshold ──────────────────
        // If mouse moves > DRAG_THRESHOLD_PX before mouseup  → reorder drag
        // If mouseup without threshold crossed               → select (shift extends)
        $wrap.find('.tafne-row-ruler').on('mousedown', '.ruler-seg', function (e) {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();

            const rowIdx  = parseInt($(this).attr('data-row'), 10);
            const startY  = e.clientY;
            let   dragging = false;

            function onMove(mv) {
                if (!dragging && Math.abs(mv.clientY - startY) > DRAG_THRESHOLD_PX) {
                    dragging = true;
                    $(document).off('mousemove.rulerrowintent mouseup.rulerrowintent');
                    _startRulerRowDrag($wrap, table, rowIdx, mv);
                }
            }
            function onUp() {
                $(document).off('mousemove.rulerrowintent mouseup.rulerrowintent');
                if (!dragging) {
                    _handleRulerRowClick($wrap, table, rowIdx, e);
                }
            }
            $(document).on('mousemove.rulerrowintent', onMove)
                       .one('mouseup.rulerrowintent', onUp);
        });

        // ── Col ruler: same threshold pattern ────────────────────────────────────
        $wrap.find('.tafne-col-ruler-vp').on('mousedown', '.ruler-seg', function (e) {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();

            const colIdx  = parseInt($(this).attr('data-col'), 10);
            const startX  = e.clientX;
            let   dragging = false;

            function onMove(mv) {
                if (!dragging && Math.abs(mv.clientX - startX) > DRAG_THRESHOLD_PX) {
                    dragging = true;
                    $(document).off('mousemove.rulercolintent mouseup.rulercolintent');
                    _startRulerColDrag($wrap, table, colIdx, mv);
                }
            }
            function onUp() {
                $(document).off('mousemove.rulercolintent mouseup.rulercolintent');
                if (!dragging) {
                    _handleRulerColClick($wrap, table, colIdx, e);
                }
            }
            $(document).on('mousemove.rulercolintent', onMove)
                       .one('mouseup.rulercolintent', onUp);
        });

        // ── ResizeObserver + window resize: rebuild ruler if table changes size ─
        if (table._tafneRulerObs) {
            table._tafneRulerObs.disconnect();
        }
        if (table._tafneResizeHandler) {
            window.removeEventListener('resize', table._tafneResizeHandler);
        }

        function _scheduleRulerRebuild() {
            if (table._tafneRulerRebuilding) return;
            clearTimeout(table._tafneRulerTimer);
            table._tafneRulerTimer = setTimeout(() => {
                const $w = $(table).closest('.tafne-ruler-wrap');
                if (!$w.length) return;
                const mapper2 = new window.VisualGridMapper(table);
                const liveRows = Array.from(table.rows).filter(r => !r.classList.contains('tifany-drag-row') && !r.classList.contains('drop-indicator-row')).length;
                const segRows  = $w.find('.tafne-row-ruler .ruler-seg').length;
                const segCols  = $w.find('.tafne-col-ruler .ruler-seg').length;
                if (liveRows === segRows && mapper2.maxCols === segCols) {
                    _syncRulerSegments($w[0], table);
                } else {
                    table._tafneRulerRebuilding = true;
                    renderTableRulers(table);
                    table._tafneRulerRebuilding = false;
                }
            }, 60);
        }

        if (window.ResizeObserver) {
            const ro = new ResizeObserver(_scheduleRulerRebuild);
            ro.observe(table);
            table._tafneRulerObs = ro;
        }

        // Fallback: window resize covers container reflows the ResizeObserver may miss
        table._tafneResizeHandler = _scheduleRulerRebuild;
        window.addEventListener('resize', table._tafneResizeHandler, { passive: true });

        // ── MutationObserver: immediately rebuild on row/cell add or remove ───
        // ResizeObserver only fires after a layout pass; direct DOM mutations
        // (deleteRows, deleteColumns, undo) can remove rows without a resize if
        // the table width stays the same — leaving ghost segments in the ruler.
        if (window.MutationObserver) {
            const mo = new MutationObserver(mutations => {
                const structural = mutations.some(m =>
                    m.type === 'childList' &&
                    (m.addedNodes.length > 0 || m.removedNodes.length > 0)
                );
                if (structural) _scheduleRulerRebuild();
            });
            mo.observe(table, { childList: true, subtree: true });
            table._tafneStructObs = mo;
        }
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
        if (table._tafneRulerObs) {
            table._tafneRulerObs.disconnect();
            delete table._tafneRulerObs;
        }
        if (table._tafneStructObs) {
            table._tafneStructObs.disconnect();
            delete table._tafneStructObs;
        }
        if (table._tafneResizeHandler) {
            window.removeEventListener('resize', table._tafneResizeHandler);
            delete table._tafneResizeHandler;
        }
        clearTimeout(table._tafneRulerTimer);
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
