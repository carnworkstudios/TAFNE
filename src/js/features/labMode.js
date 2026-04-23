// ===================================================================================
// LAB MODE — State, Pipeline, UI Orchestration
// ===================================================================================
// Replaces drawMode.js.
// UI shell (top pane / resize handle / bottom pane) is reused from drawMode HTML.
// Only the function layer changes — no structural layout changes.
// ===================================================================================

window.labModeEnabled = false;

window._labState = {
    mode: 'validate',       // active picker tab: 'validate' | 'transform' | 'analyze'

    rows: [],               // [{ ColA: 'val', ColB: 'val' }, ...]  — source data
    headers: [],            // ['ColA', 'ColB', ...]  — preserves column order

    source: 'manual',       // 'manual' | 'sheet' | 'bridge'
    sourceSheetId: null,
    bridgeEnvelope: null,

    pipeline: [],           // [{ id, fn, params, label }, ...]

    flagged: [],            // [{ rowIndex, message, level }]  — accumulated across Validate steps
    result: null,           // final rows[] or summary after Run

    recipeOpen: false
};


// ─── ENABLE / DISABLE ─────────────────────────────────────────────────────────

function enableLab() {
    // Exit Node Editor if active
    if (window.nodeEditorEnabled && typeof disableNodeEditor === 'function') {
        disableNodeEditor();
    }

    window.labModeEnabled = true;
    $('#labModeToggle').addClass('active').attr('title', 'Lab Mode: ON');
    $('#selectToolToggle').removeClass('active');

    // Reset state
    window._labState.pipeline = [];
    window._labState.flagged  = [];
    window._labState.result   = null;
    window._labState.recipeOpen = false;

    // Load data from the active table
    _labLoadFromSheet();

    // Show lab canvas, hide table view
    $('.table-wrapper').hide();
    $('#sheetTabBar').hide();
    $('#labCanvas').css('display', 'flex');
    document.body.classList.add('lab-mode-active');

    // Monaco: set to read-only recipe mode
    if (window.tifanyMonacoDraw) {
        window.tifanyMonacoDraw.updateOptions({ readOnly: true });
        window.tifanyMonacoDraw.setValue('// Lab Pipeline — no steps yet\n');
        setTimeout(function () { window.tifanyMonacoDraw.layout(); }, 50);
    }

    // Render empty state
    _labRenderStepList();
    _labSetMode(window._labState.mode);

    // Result pane: show row count loaded
    var count = window._labState.rows.length;
    $('#labResultContent').html(
        '<em style="font-size:11px; color:var(--t-text-muted);">' +
        (count > 0
            ? count + ' row' + (count !== 1 ? 's' : '') + ' loaded. Add steps and click Run.'
            : 'No table data loaded. Open a table first, then enter Lab Mode.') +
        '</em>'
    );
    $('#labSubmitRow').hide();
    $('#labResultBadge').hide();

    $.toast({ heading: 'Lab Mode', text: 'Lab Mode activated. ' + count + ' row' + (count !== 1 ? 's' : '') + ' loaded.', icon: 'info', loader: false, stack: false });
}

function disableLab() {
    window.labModeEnabled = false;
    $('#labModeToggle').removeClass('active').attr('title', 'Lab Mode');
    $('#selectToolToggle').addClass('active');

    $('#labCanvas').hide();
    $('.table-wrapper').show();
    $('#sheetTabBar').show();
    document.body.classList.remove('lab-mode-active');

    // Restore Monaco to writable (in case drawMode is ever re-enabled)
    if (window.tifanyMonacoDraw) {
        window.tifanyMonacoDraw.updateOptions({ readOnly: false });
        window.tifanyMonacoDraw.setValue('');
    }

    $('#labFnPicker').hide();
}

function toggleLab() {
    if (window.labModeEnabled) disableLab();
    else enableLab();
}


// ─── LOAD DATA ────────────────────────────────────────────────────────────────

/**
 * Reads the active HTML table and populates _labState.rows / _labState.headers.
 * Reuses the same DOM walk pattern as _populateGridFromTable() in drawMode.
 */
function _labLoadFromSheet() {
    var $table = window.currentTable
        ? $(window.currentTable)
        : $('#tableContainer table').first();

    var headers    = [];
    var rows       = [];
    var headerDone = false;

    if ($table.length) {
        $table.find('tr').each(function () {
            var $cells = $(this).find('td, th');
            if (!$cells.length) return;

            if (!headerDone) {
                var hasThCells = $(this).find('th').length > 0;
                if (hasThCells) {
                    // This row is the header row
                    $cells.each(function (i) {
                        var t = $(this).text().trim();
                        headers.push(t || ('Col' + (i + 1)));
                    });
                    headerDone = true;
                    return; // next row
                }
                // No <th> found — generate generic names, treat row as first data row
                $cells.each(function (i) { headers.push('Col' + (i + 1)); });
                headerDone = true;
                // fall through: also add as data row
            }

            // Data row
            var row = {};
            $cells.each(function (i) {
                var key = headers[i] || ('Col' + (i + 1));
                row[key] = $(this).text().trim();
            });
            rows.push(row);
        });
    }

    window._labState.headers = headers;
    window._labState.rows    = rows;
    window._labState.source  = 'sheet';
}


