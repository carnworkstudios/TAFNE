// ====================================== CELL SELECTION HANDLES ======================================
// Numbers-style direct manipulation for a rectangular cell selection.
//
//   • Drag the selection BORDER            → move the whole block (multi-cell), overwriting the target.
//   • Drag an EDGE node (○ mid-edge)       → extend the selection and MERGE the covered cells.
//   • Drag the CORNER node (◪ bottom-right)→ FILL/duplicate the block's content into the swept cells.
//
// The overlay is a single body-level, position:fixed element that tracks the selection's bounding box
// in viewport coordinates. Its interior is pointer-events:none so normal cell editing still works;
// only the border hit-frame and the handles capture the mouse.
(function () {
    const OVERLAY_ID = 'tfSelHandles';
    let $overlay = null;
    let gestureActive = false;

    // ── Geometry helpers ──────────────────────────────────────────────────────
    function activeTable() {
        return window.currentTable || null;
    }

    // Rectangular bounds of the current selection in visual grid coordinates.
    // Returns null when there is no usable selection.
    function getSelectionBox() {
        const table = activeTable();
        const cells = window.selectedCells || [];
        if (!table || cells.length === 0) return null;

        const mapper = new window.VisualGridMapper(table);
        let minR = Infinity, minC = Infinity, maxR = -Infinity, maxC = -Infinity;
        let hasSpan = false;

        cells.forEach(cell => {
            const p = mapper.getVisualPosition(cell);
            if (!p) return;
            if (p.rowspan > 1 || p.colspan > 1) hasSpan = true;
            minR = Math.min(minR, p.startRow);
            minC = Math.min(minC, p.startCol);
            maxR = Math.max(maxR, p.startRow + p.rowspan - 1);
            maxC = Math.max(maxC, p.startCol + p.colspan - 1);
        });

        if (!isFinite(minR)) return null;
        return { minR, minC, maxR, maxC, mapper, hasSpan };
    }

    // Viewport bounding rect that encloses grid cells [r0..r1]×[c0..c1].
    //
    // Hidden cells are skipped, not measured. A display:none cell reports a
    // 0×0 rect at the viewport origin, so one sp- column inside the region was
    // enough to drag the box's left edge to x=0 and stretch it across the page.
    function boundsForRegion(mapper, r0, c0, r1, c1) {
        let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
                const gc = mapper.grid[r] && mapper.grid[r][c];
                if (!gc || !window.isCellVisible(gc.element)) continue;
                const rect = gc.element.getBoundingClientRect();
                left = Math.min(left, rect.left);
                top = Math.min(top, rect.top);
                right = Math.max(right, rect.right);
                bottom = Math.max(bottom, rect.bottom);
            }
        }
        if (!isFinite(left)) return null;
        return { left, top, width: right - left, height: bottom - top };
    }

    // Cell (td/th) currently under the pointer, if any, restricted to the active table.
    function cellUnderPoint(x, y) {
        const el = document.elementFromPoint(x, y);
        if (!el) return null;
        const cell = el.closest ? el.closest('td, th') : null;
        if (!cell) return null;
        if (cell.closest('table') !== activeTable()) return null;
        if (cell.classList.contains('drag-handle')) return null;
        return cell;
    }

    // ── Overlay construction / positioning ────────────────────────────────────
    function ensureOverlay() {
        if ($overlay && $overlay.length && document.body.contains($overlay[0])) return $overlay;
        $overlay = $(
            '<div id="' + OVERLAY_ID + '" class="tf-sel-overlay" style="display:none;">' +
                '<div class="tf-sel-edge tf-sel-edge-top"></div>' +
                '<div class="tf-sel-edge tf-sel-edge-right"></div>' +
                '<div class="tf-sel-edge tf-sel-edge-bottom"></div>' +
                '<div class="tf-sel-edge tf-sel-edge-left"></div>' +
                '<div class="tf-sel-node tf-sel-node-top"    data-edge="top"></div>' +
                '<div class="tf-sel-node tf-sel-node-right"  data-edge="right"></div>' +
                '<div class="tf-sel-node tf-sel-node-bottom" data-edge="bottom"></div>' +
                '<div class="tf-sel-node tf-sel-node-left"   data-edge="left"></div>' +
                '<div class="tf-sel-fill" title="Drag to fill / duplicate"></div>' +
            '</div>'
        );
        $('body').append($overlay);
        wireGestures();
        return $overlay;
    }

    // Recompute the overlay box from the live selection. Safe to call often.
    function updateSelectionHandles() {
        if (gestureActive) return; // don't fight an in-flight drag
        // Every path that changes the selection lands here, so this is the one
        // place that has to keep the active-cell ring on the right cell.
        if (typeof window.syncActiveCell === 'function') window.syncActiveCell();
        const box = getSelectionBox();
        if (!box) { hideHandles(); return; }

        ensureOverlay();
        const rect = boundsForRegion(box.mapper, box.minR, box.minC, box.maxR, box.maxC);
        if (!rect) { hideHandles(); return; }

        $overlay.css({
            left: rect.left + 'px',
            top: rect.top + 'px',
            width: rect.width + 'px',
            height: rect.height + 'px',
            display: 'block'
        });
    }

    function hideHandles() {
        if ($overlay) $overlay.hide();
    }

    // ── Live preview highlight (reuses .selected-cell styling) ────────────────
    function highlightRegion(mapper, r0, c0, r1, c1) {
        const table = activeTable();
        $(table).find('.selected-cell').removeClass('selected-cell');
        window.selectedCells = [];
        const clampR1 = Math.min(r1, mapper.maxRows - 1);
        const clampC1 = Math.min(c1, mapper.maxCols - 1);
        for (let r = r0; r <= clampR1; r++) {
            for (let c = c0; c <= clampC1; c++) {
                const gc = mapper.grid[r] && mapper.grid[r][c];
                if (gc && gc.isOrigin && window.isCellVisible(gc.element)) {
                    $(gc.element).addClass('selected-cell');
                    if (!window.selectedCells.includes(gc.element)) window.selectedCells.push(gc.element);
                }
            }
        }
    }

    // ── Data operations ───────────────────────────────────────────────────────

    // Read the html content of the source region into a 2D array [rows][cols].
    function readRegion(mapper, r0, c0, r1, c1) {
        const out = [];
        for (let r = r0; r <= r1; r++) {
            const line = [];
            for (let c = c0; c <= c1; c++) {
                const gc = mapper.grid[r] && mapper.grid[r][c];
                line.push(gc && gc.isOrigin ? $(gc.element).html() : '');
            }
            out.push(line);
        }
        return out;
    }

    // Move the block so its top-left lands at (destR, destC). Source cells are cleared;
    // destination cells are overwritten. No structural change, so the mapper stays valid.
    function applyMove(box, destR, destC) {
        const { mapper, minR, minC, maxR, maxC } = box;
        const rows = maxR - minR;
        const cols = maxC - minC;

        // Clamp destination into the grid.
        destR = Math.max(0, Math.min(destR, mapper.maxRows - 1 - rows));
        destC = Math.max(0, Math.min(destC, mapper.maxCols - 1 - cols));
        if (destR === minR && destC === minC) return false;

        // Every destination cell must be a real, unspanned origin cell.
        for (let r = 0; r <= rows; r++) {
            for (let c = 0; c <= cols; c++) {
                const gc = mapper.grid[destR + r] && mapper.grid[destR + r][destC + c];
                if (!gc || !gc.isOrigin) return false;
                // Landing on a column the active tab hides would move the block
                // somewhere the user cannot see it.
                if (!window.isCellVisible(gc.element)) return false;
                const p = mapper.getVisualPosition(gc.element);
                if (p.rowspan > 1 || p.colspan > 1) return false;
            }
        }

        window.saveCurrentState();
        const content = readRegion(mapper, minR, minC, maxR, maxC);

        // Clear source first (so overlapping moves don't smear).
        for (let r = minR; r <= maxR; r++) {
            for (let c = minC; c <= maxC; c++) {
                const gc = mapper.grid[r][c];
                if (gc && gc.isOrigin) $(gc.element).empty();
            }
        }
        // Write into destination.
        for (let r = 0; r <= rows; r++) {
            for (let c = 0; c <= cols; c++) {
                const gc = mapper.grid[destR + r][destC + c];
                $(gc.element).html(content[r][c]);
            }
        }

        // Reselect the moved block.
        const table = activeTable();
        $(table).find('.selected-cell').removeClass('selected-cell');
        window.selectedCells = [];
        for (let r = 0; r <= rows; r++) {
            for (let c = 0; c <= cols; c++) {
                const el = mapper.grid[destR + r][destC + c].element;
                $(el).addClass('selected-cell');
                window.selectedCells.push(el);
            }
        }
        window.saveCurrentState();
        return true;
    }

    // Tile the source block's content into the extended region [minR..er]×[minC..ec].
    function applyFill(box, er, ec) {
        const { mapper, minR, minC, maxR, maxC } = box;
        er = Math.min(Math.max(er, maxR), mapper.maxRows - 1);
        ec = Math.min(Math.max(ec, maxC), mapper.maxCols - 1);
        if (er === maxR && ec === maxC) return false;

        const srcRows = maxR - minR + 1;
        const srcCols = maxC - minC + 1;
        const content = readRegion(mapper, minR, minC, maxR, maxC);

        // Validate the extension cells are unspanned origins.
        for (let r = minR; r <= er; r++) {
            for (let c = minC; c <= ec; c++) {
                if (r <= maxR && c <= maxC) continue; // inside source, untouched
                const gc = mapper.grid[r] && mapper.grid[r][c];
                if (!gc || !gc.isOrigin) return false;
                // Filling across a hidden sp- column would write into the tab
                // the user is not looking at, invisibly.
                if (!window.isCellVisible(gc.element)) return false;
                const p = mapper.getVisualPosition(gc.element);
                if (p.rowspan > 1 || p.colspan > 1) return false;
            }
        }

        window.saveCurrentState();
        for (let r = minR; r <= er; r++) {
            for (let c = minC; c <= ec; c++) {
                if (r <= maxR && c <= maxC) continue;
                const gc = mapper.grid[r][c];
                const src = content[(r - minR) % srcRows][(c - minC) % srcCols];
                $(gc.element).html(src);
            }
        }

        highlightRegion(mapper, minR, minC, er, ec);
        window.saveCurrentState();
        return true;
    }

    function setSpanAttr(el, attr, val) {
        if (val > 1) el.setAttribute(attr, val);
        else el.removeAttribute(attr);
    }

    // Grow the anchor cell's span so it covers the rectangle [r0..r1]×[c0..c1]. Only ever grows
    // (the target is clamped to include the anchor's current extent), so a drag never destroys the
    // anchor. Horizontal growth never deletes content: swept plain cells are bumped to the right,
    // and rows the anchor doesn't cover are padded to match — so dragging past the right edge
    // creates new columns. Vertical growth absorbs swept plain cells (classic merge); dragging past
    // the bottom edge creates the missing rows. For a top/left stretch the anchor's origin moves
    // up/left; for top the <td> is relocated into the new top row.
    function applySpanGrow(aBase, r0, c0, r1, c1) {
        const table = activeTable();
        if (!table) return false;
        const m = new window.VisualGridMapper(table);
        const anchor = aBase.el;
        const p = m.getVisualPosition(anchor);
        if (!p) return false;

        const ar0 = p.startRow, ac0 = p.startCol;
        const ar1 = ar0 + p.rowspan - 1, ac1 = ac0 + p.colspan - 1;

        // Grow-only. Top/left clamp at the grid origin; right/bottom may exceed the grid —
        // the overshoot becomes new columns/rows.
        r0 = Math.max(0, Math.min(r0, ar0));
        c0 = Math.max(0, Math.min(c0, ac0));
        r1 = Math.max(r1, ar1);
        c1 = Math.max(c1, ac1);
        if (r0 === ar0 && c0 === ac0 && r1 === ar1 && c1 === ac1) return false;

        const horizontal = (c0 !== ac0 || c1 !== ac1);

        // Existing cells in the swept area must be plain 1×1 origins.
        const swept = [];
        const chkR1 = Math.min(r1, m.maxRows - 1);
        const chkC1 = Math.min(c1, m.maxCols - 1);
        for (let r = r0; r <= chkR1; r++) {
            for (let c = c0; c <= chkC1; c++) {
                if (r >= ar0 && r <= ar1 && c >= ac0 && c <= ac1) continue; // anchor's own area
                const gc = m.grid[r] && m.grid[r][c];
                if (!gc) continue; // ragged spot — the span just covers it
                const pp = m.getVisualPosition(gc.element);
                if (!gc.isOrigin || pp.rowspan > 1 || pp.colspan > 1) {
                    $.toast({ heading: 'Info', text: 'Can only stretch over plain, unmerged cells.', icon: 'warning', loader: false, stack: false });
                    return false;
                }
                swept.push(gc.element);
            }
        }

        window.saveCurrentState();

        const newColspan = c1 - c0 + 1;
        const newRowspan = r1 - r0 + 1;
        const $trs = $(table).find('tr');

        if (horizontal) {
            const growCols = newColspan - (ac1 - ac0 + 1);
            // Left stretch: relocate the anchor before the cells it now bumps rightward.
            if (c0 < ac0) {
                let ref = null;
                $trs.eq(ar0).children('td, th').each(function () {
                    if (this === anchor) return;
                    const pos = m.getVisualPosition(this);
                    if (pos && pos.startCol >= c0) { ref = this; return false; }
                });
                if (ref) $(ref).before(anchor);
            }
            // Widening the anchor pushes the swept cells right; pad the rows the anchor
            // doesn't cover so every row gains the same number of columns.
            $trs.each(function (i) {
                if (i >= ar0 && i <= ar1) return;
                for (let k = 0; k < growCols; k++) {
                    const tag = this.lastElementChild ? this.lastElementChild.tagName : 'td';
                    this.appendChild(document.createElement(tag));
                }
            });
        } else {
            // Vertical stretch: absorb the swept plain cells.
            swept.forEach(el => el.remove());

            // Relocate the anchor <td> into the new top row before applying the taller rowspan,
            // so it lives in its top-left cell as required by HTML table semantics.
            if (r0 < ar0) {
                const m2 = new window.VisualGridMapper(table);
                const $targetTr = $trs.eq(r0);
                let ref = null;
                $targetTr.children('td, th').each(function () {
                    if (this === anchor) return;
                    const pos = m2.getVisualPosition(this);
                    if (pos && pos.startCol >= c0) { ref = this; return false; }
                });
                if (ref) $(ref).before(anchor);
                else $targetTr.append(anchor);
            }

            // Bottom stretch past the last row: create the missing rows. The anchor's span
            // fills its own columns there, so new rows only need cells for the remainder.
            if (r1 > m.maxRows - 1) {
                const parent = $trs.last().parent()[0] || table;
                for (let r = m.maxRows; r <= r1; r++) {
                    const tr = document.createElement('tr');
                    for (let k = 0; k < m.maxCols - newColspan; k++) {
                        tr.appendChild(document.createElement('td'));
                    }
                    parent.appendChild(tr);
                }
            }
        }

        setSpanAttr(anchor, 'colspan', newColspan);
        setSpanAttr(anchor, 'rowspan', newRowspan);

        // Reselect just the stretched cell.
        $(table).find('.selected-cell').removeClass('selected-cell');
        window.selectedCells = [anchor];
        $(anchor).addClass('selected-cell');
        window.saveCurrentState();
        return true;
    }

    // ── Gesture wiring ────────────────────────────────────────────────────────
    function beginGesture(kind, ev, edge) {
        ev.preventDefault();
        ev.stopPropagation();
        const box = getSelectionBox();
        if (!box) return;

        if ((kind === 'move' || kind === 'fill') && box.hasSpan) {
            $.toast({ heading: 'Info', text: 'Unmerge the selection before you move or fill it.', icon: 'warning', loader: false, stack: false });
            return;
        }

        // For span-stretch, operate on the single anchor cell (top-left origin of the selection)
        // and remember its current extent so we only ever grow one boundary toward the drag.
        let aBase = null;
        if (kind === 'span') {
            const anchorEl = box.mapper.grid[box.minR] && box.mapper.grid[box.minR][box.minC] && box.mapper.grid[box.minR][box.minC].element;
            const p = anchorEl && box.mapper.getVisualPosition(anchorEl);
            if (!p) return;
            aBase = { el: anchorEl, r0: p.startRow, c0: p.startCol, r1: p.startRow + p.rowspan - 1, c1: p.startCol + p.colspan - 1 };
        }

        gestureActive = true;
        $overlay.addClass('tf-gesturing');           // interior pointer-events:none during drag
        $('body').addClass('tf-no-select');

        const startCell = cellUnderPoint(ev.clientX, ev.clientY);
        const refPos = startCell ? box.mapper.getVisualPosition(startCell) : null;
        let lastKey = '';

        // Preview + record a span target; er/ec may extend past the existing grid, in which
        // case the overlay is stretched by the table's average column width / row height.
        function previewSpan(sr, sc, er, ec) {
            const key = sr + ':' + sc + ':' + er + ':' + ec;
            if (key === lastKey) return;
            lastKey = key;
            const m = box.mapper;
            const inEr = Math.min(er, m.maxRows - 1);
            const inEc = Math.min(ec, m.maxCols - 1);
            highlightRegion(m, sr, sc, inEr, inEc);
            const rect = boundsForRegion(m, sr, sc, inEr, inEc);
            if (rect) {
                const tRect = activeTable().getBoundingClientRect();
                if (ec > inEc) rect.width += (ec - inEc) * (tRect.width / m.maxCols);
                if (er > inEr) rect.height += (er - inEr) * (tRect.height / m.maxRows);
                $overlay.css({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
            }
            $overlay[0].dataset.spSr = sr; $overlay[0].dataset.spSc = sc;
            $overlay[0].dataset.spEr = er; $overlay[0].dataset.spEc = ec;
        }

        function onMove(mv) {
            const cur = cellUnderPoint(mv.clientX, mv.clientY);
            if (!cur) {
                // Span drags may leave the table: past the right/bottom edge the target
                // extends into columns/rows that don't exist yet and get created on drop.
                if (kind !== 'span') return;
                const tRect = activeTable().getBoundingClientRect();
                const m = box.mapper;
                if (edge === 'right' && mv.clientX > tRect.right) {
                    const extra = Math.max(1, Math.ceil((mv.clientX - tRect.right) / (tRect.width / m.maxCols)));
                    previewSpan(aBase.r0, aBase.c0, aBase.r1, Math.max(aBase.c1, m.maxCols - 1 + extra));
                } else if (edge === 'bottom' && mv.clientY > tRect.bottom) {
                    const extra = Math.max(1, Math.ceil((mv.clientY - tRect.bottom) / (tRect.height / m.maxRows)));
                    previewSpan(aBase.r0, aBase.c0, Math.max(aBase.r1, m.maxRows - 1 + extra), aBase.c1);
                }
                return;
            }
            const p = box.mapper.getVisualPosition(cur);
            if (!p) return;

            if (kind === 'move') {
                const dr = refPos ? p.startRow - refPos.startRow : p.startRow - box.minR;
                const dc = refPos ? p.startCol - refPos.startCol : p.startCol - box.minC;
                let destR = box.minR + dr, destC = box.minC + dc;
                destR = Math.max(0, Math.min(destR, box.mapper.maxRows - 1 - (box.maxR - box.minR)));
                destC = Math.max(0, Math.min(destC, box.mapper.maxCols - 1 - (box.maxC - box.minC)));
                const key = destR + ':' + destC;
                if (key === lastKey) return;
                lastKey = key;
                const rect = boundsForRegion(box.mapper, destR, destC,
                    destR + (box.maxR - box.minR), destC + (box.maxC - box.minC));
                if (rect) $overlay.css({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
            } else if (kind === 'fill') {
                const er = Math.max(box.maxR, p.startRow);
                const ec = Math.max(box.maxC, p.startCol);
                const key = er + ':' + ec;
                if (key === lastKey) return;
                lastKey = key;
                const rect = boundsForRegion(box.mapper, box.minR, box.minC, er, ec);
                if (rect) $overlay.css({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
                $overlay[0].dataset.fillR = er;
                $overlay[0].dataset.fillC = ec;
            } else if (kind === 'span') {
                // Grow exactly one boundary of the anchor cell toward the cursor.
                let sr = aBase.r0, sc = aBase.c0, er = aBase.r1, ec = aBase.c1;
                if (edge === 'right')  ec = Math.max(aBase.c1, p.startCol + p.colspan - 1);
                if (edge === 'left')   sc = Math.min(aBase.c0, p.startCol);
                if (edge === 'bottom') er = Math.max(aBase.r1, p.startRow + p.rowspan - 1);
                if (edge === 'top')    sr = Math.min(aBase.r0, p.startRow);
                previewSpan(sr, sc, er, ec);
            }
        }

        function onUp(up) {
            $(document).off('mousemove.tfhandle mouseup.tfhandle');
            gestureActive = false;
            $overlay.removeClass('tf-gesturing');
            $('body').removeClass('tf-no-select');

            const cur = cellUnderPoint(up.clientX, up.clientY);
            if (kind === 'move' && cur) {
                const p = box.mapper.getVisualPosition(cur);
                if (p) {
                    const dr = refPos ? p.startRow - refPos.startRow : p.startRow - box.minR;
                    const dc = refPos ? p.startCol - refPos.startCol : p.startCol - box.minC;
                    applyMove(box, box.minR + dr, box.minC + dc);
                }
            } else if (kind === 'fill') {
                const er = parseInt($overlay[0].dataset.fillR, 10);
                const ec = parseInt($overlay[0].dataset.fillC, 10);
                if (!isNaN(er) && !isNaN(ec)) applyFill(box, er, ec);
            } else if (kind === 'span') {
                const sr = parseInt($overlay[0].dataset.spSr, 10);
                const sc = parseInt($overlay[0].dataset.spSc, 10);
                const er = parseInt($overlay[0].dataset.spEr, 10);
                const ec = parseInt($overlay[0].dataset.spEc, 10);
                if (![sr, sc, er, ec].some(isNaN)) applySpanGrow(aBase, sr, sc, er, ec);
            }

            delete $overlay[0].dataset.fillR; delete $overlay[0].dataset.fillC;
            delete $overlay[0].dataset.spSr; delete $overlay[0].dataset.spSc;
            delete $overlay[0].dataset.spEr; delete $overlay[0].dataset.spEc;

            if (typeof window.renderTableRulers === 'function' && activeTable()) {
                window.renderTableRulers(activeTable());
            }
            updateSelectionHandles();
            if (typeof window.populateStylesPanel === 'function') window.populateStylesPanel();
        }

        $(document).on('mousemove.tfhandle', onMove).on('mouseup.tfhandle', onUp);
    }

    function wireGestures() {
        // Border edges → move, but ONLY on the second press of a double-click.
        //
        // The border hit-frame surrounds the entire selection, so a plain
        // press-and-drag anywhere near the selection's edge started moving the
        // block. That is the same gesture as "click a cell and drag to extend a
        // selection", and it fired far more often by accident than on purpose:
        // a single stray drag overwrote the target cells.
        //
        // e.detail is the click count the browser already tracks, so the second
        // mousedown of a double-click reads 2. Requiring it means a move is
        // always deliberate, and the double-click-then-drag gesture is
        // untouched — it is now the only way in.
        $overlay.on('mousedown', '.tf-sel-edge', function (e) {
            if (e.detail < 2) return;   // single press: let the click fall through
            beginGesture('move', e);
        });
        // Edge nodes → stretch span (colspan/rowspan grows toward the drag)
        $overlay.on('mousedown', '.tf-sel-node', function (e) { beginGesture('span', e, $(this).attr('data-edge')); });
        // Corner → fill/duplicate
        $overlay.on('mousedown', '.tf-sel-fill', function (e) { beginGesture('fill', e); });
    }

    // ── Reposition on scroll / resize ─────────────────────────────────────────
    // Capture-phase scroll catches scrolling inside any container (e.g. .tafne-table-vp),
    // not just the window.
    window.addEventListener('resize', function () { if (!gestureActive) updateSelectionHandles(); });
    document.addEventListener('scroll', function () { if (!gestureActive) updateSelectionHandles(); }, true);

    window.updateSelectionHandles = updateSelectionHandles;
    window.hideSelectionHandles = hideHandles;

    // Internal seams exposed for unit tests; no effect on runtime behavior.
    window.__cellHandlesInternals = { getSelectionBox, readRegion, applyMove, applyFill, applySpanGrow };
})();
