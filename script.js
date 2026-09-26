(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Block definitions
  //
  // Two kinds of blocks:
  //  - "atom" / "action": leaves. compute(fields) -> regex fragment.
  //  - "container": have a nested drop zone holding a sequence of child
  //    blocks. wrap(inner, fields) -> regex fragment, where `inner` is
  //    the already-computed concatenation (or alternation) of the
  //    container's children.
  //
  // Every container label ends in ":" to signal "this block holds a
  // drop zone"; no other block does. That's the one formatting rule
  // that distinguishes the two categories at a glance.
  // ---------------------------------------------------------------------

  function escapeLiteral(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function escapeClass(str) {
    return str.replace(/[\\\]]/g, "\\$&");
  }

  function clampInt(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  function isAlreadyGrouped(s) {
    if (s.length < 2 || s[0] !== "(" || s[s.length - 1] !== ")") return false;
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0 && i < s.length - 1) return false;
      }
    }
    return depth === 0;
  }

  function isSingleUnit(s) {
    if (s.length === 1) return true;
    if (/^\\.$/.test(s)) return true;
    if (/^\[.*\]$/.test(s)) return true;
    if (isAlreadyGrouped(s)) return true;
    return false;
  }

  function negateBase(base) {
    if (base === "") return base;
    const m = base.match(/^\[\^(.*)\]$/);
    if (m) return `[${m[1]}]`;
    const m2 = base.match(/^\[(.*)\]$/);
    if (m2) return `[^${m2[1]}]`;
    if (base === "\\w") return "\\W";
    if (base === "\\d") return "\\D";
    if (base === "\\s") return "\\S";
    if (base === ".") return base;
    return `(?:(?!${base}).)`;
  }

  const AMOUNT_MODES = [
    { value: "single", label: "a single occurrence" },
    { value: "exactly", label: "exactly" },
    { value: "atLeast", label: "at least" },
    { value: "upTo", label: "up to" },
    { value: "between", label: "between" },
    { value: "moreThan", label: "more than" },
    { value: "few", label: "as few as possible" },
    { value: "many", label: "as many as possible" },
  ];

  function amountSuffix(fields) {
    const n = clampInt(fields.n);
    const m = clampInt(fields.m);
    switch (fields.mode) {
      case "single":
        return "";
      case "exactly":
        return `{${n}}`;
      case "atLeast":
        return `{${n},}`;
      case "upTo":
        return `{0,${n}}`;
      case "between": {
        const lo = Math.min(n, m);
        const hi = Math.max(n, m);
        return `{${lo},${hi}}`;
      }
      case "moreThan":
        return `{${n + 1},}`;
      case "few":
        return "*?";
      case "many":
        return "*";
      default:
        return "";
    }
  }

  function amountSummary(fields) {
    const mode = AMOUNT_MODES.find((m) => m.value === fields.mode);
    const label = mode ? mode.label : fields.mode;
    switch (fields.mode) {
      case "exactly":
      case "atLeast":
      case "upTo":
      case "moreThan":
        return `${label} ${fields.n}`;
      case "between":
        return `${label} ${fields.n}-${fields.m}`;
      default:
        return label;
    }
  }

  const BLOCKS = {
    literal: {
      kind: "atom",
      label: "literal {text}",
      fields: [{ name: "text", kind: "text", placeholder: "text" }],
      compute: (f) => escapeLiteral(f.text || ""),
    },
    anyOf: {
      kind: "atom",
      label: "any of {chars}",
      fields: [{ name: "chars", kind: "text", placeholder: "characters" }],
      compute: (f) => `[${escapeClass(f.chars || "")}]`,
    },
    anything: {
      kind: "atom",
      label: "anything",
      fields: [],
      compute: () => ".",
    },
    uppercase: {
      kind: "atom",
      label: "uppercase",
      fields: [],
      compute: () => "[A-Z]",
    },
    lowercase: {
      kind: "atom",
      label: "lowercase",
      fields: [],
      compute: () => "[a-z]",
    },
    character: {
      kind: "atom",
      label: "character",
      fields: [],
      compute: () => ".",
    },
    letter: {
      kind: "atom",
      label: "letter",
      fields: [],
      compute: () => "[a-zA-Z]",
    },
    digit: {
      kind: "atom",
      label: "digit",
      fields: [],
      compute: () => "[0-9]",
    },
    letterOrDigit: {
      kind: "atom",
      label: "letter or digit",
      fields: [],
      compute: () => "[a-zA-Z0-9]",
    },
    word: {
      kind: "atom",
      label: "word",
      fields: [],
      compute: () => "\\w+",
    },
    letterRange: {
      kind: "atom",
      label: "the letter {from} through {to}",
      fields: [
        { name: "from", kind: "char", default: "a" },
        { name: "to", kind: "char", default: "z" },
      ],
      compute: (f) => {
        const from = escapeClass((f.from || "a").charAt(0) || "a");
        const to = escapeClass((f.to || "z").charAt(0) || "z");
        return `[${from}-${to}]`;
      },
    },
    fromBeginning: {
      kind: "atom",
      label: "from the beginning",
      fields: [],
      compute: () => "^",
    },
    toEnd: {
      kind: "atom",
      label: "to the end",
      fields: [],
      compute: () => "$",
    },
    replaceWith: {
      kind: "action",
      label: "replace with {text}",
      fields: [{ name: "text", kind: "text", placeholder: "replacement" }],
    },

    // -- containers: each holds a nested drop zone -----------------------
    group: {
      kind: "container",
      label: "group:",
      childJoin: "concat",
      wrap: (inner) => (isAlreadyGrouped(inner) ? inner : `(?:${inner})`),
    },
    not: {
      kind: "container",
      label: "not:",
      childJoin: "concat",
      wrap: (inner) => negateBase(inner),
    },
    or: {
      kind: "container",
      label: "either:",
      childJoin: "alternate",
      wrap: (inner) => `(?:${inner})`,
    },
    lookahead: {
      kind: "container",
      label: "followed by:",
      childJoin: "concat",
      wrap: (inner) => `(?=${inner})`,
    },
    notLookahead: {
      kind: "container",
      label: "not followed by:",
      childJoin: "concat",
      wrap: (inner) => `(?!${inner})`,
    },
    lookbehind: {
      kind: "container",
      label: "preceded by:",
      childJoin: "concat",
      wrap: (inner) => `(?<=${inner})`,
    },
    notLookbehind: {
      kind: "container",
      label: "not preceded by:",
      childJoin: "concat",
      wrap: (inner) => `(?<!${inner})`,
    },
    amount: {
      kind: "container",
      label: "amount:",
      childJoin: "concat",
      // wrap handled specially in computeNode (needs the mode dropdown)
    },
  };

  // Single source of truth for the toolbox layout. The DOM is generated
  // from BLOCKS, so labels only ever live in one place.
  const TOOLBOX_GROUPS = [
    ["literal", "anyOf", "anything", "not", "or", "group"],
    ["uppercase", "lowercase"],
    ["amount"],
    ["character", "letter", "digit", "letterOrDigit", "word", "letterRange"],
    ["fromBeginning", "toEnd"],
    ["lookahead", "notLookahead", "lookbehind", "notLookbehind"],
    ["replaceWith"],
  ];

  // ---------------------------------------------------------------------
  // Tree state
  // ---------------------------------------------------------------------

  let uidCounter = 0;
  let workbenchState = [];

  function makeInstance(defId) {
    const def = BLOCKS[defId];
    if (def.kind === "container") {
      const fields =
        defId === "amount"
          ? { mode: "atLeast", n: "1", m: "1", collapsed: "false" }
          : {};
      return { uid: ++uidCounter, defId, fields, children: [] };
    }
    const fields = {};
    (def.fields || []).forEach((f) => {
      fields[f.name] = f.default !== undefined ? String(f.default) : "";
    });
    return { uid: ++uidCounter, defId, fields };
  }

  function findParentArrayAndIndex(list, uid) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].uid === uid) return { array: list, index: i };
      if (list[i].children) {
        const res = findParentArrayAndIndex(list[i].children, uid);
        if (res) return res;
      }
    }
    return null;
  }

  function findInstanceByUid(list, uid) {
    for (const inst of list) {
      if (inst.uid === uid) return inst;
      if (inst.children) {
        const found = findInstanceByUid(inst.children, uid);
        if (found) return found;
      }
    }
    return null;
  }

  function subtreeContainsUid(inst, uid) {
    if (inst.uid === uid) return true;
    if (inst.children) return inst.children.some((c) => subtreeContainsUid(c, uid));
    return false;
  }

  function findAction(list) {
    for (const inst of list) {
      if (BLOCKS[inst.defId].kind === "action") return inst;
      if (inst.children) {
        const found = findAction(inst.children);
        if (found) return found;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Regex computation (recursive tree walk)
  // ---------------------------------------------------------------------

  function computeNode(inst) {
    const def = BLOCKS[inst.defId];
    if (def.kind === "atom") return def.compute(inst.fields);
    if (def.kind === "action") return "";

    const childFragments = (inst.children || [])
      .map(computeNode)
      .filter((f) => f !== "");
    const inner =
      def.childJoin === "alternate"
        ? childFragments.join("|")
        : childFragments.join("");

    if (inner === "") return "";

    if (inst.defId === "amount") {
      const suffix = amountSuffix(inst.fields);
      if (!suffix) return inner;
      return (isSingleUnit(inner) ? inner : `(?:${inner})`) + suffix;
    }

    // An alternation with only one surviving branch isn't really an
    // alternation (yet) -- don't wrap it in a redundant group.
    if (inst.defId === "or" && childFragments.length <= 1) return inner;

    return def.wrap(inner, inst.fields);
  }

  function computeRegex(list) {
    const pattern = list
      .map(computeNode)
      .filter((f) => f !== "")
      .join("");

    let replacement = null;
    const actionInst = findAction(list);
    if (actionInst) {
      replacement = (actionInst.fields.text || "").replace(/\$/g, "$$$$");
    }

    return { pattern, replacement };
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  const toolboxEl = document.getElementById("toolbox");
  const workbenchEl = document.getElementById("workbench");
  const regexOutputEl = document.getElementById("regexOutput");
  const textInputEl = document.getElementById("textInput");
  const outputBoxEl = document.getElementById("outputBox");
  const copyBtn = document.getElementById("copyBtn");
  const clearBtn = document.getElementById("clearWorkbench");
  const ignoreCaseEl = document.getElementById("ignoreCase");

  workbenchEl.classList.add("dropzone");
  workbenchEl.dataset.owner = "root";

  function labelParts(def) {
    const parts = [];
    const re = /\{(\w+)\}/g;
    let last = 0;
    let m;
    while ((m = re.exec(def.label))) {
      if (m.index > last) parts.push({ text: def.label.slice(last, m.index) });
      parts.push({ field: m[1] });
      last = re.lastIndex;
    }
    if (last < def.label.length) parts.push({ text: def.label.slice(last) });
    return parts;
  }

  function makeFieldInput(fieldDef, value, onChange) {
    const input = document.createElement("input");
    input.className = `field-input ${fieldDef.kind}-input`;
    input.value = value;
    if (fieldDef.kind === "number") {
      input.type = "number";
      input.min = "0";
      input.inputMode = "numeric";
    } else if (fieldDef.kind === "char") {
      input.type = "text";
      input.maxLength = 1;
    } else {
      input.type = "text";
      input.placeholder = fieldDef.placeholder || "";
    }
    input.addEventListener("input", () => {
      if (fieldDef.kind === "char") input.value = input.value.slice(0, 1);
      onChange(input.value);
    });
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
    return input;
  }

  function makeRemoveButton(onRemove) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-btn";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    removeBtn.addEventListener("click", onRemove);
    return removeBtn;
  }

  function buildLeafChip(inst, isToolboxPreview) {
    const def = BLOCKS[inst.defId];
    const chip = document.createElement("div");
    chip.className = isToolboxPreview ? "block" : "wb-chip";
    if (isToolboxPreview) chip.dataset.def = inst.defId;
    else chip.dataset.uid = inst.uid;

    labelParts(def).forEach((part) => {
      if (part.text !== undefined) {
        chip.appendChild(document.createTextNode(part.text));
        return;
      }
      const fieldDef = def.fields.find((f) => f.name === part.field);
      if (isToolboxPreview) {
        const span = document.createElement("span");
        span.className = `field ${fieldDef.kind}`;
        if (fieldDef.kind === "text") {
          span.dataset.placeholder = fieldDef.placeholder || "";
        } else {
          span.dataset.default = String(fieldDef.default);
        }
        chip.appendChild(span);
      } else {
        chip.appendChild(
          makeFieldInput(fieldDef, inst.fields[fieldDef.name], (val) => {
            inst.fields[fieldDef.name] = val;
            recompute();
          })
        );
      }
    });

    if (!isToolboxPreview) {
      chip.appendChild(
        makeRemoveButton(() => {
          const loc = findParentArrayAndIndex(workbenchState, inst.uid);
          if (loc) loc.array.splice(loc.index, 1);
          renderWorkbench();
          recompute();
        })
      );
    }

    return chip;
  }

  function renderAmountHeader(headerEl, inst) {
    const isCollapsed = inst.fields.collapsed === "true";

    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "collapse-btn";
    collapseBtn.textContent = isCollapsed ? "▸" : "▾";
    collapseBtn.title = isCollapsed ? "Expand" : "Collapse";
    collapseBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    collapseBtn.addEventListener("click", () => {
      inst.fields.collapsed = isCollapsed ? "false" : "true";
      renderWorkbench();
      recompute();
    });
    headerEl.appendChild(collapseBtn);

    if (isCollapsed) {
      const summary = document.createElement("span");
      summary.className = "amount-summary";
      summary.textContent = amountSummary(inst.fields) + " of:";
      headerEl.appendChild(summary);
      return;
    }

    const select = document.createElement("select");
    select.className = "amount-mode-select";
    AMOUNT_MODES.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.value;
      opt.textContent = m.label;
      if (inst.fields.mode === m.value) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("pointerdown", (e) => e.stopPropagation());
    select.addEventListener("change", () => {
      inst.fields.mode = select.value;
      renderWorkbench();
      recompute();
    });
    headerEl.appendChild(select);

    const mode = inst.fields.mode;
    const numberFieldDef = { kind: "number" };
    if (["exactly", "atLeast", "upTo", "moreThan"].includes(mode)) {
      headerEl.appendChild(
        makeFieldInput(numberFieldDef, inst.fields.n, (val) => {
          inst.fields.n = val;
          recompute();
        })
      );
    } else if (mode === "between") {
      headerEl.appendChild(
        makeFieldInput(numberFieldDef, inst.fields.n, (val) => {
          inst.fields.n = val;
          recompute();
        })
      );
      headerEl.appendChild(document.createTextNode("to"));
      headerEl.appendChild(
        makeFieldInput(numberFieldDef, inst.fields.m, (val) => {
          inst.fields.m = val;
          recompute();
        })
      );
    }
    headerEl.appendChild(document.createTextNode("of:"));
  }

  function buildContainerChip(inst) {
    const def = BLOCKS[inst.defId];
    const chip = document.createElement("div");
    chip.className = "wb-chip container-chip";
    chip.dataset.uid = inst.uid;

    const header = document.createElement("div");
    header.className = "container-header";
    if (inst.defId === "amount") {
      renderAmountHeader(header, inst);
    } else {
      header.appendChild(document.createTextNode(def.label));
    }
    header.appendChild(
      makeRemoveButton(() => {
        const loc = findParentArrayAndIndex(workbenchState, inst.uid);
        if (loc) loc.array.splice(loc.index, 1);
        renderWorkbench();
        recompute();
      })
    );
    chip.appendChild(header);

    const dropzone = document.createElement("div");
    dropzone.className = "dropzone";
    dropzone.dataset.owner = String(inst.uid);
    if (inst.children.length === 0) {
      const hint = document.createElement("div");
      hint.className = "dropzone-empty-hint";
      hint.textContent = "drop here";
      dropzone.appendChild(hint);
    } else {
      inst.children.forEach((child) => dropzone.appendChild(renderNode(child)));
    }
    chip.appendChild(dropzone);

    return chip;
  }

  function renderNode(inst) {
    const def = BLOCKS[inst.defId];
    if (def.kind === "container") return buildContainerChip(inst);
    return buildLeafChip(inst, false);
  }

  function renderToolbox() {
    toolboxEl.innerHTML = "";
    TOOLBOX_GROUPS.forEach((defIds) => {
      const groupEl = document.createElement("div");
      groupEl.className = "tool-group";
      defIds.forEach((defId) => {
        groupEl.appendChild(buildLeafChip({ defId, fields: {} }, true));
      });
      toolboxEl.appendChild(groupEl);
    });
  }

  function renderWorkbench() {
    workbenchEl.innerHTML = "";
    if (workbenchState.length === 0) {
      const placeholder = document.createElement("div");
      placeholder.className = "workbench-placeholder";
      placeholder.textContent = "Drag or tap blocks to build your pattern";
      workbenchEl.appendChild(placeholder);
      return;
    }
    workbenchState.forEach((inst) => workbenchEl.appendChild(renderNode(inst)));
  }

  function recompute() {
    let result;
    let patternError = null;
    try {
      result = computeRegex(workbenchState);
    } catch (e) {
      patternError = e.message;
      result = { pattern: "", replacement: null };
    }

    regexOutputEl.classList.remove("error");
    if (patternError) {
      regexOutputEl.value = "";
      regexOutputEl.placeholder = "Error: " + patternError;
      regexOutputEl.classList.add("error");
      outputBoxEl.textContent = "";
      return;
    }

    regexOutputEl.value = result.pattern;

    const text = textInputEl.value;
    if (!result.pattern) {
      outputBoxEl.textContent = text;
      return;
    }

    const flags = "gm" + (ignoreCaseEl.checked ? "i" : "");
    let re;
    try {
      re = new RegExp(result.pattern, flags);
    } catch (e) {
      regexOutputEl.classList.add("error");
      regexOutputEl.placeholder = "Invalid regex: " + e.message;
      regexOutputEl.value = "";
      outputBoxEl.textContent = text;
      return;
    }

    if (result.replacement !== null) {
      outputBoxEl.textContent = text.replace(re, result.replacement);
      return;
    }

    if (!text) {
      outputBoxEl.textContent = "";
      return;
    }

    outputBoxEl.innerHTML = "";
    let lastIndex = 0;
    let match;
    let guard = 0;
    re.lastIndex = 0;
    while ((match = re.exec(text)) !== null && guard < 20000) {
      guard++;
      if (match.index > lastIndex) {
        outputBoxEl.appendChild(
          document.createTextNode(text.slice(lastIndex, match.index))
        );
      }
      if (match[0].length === 0) {
        re.lastIndex++;
        if (match.index >= text.length) break;
        outputBoxEl.appendChild(document.createTextNode(text[match.index]));
        lastIndex = match.index + 1;
        continue;
      }
      const mark = document.createElement("mark");
      mark.textContent = match[0];
      outputBoxEl.appendChild(mark);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      outputBoxEl.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  // ---------------------------------------------------------------------
  // Drag and drop (Pointer Events: unifies mouse, touch and pen).
  // Any block -- toolbox or workbench -- can be dropped into the root
  // workbench or into any container's nested drop zone.
  // ---------------------------------------------------------------------

  const TAP_THRESHOLD_PX = 8;

  let dragGhost = null;
  let dragMode = null; // 'new' | 'move'
  let dragDefId = null;
  let dragUid = null;
  let dragSourceEl = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragMoved = false;
  let activePointerId = null;

  function dropzoneChipEls(dropzoneEl) {
    return Array.from(dropzoneEl.children).filter((el) =>
      el.classList.contains("wb-chip")
    );
  }

  function computeInsertIndex(dropzoneEl, x, y) {
    const chipEls = dropzoneChipEls(dropzoneEl);
    if (chipEls.length === 0) return 0;
    const rects = chipEls.map((el) => el.getBoundingClientRect());

    const rows = [];
    let currentRow = [0];
    for (let i = 1; i < rects.length; i++) {
      const prev = rects[currentRow[currentRow.length - 1]];
      const cur = rects[i];
      const overlaps = cur.top < prev.bottom && cur.bottom > prev.top;
      if (overlaps) currentRow.push(i);
      else {
        rows.push(currentRow);
        currentRow = [i];
      }
    }
    rows.push(currentRow);

    let targetRow = rows[0];
    let bestDist = Infinity;
    for (const row of rows) {
      const top = Math.min(...row.map((i) => rects[i].top));
      const bottom = Math.max(...row.map((i) => rects[i].bottom));
      if (y >= top && y <= bottom) {
        targetRow = row;
        bestDist = -1;
        break;
      }
      const center = (top + bottom) / 2;
      const d = Math.abs(y - center);
      if (d < bestDist) {
        bestDist = d;
        targetRow = row;
      }
    }

    for (const i of targetRow) {
      const r = rects[i];
      const midX = r.left + r.width / 2;
      if (x < midX) return i;
    }
    return targetRow[targetRow.length - 1] + 1;
  }

  function resolveDropzone(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    return el.closest(".dropzone");
  }

  function dragGhostLabel(defId) {
    if (defId === "amount") return "amount";
    return BLOCKS[defId].label.replace(/\{(\w+)\}/g, "___").replace(/:$/, "");
  }

  function startDrag(e, mode, payload) {
    if (dragMode) return; // ignore a second finger/pointer mid-drag
    e.preventDefault();
    dragMode = mode;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragMoved = false;
    activePointerId = e.pointerId;

    let defId;
    if (mode === "new") {
      dragDefId = payload;
      defId = payload;
    } else {
      dragUid = payload;
      dragSourceEl = document.querySelector(`.wb-chip[data-uid="${payload}"]`);
      if (dragSourceEl) {
        dragSourceEl.style.opacity = "0.3";
        dragSourceEl.style.pointerEvents = "none";
      }
      const inst = findInstanceByUid(workbenchState, payload);
      defId = inst.defId;
    }

    dragGhost = document.createElement("div");
    dragGhost.className = "drag-ghost block";
    dragGhost.textContent = dragGhostLabel(defId);
    document.body.appendChild(dragGhost);
    moveGhost(e);

    document.addEventListener("pointermove", onDragMove);
    document.addEventListener("pointerup", onDragEnd);
    document.addEventListener("pointercancel", onDragEnd);
  }

  function moveGhost(e) {
    if (!dragGhost) return;
    dragGhost.style.left = e.clientX + "px";
    dragGhost.style.top = e.clientY + "px";
  }

  function onDragMove(e) {
    if (e.pointerId !== activePointerId) return;
    if (
      !dragMoved &&
      Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY) > TAP_THRESHOLD_PX
    ) {
      dragMoved = true;
    }
    moveGhost(e);
    const dz = resolveDropzone(e.clientX, e.clientY);
    document
      .querySelectorAll(".dropzone.drag-over")
      .forEach((el) => el.classList.remove("drag-over"));
    if (dz) dz.classList.add("drag-over");
  }

  function endDragCleanup() {
    document.removeEventListener("pointermove", onDragMove);
    document.removeEventListener("pointerup", onDragEnd);
    document.removeEventListener("pointercancel", onDragEnd);
    document
      .querySelectorAll(".dropzone.drag-over")
      .forEach((el) => el.classList.remove("drag-over"));
    if (dragGhost) {
      dragGhost.remove();
      dragGhost = null;
    }
    if (dragSourceEl) {
      dragSourceEl.style.opacity = "";
      dragSourceEl.style.pointerEvents = "";
    }
    dragMode = null;
    dragDefId = null;
    dragUid = null;
    dragSourceEl = null;
    activePointerId = null;
  }

  function onDragEnd(e) {
    if (e.pointerId !== activePointerId) return;

    const mode = dragMode;
    const isTap = !dragMoved;
    let dz = resolveDropzone(e.clientX, e.clientY);

    if (mode === "new") {
      // A tap with no movement always appends to the root workbench --
      // easier to hit than the workbench's exact bounds on a phone.
      if (isTap && !dz) dz = workbenchEl;
      if (dz) {
        const targetArray =
          dz.dataset.owner === "root"
            ? workbenchState
            : findInstanceByUid(workbenchState, parseInt(dz.dataset.owner, 10)).children;
        const insertIndex = isTap && dz === workbenchEl
          ? targetArray.length
          : computeInsertIndex(dz, e.clientX, e.clientY);
        targetArray.splice(insertIndex, 0, makeInstance(dragDefId));
      }
    } else if (mode === "move" && dragMoved) {
      const loc = findParentArrayAndIndex(workbenchState, dragUid);
      if (loc && dz) {
        const draggedInst = loc.array[loc.index];
        const ownerUid = dz.dataset.owner === "root" ? null : parseInt(dz.dataset.owner, 10);
        const wouldCycle = ownerUid !== null && subtreeContainsUid(draggedInst, ownerUid);
        if (!wouldCycle) {
          const insertIndex = computeInsertIndex(dz, e.clientX, e.clientY);
          loc.array.splice(loc.index, 1);
          const targetArray =
            dz.dataset.owner === "root"
              ? workbenchState
              : findInstanceByUid(workbenchState, ownerUid).children;
          let idx = insertIndex;
          if (targetArray === loc.array && loc.index < idx) idx -= 1;
          targetArray.splice(idx, 0, draggedInst);
        }
      } else if (loc && !dz) {
        // dragged out of any drop zone -> remove
        loc.array.splice(loc.index, 1);
      }
    }

    endDragCleanup();
    renderWorkbench();
    recompute();
  }

  function attachToolboxHandlers() {
    toolboxEl.querySelectorAll(".block").forEach((el) => {
      el.addEventListener("pointerdown", (e) => {
        if (e.target.tagName === "INPUT") return;
        if (e.pointerType === "mouse" && e.button !== 0) return;
        startDrag(e, "new", el.dataset.def);
      });
    });
  }

  // reorder / move / remove existing chips (event delegation covers
  // chips created inside nested drop zones too)
  workbenchEl.addEventListener("pointerdown", (e) => {
    if (
      e.target.tagName === "INPUT" ||
      e.target.tagName === "SELECT" ||
      e.target.classList.contains("remove-btn") ||
      e.target.classList.contains("collapse-btn")
    ) {
      return;
    }
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const chip = e.target.closest(".wb-chip");
    if (!chip) return;
    startDrag(e, "move", parseInt(chip.dataset.uid, 10));
  });

  clearBtn.addEventListener("click", () => {
    workbenchState = [];
    renderWorkbench();
    recompute();
  });

  textInputEl.addEventListener("input", recompute);
  ignoreCaseEl.addEventListener("change", recompute);

  copyBtn.addEventListener("click", async () => {
    const value = regexOutputEl.value;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch (e) {
      regexOutputEl.select();
      document.execCommand("copy");
    }
    copyBtn.classList.add("copied");
    const original = copyBtn.textContent;
    copyBtn.textContent = "Copied!";
    setTimeout(() => {
      copyBtn.classList.remove("copied");
      copyBtn.textContent = original;
    }, 1200);
  });

  renderToolbox();
  attachToolboxHandlers();
  renderWorkbench();
  recompute();
})();