// ─── MODE TABS ────────────────────────────────────────────────────────────────

function _labSetMode(mode) {
    window._labState.mode = mode;
    $('.lab-tab').removeClass('active');
    $('.lab-tab[data-mode="' + mode + '"]').addClass('active');
    // If picker is open, re-render it for the new mode
    if ($('#labFnPicker').is(':visible')) {
        _labRenderPicker();
    }
}


// ─── PIPELINE EXECUTION ───────────────────────────────────────────────────────

/**
 * Determine the group (validate / transform / analyze) of a function.
 */
function _labFnGroup(fnName) {
    var meta = window.LabFunctionMeta && window.LabFunctionMeta[fnName];
    return meta ? meta.group : 'transform';
}

/**
 * Run the full pipeline synchronously on the main thread.
 * Steps run in order. Validate steps accumulate flags.
 * Transform steps replace workingRows. The first Analyze step stops the chain.
 */
function labRunPipeline() {
    if (!window.LabFunctions) {
        $.toast({ heading: 'Lab Mode', text: 'Function library not loaded.', icon: 'error', loader: false, stack: false });
        return;
    }

    if (!window._labState.pipeline.length) {
        $.toast({ heading: 'Lab Mode', text: 'No steps in pipeline — add a step first.', icon: 'warning', loader: false, stack: false });
        return;
    }

    // 1. Clone source rows (never mutate the original)
    var workingRows = window._labState.rows.map(function (r) { return Object.assign({}, r); });

    // 2. Reset flags
    window._labState.flagged = [];
    window._labState.result  = null;

    // 3. Execute each step
    var analyzeResult = null;

    for (var i = 0; i < window._labState.pipeline.length; i++) {
        var step = window._labState.pipeline[i];
        var fn   = window.LabFunctions[step.fn];
        if (!fn) continue;

        var group = _labFnGroup(step.fn);

        if (group === 'validate') {
            var flags = fn(workingRows, step.params || {});
            if (Array.isArray(flags)) {
                window._labState.flagged = window._labState.flagged.concat(flags);
            }
        } else if (group === 'transform') {
            var result = fn(workingRows, step.params || {});
            if (Array.isArray(result)) workingRows = result;
        } else if (group === 'analyze') {
            analyzeResult = fn(workingRows, step.params || {});
            break; // Analyze terminates the chain
        }
    }

    // 4. Store result
    if (analyzeResult !== null && analyzeResult !== undefined) {
        window._labState.result = analyzeResult;
    } else {
        window._labState.result = workingRows;
    }

    // 5. Render
    _labRenderResult();
}


// ─── RESULT RENDERING ─────────────────────────────────────────────────────────

function _labRenderResult() {
    var result   = window._labState.result;
    var flagged  = window._labState.flagged;
    var pipeline = window._labState.pipeline;
    var $content = $('#labResultContent');
    var $badge   = $('#labResultBadge');
    var $submit  = $('#labSubmitRow');

    // Determine if last executed step was Analyze
    var lastAnalyze = false;
    for (var i = pipeline.length - 1; i >= 0; i--) {
        var g = _labFnGroup(pipeline[i].fn);
        if (g === 'analyze') { lastAnalyze = true; break; }
        if (g === 'transform' || g === 'validate') break;
    }

    if (lastAnalyze) {
        _labRenderAnalyzeResult($content, result, $badge);
        $submit.show();
        return;
    }

    // Has any validate steps?
    var hasValidate = pipeline.some(function (s) { return _labFnGroup(s.fn) === 'validate'; });
    if (hasValidate) {
        _labRenderValidateResult($content, Array.isArray(result) ? result : window._labState.rows, flagged, $badge);
    } else {
        // Pure transform — just show the result table
        _labRenderTransformResult($content, result, $badge);
    }

    $submit.show();
}

/**
 * Validate result: full table with flagged rows highlighted.
 */
