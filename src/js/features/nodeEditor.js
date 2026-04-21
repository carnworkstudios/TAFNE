// ===================================================================================
// NODE EDITOR; Main Controller
//   — Mode toggle (mirrors labMode pattern)
//   — Table ↔ Node sync (enable loads sheets as nodes; disable writes nodes back)
//   — DOM rendering for node cards
//   — Inline cell editing with copy-on-write
//   — History integration
// ===================================================================================

window.nodeEditorEnabled   = false;
window._nodeEditorSnapshot = null;  // persists graph + cellStore across mode switches

// ──────────────────────────────────────────────────────────────────────────────
// Enable / Disable
// ──────────────────────────────────────────────────────────────────────────────

function enableNodeEditor() {
    if (window.nodeEditorEnabled) return;
    window.nodeEditorEnabled = true;

    $('#nodeEditorToggle').addClass('active').attr('title', 'Node Editor: ON');
    $('#selectToolToggle').removeClass('active');

    // Exit lab mode if active
    if (window.labModeEnabled && typeof disableLab === 'function') {
        disableLab();
    }

    // Save the current sheet state so it survives the mode switch
    if (typeof _saveActiveSheetState === 'function') _saveActiveSheetState();

    // Swap views
    $('.table-wrapper').hide();
    $('#sheetTabBar').hide();
    $('#nodeEditorCanvas').css('display', 'flex');
    document.body.classList.add('node-editor-active');

    // Restore previous session if one exists; otherwise build fresh from sheets
    if (window._nodeEditorSnapshot) {
        _restoreSnapshot(window._nodeEditorSnapshot);
    } else {
        _loadSheetsAsNodes();
    }

    // Boot canvas renderer
    window.nodeCanvasRenderer.init();
    window.nodeCanvasRenderer.start();

    // Boot interaction manager
    const viewport = document.getElementById('nodeEditorViewport');
    if (viewport) window.nodeInteractionManager.init(viewport);

    // Fit all nodes into view after one paint
    setTimeout(() => {
        const vp = document.getElementById('nodeEditorViewport');
        if (vp) window.nodeGraphManager.fitToView(vp.clientWidth, vp.clientHeight);
        window.nodeCanvasRenderer.markBgDirty();
        window.nodeCanvasRenderer.markStaticDirty();
    }, 80);

    $.toast({ heading: 'Node Editor', text: 'Node Editor activated', icon: 'info', loader: false, stack: false });
}

function disableNodeEditor() {
    if (!window.nodeEditorEnabled) return;
    window.nodeEditorEnabled = false;

    $('#nodeEditorToggle').removeClass('active').attr('title', 'Node Editor: OFF');
    $('#selectToolToggle').addClass('active');

    // Sync table-type node edits back to sheets
    _syncNodesToSheets();

    // Save full graph + cellStore so we can restore on re-entry
    window._nodeEditorSnapshot = {
        graph:     window.nodeGraphManager.snapshot(),
        cellStore: window.cellStoreManager.snapshot()
    };

    // Tear down canvas + interactions
    window.nodeCanvasRenderer.stop();
    window.nodeInteractionManager.destroy();

    // Close config panel if open
    if (typeof window.nodeConfigPanel !== 'undefined') window.nodeConfigPanel.close();

    // Clear HTML layer
    const htmlLayer = document.getElementById('nodeHtmlLayer');
    if (htmlLayer) htmlLayer.innerHTML = '';

    // Clear live graph (snapshot is the source of truth now)
    window.NodeGraph.nodes = {};
    window.NodeGraph.wires = {};
    window.cellStoreManager.clear();

    // Swap views back
    $('#nodeEditorCanvas').hide();
    $('.table-wrapper').show();
    $('#sheetTabBar').show();
    document.body.classList.remove('node-editor-active');

    $.toast({ heading: 'Node Editor', text: 'Returned to table view', icon: 'info', loader: false, stack: false });
}

function toggleNodeEditor() {
    if (window.nodeEditorEnabled) disableNodeEditor();
    else enableNodeEditor();
}

