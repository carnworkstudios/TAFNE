// js/core/tifany.js

$(function () {
    // =================== GLOBAL VARIABLES ===================
    window.selectedCells = [];
    window.currentTable = null;
    // Selection lifecycle for keyboard+mouse range selection.
    // - anchor: fixed start of a range (first click/selection)
    // - head: moving end of a range (mouse drag end or arrow-nav target)
    window.selectionAnchorCell = null;
    window.selectionHeadCell = null;
    window.crosshairEnabled = false;
    window.cellBeingEdited = null;
    window.originalContent = null;
    window.dragDropEnabled = false;
    window.popperInstance = null;
    window.hideTimeout = null;
    window.lastParsedHtml = null;
    window.labModeEnabled = false;
    window.nodeEditorEnabled = false;
    // True while a table cell has been most recently clicked/interacted with.
    // Used to gate copy/paste shortcuts without relying on document.activeElement
    // (which stays on Monaco's textarea after clicking a cell).
    window.tableHasFocus = false;
    // =================== CLEANUP FUNCTION ===================
    function cleanupEventHandlers() {
        $(document).off('.cell .cellEditor .hideMenu .accordion .sp_selector');
        $('#tableContainer').off('.cell .drag');
    }

    // Make cleanupEventHandlers globally accessible
    window.cleanupEventHandlers = cleanupEventHandlers;

    // =================== INITIALIZATION ===================
    function initializeAllFeatures() {
        cleanupEventHandlers();
        initAccordions();
        initCrosshair();
        initSpSelectors();
        headerAccordion();

        const $firstPanel = $('.panel').first();
        if ($firstPanel.length) {
            $firstPanel.show();
            $firstPanel.find('.sp-option').first().trigger('click.sp_selector');
        }
    }

    // Make initializeAllFeatures globally accessible
    window.initializeAllFeatures = initializeAllFeatures;

    // =================== TABLE INTERACTION ===================
    function setupTableInteraction() {
        const $container = $('#tableContainer');
        let isSelecting = false;
        let startCell = null;
        let endCell = null;
        let lastSelectedCell = null;

        // Clear previous event handlers on container
        $container.off('mousedown.cell mousemove.cell selectstart.cell contextmenu.cell dblclick.cell');

        // Mouse down - start selection; also update currentTable to the clicked table
        $container.on('mousedown.cell', 'td, th', function (e) {
            e.preventDefault();
            e.stopPropagation();

            // Update active table to whichever table was clicked
            const clickedTable = $(this).closest('table')[0];
            if (clickedTable && clickedTable !== window.currentTable) {
                // Clear selection from previous table
                if (window.currentTable) {
                    $(window.currentTable).find('.selected-cell').removeClass('selected-cell');
                }
                window.currentTable = clickedTable;
                window.selectedCells = [];
                window.selectionAnchorCell = null;
                window.selectionHeadCell = null;
            }

            // Mark table as the active interaction context.
            // stopPropagation() on this handler prevents the document-level
            // mousedown (which clears the flag) from firing on the same click.
            window.tableHasFocus = true;

            const $table = $(window.currentTable);

            if (e.button === 0) { // Left mouse button only
                if (e.ctrlKey || e.metaKey) {
                    // Toggle individual cell selection with Ctrl/Cmd
                    $(this).toggleClass('selected-cell');
                    if ($(this).hasClass('selected-cell')) {
                        if (!window.selectedCells.includes(this)) {
                            window.selectedCells.push(this);
                        }
                    } else {
                        window.selectedCells = window.selectedCells.filter(cell => cell !== this);
                    }
                    lastSelectedCell = this;
                    // Keep keyboard "active cell" aligned with latest mouse action.
                    if (window.selectedCells.length === 0) {
                        window.selectionAnchorCell = null;
                        window.selectionHeadCell = null;
                    } else {
                        window.selectionHeadCell = this;
                        // If we don't have an anchor yet, establish one.
                        if (!window.selectionAnchorCell) {
                            window.selectionAnchorCell = this;
                        }
                    }
                } else if (e.shiftKey && lastSelectedCell) {
                    // Shift+Click for range selection
                    endCell = this;
                    if (!window.selectionAnchorCell) {
                        window.selectionAnchorCell = lastSelectedCell;
                    }
                    window.selectionHeadCell = endCell;
                    selectRange(window.selectionAnchorCell, window.selectionHeadCell);
                    lastSelectedCell = endCell;
                } else {
                    // Start new selection
                    isSelecting = true;
                    startCell = this;
                    endCell = this;
                    window.selectionAnchorCell = startCell;
                    window.selectionHeadCell = startCell;

                    // Clear previous selection
                    $table.find('.selected-cell').removeClass('selected-cell');
                    window.selectedCells = [];

                    // Select starting cell
                    $(this).addClass('selected-cell');
                    window.selectedCells.push(this);
                    lastSelectedCell = this;
                }
            }
        });

        // Mouse move - extend selection during drag
        $container.on('mousemove.cell', 'td, th', function (e) {
            if (isSelecting) {
                endCell = this;
                window.selectionHeadCell = endCell;
                selectRange(window.selectionAnchorCell || startCell, window.selectionHeadCell);
            }
        });

        // Mouse up - end selection
        $(document).on('mouseup.cell', function () {
            if (isSelecting) {
                isSelecting = false;
                if (endCell) {
                    lastSelectedCell = endCell;
                    window.selectionHeadCell = endCell;
                }
                // (Draw mode operates via the Draw Canvas panel, not via cell selection)
            }
        });

        // Prevent text selection during drag
        $container.on('selectstart.cell', function (e) {
            if (isSelecting) {
                e.preventDefault();
            }
        });

        // Helper function to select a range of cells
        function selectRange(start, end) {
            if (!start || !end || !window.currentTable) return;

            const $table = $(window.currentTable);
            const mapper = new VisualGridMapper($table);
            const startPos = mapper.getVisualPosition(start);
            const endPos = mapper.getVisualPosition(end);

            if (!startPos || !endPos) return;

            // Clear previous selection
            $table.find('.selected-cell').removeClass('selected-cell');
            window.selectedCells = [];

            // Determine the rectangle boundaries
            const minRow = Math.min(startPos.startRow, endPos.startRow);
            const maxRow = Math.max(startPos.startRow + startPos.rowspan - 1, endPos.startRow + endPos.rowspan - 1);
            const minCol = Math.min(startPos.startCol, endPos.startCol);
            const maxCol = Math.max(startPos.startCol + startPos.colspan - 1, endPos.startCol + endPos.colspan - 1);

            // Select all cells in the rectangle
            for (let r = minRow; r <= maxRow; r++) {
                for (let c = minCol; c <= maxCol; c++) {
                    if (mapper.grid[r] && mapper.grid[r][c]) {
                        const cell = mapper.grid[r][c].element;
                        if (mapper.grid[r][c].isOrigin) {
                            $(cell).addClass('selected-cell');
                            if (!window.selectedCells.includes(cell)) {
                                window.selectedCells.push(cell);
                            }
                        }
                    }
                }
            }
        }

        // Mobile long-press support
        let pressTimer;
        $container.on('touchstart.cell', 'td, th', function (e) {
            const self = this;
            const touch = e.originalEvent.touches[0];
            // Store touch position for context menu
            const touchX = touch.clientX;
            const touchY = touch.clientY;

            pressTimer = window.setTimeout(function () {
                const event = $.Event('contextmenu', {
                    clientX: touchX,
                    clientY: touchY,
                    originalEvent: e.originalEvent
                });
                $(self).trigger(event);
            }, 600); // 600ms for long press
        }).on('touchend.cell touchmove.cell', function () {
            clearTimeout(pressTimer);
        });

        // Context menu for cells
        $container.on('contextmenu.cell', 'td, th', function (e) {
            e.preventDefault();
            const $menu = $('#cellContextMenu');

            // Show first so outerWidth/Height are accurate
            $menu.show();

            const menuW = $menu.outerWidth();
            const menuH = $menu.outerHeight();
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const pad = 8; // viewport edge clearance

            // Viewport-relative for position:fixed
            let x = e.clientX;
            let y = e.clientY;

            // On mobile, if it's very narrow, we might want it centered or bottom-aligned
            // but for now let's just ensure it's within bounds.
            if (vw <= 767) {
                // If it's a mobile touch, we might want to center it a bit better or show as bottom sheet
                // The user said: "contextMenu cannot be opened and edited"
                // Let's position it near the touch but ensure it doesn't overflow
                if (x + menuW > vw) x = vw - menuW - pad;
                if (y + menuH > vh) y = vh - menuH - pad;
                if (x < pad) x = pad;
                if (y < pad) y = pad;
            } else {
                // Desktop flip logic
                if (x + menuW + pad > vw) x = Math.max(pad, x - menuW);
                if (y + menuH + pad > vh) y = Math.max(pad, vh - menuH - pad);
                if (y < pad) y = pad;
            }

            $menu.css({
                top: y + 'px',
                left: x + 'px',
                display: 'grid',
                position: 'fixed' // Ensure it's relative to viewport
            });

            window.cellBeingEdited = this;
        });


        // Hide context menus when clicking elsewhere
        $(document).on('click.hideMenu', function () {
            $('#cellContextMenu, #tabContextMenu').hide();
        });

        // Right-click context menu — shared handler for sp-option tabs and accordion headings
        function showTabContextMenu(e, target) {
            e.preventDefault();
            e.stopPropagation();
            window._tabCtxTarget = target;
            const $menu = $('#tabContextMenu');
            $menu.show();
            const menuW = $menu.outerWidth(), menuH = $menu.outerHeight();
            const vw = window.innerWidth, vh = window.innerHeight, pad = 8;
            let x = e.clientX, y = e.clientY;
            if (x + menuW + pad > vw) x = Math.max(pad, x - menuW);
            if (y + menuH + pad > vh) y = Math.max(pad, vh - menuH - pad);
            $menu.css({ top: y + 'px', left: x + 'px', display: 'grid', position: 'fixed' });
        }

        $container.off('contextmenu.spOption').on('contextmenu.spOption', '.sp-option', function (e) {
            showTabContextMenu(e, this);
        });

        $container.off('contextmenu.accordionHeading').on('contextmenu.accordionHeading', 'button.accordion', function (e) {
            showTabContextMenu(e, this);
        });

        // Returns true only when the active context is a table cell.
        // Uses window.tableHasFocus (set on cell mousedown / cleared on outside
        // mousedown) as the primary signal.  document.activeElement is unreliable
        // here because clicking a td/th inside a contenteditable div does not move
        // focus away from Monaco's last-focussed textarea.
        function isTableContext() {
            if (!window.currentTable || !window.tableHasFocus) return false;
            if ($('.inline-cell-editor').length) return false;
            // Secondary rejection: if something that can receive text input is
            // currently active, don't steal its Ctrl shortcuts.
            const active = document.activeElement;
            if (active && $(active).is('input, textarea, select, [contenteditable="true"]')) return false;
            return true;
        }

        $(document).off('keydown').on('keydown', function (e) {
            if (e.repeat) return;

            // Alt+D — toggle drag-and-drop (global, works outside table context)
            if (e.altKey && !e.shiftKey && e.code === 'KeyD') {
                if (!$(e.target).is('input, textarea, select, [contenteditable="true"]')) {
                    e.preventDefault();
                    $('#toggleDragDrop').trigger('click');
                    return;
                }
            }

            // Arrow-key table navigation (keyboard-first fallback included).
            if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
                // Don't hijack arrows while typing in editors/inputs.
                const typingTarget = $(e.target).is('input, textarea, select, [contenteditable="true"]');
                if (typingTarget || $('.inline-cell-editor').length) return;

                // Resolve active table if needed.
                if (!window.currentTable) {
                    window.currentTable = $('#tableContainer table')[0] || null;
                }
                if (!window.currentTable) return;

                const $table = $(window.currentTable);
                const mapper = new VisualGridMapper($table);
                const grid = mapper.grid || [];
                if (!grid.length) return;

                let currentCell = window.selectionHeadCell || window.selectedCells[window.selectedCells.length - 1];
                if (!currentCell) {
                    // Keyboard-only start: focus first available visual cell.
                    const firstVisual = grid[0] && grid[0][0] ? grid[0][0].element : null;
                    if (!firstVisual) return;
                    $table.find('.selected-cell').removeClass('selected-cell');
                    window.selectedCells = [firstVisual];
                    $(firstVisual).addClass('selected-cell');
                    currentCell = firstVisual;
                    window.selectionAnchorCell = firstVisual;
                    window.selectionHeadCell = firstVisual;
                }

                const currentPos = mapper.getVisualPosition(currentCell);
                if (!currentPos) return;

                let targetRow = currentPos.startRow;
                let targetCol = currentPos.startCol;

                if (e.key === "ArrowUp") targetRow--;
                if (e.key === "ArrowDown") targetRow++;
                if (e.key === "ArrowLeft") targetCol--;
                if (e.key === "ArrowRight") targetCol++;

                const rowData = grid[targetRow];
                const targetData = rowData ? rowData[targetCol] : null;
                if (!targetData || !targetData.element) return;

                e.preventDefault();
                const targetCell = targetData.element;
                if (e.shiftKey) {
                    // Expand selection from an anchor to the moving head.
                    if (!window.selectionAnchorCell) {
                        window.selectionAnchorCell = currentCell;
                    }
                    window.selectionHeadCell = targetCell;
                    selectRange(window.selectionAnchorCell, window.selectionHeadCell);
                } else {
                    // Move selection as a single active cell.
                    $table.find('.selected-cell').removeClass('selected-cell');
                    window.selectedCells = [targetCell];
                    $(targetCell).addClass('selected-cell');
                    window.selectionAnchorCell = targetCell;
                    window.selectionHeadCell = targetCell;
                }
                targetCell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                return;
            }

            const key = e.key.toLowerCase();
            const ctrl = e.ctrlKey || e.metaKey;

            if ((key === 'delete' || key === 'backspace') && !e.altKey && !e.shiftKey) {
                if (!isTableContext()) return;
                e.preventDefault();
                if (typeof deleteCell === 'function') deleteCell();
            } else if ((key === 'insert' || (ctrl && key === 'enter')) && !e.shiftKey && !e.repeat) {
                // Insert or Ctrl/Cmd+Enter → Add Cell After
                if (!isTableContext()) return;
                e.preventDefault();
                if (typeof addCell === 'function') addCell();
            } else if ((key === 'insert' || (ctrl && key === 'enter')) && e.shiftKey && !e.repeat) {
                // Shift+Insert or Shift+Ctrl/Cmd+Enter → Add Cell Before
                if (!isTableContext()) return;
                e.preventDefault();
                if (typeof addCellBefore === 'function') addCellBefore();
            } else if ((key === 'delete' || key === 'backspace') && e.shiftKey && !e.altKey) {
                // Shift+Delete/Backspace → Delete Cell
                if (!isTableContext()) return;
                e.preventDefault();
                if (typeof deleteCell === 'function') deleteCell();
            } else if (ctrl && key === 'a') {
                // Ctrl+A → Select all cells
                if (!isTableContext()) return;
                e.preventDefault();
                const $table = $(window.currentTable);
                const mapper = new VisualGridMapper($table);
                $table.find('.selected-cell').removeClass('selected-cell');
                window.selectedCells = [];
                mapper.cellMap.forEach((info, cell) => {
                    $(cell).addClass('selected-cell');
                    window.selectedCells.push(cell);
                });
                window.selectionAnchorCell = window.selectedCells[0] || null;
                window.selectionHeadCell = window.selectedCells[window.selectedCells.length - 1] || null;
            } else if (ctrl && !e.shiftKey && key === 'c') {
                // Ctrl/Cmd+C → Copy selected cells (only in table context; falls through to system copy otherwise)
                if (!isTableContext() || window.selectedCells.length === 0) return;
                e.preventDefault();
                if (typeof copySelected === 'function') copySelected();
            } else if (ctrl && e.shiftKey && key === 'v') {
                // Ctrl+Shift+V → Paste Before
                if (!isTableContext()) return;
                e.preventDefault();
                if (typeof pasteBefore === 'function') pasteBefore();
            } else if (ctrl && !e.shiftKey && key === 'v') {
                // Ctrl+V → Paste After
                if (!isTableContext()) return;
                e.preventDefault();
                if (typeof pasteAfter === 'function') pasteAfter();
            } else if (e.altKey && e.shiftKey && e.code === 'KeyW') {
                // Alt/Option+Shift+W → Merge (e.code avoids Mac Option producing Unicode chars)
                if (!isTableContext()) return;
                e.preventDefault();
                if (typeof mergeCells === 'function') mergeCells();
            } else if (e.altKey && e.shiftKey && e.code === 'KeyT') {
                // Alt/Option+Shift+T → Text Split modal
                if (!isTableContext()) return;
                e.preventDefault();
                $('#textSplitModal').modal('show');
            } else if (e.altKey && e.shiftKey && e.code === 'KeyX') {
                // Alt/Option+Shift+X → Apply text split
                if (!isTableContext()) return;
                e.preventDefault();
                if (typeof applyTextSplit === 'function') applyTextSplit();
            } else if (ctrl && key === 'z' && !e.shiftKey) {
                e.preventDefault();
                performUndo();
            }
            // Ctrl+Y or Ctrl+Shift+Z for redo
            else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) {
                e.preventDefault();
                performRedo();
            }
        });

        // Clear table focus when the user clicks anywhere outside the table container.
        // The td/th mousedown calls stopPropagation(), so this won't fire on cell clicks.
        $(document).off('mousedown.tableFocus').on('mousedown.tableFocus', function (e) {
            if (!$(e.target).closest('#tableContainer').length) {
                window.tableHasFocus = false;
            }
        });

        // Double click to edit cell
        $container.off('dblclick.cell').on('dblclick.cell', 'td, th', function (e) {
            //SAVE STATE BEFORE OPERATION
            window.saveCurrentState();

            window.cellBeingEdited = this;
            window.originalContent = $(this).html();

            const content = $(this).html();

            const $input = $('<textarea>')
                .addClass('inline-cell-editor')
                .val($('<div>').html(content).text())
                .css({
                    width: $(this).innerWidth(),
                    height: $(this).innerHeight(),
                    margin: 0,
                    padding: 0,
                    resize: 'none',
                    'box-sizing': 'border-box'
                });

            $('.inline-cell-editor').remove();
            $(this).empty().append($input);
            $input.focus().select();

            $input.off('click.preventSave').on('click.preventSave', function (e) {
                e.stopPropagation();
            });

            e.stopPropagation();
        });

        // Double click to rename tab labels — overlay input, never nest inside button
        $container.off('dblclick.tabLabel').on('dblclick.tabLabel', '.sp-option', function (e) {
            //SAVE STATE BEFORE OPERATION
            window.saveCurrentState();

            e.stopPropagation();
            const $btn = $(this);
            if ($btn.find('.tab-label-editor').length) return;

            const originalText = $btn.text().trim();
            const btnOffset = $btn.offset();
            const containerOffset = $container.offset();

            const $input = $('<input type="text">')
                .addClass('tab-label-editor')
                .val(originalText)
                .css({
                    position: 'absolute',
                    top: btnOffset.top - containerOffset.top,
                    left: btnOffset.left - containerOffset.left,
                    width: $btn.outerWidth(),
                    height: $btn.outerHeight(),
                    zIndex: 1000,
                    fontSize: $btn.css('font-size'),
                    textAlign: 'center',
                    boxSizing: 'border-box',
                    padding: '0 4px'
                });

            $container.css('position', 'relative').append($input);
            $input.focus().select();

            function commit() {
                const val = $input.val().trim() || originalText;
                $btn.text(val);
                $input.remove();
                window.saveCurrentState();
            }

            $input.on('blur', commit).on('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                if (e.key === 'Escape') { $input.remove(); }
            });
        });

        // Double click to rename accordion table headings
        $container.off('dblclick.tableHeading').on('dblclick.tableHeading', 'button.accordion', function (e) {
            //SAVE STATE BEFORE OPERATION
            window.saveCurrentState();

            e.stopPropagation();
            const $btn = $(this);
            const $label = $btn.find('b');
            if (!$label.length) return;

            const originalText = $label.text().trim();
            const btnOffset = $btn.offset();
            const containerOffset = $container.offset();

            const $input = $('<input type="text">')
                .addClass('tab-label-editor')
                .val(originalText)
                .css({
                    position: 'absolute',
                    top: btnOffset.top - containerOffset.top,
                    left: btnOffset.left - containerOffset.left,
                    width: $btn.outerWidth(),
                    height: $btn.outerHeight(),
                    zIndex: 1000,
                    fontSize: $btn.css('font-size'),
                    fontWeight: 'bold',
                    boxSizing: 'border-box',
                    padding: '0 8px'
                });

            $container.css('position', 'relative').append($input);
            $input.focus().select();

            function commit() {
                const val = $input.val().trim() || originalText;
                $label.text(val);
                $input.remove();
                window.saveCurrentState();
            }

            $input.on('blur', commit).on('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                if (e.key === 'Escape') { $input.remove(); }
            });
        });

        // Click elsewhere to save
        $(document).off('click.cell').on('click.cell', function (e) {
            if (!window.cellBeingEdited) return;
            const $editor = $('.inline-cell-editor');
            if ($editor.length === 0) return;
            if ($(e.target).closest(window.cellBeingEdited).length) {
                return;
            }
            window.saveCurrentState();
            const content = $('<span>').text($editor.val()).html();
            $(window.cellBeingEdited).html(content);
            $editor.remove();
            window.cellBeingEdited = null;
            window.originalContent = null;
        });

        // Save on Enter
        $(document).off('keydown.cellEditor').on('keydown.cellEditor', '.inline-cell-editor', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const $editor = $(this);
                const newContent = $('<div>').text($editor.val()).html();
                const $cell = $editor.closest('td, th');
                window.saveCurrentState();
                $cell.html(newContent);
                window.cellBeingEdited = null;
                $.toast({
                    heading: 'Success',
                    text: 'Cell edited successfully',
                    icon: 'success',
                    loader: false,
                    stack: false
                });
            } else if (e.key === 'Escape' && window.cellBeingEdited) {
                const $editor = $('.inline-cell-editor');
                if ($editor.length > 0) {
                    $(window.cellBeingEdited).html(window.originalContent);
                    $editor.remove();
                    window.cellBeingEdited = null;
                    window.originalContent = null;
                }
            }
        });

        // Rebuild rulers after any structural table operation
        if (typeof window.renderTableRulers === 'function') {
            requestAnimationFrame(() => {
                $('#tableContainer table.tablecoil').each(function () {
                    window.renderTableRulers(this);
                });
            });
        }
    }

    // Make setupTableInteraction globally accessible
    window.setupTableInteraction = setupTableInteraction;

    // =================== BEFORE/AFTER CELL OPTIONS (FIXED FOR POPPER V1) ===================
    const toolboxButtons = ['.addCell', '.addRow', '.addColumn', '.pasteCell'];

    toolboxButtons.forEach(selector => {
        const buttons = document.querySelectorAll(selector);
        const cellOptions = document.querySelector('.cell-options');

        if (!cellOptions) return;

        buttons.forEach(button => {
            if (!button) return;

            let popperInstance = null;
            let hideTimeout = null;

            const showCellOptions = (triggerElement) => {
                // Clear any pending hide
                if (hideTimeout) {
                    clearTimeout(hideTimeout);
                    hideTimeout = null;
                }

                cellOptions.style.display = 'block';

                // Destroy existing instance
                if (popperInstance) {
                    popperInstance.destroy();
                }

                // FIXED: Use Popper v1.x API (compatible with Bootstrap 4.1.3)
                // Popper v1.x uses 'new Popper()' not 'Popper.createPopper()'
                if (typeof Popper !== 'undefined') {
                    popperInstance = new Popper(triggerElement, cellOptions, {
                        placement: 'top',
                    });
                } else {
                    // Fallback if Popper is not available
                    const rect = triggerElement.getBoundingClientRect();
                    cellOptions.style.position = 'absolute';
                    cellOptions.style.top = (rect.top - cellOptions.offsetHeight - 10) + 'px';
                    cellOptions.style.left = rect.left + 'px';
                }

                // Setup click handlers
                const beforeCell = cellOptions.querySelector('.beforeCell');
                const afterCell = cellOptions.querySelector('.afterCell');

                // Remove previous listeners
                const newBeforeCell = beforeCell.cloneNode(true);
                const newAfterCell = afterCell.cloneNode(true);
                beforeCell.replaceWith(newBeforeCell);
                afterCell.replaceWith(newAfterCell);

                // Get fresh references
                const finalBeforeCell = cellOptions.querySelector('.beforeCell');
                const finalAfterCell = cellOptions.querySelector('.afterCell');

                // Add new listeners based on which button was hovered
                if (selector === '.addCell') {
                    finalBeforeCell.onclick = (e) => {
                        e.stopPropagation();
                        if (typeof addCellBefore === 'function') addCellBefore();
                        hideCellOptions();
                    };
                    finalAfterCell.onclick = (e) => {
                        e.stopPropagation();
                        if (typeof addCell === 'function') addCell();
                        hideCellOptions();
                    };
                } else if (selector === '.addRow') {
                    finalBeforeCell.onclick = (e) => {
                        e.stopPropagation();
                        if (typeof addRowBefore === 'function') addRowBefore();
                        hideCellOptions();
                    };
                    finalAfterCell.onclick = (e) => {
                        e.stopPropagation();
                        if (typeof addRow === 'function') addRow();
                        hideCellOptions();
                    };
                } else if (selector === '.addColumn') {
                    finalBeforeCell.onclick = (e) => {
                        e.stopPropagation();
                        if (typeof addColumnBefore === 'function') addColumnBefore();
                        hideCellOptions();
                    };
                    finalAfterCell.onclick = (e) => {
                        e.stopPropagation();
                        if (typeof addColumn === 'function') addColumn();
                        hideCellOptions();
                    };
                } else if (selector === '.pasteCell') {
                    finalBeforeCell.onclick = (e) => {
                        e.stopPropagation();
                        if (typeof pasteBefore === 'function') pasteBefore();
                        hideCellOptions();
                    };
                    finalAfterCell.onclick = (e) => {
                        e.stopPropagation();
                        if (typeof pasteAfter === 'function') pasteAfter();
                        hideCellOptions();
                    };
                }
            };

            const hideCellOptions = () => {
                hideTimeout = setTimeout(() => {
                    if (popperInstance) {
                        popperInstance.destroy();
                        popperInstance = null;
                    }
                    cellOptions.style.display = 'none';
                }, 200);
            };

            button.addEventListener('mouseenter', (e) => {
                showCellOptions(e.currentTarget);
            });

            cellOptions.addEventListener('mouseenter', () => {
                if (hideTimeout) {
                    clearTimeout(hideTimeout);
                    hideTimeout = null;
                }
            });

            cellOptions.addEventListener('mouseleave', () => {
                hideCellOptions();
            });
        });
    });

    // =================== EVENT HANDLERS ===================
    $('#generateTabs').on('click', function () {
        if ($('#tableContainer table').length > 0) {
            if (typeof generateTabs === 'function') generateTabs();
        } else {
            $.toast({ heading: 'Info', text: 'Please parse a table first', icon: 'warning', loader: false, stack: false });
        }
    });

    $('.undoHistory').on('click', function () {
        if ($('#tableContainer table').length > 0) {
            performUndo();
        } else {
            $.toast({ heading: 'Info', text: 'Please parse input', icon: 'warning', loader: false, stack: false });
        }
    });
    $('.redoHistory').on('click', function () {
        if ($('#tableContainer table').length > 0) {
            performRedo();
        } else {
            $.toast({ heading: 'Info', text: 'Please parse input', icon: 'warning', loader: false, stack: false });
        }
    });

    $('#toggleDragDrop').on('click', function () {
        window.dragDropEnabled = !window.dragDropEnabled;

        if (window.dragDropEnabled) {
            $(this).text('Enabled').css({ 'background-color': 'lightgreen', 'color': 'white' });
            if (typeof enableDragDrop === 'function') enableDragDrop();
        } else {
            $(this).text('Disabled').css({ 'border': '1px solid #999999', 'background-color': '#cccccc', 'color': '#666666' });
            if (typeof disableDragDrop === 'function') disableDragDrop();
        }
        // Sync toolbar switch
        $('#dragDropSwitch').prop('checked', window.dragDropEnabled);
    });

    $('.applyTextSplit').on('click', function () {
        if (typeof applyTextSplit === 'function') applyTextSplit();
    });

    $('.transposeTable').on('click', function () {
        if (typeof transposeTable === 'function') transposeTable();
    });

    $('.toggleCrosshair').on('click', function () {
        if (typeof toggleCrosshair === 'function') toggleCrosshair();
    });

    $('.applyStyle').on('click', function () {
        if (typeof applyStyle === 'function') applyStyle();
    });

    $('.duplicateElement').on('click', function () {
        if (typeof duplicateElement === 'function') duplicateElement();
    });

    $('.copyCell').on('click', function () {
        if (typeof copySelected === 'function') copySelected();
    });

    // Table Operations - Delete Operations
    $('.deleteCell').on('click', function () {
        if (window.selectedCells.length === 0) {
            $.toast({ heading: 'Info', text: 'Please select at least one cell to delete.', icon: 'warning', loader: false, stack: false });
            return;
        }
        if (typeof deleteCell === 'function') deleteCell();
    });

    $('.deleteRow').on('click', function () {
        if (window.selectedCells.length === 0) {
            $.toast({ heading: 'Info', text: 'Please select at least one cell to delete its row.', icon: 'warning', loader: false, stack: false });
            return;
        }
        if (typeof deleteRows === 'function') deleteRows();
    });

    $('.deleteColumn').on('click', function () {
        if (window.selectedCells.length === 0) {
            $.toast({ heading: 'Info', text: 'Please select at least one cell to delete its column.', icon: 'warning', loader: false, stack: false });
            return;
        }
        if (typeof deleteColumns === 'function') deleteColumns();
    });

    $('.mergeCells').on('click', function () {
        if (typeof mergeCells === 'function') mergeCells();
    });

    $('#applyClassId').on('click', function () {
        if (typeof applyClassId === 'function') applyClassId();
    });

    $('#basic-addon1').on('click', function () {
        $(this).toggleClass('sp-active');
    });

    $('#generateCode').on('click', function () {
        if (typeof generateCode === 'function') generateCode();
    });

    $('#copyInput').on('click', function () {
        if (typeof copyInput === 'function') copyInput();
    });

    $('.editCell').on('click', function () {
        // Multi-cell: open Monaco editor with TSV representation of the selection
        if (window.selectedCells && window.selectedCells.length > 1) {
            if (typeof window.openMultiCellEdit === 'function') window.openMultiCellEdit();
            return;
        }
        // Single-cell: original textarea modal
        if (!window.cellBeingEdited) return;
        const content = $(window.cellBeingEdited).html();
        $('#cellContent').val(content);
        $('#editCellModal').modal('show');
    });

    $('#applyMultiCellEdit').on('click', function () {
        if (typeof window.applyMultiCellEdit === 'function') window.applyMultiCellEdit();
    });

    // ── Tab context menu actions ──────────────────────────────────────────────
    // ── Tab context menu actions ──────────────────────────────────────────────
    // Both sp-option buttons and accordion headings share these handlers;
    // branch on the target's class to apply the right operation.

    function _isAccordionTarget() {
        return $(window._tabCtxTarget).hasClass('accordion');
    }

    function _makeAccordionPair(label) {
        const $acc = $('<button>').addClass('accordion active').html(`<b>${label}</b>`);
        const $panel = $('<div>').addClass('panel').html('<div class="sp-selector"></div>');
        return { $acc, $panel };
    }

    $('#tabCtxRename').on('click', function () {
        const $btn = $(window._tabCtxTarget);
        if ($btn.length) $btn.trigger('dblclick'); // reuse existing inline-rename flow for both types
        $('#tabContextMenu').hide();
    });

    $('#tabCtxAddAfter').on('click', function () {
        const $btn = $(window._tabCtxTarget);
        if (!$btn.length) return;
        window.saveCurrentState();

        if (_isAccordionTarget()) {
            const tableCount = $('#tableContainer .accordion').length + 1;
            const { $acc, $panel } = _makeAccordionPair(`Table ${tableCount}`);
            // Insert after accordion + its panel sibling
            $btn.next('.panel').after($panel).after($acc);
            window.setupTableInteraction();
        } else {
            const $selector = $btn.closest('.sp-selector');
            const nextVal   = $selector.find('.sp-option').length + 1;
            $btn.after(
                $('<button>').addClass('sp-option')
                    .attr({ 'data-value': nextVal, 'data-panel': $btn.data('panel') })
                    .text(nextVal)
            );
        }
        $('#tabContextMenu').hide();
    });

    $('#tabCtxAddBefore').on('click', function () {
        const $btn = $(window._tabCtxTarget);
        if (!$btn.length) return;
        window.saveCurrentState();

        if (_isAccordionTarget()) {
            const tableCount = $('#tableContainer .accordion').length + 1;
            const { $acc, $panel } = _makeAccordionPair(`Table ${tableCount}`);
            $btn.before($panel).before($acc);
            window.setupTableInteraction();
        } else {
            const $selector = $btn.closest('.sp-selector');
            const nextVal   = $selector.find('.sp-option').length + 1;
            $btn.before(
                $('<button>').addClass('sp-option')
                    .attr({ 'data-value': nextVal, 'data-panel': $btn.data('panel') })
                    .text(nextVal)
            );
        }
        $('#tabContextMenu').hide();
    });

    $('#tabCtxDelete').on('click', function () {
        const $btn = $(window._tabCtxTarget);
        if (!$btn.length) return;

        if (_isAccordionTarget()) {
            if ($('#tableContainer .accordion').length <= 1) {
                $.toast({ heading: 'Info', text: 'Cannot delete the only table section.', icon: 'warning', loader: false, stack: false });
                $('#tabContextMenu').hide();
                return;
            }
            window.saveCurrentState();
            $btn.next('.panel').remove();
            $btn.remove();
            window.setupTableInteraction();
        } else {
            const $selector = $btn.closest('.sp-selector');
            if ($selector.find('.sp-option').length <= 1) {
                $.toast({ heading: 'Info', text: 'Cannot delete the only tab.', icon: 'warning', loader: false, stack: false });
                $('#tabContextMenu').hide();
                return;
            }
            window.saveCurrentState();
            $btn.remove();
        }
        $('#tabContextMenu').hide();
    });

    $('#saveCellContent').on('click', function () {
        if (!window.cellBeingEdited) return;

        const newContent = $('#cellContent').val();
        window.saveCurrentState();
        $(window.cellBeingEdited).html(newContent);

        $('#editCellModal').modal('hide');
        window.cellBeingEdited = null;
    });

    $('.textSplit').on('click', function () {
        if (window.selectedCells.length === 0) {
            $.toast({ heading: 'Info', text: 'Please select exactly one cell to split.', icon: 'warning', loader: false, stack: false });
            return;
        }
        $('#textSplitModal').modal('show');
    });

    // =================== LEFT PANEL TOGGLE ===================
    $('#toggleLeftPanel').on('click', function () {
        const $panel = $('.tifany-left-panel');
        $panel.toggleClass('panel-hidden');
        const isHidden = $panel.hasClass('panel-hidden');
        $(this).attr('title', isHidden ? 'Show Tools Panel' : 'Hide Tools Panel');
        $(this).toggleClass('active', !isHidden);
    });

    // =================== RIGHT PANEL RESIZE ===================
    (function () {
        var $handle = $('.right-panel-resize-handle');
        var $panel = $('.tifany-right-panel');
        if (!$handle.length || !$panel.length) return;

        var startX, startWidth;

        $handle.on('mousedown', function (e) {
            e.preventDefault();
            startX = e.clientX;
            startWidth = $panel.outerWidth();
            $handle.addClass('dragging');
            $('body').css({ cursor: 'col-resize', 'user-select': 'none' });

            $(document).on('mousemove.rightResize', function (e) {
                var delta = startX - e.clientX;
                var newWidth = Math.min(600, Math.max(220, startWidth + delta));
                $panel.css('width', newWidth + 'px');
            });

            $(document).on('mouseup.rightResize', function () {
                $handle.removeClass('dragging');
                $('body').css({ cursor: '', 'user-select': '' });
                $(document).off('mousemove.rightResize mouseup.rightResize');
            });
        });
    })();

    // =================== LAB MODE TOGGLE ===================
    $('#labModeToggle').on('click', function () {
        if (typeof toggleLab === 'function') toggleLab();
    });

    // =================== NODE EDITOR TOGGLE ===================
    // (initNodeEditor wires the button; this disables it from selectToolToggle context)

    // Select tool toggle (visual only; normal mode indicator)
    $('#selectToolToggle').on('click', function () {
        if (window.labModeEnabled && typeof disableLab === 'function') {
            disableLab();
        }
        if (window.nodeEditorEnabled && typeof disableNodeEditor === 'function') {
            disableNodeEditor();
        }
        $(this).addClass('active');
    });

    // =================== DRAG & DROP SWITCH (toolbar) ===================
    $('#dragDropSwitch').on('change', function () {
        window.dragDropEnabled = $(this).prop('checked');
        if (window.dragDropEnabled) {
            if (typeof enableDragDrop === 'function') enableDragDrop();
            $('#toggleDragDrop').text('Enabled').css({ 'background-color': 'lightgreen', 'color': 'white' });
        } else {
            if (typeof disableDragDrop === 'function') disableDragDrop();
            $('#toggleDragDrop').text('Toggle Drag & Drop').css({ 'border': '1px solid #999999', 'background-color': '#cccccc', 'color': '#666666' });
        }
    });

    // =================== DECOUPLED TAB COUNT ===================
    // Changing #buttonIndex only updates the tab buttons; never re-renders the table
    $('#buttonIndex').on('change', function () {
        let count = Math.min(100, Math.max(1, parseInt($(this).val()) || 1));
        $(this).val(count);

        const $panel = $('#tableContainer .panel');
        if ($panel.length === 0) return;

        let tabsHtml = '<div class="sp-selector">\n';
        for (let i = 1; i <= count; i++) {
            tabsHtml += `<button class="sp-option" data-value="${i}" data-panel="0">${i}</button>\n`;
        }
        tabsHtml += '</div>';

        const $existing = $panel.find('.sp-selector');
        if ($existing.length) {
            $existing.replaceWith(tabsHtml);
        } else {
            $panel.prepend(tabsHtml);
        }
    });

    // =================== FILE LOAD BUTTON ===================
    $('#loadFileBtn').on('click', function () {
        $('#fileInput').val('').trigger('click');
    });

    $('#fileInput').on('change', function () {
        const file = this.files[0];
        if (file && typeof handleFileLoad === 'function') {
            handleFileLoad(file);
        }
    });

    // =================== INPUT MODAL OPEN ===================
    $('#inputModalBtn').on('click', function () {
        $('#inputModal').modal('show');
        // Trigger Monaco layout refresh after modal becomes visible
        setTimeout(function () {
            if (window.tifanyMonacoInput) {
                window.tifanyMonacoInput.layout();
            }
        }, 200);
    });

    // =================== PARSE INSIDE MODAL ===================
    $('#parseInputModal').on('click', function () {
        if (typeof parseInput === 'function') parseInput();
    });

    // =================== LAB CANVAS INIT ===================
    if (typeof initLabCanvas === 'function') initLabCanvas();

    // =================== NODE EDITOR INIT ===================
    if (typeof initNodeEditor === 'function') initNodeEditor();

    // Initialize
    initializeAllFeatures();
});