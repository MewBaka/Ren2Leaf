// Splits Ren'Py / Python source into logical lines. A logical line joins physical lines while a
// bracket or a string is open (Ren'Py strings may span lines) or after a trailing backslash, and
// drops comments. Each line carries two views of the same length:
//   text   - the source with comments removed
//   masked - the same, with every string's contents replaced by "~", so regexes see only code
// plus the string literals with their unescaped values and positions.

const QUOTES = new Set(['"', "'", "`"]);
const OPEN = { "(": ")", "[": "]", "{": "}" };
const CLOSE = new Set([")", "]", "}"]);
const PREFIX_RE = /(?:^|[^\w])([rRuUbBfF]{1,2})$/;
const ESCAPES = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'" };

function indentWidth(s) {
    let w = 0;
    for (const c of s) {
        if (c === " ") w++;
        else if (c === "\t") w = (Math.floor(w / 8) + 1) * 8;
        else break;
    }
    return w;
}

/**
 * @returns {{lines: Array<{line:number,endLine:number,indent:number,text:string,masked:string,
 *   strings:Array<{start:number,end:number,value:string,prefix:string}>}>, errors: Array}}
 */
export function lex(source, { backtickStrings = false } = {}) {
    const src = source.replace(/^﻿/, "");
    const lines = [];
    const errors = [];
    let text = "";
    let masked = "";
    let strings = [];
    let depth = 0;
    let lineNo = 1;
    let startLine = 1;
    let indent = 0;
    let atLineStart = true;

    const flush = () => {
        if (text.trim()) {
            lines.push({ line: startLine, endLine: lineNo, indent, text: text.trimEnd(), masked: masked.trimEnd(), strings });
        }
        text = "";
        masked = "";
        strings = [];
        depth = 0;
        atLineStart = true;
    };

    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        if (atLineStart) {
            // Measure the indent of a new logical line; blank lines are skipped.
            let j = i;
            while (j < n && (src[j] === " " || src[j] === "\t")) j++;
            indent = indentWidth(src.slice(i, j));
            startLine = lineNo;
            atLineStart = false;
            i = j;
            continue;
        }
        if (c === "\r") {
            i++;
            continue;
        }
        if (c === "\n") {
            if (depth > 0) {
                text += " ";
                masked += " ";
            } else if (text.endsWith("\\")) {
                text = text.slice(0, -1) + " ";
                masked = masked.slice(0, -1) + " ";
            } else {
                flush();
            }
            lineNo++;
            i++;
            continue;
        }
        if (c === "#") {
            while (i < n && src[i] !== "\n") i++;
            continue;
        }
        if (QUOTES.has(c) && (c !== "`" || backtickStrings)) {
            const triple = src.startsWith(c.repeat(3), i);
            const q = triple ? c.repeat(3) : c;
            const pm = PREFIX_RE.exec(text);
            const prefix = pm ? pm[1] : "";
            const start = text.length;
            const startLineOfString = lineNo;
            text += q;
            masked += q;
            i += q.length;
            let value = "";
            let closed = false;
            while (i < n) {
                const d = src[i];
                if (d === "\\" && i + 1 < n) {
                    const e = src[i + 1];
                    if (e === "\n") lineNo++;
                    value += prefix.toLowerCase().includes("r") ? d + e : (ESCAPES[e] ?? (e === "\n" ? "" : d + e));
                    text += d + (e === "\n" ? " " : e);
                    masked += "~~";
                    i += 2;
                    continue;
                }
                if (src.startsWith(q, i)) {
                    text += q;
                    masked += q;
                    i += q.length;
                    closed = true;
                    break;
                }
                if (d === "\n") {
                    lineNo++;
                    value += "\n";
                    text += " ";
                    masked += "~";
                    i++;
                    continue;
                }
                if (d === "\r") {
                    i++;
                    continue;
                }
                value += d;
                text += d;
                masked += "~";
                i++;
            }
            if (!closed) errors.push({ line: startLineOfString, message: "字符串没有闭合" });
            strings.push({ start, end: text.length, value, prefix });
            continue;
        }
        if (OPEN[c]) depth++;
        else if (CLOSE.has(c)) depth = Math.max(0, depth - 1);
        text += c;
        masked += c;
        i++;
    }
    flush();
    return { lines, errors };
}