function _labRenderValidateResult($content, rows, flagged, $badge) {
    var errors = flagged.filter(function (f) { return f.level === 'error'; }).length;
    var warns  = flagged.filter(function (f) { return f.level === 'warn'; }).length;

    // Badge
    if (errors || warns) {
        var badgeText = [];
        if (errors) badgeText.push(errors + ' error' + (errors !== 1 ? 's' : ''));
        if (warns)  badgeText.push(warns  + ' warning' + (warns  !== 1 ? 's' : ''));
        $badge.text(badgeText.join(' · ')).css('color', errors ? 'var(--t-danger, #dc3545)' : 'var(--t-warning, #ffc107)').show();
    } else {
        $badge.text('✓ All rows passed').css('color', 'var(--t-success, #28a745)').show();
    }

    if (!rows.length) {
        $content.html('<em style="font-size:11px; color:var(--t-text-muted);">No rows to display.</em>');
        return;
    }

    // Build flag map: rowIndex → [messages]
    var flagMap = {};
    flagged.forEach(function (f) {
        if (!flagMap[f.rowIndex]) flagMap[f.rowIndex] = [];
        flagMap[f.rowIndex].push({ message: f.message, level: f.level });
    });

    var headers = _labCurrentHeaders(rows);
    var html    = '<table class="lab-result-table"><thead><tr>';
    headers.forEach(function (h) { html += '<th>' + _labEscape(h) + '</th>'; });
    html += '<th class="lab-flag-col">Flags</th></tr></thead><tbody>';

    rows.forEach(function (row, i) {
        var flags   = flagMap[i] || [];
        var hasErr  = flags.some(function (f) { return f.level === 'error'; });
        var hasWarn = flags.some(function (f) { return f.level === 'warn'; });
        var rowCls  = hasErr ? 'lab-row-error' : (hasWarn ? 'lab-row-warn' : '');
        html += '<tr class="' + rowCls + '">';
        headers.forEach(function (h) {
            html += '<td>' + _labEscape(String(row[h] != null ? row[h] : '')) + '</td>';
        });
        // Flag cell
        if (flags.length) {
            var msgs = flags.map(function (f) {
                return '<span class="lab-flag-badge lab-flag-' + f.level + '">' + _labEscape(f.message) + '</span>';
            }).join('');
            html += '<td class="lab-flag-col">' + msgs + '</td>';
        } else {
            html += '<td class="lab-flag-col"></td>';
        }
        html += '</tr>';
    });

    html += '</tbody></table>';
    $content.html(html);
}

/**
 * Transform result: preview table with row/column count delta.
 */
function _labRenderTransformResult($content, rows, $badge) {
    var srcCount = window._labState.rows.length;
    var outCount = Array.isArray(rows) ? rows.length : 0;

    var srcCols = window._labState.headers.length;
    var outCols = Array.isArray(rows) && rows.length ? Object.keys(rows[0]).length : 0;

    var deltaText = srcCount + ' rows';
    if (outCount !== srcCount) deltaText += ' → ' + outCount + ' rows';
    if (outCols !== srcCols)   deltaText += ' · ' + (outCols > srcCols ? (outCols - srcCols) + ' col added' : (srcCols - outCols) + ' col removed');
    $badge.text(deltaText).css('color', 'var(--t-text-muted)').show();

    if (!rows || !rows.length) {
        $content.html('<em style="font-size:11px; color:var(--t-text-muted);">Result is empty.</em>');
        return;
    }

    $content.html(_labRowsToHtml(rows));
}

/**
 * Analyze result: summary table, stat card, or list.
 */
function _labRenderAnalyzeResult($content, result, $badge) {
    $badge.text('Analysis').css('color', 'var(--t-primary, #6366f1)').show();

    if (result === null || result === undefined) {
        $content.html('<em style="font-size:11px; color:var(--t-text-muted);">No result.</em>');
        return;
    }

    // Array of objects → summary table
    if (Array.isArray(result) && result.length && typeof result[0] === 'object') {
        $content.html(_labRowsToHtml(result));
        return;
    }

    // Array of strings → single-column list
    if (Array.isArray(result)) {
        var listHtml = '<table class="lab-result-table"><thead><tr><th>Value</th></tr></thead><tbody>';
        result.forEach(function (v) {
            listHtml += '<tr><td>' + _labEscape(String(v)) + '</td></tr>';
        });
        listHtml += '</tbody></table>';
        $content.html(listHtml);
        return;
    }

    // { min, max } → two stat cards
    if (typeof result === 'object' && 'min' in result && 'max' in result) {
        $content.html(
            '<div class="lab-stat-row">' +
            _labStatCard('Min', result.min) +
            _labStatCard('Max', result.max) +
            '</div>'
        );
        return;
    }

    // Number or string → single stat card
    $content.html('<div class="lab-stat-row">' + _labStatCard('Result', result) + '</div>');
}

function _labStatCard(label, value) {
    var formatted = value !== null && value !== undefined
        ? (typeof value === 'number' ? (Number.isInteger(value) ? value : parseFloat(value.toFixed(4))) : value)
        : '—';
    return '<div class="lab-stat-card">' +
        '<div class="lab-stat-value">' + _labEscape(String(formatted)) + '</div>' +
        '<div class="lab-stat-label">' + _labEscape(label) + '</div>' +
        '</div>';
}

/**
 * Convert rows[] → HTML table string. Uses the first row's keys as headers.
 */
function _labRowsToHtml(rows) {
    if (!rows || !rows.length) return '<em style="font-size:11px;">Empty result.</em>';
    var headers = _labCurrentHeaders(rows);
    var html = '<table class="lab-result-table"><thead><tr>';
    headers.forEach(function (h) { html += '<th>' + _labEscape(h) + '</th>'; });
    html += '</tr></thead><tbody>';
    rows.forEach(function (row) {
        html += '<tr>';
        headers.forEach(function (h) {
            html += '<td>' + _labEscape(String(row[h] != null ? row[h] : '')) + '</td>';
        });
        html += '</tr>';
    });
    html += '</tbody></table>';
    return html;
}

