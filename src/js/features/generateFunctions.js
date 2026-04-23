function generateTabs(tableHtml) {
    let buttonIndex = parseInt($('#buttonIndex').val());
    if (isNaN(buttonIndex) || buttonIndex < 1) { buttonIndex = 1; $('#buttonIndex').val(1); }
    if (buttonIndex > 100) { buttonIndex = 100; $('#buttonIndex').val(100); }

    window.saveCurrentState();

    // Parse input and find every <table> — each gets its own card
    const $parsed = $('<div>').html(tableHtml);
    const $tables = $parsed.find('table');

    if ($tables.length === 0) {
        $('#tableContainer').html(tableHtml);
        setupTableInteraction();
        return;
    }

    let blocksHtml = '';

    $tables.each(function (i) {
        $(this).attr('data-tifany-id', `t-${i}`);

        let spHtml = '<div class="sp-selector">\n';
        for (let j = 1; j <= buttonIndex; j++) {
            spHtml += `  <button class="sp-option" data-value="${j}" data-panel="${i}">${j}</button>\n`;
        }
        spHtml += '</div><br>';

        const tableOuterHtml = $('<div>').append($(this).clone()).html();

        blocksHtml +=
            `<button class="accordion active"><b>Table ${i + 1}</b></button>` +
            `<div class="panel">${spHtml}${tableOuterHtml}</div>`;
    });

    $('#tableContainer').html(blocksHtml);

    setupTableInteraction();
    console.log(`Generated ${buttonIndex} tab(s) across ${$tables.length} table(s)`);
    $.toast({ heading: 'Done', text: `Generated ${buttonIndex} tabs`, icon: 'success', loader: false, stack: false });
}

function generateCode() {
    const format = $('#exportFormat').val() || 'html';
    console.group('Generate Code Process; format:', format);

    try {
        const $tables = $('#tableContainer table');
        if ($tables.length === 0) {
            alert('No table to generate from. Please parse a table first.');
            return;
        }

        let output = '';

        if (format === 'html') {
            output = exportAsHtml();
        } else if (format === 'json') {
            output = exportAsJson($tables);
        } else if (format === 'markdown') {
            output = exportAsMarkdown($tables);
        } else if (format === 'csv') {
            const csvContent = exportAsCsv(window.currentTable || $tables[0]);
            // Download the CSV file
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'table.csv';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            output = csvContent; // Also show in editor
        } else if (format === 'sql') {
            output = exportAsSql($tables);
        } else if (format === 'ascii') {
            output = exportAsAscii($tables);
        }

        if (window.tifanyMonaco) {
            window.tifanyMonaco.setValue(output);
        } else {
            $('#tableOutput').val(output);
        }

        setupTableInteraction();
        console.log('Generation successful, length:', output.length);
    } catch (error) {
        console.error('Error in code generation:', error);
        alert('Failed to generate. Check console for details.');
    } finally {
        console.groupEnd();
    }
}

function exportAsHtml() {
    const $clone = $('#tableContainer').clone();

    if (crosshairEnabled) {
        $clone.find('table').addClass('crosshair-table');
    } else {
        $clone.find('.highlight-row, .highlight-col').removeClass('highlight-row highlight-col');
    }

    $clone.find('tr').attr('id', 'test');
    $clone.removeAttr('style');
    $clone.find('td, th, tr').removeClass('selected-cell');
    $clone.find('.text-center.p-5:has(p:contains("Table View"))').remove();
    // $clone.find('td').removeAttr('style');

    return formatHtml($('<div>').append($clone).html());
}

// Helper: get headers and rows from a table DOM element
function getTableData(tableEl) {
    const $table = $(tableEl);
    const headers = [];
    const rows = [];

    $table.find('tr').each(function (rowIdx) {
        const cells = [];
        $(this).find('th, td').each(function () {
            cells.push($(this).text().trim());
        });
        if (rowIdx === 0 && $(this).find('th').length > 0) {
            headers.push(...cells);
        } else {
            if (cells.length > 0) rows.push(cells);
        }
    });

    // If no <th> headers were found, treat first row as headers
    if (headers.length === 0 && rows.length > 0) {
        headers.push(...rows.shift());
    }

    return { headers, rows };
}

