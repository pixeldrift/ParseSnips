(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Block definitions
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
    not: {
      kind: "negate",
      label: "not",
      fields: [],
    },
    or: {
      kind: "combinator",
      label: "or",
      fields: [],
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
    singleOcc: {
      kind: "quantifier",
      label: "a single occurence of:",
      fields: [],
      suffix: () => "",
    },
    exactly: {
      kind: "quantifier",
      label: "exactly {n} occurences of",
      fields: [{ name: "n", kind: "number", default: 1 }],
      suffix: (f) => `{${clampInt(f.n)}}`,
    },
    atLeast: {
      kind: "quantifier",
      label: "at least {n} or more occurences of",
      fields: [{ name: "n", kind: "number", default: 1 }],
      suffix: (f) => `{${clampInt(f.n)},}`,
    },
    upTo: {
      kind: "quantifier",
      label: "up to {n} occurences of",
      fields: [{ name: "n", kind: "number", default: 1 }],
      suffix: (f) => `{0,${clampInt(f.n)}}`,
    },
    between: {
      kind: "quantifier",
      label: "between {n} to {m} occurences of:",
      fields: [
        { name: "n", kind: "number", default: 1 },
        { name: "m", kind: "number", default: 1 },
      ],
      suffix: (f) => {
        let n = clampInt(f.n);
        let m = clampInt(f.m);
        if (n > m) {
          const tmp = n;
          n = m;
          m = tmp;
        }
        return `{${n},${m}}`;
      },
    },
    moreThan: {
      kind: "quantifier",
      label: "more than {n} occurences of",
      fields: [{ name: "n", kind: "number", default: 1 }],
      suffix: (f) => `{${clampInt(f.n) + 1},}`,
    },
    fewAsPossible: {
      kind: "quantifier",
      label: "as few as possible of",
      fields: [],
      suffix: () => "*?",
    },
    manyAsPossible: {
      kind: "quantifier",
      label: "as many as possible of",
      fields: [],
      suffix: () => "*",
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
      compute: () => "\\w",
      defaultSuffix: "+",
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
      kind: "anchor",
      label: "From the beginning",
      fields: [],
      symbol: "^",
    },
    toEnd: {
      kind: "anchor",
      label: "to the end",
      fields: [],
      symbol: "$",
    },
    replaceWith: {
      kind: "action",
      label: "Replace with: {text}",
      fields: [{ name: "text", kind: "text", placeholder: "replacement" }],
    },
  };

  // ---------------------------------------------------------------------
  // Regex fragment helpers
  // ---------------------------------------------------------------------

  function isSingleUnit(s) {
    if (s.length === 1) return true;
    if (/^\\.$/.test(s)) return true;
    if (/^\[.*\]$/.test(s)) return true;
    return false;
  }

  function negateBase(base) {
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

  function computeRegex(list) {
    const fragments = [];
    let i = 0;

    while (i < list.length) {
      const inst = list[i];
      const def = BLOCKS[inst.defId];

      if (def.kind === "combinator") {
        fragments.push({ type: "or" });
        i++;
        continue;
      }

      if (def.kind === "quantifier" || def.kind === "negate") {
        const mods = [inst];
        let j = i + 1;
        while (
          j < list.length &&
          (BLOCKS[list[j].defId].kind === "quantifier" ||
            BLOCKS[list[j].defId].kind === "negate")
        ) {
          mods.push(list[j]);
          j++;
        }
        if (j >= list.length) {
          // dangling modifiers with nothing to apply to
          break;
        }
        const terminal = list[j];
        const tdef = BLOCKS[terminal.defId];

        if (tdef.kind === "anchor") {
          fragments.push({ type: "pattern", value: tdef.symbol });
          i = j + 1;
          continue;
        }
        if (tdef.kind === "action") {
          i = j + 1;
          continue;
        }
        if (tdef.kind === "atom") {
          let base = tdef.compute(terminal.fields);
          const quantInst = mods.find(
            (m) => BLOCKS[m.defId].kind === "quantifier"
          );
          const negateApplied = mods.some(
            (m) => BLOCKS[m.defId].kind === "negate"
          );
          if (negateApplied) base = negateBase(base);
          const suffix = quantInst
            ? BLOCKS[quantInst.defId].suffix(quantInst.fields)
            : tdef.defaultSuffix || "";
          const frag = suffix
            ? isSingleUnit(base)
              ? base + suffix
              : `(?:${base})${suffix}`
            : base;
          fragments.push({ type: "pattern", value: frag });
        }
        i = j + 1;
        continue;
      }

      if (def.kind === "atom") {
        const base = def.compute(inst.fields);
        const suffix = def.defaultSuffix || "";
        const frag = suffix
          ? isSingleUnit(base)
            ? base + suffix
            : `(?:${base})${suffix}`
          : base;
        fragments.push({ type: "pattern", value: frag });
        i++;
        continue;
      }

      if (def.kind === "anchor") {
        fragments.push({ type: "pattern", value: def.symbol });
        i++;
        continue;
      }

      if (def.kind === "action") {
        i++;
        continue;
      }

      i++;
    }

    const folded = [];
    for (let k = 0; k < fragments.length; k++) {
      const f = fragments[k];
      if (f.type === "or") {
        if (folded.length === 0 || k + 1 >= fragments.length) {
          continue; // dangling "or", ignore
        }
        const prev = folded.pop();
        const next = fragments[++k];
        folded.push({
          type: "pattern",
          value: `(?:${prev.value}|${next.value})`,
        });
      } else {
        folded.push(f);
      }
    }

    const pattern = folded.map((f) => f.value).join("");

    let replacement = null;
    const actionInst = list.find((x) => BLOCKS[x.defId].kind === "action");
    if (actionInst) {
      replacement = (actionInst.fields.text || "").replace(/\$/g, "$$$$");
    }

    return { pattern, replacement };
  }

  // ---------------------------------------------------------------------
  // Workbench state
  // ---------------------------------------------------------------------

  let uidCounter = 0;
  let workbenchState = [];

  function makeInstance(defId) {
    const def = BLOCKS[defId];
    const fields = {};
    def.fields.forEach((f) => {
      fields[f.name] = f.default !== undefined ? String(f.default) : "";
    });
    return { uid: ++uidCounter, defId, fields };
  }

  function groupInstances(list) {
    const groups = [];
    let current = [];
    list.forEach((inst) => {
      const def = BLOCKS[inst.defId];
      current.push(inst);
      if (def.kind === "quantifier" || def.kind === "negate") {
        return; // keep accumulating
      }
      groups.push({ items: current, complete: true });
      current = [];
    });
    if (current.length) {
      groups.push({ items: current, complete: false });
    }
    return groups;
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  const workbenchEl = document.getElementById("workbench");
  const regexOutputEl = document.getElementById("regexOutput");
  const textInputEl = document.getElementById("textInput");
  const outputBoxEl = document.getElementById("outputBox");
  const copyBtn = document.getElementById("copyBtn");
  const clearBtn = document.getElementById("clearWorkbench");

  function labelParts(def) {
    // splits "exactly {n} occurences of" into text/field tokens
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

  function buildChip(inst, isToolboxPreview) {
    const def = BLOCKS[inst.defId];
    const chip = document.createElement("div");
    chip.className = isToolboxPreview ? "block" : "wb-chip";
    if (!isToolboxPreview) {
      chip.dataset.uid = inst.uid;
      chip.draggable = true;
    } else {
      chip.dataset.def = inst.defId;
      chip.draggable = true;
    }

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
        const input = document.createElement("input");
        input.className = `field-input ${fieldDef.kind}-input`;
        input.value = inst.fields[fieldDef.name];
        if (fieldDef.kind === "number") {
          input.type = "number";
          input.min = "0";
        } else if (fieldDef.kind === "char") {
          input.type = "text";
          input.maxLength = 1;
        } else {
          input.type = "text";
          input.placeholder = fieldDef.placeholder || "";
        }
        input.addEventListener("input", () => {
          if (fieldDef.kind === "char") {
            input.value = input.value.slice(0, 1);
          }
          inst.fields[fieldDef.name] = input.value;
          recompute();
        });
        input.addEventListener("mousedown", (e) => e.stopPropagation());
        input.addEventListener("dragstart", (e) => e.preventDefault());
        chip.appendChild(input);
      }
    });

    if (!isToolboxPreview) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "remove-btn";
      removeBtn.textContent = "×";
      removeBtn.title = "Remove";
      removeBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      removeBtn.addEventListener("click", () => {
        workbenchState = workbenchState.filter((x) => x.uid !== inst.uid);
        renderWorkbench();
        recompute();
      });
      chip.appendChild(removeBtn);
    }

    return chip;
  }

  function renderWorkbench() {
    workbenchEl.innerHTML = "";
    if (workbenchState.length === 0) {
      const placeholder = document.createElement("div");
      placeholder.className = "workbench-placeholder";
      placeholder.textContent = "Drag blocks here to build your pattern";
      workbenchEl.appendChild(placeholder);
      return;
    }

    const groups = groupInstances(workbenchState);
    groups.forEach((group, idx) => {
      if (idx > 0) {
        const plus = document.createElement("span");
        plus.className = "plus-sep";
        plus.textContent = "+";
        workbenchEl.appendChild(plus);
      }
      const groupEl = document.createElement("div");
      groupEl.className = "chip-group" + (group.complete ? "" : " incomplete");
      group.items.forEach((inst) => {
        groupEl.appendChild(buildChip(inst, false));
      });
      workbenchEl.appendChild(groupEl);
    });
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

    let re;
    try {
      re = new RegExp(result.pattern, "gm");
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
  // Drag and drop (pointer based, works for touch + mouse, easy to test)
  // ---------------------------------------------------------------------

  let dragGhost = null;
  let dragMode = null; // 'new' | 'move'
  let dragDefId = null;
  let dragUid = null;
  let dragSourceEl = null;

  function clearIndicators() {
    workbenchEl
      .querySelectorAll(".drop-indicator")
      .forEach((el) => el.remove());
  }

  function computeDropIndex(clientX) {
    const chipEls = Array.from(
      workbenchEl.querySelectorAll(".chip-group, .plus-sep")
    );
    // Build a list of top-level workbench item elements in order, mapped
    // back to indices in workbenchState via the group structure.
    const groups = groupInstances(workbenchState);
    let flatBoundaries = []; // cumulative count of instances before each group
    let count = 0;
    groups.forEach((g) => {
      flatBoundaries.push(count);
      count += g.items.length;
    });
    flatBoundaries.push(count);

    const groupEls = Array.from(workbenchEl.querySelectorAll(".chip-group"));
    if (groupEls.length === 0) return 0;

    for (let i = 0; i < groupEls.length; i++) {
      const rect = groupEls[i].getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      if (clientX < mid) {
        return flatBoundaries[i];
      }
    }
    return flatBoundaries[flatBoundaries.length - 1];
  }

  function startDrag(e, mode, payload) {
    e.preventDefault();
    dragMode = mode;
    if (mode === "new") {
      dragDefId = payload;
    } else {
      dragUid = payload;
      dragSourceEl = document.querySelector(
        `.wb-chip[data-uid="${payload}"]`
      );
      if (dragSourceEl) dragSourceEl.style.opacity = "0.3";
    }

    const def = BLOCKS[mode === "new" ? payload : workbenchState.find((x) => x.uid === payload).defId];
    dragGhost = document.createElement("div");
    dragGhost.className = "drag-ghost block";
    dragGhost.textContent = def.label.replace(/\{(\w+)\}/g, "___");
    document.body.appendChild(dragGhost);
    moveGhost(e);

    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd);
  }

  function moveGhost(e) {
    if (!dragGhost) return;
    dragGhost.style.left = e.clientX + "px";
    dragGhost.style.top = e.clientY + "px";
  }

  function onDragMove(e) {
    moveGhost(e);
    const overWorkbench = e.clientX >= workbenchEl.getBoundingClientRect().left &&
      e.clientX <= workbenchEl.getBoundingClientRect().right &&
      e.clientY >= workbenchEl.getBoundingClientRect().top &&
      e.clientY <= workbenchEl.getBoundingClientRect().bottom;
    workbenchEl.classList.toggle("drag-over", overWorkbench);
  }

  function onDragEnd(e) {
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
    workbenchEl.classList.remove("drag-over");
    if (dragGhost) {
      dragGhost.remove();
      dragGhost = null;
    }

    const rect = workbenchEl.getBoundingClientRect();
    const dropped =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;

    if (dropped) {
      const insertIndex = computeDropIndex(e.clientX);
      if (dragMode === "new") {
        const inst = makeInstance(dragDefId);
        workbenchState.splice(insertIndex, 0, inst);
      } else if (dragMode === "move") {
        const fromIdx = workbenchState.findIndex((x) => x.uid === dragUid);
        if (fromIdx !== -1) {
          const [item] = workbenchState.splice(fromIdx, 1);
          let idx = insertIndex;
          if (fromIdx < idx) idx--;
          workbenchState.splice(idx, 0, item);
        }
      }
    } else if (dragMode === "move") {
      // dropped outside workbench -> remove
      workbenchState = workbenchState.filter((x) => x.uid !== dragUid);
    }

    if (dragSourceEl) dragSourceEl.style.opacity = "";
    dragMode = null;
    dragDefId = null;
    dragUid = null;
    dragSourceEl = null;

    renderWorkbench();
    recompute();
  }

  // toolbox block -> new instance
  document.querySelectorAll("#toolbox .block").forEach((el) => {
    el.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "INPUT") return;
      startDrag(e, "new", el.dataset.def);
    });
    el.addEventListener("dragstart", (e) => e.preventDefault());
  });

  // reorder existing chips
  workbenchEl.addEventListener("mousedown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.classList.contains("remove-btn")) {
      return;
    }
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

  renderWorkbench();
  recompute();
})();
