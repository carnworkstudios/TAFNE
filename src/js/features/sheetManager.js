// ===================================================================================
// SHEET MANAGER; Excel-style sheet tabs for multi-table support
// ===================================================================================

window.sheets = [];
window.activeSheetId = null;
window._sheetCounter = 0;

/**
 * Add a new sheet with the given name and raw table HTML.
 * Automatically switches to the new sheet.
 */
function addSheet(name, rawHtml) {
    // Save current sheet's container state before switching
    if (window.activeSheetId !== null) {
        _saveActiveSheetState();
    }

    const id = 'sheet-' + (++window._sheetCounter);
    const sheetName = name || ('Sheet ' + window._sheetCounter);

    window.sheets.push({
        id: id,
        name: sheetName,
        rawHtml: rawHtml,
        containerHtml: null   // populated when switching away from this sheet
    });

    // Store raw html for decoupled tab count
    window.lastParsedHtml = rawHtml;

    renderSheetTabs();
    _activateSheet(id);
}

/**
 * Add a blank sheet manually.
 */
function addBlankSheet() {
    const blankTable = '<table class="tablecoil crosshair-table"><tr><th>Header 1</th><th>Header 2</th></tr><tr><td>Cell 1</td><td>Cell 2</td></tr></table>';
    addSheet('Sheet ' + (window._sheetCounter + 1), blankTable);
}

function loadNetlistAsSheets(netlist) {
    if (!netlist || !Array.isArray(netlist.components)) {
        $.toast({ heading: 'TAFNE', text: 'Invalid netlist format', icon: 'error', loader: false, stack: false });
        return;
    }
    const compRows = netlist.components.map(c => ({
        id: c.id || '', refdes: c.refdes || '', value: c.value || '',
        symbolType: c.symbolType || '', domain: c.domain || '',
        x: c.x != null ? String(c.x) : '', y: c.y != null ? String(c.y) : '',
    }));
    const connRows = (netlist.connections || []).map(e => ({
        id: e.id || '', from: e.from || '', to: e.to || '',
        color: e.color || '', length: e.length != null ? String(e.length) : '',
        signalType: e.signalType || '',
    }));
    if (compRows.length) addSheet('Components', parseJsonInput(JSON.stringify(compRows)));
    if (connRows.length) addSheet('Connections', parseJsonInput(JSON.stringify(connRows)));
    $.toast({
        heading: 'Schema Loaded',
        text: `${compRows.length} components, ${connRows.length} connections`,
        icon: 'success', loader: false, stack: false,
    });
}
window.loadNetlistAsSheets = loadNetlistAsSheets;

/**
 * Build sheets from a ginexys-diagram-v2 (or v1) payload received over CwsBridge.
 * v2 sheets: Components, Wires, Connections, Connectors, BOM, Hierarchy.
 * v1 falls back gracefully (no BOM/Hierarchy, no layer/path columns).
 */