// ──────────────────────────────────────────────────────────────────────────────
// Table → Nodes  (on enable: read existing sheets, populate CellStore + NodeGraph)
// ──────────────────────────────────────────────────────────────────────────────

function _loadSheetsAsNodes() {
    const htmlLayer = document.getElementById('nodeHtmlLayer');
    if (!htmlLayer) return;

    htmlLayer.innerHTML = '';
    window.NodeGraph.nodes = {};
    window.NodeGraph.wires = {};
    window.cellStoreManager.clear();

    const COLS = 3;
    let idx = 0;

    window.sheets.forEach(sheet => {
        // Use the live container HTML for the active sheet; saved state for others
        let html = '';
        if (sheet.id === window.activeSheetId) {
            html = $('#tableContainer').html();
        } else {
            html = sheet.containerHtml || sheet.rawHtml || '';
        }

        const $temp  = $('<div>').html(html);
        const $table = $temp.find('table').first();

        if (!$table.length) { idx++; return; }

        const csm     = window.cellStoreManager;
        const headers = [];
        const $rows   = $table.find('tr');

        // First row → column headers (ports)
        $rows.first().find('td, th').each(function () {
            headers.push({
                portId:  'port-' + crypto.randomUUID().slice(0, 8),
                label:   $(this).text().trim() || 'Column',
                cellIds: []
            });
        });

        // Remaining rows → cell values in CellStore
        $rows.slice(1).each(function () {
            $(this).find('td, th').each(function (colIdx) {
                if (colIdx < headers.length) {
                    headers[colIdx].cellIds.push(csm.create($(this).text().trim()));
                }
            });
        });

        // Stagger nodes in a 3-column grid
        const x = 50 + (idx % COLS) * 340;
        const y = 50 + Math.floor(idx / COLS) * 320;

        const nodeId = window.nodeGraphManager.addNode(sheet.name, x, y, headers);
        window.NodeGraph.nodes[nodeId].sourceSheetId = sheet.id;

        renderNodeDom(nodeId);
        idx++;
    });
}

// ──────────────────────────────────────────────────────────────────────────────
// Snapshot restore  (re-entry after switching away from node editor)
// ──────────────────────────────────────────────────────────────────────────────

function _restoreSnapshot(snapshot) {
    const htmlLayer = document.getElementById('nodeHtmlLayer');
    if (!htmlLayer) return;

    htmlLayer.innerHTML = '';

    // Restore graph data model
    window.nodeGraphManager.restore(snapshot.graph);

    // Restore cell store
    window.cellStoreManager.restore(snapshot.cellStore);

    // Re-render every node card from restored state
    Object.keys(window.NodeGraph.nodes).forEach(nodeId => {
        renderNodeDom(nodeId);
    });
}

// ──────────────────────────────────────────────────────────────────────────────
// Nodes → Tables  (on disable: write node state back to sheets)
// ──────────────────────────────────────────────────────────────────────────────

// Shared helper: read one cell value from a header at row r
// Columnar headers (operator output): h.values[r]
// CellStore headers (source/table nodes): csm.get(h.cellIds[r])
function _nodeVal(h, r, csm) {
    if (h.values) return String(h.values[r] ?? '');
    const id = (h.cellIds || [])[r];
    const cell = id ? csm.get(id) : null;
    return cell ? cell.value : '';
}

function _syncNodesToSheets() {
    const csm = window.cellStoreManager;

    Object.values(window.NodeGraph.nodes).forEach(node => {
        if (!node.sourceSheetId) return;
        const sheet = window.sheets.find(s => s.id === node.sourceSheetId);
        if (!sheet) return;

        let html = '<table class="tablecoil crosshair-table"><thead><tr>';
        node.headers.forEach(h => { html += `<th>${_esc(h.label)}</th>`; });
        html += '</tr></thead><tbody>';

        // maxRows: check h.values (columnar) or h.cellIds (CellStore) length
        const maxRows = node.headers.reduce((m, h) => Math.max(m, (h.values || h.cellIds || []).length), 0);
        for (let r = 0; r < maxRows; r++) {
            html += '<tr>';
            node.headers.forEach(h => { html += `<td>${_esc(_nodeVal(h, r, csm))}</td>`; });
            html += '</tr>';
        }
        html += '</tbody></table>';

        sheet.rawHtml       = html;
        sheet.containerHtml = null; // force re-parse from rawHtml on next activate
    });
}

