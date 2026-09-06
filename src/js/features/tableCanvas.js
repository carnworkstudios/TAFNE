// ====================================== TABLE CANVAS ======================================
// An infinite, pannable, zoomable surface for the table view — the Numbers model, where a
// sheet is a canvas holding free-floating tables rather than a document that stacks them.
//
//   • Wheel                 → zoom toward the cursor (trackpad pinch arrives as ctrl+wheel)
//   • Space-drag / middle   → pan
//   • Drag empty canvas     → pan
//   • Drag a card's header  → move that table anywhere
//   • Cmd/Ctrl + 0 / + / -  → reset / in / out
//
// The viewport math is lifted from the node editor (`nodeInteractions.js`): one
// `{x, y, zoom}` applied as a CSS transform, and screen↔canvas conversion through the same
// formula. This file deliberately does NOT reuse NodeGraph's viewport OBJECT — the node
// editor and the table view are two surfaces the user can hold at different zooms, and
// sharing the state would make one jump when the other moved.
//
// Positions live in `data-tf-x` / `data-tf-y` on the card. tableHistory snapshots
// `outerHTML`, so a position rides along with undo/redo and save with no extra plumbing.
(function () {
    'use strict';

    const MIN_ZOOM = 0.2;
    const MAX_ZOOM = 3;
    const CARD_SEL = '.tf-canvas-card';

    const vp = { x: 0, y: 0, zoom: 1 };
    let $viewport = null;   // the clipping element (fixed size, overflow hidden)
    let $surface  = null;   // the transformed element (infinite)
    let enabled   = false;
    let spaceHeld = false;
    let pan       = null;   // { sx, sy, vx, vy }
    let drag      = null;   // { $card, sx, sy, ox, oy }

    // ── Coordinate helpers (same formula as nodeInteractions.screenToCanvas) ──
    function screenToCanvas(clientX, clientY) {
        const r = $viewport[0].getBoundingClientRect();
        return { x: (clientX - r.left - vp.x) / vp.zoom,
                 y: (clientY - r.top  - vp.y) / vp.zoom };
    }

    function applyTransform() {
        $surface.css('transform', `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`);
        $(document).trigger('tf-canvas-transform');
        // The selection overlay is body-level and fixed, so it has to be told the
        // geometry moved under it.
        if (typeof window.scheduleTableGeometrySync === 'function') window.scheduleTableGeometrySync(window.currentTable);
        else if (typeof window.updateSelectionHandles === 'function') window.updateSelectionHandles();
        _syncZoomLabel();
    }

    function _syncZoomLabel() {
        $('#tfZoomLevel').text(Math.round(vp.zoom * 100) + '%');
    }

    // ── Zoom ──────────────────────────────────────────────────────────────────
    // Anchored at a screen point so the thing under the cursor stays under it.
    function zoomAt(clientX, clientY, factor) {
        const r  = $viewport[0].getBoundingClientRect();
        const mx = clientX - r.left;
        const my = clientY - r.top;
        const oldZ = vp.zoom;
        const newZ = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldZ * factor));
        if (newZ === oldZ) return;
        vp.x = mx - (mx - vp.x) * (newZ / oldZ);
        vp.y = my - (my - vp.y) * (newZ / oldZ);
        vp.zoom = newZ;
        applyTransform();
    }

    // Zoom about the viewport centre — what the toolbar buttons and shortcuts use.
    function zoomBy(factor) {
        const r = $viewport[0].getBoundingClientRect();
        zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
    }

    function setZoom(z) {
        const r = $viewport[0].getBoundingClientRect();
        zoomAt(r.left + r.width / 2, r.top + r.height / 2, z / vp.zoom);
    }

    function resetView() { vp.x = 0; vp.y = 0; vp.zoom = 1; applyTransform(); }

    // Frame every card, the way the node editor's fit-to-content does.
    function fitToContent() {
        const $cards = $surface.find(CARD_SEL);
        if (!$cards.length) return resetView();
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        $cards.each(function () {
            const x = parseFloat(this.dataset.tfX) || 0;
            const y = parseFloat(this.dataset.tfY) || 0;
            minX = Math.min(minX, x); minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + this.offsetWidth);
            maxY = Math.max(maxY, y + this.offsetHeight);
        });
        const r  = $viewport[0].getBoundingClientRect();
        const pad = 60;
        const z  = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM,
            Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY), 1)));
        vp.zoom = z;
        vp.x = r.width  / 2 - ((minX + maxX) / 2) * z;
        vp.y = r.height / 2 - ((minY + maxY) / 2) * z;
        applyTransform();
    }

    // ── Card placement ────────────────────────────────────────────────────────
    function setCardPos($card, x, y) {
        $card[0].dataset.tfX = Math.round(x);
        $card[0].dataset.tfY = Math.round(y);
        $card.css({ left: Math.round(x) + 'px', top: Math.round(y) + 'px' });
    }

    // Place a card that has no stored position: below the lowest existing one, so a
    // freshly created table never lands on top of another.
    function _nextFreeSlot($root, $card) {
        let y = 40;
        $root.children(CARD_SEL).not($card).each(function () {
            const cy = (parseFloat(this.dataset.tfY) || 0) + this.offsetHeight + 40;
            if (cy > y) y = cy;
        });
        return { x: 40, y };
    }

    // Wrap every top-level accordion+panel pair into one positioned card.
    // Idempotent: a card already wrapped is left alone.
    function _wrapCards() {
        // Cards live on the SURFACE once the canvas is on; before that they are
        // still direct children of the container. Wrap wherever they are.
        const $c = $surface && $surface.length ? $surface : $('#tableContainer');
        $c.children('.accordion').each(function () {
            const $btn = $(this);
            if ($btn.parent().hasClass('tf-canvas-card')) return;
            const $panel = $btn.next('.panel');
            const $card = $('<div class="tf-canvas-card"></div>');
            $btn.before($card);
            $card.append($btn).append($panel);
        });
        // Position anything not yet placed.
        $c.children(CARD_SEL).each(function () {
            const $card = $(this);
            const t = $card.find('table')[0];
            // A position stored on the table survives undo/redo, since history
            // snapshots the table's outerHTML and not the card's.
            const sx = t && t.dataset.tfX, sy = t && t.dataset.tfY;
            if (sx != null && sy != null && sx !== '') {
                setCardPos($card, parseFloat(sx), parseFloat(sy));
            } else if (this.dataset.tfX == null) {
                const p = _nextFreeSlot($c, $card);
                setCardPos($card, p.x, p.y);
                if (t) { t.dataset.tfX = p.x; t.dataset.tfY = p.y; }
            }
        });
    }

    // ── Enable / disable ──────────────────────────────────────────────────────
    function enable() {
        if (enabled) return;
        const $c = $('#tableContainer');
        if (!$c.length) return;

        $c.addClass('tf-canvas-on');
        // viewport clips; surface is transformed. Children move into the surface so
        // the transform applies to every card at once.
        $surface  = $('<div class="tf-canvas-surface"></div>');
        $viewport = $('<div class="tf-canvas-viewport"></div>').append($surface);
        $c.children().appendTo($surface);
        $c.append($viewport);

        _wrapCards();
        applyTransform();
        _wire();
        enabled = true;
        // Rulers measure with getBoundingClientRect, which now reports scaled
        // values — rebuild so segment sizes match what is on screen.
        _rerenderRulers();
    }

    function disable() {
        if (!enabled) return;
        const $c = $('#tableContainer');
        // Unwrap: cards back to plain accordion+panel in document order.
        $surface.find(CARD_SEL).each(function () {
            const $card = $(this);
            $card.before($card.children());
            $card.remove();
        });
        $surface.children().appendTo($c);
        $viewport.remove();
        $c.removeClass('tf-canvas-on');
        $viewport = $surface = null;
        enabled = false;
        _unwire();
        _rerenderRulers();
    }

    function _rerenderRulers() {
        if (typeof window.renderTableRulers !== 'function') return;
        $('#tableContainer table.tablecoil').each(function () {
            if (this.getBoundingClientRect().width > 0) window.renderTableRulers(this);
        });
    }

    // ── Event wiring ──────────────────────────────────────────────────────────
    function _wire() {
        // Wheel: ctrl/meta (or trackpad pinch) zooms; plain wheel scrolls the surface.
        $viewport.on('wheel.tfcanvas', function (e) {
            const oe = e.originalEvent;
            if (oe.ctrlKey || oe.metaKey) {
                oe.preventDefault();
                zoomAt(oe.clientX, oe.clientY, oe.deltaY > 0 ? 0.92 : 1.08);
            } else {
                oe.preventDefault();
                vp.x -= oe.deltaX;
                vp.y -= oe.deltaY;
                applyTransform();
            }
        });

        // Pan: middle-click, space-drag, or a press on empty canvas.
        $viewport.on('mousedown.tfcanvas', function (e) {
            const onCard = $(e.target).closest(CARD_SEL).length > 0;
            const wantPan = e.button === 1 || spaceHeld || !onCard;
            if (!wantPan) return;
            // A press inside a table must still select cells.
            if (onCard && !spaceHeld && e.button !== 1) return;
            e.preventDefault();
            pan = { sx: e.clientX, sy: e.clientY, vx: vp.x, vy: vp.y };
            $viewport.addClass('tf-panning');
        });

        // Card drag: from the header button only, so dragging inside the grid
        // still selects cells.
        $viewport.on('mousedown.tfcanvas', '.tf-canvas-card > .accordion', function (e) {
            if (e.button !== 0 || spaceHeld) return;
            const $card = $(this).closest(CARD_SEL);
            drag = { $card, sx: e.clientX, sy: e.clientY,
                     ox: parseFloat($card[0].dataset.tfX) || 0,
                     oy: parseFloat($card[0].dataset.tfY) || 0, moved: false };
        });

        $(document).on('mousemove.tfcanvas', function (e) {
            if (pan) {
                vp.x = pan.vx + (e.clientX - pan.sx);
                vp.y = pan.vy + (e.clientY - pan.sy);
                applyTransform();
            } else if (drag) {
                // Deltas are screen px; the surface is scaled, so divide by zoom.
                const dx = (e.clientX - drag.sx) / vp.zoom;
                const dy = (e.clientY - drag.sy) / vp.zoom;
                if (!drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
                drag.moved = true;
                drag.$card.addClass('tf-dragging');
                setCardPos(drag.$card, drag.ox + dx, drag.oy + dy);
            }
        });

        $(document).on('mouseup.tfcanvas', function () {
            if (pan) { pan = null; $viewport.removeClass('tf-panning'); }
            if (drag) {
                if (drag.moved) {
                    drag.$card.removeClass('tf-dragging');
                    // Mirror onto the table so the position survives undo/redo.
                    const t = drag.$card.find('table')[0];
                    if (t) {
                        t.dataset.tfX = drag.$card[0].dataset.tfX;
                        t.dataset.tfY = drag.$card[0].dataset.tfY;
                        window.currentTable = t;
                        if (typeof window.saveCurrentState === 'function') window.saveCurrentState();
                    }
                    if (typeof window.scheduleTableGeometrySync === 'function') window.scheduleTableGeometrySync(t);
                    else if (typeof window.updateSelectionHandles === 'function') window.updateSelectionHandles();
                }
                drag = null;
            }
        });

        $(document).on('keydown.tfcanvas', function (e) {
            if (e.code === 'Space' && !$(e.target).is('input, textarea, [contenteditable=true]')) {
                spaceHeld = true;
                $viewport.addClass('tf-space');
            }
            if (!(e.metaKey || e.ctrlKey)) return;
            if (e.key === '0') { e.preventDefault(); resetView(); }
            else if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomBy(1.1); }
            else if (e.key === '-') { e.preventDefault(); zoomBy(0.9); }
        });
        $(document).on('keyup.tfcanvas', function (e) {
            if (e.code === 'Space') { spaceHeld = false; $viewport.removeClass('tf-space'); }
        });
    }

    function _unwire() {
        $(document).off('.tfcanvas');
        if ($viewport) $viewport.off('.tfcanvas');
    }

    // Called after a table is added/removed so new cards get wrapped and placed.
    function refresh() {
        if (!enabled) return;
        // Newly appended nodes land in #tableContainer, outside the surface.
        const $c = $('#tableContainer');
        $c.children().not('.tf-canvas-viewport').appendTo($surface);
        _wrapCards();
    }

    // ── Toolbar wiring ────────────────────────────────────────────────────────
    $(function () {
        $('#tfCanvasToggle').on('click', function () {
            if (enabled) { disable(); $('body').removeClass('tf-canvas-active'); }
            else         { $('body').addClass('tf-canvas-active'); enable(); }
            $(this).toggleClass('is-on', enabled);
        });
        $('#tfZoomIn').on('click',  () => enabled && zoomBy(1.1));
        $('#tfZoomOut').on('click', () => enabled && zoomBy(0.9));
        $('#tfZoomFit').on('click', () => enabled && fitToContent());
        $('#tfZoomLevel').on('click', () => enabled && resetView());
    });

    window.TableCanvas = {
        enable, disable, refresh, resetView, fitToContent, zoomBy, setZoom,
        screenToCanvas,
        isEnabled: () => enabled,
        get zoom() { return vp.zoom; }
    };
})();