function _labCurrentHeaders(rows) {
    if (window._labState.headers.length) return window._labState.headers;
    if (rows && rows.length) return Object.keys(rows[0]);
    return [];
}

function _labEscape(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}


// ─── STEP MANAGEMENT ──────────────────────────────────────────────────────────

function _labGenId() {
    return 'step-' + Math.random().toString(36).slice(2, 9);
}

/**
 * Add a new step to the pipeline and re-render.
 */
function _labAddStep(fnName) {
    var step = {
        id:     _labGenId(),
        fn:     fnName,
        params: {},
        label:  (window.LabFunctionMeta[fnName] || {}).label || fnName
    };
    window._labState.pipeline.push(step);
    $('#labFnPicker').hide();
    _labRenderStepList();
    _labRenderRecipe();
    // Scroll to new step
    var $list = $('#labStepList');
    $list.scrollTop($list[0].scrollHeight);
}

/**
 * Remove a step from the pipeline by id.
 */
function _labRemoveStep(id) {
    window._labState.pipeline = window._labState.pipeline.filter(function (s) { return s.id !== id; });
    _labRenderStepList();
    _labRenderRecipe();
}

/**
 * Move a step up or down in the pipeline.
 */
function _labMoveStep(id, direction) {
    var pipeline = window._labState.pipeline;
    var idx = pipeline.findIndex(function (s) { return s.id === id; });
    if (idx < 0) return;
    var newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= pipeline.length) return;
    var tmp = pipeline[idx];
    pipeline[idx]    = pipeline[newIdx];
    pipeline[newIdx] = tmp;
    _labRenderStepList();
    _labRenderRecipe();
}

/**
 * Collect params from DOM for a step card and sync to _labState.pipeline.
 */
function _labCollectStepParams(stepId) {
    var step = window._labState.pipeline.find(function (s) { return s.id === stepId; });
    if (!step) return;

    var $card   = $('.lab-step-card[data-step-id="' + stepId + '"]');
    var params  = {};

    // Standard single-value inputs
    $card.find('[data-param]').each(function () {
        var key = $(this).attr('data-param');
        if (key === '_measures_dummy' || key === '_rules_dummy') return; // handled separately
        if ($(this).is('select[multiple]')) {
            var vals = $(this).val();
            params[key] = vals ? vals.join(',') : '';
        } else {
            params[key] = $(this).val();
        }
    });

    // mergeBy rules: read from .lab-rule-row
    if (step.fn === 'mergeBy') {
        var rules = {};
        $card.find('.lab-rule-row').each(function () {
            var col  = $(this).find('.lab-rule-col').text();
            var rule = $(this).find('.lab-rule-select').val();
            if (col && rule) rules[col] = rule;
        });
        params.rules = rules;
    }

    // multiAggregate measures: read from .lab-measure-row
    if (step.fn === 'multiAggregate') {
        var measures = [];
        $card.find('.lab-measure-row').each(function () {
            var col = $(this).find('.lab-measure-col').val();
            var fn  = $(this).find('.lab-measure-fn').val();
            if (col) measures.push({ column: col, fn: fn, label: fn + '(' + col + ')' });
        });
        params.measures = measures;
    }

    step.params = params;

    // Update label
    step.label = _labStepLabel(step);
    // Update label display in card header without full re-render
    $card.find('.lab-step-label').text(step.label);

    _labRenderRecipe();
}

/**
 * Generate a short human-readable label for a step.
 */
function _labStepLabel(step) {
    var meta = window.LabFunctionMeta[step.fn] || {};
    var base = meta.label || step.fn;
    var p    = step.params || {};

    var detail = '';
    if (p.column)    detail = p.column;
    if (p.from)      detail = p.from + ' → ' + (p.to || '?');
    if (p.name)      detail = p.name;
    if (p.keyColumn) detail = p.keyColumn;
    if (p.groupBy)   detail = p.groupBy;

    if (step.fn === 'filterRows' && p.column && p.operator) {
        detail = p.column + ' ' + p.operator + ' ' + (p.value || '?');
    }
    if (step.fn === 'sortBy' && p.column) {
        detail = p.column + ' ' + (p.direction === 'desc' ? '↓' : '↑');
    }

    return detail ? base + ': ' + detail : base;
}


// ─── STEP LIST RENDERER ───────────────────────────────────────────────────────

