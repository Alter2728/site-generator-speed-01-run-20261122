// Fast drop-in for makefun-site 1.0.0: run(input) returns the same output
// tree (path -> text) as the reference build, byte for byte. The graded path
// is runJson(input): the whole answer object emitted as one JSON string,
// built during rendering so no output string is ever scanned twice —
// markdown HTML and template output are produced already JSON-escaped
// (static template text pre-escaped at compile time, HTML escapes fused
// with JSON escapes in a single pass), and run() is JSON.parse(runJson()).
// Manual scanners instead of regex batteries, a regex-accelerated inline
// renderer, per-build slug/date caches, lazily compiled templates.
// Dependency-free ES module; no network, clock, randomness or env reads.

const MARK_RE = /\p{M}/gu;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ESC_BY_CODE = { 38: '&amp;', 60: '&lt;', 62: '&gt;', 34: '&quot;', 39: '&#39;' };

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function isSpaceCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
}

function hasSpaceStr(t) {
  for (let i = 0; i < t.length; i++) if (isSpaceCode(t.charCodeAt(i))) return true;
  return false;
}

// ------------------------------------------------------------ JSON fusion

// A string already in JSON-escaped form (the content of a JSON string
// literal, without the quotes). Markdown HTML travels through the data
// model wrapped in JStr so template rendering can insert it raw without
// re-escaping; the wrapper is invisible to template paths (private field).
class JStr {
  #j;
  #hj;
  constructor(j) { this.#j = j; }
  get j() { return this.#j; }
  get hj() { return this.#hj ?? (this.#hj = jToHtmlJ(this.#j)); }
}

const jesc = (s) => JSON.stringify(s).slice(1, -1);

// jesc with a clean-string fast path (most raw var values need no escaping).
function jescFast(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 34 || c === 92 || c >= 0xD800) return jesc(s);
  }
  return s;
}

// HTML-escape then JSON-escape, fused into one regex pass. Equals
// jesc(escapeHtml(s)): entities carry no JSON-special chars, and every
// other char is JSON-escaped exactly as JSON.stringify would (lone
// surrogates become \udXXX, paired surrogates pass through).
const FUSED_RE = /[&<>"'\\\u0000-\u001f\ud800-\udfff]/g;
function fusedEscape(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 32 || c === 38 || c === 60 || c === 62 || c === 34 || c === 39 || c === 92 || c >= 0xD800) {
      return text.replace(FUSED_RE, (ch, off, str) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      case '\\': return '\\\\';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\t': return '\\t';
      case '\b': return '\\b';
      case '\f': return '\\f';
      default: {
        const c = ch.charCodeAt(0);
        if (c >= 0xD800 && c <= 0xDBFF) {
          const n = str.charCodeAt(off + 1);
          if (n >= 0xDC00 && n <= 0xDFFF) return ch;
        } else if (c >= 0xDC00 && c <= 0xDFFF) {
          const p = str.charCodeAt(off - 1);
          if (p >= 0xD800 && p <= 0xDBFF) return ch;
        }
        return '\\u' + c.toString(16).padStart(4, '0');
      }
    }
  });
    }
  }
  return text;
}

