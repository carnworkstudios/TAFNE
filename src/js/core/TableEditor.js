import { GridMapper } from './GridMapper.js';
import { HistoryManager } from './HistoryManager.js';

export class TableEditor {
    constructor(tableEl, options = {}) {
        if (!tableEl || tableEl.tagName !== 'TABLE')
            throw new Error('TableEditor requires a <table> element');

        this.table = tableEl;
        this._selectedCells = [];
        this._clipboard = [];
        this._eventHandlers = {};
        this._ruler = null;

        this.grid = new GridMapper(this.table);
        this.history = new HistoryManager(this.table, {
            onChange: (state) => this._emit('historyChange', state)
        });

        if (options.ruler) this._createRuler();
        this._emit('ready', { table: this.table });
    }

    // ── Selection ─────────────────────────────────────────────────────────

    get selectedCells() {
        return this._selectedCells;
    }

    selectCell(cell) {
        this._clearSelectedClass();
        this._selectedCells = [cell];
        this._addSelectedClass(cell);
        this._emit('select', { cells: this._selectedCells });
    }

    selectCells(cells) {
        this._clearSelectedClass();
        this._selectedCells = Array.from(cells);
        this._selectedCells.forEach(c => this._addSelectedClass(c));
        this._emit('select', { cells: this._selectedCells });
    }

    selectRow(rowIndex) {
        this.grid = new GridMapper(this.table);
        const cells = this.grid.getCellsInRow(rowIndex);
        this.selectCells(cells);
    }

    selectColumn(colIndex) {
        this.grid = new GridMapper(this.table);
        const cells = this.grid.getCellsInColumn(colIndex);
        this.selectCells(cells);
    }

    clearSelection() {
        this._clearSelectedClass();
        this._selectedCells = [];
        this._emit('select', { cells: [] });
    }

    _clearSelectedClass() {
        this.table.querySelectorAll('.selected-cell').forEach(el => el.classList.remove('selected-cell'));
    }

    _addSelectedClass(cell) {
        cell.classList.add('selected-cell');
    }

    // ── Row operations ────────────────────────────────────────────────────

    addRow(before = false) {
        if (this._selectedCells.length === 0) return this._warn('Select a cell first');
        const row = this._selectedCells[0].closest('tr');
        if (!row) return;
        const colCount = new GridMapper(this.table).maxCols;
        const html = `<tr>${'<td></td>'.repeat(colCount)}</tr>`;
        if (before) row.insertAdjacentHTML('beforebegin', html);
        else row.insertAdjacentHTML('afterend', html);
        this._afterMutate();
    }

    deleteRow() {
        if (this._selectedCells.length === 0) return this._warn('Select a row first');
        const rows = new Set();
        this._selectedCells.forEach(cell => rows.add(cell.closest('tr')));
        rows.forEach(r => r.remove());
        this._afterMutate();
    }

    // ── Column operations ─────────────────────────────────────────────────

    addColumn(before = false) {
        if (this._selectedCells.length === 0) return this._warn('Select a cell first');
        this.grid = new GridMapper(this.table);
        const cell = this._selectedCells[0];
        const pos = this.grid.getVisualPosition(cell);
        if (!pos) return;
        const targetCol = before ? pos.startCol : pos.startCol + pos.colspan - 1;
        for (let rowIdx = 0; rowIdx < this.grid.maxRows; rowIdx++) {
            const gridCell = this.grid.grid[rowIdx]?.[targetCol];
            if (!gridCell || !gridCell.isOrigin) continue;
            const tag = gridCell.element.tagName.toLowerCase();
            gridCell.element.insertAdjacentHTML('afterend', `<${tag}></${tag}>`);
        }
        this._afterMutate();
    }

    deleteColumn() {
        if (this._selectedCells.length === 0) return this._warn('Select a column first');
        this.grid = new GridMapper(this.table);
        const cols = new Set();
        this._selectedCells.forEach(cell => {
            const pos = this.grid.getVisualPosition(cell);
            if (pos) cols.add(pos.startCol);
        });
        const sorted = Array.from(cols).sort((a, b) => b - a);
        sorted.forEach(colIndex => {
            this.grid.getCellsInColumn(colIndex).forEach(cell => cell.remove());
        });
        this._afterMutate();
    }

