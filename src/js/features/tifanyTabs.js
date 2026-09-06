// ===================================================================================
// 2. RE-USABLE INITIALIZATION FUNCTIONS
// ===================================================================================
/**
 * Finds all accordion headers and makes them clickable to toggle sibling rows.
 */
function initAccordions() {
    $('body').off('click.accordion').on('click.accordion', '.accordion-header', function () {
        $(this).toggleClass('actives');
        $(this).closest('tr').nextUntil('.accordion-header').toggle();
    });
}

/**
 * Wires up the crosshair highlighting feature for any table with the .crosshair-table class.
 */
//==============================================================================================
// 2.5 The Header Accordion
//===============================================================================================
function headerAccordion() {
    //SAVE STATE BEFORE OPERATION
    window.saveCurrentState();


    // Scope to table container only; left panel accordions are persistent and
    // managed independently to avoid state reset on every table reload.
    const $tableAccordions = $('#tableContainer .accordion');

    $tableAccordions.off('click.accordion').on('click.accordion', function () {
        $(this).toggleClass('active');
        const $panel = $(this).next('.panel');
        $panel.slideToggle(200);
    });

    // Show panels marked active on first render (only those not yet initialized)
    $tableAccordions.each(function () {
        const $panel = $(this).next('.panel');
        if ($(this).hasClass('active') && $panel.css('display') === 'none') {
            $panel.show();
        }
    });

    // Left panel accordions: wire click once via delegation (idempotent)
    $('body').off('click.leftAccordion').on('click.leftAccordion', '.tifany-left-panel .accordion', function () {
        $(this).toggleClass('active');
        $(this).next('.panel').slideToggle(200);
    });
}


/**
 * Drop selected cells that the current sp- tab no longer shows.
 *
 * Selecting a cell on one tab and switching to another used to leave it
 * selected while invisible: the selection overlay stayed parked over whichever
 * columns now occupy that space, and Delete would clear a cell on a tab the
 * user was not looking at. A selection has to be something you can see.
 */
function pruneHiddenSelection(table) {
    const kept = (window.selectedCells || []).filter(window.isCellVisible);
    if (kept.length === (window.selectedCells || []).length) {
        if (typeof window.scheduleTableGeometrySync === 'function') window.scheduleTableGeometrySync(table);
        else if (typeof window.updateSelectionHandles === 'function') window.updateSelectionHandles();
        return;
    }

    $(table).find('.selected-cell').not(kept).removeClass('selected-cell');
    window.selectedCells = kept;
    if (!window.isCellVisible(window.selectionAnchorCell)) window.selectionAnchorCell = kept[0] || null;
    if (!window.isCellVisible(window.selectionHeadCell))   window.selectionHeadCell   = kept[kept.length - 1] || null;
    if (typeof window.scheduleTableGeometrySync === 'function') window.scheduleTableGeometrySync(table);
    else if (typeof window.updateSelectionHandles === 'function') window.updateSelectionHandles();
    if (typeof window.populateStylesPanel === 'function') window.populateStylesPanel();
}
window.pruneHiddenSelection = pruneHiddenSelection;

/**
 * Wires up the column-hiding functionality based on the .sp-option selectors.
 */
function initSpSelectors() {
    //SAVE STATE BEFORE OPERATION
    window.saveCurrentState();
    
    $('body').off('click.sp_selector').on('click.sp_selector', '.sp-option', function () {
        const $option = $(this);
        const panel = $option.closest('.panel');
        const table = panel.find('table');
        const spValue = $option.data('value');

        panel.find('.sp-option').removeClass('active');
        $option.addClass('active');

        table.find('[class*="sp-"]').removeClass('active');
        table.find(`.sp-${spValue}`).addClass('active');

        // Column visibility changed — rebuild the ruler so hidden columns'
        // segments hide with them and widths resync to the new layout, and
        // drop any selection the switch just hid.
        const tbl = table[0];
        if (tbl) {
            requestAnimationFrame(() => {
                pruneHiddenSelection(tbl);
                if (typeof window.renderTableRulers === 'function') window.renderTableRulers(tbl);
                if (typeof window.scheduleTableGeometrySync === 'function') window.scheduleTableGeometrySync(tbl);
            });
        }
    });
}
