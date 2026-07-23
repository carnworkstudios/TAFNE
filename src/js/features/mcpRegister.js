/* ============================================================
   TAFNE — GxMCP verb registration (PUBLIC / in-submodule)
   ------------------------------------------------------------
   Declares TAFNE's FULL verb surface so a copilot can do
   everything a user can: table-viewer ops (incl. new sheets,
   styling, class/id, collapsible columns), node-editor ops
   (add filter/vlookup/join/api/formula nodes, run, reset), and
   Lab/VTA transforms (ALL 26, auto-generated from
   window.LabFunctionMeta so the manifest can never drift from
   the tool's real surface).

   Collapsible columns are the accordion/sp-selector structure
   (initAccordions / initSpSelectors in tifanyTabs.js), applied
   via the style panel's applyClassId + a re-init.

   WHY THIS FILE LIVES IN THE SUBMODULE (not root, unlike Schema
   and PDF): its apply() calls TAFNE's OWN public functions
   (transposeTable, LabFunctions.*, nodeGraphManager.addNode, …).
   That is public CAPABILITY + public SHAPE — mutating your own
   document is not a moat. It carries NO intelligence: turning a
   prompt into ops is server-side (backend/ai/router.py) + the
   shell copilot. Schema/PDF registrations live in root ONLY
   because their apply IS intelligence (auto-placement layout /
   extraction inference). Placement tracks the IP standard
   per-tool. See assets/os/mcp.js + architecture/mcp-layer.md.

   SHEET & MODE ADDRESSING: the user references a sheet as @Name
   and a mode as /table-view /lab-mode /node in the prompt; the
   model turns those into a `sheet` field on the op (name or id)
   and set_mode ops. Every mutating verb resolves op.sheet →
   switchSheet first. A NEW create_table opens a NEW sheet by
   default; add_table_to_sheet is the explicit "append" path.
   ============================================================ */
