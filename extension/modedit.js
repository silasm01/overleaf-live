// Overleaf Live: the module toolbar's text logic (no UI).
// find(text, offset): the module environment around a position (fsm,
// circuit with gates or components, kmap, truthtable), with its actions.
// An action has a label, form fields and run(values) -> edits
// [{from, to, text}] in offsets of the text it was found in.
(function () {
  "use strict";

  // --- reading TeX arguments -------------------------------------------
  // the {…} or […] argument that starts at i (after spaces): {open, start,
  // end (inner), after}, or null
  function arg(t, i, open) {
    while (i < t.length && /\s/.test(t[i])) i++;
    if (t[i] !== open) return null;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    for (let j = i; j < t.length; j++) {
      const c = t[j];
      if (c === "\\") { j++; continue; }
      if (c === "{" || (open === "[" && c === "[")) depth++;
      else if (c === "}" || (open === "[" && c === "]")) {
        depth--;
        if (depth === 0) {
          if (c !== close) return null;
          return { start: i + 1, end: j, after: j + 1, text: t.slice(i + 1, j) };
        }
      }
    }
    return null;
  }

  // the top-level parts of a list "a, b, {c, d}" in [start, end): [{start, end, text}] (trimmed)
  function split(t, start, end, sep = ",") {
    const out = [];
    let depth = 0, a = start;
    const push = (b) => {
      let s = a, e = b;
      while (s < e && /\s/.test(t[s])) s++;
      while (e > s && /\s/.test(t[e - 1])) e--;
      if (e > s) out.push({ start: s, end: e, text: t.slice(s, e) });
    };
    for (let j = start; j < end; j++) {
      const c = t[j];
      if (c === "\\") { j++; continue; }
      if (c === "{" || c === "[" || c === "(") depth++;
      else if (c === "}" || c === "]" || c === ")") depth--;
      else if (depth === 0 && c === sep) { push(j); a = j + 1; }
    }
    push(end);
    return out;
  }

  // every \name{…} in [start, end): [{at, lineStart, lineEnd, args: [...]}];
  // spec: the kinds of the arguments, e.g. "{[{{" ("[" optional)
  function commands(t, start, end, name, spec) {
    const out = [];
    const re = new RegExp("\\\\" + name + "(?![A-Za-z@])", "g");
    re.lastIndex = start;
    let m;
    while ((m = re.exec(t)) && m.index < end) {
      if (commented(t, m.index)) continue;
      let i = m.index + m[0].length;
      const args = [];
      for (const k of spec) {
        const a = arg(t, i, k);
        if (!a) { if (k === "[") { args.push(null); continue; } break; }
        args.push(a);
        i = a.after;
      }
      if (args.filter((a) => a).length < [...spec].filter((k) => k === "{").length) continue;
      const ls = t.lastIndexOf("\n", m.index) + 1;
      let le = t.indexOf("\n", i);
      if (le < 0) le = t.length;
      out.push({ at: m.index, after: i, lineStart: ls, lineEnd: le, args });
    }
    return out;
  }

  function commented(t, i) {
    const ls = t.lastIndexOf("\n", i - 1) + 1;
    for (let j = ls; j < i; j++) {
      if (t[j] === "\\") { j++; continue; }
      if (t[j] === "%") return true;
    }
    return false;
  }

  // the whole line at [lineStart, lineEnd] with its newline: for removal
  const wholeLine = (t, c) => ({ from: c.lineStart, to: Math.min(t.length, c.lineEnd + 1), text: "" });
  const indentOf = (t, ls) => /^[ \t]*/.exec(t.slice(ls))[0];

  // a new line before the line that starts at ls
  const lineBefore = (ls, line) => ({ from: ls, to: ls, text: line + "\n" });
  // a new line after the line that ends at le
  const lineAfter = (le, line) => ({ from: le, to: le, text: "\n" + line });

  // the first unused name: a letter (from `from` on, then from a), or style + number
  function nextName(used, style, from) {
    if (style === "lower" || style === "upper") {
      const base = style === "lower" ? 97 : 65;
      const start = from ? from.charCodeAt(0) - base : 0;
      for (let k = 0; k < 26; k++) {
        const n = String.fromCharCode(base + (start + k) % 26);
        if (!used.includes(n)) return n;
      }
    }
    for (let i = 1; ; i++) if (!used.includes(style + i)) return style + i;
  }

  // --- the environment around the cursor -------------------------------
  const ENVS = ["fsm", "circuit", "kmap", "truthtable"];
  function find(t, offset) {
    let best = null;
    const re = /\\begin\s*\{(fsm|circuit|kmap|truthtable)\}/g;
    let m;
    while ((m = re.exec(t))) {
      if (m.index > offset) break;
      if (commented(t, m.index)) continue;
      const endTag = "\\end{" + m[1] + "}";
      const e = t.indexOf(endTag, m.index);
      if (e < 0) continue;
      const after = e + endTag.length;
      if (offset <= after) best = { env: m[1], begin: m.index, headEnd: m.index + m[0].length, end: e, after };
    }
    // the lines after a state machine (\fsmdiagram, \fsmtable, \fsmtiming):
    // that machine
    if (!best) {
      const ls = t.lastIndexOf("\n", offset - 1) + 1;
      if (/^\s*\\fsm(diagram|table|timing)/.test(t.slice(ls, ls + 80))) {
        const b = t.lastIndexOf("\\begin{fsm}", ls);
        if (b >= 0) {
          const e = t.indexOf("\\end{fsm}", b);
          if (e >= 0 && e < ls) best = { env: "fsm", begin: b, headEnd: b + 11, end: e, after: e + 9 };
        }
      }
    }
    if (!best) return null;
    const make = { fsm: fsmModule, circuit: circuitModule, kmap: kmapModule, truthtable: ttModule }[best.env];
    return make(t, best);
  }

  // --- state machine -----------------------------------------------------
  function fsmModule(t, env) {
    const opt = arg(t, env.headEnd, "[");
    const mealy = !!(opt && /mealy/.test(opt.text));
    const states = commands(t, env.headEnd, env.end, "state", mealy ? "{[{" : "{[{{").map((c) => {
      const name = c.args[0].text.trim();
      const trans = c.args[mealy ? 2 : 3];
      const entries = trans ? split(t, trans.start, trans.end).map((e) => {
        const colon = e.text.indexOf(":");
        if (colon < 0) return null;
        const keyEnd = e.start + colon;
        const val = split(t, keyEnd + 1, e.end, "/");
        return { key: e.text.slice(0, colon).trim(), entry: e, to: val[0] || null, out: val[1] || null };
      }).filter((x) => x) : [];
      return { cmd: c, name, code: c.args[1] && c.args[1].text.trim(), trans, entries };
    });
    const names = states.map((s) => s.name);
    let keys = [];
    for (const s of states) for (const e of s.entries) if (!keys.includes(e.key)) keys.push(e.key);
    if (!keys.length) keys = ["0", "1"];
    const stateOpts = names.length ? names : ["A"];
    const byName = (n) => states.find((s) => s.name === n);

    function newName() {
      if (names.every((n) => /^[A-Z]$/.test(n))) return nextName(names, "upper");
      const sub = names.map((n) => /^([A-Za-z]+)(_?\{?)(\d+)\}?$/.exec(n)).filter((x) => x);
      if (sub.length) {
        const [, p, u] = sub[0];
        let k = Math.max(...sub.map((x) => +x[3])) + 1;
        const brace = u.includes("{");
        return p + (u.includes("_") ? "_" : "") + (brace ? "{" + k + "}" : k);
      }
      return nextName(names, "S");
    }
    function newCode() {
      const codes = states.map((s) => s.code).filter((c) => c && /^[01]+$/.test(c));
      if (!codes.length) return "0";
      const w = Math.max(...codes.map((c) => c.length));
      for (let v = 0; v < 1 << w; v++) {
        const c = v.toString(2).padStart(w, "0");
        if (!codes.includes(c)) return c;
      }
      return (1 << w).toString(2);
    }

    // the edit that sets state `from`'s transition for `key`
    function setEntry(from, key, to, out) {
      const s = byName(from);
      if (!s || !s.trans) return [];
      const val = mealy ? `${to}/${out === undefined || out === "" ? "0" : out}` : to;
      const e = s.entries.find((x) => x.key === key);
      if (e) {
        const vs = t.indexOf(":", e.entry.start) + 1;
        return [{ from: vs, to: e.entry.end, text: " " + val }];
      }
      const sep = s.entries.length ? ", " : "";
      return [{ from: s.trans.end, to: s.trans.end, text: `${sep}${key}: ${val}` }];
    }

    const actions = [
      { id: "addState", label: "+ State",
        fields: () => [
          { name: "name", label: "Name", type: "text", value: newName() },
          ...(mealy ? [] : [{ name: "code", label: "Code", type: "text", value: newCode() },
                            { name: "out", label: "Output", type: "text", value: "0" }])],
        run(v) {
          const n = (v.name || newName()).trim();
          if (names.includes(n)) throw new Error(`a state ${n} already exists`);
          const trans = keys.map((k) => `${k}: ${n}${mealy ? "/0" : ""}`).join(", ");
          const line = mealy ? `\\state{${n}}{${trans}}`
                             : `\\state{${n}}[${(v.code || "").trim()}]{${(v.out || "0").trim()}}{${trans}}`;
          if (states.length) {
            const last = states[states.length - 1].cmd;
            return [lineAfter(last.lineEnd, indentOf(t, last.lineStart) + line)];
          }
          const ls = t.lastIndexOf("\n", env.end - 1) + 1;
          return [{ from: env.end, to: env.end, text: (/\S/.test(t.slice(ls, env.end)) ? "\n" : "") + "  " + line + "\n" }];
        } },
      { id: "setTrans", label: "Transition",
        fields: () => [
          { name: "from", label: "From", type: "select", options: stateOpts },
          { name: "key", label: "Input", type: "select", options: keys, editable: true },
          { name: "to", label: "To", type: "select", options: stateOpts },
          ...(mealy ? [{ name: "out", label: "Output", type: "text", value: "0" }] : [])],
        run(v) { return setEntry(v.from, String(v.key).trim(), v.to, v.out); } },
      { id: "removeState", label: "Remove state",
        fields: () => [{ name: "name", label: "State", type: "select", options: names,
                         note: "Transitions to it become loops on their own state." }],
        run(v) {
          const s = byName(v.name);
          if (!s) return [];
          const ed = [wholeLine(t, s.cmd)];
          for (const o of states) {
            if (o === s) continue;
            for (const e of o.entries) if (e.to && e.to.text === s.name) ed.push({ from: e.to.start, to: e.to.end, text: o.name });
          }
          return ed;
        } }];
    return { kind: "fsm", title: mealy ? "State machine (Mealy)" : "State machine (Moore)", env, actions };
  }

  // --- circuit: logic gates and/or components ----------------------------
  const GATES = ["and", "or", "not", "nand", "nor", "xor", "xnor", "buffer"];
  const PARTS = ["R", "C", "L", "V", "I", "D", "short", "open", "cV", "cI", "battery1", "lamp", "fuse", "ammeter", "voltmeter"];
  function circuitModule(t, env) {
    const gates = commands(t, env.headEnd, env.end, "gate", "{{{").map((c) => ({
      cmd: c, type: c.args[0].text.trim(), name: c.args[1].text.trim(),
      inputs: split(t, c.args[2].start, c.args[2].end).map((x) => x.text) }));
    const outputs = commands(t, env.headEnd, env.end, "outputs", "{");
    const ats = commands(t, env.headEnd, env.end, "at", "{");
    const nodes = [];
    for (const a of ats) {
      const re = /([A-Za-z]\w*)\s*\(\s*([-+\d.]+)\s*,\s*([-+\d.]+)\s*\)/g;
      let m;
      while ((m = re.exec(a.args[0].text))) nodes.push({ name: m[1], x: +m[2], y: +m[3] });
    }
    const comps = commands(t, env.headEnd, env.end, "comp", "{{{");
    const nodeNames = nodes.map((n) => n.name);
    const gateNames = gates.map((g) => g.name);
    const signals = [...new Set([...gates.flatMap((g) => g.inputs), ...gateNames])];
    const outGates = outputs.flatMap((o) => split(t, o.args[0].start, o.args[0].end).map((x) => x.text.split("=")[0].trim()));
    const usedOut = [...signals, ...outputs.flatMap((o) => split(t, o.args[0].start, o.args[0].end)
      .map((x) => x.text.split("=").pop().trim()))];
    const endLine = t.lastIndexOf("\n", env.end - 1) + 1;
    // a new line before \end{circuit}: inside, after the last line
    const atEnd = (line) => ({ from: env.end, to: env.end, text: (/\S/.test(t.slice(endLine, env.end)) ? "\n" : "") + "  " + line + "\n" });

    const gateActions = [
      { id: "addGate", label: "+ Gate",
        fields: () => [
          { name: "type", label: "Type", type: "select", options: GATES },
          { name: "name", label: "Name", type: "text", value: nextName(gateNames, "upper") },
          { name: "inputs", label: "Inputs", type: "text", value: "a, b",
            note: signals.length ? "Signals: " + signals.join(", ") : "Comma list of inputs or gate names." }],
        run(v) {
          const n = v.name.trim();
          if (gateNames.includes(n)) throw new Error(`a gate ${n} already exists`);
          const line = `\\gate{${v.type}}{${n}}{${v.inputs.trim()}}`;
          if (outputs.length) return [lineBefore(outputs[0].lineStart, indentOf(t, outputs[0].lineStart) + line)];
          if (gates.length) { const g = gates[gates.length - 1].cmd; return [lineAfter(g.lineEnd, indentOf(t, g.lineStart) + line)]; }
          return [atEnd(line)];
        } },
      { id: "addOutput", label: "+ Output",
        fields: () => [
          { name: "gate", label: "Gate", type: "select", options: gateNames.length ? gateNames : ["A"],
            value: gateNames.filter((g) => !outGates.includes(g)).pop() },
          { name: "name", label: "Output", type: "text", value: nextName(usedOut, "lower", "f") }],
        run(v) {
          const pair = `${v.gate}=${v.name.trim()}`;
          if (outputs.length) {
            const a = outputs[0].args[0];
            return [{ from: a.end, to: a.end, text: (/\S/.test(a.text) ? ", " : "") + pair }];
          }
          if (gates.length) { const g = gates[gates.length - 1].cmd; return [lineAfter(g.lineEnd, indentOf(t, g.lineStart) + `\\outputs{${pair}}`)]; }
          return [atEnd(`\\outputs{${pair}}`)];
        } },
      { id: "removeGate", label: "Remove gate",
        fields: () => [{ name: "name", label: "Gate", type: "select", options: gateNames }],
        run(v) { const g = gates.find((x) => x.name === v.name); return g ? [wholeLine(t, g.cmd)] : []; } }];

    const last = nodes[nodes.length - 1];
    const partActions = [
      { id: "addNode", label: "+ Node",
        fields: () => [
          { name: "name", label: "Name", type: "text", value: nextName(nodeNames, "lower") },
          { name: "x", label: "x", type: "text", value: String(last ? last.x + 3 : 0) },
          { name: "y", label: "y", type: "text", value: String(last ? last.y : 0) }],
        run(v) {
          const n = v.name.trim();
          if (nodeNames.includes(n)) throw new Error(`a node ${n} already exists`);
          if (!/^[-+]?\d*\.?\d+$/.test(v.x.trim()) || !/^[-+]?\d*\.?\d+$/.test(v.y.trim())) throw new Error("x and y must be numbers");
          const p = `${n}(${v.x.trim()},${v.y.trim()})`;
          if (ats.length) { const a = ats[ats.length - 1].args[0]; return [{ from: a.end, to: a.end, text: (/\S/.test(a.text) ? " " : "") + p }]; }
          return [{ from: env.headEnd, to: env.headEnd, text: `\n  \\at{${p}}` }];
        } },
      { id: "addComp", label: "+ Component",
        fields: () => [
          { name: "from", label: "From", type: "select", options: nodeNames },
          { name: "to", label: "To", type: "select", options: nodeNames, value: nodeNames[1] },
          { name: "type", label: "Type", type: "select", options: PARTS },
          { name: "label", label: "Label", type: "text", value: "", note: "Math, e.g. R_1 (empty: none)." }],
        run(v) {
          if (v.from === v.to) throw new Error("from and to must be different nodes");
          const l = v.label.trim();
          const line = `\\comp{${v.from}}{${v.to}}{${v.type}${l ? `=$${l}$` : ""}}`;
          if (comps.length) { const c = comps[comps.length - 1]; return [lineAfter(c.lineEnd, indentOf(t, c.lineStart) + line)]; }
          return [atEnd(line)];
        } },
      { id: "addWire", label: "+ Wire",
        fields: () => [{ name: "nodes", label: "Nodes", type: "text", value: nodeNames.slice(0, 2).join(", "),
                         note: "Comma list, in order: " + nodeNames.join(", ") }],
        run(v) {
          const ns = v.nodes.split(",").map((x) => x.trim()).filter(Boolean);
          const bad = ns.filter((x) => !nodeNames.includes(x));
          if (ns.length < 2) throw new Error("a wire needs two nodes at least");
          if (bad.length) throw new Error("no node " + bad.join(", "));
          return [atEnd(`\\wire{${ns.join(", ")}}`)];
        } },
      { id: "addGnd", label: "+ Ground",
        fields: () => [{ name: "node", label: "Node", type: "select", options: nodeNames }],
        run(v) { return [atEnd(`\\gnd{${v.node}}`)]; } }];

    const hasGates = gates.length > 0, hasParts = nodes.length > 0 || comps.length > 0;
    const actions = hasGates && !hasParts ? gateActions : hasParts && !hasGates ? partActions : [...gateActions, ...partActions];
    return { kind: "circuit", title: hasGates && !hasParts ? "Logic gates" : hasParts && !hasGates ? "Circuit" : "Circuit", env, actions };
  }

  // --- Karnaugh map --------------------------------------------------------
  function kmapModule(t, env) {
    const vars = arg(t, env.headEnd, "{");
    const n = vars ? split(t, vars.start, vars.end).length : 3;
    const cells = [...Array(1 << n).keys()].map(String);
    const imps = commands(t, env.headEnd, env.end, "implicant", "{{");
    const endLine = t.lastIndexOf("\n", env.end - 1) + 1;
    const atEnd = (line) => ({ from: env.end, to: env.end, text: (/\S/.test(t.slice(endLine, env.end)) ? "\n" : "") + "  " + line + "\n" });
    const actions = [
      { id: "addImplicant", label: "+ Implicant",
        fields: () => [
          { name: "a", label: "From cell", type: "select", options: cells },
          { name: "b", label: "To cell", type: "select", options: cells, value: cells[1] },
          { name: "note", type: "note", note: "The corner cells of the group (minterm numbers)." }],
        run(v) { return [atEnd(`\\implicant{${v.a}}{${v.b}}`)]; } },
      { id: "removeImplicant", label: "Remove implicant",
        fields: () => [{ name: "i", label: "Implicant", type: "select",
                         options: imps.map((c) => `${c.args[0].text}–${c.args[1].text}`) }],
        run(v) {
          const c = imps.find((x) => `${x.args[0].text}–${x.args[1].text}` === v.i);
          return c ? [wholeLine(t, c)] : [];
        } }];
    return { kind: "kmap", title: `Karnaugh map (${n} variables)`, env, actions };
  }

  // --- truth table ------------------------------------------------------------
  function ttModule(t, env) {
    const ins = arg(t, env.headEnd, "{"), outs = ins && arg(t, ins.after, "{");
    if (!ins || !outs) return null;
    const ni = split(t, ins.start, ins.end).length, no = split(t, outs.start, outs.end).length;
    // the rows: from the line after the head to \end
    let bodyStart = t.indexOf("\n", outs.after);
    bodyStart = bodyStart < 0 || bodyStart > env.end ? outs.after : bodyStart + 1;
    const bodyEnd = t.lastIndexOf("\n", env.end - 1) + 1;
    const rows = t.slice(bodyStart, bodyEnd).split("\n").filter((l) => /\\\\/.test(l)).map((l) => {
      const cut = l.indexOf("\\\\");
      return split(l, 0, cut, "&").map((c) => c.text).concat(Array(Math.max(0, ni + no - split(l, 0, cut, "&").length)).fill(""))
        .slice(0, ni + no).map((x) => x || "");
    });
    const fmt = (r) => "  " + r.map((c) => c === "" ? " " : c).join(" & ").replace(/ {2,}/g, (m) => m) + " \\\\";
    const body = (rs) => rs.map(fmt).join("\n") + "\n";
    const append = (a, name) => ({ from: a.end, to: a.end, text: (/\S/.test(a.text) ? ", " : "") + name });
    const names = [...split(t, ins.start, ins.end), ...split(t, outs.start, outs.end)].map((x) => x.text);
    const inNames = split(t, ins.start, ins.end).map((x) => x.text);
    const lastIn = /^[a-y]$/.test(inNames[inNames.length - 1] || "") ? String.fromCharCode(inNames[inNames.length - 1].charCodeAt(0) + 1) : "a";
    const actions = [
      { id: "addInput", label: "+ Input",
        fields: () => [{ name: "name", label: "Name", type: "text", value: nextName(names, "lower", lastIn),
                         note: "Each row becomes two (the new input 0 and 1)." }],
        run(v) {
          const nr = [];
          for (const r of rows) for (const bit of ["0", "1"]) nr.push([...r.slice(0, ni), bit, ...r.slice(ni)]);
          if (!rows.length) nr.push(["0", ...Array(no).fill("")], ["1", ...Array(no).fill("")]);
          return [append(ins, v.name.trim()), { from: bodyStart, to: bodyEnd, text: body(nr) }];
        } },
      { id: "addOutput", label: "+ Output",
        fields: () => [{ name: "name", label: "Name", type: "text", value: nextName(names, "lower", "f") }],
        run(v) {
          return [append(outs, v.name.trim()), { from: bodyStart, to: bodyEnd, text: body(rows.map((r) => [...r, ""])) }];
        } }];
    return { kind: "truthtable", title: `Truth table (${ni} in, ${no} out)`, env, actions };
  }

  const api = { find, arg, split, commands };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.OliveModEdit = api;
})();