// J(escapeHtml(plain)) recovered from J(plain): \" becomes &quot;, every
// other JSON escape (\n, \\, \uXXXX, ...) is already correct for the
// HTML-escaped form, and literal & < > ' become entities. Backslashes in
// J form only ever start one of those escapes.
const J2H_RE = /\\.|[&<>']/g;
function jToHtmlJ(j) {
  return j.replace(J2H_RE, (m) => (m.charCodeAt(0) === 92 ? (m === '\\"' ? '&quot;' : m) : ESC_BY_CODE[m.charCodeAt(0)]));
}

// Whether a plain text run needs JSON escaping at all (control chars,
// backslash, or any surrogate — paired surrogates take the slow path too,
// JSON.stringify leaves them untouched).
const JDIRTY_RE = /[\u0000-\u001f\\\ud800-\udfff]/;
function flushRun(s, a, b, parts, dirty) {
  if (b <= a) return;
  const seg = s.slice(a, b);
  parts.push(dirty ? jesc(seg) : seg);
}

function slugify(ctx, text) {
  const hit = ctx.slugCache.get(text);
  if (hit !== undefined) return hit;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  let out = '';
  let gap = false;
  if (ascii) {
    let i = 0;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
        let j = i + 1;
        while (j < text.length) {
          const d = text.charCodeAt(j);
          if ((d >= 97 && d <= 122) || (d >= 48 && d <= 57)) j++;
          else break;
        }
        if (gap) out += '-';
        gap = false;
        out += text.slice(i, j);
        i = j;
      } else if (c >= 65 && c <= 90) {
        if (gap) out += '-';
        gap = false;
        out += String.fromCharCode(c + 32);
        i++;
      } else {
        gap = out.length > 0;
        i++;
      }
    }
  } else {
    const plain = text.normalize('NFKD').replace(MARK_RE, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  if (out.length > 64) out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e !== out.length) out = out.slice(0, e);
  const res = out === '' ? 'untitled' : out;
  ctx.slugCache.set(text, res);
  return res;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(ctx, date) {
  const hit = ctx.dateCache.get(date);
  if (hit !== undefined) return hit;
  const res = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  ctx.dateCache.set(date, res);
  return res;
}

const SPACE128 = new Uint8Array(128);
for (let c = 0; c < 128; c++) SPACE128[c] = isSpaceCode(c) ? 1 : 0;

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    const len = raw.length;
    if (len < 2 || raw.charCodeAt(len - 1) !== 34) return { error: 'a quoted string is not closed' };
    let special = false;
    for (let i = 1; i < len - 1; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92 || c === 34) { special = true; break; }
    }
    if (!special) return { value: raw.slice(1, len - 1) };
    let out = '';
    let run = 1;
    for (let i = 1; i < len - 1; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        const nc = raw.charCodeAt(i + 1);
        if ((nc !== 34 && nc !== 92) || i + 1 === len - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += raw.slice(run, i) + raw[i + 1];
        i++;
        run = i + 1;
      } else if (c === 34) return { error: 'a quoted string holds a stray quote' };
    }
    out += raw.slice(run, len - 1);
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isNameStr(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

function isSlugStr(raw) {
  if (raw.length === 0 || raw.length > 64) return false;
  let seg = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) {
      if (seg === 0) return false;
      seg = 0;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) seg++;
    else return false;
  }
  return seg > 0;
}

