// ===================================================================================
// DRAW MODE (Hybrid Architecture: Interactive Grid + Bulk Insert + Paint Mode)
// ===================================================================================

window.drawModeEnabled = false;

// New State
window._drawGridState = {
    rows: 3,
    cols: 3,
    data: [], // 2D array of { text: string }
    activeRow: 0,
    activeCol: 0,
    autoAdvance: 'right', // 'right', 'down', 'none'
    paintMode: false
};

// ──────────────────────────────────────────────
// Enable / disable
// ──────────────────────────────────────────────

function enableDrawMode() {
    // Exit Node Editor if it's active before entering Draw Mode
    if (window.nodeEditorEnabled && typeof disableNodeEditor === 'function') {
        disableNodeEditor();
    }

    window.drawModeEnabled = true;
    $('#drawModeToggle').addClass('active').attr('title', 'Draw Mode: ON');
    $('#selectToolToggle').removeClass('active');

    // Pre-fill Monaco
    const $table = window.currentTable ? $(window.currentTable) : $('#tableContainer table').first();
    let prefill = '';
    if ($table.length) {
        const lines = [];
        $table.find('tr').each(function () {
            const rowCells = [];
            $(this).find('td, th').each(function () {
                rowCells.push($(this).text().trim());
            });
            if (rowCells.length) lines.push(rowCells.join('\t'));
        });
        prefill = lines.join('\n');
    }

    if (window.tifanyMonacoDraw) {
        window.tifanyMonacoDraw.setValue(prefill);
        setTimeout(function () { window.tifanyMonacoDraw.layout(); }, 50);

        // Attach Paint Mode listener
        if (!window._paintModeListenerAttached) {
            window.tifanyMonacoDraw.onDidChangeCursorSelection((e) => {
                if (window._drawGridState.paintMode && e.reason === monaco.editor.CursorChangeReason.Explicit) {
                    const text = _getDrawSelection();
                    if (text) {
                        // User drag-selected a range — use it directly
                        drawInsertItems([text]);
                        window.tifanyMonacoDraw.setPosition(e.selection.getEndPosition());
                    } else {
                        // No drag selection — fall back to the word under the cursor (click-to-paint)
                        const editor = window.tifanyMonacoDraw;
                        const model = editor.getModel();
                        const selection = editor.getSelection();
                        const word = model.getWordAtPosition(selection.getStartPosition());
                        if (word) {
                            drawInsertItems([word.word]);
                            editor.setPosition(selection.getEndPosition());
                        }
                    }
                }
            });
            window._paintModeListenerAttached = true;
        }
    } else {
        $('#drawInput').val(prefill).show();
        $('#monaco-draw-container').hide();
    }

    // Pre-populate from existing table, or start blank if none
    if ($table.length) { _populateGridFromTable($table); } else { _initEmptyGrid(); }

    $('.table-wrapper').hide();
    $('#sheetTabBar').hide();
    $('#drawCanvas').css('display', 'flex');
    document.body.classList.add('draw-mode-active');
    $.toast({ heading: 'Draw Mode', text: 'Hybrid Draw Mode activated.', icon: 'info', loader: false, stack: false });
}

function disableDrawMode() {
    window.drawModeEnabled = false;
    $('#drawModeToggle').removeClass('active').attr('title', 'Draw Mode: OFF');
    $('#selectToolToggle').addClass('active');

    $('#drawCanvas').hide();
    if (window.tifanyMonacoDraw) window.tifanyMonacoDraw.setValue('');
    else $('#drawInput').val('');

    $('.table-wrapper').show();
    $('#sheetTabBar').show();
    document.body.classList.remove('draw-mode-active');

    // reset paint mode
    window._drawGridState.paintMode = false;
    _updateToolbarUI();
}

function toggleDrawMode() {
    if (window.drawModeEnabled) disableDrawMode();
    else enableDrawMode();
}

// ──────────────────────────────────────────────
// Grid State Management
// ──────────────────────────────────────────────

function _initEmptyGrid(r, c) {
    const rows = r || parseInt($('#drawGridRows').val()) || 3;
    const cols = c || parseInt($('#drawGridCols').val()) || 3;
    window._drawGridState.rows = rows;
    window._drawGridState.cols = cols;
    window._drawGridState.data = [];
    window._drawGridState.activeRow = 0;
    window._drawGridState.activeCol = 0;

    for (let i = 0; i < rows; i++) {
        let rowData = [];
        for (let j = 0; j < cols; j++) {
            rowData.push({ text: '', isHeader: i === 0 });
        }
        window._drawGridState.data.push(rowData);
    }
    _renderGrid();
}