    // ── Cell operations ───────────────────────────────────────────────────

    addCell(before = false) {
        if (this._selectedCells.length === 0) return this._warn('Select a cell first');
        this._selectedCells.forEach(cell => {
            const tag = cell.tagName.toLowerCase();
            if (before) cell.insertAdjacentHTML('beforebegin', `<${tag}></${tag}>`);
            else cell.insertAdjacentHTML('afterend', `<${tag}></${tag}>`);
        });
        this._afterMutate();
    }

    deleteCell() {
        if (this._selectedCells.length === 0) return this._warn('Select a cell first');
        this._selectedCells.forEach(cell => cell.remove());
        this._selectedCells = [];
        this._afterMutate();
    }

    mergeCells() {
        const cells = this._selectedCells;
        if (cells.length < 2) return this._warn('Select at least 2 adjacent cells');
        this.grid = new GridMapper(this.table);
        const info = cells.map(c => ({ cell: c, pos: this.grid.getVisualPosition(c) })).filter(i => i.pos);
        if (info.length < 2) return;
        info.sort((a, b) => a.pos.startRow - b.pos.startRow || a.pos.startCol - b.pos.startCol);
        const first = info[0];
        const rows = new Set(info.map(i => i.pos.startRow));
        const cols = new Set(info.map(i => i.pos.startCol));
        const isHorizontal = rows.size === 1 && cols.size > 1;
        const isVertical = cols.size === 1 && rows.size > 1;
        const isRect = rows.size > 1 && cols.size > 1;

        if (!isHorizontal && !isVertical && !isRect) return;

        if (isRect) {
            this._rectMerge(info);
            return;
        }

        let colspan = first.pos.colspan;
        let rowspan = first.pos.rowspan;
        let content = [first.cell.innerHTML];
        for (let i = 1; i < info.length; i++) {
            if (isHorizontal) colspan += info[i].pos.colspan;
            if (isVertical) rowspan += info[i].pos.rowspan;
            content.push(info[i].cell.innerHTML);
            info[i].cell.remove();
        }
        first.cell.innerHTML = content.join(' ');
        if (colspan > 1) first.cell.setAttribute('colspan', String(colspan));
        if (rowspan > 1) first.cell.setAttribute('rowspan', String(rowspan));
        this._afterMutate();
    }

    _rectMerge(info) {
        const minRow = Math.min(...info.map(i => i.pos.startRow));
        const maxRow = Math.max(...info.map(i => i.pos.startRow));
        const minCol = Math.min(...info.map(i => i.pos.startCol));
        const maxCol = Math.max(...info.map(i => i.pos.startCol));
        const allContent = [];
        const survivors = [];
        for (let r = minRow; r <= maxRow; r++) {
            const row = info.filter(i => i.pos.startRow === r).sort((a, b) => a.pos.startCol - b.pos.startCol);
            allContent.push(...row.map(i => i.cell.innerHTML));
            for (let j = 1; j < row.length; j++) row[j].cell.remove();
            row[0].cell.setAttribute('colspan', String(maxCol - minCol + 1));
            survivors.push(row[0].cell);
        }
        const top = survivors[0];
        top.innerHTML = allContent.join(' ');
        top.setAttribute('rowspan', String(maxRow - minRow + 1));
        for (let i = 1; i < survivors.length; i++) survivors[i].remove();
    }

    duplicate() {
        if (this._selectedCells.length === 0) return this._warn('Select a cell first');
        this._selectedCells.forEach(cell => {
            cell.insertAdjacentHTML('afterend', cell.outerHTML);
        });
        this._afterMutate();
    }

    // ── Clipboard ─────────────────────────────────────────────────────────

    copy() {
        if (this._selectedCells.length === 0) return this._warn('Select cells first');
        this._clipboard = this._selectedCells.map(c => c.outerHTML);
        this._emit('copy', { count: this._clipboard.length });
    }

