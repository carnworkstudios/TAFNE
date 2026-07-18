// ====================================== STYLES & ID REFLECTION =====================================
// Makes the "Styles And ID" panel reflect the current selection instead of being write-only:
//   • Class Name  → existing classes shown as removable pills; type + Enter adds one (live).
//   • ID          → input pre-filled with the element's current id.
//   • Colspan/Rowspan → the attribute value box shows whichever span the cell actually has.
// Targeting follows the Element Type selector (cell / row / column), reusing getStyleTargets().
(function () {
    // Transient/engine classes that should never appear as user-editable pills.
    const SYSTEM_CLASSES = new Set([
        'selected-cell', 'tablecoil', 'crosshair-table', 'dragging', 'row-dragging',
        'column-dragging', 'drag-over', 'column-drop-target', 'col-drop-target',
        'col-drop-target-left', 'col-drop-target-right', 'drag-handle', 'tifany-drag-row',
        'drop-indicator-row', 'highlight-row', 'highlight-col', 'cell-muted', 'active'
    ]);

    function elementType() { return $('#elementType').val() || 'cell'; }

    // The single element whose current values the panel reflects (first target).
    function anchorElement() {
        const cells = window.selectedCells || [];
        if (!cells.length) return null;
        if (elementType() === 'row') return $(cells[0]).closest('tr')[0] || null;
        return cells[0]; // cell, or the reference cell for a column
    }

    function targets() {
        return (typeof window.getStyleTargets === 'function')
            ? window.getStyleTargets(elementType())
            : (window.selectedCells || []);
    }

    function userClasses(el) {
        if (!el) return [];
        return Array.from(el.classList).filter(c => !SYSTEM_CLASSES.has(c));
    }

    // ── Class pills ───────────────────────────────────────────────────────────
    function renderPills() {
        const $wrap = $('#classPills');
        if (!$wrap.length) return;
        $wrap.empty();
        userClasses(anchorElement()).forEach(cls => {
            const $pill = $('<span class="tf-class-pill"></span>').text(cls);
            const $x = $('<span class="tf-class-pill-x" title="Remove class">×</span>');
            $x.on('click', function (e) { e.stopPropagation(); removeClass(cls); });
            $pill.append($x);
            $wrap.append($pill);
        });
    }

    function addClass(raw) {
        let name = (raw || '').trim();
        if (!name) return;
        if ($('#basic-addon1').hasClass('sp-active') && !name.startsWith('sp-')) name = 'sp-' + name;
        const els = targets();
        if (!els.length) return;
        window.saveCurrentState();
        els.forEach(el => el.classList.add(name));
        window.saveCurrentState();
        renderPills();
    }

    function removeClass(name) {
        const els = targets();
        if (!els.length) return;
        window.saveCurrentState();
        els.forEach(el => el.classList.remove(name));
        window.saveCurrentState();
        renderPills();
        if (typeof window.updateSelectionHandles === 'function') window.updateSelectionHandles();
    }

    // ── ID + span reflection ──────────────────────────────────────────────────
    function populateId() {
        const el = anchorElement();
        $('#idInput').val(el && el.id ? el.id : '');
    }

    function populateSpan() {
        const el = anchorElement();
        const cs = el ? parseInt(el.getAttribute('colspan') || '1', 10) : 1;
        const rs = el ? parseInt(el.getAttribute('rowspan') || '1', 10) : 1;
        // Show whichever span the cell actually carries; prefer colspan if it has both.
        if (cs > 1) { $('#tableAttribute').val('colspan'); $('#attributeValue').val(cs); }
        else if (rs > 1) { $('#tableAttribute').val('rowspan'); $('#attributeValue').val(rs); }
        else { $('#tableAttribute').val(''); $('#attributeValue').val(''); }
    }

    function populate() {
        if (!(window.selectedCells || []).length) {
            $('#classPills').empty();
            return;
        }
        populateId();
        renderPills();
        populateSpan();
    }
    window.populateStylesPanel = populate;

    // ── Wiring ────────────────────────────────────────────────────────────────
    // Add a class on Enter/Return from the "add" field. Bound directly to the element
    // (not delegated from document) because a global `$(document).off('keydown')` elsewhere
    // wipes delegated document keydown handlers.
    $(function () {
        $('#classInput').off('keydown.tfclass').on('keydown.tfclass', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                addClass($(this).val());
                $(this).val('');
            }
        });
    });

    // Switching the Colspan/Rowspan selector shows that attribute's current value.
    $(document).on('change', '#tableAttribute', function () {
        const el = anchorElement();
        const attr = $(this).val();
        if (el && (attr === 'colspan' || attr === 'rowspan')) {
            $('#attributeValue').val(parseInt(el.getAttribute(attr) || '1', 10));
        }
    });

    // Re-reflect when the Element Type (cell/row/column) changes.
    $(document).on('change', '#elementType', populate);
})();