function _labRenderStepList() {
    var $list = $('#labStepList');
    if (!window._labState.pipeline.length) {
        $list.html('<div class="lab-step-empty">No steps yet — click <strong>+ Add Step</strong> to begin.</div>');
        return;
    }

    var html = '';
    window._labState.pipeline.forEach(function (step, idx) {
        var group   = _labFnGroup(step.fn);
        var canUp   = idx > 0;
        var canDown = idx < window._labState.pipeline.length - 1;
        html +=
            '<div class="lab-step-card" data-step-id="' + step.id + '">' +
            '<div class="lab-step-card-header">' +
            '<span class="lab-step-num">' + (idx + 1) + '</span>' +
            '<span class="lab-step-badge lab-badge-' + group + '">' + group + '</span>' +
            '<span class="lab-step-label">' + _labEscape(step.label) + '</span>' +
            '<div class="lab-step-actions">' +
            '<button class="lab-step-btn lab-step-up" data-step-id="' + step.id + '" title="Move up"' + (canUp ? '' : ' disabled') + '>↑</button>' +
            '<button class="lab-step-btn lab-step-down" data-step-id="' + step.id + '" title="Move down"' + (canDown ? '' : ' disabled') + '>↓</button>' +
            '<button class="lab-step-btn lab-step-remove" data-step-id="' + step.id + '" title="Remove">×</button>' +
            '</div>' +
            '</div>' +
            '<div class="lab-step-params">' + _labRenderParamForm(step) + '</div>' +
            '</div>';
    });
    $list.html(html);

    // Wire step button events
    $list.find('.lab-step-up').on('click', function () {
        _labMoveStep($(this).attr('data-step-id'), 'up');
    });
    $list.find('.lab-step-down').on('click', function () {
        _labMoveStep($(this).attr('data-step-id'), 'down');
    });
    $list.find('.lab-step-remove').on('click', function () {
        _labRemoveStep($(this).attr('data-step-id'));
    });

    // Wire param change events
    $list.find('[data-param], .lab-rule-select, .lab-measure-col, .lab-measure-fn').on('change input', function () {
        var $card  = $(this).closest('.lab-step-card');
        var stepId = $card.attr('data-step-id');
        _labCollectStepParams(stepId);
    });

    // Wire expr-type sub-form visibility
    $list.find('[data-param="exprType"]').each(function () {
        _labToggleExprSubfields($(this));
        $(this).on('change', function () { _labToggleExprSubfields($(this)); });
    });

    // Wire pattern custom term visibility
    $list.find('[data-param="pattern"]').each(function () {
        _labToggleCustomTerm($(this));
        $(this).on('change', function () { _labToggleCustomTerm($(this)); });
    });

    // Wire keyColumn change → rebuild rules sub-form
    $list.find('[data-param="keyColumn"]').on('change', function () {
        var $card  = $(this).closest('.lab-step-card');
        var stepId = $card.attr('data-step-id');
        _labCollectStepParams(stepId);
        var step = window._labState.pipeline.find(function (s) { return s.id === stepId; });
        if (step) $card.find('.lab-rules-container').html(_labRulesForm(step.params.keyColumn));
    });

    // Wire add measure button
    $list.find('.lab-add-measure').on('click', function () {
        var $card = $(this).closest('.lab-step-card');
        $card.find('.lab-measures-rows').append(_labMeasureRow());
        // Wire new row events
        $card.find('.lab-measures-rows .lab-measure-row:last-child').find('select').on('change', function () {
            var stepId = $card.attr('data-step-id');
            _labCollectStepParams(stepId);
        });
    });
}


// ─── PARAM FORM RENDERER ─────────────────────────────────────────────────────

function _labRenderParamForm(step) {
    var meta   = window.LabFunctionMeta[step.fn];
    if (!meta) return '';
    var params = step.params || {};
    var html   = '<div class="lab-param-grid">';

    meta.params.forEach(function (spec) {
        html += '<label class="lab-param-label">' + _labEscape(spec.label) + '</label>';
        html += '<div class="lab-param-input">';
        html += _labParamInput(spec, params[spec.key], step);
        html += '</div>';
    });

    html += '</div>';
    return html;
}