function valueOf(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringOf(raw);
    return s.error !== undefined ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
    let y = 0, mo = 0, d = 0;
    if (ok) {
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) { ok = false; break; }
      }
    }
    if (ok) {
      y = Number(raw.slice(0, 4));
      mo = Number(raw.slice(5, 7));
      d = Number(raw.slice(8, 10));
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
    }
    return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  }
  if (key === 'tags') {
    if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    for (const t of tags) {
      if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    return { value: tags };
  }
  if (key === 'draft') {
    return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    return isNameStr(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  // slug
  return isSlugStr(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
}

function parseFrontMatter(text) {
  const n = text.length;
  const e0 = text.indexOf('\n');
  const first = e0 === -1 ? text : text.slice(0, e0);
  if (first !== '---') return { error: 'no front matter' };
  if (e0 === -1) return { error: 'the front matter is not closed' };
  // First pass: collect front-matter lines and find the closing line.
  const fmLines = [];
  let pos = e0 + 1;
  let body = null;
  while (pos <= n) {
    const e = text.indexOf('\n', pos);
    const line = e === -1 ? text.slice(pos) : text.slice(pos, e);
    if (line === '---') {
      body = e === -1 ? '' : text.slice(e + 1);
      break;
    }
    fmLines.push(line);
    if (e === -1) break;
    pos = e + 1;
  }
  if (body === null) return { error: 'the front matter is not closed' };
  const data = {};
  for (let idx = 0; idx < fmLines.length; idx++) {
    const line = fmLines[idx];
    const i = idx + 1; // index in the split-lines view (opening --- is 0)
    let blank = true;
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank || line.charCodeAt(0) === 35) continue;
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    if (raw.includes('\u2028') || raw.includes('\u2029')) return { error: `line ${i + 1} is not "key: value"` };
    let re = raw.length;
    while (re > 0) {
      const c = raw.charCodeAt(re - 1);
      if (c === 32 || c === 9) re--;
      else break;
    }
    if (re !== raw.length) raw = raw.slice(0, re);
    const key = line.slice(0, k);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if (v.error !== undefined) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

function pathOf(name, text) {
  let ok = text.length > 0;
  let i = 0;
  while (ok) {
    const c = text.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95)) { ok = false; break; }
    i++;
    while (i < text.length) {
      const d = text.charCodeAt(i);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95) i++;
      else break;
    }
    if (i >= text.length) break;
    if (text.charCodeAt(i) !== 46) { ok = false; break; }
    i++;
    if (i >= text.length) { ok = false; break; }
  }
  if (!ok) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function isBlankRange(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlankRange(src, lineStart, open) && isBlankRange(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseForTag(tag) {
  if (!tag.startsWith('for ')) return null;
  let i = 4;
  const c = tag.charCodeAt(i);
  if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95)) return null;
  i++;
  while (i < tag.length) {
    const d = tag.charCodeAt(i);
    if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95) i++;
    else break;
  }
  const varName = tag.slice(4, i);
  if (tag.slice(i, i + 4) !== ' in ') return null;
  const path = tag.slice(i + 4);
  if (path === '' || hasSpaceStr(path)) return null;
  return { varName, path };
}

function parseIfTag(tag) {
  if (!tag.startsWith('if ')) return null;
  const rest = tag.slice(3);
  if (rest.startsWith('not ')) {
    const p = rest.slice(4);
    if (p !== '' && !hasSpaceStr(p)) return { not: true, path: p };
    return null;
  }
  if (rest !== '' && !hasSpaceStr(rest)) return { not: false, path: rest };
  return null;
}

function parseIncludeTag(tag) {
  if (!tag.startsWith('include "')) return null;
  if (tag.charCodeAt(tag.length - 1) !== 34) return null;
  const nm = tag.slice(9, -1);
  if (nm.length === 0) return null;
  for (let i = 0; i < nm.length; i++) {
    const c = nm.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return nm;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = parseForTag(tag)) !== null) {
        const node = { kind: 'for', name: m.varName, path: pathOf(name, m.path), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = parseIfTag(tag)) !== null) {
        const node = { kind: 'if', not: m.not, path: pathOf(name, m.path), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = parseIncludeTag(tag)) !== null) body.push({ kind: 'include', name: m });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// Root names a template may read, transitively through includes, with
// lexical loop bindings respected. A template whose reads are only the
// per-case constants (site/tags/recent) — plus optionally one caller loop
// variable and 'loop' — renders the same string whenever those inputs are
// the same, so its output can be memoized per case.
function ownReads(body, scopes, out) {
  for (const n of body) {
    if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
      if (!scopes.has(n.path[0])) out.add(n.path[0]);
      if (n.kind === 'if') {
        ownReads(n.then, scopes, out);
        if (n.else !== null) ownReads(n.else, scopes, out);
      }
    } else if (n.kind === 'for') {
      if (!scopes.has(n.path[0])) out.add(n.path[0]);
      const inner = new Set(scopes);
      inner.add(n.name);
      inner.add('loop');
      ownReads(n.body, inner, out);
    } else if (n.kind === 'include') out.add('\u0000' + n.name);
  }
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (v instanceof JStr) return JSON.parse(`"${v.j}"`);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Compile a parsed template to a JS function (R, H, D, P) that pushes
// JSON-escaped fragments into P. R is the flattened scope object
// (null-prototype): root vars plus the loop bindings currently in force,
// saved/restored around each loop body so an include sees exactly the
// scope the reference chain would. Loop variables of this template
// resolve lexically at compile time; later path steps keep the
// own-property, objects-only rule. Static text is JSON-escaped once,
// here at compile time.
function hasInclude(body) {
  for (const n of body) {
    if (n.kind === 'include') return true;
    if (n.kind === 'for' && hasInclude(n.body)) return true;
    if (n.kind === 'if' && (hasInclude(n.then) || (n.else !== null && hasInclude(n.else)))) return true;
  }
  return false;
}

function compileTemplate(nodes) {
  let uid = 0;
  const lines = [];
  function lookupExpr(path, scopes) {
    const first = path[0];
    let base = null;
    for (let s = scopes.length - 1; s >= 0; s--) {
      const m = scopes[s];
      if (m.has(first)) { base = m.get(first); break; }
    }
    let expr = base !== null ? base : `R[${JSON.stringify(first)}]`;
    for (let k = 1; k < path.length; k++) expr = `H.g(${expr},'${path[k]}')`;
    return expr;
  }
  function gen(body, scopes) {
    let pending = [];
    const flushPending = () => {
      if (pending.length > 0) {
        lines.push(`P.push(${pending.join('+')});`);
        pending = [];
      }
    };
    for (const n of body) {
      if (n.kind === 'text') pending.push(JSON.stringify(jesc(n.text)));
      else if (n.kind === 'var') pending.push(`((_v=${lookupExpr(n.path, scopes)}),typeof _v==='string'?H.e(_v):H.v(_v))`);
      else if (n.kind === 'raw') pending.push(`((_v=${lookupExpr(n.path, scopes)}),typeof _v==='string'?H.j(_v):H.t(_v))`);
      else if (n.kind === 'include') { flushPending(); lines.push(`{var f=H.gf(${JSON.stringify(n.name)});if(f!==undefined&&D<8)f(R,H,D+1,P);}`); }
      else if (n.kind === 'if') {
        flushPending();
        lines.push(`if(((_v=${lookupExpr(n.path, scopes)}),_v instanceof H.J?_v.j!=='' : _v!==undefined&&_v!==null&&_v!==false&&_v!==''&&_v!==0&&(!Array.isArray(_v)||_v.length>0))!==${n.not}){`);
        gen(n.then, scopes);
        if (n.else !== null) {
          lines.push('}else{');
          gen(n.else, scopes);
        }
        lines.push('}');
      } else if (n.kind === 'for') {
        flushPending();
        const id = uid++;
        const xs = `x${id}`, ii = `i${id}`, ln = `n${id}`, el = `e${id}`, lp = `l${id}`;
        lines.push(`var ${xs}=${lookupExpr(n.path, scopes)};if(Array.isArray(${xs})){var ${ln}=${xs}.length;for(var ${ii}=0;${ii}<${ln};${ii}++){var ${el}=${xs}[${ii}];var ${lp}={index:${ii}+1,first:${ii}===0,last:${ii}===${ln}-1,length:${ln}};`);
        const scope = new Map();
        if (n.name !== 'loop') scope.set(n.name, el);
        scope.set('loop', lp);
        // R only needs the bindings when an include in the body may read them.
        const saves = [];
        if (hasInclude(n.body)) {
          for (const [nm, ex] of scope) {
            const sv = `s${id}_${saves.length}`, sh = `h${id}_${saves.length}`;
            saves.push({ nm, sv, sh });
            lines.push(`var ${sh}=Object.hasOwn(R,${JSON.stringify(nm)});var ${sv}=R[${JSON.stringify(nm)}];R[${JSON.stringify(nm)}]=${ex};`);
          }
        }
        scopes.push(scope);
        gen(n.body, scopes);
        scopes.pop();
        for (let s = saves.length - 1; s >= 0; s--) {
          const { nm, sv, sh } = saves[s];
          lines.push(`R[${JSON.stringify(nm)}]=${sh}?${sv}:undefined;`);
        }
        lines.push('}}');
      }
    }
    flushPending();
  }
  gen(nodes, []);
  return new Function('R', 'H', 'D', 'P', `var _v;\n${lines.join('\n')}`);
}

// ---------------------------------------------------------------- markdown

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function fenceOpen(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const langEnd = i;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else break;
  }
  if (i !== line.length) return null;
  return line.slice(3, langEnd);
}

