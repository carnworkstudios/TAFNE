// ====================================== DRAG AND DROP ================================================
    // Global variables for drag and drop
    let dragDropEnabled = false;
    let draggedElement = null;
    let dragType = null; // 'cell', 'row', or 'column'

    function enableDragDrop() {
        if (!currentTable) return;
        const $table = $(currentTable);
        const mapper = new window.VisualGridMapper($table);

        // Make the table a positioning context for absolute elements
        $table.css({
            'position': 'relative',
            'cursor': 'move'
        });

        // --- Enable ROW dragging ---
        $table.find('tr').each(function () {
            // Add a handle to the start of the row for dragging
            $(this).prepend('<td class="drag-handle row-handle">::</td>');
        });
        $table.on('mousedown.drag', '.row-handle', function (e) {
            startRowDrag($(this).parent('tr')[0], e);
        });

        // --- Enable COLUMN dragging ---
        let maxCols = mapper.maxCols;
        if (maxCols === 0) maxCols = 1;

        // Inject dedicated drag handle row at the top
        // Start with an empty spacer to align with the row-handle column
        let dragRowHtml = '<tr class="tifany-drag-row ignore-export" style="background:var(--t-bg-workspace); border-bottom:2px solid var(--t-primary);">';
        dragRowHtml += '<td class="drag-handle drag-row-spacer" style="width:20px; padding:0;"></td>';
        for (let i = 0; i < maxCols; i++) {
            dragRowHtml += `<td class="drag-handle col-handle" data-col-index="${i}" style="text-align:center; font-weight:bold; color:var(--t-primary); cursor:ew-resize; padding:4px;">::</td>`;
        }
        dragRowHtml += '</tr>';
        
        if ($table.find('thead').length) {
            $table.find('thead').prepend(dragRowHtml);
        } else if ($table.find('tbody').length) {
            $table.find('tbody').prepend(dragRowHtml);
        } else {
            $table.prepend(dragRowHtml);
        }

        $table.on('mousedown.drag', '.col-handle', function (e) {
            const colIndex = parseInt($(this).attr('data-col-index'), 10);
            startColumnDrag(colIndex, e);
        });

        // --- Enable CELL dragging ---
        $table.on('mousedown.drag', 'td:not(.drag-handle), th:not(.drag-handle)', function (e) {
            startCellDrag(this, e);
        });
    }

    function disableDragDrop() {
        if (!currentTable) return;
        const $table = $(currentTable);

        // Remove the relative positioning
        $table.css({
            'position': '',
            'cursor': 'cell'
        });

        // Remove all event listeners namespaced with .drag
        $table.off('.drag');

        // Remove handles and the custom drag row
        $table.find('.drag-handle').remove();
        $table.find('.tifany-drag-row').remove();

        // Clean up any active drag indicators
        endDrag();
    }

    // ===================================================================
    // DRAG ACTION STARTERS
    // ===================================================================

    function startCellDrag(cell, e) {
        //SAVE STATE BEFORE OPERATION
            window.saveCurrentState();

        e.preventDefault();
        e.stopPropagation();

        dragType = 'cell';
        draggedElement = cell;
        const $cell = $(cell);
        $cell.addClass('dragging');

        // On mouse up ANYWHERE, end the drag
        $(document).one('mouseup', endDrag);

        // Add listeners to potential drop targets
        $(currentTable).find('td, th').on('mouseenter.drag', function () {
            // Don't allow dropping on the element being dragged
            if (this !== draggedElement) {
                $('.drag-over').removeClass('drag-over');
                $(this).addClass('drag-over');
            }
        }).on('mouseup.drag', function () {
            // On mouseup over a valid target, perform the swap
            const dropTarget = this;
            if (draggedElement && dropTarget !== draggedElement) {
                swapCells(draggedElement, dropTarget);
            }
        });
    }

    function startRowDrag(row, e) {
        //SAVE STATE BEFORE OPERATION
            window.saveCurrentState();

        e.preventDefault();
        e.stopPropagation();

        dragType = 'row';
        draggedElement = row;
        $(row).addClass('row-dragging');

        // Create drop indicators between rows
        $(currentTable).find('tr').each(function () {
            if (this !== draggedElement && !$(this).hasClass('tifany-drag-row')) {
                $(this).before('<tr class="drop-indicator-row"><td colspan="999"></td></tr>');
            }
        });
        $(currentTable).append('<tr class="drop-indicator-row"><td colspan="999"></td></tr>');

        $(document).one('mouseup', endDrag);

        $(currentTable).on('mouseup.drag', '.drop-indicator-row', function () {
            moveRow(draggedElement, this);
        });
    }

    let colDropTarget = -1; // tracks the target column index during column drag

    function startColumnDrag(colIndex, e) {
        //SAVE STATE BEFORE OPERATION
            window.saveCurrentState();

        e.preventDefault();
        e.stopPropagation();

        dragType = 'column';
        draggedElement = colIndex; // keep as number
        colDropTarget = -1;

        const mapper = new window.VisualGridMapper(currentTable);
        // Offset: visual column 0 in the mapper is the row-handle column,
        // so data-col-index N corresponds to mapper column N+1
        const COL_OFFSET = 1;

        // highlight dragged column visually
        const cellsInCol = mapper.getCellsInColumn(colIndex + COL_OFFSET);
        $(cellsInCol).not('.drag-handle').addClass('column-dragging');

        // Build a lookup of column boundaries from the drag-row handles
        const $dragRow = $(currentTable).find('.tifany-drag-row');
        const colEdges = []; // array of { left, right, colIdx }
        $dragRow.find('.col-handle').each(function () {
            const rect = this.getBoundingClientRect();
            const idx = parseInt($(this).attr('data-col-index'), 10);
            colEdges.push({ left: rect.left, right: rect.right, center: (rect.left + rect.right) / 2, colIdx: idx });
        });

        // On mousemove, determine which column gap the cursor is closest to
        $(document).on('mousemove.coldrag', function (ev) {
            if (colEdges.length === 0) return;

            // Find which column the mouse is over or between
            let targetCol = -1;
            for (let i = 0; i < colEdges.length; i++) {
                if (ev.clientX < colEdges[i].center) {
                    targetCol = colEdges[i].colIdx;
                    break;
                }
            }
            // Past the last column center → drop after last column
            if (targetCol === -1) {
                targetCol = colEdges[colEdges.length - 1].colIdx + 1;
            }

            if (targetCol !== colDropTarget) {
                colDropTarget = targetCol;

                // Clear previous target highlights
                $dragRow.find('.col-handle').removeClass('col-drop-target col-drop-target-left col-drop-target-right');
                $(currentTable).find('.column-drop-target').removeClass('column-drop-target');

                // Highlight the border between columns in the drag row
                if (targetCol < mapper.maxCols) {
                    $dragRow.find('.col-handle[data-col-index="' + targetCol + '"]').addClass('col-drop-target col-drop-target-left');
                }
                if (targetCol > 0) {
                    $dragRow.find('.col-handle[data-col-index="' + (targetCol - 1) + '"]').addClass('col-drop-target col-drop-target-right');
                }

                // Highlight the target column cells with green so user sees where it will land
                // Show the column that will be displaced (the one at targetCol, if it exists)
                if (targetCol + COL_OFFSET < mapper.maxCols && targetCol !== colIndex) {
                    const targetCells = mapper.getCellsInColumn(targetCol + COL_OFFSET);
                    $(targetCells).not('.drag-handle').addClass('column-drop-target');
                }
            }
        });

        // On mouseup anywhere, perform the column move
        $(document).one('mouseup.drag', function () {
            //SAVE STATE BEFORE OPERATION
            window.saveCurrentState();

            $(document).off('mousemove.coldrag');
            if (colDropTarget >= 0 && colDropTarget !== colIndex) {
                console.log('moveColumn called from', draggedElement, 'to', colDropTarget);
                moveColumn(draggedElement, colDropTarget);
            } else {
                endDrag();
            }
        });
    }

    // ===================================================================
    // DRAG ACTIONS
    // ===================================================================

    function swapCells(cell1, cell2) {
        //SAVE STATE BEFORE OPERATION
            window.saveCurrentState();
            
        const $cell1 = $(cell1);
        const $cell2 = $(cell2);

        // A simple and effective way to swap DOM elements
        const $temp = $('<div>');
        $cell1.after($temp);
        $cell2.after($cell1);
        $temp.after($cell2).remove();
    }

    function moveRow(draggedRow, indicator) {
        //SAVE STATE BEFORE OPERATION
            window.saveCurrentState();

        console.log('moveRow called from', indicator, 'to', draggedRow);
        $(indicator).after(draggedRow);
    }

    function moveColumn(fromIndex, toIndex) {
        //SAVE STATE BEFORE OPERATION
            window.saveCurrentState();

        if (fromIndex === toIndex || fromIndex + 1 === toIndex) { // no-op if identical or adjacent same spot
            endDrag();
            return;
        }

        const $table = $(currentTable);
        const mapper = new window.VisualGridMapper($table);
        const movedElements = new Set(); // avoid moving a cell twice (colspan spans multiple grid rows)

        // Offset: visual column 0 in the mapper is the row-handle column,
        // so data-col-index N corresponds to mapper column N+1
        const COL_OFFSET = 1;
        const mapperFrom = fromIndex + COL_OFFSET;
        const mapperTo = toIndex + COL_OFFSET;

        for (let r = 0; r < mapper.maxRows; r++) {
            const rowData = mapper.grid[r];
            if (!rowData) continue;

            // Skip the drag-handle row; we'll reorder its handles separately
            const rowEl = $table.find('tr').eq(r);
            if (rowEl.hasClass('tifany-drag-row')) continue;

            const fromCellData = rowData[mapperFrom];

            // Only move origin cells mapped to this visual column (skip already-moved spanned cells)
            if (fromCellData && fromCellData.isOrigin && !movedElements.has(fromCellData.element)) {
                movedElements.add(fromCellData.element);
                const $moving = $(fromCellData.element);

                // Skip drag handles
                if ($moving.hasClass('drag-handle')) continue;

                let targetCellData = rowData[mapperTo];

                if (targetCellData && targetCellData.isOrigin && targetCellData.element !== fromCellData.element) {
                    // Insert immediately before the target origin cell
                    $(targetCellData.element).before($moving);
                } else if (!targetCellData) {
                    // Past the end of the row; append
                    $moving.closest('tr').append($moving);
                } else {
                    // Target is inside a colspan that started before mapperTo
                    // Find the next origin cell to the right and insert before it
                    let foundOrigin = null;
                    for (let c = mapperTo; c < mapper.maxCols; c++) {
                        if (rowData[c] && rowData[c].isOrigin && rowData[c].element !== fromCellData.element) {
                            foundOrigin = rowData[c].element;
                            break;
                        }
                    }
                    if (foundOrigin) {
                        $(foundOrigin).before($moving);
                    } else {
                        $moving.closest('tr').append($moving);
                    }
                }
            }
        }

        // Reorder the col-handle in the drag row to match
        const $dragRow = $table.find('.tifany-drag-row');
        const $handles = $dragRow.find('.col-handle');
        const $fromHandle = $handles.eq(fromIndex);

        // Adjust target: if moving right, account for the fact that removing from shifts indices
        const adjustedTo = (toIndex > fromIndex) ? toIndex - 1 : toIndex;
        const $targetHandle = $handles.eq(adjustedTo);

        if (toIndex > fromIndex) {
            $targetHandle.after($fromHandle);
        } else {
            $targetHandle.before($fromHandle);
        }

        // Re-index all handles
        $dragRow.find('.col-handle').each(function(idx) {
            $(this).attr('data-col-index', idx);
        });

        if (typeof window.saveCurrentState === 'function') window.saveCurrentState();

        endDrag();
    }

    // ===================================================================
    // END DRAG
    // ===================================================================

    function endDrag() {
        // Remove all visual indicators
        $('.dragging, .row-dragging, .column-dragging, .drag-over').removeClass('dragging row-dragging column-dragging drag-over');
        $('.col-drop-target, .col-drop-target-left, .col-drop-target-right').removeClass('col-drop-target col-drop-target-left col-drop-target-right');
        $('.column-drop-target').removeClass('column-drop-target');
        $('.drop-indicator-row').remove();

        // Remove column drag mousemove listener
        $(document).off('mousemove.coldrag');

        // Remove all temporary drag-related event listeners
        if (currentTable) {
            $(currentTable).find('td, th').off('mouseenter.drag mouseup.drag');
            $(currentTable).off('mouseup.drag');
        }

        // Reset state
        draggedElement = null;
        dragType = null;
        colDropTarget = -1;
    }