function _esc(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ──────────────────────────────────────────────────────────────────────────────
// DOM Rendering — Node Cards
// ──────────────────────────────────────────────────────────────────────────────

const MAX_VISIBLE_ROWS = 8;

function renderNodeDom(nodeId) {
    const node = window.NodeGraph.nodes[nodeId];
    if (!node) return;

    const htmlLayer = document.getElementById('nodeHtmlLayer');
    if (!htmlLayer) return;

    // Remove previous DOM for this node if it exists
    const old = htmlLayer.querySelector(`[data-node-id="${nodeId}"]`);
    if (old) old.remove();

    const csm        = window.cellStoreManager;
    const collapsed  = node.collapsed;
    const nodeType   = node.nodeType || 'table';
    const typeDef    = window.NodeTypes ? window.NodeTypes.get(nodeType) : null;
    const isOperator = window.NodeTypes ? window.NodeTypes.isOperator(nodeType) : false;

    // ── Header rows (port row per column) — direction-aware
    let headerRowsHtml = '';
    node.headers.forEach(h => {
        const dir = h.direction || (isOperator ? 'in' : 'inout');
        const showIn  = dir === 'in'  || dir === 'inout';
        const showOut = dir === 'out' || dir === 'inout';
        const inPort  = showIn
            ? `<div class="ne-port ne-port-in"  data-port-id="${h.portId}"     title="In: ${_esc(h.label)}"></div>`
            : `<div class="ne-port-spacer"></div>`;
        const outPort = showOut
            ? `<div class="ne-port ne-port-out" data-port-id="${h.portId}-out" title="Out: ${_esc(h.label)}"></div>`
            : `<div class="ne-port-spacer"></div>`;

        headerRowsHtml += `
            <div class="ne-node-row ne-node-col-row">
                ${inPort}
                <span class="ne-cell-label" title="${_esc(h.label)}">${_esc(h.label)}</span>
                ${outPort}
            </div>`;
    });

    // ── Data rows (up to MAX_VISIBLE_ROWS, only for table nodes or done operator nodes)
    let dataRowsHtml = '';
    if (!collapsed && node.headers.length > 0) {
        // rowCount: check h.values (columnar/operator headers) or h.cellIds (source/table headers)
        const rowCount    = node.headers.reduce((m, h) => Math.max(m, (h.values || h.cellIds || []).length), 0);
        const displayRows = Math.min(rowCount, MAX_VISIBLE_ROWS);

        for (let r = 0; r < displayRows; r++) {
            dataRowsHtml += '<div class="ne-node-data-row">';
            node.headers.forEach(h => {
                let val    = '';
                let cellId = '';
                if (h.values) {
                    // Columnar path — operator output, read directly from array
                    val = _esc(String(h.values[r] ?? ''));
                } else {
                    // CellStore path — source/table node
                    cellId = (h.cellIds || [])[r] || '';
                    const cell = cellId ? csm.get(cellId) : null;
                    val = cell ? _esc(cell.value) : '';
                }
                dataRowsHtml += `<span class="ne-cell-value" data-cell-id="${cellId}" title="${val}">${val || '<em class="ne-cell-empty">—</em>'}</span>`;
            });
            dataRowsHtml += '</div>';
        }

        if (rowCount > MAX_VISIBLE_ROWS) {
            dataRowsHtml += `<div class="ne-node-overflow-hint">+${rowCount - MAX_VISIBLE_ROWS} more rows</div>`;
        }
    }

    // ── Exec state badge
    const execState  = node.execState || 'idle';
    const execBadges = { idle: '', running: '<span class="ne-exec-badge ne-exec-running">●</span>', done: '<span class="ne-exec-badge ne-exec-done">✓</span>', error: '<span class="ne-exec-badge ne-exec-error" title="' + _esc(node.execError || '') + '">✕</span>' };
    const execBadge  = execBadges[execState] || '';

    // ── Type badge (operator nodes only)
    const typeBadge = typeDef && isOperator
        ? `<span class="ne-type-badge" style="background:${typeDef.color}" title="${_esc(typeDef.description)}">${typeDef.icon} ${typeDef.label}</span>`
        : '';

    // ── Config button (operator nodes only) — disabled until at least one input wire exists
    let configBtn = '';
    if (isOperator) {
        const hasInputWire = Object.values(window.NodeGraph.wires || {}).some(
            w => w.targetNodeId === nodeId
        );
        if (hasInputWire) {
            configBtn = `<button class="ne-node-config-btn" title="Configure node">⚙</button>`;
        } else {
            configBtn = `<button class="ne-node-config-btn ne-config-btn-disabled" title="Connect a source table first" disabled>⚙</button>`;
        }
    }

    // ── Operator placeholder when idle/running and no input wires yet
    let operatorPlaceholder = '';
    if (isOperator && !collapsed && (execState === 'idle' || execState === 'running')) {
        const hasInputWire = Object.values(window.NodeGraph.wires || {}).some(
            w => w.targetNodeId === nodeId
        );
        if (!hasInputWire) {
            operatorPlaceholder = `<div class="ne-operator-placeholder">Wire a table's output port here, then ⚙ configure</div>`;
        } else if (node.headers.filter(h => h.direction === 'out').length === 0) {
            operatorPlaceholder = `<div class="ne-operator-placeholder">${execState === 'running' ? 'Running…' : 'Configure ⚙ then click ▶ Run'}</div>`;
        }
    }

    // ── Build element
    const el = document.createElement('div');
    el.className = [
        'ne-node',
        node.selected  ? 'selected'  : '',
        collapsed      ? 'collapsed' : '',
        isOperator     ? 'ne-operator' : '',
        `ne-type-${nodeType}`,
        execState !== 'idle' ? `ne-exec-${execState}` : ''
    ].filter(Boolean).join(' ');

    el.dataset.nodeId   = nodeId;
    el.dataset.nodeType = nodeType;
    el.style.cssText    = `left:${node.x}px; top:${node.y}px; width:${node.width || 280}px;`;

    el.innerHTML = `
        <div class="ne-node-header">
            <span class="ne-node-collapse-btn" title="${collapsed ? 'Expand' : 'Collapse'}">${collapsed ? '▶' : '▼'}</span>
            ${typeBadge}
            <span class="ne-node-label" title="${_esc(node.label)}">${_esc(node.label)}</span>
            ${execBadge}
            <span class="ne-node-meta">${node.headers.length} col${node.headers.length !== 1 ? 's' : ''}</span>
            ${configBtn}
            <button class="ne-node-delete-btn" title="Remove node">✕</button>
        </div>
        <div class="ne-node-body${collapsed ? ' ne-hidden' : ''}">
            <div class="ne-node-col-rows">${headerRowsHtml}</div>
            ${operatorPlaceholder}
            <div class="ne-node-data-rows">${dataRowsHtml}</div>
        </div>`;

    // ── Inline edit on double-click (table nodes only)
    if (!isOperator) {
        el.querySelectorAll('.ne-cell-value').forEach(cellEl => {
            cellEl.addEventListener('dblclick', function (e) {
                e.stopPropagation();
                const cellId = this.dataset.cellId;
                if (!cellId) return;
                _startInlineEdit(this, cellId, nodeId);
            });
        });
    }

    htmlLayer.appendChild(el);
}

window.renderNodeDom = renderNodeDom;

// ──────────────────────────────────────────────────────────────────────────────
// Inline Cell Editing (copy-on-write)
// ──────────────────────────────────────────────────────────────────────────────

function _startInlineEdit(cellEl, cellId, nodeId) {
    const current = window.cellStoreManager.get(cellId);
    if (!current) return;

    const input = document.createElement('input');
    input.type      = 'text';
    input.value     = current.value;
    input.className = 'ne-cell-edit-input';

    const finish = () => {
        const newVal  = input.value;
        const ownedId = window.cellStoreManager.deref(cellId);
        if (!ownedId) return;

        window.cellStoreManager.update(ownedId, newVal);

        // If deref created a new UUID, update all header cellIds that referenced the old one
        if (ownedId !== cellId) {
            Object.values(window.NodeGraph.nodes).forEach(n => {
                n.headers.forEach(h => {
                    const i = h.cellIds.indexOf(cellId);
                    if (i !== -1) h.cellIds[i] = ownedId;
                });
            });
        }

        // Re-render all nodes that contain this cell
        Object.keys(window.NodeGraph.nodes).forEach(nId => {
            const n = window.NodeGraph.nodes[nId];
            const touched = n.headers.some(h => h.cellIds.includes(ownedId) || h.cellIds.includes(cellId));
            if (touched) renderNodeDom(nId);
        });

        if (typeof window.saveNodeEditorState === 'function') window.saveNodeEditorState();
    };

    let finished = false;
    const safeFinish = () => { if (!finished) { finished = true; finish(); } };

    input.addEventListener('blur',    safeFinish);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') {
            finished = true;
            // Cancel — re-render without saving
            const nodeEl = document.querySelector(`[data-node-id="${nodeId}"]`);
            const parentHtmlLayer = document.getElementById('nodeHtmlLayer');
            if (nodeEl && parentHtmlLayer) {
                nodeEl.remove();
                renderNodeDom(nodeId);
            }
        }
    });

    cellEl.replaceWith(input);
    input.focus();
    input.select();
}