function isFenceClose(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function headingOf(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6 || d >= line.length) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  let s = d;
  while (s < line.length) {
    const ch = line.charCodeAt(s);
    if (ch === 32 || ch === 9) s++;
    else break;
  }
  let e = line.length;
  while (e > s) {
    const ch = line.charCodeAt(e - 1);
    if (ch === 32 || ch === 9) e--;
    else break;
  }
  if (e <= s) return null;
  const text = line.slice(s, e);
  if (text.includes('\u2028') || text.includes('\u2029')) return null;
  return { depth: d, text };
}

function isHr(line) {
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  if (!((c0 === 45 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45) || (c0 === 42 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42))) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 !== 45 && c0 !== 42) || line.charCodeAt(1) !== 32) return null;
  const text = line.slice(2);
  if (text.includes('\u2028') || text.includes('\u2029')) return null;
  return text;
}

function orderedOf(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  const text = line.slice(i + 2);
  if (text.includes('\u2028') || text.includes('\u2029')) return null;
  return { num: Number(line.slice(0, i)), text };
}

function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < line.length && !isSpaceCode(line.charCodeAt(i));
}

function isHeading(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6 || d >= line.length) return false;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return false;
  let s = d;
  while (s < line.length) {
    const ch = line.charCodeAt(s);
    if (ch === 32 || ch === 9) s++;
    else break;
  }
  let e = line.length;
  while (e > s) {
    const ch = line.charCodeAt(e - 1);
    if (ch === 32 || ch === 9) e--;
    else break;
  }
  if (e <= s) return false;
  const u1 = line.indexOf('\u2028', s);
  if (u1 !== -1 && u1 < e) return false;
  const u2 = line.indexOf('\u2029', s);
  if (u2 !== -1 && u2 < e) return false;
  return true;
}

function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 35) return isHeading(line);
  if (c === 96) return fenceOpen(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  if (c === 32 || c === 9) return isBlankLine(line);
  return false;
}

function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e) {
    const c = line.charCodeAt(s);
    if (c === 32 || c === 9) s++;
    else break;
  }
  while (e > s) {
    const c = line.charCodeAt(e - 1);
    if (c === 32 || c === 9) e--;
    else break;
  }
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

