// ===================================================================================
// LAB MODE — Pre-defined Function Library
// ===================================================================================
// 26 pure functions: receive (rows, params), return a result.
// No globals, no DOM, no network. Safe to call on the main thread.
// ===================================================================================

window.LabFunctions = {

    // ─── VALIDATE ─────────────────────────────────────────────────────────────────
    // Each returns flags[] — [{ rowIndex, message, level: 'error'|'warn' }]

    /**
     * Flag rows where the named column is empty or whitespace-only.
     */
    flagEmpty: function (rows, p) {
        var col = p.column;
        return rows.reduce(function (flags, row, i) {
            var v = row[col];
            if (v === undefined || v === null || String(v).trim() === '') {
                flags.push({ rowIndex: i, message: '"' + col + '" is empty', level: 'error' });
            }
            return flags;
        }, []);
    },

    /**
     * Flag rows where the column value is not unique across the dataset.
     */
    flagDuplicate: function (rows, p) {
        var col = p.column;
        var seen = Object.create(null);
        var dupes = Object.create(null);
        rows.forEach(function (row) {
            var v = String(row[col] != null ? row[col] : '');
            if (seen[v]) { dupes[v] = true; } else { seen[v] = true; }
        });
        return rows.reduce(function (flags, row, i) {
            var v = String(row[col] != null ? row[col] : '');
            if (dupes[v]) {
                flags.push({ rowIndex: i, message: 'Duplicate in "' + col + '": ' + row[col], level: 'error' });
            }
            return flags;
        }, []);
    },

    /**
     * Flag rows where the numeric column value falls outside [min, max].
     */
    flagOutOfRange: function (rows, p) {
        var col = p.column;
        var min = p.min !== '' && p.min != null ? parseFloat(p.min) : null;
        var max = p.max !== '' && p.max != null ? parseFloat(p.max) : null;
        return rows.reduce(function (flags, row, i) {
            var v = parseFloat(row[col]);
            if (!isNaN(v)) {
                var outLow  = min !== null && v < min;
                var outHigh = max !== null && v > max;
                if (outLow || outHigh) {
                    var range = '[' + (min !== null ? min : '−∞') + ', ' + (max !== null ? max : '+∞') + ']';
                    flags.push({ rowIndex: i, message: '"' + col + '" value ' + v + ' is outside ' + range, level: 'error' });
                }
            }
            return flags;
        }, []);
    },

    /**
     * Flag rows where the column doesn't match the selected pattern.
     * Patterns are chosen from a fixed list — no user-supplied regex.
     */
    flagPattern: function (rows, p) {
        var col     = p.column;
        var pattern = p.pattern;
        var term    = p.term || '';

        var PATTERNS = {
            'whole-number':   /^\d+$/,
            'decimal-number': /^\d+(\.\d+)?$/,
            'ref-designator': /^[A-Z]+\d+$/,
            'email':          /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
            'iso-date':       /^\d{4}-\d{2}-\d{2}$/,
            'non-empty':      /\S+/,
            'uppercase':      /^[A-Z\s]+$/
        };

        return rows.reduce(function (flags, row, i) {
            var v = String(row[col] != null ? row[col] : '');
            var pass;
            if (pattern === 'custom') {
                pass = term === '' || v.includes(term);
            } else if (PATTERNS[pattern]) {
                pass = PATTERNS[pattern].test(v);
            } else {
                pass = true; // unknown pattern — skip silently
            }
            if (!pass) {
                flags.push({ rowIndex: i, message: '"' + col + '" doesn\'t match "' + pattern + '": ' + v, level: 'error' });
            }
            return flags;
        }, []);
    },

    /**
     * Flag rows where colA operator colB fails (e.g. Total should equal Qty × Price).
     */
    flagCrossColumn: function (rows, p) {
        var colA = p.colA;
        var op   = p.operator;
        var colB = p.colB;
        return rows.reduce(function (flags, row, i) {
            var a = parseFloat(row[colA]);
            var b = parseFloat(row[colB]);
            if (isNaN(a) || isNaN(b)) return flags;
            var pass = false;
            if (op === '=')  pass = a === b;
            if (op === '≠')  pass = a !== b;
            if (op === '>')  pass = a > b;
            if (op === '<')  pass = a < b;
            if (op === '≥')  pass = a >= b;
            if (op === '≤')  pass = a <= b;
            if (!pass) {
                flags.push({ rowIndex: i, message: '"' + colA + '" ' + op + ' "' + colB + '" failed (' + a + ' vs ' + b + ')', level: 'error' });
            }
            return flags;
        }, []);
    },

    /**
     * Flag rows where ANY of the listed columns is empty.
     */
    flagMissingAny: function (rows, p) {
        var cols = Array.isArray(p.columns)
            ? p.columns
            : String(p.columns || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        return rows.reduce(function (flags, row, i) {
            var missing = cols.filter(function (c) {
                var v = row[c];
                return v === undefined || v === null || String(v).trim() === '';
            });
            if (missing.length) {
                flags.push({ rowIndex: i, message: 'Missing required: ' + missing.join(', '), level: 'error' });
            }
            return flags;
        }, []);
    },

    /**
     * Warning-level duplicate check (yellow, not red).
     */
    warnDuplicate: function (rows, p) {
        var col = p.column;
        var seen = Object.create(null);
        var dupes = Object.create(null);
        rows.forEach(function (row) {
            var v = String(row[col] != null ? row[col] : '');
            if (seen[v]) { dupes[v] = true; } else { seen[v] = true; }
        });
        return rows.reduce(function (flags, row, i) {
            var v = String(row[col] != null ? row[col] : '');
            if (dupes[v]) {
                flags.push({ rowIndex: i, message: 'Possible duplicate in "' + col + '": ' + row[col], level: 'warn' });
            }
            return flags;
        }, []);
    },

    /**
     * Warning-level range check.
     */
    warnOutOfRange: function (rows, p) {
        var col = p.column;
        var min = p.min !== '' && p.min != null ? parseFloat(p.min) : null;
        var max = p.max !== '' && p.max != null ? parseFloat(p.max) : null;
        return rows.reduce(function (flags, row, i) {
            var v = parseFloat(row[col]);
            if (!isNaN(v)) {
                if ((min !== null && v < min) || (max !== null && v > max)) {
                    flags.push({ rowIndex: i, message: '"' + col + '" value ' + v + ' may be outside expected range', level: 'warn' });
                }
            }
            return flags;
        }, []);
    },


    // ─── TRANSFORM ────────────────────────────────────────────────────────────────
    // Each returns rows[] — a NEW array (source rows never mutated).

    /**
     * Keep only rows matching the condition.
     * Operators: = ≠ > < ≥ ≤ contains starts-with ends-with is-empty is-not-empty
     */
    filterRows: function (rows, p) {
        var col = p.column;
        var op  = p.operator;
        var val = String(p.value != null ? p.value : '');
        var num = parseFloat(val);
        return rows.filter(function (row) {
            var v  = row[col];
            var s  = String(v != null ? v : '');
            var n  = parseFloat(v);
            if (op === '=')             return s === val;
            if (op === '≠')             return s !== val;
            if (op === '>')             return !isNaN(n) && n > num;
            if (op === '<')             return !isNaN(n) && n < num;
            if (op === '≥')             return !isNaN(n) && n >= num;
            if (op === '≤')             return !isNaN(n) && n <= num;
            if (op === 'contains')      return s.includes(val);
            if (op === 'starts-with')   return s.startsWith(val);
            if (op === 'ends-with')     return s.endsWith(val);
            if (op === 'is-empty')      return s.trim() === '';
            if (op === 'is-not-empty')  return s.trim() !== '';
            return true;
        });
    },

    /**
     * Add a computed column using a structured expression type.
     * exprType: 'multiply' | 'divide' | 'add' | 'subtract' |
     *           'multiply-const' | 'concat' | 'conditional' | 'fixed'
     */
    addColumn: function (rows, p) {
        var name = p.name || 'NewColumn';
        var type = p.exprType;
        return rows.map(function (row) {
            var r  = Object.assign({}, row);
            var a  = parseFloat(row[p.colA]);
            var b  = parseFloat(row[p.colB]);
            var v;
            if      (type === 'multiply')      v = (!isNaN(a) && !isNaN(b)) ? a * b : '';
            else if (type === 'divide')        v = (!isNaN(a) && !isNaN(b) && b !== 0) ? a / b : '';
            else if (type === 'add')           v = (!isNaN(a) && !isNaN(b)) ? a + b : '';
            else if (type === 'subtract')      v = (!isNaN(a) && !isNaN(b)) ? a - b : '';
            else if (type === 'multiply-const') {
                var f = parseFloat(p.factor);
                v = !isNaN(a) ? a * f : '';
            }
            else if (type === 'concat') {
                var sep = p.separator != null ? p.separator : '';
                v = String(row[p.colA] != null ? row[p.colA] : '') + sep + String(row[p.colB] != null ? row[p.colB] : '');
            }
            else if (type === 'conditional') {
                var cv   = row[p.condCol];
                var cn   = parseFloat(cv);
                var co   = parseFloat(p.condVal);
                var test = false;
                var cop  = p.condOp;
                if (cop === '=')  test = String(cv) === String(p.condVal);
                if (cop === '≠')  test = String(cv) !== String(p.condVal);
                if (cop === '>')  test = !isNaN(cn) && cn > co;
                if (cop === '<')  test = !isNaN(cn) && cn < co;
                if (cop === '≥')  test = !isNaN(cn) && cn >= co;
                if (cop === '≤')  test = !isNaN(cn) && cn <= co;
                v = test ? p.thenVal : p.elseVal;
            }
            else if (type === 'fixed')         v = p.literal != null ? p.literal : '';
            else                               v = '';
            r[name] = v;
            return r;
        });
    },

    /**
     * Drop one or more columns. Accepts array or comma-separated string.
     */
    removeColumns: function (rows, p) {
        var cols = Array.isArray(p.columns)
            ? p.columns
            : String(p.columns || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        return rows.map(function (row) {
            var r = Object.assign({}, row);
            cols.forEach(function (c) { delete r[c]; });
            return r;
        });
    },

    /**
     * Rename a column header, preserving column order.
     */
    renameColumn: function (rows, p) {
        var from = p.from;
        var to   = p.to;
        return rows.map(function (row) {
            var r = {};
            Object.keys(row).forEach(function (k) {
                r[k === from ? to : k] = row[k];
            });
            return r;
        });
    },

    /**
     * Sort rows ascending or descending by a column.
     * Numeric values sort numerically; strings sort lexicographically.
     */
    sortBy: function (rows, p) {
        var col = p.column;
        var dir = p.direction === 'desc' ? -1 : 1;
        return rows.slice().sort(function (a, b) {
            var av = a[col];
            var bv = b[col];
            var an = parseFloat(av);
            var bn = parseFloat(bv);
            if (!isNaN(an) && !isNaN(bn)) return (an - bn) * dir;
            return String(av != null ? av : '').localeCompare(String(bv != null ? bv : '')) * dir;
        });
    },

    /**
     * Consolidate duplicate rows by a key column.
     * rules: { columnName: 'sum'|'first'|'last'|'count'|'unique'|'join(sep)' }
     * Primary BOM function: mergeBy('Value', { Qty: 'sum', Price: 'first' })
     */
    mergeBy: function (rows, p) {
        var key   = p.keyColumn;
        var rules = p.rules || {};
        var groups = Object.create(null);
        var order  = [];
        rows.forEach(function (row) {
            var k = String(row[key] != null ? row[key] : '');
            if (!groups[k]) { groups[k] = []; order.push(k); }
            groups[k].push(row);
        });
        return order.map(function (k) {
            var g      = groups[k];
            var merged = Object.assign({}, g[0]);
            Object.keys(rules).forEach(function (col) {
                var rule = rules[col];
                var vals = g.map(function (r) { return r[col]; });
                if (rule === 'sum') {
                    merged[col] = vals.reduce(function (s, v) { return s + (parseFloat(v) || 0); }, 0);
                } else if (rule === 'first') {
                    merged[col] = vals[0];
                } else if (rule === 'last') {
                    merged[col] = vals[vals.length - 1];
                } else if (rule === 'count') {
                    merged[col] = g.length;
                } else if (rule === 'unique') {
                    merged[col] = vals.filter(function (v, i, a) {
                        return a.indexOf(v) === i;
                    }).map(String).join(', ');
                } else if (String(rule).indexOf('join(') === 0) {
                    var sep = String(rule).slice(5, -1);
                    merged[col] = vals.map(String).join(sep);
                }
            });
            return merged;
        });
    },

    /**
     * Multiply all numeric values in a column by a constant factor.
     */
    multiplyColumn: function (rows, p) {
        var col = p.column;
        var f   = parseFloat(p.factor);
        return rows.map(function (row) {
            var r = Object.assign({}, row);
            var v = parseFloat(row[col]);
            r[col] = !isNaN(v) ? v * f : row[col];
            return r;
        });
    },

    /**
     * Plain string find-and-replace within a column's values.
     */
    replaceInColumn: function (rows, p) {
        var col     = p.column;
        var find    = String(p.find    != null ? p.find    : '');
        var replace = String(p.replace != null ? p.replace : '');
        return rows.map(function (row) {
            var r = Object.assign({}, row);
            r[col] = String(row[col] != null ? row[col] : '').split(find).join(replace);
            return r;
        });
    },

    /**
     * Trim leading and trailing whitespace from a column.
     */
    trimColumn: function (rows, p) {
        var col = p.column;
        return rows.map(function (row) {
            var r = Object.assign({}, row);
            r[col] = String(row[col] != null ? row[col] : '').trim();
            return r;
        });
    },

    /**
     * Fill empty cells in a column with a default value.
     */
    fillEmpty: function (rows, p) {
        var col = p.column;
        var val = p.value != null ? p.value : '';
        return rows.map(function (row) {
            var r = Object.assign({}, row);
            var v = row[col];
            if (v === undefined || v === null || String(v).trim() === '') r[col] = val;
            return r;
        });
    },

    /**
     * Split one column into two or more new columns by a delimiter.
     * newCols: array or comma-separated string of new column names.
     * The original column is removed.
     */
    splitColumn: function (rows, p) {
        var col  = p.column;
        var delim = String(p.delimiter != null ? p.delimiter : ',');
        var cols = Array.isArray(p.newCols)
            ? p.newCols
            : String(p.newCols || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        return rows.map(function (row) {
            var r      = Object.assign({}, row);
            var parts  = String(row[col] != null ? row[col] : '').split(delim);
            cols.forEach(function (c, i) { r[c] = parts[i] != null ? parts[i] : ''; });
            delete r[col];
            return r;
        });
    },


    // ─── ANALYZE ──────────────────────────────────────────────────────────────────
    // Each takes rows[], returns a summary structure.
    // Analyze results do not feed into further Transform steps.

    /**
     * Count rows per unique value → summary table sorted by count descending.
     */
    countBy: function (rows, p) {
        var col    = p.column;
        var counts = Object.create(null);
        rows.forEach(function (row) {
            var k = String(row[col] != null ? row[col] : '(empty)');
            counts[k] = (counts[k] || 0) + 1;
        });
        return Object.keys(counts)
            .sort(function (a, b) { return counts[b] - counts[a]; })
            .map(function (k) {
                var o = {};
                o[col]   = k;
                o.Count  = counts[k];
                return o;
            });
    },

    /**
     * Sum all numeric values in a column → single number.
     */
    sumColumn: function (rows, p) {
        var col = p.column;
        return rows.reduce(function (sum, row) {
            return sum + (parseFloat(row[col]) || 0);
        }, 0);
    },

    /**
     * Average of numeric values in a column → single number or null.
     */
    averageColumn: function (rows, p) {
        var col  = p.column;
        var nums = rows.map(function (r) { return parseFloat(r[col]); }).filter(function (n) { return !isNaN(n); });
        if (!nums.length) return null;
        return nums.reduce(function (s, n) { return s + n; }, 0) / nums.length;
    },

    /**
     * Value → count → percentage frequency table.
     */
    distribution: function (rows, p) {
        var col    = p.column;
        var counts = Object.create(null);
        rows.forEach(function (row) {
            var k = String(row[col] != null ? row[col] : '(empty)');
            counts[k] = (counts[k] || 0) + 1;
        });
        var total = rows.length;
        return Object.keys(counts)
            .sort(function (a, b) { return counts[b] - counts[a]; })
            .map(function (k) {
                var o = {};
                o[col]  = k;
                o.Count = counts[k];
                o['%']  = total > 0 ? ((counts[k] / total) * 100).toFixed(1) + '%' : '0%';
                return o;
            });
    },

    /**
     * Min and max of a numeric column → { min, max }.
     */
    minMax: function (rows, p) {
        var col  = p.column;
        var nums = rows.map(function (r) { return parseFloat(r[col]); }).filter(function (n) { return !isNaN(n); });
        if (!nums.length) return { min: null, max: null };
        return { min: Math.min.apply(null, nums), max: Math.max.apply(null, nums) };
    },

    /**
     * Array of distinct values in a column.
     */
    uniqueValues: function (rows, p) {
        var col  = p.column;
        var seen = Object.create(null);
        var out  = [];
        rows.forEach(function (row) {
            var v = String(row[col] != null ? row[col] : '');
            if (!seen[v]) { seen[v] = true; out.push(v); }
        });
        return out;
    },

    /**
     * Group by one column and apply multiple aggregate measures → pivot table.
     * measures: [{ column, fn: 'count'|'sum'|'average', label }]
     */
    multiAggregate: function (rows, p) {
        var groupBy  = p.groupBy;
        var measures = Array.isArray(p.measures) ? p.measures : [];
        var groups   = Object.create(null);
        var order    = [];
        rows.forEach(function (row) {
            var k = String(row[groupBy] != null ? row[groupBy] : '(empty)');
            if (!groups[k]) { groups[k] = []; order.push(k); }
            groups[k].push(row);
        });
        return order.map(function (k) {
            var g   = groups[k];
            var res = {};
            res[groupBy] = k;
            measures.forEach(function (m) {
                var label = m.label || (m.fn + '(' + m.column + ')');
                if (m.fn === 'count') {
                    res[label] = g.length;
                } else if (m.fn === 'sum') {
                    res[label] = g.reduce(function (s, r) { return s + (parseFloat(r[m.column]) || 0); }, 0);
                } else if (m.fn === 'average') {
                    var nums = g.map(function (r) { return parseFloat(r[m.column]); }).filter(function (n) { return !isNaN(n); });
                    res[label] = nums.length ? nums.reduce(function (s, n) { return s + n; }, 0) / nums.length : null;
                }
            });
            return res;
        });
    }

};


// ===================================================================================
// FUNCTION METADATA — used by the step builder UI
// ===================================================================================
// param types:
//   col         → <select> populated from _labState.headers
//   multi-col   → comma-separated text input
//   text        → <input type="text">
//   num         → <input type="number">
//   filter-op   → <select> with filter operators
//   cross-op    → <select> with = ≠ > < ≥ ≤
//   dir         → <select> [asc | desc]
//   pattern     → <select> with fixed pattern names + optional custom term
//   expr-type   → <select> with expression types + dynamic sub-inputs
//   rules       → mergeBy rules dynamic sub-form
//   measures    → multiAggregate measures dynamic sub-form

window.LabFunctionMeta = {
    // ── Validate ──────────────────────────────────────────────────────────────────
    flagEmpty: {
        group: 'validate', label: 'Flag empty',
        params: [
            { key: 'column', type: 'col', label: 'Column' }
        ]
    },
    flagDuplicate: {
        group: 'validate', label: 'Flag duplicate',
        params: [
            { key: 'column', type: 'col', label: 'Column' }
        ]
    },
    flagOutOfRange: {
        group: 'validate', label: 'Flag out of range',
        params: [
            { key: 'column', type: 'col', label: 'Column' },
            { key: 'min',    type: 'num', label: 'Min' },
            { key: 'max',    type: 'num', label: 'Max' }
        ]
    },
    flagPattern: {
        group: 'validate', label: 'Flag pattern mismatch',
        params: [
            { key: 'column',  type: 'col',     label: 'Column' },
            { key: 'pattern', type: 'pattern', label: 'Pattern' }
        ]
    },
    flagCrossColumn: {
        group: 'validate', label: 'Flag cross-column',
        params: [
            { key: 'colA',     type: 'col',      label: 'Column A' },
            { key: 'operator', type: 'cross-op', label: 'Operator' },
            { key: 'colB',     type: 'col',      label: 'Column B' }
        ]
    },
    flagMissingAny: {
        group: 'validate', label: 'Flag missing any',
        params: [
            { key: 'columns', type: 'multi-col', label: 'Columns (comma-separated)' }
        ]
    },
    warnDuplicate: {
        group: 'validate', label: 'Warn duplicate',
        params: [
            { key: 'column', type: 'col', label: 'Column' }
        ]
    },
    warnOutOfRange: {
        group: 'validate', label: 'Warn out of range',
        params: [
            { key: 'column', type: 'col', label: 'Column' },
            { key: 'min',    type: 'num', label: 'Min' },
            { key: 'max',    type: 'num', label: 'Max' }
        ]
    },

    // ── Transform ─────────────────────────────────────────────────────────────────
    filterRows: {
        group: 'transform', label: 'Filter rows',
        params: [
            { key: 'column',   type: 'col',       label: 'Column' },
            { key: 'operator', type: 'filter-op', label: 'Operator' },
            { key: 'value',    type: 'text',       label: 'Value' }
        ]
    },
    addColumn: {
        group: 'transform', label: 'Add column',
        params: [
            { key: 'name',     type: 'text',      label: 'New column name' },
            { key: 'exprType', type: 'expr-type', label: 'Expression' }
        ]
    },
    removeColumns: {
        group: 'transform', label: 'Remove columns',
        params: [
            { key: 'columns', type: 'multi-col', label: 'Columns to remove (comma-separated)' }
        ]
    },
    renameColumn: {
        group: 'transform', label: 'Rename column',
        params: [
            { key: 'from', type: 'col',  label: 'Column' },
            { key: 'to',   type: 'text', label: 'New name' }
        ]
    },
    sortBy: {
        group: 'transform', label: 'Sort by',
        params: [
            { key: 'column',    type: 'col', label: 'Column' },
            { key: 'direction', type: 'dir', label: 'Direction' }
        ]
    },
    mergeBy: {
        group: 'transform', label: 'Merge / BOM consolidate',
        params: [
            { key: 'keyColumn', type: 'col',   label: 'Key column' },
            { key: 'rules',     type: 'rules', label: 'Aggregate rules' }
        ]
    },
    multiplyColumn: {
        group: 'transform', label: 'Multiply column',
        params: [
            { key: 'column', type: 'col', label: 'Column' },
            { key: 'factor', type: 'num', label: 'Factor' }
        ]
    },
    replaceInColumn: {
        group: 'transform', label: 'Find & replace',
        params: [
            { key: 'column',  type: 'col',  label: 'Column' },
            { key: 'find',    type: 'text', label: 'Find' },
            { key: 'replace', type: 'text', label: 'Replace with' }
        ]
    },
    trimColumn: {
        group: 'transform', label: 'Trim whitespace',
        params: [
            { key: 'column', type: 'col', label: 'Column' }
        ]
    },
    fillEmpty: {
        group: 'transform', label: 'Fill empty cells',
        params: [
            { key: 'column', type: 'col',  label: 'Column' },
            { key: 'value',  type: 'text', label: 'Default value' }
        ]
    },
    splitColumn: {
        group: 'transform', label: 'Split column',
        params: [
            { key: 'column',    type: 'col',  label: 'Column' },
            { key: 'delimiter', type: 'text', label: 'Delimiter' },
            { key: 'newCols',   type: 'text', label: 'New columns (comma-separated)' }
        ]
    },

    // ── Analyze ───────────────────────────────────────────────────────────────────
    countBy: {
        group: 'analyze', label: 'Count by',
        params: [{ key: 'column', type: 'col', label: 'Column' }]
    },
    sumColumn: {
        group: 'analyze', label: 'Sum column',
        params: [{ key: 'column', type: 'col', label: 'Column' }]
    },
    averageColumn: {
        group: 'analyze', label: 'Average column',
        params: [{ key: 'column', type: 'col', label: 'Column' }]
    },
    distribution: {
        group: 'analyze', label: 'Distribution',
        params: [{ key: 'column', type: 'col', label: 'Column' }]
    },
    minMax: {
        group: 'analyze', label: 'Min / Max',
        params: [{ key: 'column', type: 'col', label: 'Column' }]
    },
    uniqueValues: {
        group: 'analyze', label: 'Unique values',
        params: [{ key: 'column', type: 'col', label: 'Column' }]
    },
    multiAggregate: {
        group: 'analyze', label: 'Multi-aggregate (pivot)',
        params: [
            { key: 'groupBy',  type: 'col',      label: 'Group by' },
            { key: 'measures', type: 'measures', label: 'Measures' }
        ]
    }
};