/**
 * Pre-populate _drawGridState from an existing HTML table.
 * Preserves th vs td per-cell so isHeader is accurate.
 */
function _populateGridFromTable($table) {
    const rows = [];
    $table.find('tr').each(function () {
        const rowCells = [];
        $(this).find('td, th').each(function () {
            rowCells.push({ text: $(this).text().trim(), isHeader: $(this).is('th') });
        });
        if (rowCells.length) rows.push(rowCells);
    });

    if (rows.length === 0) { _initEmptyGrid(); return; }

    const numRows = rows.length;
    const numCols = Math.max(...rows.map(r => r.length));

    window._drawGridState.rows = numRows;
    window._drawGridState.cols = numCols;
    window._drawGridState.activeRow = 0;
    window._drawGridState.activeCol = 0;
    window._drawGridState.data = rows.map(row => {
        while (row.length < numCols) row.push({ text: '', isHeader: false });
        return row;
    });

    $('#drawGridRows').val(numRows);
    $('#drawGridCols').val(numCols);
    _renderGrid();
}

function _resizeGrid() {
    const newRows = parseInt($('#drawGridRows').val()) || 3;
    const newCols = parseInt($('#drawGridCols').val()) || 3;

    // Copy existing data
    const newData = [];
    for (let r = 0; r < newRows; r++) {
        let rowData = [];
        for (let c = 0; c < newCols; c++) {
            if (r < window._drawGridState.rows && c < window._drawGridState.cols) {
                rowData.push(window._drawGridState.data[r][c]);
            } else {
                rowData.push({ text: '', isHeader: r === 0 });
            }
        }
        newData.push(rowData);
    }

    window._drawGridState.rows = newRows;
    window._drawGridState.cols = newCols;
    window._drawGridState.data = newData;

    // Adjust active cell if out of bounds
    if (window._drawGridState.activeRow >= newRows) window._drawGridState.activeRow = newRows - 1;
    if (window._drawGridState.activeCol >= newCols) window._drawGridState.activeCol = newCols - 1;

    _renderGrid();
}

// ──────────────────────────────────────────────
// Rendering
// ──────────────────────────────────────────────

function _renderGrid() {
    const $preview = $('#drawPreviewContent');
    let html = '<table class="draw-preview-grid"><tbody>';

    for (let r = 0; r < window._drawGridState.rows; r++) {
        html += '<tr>';
        for (let c = 0; c < window._drawGridState.cols; c++) {
            const cell = window._drawGridState.data[r][c];
            let cls = '';
            if (r === window._drawGridState.activeRow && c === window._drawGridState.activeCol) cls += ' active-cell';
            if (cell.isHeader) cls += ' header-cell';
            html += `<td class="${cls}" data-row="${r}" data-col="${c}" title="Dbl-click to edit — Row ${r + 1}, Col ${c + 1}">${cell.text || '<span class="draw-cell-empty">empty</span>'}</td>`;
        }
        html += '</tr>';
    }

    html += '</tbody></table>';
    $preview.html(html);

    // Single click → set active cell
    $preview.find('td').on('click', function () {
        window._drawGridState.activeRow = parseInt($(this).attr('data-row'));
        window._drawGridState.activeCol = parseInt($(this).attr('data-col'));
        _renderGrid();
    });

    // Double-click → inline edit
    $preview.find('td').on('dblclick', function (e) {
        e.stopPropagation();
        _startCellEdit($(this));
    });
}

/**
 * Inline cell editor: replaces a grid <td> with a text input.
 * Commits on Enter / blur. Tab advances to the next cell.
 * Escape cancels without saving.
 */
function _startCellEdit($td) {
    const row = parseInt($td.attr('data-row'));
    const col = parseInt($td.attr('data-col'));
    window._drawGridState.activeRow = row;
    window._drawGridState.activeCol = col;

    const cellData = window._drawGridState.data[row][col];
    const $input = $('<input type="text" class="draw-cell-input">').val(cellData.text || '');
    $td.empty().append($input);
    $input[0].focus();
    $input[0].select();

    function commit() {
        // Guard: input may already be detached (Tab path calls _renderGrid first)
        if (!$input.closest('#drawPreviewContent').length) return;
        window._drawGridState.data[row][col].text = $input.val();
        _renderGrid();
    }

    $input.on('blur', commit);

    $input.on('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            commit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            $input.off('blur');
            _renderGrid(); // discard changes
        } else if (e.key === 'Tab') {
            e.preventDefault();
            $input.off('blur'); // prevent double-save via blur
            window._drawGridState.data[row][col].text = $input.val();

            const totalCols = window._drawGridState.cols;
            const totalRows = window._drawGridState.rows;
            let nextRow = row;
            let nextCol = e.shiftKey ? col - 1 : col + 1;

            if (nextCol >= totalCols) { nextCol = 0; nextRow = Math.min(row + 1, totalRows - 1); }
            if (nextCol < 0)          { nextCol = totalCols - 1; nextRow = Math.max(row - 1, 0); }

            window._drawGridState.activeRow = nextRow;
            window._drawGridState.activeCol = nextCol;
            _renderGrid();

            setTimeout(() => {
                const $next = $('#drawPreviewContent').find(`td[data-row="${nextRow}"][data-col="${nextCol}"]`);
                if ($next.length) _startCellEdit($next);
            }, 0);
        }
    });
}