function isEscapable(c) {
  return c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 || c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 || c === 33 || c === 62;
}

// Whether position j is consumed as the escaped char of a backslash pair,
// scanning from `from`: an odd run of backslashes immediately before j
// (within [from, j)) means the last one escapes s[j] when s[j] is escapable.
function isEscapedAt(s, from, j) {
  let run = 0;
  for (let k = j - 1; k >= from && s.charCodeAt(k) === 92; k--) run++;
  return run % 2 === 1;
}

function findUnescaped(s, what, from, end) {
  const wl = what.length;
  let j = from;
  while (j <= end - wl) {
    j = s.indexOf(what, j);
    if (j === -1 || j > end - wl) return -1;
    if (isEscapedAt(s, from, j)) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

function findSingleStar(s, from, end) {
  let j = from;
  while (j < end) {
    j = s.indexOf('*', j);
    if (j === -1 || j >= end) return -1;
    if (isEscapedAt(s, from, j)) {
      j++;
      continue;
    }
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
      j += 2;
      continue;
    }
    return j;
  }
  return -1;
}

// Code-span content: HTML-escape fused with JSON-escape, in J form.
function escapeRangeJ(s, a, b, parts) {
  let run = a;
  let dirty = false;
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (i > run) {
        const seg = s.slice(run, i);
        parts.push(dirty ? jesc(seg) : seg);
      }
      parts.push(ESC_BY_CODE[c]);
      run = i + 1;
      dirty = false;
    } else if (c < 32 || c === 92 || c >= 0xD800) dirty = true;
  }
  if (b > run) {
    const seg = s.slice(run, b);
    parts.push(dirty ? jesc(seg) : seg);
  }
}

const CAT128 = new Uint8Array(128);
CAT128[92] = 1; CAT128[96] = 2; CAT128[42] = 3; CAT128[91] = 4;
CAT128[38] = 5; CAT128[60] = 5; CAT128[62] = 5; CAT128[34] = 5; CAT128[39] = 5;