// ──────────────────────────────────────────────────────────────────────────────
// Add current sheet as an extra node (toolbar button: "Add Sheet")
// ──────────────────────────────────────────────────────────────────────────────

function addCurrentSheetAsNode() {
    if (!window.activeSheetId) {
        $.toast({ heading: 'Node Editor', text: 'No active sheet', icon: 'warning', loader: false, stack: false });
        return;
    }

    const sheet = window.sheets.find(s => s.id === window.activeSheetId);
    if (!sheet) return;

    const already = Object.values(window.NodeGraph.nodes).find(n => n.sourceSheetId === window.activeSheetId);
    if (already) {
        $.toast({ heading: 'Node Editor', text: 'Sheet already in node view', icon: 'warning', loader: false, stack: false });
        return;
    }

    const csm     = window.cellStoreManager;
    const html    = $('#tableContainer').html();
    const $temp   = $('<div>').html(html);
    const $table  = $temp.find('table').first();

    if (!$table.length) {
        $.toast({ heading: 'Node Editor', text: 'No table in current sheet', icon: 'warning', loader: false, stack: false });
        return;
    }

    const headers = [];
    const $rows   = $table.find('tr');

    $rows.first().find('td, th').each(function () {
        headers.push({ portId: 'port-' + crypto.randomUUID().slice(0, 8), label: $(this).text().trim() || 'Column', cellIds: [] });
    });
    $rows.slice(1).each(function () {
        $(this).find('td, th').each(function (ci) {
            if (ci < headers.length) headers[ci].cellIds.push(csm.create($(this).text().trim()));
        });
    });

    const count = Object.keys(window.NodeGraph.nodes).length;
    const x = 50 + (count % 3) * 340;
    const y = 50 + Math.floor(count / 3) * 320;

    const nodeId = window.nodeGraphManager.addNode(sheet.name, x, y, headers);
    window.NodeGraph.nodes[nodeId].sourceSheetId = window.activeSheetId;
    renderNodeDom(nodeId);

    window.nodeCanvasRenderer.markStaticDirty();
    if (typeof window.saveNodeEditorState === 'function') window.saveNodeEditorState();
    $.toast({ heading: 'Node Editor', text: `"${sheet.name}" added`, icon: 'success', loader: false, stack: false });
}

