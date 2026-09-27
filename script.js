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

  // "case insensitive:" has no scoped regex-flag equivalent that's safe
  // across engines, so it works by expanding letters/ranges into both
  // cases directly in the pattern text -- "a" becomes "[aA]", "a-z"
  // gains a parallel "A-Z", etc. Only touches structure the block model
  // itself produces (or already-parsed classes), so escapes, groups,
  // alternation and quantifiers all pass through untouched.
  function otherCase(ch) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    if (ch === lower && ch !== upper) return upper;
    if (ch === upper && ch !== lower) return lower;
    return null; // not a cased letter
  }

  function expandClassContentCase(content) {
    let out = "";
    let i = 0;
    while (i < content.length) {
      const c = content[i];
      if (c === "\\") {
        out += content.slice(i, i + 2);
        i += 2;
        continue;
      }
      const isRange =
        content[i + 1] === "-" &&
        i + 2 < content.length &&
        content[i + 2] !== "\\" &&
        otherCase(c) &&
        otherCase(content[i + 2]);
      if (isRange) {
        const start = c;
        const end = content[i + 2];
        out += `${start}-${end}${otherCase(start)}-${otherCase(end)}`;
        i += 3;
        continue;
      }
      const alt = otherCase(c);
      out += alt ? c + alt : c;
      i++;
    }
    return out;
  }

  function foldCase(fragment) {
    let out = "";
    let i = 0;
    while (i < fragment.length) {
      const c = fragment[i];
      if (c === "\\") {
        out += fragment.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "[") {
        let j = i + 1;
        let negated = false;
        if (fragment[j] === "^") {
          negated = true;
          j++;
        }
        const start = j;
        while (j < fragment.length && fragment[j] !== "]") {
          j += fragment[j] === "\\" ? 2 : 1;
        }
        const content = fragment.slice(start, j);
        out += `[${negated ? "^" : ""}${expandClassContentCase(content)}]`;
        i = j + 1;
        continue;
      }
      const alt = otherCase(c);
      out += alt ? `[${c}${alt}]` : c;
      i++;
    }
    return out;
  }

  const AMOUNT_MODES = [
    { value: "single", label: "a single occurrence" },
    { value: "exactly", label: "exactly" },
    { value: "atLeast", label: "at least" },
    { value: "upTo", label: "up to" },
    { value: "between", label: "between" },
    { value: "moreThan", label: "more than" },
  ];

  // Modes whose suffix has an inherent greedy/lazy distinction of its own
  // ("as few/many as possible" already pick one) -- everything else in
  // this list can additionally take the generic lazy toggle.
  const LAZY_TOGGLE_MODES = ["atLeast", "upTo", "between", "moreThan"];

  function amountSuffix(fields) {
    const n = clampInt(fields.n);
    const m = clampInt(fields.m);
    let suffix;
    switch (fields.mode) {
      case "single":
        return "";
      case "exactly":
        return `{${n}}`;
      case "atLeast":
        suffix = `{${n},}`;
        break;
      case "upTo":
        suffix = `{0,${n}}`;
        break;
      case "between": {
        const lo = Math.min(n, m);
        const hi = Math.max(n, m);
        suffix = `{${lo},${hi}}`;
        break;
      }
      case "moreThan":
        suffix = `{${n + 1},}`;
        break;
      default:
        return "";
    }
    if (fields.lazy === "true" && LAZY_TOGGLE_MODES.includes(fields.mode)) {
      suffix += "?";
    }
    return suffix;
  }

  function amountSummary(fields) {
    const mode = AMOUNT_MODES.find((m) => m.value === fields.mode);
    const label = mode ? mode.label : fields.mode;
    const lazySuffix =
      fields.lazy === "true" && LAZY_TOGGLE_MODES.includes(fields.mode)
        ? ", minimal match"
        : "";
    switch (fields.mode) {
      case "exactly":
      case "atLeast":
      case "upTo":
      case "moreThan":
        return `${label} ${fields.n}${lazySuffix}`;
      case "between":
        return `${label} ${fields.n}-${fields.m}${lazySuffix}`;
      default:
        return label;
    }
  }

  // Categories give related blocks a shared, subtle color tint (see
  // .cat-* rules in style.css) -- purely visual, no effect on regex
  // generation or parsing.
  const BLOCKS = {
    literal: {
      kind: "atom",
      category: "logic",
      label: "literal {text}",
      icon: "“…”",
      fields: [{ name: "text", kind: "text", placeholder: "text" }],
      compute: (f) => escapeLiteral(f.text || ""),
    },
    anyOf: {
      // Raw pass-through: whatever is typed here becomes the literal body
      // of a [...] class, so ranges (a-z), escapes (\d) and everything
      // else round-trip exactly when a regex is parsed back into blocks.
      kind: "atom",
      category: "logic",
      label: "any of {chars}",
      icon: "[…]",
      fields: [{ name: "chars", kind: "text", placeholder: "characters" }],
      compute: (f) => `[${f.chars || ""}]`,
    },
    anything: {
      kind: "atom",
      category: "logic",
      label: "anything",
      icon: ".",
      fields: [],
      compute: () => ".",
    },
    uppercase: {
      kind: "atom",
      category: "case",
      label: "uppercase",
      icon: "[A-Z]",
      fields: [],
      compute: () => "[A-Z]",
    },
    lowercase: {
      kind: "atom",
      category: "case",
      label: "lowercase",
      icon: "[a-z]",
      fields: [],
      compute: () => "[a-z]",
    },
    character: {
      kind: "atom",
      category: "class",
      label: "character",
      icon: ".",
      fields: [],
      compute: () => ".",
    },
    letter: {
      kind: "atom",
      category: "class",
      label: "letter",
      icon: "Aa",
      fields: [],
      compute: () => "[a-zA-Z]",
    },
    digit: {
      kind: "atom",
      category: "class",
      label: "digit",
      icon: "\\d",
      fields: [],
      compute: () => "[0-9]",
    },
    letterOrDigit: {
      kind: "atom",
      category: "class",
      label: "letter or digit",
      icon: "Aa9",
      fields: [],
      compute: () => "[a-zA-Z0-9]",
    },
    word: {
      kind: "atom",
      category: "class",
      label: "word character",
      icon: "\\w",
      fields: [],
      compute: () => "\\w",
    },
    whitespace: {
      kind: "atom",
      category: "class",
      label: "whitespace",
      icon: "\\s",
      fields: [],
      compute: () => "\\s",
    },
    letterRange: {
      kind: "atom",
      category: "class",
      label: "the letter {from} through {to}",
      icon: "a-z",
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
      category: "anchor",
      label: "from the beginning",
      icon: "^",
      fields: [],
      compute: () => "^",
    },
    toEnd: {
      kind: "atom",
      category: "anchor",
      label: "to the end",
      icon: "$",
      fields: [],
      compute: () => "$",
    },
    wordBoundary: {
      kind: "atom",
      category: "anchor",
      label: "word boundary",
      icon: "\\b",
      fields: [],
      compute: () => "\\b",
    },
    notWordBoundary: {
      kind: "atom",
      category: "anchor",
      label: "not a word boundary",
      icon: "\\B",
      fields: [],
      compute: () => "\\B",
    },
    replaceWith: {
      // An action block, not a container (it never contributes to the
      // search pattern -- computeNode short-circuits on "action" kind
      // before ever looking at its children) but it still holds its own
      // drop zone: literal text and "capture group:" references can be
      // dropped in, and computeReplacementText walks that same children
      // array to build the actual replacement string.
      kind: "action",
      category: "action",
      label: "replace with:",
      icon: "⇄",
      childJoin: "concat",
    },

    captureRef: {
      // Emits a numbered backreference ($1, $2, ...) to another "group:"
      // block's captured text. Only meaningful inside "replace with:" --
      // dropped anywhere else it's inert (contributes "" to the pattern).
      // The referenced group only becomes a real capturing "(...)" (instead
      // of the usual non-capturing "(?:...)") once something actually
      // references it, so plain patterns stay as uncluttered as before.
      kind: "atom",
      category: "action",
      label: "capture group:",
      icon: "$n",
      fields: [],
      compute: () => "",
    },

    matchGroup: {
      // References another named "group:" block already on the workbench
      // by substituting a copy of its compiled pattern at this spot --
      // not a real regex backreference (those need a capturing group,
      // which isn't wired up to anything yet), just reuse without
      // having to duplicate the blocks by hand.
      kind: "atom",
      category: "logic",
      label: "match group:",
      icon: "#",
      fields: [],
      compute: (f) => {
        const uid = parseInt(f.refUid, 10);
        if (!uid) return "";
        if (matchGroupResolutionStack.includes(uid)) return ""; // cycle guard
        const target = findInstanceByUid(workbenchState, uid);
        if (!target || target.defId !== "group") return "";
        matchGroupResolutionStack.push(uid);
        try {
          return computeNode(target);
        } finally {
          matchGroupResolutionStack.pop();
        }
      },
    },

    // -- containers: each holds a nested drop zone -----------------------
    group: {
      kind: "container",
      category: "logic",
      label: "group:",
      icon: "(…)",
      childJoin: "concat",
      wrap: (inner) => (isAlreadyGrouped(inner) ? inner : `(?:${inner})`),
    },
    not: {
      kind: "container",
      category: "logic",
      label: "not:",
      icon: "¬",
      childJoin: "concat",
      wrap: (inner) => negateBase(inner),
    },
    caseInsensitive: {
      // No portable scoped regex-flag equivalent, so this expands
      // letters/ranges into both cases directly (see foldCase) --
      // "a" -> "[aA]", "a-z" -> "a-zA-Z", etc.
      kind: "container",
      category: "case",
      label: "case insensitive:",
      icon: "Aa",
      childJoin: "concat",
      wrap: (inner) => foldCase(inner),
    },
    or: {
      kind: "container",
      category: "logic",
      label: "either:",
      icon: "|",
      childJoin: "alternate",
      wrap: (inner) => `(?:${inner})`,
    },
    lookahead: {
      kind: "container",
      category: "lookaround",
      label: "followed by:",
      icon: "?=",
      childJoin: "concat",
      wrap: (inner) => `(?=${inner})`,
    },
    notLookahead: {
      kind: "container",
      category: "lookaround",
      label: "not followed by:",
      icon: "?!",
      childJoin: "concat",
      wrap: (inner) => `(?!${inner})`,
    },
    lookbehind: {
      kind: "container",
      category: "lookaround",
      label: "preceded by:",
      icon: "?<=",
      childJoin: "concat",
      wrap: (inner) => `(?<=${inner})`,
    },
    notLookbehind: {
      kind: "container",
      category: "lookaround",
      label: "not preceded by:",
      icon: "?<!",
      childJoin: "concat",
      wrap: (inner) => `(?<!${inner})`,
    },
    amount: {
      kind: "container",
      category: "quantity",
      label: "amount:",
      icon: "{n}",
      childJoin: "concat",
      // wrap handled specially in computeNode (needs the mode dropdown)
    },
  };

  // Single source of truth for the toolbox layout. The DOM is generated
  // from BLOCKS, so labels only ever live in one place.
  const TOOLBOX_GROUPS = [
    ["literal", "anyOf", "anything", "not", "or", "group", "matchGroup"],
    ["uppercase", "lowercase", "caseInsensitive"],
    ["amount"],
    [
      "character",
      "letter",
      "digit",
      "letterOrDigit",
      "word",
      "whitespace",
      "letterRange",
    ],
    ["fromBeginning", "toEnd", "wordBoundary", "notWordBoundary"],
    ["lookahead", "notLookahead", "lookbehind", "notLookbehind"],
    ["replaceWith", "captureRef"],
  ];

  // ---------------------------------------------------------------------
  // Tree state
  // ---------------------------------------------------------------------

  let uidCounter = 0;
  let workbenchState = [];
  let matchGroupResolutionStack = []; // cycle guard for "match group:" lookups

  function makeInstance(defId) {
    const def = BLOCKS[defId];
    if (def.kind === "container" || defId === "replaceWith") {
      let fields;
      if (defId === "amount") {
        fields = { mode: "atLeast", n: "1", m: "1", lazy: "false", collapsed: "false" };
      } else if (defId === "group") {
        fields = { name: "", collapsed: "false" };
      } else {
        fields = { collapsed: "false" };
      }
      return { uid: ++uidCounter, defId, fields, children: [] };
    }
    if (defId === "matchGroup") {
      return { uid: ++uidCounter, defId, fields: { refUid: "", expanded: "false" } };
    }
    if (defId === "captureRef") {
      return { uid: ++uidCounter, defId, fields: { refUid: "" } };
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

  function cloneTree(node) {
    const clone = { uid: ++uidCounter, defId: node.defId, fields: { ...node.fields } };
    if (node.children) clone.children = node.children.map(cloneTree);
    return clone;
  }

  // A bookmark is always a single named "group:" node. Saving something
  // that isn't already exactly one group wraps it in a new one; saving
  // an existing group reuses it (so a bookmark's name survives being
  // dragged back into the workbench and re-saved).
  function wrapForBookmark(sourceNodes) {
    if (sourceNodes.length === 1 && sourceNodes[0].defId === "group") {
      return cloneTree(sourceNodes[0]);
    }
    return {
      uid: ++uidCounter,
      defId: "group",
      fields: { name: "", collapsed: "false" },
      children: sourceNodes.map(cloneTree),
    };
  }

  // ---------------------------------------------------------------------
  // Regex computation (recursive tree walk)
  // ---------------------------------------------------------------------

  // uid -> 1-based capture index, for "group:" nodes actually referenced by
  // a "capture group:" block. Rebuilt from scratch on every computeRegex()
  // call (see assignCaptureIndices below) -- capture-worthiness isn't a
  // property stored on the group itself, it's derived fresh each time from
  // whatever currently references it.
  let captureIndexMap = {};

  function computeNode(inst, memo) {
    const def = BLOCKS[inst.defId];
    if (def.kind === "atom") {
      const frag = def.compute(inst.fields);
      if (memo) memo.set(inst.uid, frag);
      return frag;
    }
    if (def.kind === "action") {
      if (memo) memo.set(inst.uid, "");
      return "";
    }

    const childFragments = (inst.children || [])
      .map((c) => computeNode(c, memo))
      .filter((f) => f !== "");
    const inner =
      def.childJoin === "alternate"
        ? childFragments.join("|")
        : childFragments.join("");

    if (inner === "") {
      if (memo) memo.set(inst.uid, "");
      return "";
    }

    let result;
    if (inst.defId === "amount") {
      const suffix = amountSuffix(inst.fields);
      result = !suffix ? inner : (isSingleUnit(inner) ? inner : `(?:${inner})`) + suffix;
    } else if (inst.defId === "group") {
      // A group only gets real capturing parens once something actually
      // backreferences it (see assignCaptureIndices) -- otherwise it stays
      // the usual non-capturing "(?:...)" (or reuses inner's own parens).
      const capIndex = captureIndexMap[inst.uid];
      result = capIndex
        ? `(${inner})`
        : isAlreadyGrouped(inner)
        ? inner
        : `(?:${inner})`;
    } else if (inst.defId === "or" && childFragments.length <= 1) {
      // An alternation with only one surviving branch isn't really an
      // alternation (yet) -- don't wrap it in a redundant group.
      result = inner;
    } else {
      result = def.wrap(inner, inst.fields);
    }

    if (memo) memo.set(inst.uid, result);
    return result;
  }

  // Every "capture group:" block anywhere in the tree (they only make
  // sense inside "replace with:", but nothing stops one being dropped
  // elsewhere) names a group uid it wants to backreference.
  function collectCaptureRefTargets(list, into) {
    into = into || new Set();
    for (const inst of list) {
      if (inst.defId === "captureRef" && inst.fields.refUid) {
        const uid = parseInt(inst.fields.refUid, 10);
        if (uid) into.add(uid);
      }
      if (inst.children) collectCaptureRefTargets(inst.children, into);
    }
    return into;
  }

  // Real regex capture numbering is assigned left-to-right by the position
  // of each group's opening "(" in the final pattern text -- i.e. a
  // pre-order walk (parent before children), and skipping any group whose
  // fragment came out empty (it was pruned entirely, so its "(" never
  // actually appears). `fragmentByUid` comes from a first computeNode pass
  // (with captureIndexMap still empty) -- capturing vs. non-capturing only
  // changes "(?:" to "(", never whether a fragment is empty, so that first
  // pass's emptiness results stay valid once capturing is applied.
  function assignCaptureIndices(list, fragmentByUid, capturingUids) {
    let next = 1;
    function walk(nodes) {
      for (const inst of nodes) {
        if (
          inst.defId === "group" &&
          capturingUids.has(inst.uid) &&
          fragmentByUid.get(inst.uid)
        ) {
          captureIndexMap[inst.uid] = next++;
        }
        if (inst.children) walk(inst.children);
      }
    }
    walk(list);
  }

  function computeReplacementNode(inst) {
    if (inst.defId === "literal") {
      return (inst.fields.text || "").replace(/\$/g, "$$$$");
    }
    if (inst.defId === "captureRef") {
      const idx = captureIndexMap[parseInt(inst.fields.refUid, 10)];
      return idx ? "$" + idx : "";
    }
    // Anything else dropped into "replace with:" doesn't make sense as
    // literal replacement text -- ignore it rather than crash.
    return "";
  }

  function computeReplacementText(actionInst) {
    return (actionInst.children || []).map(computeReplacementNode).join("");
  }

  function computeRegex(list) {
    matchGroupResolutionStack = [];
    captureIndexMap = {};

    // Pass 1: find which nodes actually survive into non-empty fragments,
    // with every group still provisionally non-capturing.
    const fragmentByUid = new Map();
    list.forEach((n) => computeNode(n, fragmentByUid));

    const capturingUids = collectCaptureRefTargets(list);
    assignCaptureIndices(list, fragmentByUid, capturingUids);

    // Pass 2: recompute now that captureIndexMap says which groups need
    // real "(...)" parens instead of "(?:...)".
    const pattern = list
      .map((n) => computeNode(n))
      .filter((f) => f !== "")
      .join("");

    let replacement = null;
    const actionInst = findAction(list);
    if (actionInst) {
      replacement = computeReplacementText(actionInst);
    }

    return { pattern, replacement };
  }

  // ---------------------------------------------------------------------
  // Reverse parsing: regex text -> block tree.
  //
  // Lets someone paste or hand-edit a plain regex string (no special
  // markup) and have it rebuilt into blocks -- the same round trip that
  // makes a regex string usable as a plain-text "favorite" snippet.
  //
  // Supports exactly the subset of regex syntax our blocks can express.
  // Constructs with no block equivalent (backreferences, inline flag
  // groups, unicode property escapes, atomic/possessive quantifiers)
  // raise a clear error instead of silently producing something wrong.
  // A plain or named capturing group is accepted but downgraded to a
  // plain "group:" block, since capture groups aren't wired up to
  // anything yet.
  // ---------------------------------------------------------------------

  function newParsedNode(defId, fields, children) {
    const def = BLOCKS[defId];
    if (def.kind === "container") {
      const finalFields = { collapsed: "false" };
      if (defId === "amount") {
        finalFields.mode = (fields && fields.mode) || "atLeast";
        finalFields.n = fields && fields.n !== undefined ? String(fields.n) : "1";
        finalFields.m = fields && fields.m !== undefined ? String(fields.m) : "1";
        finalFields.lazy = (fields && fields.lazy) || "false";
      } else if (defId === "group") {
        finalFields.name = (fields && fields.name) || "";
      }
      return { uid: ++uidCounter, defId, fields: finalFields, children: children || [] };
    }
    const finalFields = {};
    (def.fields || []).forEach((f) => {
      const v = fields ? fields[f.name] : undefined;
      finalFields[f.name] = v !== undefined ? String(v) : f.default !== undefined ? String(f.default) : "";
    });
    return { uid: ++uidCounter, defId, fields: finalFields };
  }

  function mergeLiterals(nodes) {
    const out = [];
    for (const node of nodes) {
      const prev = out[out.length - 1];
      if (prev && prev.defId === "literal" && node.defId === "literal") {
        prev.fields.text += node.fields.text;
      } else {
        out.push(node);
      }
    }
    return out;
  }

  function parseRegexToNodes(pattern) {
    let i = 0;
    const n = pattern.length;

    function peek() {
      return pattern[i];
    }
    function eof() {
      return i >= n;
    }
    function fail(msg) {
      const around = pattern.slice(Math.max(0, i - 6), i + 6);
      throw new Error(`${msg} (near "...${around}..." at position ${i})`);
    }
    function expect(ch) {
      if (eof() || peek() !== ch) fail(`Expected "${ch}"`);
      i++;
    }

    function parseAlternation() {
      const branches = [parseConcat()];
      while (!eof() && peek() === "|") {
        i++;
        branches.push(parseConcat());
      }
      if (branches.length === 1) return branches[0];
      const children = branches.map((nodes) => newParsedNode("group", {}, nodes));
      return [newParsedNode("or", {}, children)];
    }

    function parseConcat() {
      const nodes = [];
      while (!eof() && peek() !== "|" && peek() !== ")") {
        nodes.push(parsePiece());
      }
      return mergeLiterals(nodes);
    }

    function parsePiece() {
      const atomNode = parseAtom();
      const quant = tryParseQuantifier();
      if (!quant) return atomNode;
      return newParsedNode("amount", quant, [atomNode]);
    }

    function tryParseQuantifier() {
      if (eof()) return null;
      const c = peek();
      let fields = null;
      if (c === "*") {
        i++;
        fields = { mode: "atLeast", n: "0" };
      } else if (c === "+") {
        i++;
        fields = { mode: "atLeast", n: "1" };
      } else if (c === "?") {
        i++;
        fields = { mode: "upTo", n: "1" };
      } else if (c === "{") {
        const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
        if (!m) return null; // not a valid quantifier -- '{' is a literal char
        i += m[0].length;
        if (m[2] === undefined) fields = { mode: "exactly", n: m[1] };
        else if (!m[3]) fields = { mode: "atLeast", n: m[1] };
        else fields = { mode: "between", n: m[1], m: m[3] };
      } else {
        return null;
      }
      let lazy = false;
      if (!eof() && peek() === "?") {
        i++;
        lazy = true;
      }
      fields.lazy = lazy ? "true" : "false";
      return fields;
    }

    function parseAtom() {
      if (eof()) fail("Unexpected end of pattern");
      const c = peek();
      if (c === "^") {
        i++;
        return newParsedNode("fromBeginning", {});
      }
      if (c === "$") {
        i++;
        return newParsedNode("toEnd", {});
      }
      if (c === ".") {
        i++;
        return newParsedNode("anything", {});
      }
      if (c === "*" || c === "+" || c === "?") {
        fail(`Quantifier "${c}" with nothing to repeat`);
      }
      if (c === ")") fail('Unexpected ")"');
      if (c === "(") return parseGroup();
      if (c === "[") return parseCharClass();
      if (c === "\\") return parseEscape();
      i++;
      return newParsedNode("literal", { text: c });
    }

    function parseCharClass() {
      i++; // consume '['
      let negated = false;
      if (!eof() && peek() === "^") {
        negated = true;
        i++;
      }
      const start = i;
      while (!eof() && peek() !== "]") {
        if (peek() === "\\") i += 2;
        else i++;
      }
      if (eof()) fail("Unterminated character class");
      const content = pattern.slice(start, i);
      i++; // consume ']'
      const atomNode = newParsedNode("anyOf", { chars: content });
      return negated ? newParsedNode("not", {}, [atomNode]) : atomNode;
    }

    function parseEscape() {
      i++; // consume backslash
      if (eof()) fail("Trailing backslash");
      const c = pattern[i];
      i++;
      switch (c) {
        case "d":
          return newParsedNode("digit", {});
        case "D":
          return newParsedNode("not", {}, [newParsedNode("digit", {})]);
        case "w":
          return newParsedNode("word", {});
        case "W":
          return newParsedNode("not", {}, [newParsedNode("word", {})]);
        case "s":
          return newParsedNode("whitespace", {});
        case "S":
          return newParsedNode("not", {}, [newParsedNode("whitespace", {})]);
        case "b":
          return newParsedNode("wordBoundary", {});
        case "B":
          return newParsedNode("notWordBoundary", {});
        case "n":
          return newParsedNode("literal", { text: "\n" });
        case "t":
          return newParsedNode("literal", { text: "\t" });
        case "r":
          return newParsedNode("literal", { text: "\r" });
        default:
          if (/[0-9]/.test(c)) fail("Backreferences aren't supported");
          if ("uxpPk".includes(c)) fail(`The "\\${c}" escape isn't supported`);
          return newParsedNode("literal", { text: c });
      }
    }

    function parseGroup() {
      i++; // consume '('
      if (!eof() && peek() === "?") {
        const next = pattern[i + 1];
        if (next === ":") {
          i += 2;
          const inner = parseAlternation();
          expect(")");
          return newParsedNode("group", {}, inner);
        }
        if (next === "=") {
          i += 2;
          const inner = parseAlternation();
          expect(")");
          return newParsedNode("lookahead", {}, inner);
        }
        if (next === "!") {
          i += 2;
          const inner = parseAlternation();
          expect(")");
          return newParsedNode("notLookahead", {}, inner);
        }
        if (next === "<" && pattern[i + 2] === "=") {
          i += 3;
          const inner = parseAlternation();
          expect(")");
          return newParsedNode("lookbehind", {}, inner);
        }
        if (next === "<" && pattern[i + 2] === "!") {
          i += 3;
          const inner = parseAlternation();
          expect(")");
          return newParsedNode("notLookbehind", {}, inner);
        }
        if (next === "<") {
          // named capturing group -- downgraded to a plain group, since
          // captures aren't wired to anything (yet).
          i += 2;
          while (!eof() && peek() !== ">") i++;
          if (eof()) fail("Unterminated group name");
          i++;
          const inner = parseAlternation();
          expect(")");
          return newParsedNode("group", {}, inner);
        }
        fail(`Unsupported group syntax "(?${next || ""}"`);
      }
      // plain capturing group -- also downgraded to a plain group
      const inner = parseAlternation();
      expect(")");
      return newParsedNode("group", {}, inner);
    }

    const nodes = parseAlternation();
    if (!eof()) fail(`Unexpected "${peek()}"`);
    return nodes;
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
  const outputCopyBtn = document.getElementById("outputCopyBtn");
  const outputCopyIconBtn = document.getElementById("outputCopyIconBtn");
  const rebuildBtn = document.getElementById("rebuildBtn");
  const reloadBtn = document.getElementById("reloadBtn");
  const regexParseErrorEl = document.getElementById("regexParseError");
  const clearBtn = document.getElementById("clearWorkbench");
  const bookmarksBoxEl = document.getElementById("bookmarksBox");
  const bookmarkBtn = document.getElementById("bookmarkBtn");
  const outputModeSwitchEl = document.getElementById("outputModeSwitch");

  let outputMode = "highlight"; // 'highlight' | 'onlyMatches' | 'removed'

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

  // Two diagonal corner-brackets at 45 degrees: pulled apart (pointing
  // away from each other) to mean "expand", pulled together (pointing
  // toward each other) to mean "collapse".
  const EXPAND_ICON_SVG =
    '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M9 3 L3 3 L3 9"/><path d="M15 21 L21 21 L21 15"/></svg>';
  const COLLAPSE_ICON_SVG =
    '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 9 L9 9 L9 3"/><path d="M21 15 L15 15 L15 21"/></svg>';

  function makeCollapseToggle(isCollapsed, onToggle) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "collapse-toggle-btn";
    btn.title = isCollapsed ? "Expand" : "Collapse";
    btn.innerHTML = isCollapsed ? EXPAND_ICON_SVG : COLLAPSE_ICON_SVG;
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", onToggle);
    return btn;
  }

  const FOLDER_ICON_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>';
  const BOOKMARK_ICON_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M6 3h12v18l-6-4-6 4V3z"/></svg>';

  function renderGroupHeader(headerEl, inst) {
    const hasName = !!(inst.fields.name && inst.fields.name.trim());

    const icon = document.createElement("span");
    icon.className = "group-icon";
    icon.innerHTML = hasName ? BOOKMARK_ICON_SVG : FOLDER_ICON_SVG;
    headerEl.appendChild(icon);

    headerEl.appendChild(document.createTextNode("group:"));

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "group-name-input";
    nameInput.placeholder = "name";
    nameInput.value = inst.fields.name || "";
    nameInput.addEventListener("pointerdown", (e) => e.stopPropagation());
    nameInput.addEventListener("input", () => {
      inst.fields.name = nameInput.value;
    });
    nameInput.addEventListener("blur", () => {
      // Re-render only now (not on every keystroke) so the folder/
      // bookmark icon reflects the current name without disrupting
      // an in-progress edit.
      renderWorkbench();
      recompute();
    });
    headerEl.appendChild(nameInput);
  }

  function makeBlockIcon(defId) {
    const def = BLOCKS[defId];
    if (!def.icon) return null;
    const span = document.createElement("span");
    span.className = "block-icon";
    span.textContent = def.icon;
    return span;
  }

  function buildLeafChip(inst, isToolboxPreview) {
    const def = BLOCKS[inst.defId];
    const chip = document.createElement("div");
    chip.className = `${isToolboxPreview ? "block" : "wb-chip"} cat-${def.category}`;
    if (isToolboxPreview) chip.dataset.def = inst.defId;
    else chip.dataset.uid = inst.uid;

    const icon = makeBlockIcon(inst.defId);
    if (icon) chip.appendChild(icon);

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

  function makeGreedyLazyToggle(inst) {
    // A separate row below the drop zone -- not part of the header
    // sentence at all -- with a little switch between the two labels.
    // The switch's arrow points at whichever side is active, and that
    // side's label is bold; the other is faded.
    const isLazy = inst.fields.lazy === "true";

    function setLazy(val) {
      inst.fields.lazy = val ? "true" : "false";
      renderWorkbench();
      recompute();
    }

    const row = document.createElement("div");
    row.className = "greedy-toggle";

    const lazyLabel = document.createElement("span");
    lazyLabel.className = "greedy-toggle-label" + (isLazy ? " active" : "");
    lazyLabel.textContent = "as little as possible";
    lazyLabel.addEventListener("pointerdown", (e) => e.stopPropagation());
    lazyLabel.addEventListener("click", () => setLazy(true));

    const switchBtn = document.createElement("button");
    switchBtn.type = "button";
    switchBtn.className = "greedy-toggle-switch " + (isLazy ? "state-lazy" : "state-greedy");
    switchBtn.title = "Toggle minimal/maximal matching";
    switchBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    switchBtn.addEventListener("click", () => setLazy(!isLazy));
    const arrow = document.createElement("span");
    arrow.className = "greedy-toggle-arrow";
    arrow.textContent = isLazy ? "◀" : "▶";
    switchBtn.appendChild(arrow);

    const greedyLabel = document.createElement("span");
    greedyLabel.className = "greedy-toggle-label" + (!isLazy ? " active" : "");
    greedyLabel.textContent = "as much as possible";
    greedyLabel.addEventListener("pointerdown", (e) => e.stopPropagation());
    greedyLabel.addEventListener("click", () => setLazy(false));

    row.appendChild(lazyLabel);
    row.appendChild(switchBtn);
    row.appendChild(greedyLabel);
    return row;
  }

  function renderAmountHeader(headerEl, inst) {
    const isCollapsed = inst.fields.collapsed === "true";

    const icon = makeBlockIcon("amount");
    if (icon) headerEl.appendChild(icon);

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
    chip.className = `wb-chip container-chip cat-${def.category}`;
    chip.dataset.uid = inst.uid;

    const isCollapsed = inst.fields.collapsed === "true";

    chip.appendChild(
      makeCollapseToggle(isCollapsed, () => {
        inst.fields.collapsed = isCollapsed ? "false" : "true";
        renderWorkbench();
        recompute();
      })
    );

    const header = document.createElement("div");
    header.className = "container-header";
    if (inst.defId === "amount") {
      renderAmountHeader(header, inst);
    } else if (inst.defId === "group") {
      renderGroupHeader(header, inst);
    } else {
      const icon = makeBlockIcon(inst.defId);
      if (icon) header.appendChild(icon);
      header.appendChild(document.createTextNode(def.label));
    }
    chip.appendChild(header);

    chip.appendChild(
      makeRemoveButton(() => {
        const loc = findParentArrayAndIndex(workbenchState, inst.uid);
        if (loc) loc.array.splice(loc.index, 1);
        renderWorkbench();
        recompute();
      })
    );

    if (!isCollapsed) {
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

      if (inst.defId === "amount" && LAZY_TOGGLE_MODES.includes(inst.fields.mode)) {
        chip.appendChild(makeGreedyLazyToggle(inst));
      }
    }

    return chip;
  }

  function listNamedGroups(list, results) {
    results = results || [];
    for (const node of list) {
      if (node.defId === "group" && node.fields.name && node.fields.name.trim()) {
        results.push(node);
      }
      if (node.children) listNamedGroups(node.children, results);
    }
    return results;
  }

  function buildMatchGroupChip(inst) {
    const chip = document.createElement("div");
    chip.className = "wb-chip cat-logic";
    chip.dataset.uid = inst.uid;

    const icon = makeBlockIcon("matchGroup");
    if (icon) chip.appendChild(icon);
    chip.appendChild(document.createTextNode("match group:"));

    const select = document.createElement("select");
    select.className = "amount-mode-select";
    const placeholderOpt = document.createElement("option");
    placeholderOpt.value = "";
    placeholderOpt.textContent = "— choose —";
    select.appendChild(placeholderOpt);
    listNamedGroups(workbenchState).forEach((g) => {
      const opt = document.createElement("option");
      opt.value = String(g.uid);
      opt.textContent = g.fields.name;
      if (inst.fields.refUid === String(g.uid)) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("pointerdown", (e) => e.stopPropagation());
    select.addEventListener("change", () => {
      inst.fields.refUid = select.value;
      recompute();
    });
    chip.appendChild(select);

    const isExpanded = inst.fields.expanded === "true";
    const toggle = makeCollapseToggle(!isExpanded, () => {
      inst.fields.expanded = isExpanded ? "false" : "true";
      renderWorkbench();
    });
    toggle.classList.add("inline-expand-toggle");
    chip.appendChild(toggle);

    chip.appendChild(
      makeRemoveButton(() => {
        const loc = findParentArrayAndIndex(workbenchState, inst.uid);
        if (loc) loc.array.splice(loc.index, 1);
        renderWorkbench();
        recompute();
      })
    );

    if (isExpanded) {
      chip.classList.add("match-group-expanded");
      const preview = document.createElement("div");
      preview.className = "match-group-preview";
      const target = findInstanceByUid(workbenchState, parseInt(inst.fields.refUid, 10));
      preview.textContent = target ? computeNode(target) || "(empty)" : "(no group selected)";
      chip.appendChild(preview);
    }

    return chip;
  }

  function buildCaptureRefChip(inst) {
    const chip = document.createElement("div");
    chip.className = "wb-chip cat-action";
    chip.dataset.uid = inst.uid;

    const icon = makeBlockIcon("captureRef");
    if (icon) chip.appendChild(icon);
    chip.appendChild(document.createTextNode("capture group:"));

    const select = document.createElement("select");
    select.className = "amount-mode-select";
    const placeholderOpt = document.createElement("option");
    placeholderOpt.value = "";
    placeholderOpt.textContent = "— choose —";
    select.appendChild(placeholderOpt);
    listNamedGroups(workbenchState).forEach((g) => {
      const opt = document.createElement("option");
      opt.value = String(g.uid);
      opt.textContent = g.fields.name;
      if (inst.fields.refUid === String(g.uid)) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("pointerdown", (e) => e.stopPropagation());
    select.addEventListener("change", () => {
      inst.fields.refUid = select.value;
      recompute();
    });
    chip.appendChild(select);

    chip.appendChild(
      makeRemoveButton(() => {
        const loc = findParentArrayAndIndex(workbenchState, inst.uid);
        if (loc) loc.array.splice(loc.index, 1);
        renderWorkbench();
        recompute();
      })
    );

    return chip;
  }

  function renderNode(inst) {
    const def = BLOCKS[inst.defId];
    if (inst.defId === "matchGroup") return buildMatchGroupChip(inst);
    if (inst.defId === "captureRef") return buildCaptureRefChip(inst);
    if (def.kind === "container" || inst.defId === "replaceWith") return buildContainerChip(inst);
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
    bookmarkBtn.disabled = workbenchState.length === 0;
    if (workbenchState.length === 0) {
      const placeholder = document.createElement("div");
      placeholder.className = "workbench-placeholder";
      placeholder.textContent = "Drag or tap blocks to build your pattern";
      workbenchEl.appendChild(placeholder);
      return;
    }
    workbenchState.forEach((inst) => workbenchEl.appendChild(renderNode(inst)));
  }

  // ---------------------------------------------------------------------
  // Saved Patterns (bookmarks): named, reusable snippets. Each one is a
  // single "group:" node plus a frozen snapshot of the regex text it
  // produced at save time. Behaves like a second toolbox: drag or tap an
  // entry to drop a fresh clone of it into the workbench.
  // ---------------------------------------------------------------------

  let bookmarks = [];
  let bookmarkUidCounter = 0;
  let bookmarkNameCounter = 0;

  const SEED_BOOKMARKS = [
    { name: "Email address", pattern: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}" },
    { name: "URL", pattern: "https?://[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}(?:/[^\\s]*)?" },
    { name: "Phone number", pattern: "\\(?\\d{3}\\)?[-.\\s]?\\d{3}[-.\\s]?\\d{4}" },
    { name: "Date (MM/DD/YYYY)", pattern: "\\d{1,2}/\\d{1,2}/\\d{4}" },
    { name: "ZIP code", pattern: "\\d{5}(?:-\\d{4})?" },
    {
      name: "HTML tags",
      pattern: "</?[a-zA-Z][a-zA-Z0-9]*(?:\\s+[a-zA-Z][a-zA-Z0-9-]*(?:=\"[^\"]*\")?)*\\s*/?>",
    },
  ];

  function makeSeedBookmark(name, patternText) {
    const groupNode = wrapForBookmark(parseRegexToNodes(patternText));
    groupNode.fields.name = name;
    return {
      id: ++bookmarkUidCounter,
      name,
      pattern: computeNode(groupNode),
      tree: groupNode,
    };
  }

  bookmarks = SEED_BOOKMARKS.map((s) => makeSeedBookmark(s.name, s.pattern));

  function nextDefaultBookmarkName() {
    bookmarkNameCounter += 1;
    return `Saved pattern ${String(bookmarkNameCounter).padStart(2, "0")}`;
  }

  function buildBookmarkChip(bm) {
    const chip = document.createElement("div");
    chip.className = "bookmark-chip cat-bookmark";
    chip.dataset.bookmarkId = bm.id;

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "bookmark-name-input";
    nameInput.value = bm.name;
    nameInput.addEventListener("pointerdown", (e) => e.stopPropagation());
    nameInput.addEventListener("input", () => {
      bm.name = nameInput.value;
      bm.tree.fields.name = nameInput.value;
    });
    chip.appendChild(nameInput);

    const caption = document.createElement("div");
    caption.className = "bookmark-pattern-caption";
    caption.textContent = bm.pattern;
    chip.appendChild(caption);

    chip.appendChild(
      makeRemoveButton(() => {
        bookmarks = bookmarks.filter((x) => x.id !== bm.id);
        renderBookmarks();
      })
    );

    return chip;
  }

  function renderBookmarks() {
    bookmarksBoxEl.innerHTML = "";
    if (bookmarks.length === 0) {
      const hint = document.createElement("div");
      hint.className = "bookmarks-empty-hint";
      hint.textContent = "Save a pattern to see it here";
      bookmarksBoxEl.appendChild(hint);
      return;
    }
    bookmarks.forEach((bm) => bookmarksBoxEl.appendChild(buildBookmarkChip(bm)));
  }

  function focusBookmarkName(id) {
    const input = bookmarksBoxEl.querySelector(
      `.bookmark-chip[data-bookmark-id="${id}"] .bookmark-name-input`
    );
    if (input) {
      input.focus();
      input.select();
    }
  }

  function flyToBookmarks(originRect, onComplete) {
    if (!originRect) {
      onComplete();
      return;
    }
    const targetRect = bookmarksBoxEl.getBoundingClientRect();
    const ghost = document.createElement("div");
    ghost.className = "block cat-logic bookmark-fly-ghost";
    ghost.textContent = "group:";
    ghost.style.left = originRect.left + "px";
    ghost.style.top = originRect.top + "px";
    ghost.style.width = (originRect.width || 60) + "px";
    ghost.style.height = (originRect.height || 28) + "px";
    document.body.appendChild(ghost);

    const endX = targetRect.left + targetRect.width / 2 - 8;
    const endY = targetRect.top + 8;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ghost.style.left = endX + "px";
        ghost.style.top = endY + "px";
        ghost.style.width = "16px";
        ghost.style.height = "16px";
        ghost.style.fontSize = "0px";
        ghost.style.opacity = "0";
      });
    });

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      ghost.remove();
      onComplete();
    };
    ghost.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 650);
  }

  function saveBookmark(sourceNodes, originRect) {
    if (!sourceNodes || sourceNodes.length === 0) return;
    const groupNode = wrapForBookmark(sourceNodes);
    const pattern = computeNode(groupNode);
    const hadName = !!(groupNode.fields.name && groupNode.fields.name.trim());
    if (!hadName) groupNode.fields.name = nextDefaultBookmarkName();

    const entry = {
      id: ++bookmarkUidCounter,
      name: groupNode.fields.name,
      pattern,
      tree: groupNode,
    };

    flyToBookmarks(originRect, () => {
      bookmarks.push(entry);
      renderBookmarks();
      if (!hadName) focusBookmarkName(entry.id);
    });
  }

  function renderHighlightedOutput(re, text) {
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

    // Don't overwrite what the user is actively typing into the regex
    // field -- it only gets replaced once they rebuild blocks from it.
    if (document.activeElement !== regexOutputEl) {
      regexOutputEl.value = result.pattern;
    }

    const text = textInputEl.value;
    if (!result.pattern) {
      outputBoxEl.textContent = text;
      return;
    }

    const flags = "gm";
    let re;
    try {
      re = new RegExp(result.pattern, flags);
    } catch (e) {
      regexOutputEl.classList.add("error");
      regexOutputEl.placeholder = "Invalid regex: " + e.message;
      if (document.activeElement !== regexOutputEl) regexOutputEl.value = "";
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

    if (outputMode === "removed") {
      outputBoxEl.textContent = text.replace(re, "");
      return;
    }

    if (outputMode === "onlyMatches") {
      const matches = [];
      let guard = 0;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null && guard < 20000) {
        guard++;
        if (m[0]) matches.push(m[0]);
        if (m[0].length === 0) {
          re.lastIndex++;
          if (re.lastIndex > text.length) break;
        }
      }
      outputBoxEl.textContent = matches.join("\n");
      return;
    }

    renderHighlightedOutput(re, text);
  }

  // ---------------------------------------------------------------------
  // Drag and drop (Pointer Events: unifies mouse, touch and pen).
  // Any block -- toolbox or workbench -- can be dropped into the root
  // workbench or into any container's nested drop zone.
  // ---------------------------------------------------------------------

  const TAP_THRESHOLD_PX = 8;

  let dragGhost = null;
  let dragMode = null; // 'new' | 'move' | 'bookmark'
  let dragDefId = null;
  let dragUid = null;
  let dragBookmarkId = null;
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
    const dz = el.closest(".dropzone");
    if (dz) return dz;
    // Something with no dropzone of its own can still be drawn on top of
    // one -- on the phone layout, the Workbench's Save/Clear buttons
    // float directly over its own top-right corner (see .workbench-header
    // in style.css), which is exactly where an ordinary "move this chip
    // to the end" drag naturally lands. Falling through to "no dropzone
    // here" in that case would silently delete whatever was being
    // dragged (see onDragEnd's "dropped outside -> remove" branch), so
    // treat a point that's still geometrically inside the root Workbench
    // as a drop onto it regardless of what's drawn on top at that pixel.
    const wbRect = workbenchEl.getBoundingClientRect();
    if (x >= wbRect.left && x <= wbRect.right && y >= wbRect.top && y <= wbRect.bottom) {
      return workbenchEl;
    }
    return null;
  }

  function resolveBookmarksBox(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    return el.closest("#bookmarksBox");
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

    let ghostLabel;
    if (mode === "new") {
      dragDefId = payload;
      ghostLabel = dragGhostLabel(payload);
    } else if (mode === "bookmark") {
      dragBookmarkId = payload;
      const bm = bookmarks.find((b) => b.id === payload);
      ghostLabel = bm ? bm.name : "pattern";
    } else {
      dragUid = payload;
      dragSourceEl = document.querySelector(`.wb-chip[data-uid="${payload}"]`);
      if (dragSourceEl) {
        dragSourceEl.style.opacity = "0.3";
        dragSourceEl.style.pointerEvents = "none";
      }
      const inst = findInstanceByUid(workbenchState, payload);
      ghostLabel = dragGhostLabel(inst.defId);
    }

    dragGhost = document.createElement("div");
    dragGhost.className = "drag-ghost block";
    dragGhost.textContent = ghostLabel;
    document.body.appendChild(dragGhost);
    moveGhost(e);
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    startAutoScroll();

    document.addEventListener("pointermove", onDragMove);
    document.addEventListener("pointerup", onDragEnd);
    document.addEventListener("pointercancel", onDragEnd);
  }

  function moveGhost(e) {
    if (!dragGhost) return;
    dragGhost.style.left = e.clientX + "px";
    dragGhost.style.top = e.clientY + "px";
  }

  function updateDragOverHighlight(x, y) {
    const dz = resolveDropzone(x, y);
    document
      .querySelectorAll(".dropzone.drag-over")
      .forEach((el) => el.classList.remove("drag-over"));
    bookmarksBoxEl.classList.remove("drag-over-bookmarks");
    if (dz) dz.classList.add("drag-over");
    else if (dragMode === "move" && resolveBookmarksBox(x, y)) {
      bookmarksBoxEl.classList.add("drag-over-bookmarks");
    }
  }

  // Pointer Events don't get the auto-scroll a native HTML5 drag would
  // near a scroll container's edge -- and on the phone layout, the
  // Workbench/Toolbox/Saved/Output panels are each their own short,
  // internally-scrolling region rather than one long page (see the
  // max-width:860px rules in style.css), so it's usually one of THOSE
  // that needs scrolling, not the page itself. Find whatever's actually
  // scrollable under the pointer and nudge it whenever the pointer sits
  // near its top/bottom edge while a drag is active -- speed ramps up
  // the closer the pointer gets to the very edge.
  const AUTO_SCROLL_EDGE_PX = 50;
  const AUTO_SCROLL_MAX_SPEED = 14;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let autoScrollRAF = null;

  function findScrollableAncestor(el) {
    let node = el;
    while (node && node !== document.body) {
      if (node.scrollHeight > node.clientHeight + 1) {
        const overflowY = getComputedStyle(node).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function autoScrollTick() {
    if (!dragMode) {
      autoScrollRAF = null;
      return;
    }
    const underPointer = document.elementFromPoint(lastPointerX, lastPointerY);
    const target = underPointer ? findScrollableAncestor(underPointer) : null;
    if (target) {
      const isWindow =
        target === document.scrollingElement || target === document.documentElement;
      const rect = isWindow
        ? { top: 0, bottom: window.innerHeight }
        : target.getBoundingClientRect();
      let dy = 0;
      if (lastPointerY < rect.top + AUTO_SCROLL_EDGE_PX) {
        dy = -AUTO_SCROLL_MAX_SPEED * (1 - (lastPointerY - rect.top) / AUTO_SCROLL_EDGE_PX);
      } else if (lastPointerY > rect.bottom - AUTO_SCROLL_EDGE_PX) {
        dy = AUTO_SCROLL_MAX_SPEED * (1 - (rect.bottom - lastPointerY) / AUTO_SCROLL_EDGE_PX);
      }
      if (dy !== 0) {
        if (isWindow) window.scrollBy(0, dy);
        else target.scrollTop += dy;
        // The pointer hasn't actually moved -- content scrolled under
        // it -- so re-resolve what's now underneath it.
        updateDragOverHighlight(lastPointerX, lastPointerY);
      }
    }
    autoScrollRAF = requestAnimationFrame(autoScrollTick);
  }

  function startAutoScroll() {
    if (autoScrollRAF === null) autoScrollRAF = requestAnimationFrame(autoScrollTick);
  }

  function onDragMove(e) {
    if (e.pointerId !== activePointerId) return;
    if (
      !dragMoved &&
      Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY) > TAP_THRESHOLD_PX
    ) {
      dragMoved = true;
    }
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    moveGhost(e);
    updateDragOverHighlight(e.clientX, e.clientY);
  }

  function endDragCleanup() {
    document.removeEventListener("pointermove", onDragMove);
    document.removeEventListener("pointerup", onDragEnd);
    document.removeEventListener("pointercancel", onDragEnd);
    document
      .querySelectorAll(".dropzone.drag-over")
      .forEach((el) => el.classList.remove("drag-over"));
    bookmarksBoxEl.classList.remove("drag-over-bookmarks");
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
    dragBookmarkId = null;
    dragSourceEl = null;
    activePointerId = null;
    if (autoScrollRAF !== null) {
      cancelAnimationFrame(autoScrollRAF);
      autoScrollRAF = null;
    }
  }

  function onDragEnd(e) {
    if (e.pointerId !== activePointerId) return;

    const mode = dragMode;
    const isTap = !dragMoved;
    let dz = resolveDropzone(e.clientX, e.clientY);

    if (mode === "new" || mode === "bookmark") {
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
        if (mode === "new") {
          targetArray.splice(insertIndex, 0, makeInstance(dragDefId));
        } else {
          const bm = bookmarks.find((b) => b.id === dragBookmarkId);
          if (bm) targetArray.splice(insertIndex, 0, cloneTree(bm.tree));
        }
      }
    } else if (mode === "move" && dragMoved) {
      const droppedOnBookmarks = resolveBookmarksBox(e.clientX, e.clientY);
      const loc = findParentArrayAndIndex(workbenchState, dragUid);
      if (droppedOnBookmarks && loc) {
        const originRect = dragSourceEl ? dragSourceEl.getBoundingClientRect() : null;
        saveBookmark([loc.array[loc.index]], originRect);
      } else if (loc && dz) {
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

  // drag/tap a saved pattern into the workbench, the same way toolbox
  // blocks work (event delegation covers bookmarks added after load)
  bookmarksBoxEl.addEventListener("pointerdown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.classList.contains("remove-btn")) {
      return;
    }
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const chip = e.target.closest(".bookmark-chip");
    if (!chip) return;
    startDrag(e, "bookmark", parseInt(chip.dataset.bookmarkId, 10));
  });

  bookmarkBtn.addEventListener("click", () => {
    if (workbenchState.length === 0) return;
    saveBookmark(workbenchState.slice(), bookmarkBtn.getBoundingClientRect());
  });

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

  outputModeSwitchEl.addEventListener("change", (e) => {
    if (e.target.name !== "outputMode") return;
    outputMode = e.target.value;
    recompute();
  });

  // Phone-only tab bar (Toolbox / Saved / Output share one screen slot
  // below the always-visible Workbench -- see the max-width:860px rules
  // in style.css). The CSS ignores ".mobile-tab-active" entirely on a
  // wide screen, where every panel is already visible at once, so this
  // wiring is harmless there too and needs no screen-size check itself.
  const mobileTabBarEl = document.getElementById("mobileTabBar");
  mobileTabBarEl.querySelectorAll(".mobile-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      mobileTabBarEl
        .querySelectorAll(".mobile-tab-btn")
        .forEach((b) => {
          const isActive = b === btn;
          b.classList.toggle("active", isActive);
          b.setAttribute("aria-selected", isActive ? "true" : "false");
        });
      // More than one panel can share a tab slot (e.g. panel-about rides
      // along with panel-output), so toggle every matching element, not
      // just one fixed panel per tab.
      document.querySelectorAll("[data-mobile-tab]").forEach((panel) => {
        panel.classList.toggle("mobile-tab-active", panel.dataset.mobileTab === tab);
      });
    });
  });

  async function copyToClipboard(text, btn) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      document.execCommand("copy");
      helper.remove();
    }
    const original = btn.innerHTML;
    btn.classList.add("copied");
    btn.innerHTML = btn.classList.contains("field-icon-btn") ? "&#10003;" : "Copied!";
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.innerHTML = original;
    }, 1200);
  }

  copyBtn.addEventListener("click", () => copyToClipboard(regexOutputEl.value, copyBtn));
  outputCopyBtn.addEventListener("click", () =>
    copyToClipboard(outputBoxEl.textContent, outputCopyBtn)
  );
  outputCopyIconBtn.addEventListener("click", () =>
    copyToClipboard(outputBoxEl.textContent, outputCopyIconBtn)
  );

  // -- reverse parsing: rebuild the block tree from edited regex text ----

  function rebuildFromRegexText() {
    const text = regexOutputEl.value;
    let nodes;
    try {
      nodes = parseRegexToNodes(text);
    } catch (e) {
      regexParseErrorEl.textContent = e.message;
      return;
    }
    regexParseErrorEl.textContent = "";
    workbenchState = nodes;
    renderWorkbench();
    recompute();
  }

  rebuildBtn.addEventListener("click", rebuildFromRegexText);
  reloadBtn.addEventListener("click", rebuildFromRegexText);
  regexOutputEl.addEventListener("blur", () => {
    // Only re-parse if the text actually diverged from the last
    // generated pattern -- otherwise every click-away would needlessly
    // reset scroll position / selection in the field for no change.
    if (regexOutputEl.value !== computeRegex(workbenchState).pattern) {
      rebuildFromRegexText();
    }
  });
  regexOutputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      regexOutputEl.blur();
    }
  });
  regexOutputEl.addEventListener("input", () => {
    regexParseErrorEl.textContent = "";
  });

  renderToolbox();
  attachToolboxHandlers();
  renderBookmarks();
  renderWorkbench();
  recompute();
})();