// Next-special scanner: the regex engine skips plain runs natively; the
// shared regex's lastIndex is reset at every entry and after every
// recursive call, so recursion cannot disturb an outer scan.
const SPECRE = /[\\`*\[&<>"'\u0000-\u001f\ud800-\udfff]/g;

const JESC_CTRL = { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r' };

function renderInline(s, a, b, linkFn, parts) {
  let run = a;
  const re = SPECRE;
  re.lastIndex = a;
  let m;
  while ((m = re.exec(s)) !== null) {
    const i = m.index;
    if (i >= b) break;
    const c = s.charCodeAt(i);
    const cat = c < 128 ? CAT128[c] : 0;
    if (cat === 0) {
      // A JSON-dirty char inside a plain run: flush the clean slice before
      // it and emit its JSON escape directly. Paired surrogates stay in
      // the run (JSON leaves them as-is); lone ones are escaped.
      if (c >= 0xD800) {
        if (c <= 0xDBFF) {
          const n = s.charCodeAt(i + 1);
          if (n >= 0xDC00 && n <= 0xDFFF) continue;
        } else {
          const pv = s.charCodeAt(i - 1);
          if (pv >= 0xD800 && pv <= 0xDBFF) continue;
        }
        if (i > run) parts.push(s.slice(run, i));
        parts.push('\\u' + c.toString(16));
        run = i + 1;
      } else {
        if (i > run) parts.push(s.slice(run, i));
        parts.push(JESC_CTRL[c] ?? ('\\u' + c.toString(16).padStart(4, '0')));
        run = i + 1;
      }
      continue;
    }
    if (cat === 1) {
      if (i + 1 < b && isEscapable(s.charCodeAt(i + 1))) {
        if (i > run) parts.push(s.slice(run, i));
        const nc = s.charCodeAt(i + 1);
        parts.push(nc === 62 ? '&gt;' : nc === 92 ? '\\\\' : s[i + 1]);
        run = i + 2;
        re.lastIndex = run;
      } else {
        if (i > run) parts.push(s.slice(run, i));
        parts.push('\\\\');
        run = i + 1;
      }
      continue;
    }
    if (cat === 2) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        if (i > run) parts.push(s.slice(run, i));
        parts.push('<code>');
        escapeRangeJ(s, i + 1, j, parts);
        parts.push('</code>');
        run = j + 1;
        re.lastIndex = run;
      }
      continue;
    }
    if (cat === 3) {
      if (i + 1 < b && s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j > i + 2) {
          if (i > run) parts.push(s.slice(run, i));
          parts.push('<strong>');
          renderInline(s, i + 2, j, linkFn, parts);
          parts.push('</strong>');
          run = j + 2;
          re.lastIndex = run;
        } else re.lastIndex = i + 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j > i + 1) {
        if (i > run) parts.push(s.slice(run, i));
        parts.push('<em>');
        renderInline(s, i + 1, j, linkFn, parts);
        parts.push('</em>');
        run = j + 1;
        re.lastIndex = run;
      }
      continue;
    }
    if (cat === 4) {
      const k = findUnescaped(s, ']', i + 1, b);
      let mm = -1;
      if (k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40) mm = s.indexOf(')', k + 2);
      if (mm !== -1 && mm < b) {
        const target = s.slice(k + 2, mm);
        if (target !== '' && !hasSpaceStr(target)) {
          if (i > run) parts.push(s.slice(run, i));
          parts.push('<a href=\\"', linkFn(target), '\\">');
          renderInline(s, i + 1, k, linkFn, parts);
          parts.push('</a>');
          run = mm + 1;
          re.lastIndex = run;
          continue;
        }
      }
      continue;
    }
    if (i > run) parts.push(s.slice(run, i));
    parts.push(ESC_BY_CODE[c]);
    run = i + 1;
  }
  if (b > run) parts.push(s.slice(run, b));
}

const PARTS = [];

function inlineStrJ(s, linkFn) {
  PARTS.length = 0;
  renderInline(s, 0, s.length, linkFn, PARTS);
  return PARTS.join('');
}

const OUT = [];
const BP = [];

function wordsOfBody(src) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    const sp = c < 128 ? SPACE128[c] : isSpaceCode(c) ? 1 : 0;
    if (sp) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

function renderBody(ctx, src, linkFn) {
  const lines = src.split('\n');
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  const out = OUT;
  out.length = 0;
  const N = lines.length;
  let i = 0;
  while (i < N) {
    const line = lines[i];
    if (line.length === 0) { i++; continue; }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlankLine(line)) { i++; continue; }
    } else if (c0 === 96) {
      const fence = fenceOpen(line);
      if (fence !== null) {
        out.push('<pre><code');
        if (fence !== '') out.push(' class=\\"language-', fence, '\\"');
        out.push('>');
        i++;
        while (i < N && !isFenceClose(lines[i])) {
          out.push(fusedEscape(lines[i]), '\\n');
          i++;
        }
        i++;
        out.push('</code></pre>\\n');
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(ctx, h.text), ids);
        const html = inlineStrJ(h.text, linkFn);
        out.push('<h', String(h.depth), ' id=\\"', id, '\\">', html, '</h', String(h.depth), '>\\n');
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html: new JStr(html) });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        out.push('<hr>\\n');
        i++;
        continue;
      }
    }
    if (c0 === 62) {
      BP.length = 0;
      while (i < N && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        const t = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') BP.push(t);
        i++;
      }
      if (BP.length === 0) out.push('<blockquote>\\n</blockquote>\\n');
      else {
        const joined = BP.join('\n');
        out.push('<blockquote>\\n<p>');
        renderInline(joined, 0, joined.length, linkFn, out);
        out.push('</p>\\n</blockquote>\\n');
      }
      continue;
    }
    const b = c0 === 45 || c0 === 42 ? bulletOf(line) : null;
    const o = b === null && c0 >= 48 && c0 <= 57 ? orderedOf(line) : null;
    if (b !== null || o !== null) {
      const ordered = o !== null;
      const start = ordered ? o.num : 1;
      out.push(ordered && start !== 1 ? `<ol start=\\"${start}\\">\\n` : ordered ? '<ol>\\n' : '<ul>\\n');
      BP.length = 0;
      BP.push(trimLine(ordered ? o.text : b));
      i++;
      while (i < N) {
        const l = lines[i];
        const mm = ordered ? orderedOf(l) : bulletOf(l);
        if (mm !== null) {
          const joined = BP.join('\n');
          out.push('<li>');
          renderInline(joined, 0, joined.length, linkFn, out);
          out.push('</li>\\n');
          BP.length = 0;
          BP.push(trimLine(ordered ? mm.text : mm));
          i++;
        } else if (isContinued(l)) {
          BP.push(trimLine(l));
          i++;
        } else break;
      }
      {
        const joined = BP.join('\n');
        out.push('<li>');
        renderInline(joined, 0, joined.length, linkFn, out);
        out.push('</li>\\n');
      }
      out.push(ordered ? '</ol>\\n' : '</ul>\\n');
      continue;
    }
    BP.length = 0;
    BP.push(trimLine(line));
    i++;
    while (i < N && !endsParagraph(lines[i])) {
      BP.push(trimLine(lines[i]));
      i++;
    }
    const joined = BP.join('\n');
    if (excerpt === null) {
      const html = inlineStrJ(joined, linkFn);
      excerpt = html;
      out.push('<p>', html, '</p>\\n');
    } else {
      out.push('<p>');
      renderInline(joined, 0, joined.length, linkFn, out);
      out.push('</p>\\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- links

function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  let i = 1;
  while (i < target.length) {
    const c = target.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) i++;
    else break;
  }
  return target.charCodeAt(i) === 58;
}

function resolvePath(dirParts, dirStr, rel) {
  // Fast path: no '.' or '..' segment and no empty segment, so the joined
  // result is the directory prefix plus rel verbatim.
  if (rel.charCodeAt(0) !== 46 && !rel.includes('/.') && !rel.includes('//') && rel.charCodeAt(rel.length - 1) !== 47) {
    return dirStr === '' ? rel : `${dirStr}/${rel}`;
  }
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// Returns the href in J form: J(escapeHtml(url)), fused in one pass.
function makeLinkFn(base, dirParts, dirStr, bySource, staticPaths, broken, srcPath) {
  const cache = new Map();
  return (target) => {
    const hit = cache.get(target);
    if (hit !== undefined) return hit;
    let res;
    if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) {
      res = target;
    } else {
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dirParts, dirStr, rel);
      if (path !== null && bySource.has(path)) res = bySource.get(path).url + frag;
      else if (path !== null && staticPaths.has(path)) res = `${base}/${path}${frag}`;
      else {
        broken.add(`broken-link ${srcPath} -> ${target}`);
        res = target;
      }
    }
    res = fusedEscape(res);
    cache.set(target, res);
    return res;
  };
}

// ---------------------------------------------------------------- build

export function runJson(input) {
  const ctx = { slugCache: new Map(), dateCache: new Map() };
  const report = [];
  const asts = Object.create(null);
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      asts[name] = parseTemplate(name, input.templates[name]);
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }
  const readSets = Object.create(null);
  for (const name of Object.keys(asts)) {
    const out = new Set();
    ownReads(asts[name], new Set(), out);
    readSets[name] = out;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of Object.keys(readSets)) {
      const out = readSets[name];
      for (const r of [...out]) {
        if (r.charCodeAt(0) === 0) {
          const inc = readSets[r.slice(1)];
          if (inc !== undefined) {
            for (const x of inc) {
              if (!out.has(x)) { out.add(x); changed = true; }
            }
          }
        }
      }
    }
  }
  // name -> loop var name it may read besides the constants ('' if none),
  // or undefined when not memoizable.
  const memoVar = Object.create(null);
  for (const name of Object.keys(readSets)) {
    let extra = '';
    let ok = true;
    for (const r of readSets[name]) {
      if (r.charCodeAt(0) === 0 || r === 'site' || r === 'tags' || r === 'recent' || r === 'loop') continue;
      if (extra === '') extra = r;
      else if (extra !== r) { ok = false; break; }
    }
    if (ok) memoVar[name] = extra;
  }
  const memoCache = new Map();
  const memoWeak = new WeakMap();
  let siteRef = null;
  let tagsRef = null;
  let recentRef = null;
  const fns = Object.create(null);
  const H = {
    J: JStr,
    e: fusedEscape,
    j: jescFast,
    g: (v, k) => (v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined),
    gf: (name) => {
      let f = fns[name];
      if (f === undefined) {
        const ast = asts[name];
        if (ast === undefined) return undefined;
        f = compileTemplate(ast);
        const mv = memoVar[name];
        if (mv !== undefined) {
          const raw = f;
          f = (R, H, D, P) => {
            if (R.site !== siteRef || R.tags !== tagsRef || R.recent !== recentRef) {
              raw(R, H, D, P);
              return;
            }
            if (mv === '') {
              const key = `${name}@${D}`;
              let hit = memoCache.get(key);
              if (hit === undefined) {
                const tmp = [];
                raw(R, H, D, tmp);
                hit = tmp.join('');
                memoCache.set(key, hit);
              }
              P.push(hit);
              return;
            }
            const el = R[mv];
            if (el === null || typeof el !== 'object') {
              raw(R, H, D, P);
              return;
            }
            const lp = R.loop;
            const key = `${name}@${D}@${lp ? lp.index : 0}@${lp ? lp.length : 0}`;
            let perEl = memoWeak.get(el);
            if (perEl === undefined) {
              perEl = new Map();
              memoWeak.set(el, perEl);
            }
            let hit = perEl.get(key);
            if (hit === undefined) {
              const tmp = [];
              raw(R, H, D, tmp);
              hit = tmp.join('');
              perEl.set(key, hit);
            }
            P.push(hit);
          };
        }
        fns[name] = f;
      }
      return f;
    },
    t: (v) => (v instanceof JStr ? v.j : jescFast(textOf(v))),
    v: (v) => (v instanceof JStr ? v.hj : fusedEscape(textOf(v))),
    y: (v) => (v instanceof JStr ? v.j !== '' : truthy(v)),
  };
  let base = input.site.base_url;
  {
    let e = base.length;
    while (e > 0 && base.charCodeAt(e - 1) === 47) e--;
    if (e !== base.length) base = base.slice(0, e);
  }
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      let text = f.content;
      if (text.includes('\r')) text = text.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (asts[layout] === undefined) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(ctx, s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const md = renderBody(ctx, s.body, makeLinkFn(base, dirParts, dir, bySource, staticPaths, broken, s.path));
    s.html = new JStr(md.html);
    s.toc = md.toc;
    s.excerpt = new JStr(md.excerpt);
  }
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(ctx, name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push({ name, slug });
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  const linkOf = (s) => (s === null ? null : (s.link ?? (s.link = { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(ctx, s.data.date) })));
  const readingOf = (s) => s.rm ?? (s.rm = Math.max(1, Math.ceil(wordsOfBody(s.body) / 200)));
  const cardOf = (s) => {
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(ctx, s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      tags: s.tagRefs.map((t) => t.cardTag ?? (t.cardTag = { name: t.name, slug: t.slug, url: t.url })),
    };
    Object.defineProperty(card, 'reading_minutes', { enumerable: true, get: () => readingOf(s) });
    return card;
  };
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => {
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      title: card.title,
      url: card.url,
      date: card.date,
      date_long: card.date_long,
      summary: card.summary,
      excerpt: card.excerpt,
      tags: card.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    Object.defineProperty(page, 'reading_minutes', { enumerable: true, get: () => readingOf(s) });
    return page;
  };
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  siteRef = site;
  tagsRef = allTags;
  recentRef = recent;
  const parts = ['{'];
  const emitted = new Set();
  let first = true;
  const keyJson = (key) => {
    for (let i = 0; i < key.length; i++) {
      const c = key.charCodeAt(i);
      if (c < 32 || c === 34 || c === 92 || c >= 0xD800) return JSON.stringify(key);
    }
    return `"${key}"`;
  };
  const begin = (key) => {
    parts.push(first ? '' : ',', keyJson(key), ':"');
    first = false;
    emitted.add(key);
  };
  const R = Object.create(null);
  R.site = site;
  R.tags = allTags;
  R.recent = recent;
  const renderInto = (fn, vars) => {
    R.page = vars.page;
    R.posts = vars.posts;
    R.pager = vars.pager;
    R.tag = vars.tag;
    fn(R, H, 0, parts);
  };
  for (const s of kept) {
    begin(`${s.outDir}/index.html`);
    renderInto(H.gf(s.layout), { page: pageOf(s) });
    parts.push('"');
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  const indexFn = H.gf('index');
  if (indexFn !== undefined) {
    for (let k = 1; k <= pages; k++) {
      begin(k === 1 ? 'index.html' : `page/${k}/index.html`);
      renderInto(indexFn, {
        posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      parts.push('"');
    }
  }
  const tagFn = H.gf('tag');
  if (tagFn !== undefined) {
    for (const t of tags) {
      begin(`tags/${t.slug}/index.html`);
      renderInto(tagFn, { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
      parts.push('"');
    }
  }
  const tagsFn = H.gf('tags');
  if (tagsFn !== undefined) {
    begin('tags/index.html');
    renderInto(tagsFn, {});
    parts.push('"');
  }
  for (const f of statics) {
    if (emitted.has(f.path)) {
      report.push(`shadowed ${f.path}: a built page has its path`);
      continue;
    }
    emitted.add(f.path);
    if (f.path === 'build-report.txt') continue; // the report overwrites it
    parts.push(first ? '' : ',', keyJson(f.path), ':"', jesc(f.content), '"');
    first = false;
  }
  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${kept.filter((s) => !s.post).length} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  parts.push(first ? '' : ',', '"build-report.txt":"', jesc(`${lines.join('\n')}\n`), '"');
  parts.push('}');
  return parts.join('');
}

export function run(input) {
  return JSON.parse(runJson(input));
}