// ──────────────────────────────────────────────────────────────────────────────
// Build Table from selected node (toolbar button: "Build Table")
// ──────────────────────────────────────────────────────────────────────────────

function buildTableFromSelectedNode() {
    const selected = window.nodeGraphManager.getSelectedNodes();
    if (selected.length === 0) {
        $.toast({ heading: 'Node Editor', text: 'Select a node first', icon: 'warning', loader: false, stack: false });
        return;
    }

    const node    = selected[0];
    const csm     = window.cellStoreManager;

    // maxRows: check h.values (columnar) or h.cellIds (CellStore) length
    const maxRows = node.headers.reduce((m, h) => Math.max(m, (h.values || h.cellIds || []).length), 0);

    // Only output 'out' or 'inout' columns — skip structural 'in' ports (e.g. join-in-left)
    const outputHeaders = node.headers.filter(h => h.direction !== 'in');

    let html = '<table class="tablecoil crosshair-table"><thead><tr>';
    outputHeaders.forEach(h => { html += `<th>${_esc(h.label)}</th>`; });
    html += '</tr></thead><tbody>';
    for (let r = 0; r < maxRows; r++) {
        html += '<tr>';
        outputHeaders.forEach(h => { html += `<td>${_esc(_nodeVal(h, r, csm))}</td>`; });
        html += '</tr>';
    }
    html += '</tbody></table>';

    if (typeof addSheet === 'function') {
        addSheet(node.label + ' (node)', html);
        $.toast({ heading: 'Node Editor', text: `Table built from "${node.label}"`, icon: 'success', loader: false, stack: false });
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Fit to view (toolbar button)
// ──────────────────────────────────────────────────────────────────────────────

function fitNodeView() {
    const vp = document.getElementById('nodeEditorViewport');
    if (!vp) return;
    window.nodeGraphManager.fitToView(vp.clientWidth, vp.clientHeight);
    window.nodeCanvasRenderer.markBgDirty();
    window.nodeCanvasRenderer.markStaticDirty();
}

// ──────────────────────────────────────────────────────────────────────────────
// History integration
// ──────────────────────────────────────────────────────────────────────────────

function saveNodeEditorState() {
    if (!window.nodeEditorEnabled) return;
    if (!window.historyManager || window.historyManager.isRestoring) return;

    const state = JSON.stringify({
        type:      'nodeEditor',
        graph:     window.nodeGraphManager.snapshot(),
        cellStore: window.cellStoreManager.snapshot()
    });
    window.historyManager.saveState(state);
}

window.saveNodeEditorState = saveNodeEditorState;

// ──────────────────────────────────────────────────────────────────────────────
// Theme change listener
// ──────────────────────────────────────────────────────────────────────────────

// Legacy postMessage format (direct from os-shell.js fallback)
window.addEventListener('message', function (ev) {
    if (ev.data && ev.data.type === 'cws:theme-change' && window.nodeEditorEnabled) {
        window.nodeCanvasRenderer.onThemeChange();
    }
});
// New bridge CustomEvent format (from CwsBridge)
window.addEventListener('cws-theme-change', function () {
    if (window.nodeEditorEnabled && window.nodeCanvasRenderer) {
        window.nodeCanvasRenderer.onThemeChange();
    }
});

// ──────────────────────────────────────────────────────────────────────────────
// Init (wires up toolbar buttons — called from tifany.js)
// ──────────────────────────────────────────────────────────────────────────────

function initNodeEditor() {
    $('#nodeEditorToggle').on('click',  toggleNodeEditor);
    $('#neExit').on('click',           disableNodeEditor);
    $('#neFitView').on('click',        fitNodeView);
    $('#neBuildTable').on('click',     buildTableFromSelectedNode);
    $('#neAddFromSheet').on('click',   addCurrentSheetAsNode);
    $('#neRunGraph').on('click',       () => window.nodeExecutor.run());
    $('#neResetRun').on('click',       () => window.nodeExecutor.resetRunState());

    // Palette + config panel
    if (typeof window.nodePaletteInit === 'function') window.nodePaletteInit();
    if (typeof window.nodeConfigPanel !== 'undefined') window.nodeConfigPanel.init();
}
