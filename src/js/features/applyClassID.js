function applyClassId() {
  if (selectedCells.length === 0) {
    alert("Please select at least one cell");
    return;
  }

  const elementType = $("#elementType").val();
  const rawClass = $("#classInput").val();
  const spActive = $("#basic-addon1").hasClass("sp-active");
  const className = rawClass && spActive ? "sp-" + rawClass : rawClass;
  const id = $("#idInput").val();

  // Get style values
  const selectedColor = $("#cellColor").val();
  const spacingTop = $("#spacingTop").val();
  const spacingRight = $("#spacingRight").val();
  const spacingBottom = $("#spacingBottom").val();
  const spacingLeft = $("#spacingLeft").val();
  const attributeValue = $("#attributeValue").val();

  // Get selected style and attribute options
  const selectedStyle = $("#styleInput").val();
  const selectedAttribute = $("#tableAttribute").val();
  const selectedStyleLabel = $("#styleInput option:selected")
    .parent()
    .attr("label");

  const $table = $(currentTable);

  // Function to apply styles and attributes to a cell
  function applyStylingToCell(cell) {
    // Apply class and ID
    if (className) $(cell).addClass(className);
    if (id) $(cell).attr('id', id);

    //SAVE STATE BEFORE OPERATION
    window.saveCurrentState();

    // Apply CSS styles based on selection
    if (selectedStyle) {
      if (
        selectedStyle === "background-color" ||
        selectedStyle === "color" ||
        selectedStyle === "border-color"
      ) {
        $(cell).css(selectedStyle, selectedColor);
      } else if (selectedStyle === "padding" || selectedStyle === "margin") {
        const spacingValue = `${spacingTop}px ${spacingRight}px ${spacingBottom}px ${spacingLeft}px`;
        $(cell).css(selectedStyle, spacingValue);
      } else if (selectedStyle === "border-collapse: collapse") {
        $(cell).css("border-collapse", "collapse");
      } else if (selectedStyle === "border-collapse: separate") {
        $(cell).css("border-collapse", "separate");
      }
    }

    // Apply HTML attributes
    if (selectedAttribute) {
      if (selectedAttribute === "colspan" || selectedAttribute === "rowspan") {
        $(cell).attr(selectedAttribute, attributeValue);
      } else if (selectedAttribute === "table-layout") {
        $(cell).css("table-layout", attributeValue);
      }
    }
  }

  // Apply to whichever elements the Element Type selector targets
  getStyleTargets(elementType).forEach(applyStylingToCell);

  // Clear only the transient "add" fields; leave id/class/span reflecting the
  // element's live state (repopulated below) instead of resetting to defaults.
  $("#classInput").val("");
  $("#styleInput").val("");
  window.saveCurrentState();
  if (typeof window.populateStylesPanel === "function") window.populateStylesPanel();
}

// Resolve the elements a style/class/attribute operation should target, based on
// the Element Type selector. Shared by applyClassId and the reflection panel.
function getStyleTargets(elementType) {
  const cells = window.selectedCells || [];
  if (!cells.length) return [];

  if (elementType === "row") {
    const rows = new Set();
    cells.forEach((c) => { const tr = $(c).closest("tr")[0]; if (tr) rows.add(tr); });
    return Array.from(rows);
  }

  if (elementType === "column") {
    const mapper = new VisualGridMapper($(window.currentTable));
    const out = new Set();
    cells.forEach((c) => {
      const p = mapper.getVisualPosition(c);
      if (p) mapper.getCellsInColumn(p.startCol).forEach((x) => out.add(x));
    });
    return Array.from(out);
  }

  return cells.slice();
}

// Make globally accessible
window.applyClassId = applyClassId;
window.getStyleTargets = getStyleTargets;
