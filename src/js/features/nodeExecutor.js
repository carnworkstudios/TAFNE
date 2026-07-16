// ===================================================================================
// NODE EXECUTOR; Topological sort + execution loop
//   1. Kahn's algorithm — detects cycles, returns ordered node list
//   2. async run() — processes each operator node in order, writes output to CellStore
//   3. Handlers: filter, vlookup, formula, api
// ===================================================================================

window.nodeExecutor = (function () {

    // ── Topological sort (Kahn's algorithm) ────────────────────────────────────

    function _topoSort(nodes, wires) {
        // Build adjacency + in-degree
        const ids      = Object.keys(nodes);
        const inDeg    = {};
        const adjOut   = {};   // nodeId → [nodeId, ...]

        ids.forEach(id => { inDeg[id] = 0; adjOut[id] = []; });

        Object.values(wires).forEach(w => {
            if (!nodes[w.sourceNodeId] || !nodes[w.targetNodeId]) return;
            adjOut[w.sourceNodeId].push(w.targetNodeId);
            inDeg[w.targetNodeId]++;
        });

        // Queue: nodes with no incoming edges
        const queue   = ids.filter(id => inDeg[id] === 0);
        const ordered = [];

        while (queue.length) {
            const cur = queue.shift();
            ordered.push(cur);
            adjOut[cur].forEach(next => {
                inDeg[next]--;
                if (inDeg[next] === 0) queue.push(next);
            });
        }

        const cycleNodes = ids.filter(id => !ordered.includes(id));
        return { ordered, cycleNodes };
    }

    // ── Input map builder ─────────────────────────────────────────────────────
    //
    //   inputMap: { sourcePortId → { label, values: string[], sourceNodeId } }
    //
    //   For every wire pointing at nodeId, we walk the ENTIRE source node's
    //   output headers — not just the wired column. This means wiring ANY
    //   column from Table A to an operator gives the operator all of Table A's
    //   columns. Keying by source portId means cfg.column / cfg.keyPort etc.
    //   can reference source columns directly.

    function _buildInputMap(nodeId) {
        const csm      = window.cellStoreManager;
        const inputMap = {};
        const seen     = new Set();

        Object.values(window.NodeGraph.wires).forEach(w => {
            if (w.targetNodeId !== nodeId) return;
            if (seen.has(w.sourceNodeId)) return;
            seen.add(w.sourceNodeId);

            const srcNode = window.NodeGraph.nodes[w.sourceNodeId];
            if (!srcNode) return;

            srcNode.headers
                .filter(h => h.direction !== 'in')
                .forEach(h => {
                    // Columnar path: operator output stored as h.values (no CellStore lookup)
                    // CellStore path: source/table node data stored via h.cellIds
                    const values = h.values
                        ? h.values
                        : (h.cellIds || []).map(id => {
                            const cell = csm.get(id);
                            return cell ? cell.value : '';
                        });
                    inputMap[h.portId] = { label: h.label, values, sourceNodeId: w.sourceNodeId };
                });
        });

        return inputMap;
    }

    // ── Write output back to a node ───────────────────────────────────────────
    //
    //   outputCols: [{ label, values: string[], direction: 'out' }]

    function _writeOutput(node, outputCols) {
        const csm = window.cellStoreManager;

        // Drop columns the user deselected in the config panel's schema preview
        const excluded = new Set(node.config?.excludedCols || []);
        if (excluded.size) outputCols = outputCols.filter(c => !excluded.has(c.label));

        // Release any old CellStore refs (only source/table headers use cellIds)
        node.headers.forEach(h => {
            if (h.cellIds && h.cellIds.length > 0) {
                h.cellIds.forEach(id => csm.release(id));
            }
        });

        // Write operator output as columnar string arrays — zero CellStore allocation
        node.headers = outputCols.map(col => ({
            portId:    'port-' + crypto.randomUUID().slice(0, 8),
            label:     col.label,
            values:    col.values.map(v => String(v)),  // plain array, no CellStore
            cellIds:   [],                               // kept for structural compat
            direction: col.direction || 'out'
        }));
    }

    // ── Handlers ──────────────────────────────────────────────────────────────

    // filter — keep rows matching (config.column, config.operator, config.value)
    function _handleFilter(node, inputMap) {
        const cfg = node.config || {};
        if (!cfg.column || !inputMap[cfg.column]) {
            throw new Error('Filter: no column selected or no input connected');
        }

        const masterCol = inputMap[cfg.column];
        const allPorts  = Object.keys(inputMap);
        const numRows   = masterCol.values.length;
        const keepIdx   = [];

        for (let r = 0; r < numRows; r++) {
            if (_testRow(masterCol.values[r], cfg.operator, cfg.value)) {
                keepIdx.push(r);
            }
        }

        const outputCols = allPorts.map(portId => {
            const col = inputMap[portId];
            return { label: col.label, values: keepIdx.map(i => col.values[i] || ''), direction: 'out' };
        });

        _writeOutput(node, outputCols);
    }

    function _testRow(val, op, cmp) {
        const vf = parseFloat(val), cf = parseFloat(cmp);
        const numOk = !isNaN(vf) && !isNaN(cf);
        switch (op) {
            case 'eq':       return numOk ? vf === cf : String(val) === String(cmp);
            case 'ne':       return numOk ? vf !== cf : String(val) !== String(cmp);
            case 'gt':       return numOk ? vf > cf : String(val) > String(cmp);
            case 'lt':       return numOk ? vf < cf : String(val) < String(cmp);
            case 'gte':      return numOk ? vf >= cf : String(val) >= String(cmp);
            case 'lte':      return numOk ? vf <= cf : String(val) <= String(cmp);
            case 'contains': return String(val).includes(String(cmp));
            case 'regex':    try { return new RegExp(cmp).test(val); } catch (_) { return false; }
            default:         return true;
        }
    }

    // vlookup — enrich with a column from a reference node by matching keys
    function _handleVlookup(node, inputMap) {
        const cfg = node.config || {};
        if (!cfg.keyPort || !cfg.refNodeId || !cfg.refKeyPort || !cfg.refValuePort) {
            throw new Error('VLookup: incomplete configuration');
        }

        const keyCol = inputMap[cfg.keyPort];
        if (!keyCol) throw new Error('VLookup: key column not connected');

        const refNode     = window.NodeGraph.nodes[cfg.refNodeId];
        if (!refNode) throw new Error('VLookup: reference node not found');

        const csm         = window.cellStoreManager;
        const refKeyHeader = refNode.headers.find(h => h.portId === cfg.refKeyPort);
        const refValHeader = refNode.headers.find(h => h.portId === cfg.refValuePort);
        if (!refKeyHeader || !refValHeader) throw new Error('VLookup: reference columns not found');

        // Columnar path (reference node is an operator output) or CellStore path (table node)
        const _headerVals = h => h.values
            ? h.values
            : (h.cellIds || []).map(id => { const c = csm.get(id); return c ? c.value : ''; });
        const refKeys   = _headerVals(refKeyHeader);
        const refValues = _headerVals(refValHeader);

        // Build lookup map
        const lookupMap = {};
        refKeys.forEach((k, i) => { lookupMap[k] = refValues[i]; });

        // Pass through all input columns + add the looked-up column
        const outputCols = Object.entries(inputMap).map(([, col]) => ({
            label: col.label, values: col.values, direction: 'out'
        }));
        outputCols.push({
            label:     cfg.outputLabel || 'Lookup Result',
            values:    keyCol.values.map(k => lookupMap[k] !== undefined ? lookupMap[k] : ''),
            direction: 'out'
        });

        _writeOutput(node, outputCols);
    }

    // formula — add a computed column per row
    function _handleFormula(node, inputMap) {
        const cfg = node.config || {};
        if (!cfg.expression) throw new Error('Formula: no expression configured');

        const numRows    = Math.max(...Object.values(inputMap).map(c => c.values.length), 0);
        const outputVals = [];

        for (let r = 0; r < numRows; r++) {
            const rowCtx = {};
            Object.values(inputMap).forEach(col => {
                rowCtx['$' + col.label] = col.values[r] || '';
            });
            outputVals.push(window.nodeFormulaParser.evaluate(cfg.expression, rowCtx));
        }

        // Pass through all input columns + add the computed column
        const outputCols = Object.entries(inputMap).map(([, col]) => ({
            label: col.label, values: col.values, direction: 'out'
        }));
        outputCols.push({
            label:     cfg.outputLabel || 'Result',
            values:    outputVals,
            direction: 'out'
        });

        _writeOutput(node, outputCols);
    }

    // join — combine two source tables in various ways
    function _handleJoin(node) {
        const cfg = node.config || {};
        const mode = cfg.mode || 'stack';

        // Resolve both source tables from the fixed structural ports
        const leftData  = _getJoinSideData(node, 'join-in-left');
        const rightData = _getJoinSideData(node, 'join-in-right');

        if (!leftData && !rightData) {
            throw new Error('Join: connect at least one table');
        }

        // Modes that don't need a key
        if (mode === 'stack') {
            _writeJoinOutput(node, _joinStack(leftData, rightData));
            return;
        }
        if (mode === 'lateral') {
            _writeJoinOutput(node, _joinLateral(leftData, rightData));
            return;
        }

        // Key-based modes
        if (!leftData)  throw new Error('Join: Left Table not connected');
        if (!rightData) throw new Error('Join: Right Table not connected');
        if (!cfg.leftKey)  throw new Error('Join: Left key column not configured');
        if (!cfg.rightKey) throw new Error('Join: Right key column not configured');

        const leftKeyCol  = leftData.find(c => c.portId === cfg.leftKey);
        const rightKeyCol = rightData.find(c => c.portId === cfg.rightKey);

        if (!leftKeyCol)  throw new Error('Join: Left key column not found in source');
        if (!rightKeyCol) throw new Error('Join: Right key column not found in source');

        switch (mode) {
            case 'inner': _writeJoinOutput(node, _joinInner(leftData, rightData, leftKeyCol, rightKeyCol)); break;
            case 'left':  _writeJoinOutput(node, _joinLeft (leftData, rightData, leftKeyCol, rightKeyCol)); break;
            case 'right': _writeJoinOutput(node, _joinRight(leftData, rightData, leftKeyCol, rightKeyCol)); break;
            case 'outer': _writeJoinOutput(node, _joinOuter(leftData, rightData, leftKeyCol, rightKeyCol)); break;
            default: throw new Error('Join: unknown mode ' + mode);
        }
    }

    // Get all columns from the source node wired to a fixed port (join-in-left or join-in-right)
    function _getJoinSideData(node, fixedPortId) {
        const csm  = window.cellStoreManager;
        const wire = Object.values(window.NodeGraph.wires).find(
            w => w.targetNodeId === node.id && w.targetPortId === fixedPortId
        );
        if (!wire) return null;
        const src = window.NodeGraph.nodes[wire.sourceNodeId];
        if (!src) return null;
        return src.headers
            .filter(h => h.direction !== 'in')
            .map(h => ({
                portId: h.portId,
                label:  h.label,
                // Columnar path: operator outputs; CellStore path: source table headers
                values: h.values
                    ? h.values
                    : (h.cellIds || []).map(id => { const c = csm.get(id); return c ? c.value : ''; })
            }));
    }

    // ── Join mode implementations ──────────────────────────────────────────────

    // Stack: append all rows, columns matched by name — mismatched columns get blanks
    function _joinStack(left, right) {
        left  = left  || [];
        right = right || [];
        const allLabels = [...new Set([...left.map(c => c.label), ...right.map(c => c.label)])];
        return allLabels.map(label => {
            const lCol = left.find(c => c.label === label);
            const rCol = right.find(c => c.label === label);
            return {
                label,
                values: [...(lCol ? lCol.values : Array(left[0]?.values.length || 0).fill('')),
                         ...(rCol ? rCol.values : Array(right[0]?.values.length || 0).fill(''))]
            };
        });
    }

    // Lateral: put Right columns alongside Left columns, aligned by row index
    function _joinLateral(left, right) {
        left  = left  || [];
        right = right || [];
        const lLen = left[0]?.values.length  || 0;
        const rLen = right[0]?.values.length || 0;
        const maxRows = Math.max(lLen, rLen);
        const _pad = (col, len) => ({ ...col, values: col.values.concat(Array(len - col.values.length).fill('')) });
        return [
            ...left.map(c  => _pad(c, maxRows)),
            ...right.map(c => _pad(c, maxRows))
        ];
    }

    // Inner: only rows where leftKey == rightKey
    function _joinInner(left, right, leftKeyCol, rightKeyCol) {
        const rightIdx = _buildIndex(rightKeyCol.values);
        const outputCols = _initOutputCols(left, right);
        leftKeyCol.values.forEach((lKey, lRow) => {
            const rRows = rightIdx[lKey];
            if (!rRows) return;
            rRows.forEach(rRow => _appendRow(outputCols, left, right, lRow, rRow));
        });
        return outputCols;
    }

    // Left: all Left rows, Right columns blank where no match
    function _joinLeft(left, right, leftKeyCol, rightKeyCol) {
        const rightIdx   = _buildIndex(rightKeyCol.values);
        const outputCols = _initOutputCols(left, right);
        leftKeyCol.values.forEach((lKey, lRow) => {
            const rRows = rightIdx[lKey];
            if (rRows) rRows.forEach(rRow => _appendRow(outputCols, left, right, lRow, rRow));
            else       _appendRow(outputCols, left, right, lRow, null);
        });
        return outputCols;
    }

    // Right: all Right rows, Left columns blank where no match
    function _joinRight(left, right, leftKeyCol, rightKeyCol) {
        const leftIdx    = _buildIndex(leftKeyCol.values);
        const outputCols = _initOutputCols(left, right);
        rightKeyCol.values.forEach((rKey, rRow) => {
            const lRows = leftIdx[rKey];
            if (lRows) lRows.forEach(lRow => _appendRow(outputCols, left, right, lRow, rRow));
            else       _appendRow(outputCols, left, right, null, rRow);
        });
        return outputCols;
    }

    // Full Outer: all rows from both, blanks on whichever side has no match
    function _joinOuter(left, right, leftKeyCol, rightKeyCol) {
        const rightIdx      = _buildIndex(rightKeyCol.values);
        const matchedRRight = new Set();
        const outputCols    = _initOutputCols(left, right);

        leftKeyCol.values.forEach((lKey, lRow) => {
            const rRows = rightIdx[lKey];
            if (rRows) {
                rRows.forEach(rRow => { _appendRow(outputCols, left, right, lRow, rRow); matchedRRight.add(rRow); });
            } else {
                _appendRow(outputCols, left, right, lRow, null);
            }
        });
        // Right rows with no Left match
        rightKeyCol.values.forEach((_, rRow) => {
            if (!matchedRRight.has(rRow)) _appendRow(outputCols, left, right, null, rRow);
        });
        return outputCols;
    }

    // Build value → [rowIndex, ...] index from a column's values array
    function _buildIndex(values) {
        const idx = {};
        values.forEach((v, i) => { if (!idx[v]) idx[v] = []; idx[v].push(i); });
        return idx;
    }

    // Create output column stubs — all Left columns then all Right columns
    // Right columns are prefixed if a same-named column exists in Left (avoids clobbering)
    function _initOutputCols(left, right) {
        const leftLabels = new Set((left || []).map(c => c.label));
        const out = [
            ...(left  || []).map(c => ({ label: c.label, values: [] })),
            ...(right || []).map(c => ({ label: leftLabels.has(c.label) ? c.label + ' (right)' : c.label, values: [] }))
        ];
        return out;
    }

    // Append one merged row — lRow or rRow can be null (means blank that side)
    function _appendRow(outputCols, left, right, lRow, rRow) {
        const lLen = (left  || []).length;
        left = left || [];
        right = right || [];
        outputCols.forEach((col, colIdx) => {
            if (colIdx < lLen) {
                col.values.push(lRow !== null ? (left[colIdx].values[lRow]  ?? '') : '');
            } else {
                const rColIdx = colIdx - lLen;
                col.values.push(rRow !== null ? (right[rColIdx].values[rRow] ?? '') : '');
            }
        });
    }

    // Write join output — keeps structural 'in' ports, replaces previous 'out' columns
    function _writeJoinOutput(node, outputCols) {
        const csm = window.cellStoreManager;

        // Drop columns the user deselected in the config panel's schema preview
        const excluded = new Set(node.config?.excludedCols || []);
        if (excluded.size) outputCols = outputCols.filter(c => !excluded.has(c.label));
        // Release any previous output-only CellStore refs
        node.headers
            .filter(h => h.direction === 'out')
            .forEach(h => { if (h.cellIds && h.cellIds.length > 0) h.cellIds.forEach(id => csm.release(id)); });
        // Keep only structural 'in' ports
        node.headers = node.headers.filter(h => h.direction === 'in');
        // Append new output columns as columnar arrays — zero CellStore allocation
        outputCols.forEach(col => {
            node.headers.push({
                portId:    'port-' + crypto.randomUUID().slice(0, 8),
                label:     col.label,
                values:    col.values.map(v => String(v)),  // plain array, no CellStore
                cellIds:   [],
                direction: 'out'
            });
        });
    }

    // api — fetch JSON, traverse jsonPath, expose fields as output columns
    async function _handleApi(node) {
        const cfg = node.config || {};
        if (!cfg.url) throw new Error('API: no URL configured');

        let headersObj = {};
        if (cfg.headers && typeof cfg.headers === 'object') headersObj = cfg.headers;

        let response;
        try {
            response = await fetch(cfg.url, {
                method:  cfg.method || 'GET',
                headers: headersObj
            });
        } catch (networkErr) {
            // Network error, CORS block, or DNS failure
            throw new Error(`API: Network error — ${networkErr.message}. Check the URL and that the server allows cross-origin requests (CORS).`);
        }

        if (!response.ok) throw new Error(`API: HTTP ${response.status} ${response.statusText}`);

        let data;
        try {
            data = await response.json();
        } catch (_) {
            throw new Error('API: Response is not valid JSON');
        }

        // Traverse jsonPath (e.g. 'data.items')
        if (cfg.jsonPath) {
            const parts = cfg.jsonPath.split('.');
            for (const part of parts) {
                if (data == null || typeof data !== 'object') break;
                data = data[part];
            }
        }

        // Normalise to array of objects
        if (!Array.isArray(data)) {
            data = typeof data === 'object' && data !== null ? [data] : [];
        }

        if (data.length === 0) {
            _writeOutput(node, []);
            return;
        }

        // Collect all unique keys across all rows
        const keys = [];
        data.forEach(row => {
            if (typeof row !== 'object' || row === null) return;
            Object.keys(row).forEach(k => { if (!keys.includes(k)) keys.push(k); });
        });

        const outputCols = keys.map(k => ({
            label:     k,
            values:    data.map(row => (row && row[k] !== undefined) ? String(row[k]) : ''),
            direction: 'out'
        }));

        _writeOutput(node, outputCols);
    }

    // ── Run ───────────────────────────────────────────────────────────────────

    async function run() {
        const nodes = window.NodeGraph.nodes;
        const wires = window.NodeGraph.wires;

        // Mark all operator nodes as 'running' and flush a repaint before heavy work
        Object.values(nodes).forEach(n => {
            if (window.NodeTypes.isOperator(n.nodeType)) {
                n.execState = 'running';
                n.execError = null;
                if (typeof renderNodeDom === 'function') renderNodeDom(n.id);
            }
        });
        window.nodeCanvasRenderer.markStaticDirty();

        // Yield once so the browser can paint the 'running' badges before we block
        await new Promise(r => setTimeout(r, 0));

        let doneCount  = 0;
        let errorCount = 0;

        try {
            const { ordered, cycleNodes } = _topoSort(nodes, wires);

            // Mark cycle nodes immediately
            cycleNodes.forEach(id => {
                const n = nodes[id];
                if (!n) return;
                n.execState = 'error';
                n.execError = 'Cycle detected';
                if (typeof renderNodeDom === 'function') renderNodeDom(n.id);
            });
            errorCount += cycleNodes.length;

            // ── Yielded execution loop ─────────────────────────────────────────
            // Between each operator node we yield (setTimeout 0) so the browser
            // event loop can repaint, handle input, and avoid "frozen" appearance.
            for (const nodeId of ordered) {
                const node = nodes[nodeId];
                if (!node) continue;
                if (!window.NodeTypes.isOperator(node.nodeType)) continue;

                try {
                    const inputMap = _buildInputMap(nodeId);
                    switch (node.nodeType) {
                        case 'filter':  _handleFilter(node, inputMap);  break;
                        case 'vlookup': _handleVlookup(node, inputMap); break;
                        case 'formula': _handleFormula(node, inputMap); break;
                        case 'api':     await _handleApi(node);         break;
                        case 'join':    _handleJoin(node);              break;
                        default: break;
                    }
                    node.execState = 'done';
                    doneCount++;
                } catch (err) {
                    node.execState = 'error';
                    node.execError = err.message || 'Unknown error';
                    errorCount++;
                }

                // Re-render this node's card to show done/error badge…
                if (typeof renderNodeDom === 'function') renderNodeDom(nodeId);
                // …then yield to the browser so the repaint actually happens
                await new Promise(r => setTimeout(r, 0));
            }
        } catch (fatalErr) {
            Object.values(nodes).forEach(n => {
                if (n.execState === 'running') {
                    n.execState = 'error';
                    n.execError = 'Run aborted: ' + (fatalErr.message || 'Unknown error');
                    if (typeof renderNodeDom === 'function') renderNodeDom(n.id);
                    errorCount++;
                }
            });
        }

        // Single canvas redraw + state save after the whole loop
        window.nodeCanvasRenderer.markStaticDirty();
        if (typeof window.saveNodeEditorState === 'function') window.saveNodeEditorState();

        const summary = errorCount > 0
            ? `Run complete: ${doneCount} succeeded, ${errorCount} failed`
            : `Run complete: ${doneCount} node${doneCount !== 1 ? 's' : ''} processed`;

        $.toast({
            heading: 'Node Editor',
            text:    summary,
            icon:    errorCount > 0 ? 'warning' : 'success',
            loader:  false, stack: false
        });
    }

    // Reset all exec states back to idle (use after a failed/stuck run)
    function resetRunState() {
        Object.values(window.NodeGraph.nodes).forEach(n => {
            n.execState = 'idle';
            n.execError = null;
            if (typeof renderNodeDom === 'function') renderNodeDom(n.id);
        });
        window.nodeCanvasRenderer.markStaticDirty();
        $.toast({ heading: 'Node Editor', text: 'Run state reset', icon: 'info', loader: false, stack: false, hideAfter: 1500 });
    }

    return { run, resetRunState };
})();