function _labParamInput(spec, currentVal, step) {
    var headers = window._labState.headers;
    var val     = currentVal != null ? currentVal : '';

    switch (spec.type) {

        case 'col':
            var selHtml = '<select class="lab-input" data-param="' + spec.key + '">';
            selHtml += '<option value="">— select column —</option>';
            headers.forEach(function (h) {
                selHtml += '<option value="' + _labEscape(h) + '"' + (h === val ? ' selected' : '') + '>' + _labEscape(h) + '</option>';
            });
            selHtml += '</select>';
            return selHtml;

        case 'multi-col':
            return '<input type="text" class="lab-input" data-param="' + spec.key + '" placeholder="col1, col2, ..." value="' + _labEscape(String(val)) + '">';

        case 'text':
            return '<input type="text" class="lab-input" data-param="' + spec.key + '" value="' + _labEscape(String(val)) + '">';

        case 'num':
            return '<input type="number" class="lab-input lab-input-num" data-param="' + spec.key + '" value="' + _labEscape(String(val)) + '" placeholder="">';

        case 'filter-op':
            var ops = ['=', '≠', '>', '<', '≥', '≤', 'contains', 'starts-with', 'ends-with', 'is-empty', 'is-not-empty'];
            return _labSelectInput(spec.key, ops, val);

        case 'cross-op':
            return _labSelectInput(spec.key, ['=', '≠', '>', '<', '≥', '≤'], val);

        case 'dir':
            return _labSelectInput(spec.key, ['asc', 'desc'], val || 'asc');

        case 'pattern':
            var patternOpts = ['whole-number', 'decimal-number', 'ref-designator', 'email', 'iso-date', 'non-empty', 'uppercase', 'custom'];
            return _labSelectInput(spec.key, patternOpts, val) +
                '<input type="text" class="lab-input lab-custom-term" data-param="term" ' +
                'placeholder="substring to match" ' +
                'style="display:' + (val === 'custom' ? 'block' : 'none') + '; margin-top:4px;" ' +
                'value="' + _labEscape(String((step && step.params && step.params.term) || '')) + '">';

        case 'expr-type':
            var exprTypes = ['multiply', 'divide', 'add', 'subtract', 'multiply-const', 'concat', 'conditional', 'fixed'];
            return _labSelectInput(spec.key, exprTypes, val) + _labExprSubfields(val, step ? step.params : {});

        case 'rules':
            return '<div class="lab-rules-container">' + _labRulesForm((step && step.params && step.params.keyColumn) || '') + '</div>';

        case 'measures':
            return _labMeasuresForm(step ? step.params : {});

        default:
            return '<input type="text" class="lab-input" data-param="' + spec.key + '" value="' + _labEscape(String(val)) + '">';
    }
}

function _labSelectInput(key, options, selected) {
    var html = '<select class="lab-input" data-param="' + key + '">';
    options.forEach(function (o) {
        html += '<option value="' + _labEscape(o) + '"' + (o === selected ? ' selected' : '') + '>' + _labEscape(o) + '</option>';
    });
    html += '</select>';
    return html;
}

function _labExprSubfields(exprType, params) {
    params = params || {};
    var headers = window._labState.headers;
    var html    = '<div class="lab-expr-sub">';

    function colRow(key, label) {
        var s = '<div class="lab-expr-row"><span class="lab-expr-label">' + label + '</span>';
        s += '<select class="lab-input" data-param="' + key + '">';
        s += '<option value="">— column —</option>';
        headers.forEach(function (h) {
            s += '<option value="' + _labEscape(h) + '"' + (h === params[key] ? ' selected' : '') + '>' + _labEscape(h) + '</option>';
        });
        s += '</select></div>';
        return s;
    }
    function textRow(key, label, placeholder) {
        return '<div class="lab-expr-row"><span class="lab-expr-label">' + label + '</span>' +
            '<input type="text" class="lab-input" data-param="' + key + '" placeholder="' + (placeholder || '') + '" value="' + _labEscape(String(params[key] || '')) + '"></div>';
    }

    if (!exprType || exprType === 'multiply' || exprType === 'divide' || exprType === 'add' || exprType === 'subtract') {
        html += colRow('colA', 'Col A') + colRow('colB', 'Col B');
    } else if (exprType === 'multiply-const') {
        html += colRow('colA', 'Column') + textRow('factor', 'Factor', '1');
    } else if (exprType === 'concat') {
        html += colRow('colA', 'Col A') + textRow('separator', 'Separator', '-') + colRow('colB', 'Col B');
    } else if (exprType === 'conditional') {
        html += colRow('condCol', 'If col') +
            '<div class="lab-expr-row"><span class="lab-expr-label">op</span>' +
            _labSelectInput('condOp', ['=', '≠', '>', '<', '≥', '≤'], params.condOp || '=') +
            '</div>' +
            textRow('condVal', 'Value', '') +
            textRow('thenVal', 'Then', '') +
            textRow('elseVal', 'Else', '');
    } else if (exprType === 'fixed') {
        html += textRow('literal', 'Value', '');
    }

    html += '</div>';
    return html;
}

function _labToggleExprSubfields($select) {
    var $card  = $select.closest('.lab-step-card');
    var stepId = $card.attr('data-step-id');
    var type   = $select.val();
    var step   = window._labState.pipeline.find(function (s) { return s.id === stepId; });
    // Remove old sub-fields and rebuild
    $card.find('.lab-expr-sub').remove();
    var $sub = $(_labExprSubfields(type, step ? step.params : {}));
    $select.closest('.lab-param-input').append($sub);
    // Wire change events on new sub-fields
    $sub.find('[data-param]').on('change input', function () {
        _labCollectStepParams(stepId);
    });
}

function _labToggleCustomTerm($select) {
    var $termInput = $select.closest('.lab-param-input').find('.lab-custom-term');
    $termInput.toggle($select.val() === 'custom');
}