    paste(before = false) {
        if (this._selectedCells.length === 0 || this._clipboard.length === 0) return;
        this._selectedCells.forEach(target => {
            if (before) {
                for (let i = this._clipboard.length - 1; i >= 0; i--)
                    target.insertAdjacentHTML('beforebegin', this._clipboard[i]);
            } else {
                let anchor = target;
                for (let i = 0; i < this._clipboard.length; i++) {
                    anchor.insertAdjacentHTML('afterend', this._clipboard[i]);
                    anchor = anchor.nextElementSibling;
                }
            }
        });
        this._afterMutate();
    }

    // ── Move / reorder ────────────────────────────────────────────────────

    moveRow(fromIndex, toIndex) {
        this.grid = new GridMapper(this.table);
        const rows = Array.from(this.table.querySelectorAll('tr'));
        const fromRow = rows[fromIndex];
        const toRow = rows[toIndex];
        if (!fromRow || !toRow) return;
        if (toIndex > fromIndex) toRow.insertAdjacentElement('afterend', fromRow);
        else toRow.insertAdjacentElement('beforebegin', fromRow);
        this._afterMutate();
    }

    moveColumn(fromIndex, toIndex) {
        this.grid = new GridMapper(this.table);
        const fromCells = this.grid.getCellsInColumn(fromIndex);
        const toCells = this.grid.getCellsInColumn(toIndex);
        if (!fromCells.length || !toCells.length) return;
        const originFrom = fromCells.filter(c => {
            const p = this.grid.getVisualPosition(c);
            return p && p.startCol === fromIndex;
        });
        const originTo = toCells.filter(c => {
            const p = this.grid.getVisualPosition(c);
            return p && p.startCol === toIndex;
        });
        originFrom.forEach((cell, i) => {
            const target = originTo[i];
            if (!target) return;
            if (fromIndex < toIndex) target.insertAdjacentElement('afterend', cell);
            else target.insertAdjacentElement('beforebegin', cell);
        });
        this._afterMutate();
    }

    // ── Drag-move (inline, for contenteditable-style moving) ─────────────