function exportAsJson($tables) {
    const result = {};
    const tableCount = $tables.length;

    $tables.each(function (i) {
        const { headers, rows } = getTableData(this);
        const key = tableCount === 1 ? 'table' : `table_${i + 1}`;
        result[key] = rows.map(row => {
            const obj = {};
            headers.forEach((h, idx) => {
                obj[h || `col_${idx + 1}`] = row[idx] !== undefined ? row[idx] : '';
            });
            return obj;
        });
    });

    return JSON.stringify(tableCount === 1 ? result['table'] : result, null, 2);
}

function exportAsCsv(tableEl) {
    const { headers, rows } = getTableData(tableEl);
    const escapeCell = val => {
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    };

    const lines = [];
    if (headers.length > 0) lines.push(headers.map(escapeCell).join(','));
    rows.forEach(row => lines.push(row.map(escapeCell).join(',')));
    return lines.join('\r\n');
}

function exportAsMarkdown($tables) {
    const parts = [];

    $tables.each(function () {
        const { headers, rows } = getTableData(this);
        if (headers.length === 0) return;

        const lines = [];
        lines.push('| ' + headers.join(' | ') + ' |');
        lines.push('| ' + headers.map(() => '---').join(' | ') + ' |');
        rows.forEach(row => {
            const padded = headers.map((_, i) => row[i] !== undefined ? row[i] : '');
            lines.push('| ' + padded.join(' | ') + ' |');
        });
        parts.push(lines.join('\n'));
    });

    return parts.join('\n\n');
}

function exportAsSql($tables) {
    const parts = [];

    $tables.each(function (i) {
        const { headers, rows } = getTableData(this);
        const tableName = `table_${i + 1}`;
        const cols = headers.length > 0
            ? headers.map((h, idx) => h ? h.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '') || `col_${idx + 1}` : `col_${idx + 1}`)
            : (rows[0] || []).map((_, idx) => `col_${idx + 1}`);

        const colDefs = cols.map(c => `  ${c} TEXT`).join(',\n');
        let sql = `CREATE TABLE ${tableName} (\n${colDefs}\n);\n`;

        rows.forEach(row => {
            const values = cols.map((_, idx) => {
                const v = row[idx] !== undefined ? row[idx] : '';
                return `'${v.replace(/'/g, "''")}'`;
            });
            sql += `INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${values.join(', ')});\n`;
        });

        parts.push(sql);
    });

    return parts.join('\n');
}

/**
 * Export table(s) as an ASCII box-drawing table.
 * Example:
 *   +------+-------+
 *   | Name | Score |
 *   +======+=======+
 *   | Bob  |    42 |
 *   +------+-------+
 */
function exportAsAscii($tables) {
    const parts = [];

    $tables.each(function () {
        const { headers, rows } = getTableData(this);
        const allRows = headers.length > 0 ? [headers, ...rows] : rows;
        if (allRows.length === 0) return;

        // Compute column widths
        const cols = allRows[0].length;
        const widths = Array.from({ length: cols }, (_, c) =>
            Math.max(...allRows.map(row => String(row[c] !== undefined ? row[c] : '').length))
        );

        const sep  = (ch) => '+' + widths.map(w => ch.repeat(w + 2)).join('+') + '+';
        const row  = (cells) => '| ' + cells.map((c, i) => String(c !== undefined ? c : '').padEnd(widths[i])).join(' | ') + ' |';

        const lines = [];
        lines.push(sep('-'));
        if (headers.length > 0) {
            lines.push(row(headers));
            lines.push(sep('='));
            rows.forEach(r => lines.push(row(r)));
        } else {
            allRows.forEach(r => lines.push(row(r)));
        }
        lines.push(sep('-'));
        parts.push(lines.join('\n'));
    });

    return parts.join('\n\n');
}

function copyInput() {
        const formatBoard = window.tifanyMonaco
            ? window.tifanyMonaco.getValue()
            : $('#tableOutput').val();
        if (!formatBoard || formatBoard.trim() === '') {
            // More descriptive error message
            $.toast({ heading: 'Info', text: 'The text area is empty. Please add content before copying.', icon: 'warning', loader: false, stack: false });
            return;
        }
        if (navigator.clipboard) {
            navigator.clipboard.writeText(formatBoard)
                .then(() => {
                    $.toast({ heading: 'Copied', text: 'HTML copied to clipboard!', icon: 'success', loader: false, stack: false });
                })
        } else {
            $.toast({ heading: 'Error', text: 'Failed to copy', icon: 'error', loader: false, stack: false })
        }
    }