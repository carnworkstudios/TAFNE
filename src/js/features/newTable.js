// ====================================== CREATE NEW TABLE ============================================
// Lets the user draw a new empty table onto the current sheet. A drag/hover grid picker (like the
// "insert table" control in a word processor) sets the dimensions; the table is then appended to
// #tableContainer as its own card with a fresh data-tifany-id, so a sheet can hold many tables.
(function () {
    const MAX_R = 12, MAX_C = 10;
    let $pop = null;

    // Next unused tifany index across all tables currently on the sheet.
    function nextTifanyIndex() {
        let max = -1;
        $('#tableContainer table[data-tifany-id]').each(function () {
            const m = /^t-(\d+)$/.exec($(this).attr('data-tifany-id') || '');
            if (m) max = Math.max(max, parseInt(m[1], 10));
        });
        return max + 1;
    }

    function buildTableHtml(rows, cols, tifIdx) {
        let html = `<table class="tablecoil crosshair-table" data-tifany-id="t-${tifIdx}">`;
        html += '<thead><tr>';
        for (let c = 0; c < cols; c++) html += `<th>Column ${c + 1}</th>`;
        html += '</tr></thead><tbody>';
        for (let r = 0; r < rows; r++) {
            html += '<tr>';
            for (let c = 0; c < cols; c++) html += '<td></td>';
            html += '</tr>';
        }
        html += '</tbody></table>';
        return html;
    }

    function createNewTable(rows, cols) {
        rows = Math.max(1, Math.min(rows, 200));
        cols = Math.max(1, Math.min(cols, 60));

        if (typeof window.saveCurrentState === 'function') window.saveCurrentState();

        const tifIdx = nextTifanyIndex();
        const tableCount = $('#tableContainer .accordion').length + 1;
        const tableHtml = buildTableHtml(rows, cols, tifIdx);

        const block =
            `<button class="accordion active"><b>Table ${tableCount}</b></button>` +
            `<div class="panel"><div class="sp-selector"></div>${tableHtml}</div>`;

        const clean = window.DOMPurify
            ? window.DOMPurify.sanitize(block, { ALLOW_DATA_ATTR: true })
            : block;

        $('#tableContainer').append(clean);

        const newTable = $('#tableContainer table[data-tifany-id="t-' + tifIdx + '"]')[0];
        window.currentTable = newTable;

        // .panel starts display:none (accordion collapsed). A freshly drawn table must be
        // visible, so open its panel — otherwise the card renders with no table inside.
        $(newTable).closest('.panel').show();

        if (typeof window.setupTableInteraction === 'function') window.setupTableInteraction();
        if (typeof window.renderTableRulers === 'function') {
            requestAnimationFrame(() => window.renderTableRulers(newTable));
        }

        newTable.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        $.toast({ heading: 'New table', text: `${rows} × ${cols} table added`, icon: 'success', loader: false, stack: false });
    }
    window.createNewTable = createNewTable;

    // ── Grid picker popover ───────────────────────────────────────────────────
    function buildPopover() {
        if ($pop && document.body.contains($pop[0])) return $pop;
        let cells = '';
        for (let r = 0; r < MAX_R; r++) {
            for (let c = 0; c < MAX_C; c++) {
                cells += `<div class="tf-grid-cell" data-r="${r}" data-c="${c}"></div>`;
            }
        }
        $pop = $(
            '<div class="tf-newtable-pop" style="display:none;">' +
                `<div class="tf-grid" style="grid-template-columns:repeat(${MAX_C},14px);">${cells}</div>` +
                '<div class="tf-grid-label">Drag to size</div>' +
            '</div>'
        );
        $('body').append($pop);

        const $label = $pop.find('.tf-grid-label');

        $pop.on('mousemove', '.tf-grid-cell', function () {
            const r = +$(this).data('r'), c = +$(this).data('c');
            $pop.find('.tf-grid-cell').each(function () {
                const rr = +$(this).data('r'), cc = +$(this).data('c');
                $(this).toggleClass('on', rr <= r && cc <= c);
            });
            $label.text(`${r + 1} × ${c + 1}`);
        });

        $pop.on('click', '.tf-grid-cell', function () {
            const r = +$(this).data('r'), c = +$(this).data('c');
            hidePopover();
            createNewTable(r + 1, c + 1);
        });

        return $pop;
    }

    function showPopover(anchorEl) {
        buildPopover();
        const rect = anchorEl.getBoundingClientRect();
        $pop.css({ display: 'block', visibility: 'hidden' });
        const pw = $pop.outerWidth();
        let left = rect.left;
        if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
        $pop.css({ left: Math.max(8, left) + 'px', top: (rect.bottom + 6) + 'px', visibility: 'visible' });
        $pop.find('.tf-grid-cell').removeClass('on');
        $pop.find('.tf-grid-label').text('Drag to size');

        setTimeout(() => {
            $(document).on('mousedown.tfnewtable', function (e) {
                if (!$(e.target).closest('.tf-newtable-pop, .newTableBtn').length) hidePopover();
            });
        }, 0);
    }

    function hidePopover() {
        if ($pop) $pop.hide();
        $(document).off('mousedown.tfnewtable');
    }

    $(function () {
        $(document).on('click', '.newTableBtn', function (e) {
            e.preventDefault();
            e.stopPropagation();
            if ($pop && $pop.is(':visible')) { hidePopover(); return; }
            showPopover(this);
        });
    });
})();