function loadDiagramAsSheets(diagram) {
    var v2 = diagram?.schema === 'ginexys-diagram-v2';
    var v1 = diagram?.schema === 'ginexys-diagram-v1';
    if (!v2 && !v1) {
        $.toast({ heading: 'TAFNE', text: 'Invalid diagram format', icon: 'error', loader: false, stack: false });
        return;
    }
    var t = diagram.topology || {};

    // ── Components ─────────────────────────────────────────────
    // v2: adds layer column. Grouped elements arrive with type:"module".
    var comps = t.components || [];
    if (comps.length) {
        var compRows = comps.map(function(c) {
            var row = {
                id:     c.id                         || '',
                type:   c.type                       || '',
                symbol: c.symbol || c.symbolType || c.type || '',
                refdes: c.refdes                     || '',
                value:  c.value                      || '',
                domain: c.domain                     || '',
                x:      c.x      != null ? String(c.x) : '',
                y:      c.y      != null ? String(c.y) : '',
                bbox_w: c.bbox?.width  != null ? String(c.bbox.width)  : '',
                bbox_h: c.bbox?.height != null ? String(c.bbox.height) : '',
            };
            if (v2) row.layer = c.layer || '';
            return row;
        });
        addSheet('Components', parseJsonInput(JSON.stringify(compRows)));
    }

    // ── Wires ───────────────────────────────────────────────────
    // v2: adds path and layer columns.
    var wires = t.wires || [];
    if (wires.length) {
        var wireRows = wires.map(function(w) {
            var ep0 = w.endpoints?.[0];
            var ep1 = w.endpoints?.[1];
            var row = {
                id:        w.id        || '',
                color:     w.color     || '',
                width:     w.width  != null ? String(w.width) : '',
                length:    w.length != null ? String(Math.round(w.length)) : '',
                linearity: w.linearity != null ? String(w.linearity.toFixed(3)) : '',
                from_x:    ep0?.x != null ? String(ep0.x.toFixed(1)) : '',
                from_y:    ep0?.y != null ? String(ep0.y.toFixed(1)) : '',
                to_x:      ep1?.x != null ? String(ep1.x.toFixed(1)) : '',
                to_y:      ep1?.y != null ? String(ep1.y.toFixed(1)) : '',
            };
            if (v2) { row.path = w.path || ''; row.layer = w.layer || ''; }
            return row;
        });
        addSheet('Wires', parseJsonInput(JSON.stringify(wireRows)));
    }

    // ── Connections ────────────────────────────────────────────
    // v2: top-level topology.connections[]. v1: graph.edges fallback.
    var connEdges = v2 ? (t.connections || []) : (t.graph?.edges || []);
    if (connEdges.length) {
        var connRows = connEdges.map(function(e) {
            return {
                id:         e.id         || '',
                from:       e.from       || '',
                to:         e.to         || '',
                color:      e.color      || '',
                length:     e.length != null ? String(Math.round(e.length)) : '',
                signalType: e.signalType || '',
            };
        });
        addSheet('Connections', parseJsonInput(JSON.stringify(connRows)));
    }

    // ── Connectors ─────────────────────────────────────────────
    var connectors = t.connectors || [];
    if (connectors.length) {
        var pinRows = connectors.map(function(c) {
            return {
                id:     c.id || '',
                bbox_x: c.bbox?.x != null ? String(c.bbox.x.toFixed(1)) : '',
                bbox_y: c.bbox?.y != null ? String(c.bbox.y.toFixed(1)) : '',
            };
        });
        addSheet('Connectors', parseJsonInput(JSON.stringify(pinRows)));
    }

    // ── BOM (v2 only) ──────────────────────────────────────────
    // Aggregate component counts by symbol type.
    if (v2 && comps.length) {
        var bomMap = {};
        comps.forEach(function(c) {
            var key = c.symbol || c.type || 'unknown';
            bomMap[key] = (bomMap[key] || 0) + 1;
        });
        var bomRows = Object.keys(bomMap).sort().map(function(sym) {
            return { symbol: sym, count: String(bomMap[sym]) };
        });
        if (bomRows.length) addSheet('BOM', parseJsonInput(JSON.stringify(bomRows)));
    }

    // ── Hierarchy (v2 only) ────────────────────────────────────
    // User-defined layer groups from Structure view.
    if (v2) {
        var groups = diagram.structure?.groups || [];
        if (groups.length) {
            var hierRows = groups.map(function(g) {
                return {
                    id:       g.id   || '',
                    name:     g.name || '',
                    type:     'module',
                    children: (g.children || []).join(', '),
                };
            });
            addSheet('Hierarchy', parseJsonInput(JSON.stringify(hierRows)));
        }
    }

    var sheetCount = comps.length + wires.length + connEdges.length;
    $.toast({
        heading: 'Diagram Loaded',
        text: (v2 ? '[v2] ' : '[v1] ') +
              comps.length + ' components · ' +
              wires.length + ' wires · ' +
              connEdges.length + ' connections',
        icon: 'success', loader: false, stack: false,
    });
}
window.loadDiagramAsSheets = loadDiagramAsSheets;

/**
 * Switch to a different sheet by id.
 */
function switchSheet(id) {
    if (id === window.activeSheetId) return;

    // Save current sheet state
    _saveActiveSheetState();

    window.lastParsedHtml = null; // reset before activating
    _activateSheet(id);
}

/**
 * Rename a sheet (called on dblclick).
 */