    enableDragMove() {
        this.table.querySelectorAll('td, th').forEach(cell => {
            cell.setAttribute('draggable', 'true');
            cell.addEventListener('dragstart', this._onDragStart = (e) => {
                this._dragCell = cell;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', '');
                cell.classList.add('dragging');
            });
            cell.addEventListener('dragend', () => {
                cell.classList.remove('dragging');
                this._dragCell = null;
            });
            cell.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (this._dragCell && cell !== this._dragCell) cell.classList.add('drag-over');
            });
            cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
            cell.addEventListener('drop', (e) => {
                e.preventDefault();
                cell.classList.remove('drag-over');
                if (!this._dragCell || cell === this._dragCell) return;
                const rect = cell.getBoundingClientRect();
                const after = e.clientY > rect.top + rect.height / 2;
                if (after) cell.insertAdjacentElement('afterend', this._dragCell);
                else cell.insertAdjacentElement('beforebegin', this._dragCell);
                this._afterMutate();
            });
        });
    }

    disableDragMove() {
        this.table.querySelectorAll('td, th').forEach(cell => {
            cell.removeAttribute('draggable');
            cell.removeEventListener('dragstart', this._onDragStart);
        });
    }

    // ── Serialization ─────────────────────────────────────────────────────

    getHTML() {
        return this.table.outerHTML;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    destroy() {
        this.disableDragMove();
        this.clearSelection();
        this.history.clear();
        this._eventHandlers = {};
        this._clipboard = [];
        this._destroyRuler();
    }

    // ── Ruler ─────────────────────────────────────────────────────────────

    _createRuler() {
        if (this._ruler) return;
        const wrap = document.createElement('div');
        wrap.className = 'tafne-ruler-wrap';
        this.table.parentNode?.insertBefore(wrap, this.table);
        wrap.appendChild(this.table);

        const headerRow = document.createElement('div');
        headerRow.className = 'tafne-ruler-header';
        const corner = document.createElement('div');
        corner.className = 'tafne-corner';
        headerRow.appendChild(corner);

        const colRuler = document.createElement('div');
        colRuler.className = 'tafne-col-ruler';
        headerRow.appendChild(colRuler);
        wrap.appendChild(headerRow);

        const bodyRow = document.createElement('div');
        bodyRow.className = 'tafne-ruler-body';
        const rowRuler = document.createElement('div');
        rowRuler.className = 'tafne-row-ruler';
        bodyRow.appendChild(rowRuler);
        bodyRow.appendChild(this.table);
        wrap.appendChild(bodyRow);

        this.grid = new GridMapper(this.table);
        this._buildColRuler(colRuler);
        this._buildRowRuler(rowRuler);
        this._ruler = wrap;
    }

    _buildColRuler(container) {
        container.innerHTML = '';
        for (let c = 0; c < this.grid.maxCols; c++) {
            const seg = document.createElement('div');
            seg.className = 'ruler-seg';
            seg.textContent = String.fromCharCode(65 + c);
            seg.dataset.col = c;
            seg.addEventListener('click', () => this.selectColumn(c));
            const del = document.createElement('span');
            del.className = 'ruler-del';
            del.textContent = '\u00D7';
            del.addEventListener('click', (e) => { e.stopPropagation(); this.selectColumn(c); this.deleteColumn(); });
            seg.appendChild(del);
            container.appendChild(seg);
        }
        const addBtn = document.createElement('div');
        addBtn.className = 'ruler-add';
        addBtn.textContent = '+';
        addBtn.addEventListener('click', () => {
            if (this._selectedCells.length) this.addColumn();
        });
        container.appendChild(addBtn);
    }

    _buildRowRuler(container) {
        container.innerHTML = '';
        const rows = Array.from(this.table.querySelectorAll('tr'));
        rows.forEach((tr, r) => {
            const seg = document.createElement('div');
            seg.className = 'ruler-seg';
            seg.textContent = String(r + 1);
            seg.dataset.row = r;
            seg.addEventListener('click', () => this.selectRow(r));
            const del = document.createElement('span');
            del.className = 'ruler-del';
            del.textContent = '\u00D7';
            del.addEventListener('click', (e) => { e.stopPropagation(); this.selectRow(r); this.deleteRow(); });
            seg.appendChild(del);
            container.appendChild(seg);
        });
        const addBtn = document.createElement('div');
        addBtn.className = 'ruler-add';
        addBtn.textContent = '+';
        addBtn.addEventListener('click', () => {
            if (this._selectedCells.length) this.addRow();
        });
        container.appendChild(addBtn);
    }

    _syncRuler() {
        if (!this._ruler) return;
        this.grid = new GridMapper(this.table);
        const colRuler = this._ruler.querySelector('.tafne-col-ruler');
        const rowRuler = this._ruler.querySelector('.tafne-row-ruler');
        if (colRuler) this._buildColRuler(colRuler);
        if (rowRuler) this._buildRowRuler(rowRuler);
    }

    _destroyRuler() {
        if (!this._ruler) return;
        const parent = this._ruler.parentNode;
        if (parent) parent.insertBefore(this.table, this._ruler);
        this._ruler.remove();
        this._ruler = null;
    }

    // ── Internal ──────────────────────────────────────────────────────────

    _afterMutate() {
        this.grid = new GridMapper(this.table);
        this.history.save();
        this._syncRuler();
        this._emit('change', { table: this.table });
    }

    _warn(msg) {
        this._emit('error', { message: msg });
    }

    // ── Events ────────────────────────────────────────────────────────────

    on(event, callback) {
        if (!this._eventHandlers[event]) this._eventHandlers[event] = [];
        this._eventHandlers[event].push(callback);
    }

    off(event, callback) {
        const handlers = this._eventHandlers[event];
        if (!handlers) return;
        this._eventHandlers[event] = handlers.filter(h => h !== callback);
    }

    _emit(event, data) {
        const handlers = this._eventHandlers[event];
        if (handlers) handlers.forEach(cb => cb(data));
    }
}
