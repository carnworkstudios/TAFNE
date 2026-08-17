// ===================================================================================
// PIPELINE EMIT — the node graph as a `gx-pipeline/1` envelope
// ===================================================================================
// TAFNE's node editor holds the evidence for a schema, and until now none of it
// crossed a tool boundary. Sending the COMPUTED ROWS (a `gx-tables` envelope)
// carries the result of a vlookup but not the `{keyPort, refNodeId, refKeyPort}`
// that makes it a foreign key, and not the formula that makes a column derived.
// So the receiving tool had to re-guess, from a column name, a relationship the
// user had already declared here.
//
// This emits the node CONFIGS. The difference it makes is one field:
// a foreign key recovered from `<name>_id` is `inferred: true` at 0.85;
// the same relationship carried across as a vlookup config is `inferred: false`.
// Declared knowledge stops being laundered as a guess.
//
// ── IP boundary ─────────────────────────────────────────────────────────────────
// This file is SHAPE: it walks public tool state (`window.NodeGraph`) into a
// declared envelope, and decides nothing about what any of it means. The
// TRANSLATION — which node becomes an entity, which becomes a constraint, what
// a `lateral` join is refused for — is policy and lives in the private root
// (`assets/schema-editor/domains/software/promote.js`). A fork emitting this
// envelope gets a description of its own graph, which its own UI already shows.
//
// ── What is deliberately not decided here ───────────────────────────────────────
// Column TYPES. The emitter ships column names plus raw sample values and stops.
// Typing a column is inference — the receiver has a declared ladder for it with
// a sample floor and a confidence — and an emitter that guessed `text` would
// hand that ladder a fact it never established, at full confidence. Names are
// what this tool knows; values are what it holds; types are a conclusion.
// ===================================================================================
//
// ── Do not `require()` this file from Node ──────────────────────────────────────
// `tools/table-formatter/package.json` declares "type": "module", so every .js
// in this submodule is ESM. The UMD probe below is therefore FALSE under a Node
// require(): the file exports nothing and require() returns `{}` with no error.
// Load it the way a browser does — evaluate it against a `window` object (see
// `packages/shared/src/table/TableDriver.cjs`). The module.exports branch is
// kept only for a fork that vendors this file into a CommonJS package.