function _labRulesForm(keyCol) {
    var headers = window._labState.headers.filter(function (h) { return h !== keyCol; });
    if (!headers.length) return '<em class="lab-hint">Load data and select a key column first.</em>';
    var rules   = ['sum', 'first', 'last', 'count', 'unique', 'join(, )'];
    var html    = '';
    headers.forEach(function (h) {
        html += '<div class="lab-rule-row">' +
            '<span class="lab-rule-col" title="' + _labEscape(h) + '">' + _labEscape(h) + '</span>' +
            '<select class="lab-input lab-input-xs lab-rule-select">';
        rules.forEach(function (r) { html += '<option value="' + r + '">' + r + '</option>'; });
        html += '</select></div>';
    });
    return html;
}

function _labMeasuresForm(params) {
    var measures = (params && Array.isArray(params.measures)) ? params.measures : [];
    var html = '<div class="lab-measures-rows">';
    if (measures.length) {
        measures.forEach(function (m) { html += _labMeasureRow(m); });
    }
    html += '</div>';
    html += '<button class="btn btn-xs btn-outline-secondary lab-add-measure" style="margin-top:4px;">+ Add Measure</button>';
    return html;
}

function _labMeasureRow(m) {
    m = m || {};
    var headers = window._labState.headers;
    var colOpts = '<option value="">— column —</option>';
    headers.forEach(function (h) {
        colOpts += '<option value="' + _labEscape(h) + '"' + (h === m.column ? ' selected' : '') + '>' + _labEscape(h) + '</option>';
    });
    var fnOpts = ['count', 'sum', 'average'].map(function (f) {
        return '<option value="' + f + '"' + (f === m.fn ? ' selected' : '') + '>' + f + '</option>';
    }).join('');
    return '<div class="lab-measure-row">' +
        '<select class="lab-input lab-input-xs lab-measure-col">' + colOpts + '</select>' +
        '<select class="lab-input lab-input-xs lab-measure-fn">' + fnOpts + '</select>' +
        '</div>';
}


// ─── FUNCTION PICKER ──────────────────────────────────────────────────────────

function _labRenderPicker() {
    var mode    = window._labState.mode;
    var $picker = $('#labFnPicker');
    var html    = '<div class="lab-picker-inner">';

    var groups = { validate: [], transform: [], analyze: [] };
    Object.keys(window.LabFunctionMeta).forEach(function (fnName) {
        var meta = window.LabFunctionMeta[fnName];
        if (groups[meta.group]) groups[meta.group].push({ fn: fnName, label: meta.label });
    });

    // Show current mode group first, then the others collapsed
    var displayOrder = [mode, 'validate', 'transform', 'analyze'].filter(function (g, i, a) {
        return a.indexOf(g) === i;
    });

    displayOrder.forEach(function (group) {
        if (!groups[group].length) return;
        html += '<div class="lab-picker-group lab-picker-' + group + (group === mode ? ' lab-picker-active-group' : '') + '">';
        html += '<div class="lab-picker-group-label">' + group + '</div>';
        groups[group].forEach(function (item) {
            html += '<button class="lab-picker-item" data-fn="' + item.fn + '">' + _labEscape(item.label) + '</button>';
        });
        html += '</div>';
    });

    // Commercial upgrade stub
    html += '<div class="lab-picker-group">' +
        '<div class="lab-picker-group-label">cloud</div>' +
        '<button class="lab-picker-item lab-picker-cloud" disabled>' +
        '☁ Custom Script <em>(GINEXYS Cloud)</em>' +
        '</button>' +
        '</div>';

    html += '</div>';
    $picker.html(html);

    $picker.find('.lab-picker-item:not([disabled])').on('click', function () {
        _labAddStep($(this).attr('data-fn'));
    });
}

function _labTogglePicker() {
    if ($('#labFnPicker').is(':visible')) {
        $('#labFnPicker').hide();
    } else {
        _labRenderPicker();
        $('#labFnPicker').show();
    }
}


// ─── RECIPE DISPLAY ───────────────────────────────────────────────────────────

function _labRenderRecipe() {
    if (!window.tifanyMonacoDraw) return;
    if (!window._labState.recipeOpen) return;

    var pipeline = window._labState.pipeline;
    if (!pipeline.length) {
        window.tifanyMonacoDraw.setValue('// Lab Pipeline — no steps yet\n');
        return;
    }

    var lines = ['// Lab Pipeline — ' + pipeline.length + ' step' + (pipeline.length !== 1 ? 's' : '') + '\n'];
    var lastGroup = null;
    pipeline.forEach(function (step) {
        var group = _labFnGroup(step.fn);
        if (group !== lastGroup) {
            lines.push('// [' + group + ']');
            lastGroup = group;
        }
        var paramStr = JSON.stringify(step.params || {});
        lines.push(step.fn + '(' + paramStr + ')');
    });

    window.tifanyMonacoDraw.setValue(lines.join('\n'));
}

function _labToggleRecipe() {
    window._labState.recipeOpen = !window._labState.recipeOpen;
    var $btn = $('#labRecipeToggle');
    var $section = $('#labRecipeSection');

    if (window._labState.recipeOpen) {
        $section.show();
        $btn.text('Recipe ▴');
        _labRenderRecipe();
        setTimeout(function () {
            if (window.tifanyMonacoDraw) window.tifanyMonacoDraw.layout();
        }, 50);
    } else {
        $section.hide();
        $btn.text('Recipe ▾');
    }
}