(function () {
    'use strict';
    if (!window.GxMCP || typeof window.GxMCP.register !== 'function') return;

    // ── Tool state helpers (all read/drive TAFNE's own public state) ─────────────
    function _table() { return window.currentTable || document.querySelector('#tableContainer table'); }
    function _rowsAsGrid(t) {
        t = t || _table();
        if (!t) return [];
        return Array.from(t.rows, function (row) {
            return Array.from(row.cells, function (c) { return c.innerText.trim(); });
        });
    }
    function _gridToRows(grid) {
        if (!grid.length) return [];
        var headers = grid[0];
        return grid.slice(1).map(function (r) {
            var o = {};
            headers.forEach(function (h, i) { o[h || ('Column ' + (i + 1))] = r[i] != null ? r[i] : ''; });
            return o;
        });
    }
    function _reloadActiveFromRows(rows, name) {
        // Replace the ACTIVE sheet's content with LabFunctions-style row objects
        // by rebuilding it in place (no new sheet — VTA transforms mutate current).
        if (typeof window.parseJsonInput === 'function' && window.activeSheetId != null) {
            var html = window.parseJsonInput(JSON.stringify(rows));
            var container = document.getElementById('tableContainer');
            if (container && html) { container.innerHTML = html; return true; }
        }
        // Fallback: append as a new sheet.
        if (typeof window.loadTablesAsSheets === 'function') {
            window.loadTablesAsSheets({ schema: 'gx-tables-v1', tables: [{ name: name || 'Result', rows: rows }] });
            return true;
        }
        return false;
    }
    function _dispatchGridOps(ops) {
        window.postMessage({ type: 'gx:ai-apply-ops', ops: ops }, window.location.origin);
        return { dispatched: ops.length };
    }
    function _notBuilt(name) { throw new Error(name + ' is not yet implemented in TAFNE'); }

    // Resolve op.sheet (a name OR an id) to a sheet id and switch to it. Returns
    // true if a switch happened, false if none needed, throws if unresolved.
    function _resolveSheet(op) {
        var ref = op && op.sheet;
        if (!ref) return false;                       // act on the active sheet
        ref = String(ref).replace(/^@/, '').trim();   // models echo the @ prefix — strip it
        if (!ref) return false;
        var sheets = window.sheets || [];
        var byId = sheets.find(function (s) { return s.id === ref; });
        var byName = byId || sheets.find(function (s) {
            return (s.name || '').toLowerCase() === String(ref).toLowerCase();
        });
        var target = byId || byName;
        if (!target) throw new Error('unknown sheet: @' + ref);
        if (target.id !== window.activeSheetId && typeof window.switchSheet === 'function') {
            window.switchSheet(target.id);
        }
        return true;
    }

    // Set the value of a DOM form field, then optionally trigger it (for the
    // style/class panel whose apply reads a batch of inputs).
    function _setField(id, val) {
        var el = document.getElementById(id);
        if (el != null && val != null) { el.value = val; }
    }

    // ── Node graph helpers (for connect_nodes) ───────────────────────────────────
    // Resolve a node reference (label OR node-id) to its id.
    function _resolveNode(ref) {
        var nodes = (window.NodeGraph && window.NodeGraph.nodes) || {};
        if (nodes[ref]) return ref;                          // already an id
        var match = Object.values(nodes).find(function (n) {
            return (n.label || '').toLowerCase() === String(ref).toLowerCase();
        });
        return match ? match.id : null;
    }
    // Pick a port on `node` that can act in `dir` ('out'|'in'). Mirrors the
    // direction rules in nodeInteractions._completeWire: a header's direction is
    // 'inout'|'in'|'out'; an out-port may carry a '-out' suffix.
    function _pickPort(node, dir) {
        var headers = (node && node.headers) || [];
        for (var i = 0; i < headers.length; i++) {
            var d = headers[i].direction || 'inout';
            if (dir === 'out' && (d === 'out' || d === 'inout')) return headers[i].portId + (d === 'inout' ? '-out' : '');
            if (dir === 'in' && (d === 'in' || d === 'inout')) return headers[i].portId;
        }
        return null;
    }

    // ── Manifest: static verbs ───────────────────────────────────────────────────
    var VERBS = [
        // ── Table viewer: structure ──────────────────────────────────────────────
        { name: 'create_table', group: 'table', doc: 'Create a table in a NEW sheet (default for any new-table request). rows×cols; name optional.',
          params: { rows: { type: 'int', min: 1, max: 500 }, cols: { type: 'int', min: 1, max: 100 }, name: { type: 'string' } } },
        { name: 'add_table_to_sheet', group: 'table', doc: 'Add a table to an EXISTING sheet (only when the user says "add to @Sheet").',
          params: { sheet: { type: 'string' }, rows: { type: 'int', min: 1, max: 500 }, cols: { type: 'int', min: 1, max: 100 } } },
        { name: 'new_sheet', group: 'table', doc: 'Open a new blank sheet.', params: { name: { type: 'string' } } },
        { name: 'set_cell', group: 'table', doc: 'Set one cell (0-indexed). Optional sheet targets @Name/id.',
          params: { row: { type: 'int' }, col: { type: 'int' }, text: { type: 'string' }, sheet: { type: 'string' } } },
        { name: 'add_row', group: 'table', doc: 'Insert a blank row at index. Optional sheet.', params: { index: { type: 'int' }, sheet: { type: 'string' } } },
        { name: 'delete_row', group: 'table', doc: 'Delete the row at index. Optional sheet.', params: { index: { type: 'int' }, sheet: { type: 'string' } } },
        { name: 'add_column', group: 'table', doc: 'Insert a blank column at index. Optional sheet.', params: { index: { type: 'int' }, sheet: { type: 'string' } } },
        { name: 'delete_column', group: 'table', doc: 'Delete the column at index. Optional sheet.', params: { index: { type: 'int' }, sheet: { type: 'string' } } },
        { name: 'merge_cells', group: 'table', doc: 'Merge a rectangular cell range. Optional sheet.',
          params: { start_row: { type: 'int' }, start_col: { type: 'int' }, end_row: { type: 'int' }, end_col: { type: 'int' }, sheet: { type: 'string' } } },
        { name: 'transpose', group: 'table', doc: 'Swap rows and columns of the whole table. Optional sheet.', params: { sheet: { type: 'string' } } },
        { name: 'transpose_selection', group: 'table', doc: 'Transpose only the currently selected cell range.', params: {} },
        { name: 'copy_clipboard', group: 'table', doc: 'Copy the current table to the clipboard.', params: {} },
        { name: 'make_tabs', group: 'table', doc: 'Add N collapsible tabs to a sheet: wraps its table(s) into accordion cards with `count` tab buttons to iterate through. THIS single op is the COMPLETE way to add "tabs"/collapsible views — do NOT accompany it with apply_id, apply_class, or per-column ops; make_tabs handles the whole structure itself.',
          params: { count: { type: 'int', min: 1, max: 100 }, sheet: { type: 'string' } } },
        // ── Table viewer: style / class / id / attributes / collapsible ──────────
        { name: 'apply_class', group: 'style', doc: 'Apply a CSS class name to the target elements (rows/cols/cells/table).',
          params: { class: { type: 'string' }, target: { type: 'enum', values: ['cell', 'row', 'column', 'table'] } } },
        { name: 'apply_id', group: 'style', doc: 'Apply an id to the target element (used for collapsible columns / anchors).',
          params: { id: { type: 'string' }, target: { type: 'enum', values: ['cell', 'row', 'column', 'table'] } } },
        { name: 'set_style', group: 'style', doc: 'Set a CSS style on the target (color/background/border-color).',
          params: { style: { type: 'enum', values: ['background-color', 'color', 'border-color'] }, color: { type: 'string' }, target: { type: 'enum', values: ['cell', 'row', 'column', 'table'] } } },
        { name: 'set_spacing', group: 'style', doc: 'Set padding/margin spacing (px) on the target.',
          params: { style: { type: 'enum', values: ['padding', 'margin'] }, top: { type: 'number' }, right: { type: 'number' }, bottom: { type: 'number' }, left: { type: 'number' }, target: { type: 'enum', values: ['cell', 'row', 'column', 'table'] } } },
        { name: 'set_attribute', group: 'style', doc: 'Set a table attribute (e.g. table-layout, border-collapse).',
          params: { attribute: { type: 'string' }, value: { type: 'string' } } },
        // (collapsible "tabs" are done with make_tabs, above — not a per-column op)
        // ── Node editor ──────────────────────────────────────────────────────────
        { name: 'set_mode', group: 'mode', doc: 'Switch tool mode (from /table-view /lab-mode /node references).',
          params: { mode: { type: 'enum', values: ['table', 'lab', 'node'] } } },
        { name: 'add_node', group: 'node', doc: 'Add an operator node to the node graph.',
          params: { node_type: { type: 'enum', values: ['filter', 'vlookup', 'formula', 'join', 'api'] }, label: { type: 'string' } } },
        { name: 'add_sheet_node', group: 'node', doc: 'Add the current/named sheet as a table node.', params: { sheet: { type: 'string' } } },
        { name: 'connect_nodes', group: 'node', doc: 'Wire one node’s output into another node’s input (references are node labels or ids). Ports are auto-picked from each node’s direction.',
          params: { from: { type: 'string', doc: 'source node label or id' }, to: { type: 'string', doc: 'target node label or id' } } },
        { name: 'run_nodes', group: 'node', doc: 'Execute the node graph.', params: {} },
        { name: 'reset_nodes', group: 'node', doc: 'Reset node run state after a stuck/failed run.', params: {} },
        { name: 'build_table_from_node', group: 'node', doc: 'Materialize the selected node output as a new table.', params: {} },
    ];

    // ── VTA verbs — AUTO-GENERATED from window.LabFunctionMeta ────────────────────
    // Every Lab function (all 26) becomes a vta_<name> verb whose params mirror the
    // meta's declared params. Generated at register time so the manifest is always
    // in lockstep with the real Lab surface — no hand-transcription, no drift.
    var _LAB_META_TYPE = { col: 'string', 'multi-col': 'string', num: 'number', pattern: 'string', 'cross-op': 'string', str: 'string', bool: 'bool' };
    function _buildVtaVerbs() {
        var meta = window.LabFunctionMeta || {};
        var verbs = [];
        Object.keys(meta).forEach(function (fnName) {
            var m = meta[fnName];
            var params = { sheet: { type: 'string' } };   // every VTA verb can target a sheet
            (m.params || []).forEach(function (p) {
                params[p.key] = { type: _LAB_META_TYPE[p.type] || 'string', doc: p.label };
            });
            verbs.push({
                name: 'vta_' + fnName,
                group: 'vta_' + (m.group || 'transform'),
                doc: (m.label || fnName) + ' (Lab/VTA)',
                params: params,
                _lab: fnName,   // internal: which LabFunctions key to call
            });
        });
        return verbs;
    }

    // ── apply(op) — calls TAFNE's own public functions ───────────────────────────
    function apply(op) {
        var name = op.op || op.name;

        // set_mode first (no sheet resolution).
        if (name === 'set_mode') {
            if (op.mode === 'lab' && typeof window.enableLab === 'function') { window.enableLab(); return { ok: true, mode: 'lab' }; }
            if (op.mode === 'node' && typeof window.enableNodeEditor === 'function') { window.enableNodeEditor(); return { ok: true, mode: 'node' }; }
            if (op.mode === 'table') {
                if (typeof window.disableLab === 'function') window.disableLab();
                if (typeof window.disableNodeEditor === 'function') window.disableNodeEditor();
                return { ok: true, mode: 'table' };
            }
            return _notBuilt('set_mode(' + op.mode + ')');
        }

        // create_table / new_sheet open a NEW sheet (the default for any new table).
        // GUARD: if the op names an EXISTING sheet, the model meant "edit that
        // sheet", not "rebuild it" — switch to it and do nothing destructive.
        if (name === 'create_table' || name === 'new_sheet') {
            var cleanName = op.name ? String(op.name).replace(/^@/, '').trim() : null;
            if (cleanName) {
                var existing = (window.sheets || []).find(function (s) {
                    return (s.name || '').toLowerCase() === cleanName.toLowerCase() || s.id === cleanName;
                });
                if (existing) {
                    if (existing.id !== window.activeSheetId && typeof window.switchSheet === 'function') window.switchSheet(existing.id);
                    return { ok: true, switchedToExisting: existing.id, note: 'named an existing sheet — switched instead of rebuilding' };
                }
            }
            var r = op.rows || 2, c = op.cols || 2;
            var rowsArr = [];
            for (var i = 0; i < Math.max(1, r) - 1; i++) {
                var o = {};
                for (var j = 0; j < c; j++) o['Column ' + (j + 1)] = '';
                rowsArr.push(o);
            }
            if (typeof window.loadTablesAsSheets === 'function') {
                window.loadTablesAsSheets({ schema: 'gx-tables-v1', tables: [{ name: cleanName || null, rows: rowsArr.length ? rowsArr : [{ 'Column 1': '' }] }] });
                return { ok: true, newSheet: true };
            }
            if (typeof window.addBlankSheet === 'function') { window.addBlankSheet(); return { ok: true }; }
            return _notBuilt(name);
        }
        if (name === 'add_table_to_sheet') {
            _resolveSheet(op);   // switch to the target sheet, then dispatch a create in place
            return _dispatchGridOps([{ op: 'create_table', rows: op.rows || 2, cols: op.cols || 2 }]);
        }

        // Grid-level ops — resolve target sheet, then use the existing channel.
        if (['set_cell', 'add_row', 'delete_row', 'add_column', 'delete_column', 'merge_cells'].indexOf(name) >= 0) {
            _resolveSheet(op);
            var clean = Object.assign({}, op); delete clean.sheet;
            return _dispatchGridOps([clean]);
        }

        switch (name) {
            case 'transpose':
                _resolveSheet(op);
                if (typeof window.transposeTable === 'function') { window.transposeTable(); return { ok: true }; }
                return _notBuilt('transpose');
            case 'transpose_selection':
                if (typeof window.transposeSelection === 'function') { window.transposeSelection(); return { ok: true }; }
                return _notBuilt('transpose_selection');
            case 'copy_clipboard':
                if (typeof window.copySelected === 'function') { window.copySelected(); return { ok: true }; }
                return _notBuilt('copy_clipboard');
            case 'make_tabs': {
                // The real "tabs"/collapsible feature: set the tab count (#buttonIndex)
                // then generateTabs wraps the sheet's table(s) into accordion cards.
                _resolveSheet(op);
                if (typeof window.generateTabs !== 'function') return _notBuilt('make_tabs');
                var count = Math.max(1, Math.min(100, op.count || 1));
                _setField('buttonIndex', count);
                var t = _table();
                var html = t ? t.outerHTML : (document.getElementById('tableContainer') || {}).innerHTML;
                window.generateTabs(html);
                return { ok: true, tabs: count };
            }

            // ── style/class/id (drive the style panel's applyClassId) ────────────
            case 'apply_class':
            case 'apply_id':
            case 'set_style':
            case 'set_spacing':
            case 'set_attribute':
                return _applyStyleOp(name, op);

            // ── node editor ──────────────────────────────────────────────────────
            case 'add_node': {
                if (typeof window.enableNodeEditor === 'function') window.enableNodeEditor();
                var mgr = window.nodeGraphManager;
                var def = window.NodeTypes && window.NodeTypes.get ? window.NodeTypes.get(op.node_type) : null;
                if (!mgr || typeof mgr.addNode !== 'function' || !def) return _notBuilt('add_node');
                var label = op.label || (def.label + ' ' + (Object.keys(mgr.graph ? mgr.graph.nodes : {}).length + 1));
                var id = mgr.addNode(label, 120, 120, [], op.node_type, {});
                return { ok: true, nodeId: id };
            }
            case 'add_sheet_node':
                _resolveSheet(op);
                if (typeof window.addCurrentSheetAsNode === 'function') { window.addCurrentSheetAsNode(); return { ok: true }; }
                return _notBuilt('add_sheet_node');
            case 'connect_nodes': {
                var mgr2 = window.nodeGraphManager;
                if (!mgr2 || typeof mgr2.addWire !== 'function' || !window.NodeGraph) return _notBuilt('connect_nodes');
                var srcId = _resolveNode(op.from), tgtId = _resolveNode(op.to);
                if (!srcId) throw new Error('unknown source node: ' + op.from);
                if (!tgtId) throw new Error('unknown target node: ' + op.to);
                var srcPort = _pickPort(window.NodeGraph.nodes[srcId], 'out');
                var tgtPort = _pickPort(window.NodeGraph.nodes[tgtId], 'in');
                if (!srcPort) throw new Error(op.from + ' has no output port');
                if (!tgtPort) throw new Error(op.to + ' has no input port');
                var wid = mgr2.addWire(srcId, srcPort, tgtId, tgtPort);
                if (!wid) throw new Error('connection rejected (self/duplicate)');
                // Re-render endpoints so the ⚙ config state reflects the new wire.
                if (typeof window.renderNodeDom === 'function') { window.renderNodeDom(srcId); window.renderNodeDom(tgtId); }
                return { ok: true, wireId: wid };
            }
            case 'run_nodes':
                if (window.nodeExecutor && typeof window.nodeExecutor.run === 'function') { window.nodeExecutor.run(); return { ok: true }; }
                return _notBuilt('run_nodes');
            case 'reset_nodes':
                if (window.nodeExecutor && typeof window.nodeExecutor.resetRunState === 'function') { window.nodeExecutor.resetRunState(); return { ok: true }; }
                return _notBuilt('reset_nodes');
            case 'build_table_from_node':
                if (typeof window.buildTableFromSelectedNode === 'function') { window.buildTableFromSelectedNode(); return { ok: true }; }
                return _notBuilt('build_table_from_node');

            default:
                // ── VTA (auto-generated verbs) ────────────────────────────────────
                if (name.indexOf('vta_') === 0) return _applyVtaOp(name, op);
                throw new Error('unknown TAFNE verb: ' + name);
        }
    }

    // Style/class/id/attribute → set the panel's fields, then call applyClassId.
    function _applyStyleOp(name, op) {
        if (typeof window.applyClassId !== 'function') return _notBuilt(name);
        // Map target → the panel's #elementType select values.
        var targetMap = { cell: 'cell', row: 'row', column: 'column', table: 'table' };
        _setField('elementType', targetMap[op.target] || 'cell');
        // Reset the batch fields we might set so a prior op doesn't bleed in.
        ['classInput', 'idInput', 'styleInput', 'cellColor', 'spacingTop', 'spacingRight',
         'spacingBottom', 'spacingLeft', 'attributeValue', 'tableAttribute'].forEach(function (f) {
            var el = document.getElementById(f); if (el && el.tagName === 'INPUT') el.value = '';
        });
        if (name === 'apply_class') _setField('classInput', op.class);
        if (name === 'apply_id') _setField('idInput', op.id);
        if (name === 'set_style') { _setField('styleInput', op.style); _setField('cellColor', op.color); }
        if (name === 'set_spacing') {
            _setField('styleInput', op.style);
            _setField('spacingTop', op.top); _setField('spacingRight', op.right);
            _setField('spacingBottom', op.bottom); _setField('spacingLeft', op.left);
        }
        if (name === 'set_attribute') { _setField('tableAttribute', op.attribute); _setField('attributeValue', op.value); }
        window.applyClassId();
        return { ok: true };
    }

    // VTA → resolve sheet, read grid → rows, call LabFunctions[fn], reload result.
    function _applyVtaOp(name, op) {
        var lf = window.LabFunctions;
        if (!lf) return _notBuilt(name);
        var fnName = name.slice(4);   // strip 'vta_'
        if (typeof lf[fnName] !== 'function') return _notBuilt(name + ' (LabFunctions.' + fnName + ')');
        _resolveSheet(op);
        // Build the LabFunctions param object from the op (drop op/sheet keys).
        var p = {};
        Object.keys(op).forEach(function (k) { if (k !== 'op' && k !== 'name' && k !== 'sheet') p[k] = op[k]; });
        var rows = _gridToRows(_rowsAsGrid());
        var result = lf[fnName](rows, p);
        // Flag/warn functions return {rows, flagged}; transforms/aggregates return
        // rows (or an aggregate object). Reload only when we got a row array back.
        var outRows = Array.isArray(result) ? result : (result && result.rows) || null;
        if (outRows) { _reloadActiveFromRows(outRows, 'VTA · ' + fnName); return { ok: true, rows: outRows.length }; }
        // Aggregates (sumColumn, distribution, …) return a value — surface it.
        return { ok: true, result: result };
    }

    // ── Register ─────────────────────────────────────────────────────────────────
    var allVerbs = VERBS.concat(_buildVtaVerbs());
    window.GxMCP.register('tifany', { engine: 'table', verbs: allVerbs, apply: apply });
    console.log('[TAFNE] GxMCP registered', allVerbs.length, 'verbs (' +
        (allVerbs.length - VERBS.length) + ' VTA auto-generated)');
})();