function _updateToolbarUI() {
    const btn = $('#drawPaintModeToggle');
    if (window._drawGridState.paintMode) {
        btn.removeClass('btn-outline-warning').addClass('btn-warning');
        btn.html('<i class="fas fa-paint-brush"></i> Paint: ON');
    } else {
        btn.removeClass('btn-warning').addClass('btn-outline-warning');
        btn.html('<i class="fas fa-paint-brush"></i> Paint: OFF');
    }
}

// ──────────────────────────────────────────────
// Interaction & Insertion Logic
// ──────────────────────────────────────────────

// Gets array of text based on cursors/selections
function _getSelectionsArray() {
    if (window.tifanyMonacoDraw) {
        const selections = window.tifanyMonacoDraw.getSelections();
        if (selections && selections.length > 0) {
            let texts = [];
            const model = window.tifanyMonacoDraw.getModel();

            // If it's a single massive selection spanning multiple lines, we split by newline
            if (selections.length === 1 && selections[0].startLineNumber !== selections[0].endLineNumber) {
                const raw = model.getValueInRange(selections[0]);
                texts = raw.split(/\r?\n/).filter(t => t.trim().length > 0);
            }
            // If it's multi-cursor / column select
            else {
                selections.forEach(sel => {
                    const text = model.getValueInRange(sel).trim();
                    if (text) texts.push(text);
                });
            }

            if (texts.length > 0) return texts;
        }
        return [];
    }

    // Fallback textarea logic
    const ta = document.getElementById('drawInput');
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (start !== end) {
        const raw = ta.value.substring(start, end);
        return raw.split(/\r?\n/).filter(t => t.trim().length > 0);
    }
    return [];
}

// Single insertion for paint mode
function _getDrawSelection() {
    if (window.tifanyMonacoDraw) {
        const selection = window.tifanyMonacoDraw.getSelection();
        if (selection && !selection.isEmpty()) {
            return window.tifanyMonacoDraw.getModel().getValueInRange(selection).trim();
        }
    }
    return '';
}

function drawInsertItems(items) {
    if (!items || items.length === 0) return;

    let r = window._drawGridState.activeRow;
    let c = window._drawGridState.activeCol;
    const autoAdv = $('#drawAutoAdvance').val() || window._drawGridState.autoAdvance;

    let insertedCount = 0;

    for (let i = 0; i < items.length; i++) {
        // Expand grid if needed
        if (r >= window._drawGridState.rows) {
            $('#drawGridRows').val(r + 1);
            _resizeGrid();
        }
        if (c >= window._drawGridState.cols) {
            $('#drawGridCols').val(c + 1);
            _resizeGrid();
        }

        window._drawGridState.data[r][c].text = items[i];
        insertedCount++;

        // Auto advance
        if (autoAdv === 'right') {
            c++;
            if (c >= window._drawGridState.cols) {
                c = 0;
                r++;
            }
        } else if (autoAdv === 'down') {
            r++;
        }
    }

    // Update active cell position
    if (autoAdv !== 'none') {
        window._drawGridState.activeRow = r;
        window._drawGridState.activeCol = c;
    }

    // Auto-expand grid visual if active cell pushed out of bounds
    if (r >= window._drawGridState.rows) { $('#drawGridRows').val(r + 1); _resizeGrid(); }
    if (c >= window._drawGridState.cols) { $('#drawGridCols').val(c + 1); _resizeGrid(); }

    _renderGrid();

    if (insertedCount > 1) {
        $.toast({ heading: 'Draw Mode', text: `Inserted ${insertedCount} items.`, icon: 'success', loader: false, stack: false });
    }
}

// Triggered by "Insert Selected" button
function drawHandleInsert() {
    const items = _getSelectionsArray();
    if (items.length === 0) {
        $.toast({ heading: 'Draw Mode', text: 'Select text first to insert', icon: 'warning', loader: false, stack: false });
        return;
    }
    drawInsertItems(items);
    if (window.tifanyMonacoDraw) window.tifanyMonacoDraw.focus();
}

