// ===================================================================================
// 3. Table Transpose
// ===================================================================================
function transposeTable() {
    if (!currentTable) return;

    $.toast({
        heading: 'Information',
        text: 'Table must have equal rows and columns to transpose',
        icon: 'info',
        loader: true,        // Change it to false to disable loader
        loaderBg: '#9EC600',  // To change the background
        stack: false,
    })

    const $originalTable = $(currentTable);
    const originalClasses = $originalTable.attr('class');
    const originalId = $originalTable.attr('id');

    $originalTable.off('mouseenter mouseleave');

    const mapper = new VisualGridMapper($originalTable);
    const grid = mapper.grid;
    const transposedGrid = [];

    for (let c = 0; c < mapper.maxCols; c++) {
        transposedGrid[c] = [];
        for (let r = 0; r < mapper.maxRows; r++) {
            transposedGrid[c][r] = (grid[r] && grid[r][c]) ? grid[r][c] : null;
        }
    }

    const $transposedTable = $('<table>')
        .addClass($originalTable.attr('class'))
        .attr('id', $originalTable.attr('id'));

    const visited = new Set();

    transposedGrid.forEach((row, rowIndex) => {
        const $tr = $('<tr id="test">');

        row.forEach((gridCell, colIndex) => {
            const key = `${rowIndex},${colIndex}`;
            if (visited.has(key)) return;

            if (!gridCell || !gridCell.element || !gridCell.isOrigin) {
                if (!visited.has(key)) {
                    $tr.append('<td> </td>');
                }
                return;
            }

            const $originalCell = $(gridCell.element);
            const cellInfo = mapper.getVisualPosition(gridCell.element);
            const newRowspan = cellInfo.colspan;
            const newColspan = cellInfo.rowspan;

            const $newCell = $(cellInfo.isHeader ? '<th>' : '<td>')
                .addClass($originalCell.attr('class'))
                .attr('id', $originalCell.attr('id'));

            $newCell.html(cellInfo.content);

            if (newRowspan > 1) $newCell.attr('rowspan', newRowspan);
            if (newColspan > 1) $newCell.attr('colspan', newColspan);

            $tr.append($newCell);

            for (let r = 0; r < newRowspan; r++) {
                for (let c = 0; c < newColspan; c++) {
                    visited.add(`${rowIndex + r},${colIndex + c}`);
                }
            }
        });

        const originalRow = $(row[0].element).closest('tr');
        $tr.addClass(originalRow.attr('class'))
            .attr('id', originalRow.attr('id'));

        $transposedTable.append($tr);
    });

    $originalTable.replaceWith($transposedTable);
    currentTable = $transposedTable[0];

    // initializeAllFeatures();
    setupTableInteraction();
    window.saveCurrentState();
}

function toggleCrosshair() {
    crosshairEnabled = !crosshairEnabled;
    const $table = $(currentTable);

    if (crosshairEnabled) {
        $table.addClass('crosshair-table');
        initCrosshair();
    } else {
        $table.removeClass('crosshair-table');
        $table.find('.highlight-row, .highlight-col').removeClass('highlight-row highlight-col');
    }
}

function initCrosshair() {
    $('.crosshair-table').each(function () {
        const $table = $(this);
        if ($table.data('crosshair-initialized')) return;
        $table.data('crosshair-initialized', true);

        const mapper = new VisualGridMapper($table);

        $table.on('mouseenter', 'td, th', function () {
            if (!crosshairEnabled) return;

            const hoveredCell = this;
            const position = mapper.cellMap.get(hoveredCell);
            if (!position) return;

            $table.find('.highlight-row, .highlight-col').removeClass('highlight-row highlight-col');

            const rowCells = new Set(), colCells = new Set();

            for (let r = 0; r < position.rowspan; r++) {
                mapper.getCellsInRow(position.startRow + r).forEach(cell => rowCells.add(cell));
            }

            for (let c = 0; c < position.colspan; c++) {
                mapper.getCellsInColumn(position.startCol + c).forEach(cell => colCells.add(cell));
            }

            $(Array.from(rowCells)).addClass('highlight-row');
            $(Array.from(colCells)).addClass('highlight-col');
        });

        $table.on('mouseleave', function () {
            $table.find('.highlight-row, .highlight-col').removeClass('highlight-row highlight-col');
        });
    });
}

/**
 * Apply Style — put the current table into the sheet card look.
 *
 * This used to write a fixed appearance into style attributes: width 100%,
 * 10px padding, centred text, lightgrey borders, #f2f2f2 headers. Inline
 * styles win over every stylesheet, so a table that had been "styled" once
 * could never follow the theme again — it stayed light-grey-on-white in dark
 * mode, and it ignored the density the editor's own grid uses.
 *
 * So Apply Style now applies CLASSES and clears the inline styles the old one
 * left behind. The look lives in tableEditor.css (.tablecoil inside
 * .tafne-ruler-wrap) and follows the theme like everything else.
 */
