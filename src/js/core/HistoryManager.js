const MAX_PER_SLOT = 50;

export class HistoryManager {
    constructor(table, options = {}) {
        this.table = table;
        this.maxPerSlot = options.maxPerSlot || MAX_PER_SLOT;
        this._slots = { history: [], currentIndex: -1 };
        this._isRestoring = false;
        this._onChange = options.onChange || null;
        this._id = table.getAttribute('data-tafne-id') || `table-${crypto.randomUUID()}`;
        if (!table.getAttribute('data-tafne-id')) table.setAttribute('data-tafne-id', this._id);
    }

    save() {
        if (this._isRestoring) return;
        const html = this.table.outerHTML;
        if (!html || html.trim() === '') return;
        const slot = this._slots;
        if (slot.currentIndex >= 0 && slot.history[slot.currentIndex] === html) return;
        slot.history = slot.history.slice(0, slot.currentIndex + 1);
        slot.history.push(html);
        if (slot.history.length > this.maxPerSlot) slot.history.shift();
        else slot.currentIndex++;
        this._notify();
    }

    undo() {
        const slot = this._slots;
        if (slot.currentIndex <= 0) return false;
        slot.currentIndex--;
        this._restore(slot);
        return true;
    }

    redo() {
        const slot = this._slots;
        if (slot.currentIndex >= slot.history.length - 1) return false;
        slot.currentIndex++;
        this._restore(slot);
        return true;
    }

    canUndo() {
        return this._slots.currentIndex > 0;
    }

    canRedo() {
        return this._slots.currentIndex < this._slots.history.length - 1;
    }

    undoCount() {
        return this._slots.currentIndex;
    }

    redoCount() {
        return this._slots.history.length - this._slots.currentIndex - 1;
    }

    clear() {
        this._slots = { history: [], currentIndex: -1 };
        this._notify();
    }

    _restore(slot) {
        this._isRestoring = true;
        const html = slot.history[slot.currentIndex];
        if (this.table.parentNode) {
            this.table.outerHTML = html;
            this.table = this.table.parentNode.querySelector(`table[data-tafne-id="${this._id}"]`);
        }
        this._isRestoring = false;
        this._notify();
    }

    _notify() {
        if (this._onChange) this._onChange({ canUndo: this.canUndo(), canRedo: this.canRedo() });
    }
}