function drawTogglePaintMode() {
    window._drawGridState.paintMode = !window._drawGridState.paintMode;
    if (window._drawGridState.paintMode) {
        $.toast({ heading: 'Paint Mode ON', text: 'Select phrases in the editor. They will instantly drop into the active cell.', icon: 'info', loader: false, stack: false });
    }
    _updateToolbarUI();
}

function drawClearAll() {
    _initEmptyGrid();
    $.toast({ heading: 'Draw Mode', text: 'Grid cleared.', icon: 'info', loader: false, stack: false });
}

/**
 * Build an HTML table from the grid state
 */
function drawBuildTable() {
    const rows = window._drawGridState.rows;
    const cols = window._drawGridState.cols;

    // Check if table is totally empty
    let hasData = false;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            if (window._drawGridState.data[r][c].text) hasData = true;
        }
    }

    if (!hasData) {
        $.toast({ heading: 'Draw Mode', text: 'Grid is completely empty.', icon: 'warning', loader: false, stack: false });
    }

    let tableHtml = '<table class="tablecoil crosshair-table">';

    for (let r = 0; r < rows; r++) {
        tableHtml += '<tr id="test">';
        for (let c = 0; c < cols; c++) {
            const cellData = window._drawGridState.data[r][c];
            const tag = cellData.isHeader ? 'th' : 'td';
            const rawText = cellData.text || '';
            const escaped = rawText
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            tableHtml += `<${tag}>${escaped}</${tag}>`;
        }
        tableHtml += '</tr>';
    }

    tableHtml += '</table>';

    const sheetName = 'Draw ' + (window._sheetCounter + 1);
    if (typeof addSheet === 'function') {
        addSheet(sheetName, tableHtml);
    }

    disableDrawMode();
    $.toast({ heading: 'Draw Mode', text: 'Table built successfully!', icon: 'success', loader: false, stack: false });
}

// ──────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────
function initDrawCanvas() {
    $('#exitDrawMode').on('click', disableDrawMode);
    $('#drawClearAll').on('click', drawClearAll);
    $('#drawApplySize').on('click', _resizeGrid);
    // Remove the 'change' event from input fields for instant resize to prevent annoying UI jumps while typing. Only trigger on button
    // $('#drawGridRows, #drawGridCols').on('change', _resizeGrid); 
    $('#drawInsertSelected').on('click', drawHandleInsert);
    $('#drawPaintModeToggle').on('click', drawTogglePaintMode);
    $('#drawBuildTable').on('click', drawBuildTable);

    // Auto advance change
    $('#drawAutoAdvance').on('change', function () {
        window._drawGridState.autoAdvance = $(this).val();
        $('#drawAutoAdvance').val($(this).val()); // Just to ensure synced
    });

    // ── Vertical resize handle between Monaco and grid preview ─────────────
    (function () {
        const handle  = document.getElementById('drawResizeHandle');
        const monaco  = document.getElementById('monaco-draw-container');
        const body    = document.getElementById('draw-canvas-body');
        if (!handle || !monaco) return;

        let dragging = false;
        let startY   = 0;
        let startH   = 0;

        function beginDrag(y) {
            dragging = true;
            startY   = y;
            startH   = monaco.getBoundingClientRect().height;
            handle.classList.add('dragging');
            document.body.style.cursor     = 'ns-resize';
            document.body.style.userSelect = 'none';
        }

        function moveDrag(y) {
            if (!dragging) return;
            const delta  = y - startY;
            const parent = monaco.parentElement.getBoundingClientRect().height;
            // Clamp: min 60px, max 70% of the draw-canvas-body height
            const newH   = Math.max(60, Math.min(startH + delta, parent * 0.70));
            monaco.style.flex   = 'none';
            monaco.style.height = newH + 'px';
            if (window.tifanyMonacoDraw) window.tifanyMonacoDraw.layout();
        }

        function endDrag() {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            document.body.style.cursor     = '';
            document.body.style.userSelect = '';
            if (window.tifanyMonacoDraw) window.tifanyMonacoDraw.layout();
        }

        // Pointer events cover mouse + touch + stylus (touchstart/touchend
        // removed — they double-fired alongside pointerdown/up on touch).
        handle.addEventListener('pointerdown', function (e) {
            if (e.button !== 0 || e.isPrimary === false) return;
            beginDrag(e.clientY);
            e.preventDefault();
        });
        document.addEventListener('pointermove', function (e) { if (e.isPrimary === false) return; moveDrag(e.clientY); });
        document.addEventListener('pointerup',   endDrag);
        document.addEventListener('pointercancel', endDrag);
    })();
}