function applyStyle() {
    if (!currentTable) return;

    if (typeof window.saveCurrentState === 'function') window.saveCurrentState();

    const $table = $(currentTable);

    $table.addClass('tablecoil');
    if (!$table.hasClass('crosshair-table')) $table.addClass('crosshair-table');

    // Undo the previous version's handiwork. Passing '' removes the declaration
    // rather than setting it to an empty value, so the stylesheet takes over.
    $table.css({
        width: '',
        'border-collapse': '',
        'border-spacing': '',
        border: '',
        'table-layout': '',
    });
    $table.find('td, th').css({
        padding: '',
        'text-align': '',
        border: '',
        'background-color': '',
        'font-weight': '',
    });

    // ── Card structure ───────────────────────────────────────────────────────
    // A styled table is a card: title bar (.accordion) + body (.panel) with a
    // tab strip along the top edge. A table parsed straight into the container
    // has none of that, so build it; one already in a card keeps its own.
    const $host  = $table.closest('.tafne-ruler-wrap').length
        ? $table.closest('.tafne-ruler-wrap')
        : $table;
    let   $panel = $table.closest('.panel');

    if (!$panel.length) {
        const n = $('#tableContainer button.accordion').length + 1;
        $host.wrap('<div class="panel"></div>');
        $panel = $table.closest('.panel');
        $panel.before('<button class="accordion active"><b>Table ' + n + '</b></button>');
        $panel.show();
    }

    // The tab strip is the card's top edge even with no tabs in it yet — an
    // empty strip is the folder lip the active tab later sits on.
    if (!$panel.children('.sp-selector').length) {
        $panel.prepend('<div class="sp-selector"></div>');
    }

    setupTableInteraction();

    if (typeof window.renderTableRulers === 'function') {
        requestAnimationFrame(() => window.renderTableRulers(currentTable));
    }
}

// ===========================TEXT SPLIT FUNCTIONS AND TABLE EDITS===============================

$('.textSplit').on('click', function () {
    if (selectedCells.length === 0) {
        alert('Please select exactly one cell to split.');
        return;
    }
    $('#textSplitModal').modal('show');
});

function applyTextSplit() {
    // SAVE STATE BEFORE OPERATION
    window.saveCurrentState();

    const colDelimiter = $('#colDelimiter').val();
    const rowDelimiter = $('#rowDelimiter').val();
    const splitDirection = $('#splitDirection').val();

    const cell = selectedCells[0];
    const text = $(cell).text();

    let tableData = [];

    // --- Helper function for splitting ---
    const splitText = (str, delimiter) => {
        if (delimiter === ' ') {
            // Special handling for single space: split by one or more whitespace characters
            return str.trim().split(/\s+/);
        }
        if (delimiter === '') {
            // If the delimiter is an empty string, do not split.
            // This prevents splitting every character.
            return [str];
        }
        // Standard split for other delimiters
        return str.split(delimiter);
    };

    // --- Process each selected cell ---
    selectedCells.forEach((cell, cellIndex) => {
        const $cell = $(cell);
        const text = $cell.text();
        let tableData = [];

        // Split the text based on direction
        if (splitDirection === 'rows') {
            const rows = splitText(text, rowDelimiter).filter(row => row.trim() !== '');
            tableData = rows.map(row => [row.trim()]);
        } else if (splitDirection === 'columns') {
            const columns = splitText(text, colDelimiter).filter(col => col.trim() !== '');
            tableData = [columns];
        } else {
            const rows = splitText(text, rowDelimiter).filter(row => row.trim() !== '');
            tableData = rows.map(row =>
                splitText(row, colDelimiter).map(cell => cell.trim()).filter(cell => cell !== '')
            );
        }

        // --- Build the table HTML for this cell ---
        if (tableData.length > 0 && tableData[0].length > 0) {
            const $row = $cell.closest('tr');
            const cellIndex = $cell.index();
            let $lastRow = $row;

            // Process each row from the split data
            tableData.forEach((rowData, rowIndex) => {
                if (rowIndex === 0) {
                    // First row: replace content in existing row
                    const newCellsHtml = rowData.map(cellText => `<td>${cellText}</td>`).join('');
                    $cell.before(newCellsHtml);
                } else {
                    // Subsequent rows: create new rows
                    let newRowHtml = '<tr>' + '<td></td>'.repeat(cellIndex);
                    newRowHtml += rowData.map(cellText => `<td>${cellText}</td>`).join('');
                    newRowHtml += '</tr>';

                    $lastRow.after(newRowHtml);
                    $lastRow = $lastRow.next();
                }
            });

            // Remove the original cell
            $cell.remove();
        } else {
            // Keep original text if no split occurred
            $cell.text(text);
        }
    });


    // Close the modal
    $('#textSplitModal').modal('hide');

    // Reinitialize features for the new table
    // initializeAllFeatures();
    setupTableInteraction();
    window.saveCurrentState();
};