/** Index of the bracket that closes the one at `open`, or -1. Works on masked text. */
export function matchBracket(masked, open) {
    const want = OPEN[masked[open]];
    if (!want) return -1;
    const stack = [want];
    for (let i = open + 1; i < masked.length; i++) {
        const c = masked[i];
        if (OPEN[c]) stack.push(OPEN[c]);
        else if (CLOSE.has(c)) {
            if (stack.pop() !== c) return -1;
            if (!stack.length) return i;
        }
    }
    return -1;
}

/** Bracket depth before each character of a masked line. */
export function depthMap(masked) {
    const out = new Array(masked.length);
    let d = 0;
    for (let i = 0; i < masked.length; i++) {
        const c = masked[i];
        if (CLOSE.has(c)) d = Math.max(0, d - 1);
        out[i] = d;
        if (OPEN[c]) d++;
    }
    return out;
}

/** Splits masked[a, b) at depth-0 commas. Returns [start, end) pairs, trimmed, empty ones dropped. */
export function splitArgs(masked, a, b) {
    const parts = [];
    let d = 0;
    let s = a;
    for (let i = a; i <= b; i++) {
        const c = i < b ? masked[i] : ",";
        if (OPEN[c]) d++;
        else if (CLOSE.has(c)) d--;
        else if (c === "," && d === 0) {
            let x = s;
            let y = i;
            while (x < y && /\s/.test(masked[x])) x++;
            while (y > x && /\s/.test(masked[y - 1])) y--;
            if (y > x) parts.push([x, y]);
            s = i + 1;
        }
    }
    return parts;
}

/**
 * End of the single expression starting at or after `i` in a masked line: an atom with its call,
 * index and attribute trailers, continued across binary and conditional operators. Stops before
 * the next screen-language property name.
 */
export function exprEnd(masked, i) {
    const n = masked.length;
    const ws = (k) => {
        while (k < n && masked[k] === " ") k++;
        return k;
    };
    let j = ws(i);
    for (;;) {
        // Unary operators.
        for (;;) {
            if (masked.startsWith("not ", j)) j = ws(j + 4);
            else if (masked[j] === "-" || masked[j] === "+" || masked[j] === "~" && masked[j + 1] !== "~") j = ws(j + 1);
            else break;
        }
        const atomStart = j;
        const pm = /^[rRuUbBfF]{1,2}(?=["'`])/.exec(masked.slice(j, j + 3));
        if (pm) j += pm[0].length;
        const c = masked[j];
        if (c === '"' || c === "'" || c === "`") {
            let run = 0;
            while (masked[j + run] === c) run++;
            if (run === 2 || run === 6) j += run;
            else {
                const q = run >= 3 ? c.repeat(3) : c;
                const close = masked.indexOf(q, j + q.length);
                j = close < 0 ? n : close + q.length;
            }
        } else if (OPEN[c]) {
            const close = matchBracket(masked, j);
            j = close < 0 ? n : close + 1;
        } else {
            const m = /^[\w.]+/.exec(masked.slice(j));
            if (!m) return atomStart;
            j += m[0].length;
        }
        // Trailers.
        for (;;) {
            if (masked[j] === "(" || masked[j] === "[") {
                const close = matchBracket(masked, j);
                j = close < 0 ? n : close + 1;
            } else if (masked[j] === "." && /[A-Za-z_]/.test(masked[j + 1] || "")) {
                j += 1 + /^\w+/.exec(masked.slice(j + 1))[0].length;
            } else break;
        }
        const k = ws(j);
        const op = /^(?:\*\*|\/\/|==|!=|<=|>=|<<|>>|[-+*\/%<>&|^]|(?:and|or|if|else|in|is|not in|is not)(?![\w]))/.exec(masked.slice(k));
        if (!op) return j;
        j = ws(k + op[0].length);
    }
}