function renameSheet(id, newName) {
    const sheet = window.sheets.find(s => s.id === id);
    if (!sheet || !newName.trim()) return;
    sheet.name = newName.trim();
    renderSheetTabs();
}

/**
 * Delete a sheet. Switches to adjacent sheet if active.
 */
function deleteSheet(id) {
    if (window.sheets.length <= 1) {
        $.toast({ heading: 'Sheet', text: 'Cannot delete the only sheet', icon: 'warning', loader: false, stack: false });
        return;
    }

    const idx = window.sheets.findIndex(s => s.id === id);
    if (idx === -1) return;

    const wasActive = (id === window.activeSheetId);
    window.sheets.splice(idx, 1);

    if (typeof window.clearSheetHistory === 'function') window.clearSheetHistory(id);

    if (wasActive) {
        // Switch to adjacent sheet
        const nextSheet = window.sheets[Math.min(idx, window.sheets.length - 1)];
        window.activeSheetId = null;
        window.lastParsedHtml = null;
        renderSheetTabs();
        _activateSheet(nextSheet.id);
    } else {
        renderSheetTabs();
    }
}

// ──────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────

function _saveActiveSheetState() {
    if (window.activeSheetId === null) return;
    const sheet = window.sheets.find(s => s.id === window.activeSheetId);
    if (sheet) {
        sheet.containerHtml = $('#tableContainer').html();
    }
}

function _activateSheet(id) {
    const sheet = window.sheets.find(s => s.id === id);
    if (!sheet) return;

    window.activeSheetId = id;
    window.lastParsedHtml = sheet.rawHtml;

    if (sheet.containerHtml) {
        // Restore previously saved container state
        $('#tableContainer').html(sheet.containerHtml);
        window.currentTable = $('#tableContainer table')[0] || null;
        initializeAllFeatures();
        setupTableInteraction();
    } else {
        // First time loading this sheet; render via generateTabs
        generateTabs(sheet.rawHtml);
        window.currentTable = $('#tableContainer table')[0] || null;
        initializeAllFeatures();
        setupTableInteraction();
        window.saveCurrentState();
    }

    renderSheetTabs();
    if (typeof window.syncHistoryButtons === 'function') window.syncHistoryButtons();
}

/**
 * Re-render the sheet tab bar DOM.
 */
function renderSheetTabs() {
    let $bar = $('#sheetTabBar');
    if (!$bar.length) return;

    $bar.empty();

    window.sheets.forEach(function (sheet) {
        const isActive = sheet.id === window.activeSheetId;
        const $tab = $('<div>')
            .addClass('sheet-tab' + (isActive ? ' active' : ''))
            .attr('data-sheet-id', sheet.id);

        const $label = $('<span>')
            .addClass('sheet-tab-label')
            .text(sheet.name);

        const $close = $('<button>')
            .addClass('sheet-tab-close')
            .attr('title', 'Delete sheet')
            .html('&times;');

        $tab.append($label).append($close);
        $bar.append($tab);

        // Switch on click
        $tab.on('click', function (e) {
            if (!$(e.target).hasClass('sheet-tab-close')) {
                switchSheet(sheet.id);
            }
        });

        // Rename on dblclick
        $label.on('dblclick', function (e) {
            e.stopPropagation();
            const currentName = sheet.name;
            $label.attr('contenteditable', 'true').focus();
            // Select all text
            const range = document.createRange();
            range.selectNodeContents($label[0]);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);

            $label.one('blur keydown', function (ev) {
                if (ev.type === 'blur' || ev.key === 'Enter') {
                    ev.preventDefault();
                    const newName = $label.text().trim() || currentName;
                    $label.removeAttr('contenteditable');
                    renameSheet(sheet.id, newName);
                } else if (ev.key === 'Escape') {
                    $label.text(currentName).removeAttr('contenteditable');
                }
            });
        });

        // Delete on close button click
        $close.on('click', function (e) {
            e.stopPropagation();
            deleteSheet(sheet.id);
        });
    });

    // "+" add blank sheet button
    const $addBtn = $('<button>')
        .addClass('sheet-tab-add')
        .attr('title', 'Add blank sheet')
        .text('+');
    $addBtn.on('click', addBlankSheet);
    $bar.append($addBtn);
}