window.transposeTable = transposeTable;

// ===================================================================================
// 3b. Partial Transpose — transpose only the selected cell block (row / column / range)
//     The selection's bounding box is pivoted around its top-left cell, Excel
//     paste-transpose style. The table grows with blank rows/columns if the
//     transposed block extends past the current edge.
// ===================================================================================
function transposeSelection() {
    const table = window.currentTable;
    const cells = window.selectedCells || [];

    if (!table || cells.length === 0) {
        $.toast({ heading: 'Transpose Selection', text: 'Select the cells, row, or column to transpose first.', icon: 'info', loader: false, stack: false });
        return;
    }

    let mapper = new VisualGridMapper(table);

    // Bounding box of the selection; merged cells are not supported
    let r0 = Infinity, c0 = Infinity, r1 = -1, c1 = -1, hasMerged = false;
    cells.forEach(cell => {
        const p = mapper.getVisualPosition(cell);
        if (!p) return;
        if (p.rowspan > 1 || p.colspan > 1) hasMerged = true;
        r0 = Math.min(r0, p.startRow); c0 = Math.min(c0, p.startCol);
        r1 = Math.max(r1, p.startRow + p.rowspan - 1); c1 = Math.max(c1, p.startCol + p.colspan - 1);
    });

    if (r1 < 0) return;
    if (hasMerged) {
        $.toast({ heading: 'Transpose Selection', text: 'Selection contains merged cells — unmerge them first.', icon: 'warning', loader: false, stack: false });
        return;
    }

    const nR = r1 - r0 + 1, nC = c1 - c0 + 1;
    if (nR === 1 && nC === 1) {
        $.toast({ heading: 'Transpose Selection', text: 'A single cell has nothing to transpose.', icon: 'info', loader: false, stack: false });
        return;
    }

    // Read the block's values before any mutation
    const block = [];
    for (let r = 0; r < nR; r++) {
        block[r] = [];
        for (let c = 0; c < nC; c++) {
            const gc = mapper.grid[r0 + r] && mapper.grid[r0 + r][c0 + c];
            block[r][c] = gc && gc.element ? $(gc.element).html() : '';
        }
    }

    // Target region: rows r0..r0+nC-1, cols c0..c0+nR-1
    const needRows = r0 + nC;
    const needCols = c0 + nR;

    if (typeof window.saveCurrentState === 'function') window.saveCurrentState();
    if (table._tafneStructObs) table._tafneStructObs.disconnect();

    // Grow the table if the transposed block extends past the current edge
    const $rows = $(table).find('tr').not('.tifany-drag-row').not('.drop-indicator-row');
    const curCols = mapper.maxCols;
    for (let r = $rows.length; r < needRows; r++) {
        let tr = '<tr>';
        for (let c = 0; c < Math.max(curCols, needCols); c++) tr += '<td></td>';
        tr += '</tr>';
        $(table).find('tr').not('.tifany-drag-row').not('.drop-indicator-row').last().after(tr);
    }
    if (needCols > curCols) {
        $(table).find('tr').not('.tifany-drag-row').not('.drop-indicator-row').each(function () {
            while (this.cells.length < needCols) $(this).append('<td></td>');
        });
    }

    // Re-map after structural changes, verify the target region is unmerged
    mapper = new VisualGridMapper(table);
    for (let r = 0; r < nC; r++) {
        for (let c = 0; c < nR; c++) {
            const gc = mapper.grid[r0 + r] && mapper.grid[r0 + r][c0 + c];
            if (gc && gc.element && !gc.isOrigin) {
                $.toast({ heading: 'Transpose Selection', text: 'Target area overlaps a merged cell — cannot transpose here.', icon: 'warning', loader: false, stack: false });
                if (typeof renderTableRulers === 'function') renderTableRulers(table);
                return;
            }
        }
    }

    const _setCell = (R, C, html) => {
        const gc = mapper.grid[R] && mapper.grid[R][C];
        if (gc && gc.element) $(gc.element).html(html);
    };

    // Clear the original block, then write the pivoted values
    for (let r = 0; r < nR; r++) for (let c = 0; c < nC; c++) _setCell(r0 + r, c0 + c, '');
    for (let r = 0; r < nR; r++) for (let c = 0; c < nC; c++) _setCell(r0 + c, c0 + r, block[r][c]);

    if (typeof renderTableRulers === 'function') renderTableRulers(table);
    $.toast({ heading: 'Transpose Selection', text: `Transposed ${nR}×${nC} block.`, icon: 'success', loader: false, stack: false, hideAfter: 1800 });
}

window.transposeSelection = transposeSelection;
window.applyTextSplit = applyTextSplit;