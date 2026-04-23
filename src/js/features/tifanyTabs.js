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
    });
}