(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.GxPipelineEmit = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    var SCHEMA = 'gx-pipeline/1';

    // How many values per column ride along. The receiver's type ladder wants at
    // least 5 to claim a type at all; 25 is enough for it to reach full
    // confidence without turning a graph description into a data dump.
    var SAMPLE_LIMIT = 25;

    function _cellValue(cellId, store) {
        if (!store || !cellId) return null;
        var c = typeof store.get === 'function' ? store.get(cellId) : null;
        if (c == null) return null;
        if (typeof c === 'object') return c.value != null ? c.value : (c.text != null ? c.text : null);
        return c;
    }

    /**
     * A table node's columns: one per port row, with sample values.
     *
     * `portId` is the id, not the label. The label is what the user reads and
     * can rename; the portId is what wires, `keyPort` and `refKeyPort` are all
     * expressed in. Using the label as the id would break every key reference
     * the moment someone renamed a column — which is the whole reason the
     * config stores portIds in the first place.
     */
    function _columnsOf(node, store) {
        return (node.headers || []).map(function (h) {
            var samples = [];
            (h.cellIds || []).slice(0, SAMPLE_LIMIT).forEach(function (id) {
                var v = _cellValue(id, store);
                if (v != null && String(v).trim() !== '') samples.push(String(v));
            });
            return { id: h.portId, name: h.label, samples: samples };
        });
    }

    /**
     * Terminal disposition: does this node's output get STORED or only shown?
     *
     * It decides whether a filter becomes a CHECK constraint on the stored rows
     * or a WHERE clause in a view — the same node, two different pieces of DDL,
     * and the pipeline does not say which. So the honest emission is the fact
     * this tool actually knows: a node with no outgoing wire is terminal, and
     * whether it was built into a table is recorded by `Build Table`. Anything
     * we cannot observe is emitted as `undeclared`, and the receiver asks
     * rather than guessing — guessing writes a constraint that permanently
     * rejects rows the user only meant to hide in one report.
     */
    function _terminals(nodes, wires) {
        var hasOut = {};
        wires.forEach(function (w) { hasOut[w.from] = true; });
        return nodes.filter(function (n) { return !hasOut[n.id]; }).map(function (n) {
            var built = !!(n.config && (n.config.builtSheetId || n.config.persisted));
            return {
                nodeId: n.id,
                disposition: built ? 'persist' : 'undeclared',
            };
        });
    }

    /**
     * Walk `window.NodeGraph` into a gx-pipeline/1 envelope.
     *
     * @param {object} graph  window.NodeGraph (or a snapshot of it)
     * @param {object} opts   { cellStore, sheetsById, title }
     */
    function emit(graph, opts) {
        opts = opts || {};
        graph = graph || {};
        var store = opts.cellStore || null;
        var rawNodes = Object.values(graph.nodes || {});
        var rawWires = Object.values(graph.wires || {});

        var wires = rawWires.map(function (w) {
            return {
                id: w.id,
                from: w.sourceNodeId,
                to: w.targetNodeId,
                fromPort: w.sourcePortId || null,
                toPort: w.targetPortId || null,
            };
        });

        var nodes = rawNodes.map(function (n) {
            var type = n.nodeType || 'table';
            var config = Object.assign({}, n.config || {});
            // The node's own label is its name unless the config overrides it —
            // a table node's label IS the entity name a user would expect.
            if (!config.name) config.name = n.label || n.id;
            if (type === 'table' || type === 'api') {
                config.columns = _columnsOf(n, store);
            }
            var out = { id: n.id, type: type, config: config };
            // A node built from a sheet carries the address back to it. This is
            // what lets an edit made downstream in the Schema Editor point at
            // the sheet and cell it came from instead of at "this diagram".
            if (n.sourceSheetId) {
                out.origin = {
                    tool: 'tifany',
                    doc: opts.title || 'TAFNE',
                    sheetId: n.sourceSheetId,
                    nodeId: n.id,
                };
            }
            return out;
        });

        return {
            schema: SCHEMA,
            meta: { source: 'tifany', title: opts.title || 'TAFNE pipeline' },
            nodes: nodes,
            wires: wires,
            terminals: _terminals(nodes, wires),
        };
    }

    /**
     * Structural validation. Never throws — same rule as `GxTables.validate` and
     * `GxScene.validate`: a malformed envelope from one tool must not crash the
     * receiver, it must be refused with a reason.
     */
    function validate(env) {
        var errs = [];
        if (!env || typeof env !== 'object') return ['envelope is not an object'];
        if (env.schema !== SCHEMA) errs.push('schema must be "' + SCHEMA + '"');
        if (!Array.isArray(env.nodes)) errs.push('nodes must be an array');
        if (!Array.isArray(env.wires)) errs.push('wires must be an array');
        if (errs.length) return errs;
        if (!env.nodes.length) errs.push('envelope carries no nodes');

        var ids = {};
        env.nodes.forEach(function (n, i) {
            if (!n || !n.id) { errs.push('node[' + i + '] has no id'); return; }
            if (ids[n.id]) errs.push('duplicate node id "' + n.id + '"');
            ids[n.id] = true;
            if (!n.type) errs.push('node "' + n.id + '" has no type');
        });
        // A wire to a node that is not in the envelope is the failure mode that
        // matters: the receiver resolves relationships by node id, and a
        // dangling end silently produces no relation rather than an error.
        env.wires.forEach(function (w, i) {
            if (!w || !w.from || !w.to) { errs.push('wire[' + i + '] is missing an end'); return; }
            if (!ids[w.from]) errs.push('wire[' + i + '] starts at unknown node "' + w.from + '"');
            if (!ids[w.to]) errs.push('wire[' + i + '] ends at unknown node "' + w.to + '"');
        });
        return errs;
    }

    return { SCHEMA: SCHEMA, emit: emit, validate: validate, SAMPLE_LIMIT: SAMPLE_LIMIT };
});
