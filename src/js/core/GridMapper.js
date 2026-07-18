export class GridMapper {
    constructor(table) {
        if (!table || table.tagName !== 'TABLE') throw new Error('GridMapper requires a <table> element');
        this.table = table;
        this.grid = [];
        this.cellMap = new Map();
        this.buildGrid();
    }

    buildGrid() {
        this.grid = [];
        this.cellMap = new Map();
        const rows = this.table.querySelectorAll('tr');
        let maxCols = 0;

        rows.forEach((row, rowIndex) => {
            this.grid[rowIndex] = this.grid[rowIndex] || [];
        });

        rows.forEach((row, rowIndex) => {
            let colIndex = 0;
            row.querySelectorAll('td, th').forEach(cell => {
                const colspan = parseInt(cell.getAttribute('colspan') || '1', 10);
                const rowspan = parseInt(cell.getAttribute('rowspan') || '1', 10);

                while (this.grid[rowIndex][colIndex] !== undefined) colIndex++;

                this.cellMap.set(cell, {
                    rowspan,
                    colspan,
                    content: cell.innerHTML,
                    isHeader: cell.tagName === 'TH',
                    startRow: rowIndex,
                    startCol: colIndex
                });

                for (let r = 0; r < rowspan; r++) {
                    if (!this.grid[rowIndex + r]) this.grid[rowIndex + r] = [];
                    for (let c = 0; c < colspan; c++) {
                        this.grid[rowIndex + r][colIndex + c] = {
                            element: cell,
                            isOrigin: r === 0 && c === 0
                        };
                    }
                }

                colIndex += colspan;
            });

            maxCols = Math.max(maxCols, colIndex);
        });

        this.maxCols = maxCols;
        this.maxRows = this.grid.length;
    }

    getCellsInRow(rowIndex) {
        const cells = new Set();
        if (this.grid[rowIndex]) {
            this.grid[rowIndex].forEach(gridCell => {
                if (gridCell) cells.add(gridCell.element);
            });
        }
        return Array.from(cells);
    }

    getCellsInColumn(colIndex) {
        const cells = new Set();
        this.grid.forEach(row => {
            if (row && row[colIndex]) cells.add(row[colIndex].element);
        });
        return Array.from(cells);
    }

    getVisualPosition(cell) {
        return this.cellMap.get(cell) || null;
    }
}