// ─── CLEAR ────────────────────────────────────────────────────────────────────

function labClearPipeline() {
    window._labState.pipeline = [];
    window._labState.flagged  = [];
    window._labState.result   = null;
    _labRenderStepList();
    _labRenderRecipe();
    $('#labResultContent').html('<em style="font-size:11px; color:var(--t-text-muted);">Pipeline cleared.</em>');
    $('#labSubmitRow').hide();
    $('#labResultBadge').hide();
    $.toast({ heading: 'Lab Mode', text: 'Pipeline cleared.', icon: 'info', loader: false, stack: false });
}


// ─── SUBMIT ───────────────────────────────────────────────────────────────────

function labSubmit() {
    var result = window._labState.result;
    if (!result) {
        $.toast({ heading: 'Lab Mode', text: 'Run the pipeline first.', icon: 'warning', loader: false, stack: false });
        return;
    }

    // Build sheet HTML
    var sheetHtml;
    if (Array.isArray(result) && result.length && typeof result[0] === 'object') {
        sheetHtml = _labRowsToHtml(result).replace('class="lab-result-table"', 'class="tablecoil crosshair-table"');
    } else if (Array.isArray(result)) {
        sheetHtml = '<table class="tablecoil crosshair-table"><thead><tr><th>Value</th></tr></thead><tbody>' +
            result.map(function (v) { return '<tr><td>' + _labEscape(String(v)) + '</td></tr>'; }).join('') +
            '</tbody></table>';
    } else if (typeof result === 'object' && 'min' in result) {
        sheetHtml = '<table class="tablecoil crosshair-table"><thead><tr><th>Min</th><th>Max</th></tr></thead><tbody>' +
            '<tr><td>' + result.min + '</td><td>' + result.max + '</td></tr></tbody></table>';
    } else {
        sheetHtml = '<table class="tablecoil crosshair-table"><thead><tr><th>Result</th></tr></thead><tbody>' +
            '<tr><td>' + _labEscape(String(result)) + '</td></tr></tbody></table>';
    }

    var ts        = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var sheetName = 'Lab ' + ts;

    if (typeof addSheet === 'function') {
        addSheet(sheetName, sheetHtml);
    }
    disableLab();
    $.toast({ heading: 'Lab Mode', text: 'Results submitted as "' + sheetName + '"', icon: 'success', loader: false, stack: false });
}


// ─── INIT ─────────────────────────────────────────────────────────────────────

function initLabCanvas() {
    $('#exitLabMode').on('click',    disableLab);
    $('#labClearAll').on('click',    labClearPipeline);
    $('#labAddStep').on('click',     _labTogglePicker);
    $('#labRunBtn').on('click',      labRunPipeline);
    $('#labSubmitBtn').on('click',   labSubmit);
    $('#labRecipeToggle').on('click', _labToggleRecipe);

    // Mode tab switching
    $(document).on('click', '.lab-tab', function () {
        _labSetMode($(this).data('mode'));
    });

    // Close picker when clicking outside
    $(document).on('click.labPicker', function (e) {
        if (!$(e.target).closest('#labFnPicker, #labAddStep').length) {
            $('#labFnPicker').hide();
        }
    });

    // ── Vertical resize handle (reused from drawMode) ─────────────────────────
    (function () {
        var handle   = document.getElementById('drawResizeHandle');
        var topPane  = document.querySelector('.lab-step-pane');
        var body     = document.getElementById('lab-canvas-body');
        if (!handle || !topPane) return;

        var dragging = false;
        var startY   = 0;
        var startH   = 0;

        function beginDrag(y) {
            dragging = true;
            startY   = y;
            startH   = topPane.getBoundingClientRect().height;
            handle.classList.add('dragging');
            document.body.style.cursor     = 'ns-resize';
            document.body.style.userSelect = 'none';
        }

        function moveDrag(y) {
            if (!dragging) return;
            var delta  = y - startY;
            var parent = topPane.parentElement.getBoundingClientRect().height;
            var newH   = Math.max(80, Math.min(startH + delta, parent * 0.80));
            topPane.style.flex   = 'none';
            topPane.style.height = newH + 'px';
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

        handle.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            beginDrag(e.clientY);
            e.preventDefault();
        });
        document.addEventListener('mousemove', function (e) { moveDrag(e.clientY); });
        document.addEventListener('mouseup',   endDrag);

        handle.addEventListener('touchstart', function (e) {
            beginDrag(e.touches[0].clientY);
            e.preventDefault();
        }, { passive: false });
        document.addEventListener('touchmove', function (e) {
            if (dragging) { moveDrag(e.touches[0].clientY); e.preventDefault(); }
        }, { passive: false });
        document.addEventListener('touchend', endDrag);
    })();
}
