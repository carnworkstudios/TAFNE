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

  // Apply to different element types
  if (elementType === "cell") {
    selectedCells.forEach((cell) => {
      applyStylingToCell(cell);
    });
  } else if (elementType === "row") {
    const rows = new Set();
    selectedCells.forEach((cell) => {
      rows.add($(cell).closest("tr")[0]);
    });

    rows.forEach((row) => {
      applyStylingToCell(row);
    });
  } else if (elementType === "column") {
    const mapper = new VisualGridMapper($table);
    const cols = new Set();

    selectedCells.forEach((cell) => {
      const position = mapper.getVisualPosition(cell);
      if (position) {
        cols.add(position.startCol);
      }
    });

    cols.forEach((colIndex) => {
      const cells = mapper.getCellsInColumn(colIndex);
      cells.forEach((cell) => {
        applyStylingToCell(cell);
      });
    });
  }

  // Clear inputs after applying
  $("#classInput").val("");
  $("#idInput").val("");
  $("#styleInput").val("");
  $("#tableAttribute").val("");
  $("#attributeValue").val("1");
  window.saveCurrentState();
}

// Make globally accessible
window.applyClassId = applyClassId;
