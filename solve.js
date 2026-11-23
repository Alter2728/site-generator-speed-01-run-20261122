// Fast drop-in for makefun-site 1.0.0: run(input) returns the same output
// tree (path -> text) as the reference build, byte for byte, computed with a
// fused single-pass pipeline: manual scanners instead of regex batteries, a
// range-based inline renderer that copies plain runs in bulk, per-build slug
// and date caches, and templates compiled once to plain JS functions.
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

function escapeHtml(text) {
  let idx = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) { idx = i; break; }
  }
  if (idx === -1) return text;
  let out = text.slice(0, idx);
  let run = idx;
  for (let i = idx; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (i > run) out += text.slice(run, i);
      out += ESC_BY_CODE[c];
      run = i + 1;
    }
  }
  if (run < text.length) out += text.slice(run);
  return out;
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
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep < 0) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
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

function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const sp = c < 128 ? SPACE128[c] : isSpaceCode(c) ? 1 : 0;
    if (sp) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

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

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Compile a parsed template to a JS function (R, H, D) -> string.
// R is the flattened scope object (null-prototype): root vars plus the loop
// bindings currently in force, saved/restored around each loop body so an
// include sees exactly the scope the reference chain would. Loop variables
// of this template resolve lexically at compile time; later path steps go
// through H.g, which keeps the own-property, objects-only rule.
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
    for (let k = 1; k < path.length; k++) expr = `(_v=${expr},_v!==null&&typeof _v==='object'&&Object.hasOwn(_v,'${path[k]}')?_v.${path[k]}:undefined)`;
    return expr;
  }
  function gen(body, scopes) {
    for (const n of body) {
      if (n.kind === 'text') lines.push(`O+=${JSON.stringify(n.text)};`);
      else if (n.kind === 'var') lines.push(`O+=H.v(${lookupExpr(n.path, scopes)});`);
      else if (n.kind === 'raw') lines.push(`O+=H.t(${lookupExpr(n.path, scopes)});`);
      else if (n.kind === 'include') lines.push(`{var f=H.f[${JSON.stringify(n.name)}];if(f!==undefined&&D<8)O+=f(R,H,D+1);}`);
      else if (n.kind === 'if') {
        lines.push(`if(H.y(${lookupExpr(n.path, scopes)})!==${n.not}){`);
        gen(n.then, scopes);
        if (n.else !== null) {
          lines.push('}else{');
          gen(n.else, scopes);
        }
        lines.push('}');
      } else if (n.kind === 'for') {
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
  }
  gen(nodes, []);
  return new Function('R', 'H', 'D', `var O='';var _v;\n${lines.join('\n')}\nreturn O;`);
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

function escapeRange(s, a, b, parts) {
  let run = a;
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (i > run) parts.push(s.slice(run, i));
      parts.push(ESC_BY_CODE[c]);
      run = i + 1;
    }
  }
  if (b > run) parts.push(s.slice(run, b));
}

const CAT128 = new Uint8Array(128);
CAT128[92] = 1; CAT128[96] = 2; CAT128[42] = 3; CAT128[91] = 4;
CAT128[38] = 5; CAT128[60] = 5; CAT128[62] = 5; CAT128[34] = 5; CAT128[39] = 5;

function renderInline(s, a, b, linkFn, parts) {
  let i = a;
  let run = a;
  while (i < b) {
    const c = s.charCodeAt(i);
    const cat = c < 128 ? CAT128[c] : 0;
    if (cat === 0) { i++; continue; }
    if (cat === 1 && i + 1 < b && isEscapable(s.charCodeAt(i + 1))) {
      if (i > run) parts.push(s.slice(run, i));
      const nc = s.charCodeAt(i + 1);
      parts.push(nc === 62 ? '&gt;' : s[i + 1]);
      i += 2;
      run = i;
      continue;
    }
    if (cat === 2) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        if (i > run) parts.push(s.slice(run, i));
        parts.push('<code>');
        escapeRange(s, i + 1, j, parts);
        parts.push('</code>');
        i = j + 1;
        run = i;
      } else i++;
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
          i = j + 2;
          run = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j > i + 1) {
        if (i > run) parts.push(s.slice(run, i));
        parts.push('<em>');
        renderInline(s, i + 1, j, linkFn, parts);
        parts.push('</em>');
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (cat === 4) {
      const k = findUnescaped(s, ']', i + 1, b);
      let m = -1;
      if (k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40) m = s.indexOf(')', k + 2);
      if (m !== -1 && m < b) {
        const target = s.slice(k + 2, m);
        if (target !== '' && !hasSpaceStr(target)) {
          if (i > run) parts.push(s.slice(run, i));
          parts.push('<a href="', linkFn(target), '">');
          renderInline(s, i + 1, k, linkFn, parts);
          parts.push('</a>');
          i = m + 1;
          run = i;
          continue;
        }
      }
      i++;
      continue;
    }
    if (cat === 5) {
      if (i > run) parts.push(s.slice(run, i));
      parts.push(ESC_BY_CODE[c]);
      i++;
      run = i;
      continue;
    }
    i++;
  }
  if (b > run) parts.push(s.slice(run, b));
}

const PARTS = [];

function inlineStr(s, linkFn) {
  PARTS.length = 0;
  renderInline(s, 0, s.length, linkFn, PARTS);
  return PARTS.join('');
}

const OUT = [];

function renderBody(ctx, src, linkFn) {
  const lines = src.split('\n');
  let wordCount = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const ll = line.length;
    let inWord = false;
    for (let i = 0; i < ll; i++) {
      const c = line.charCodeAt(i);
      const sp = c < 128 ? SPACE128[c] : isSpaceCode(c) ? 1 : 0;
      if (sp) inWord = false;
      else if (!inWord) { inWord = true; wordCount++; }
    }
  }
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
        if (fence !== '') out.push(' class="language-', fence, '"');
        out.push('>');
        i++;
        while (i < N && !isFenceClose(lines[i])) {
          out.push(escapeHtml(lines[i]), '\n');
          i++;
        }
        i++;
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(ctx, h.text), ids);
        const html = inlineStr(h.text, linkFn);
        out.push('<h', String(h.depth), ' id="', id, '">', html, '</h', String(h.depth), '>\n');
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
    }
    if (c0 === 62) {
      const parts = [];
      while (i < N && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        const t = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') parts.push(t);
        i++;
      }
      if (parts.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const joined = parts.join('\n');
        out.push('<blockquote>\n<p>');
        renderInline(joined, 0, joined.length, linkFn, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const b = c0 === 45 || c0 === 42 ? bulletOf(line) : null;
    const o = b === null && c0 >= 48 && c0 <= 57 ? orderedOf(line) : null;
    if (b !== null || o !== null) {
      const ordered = o !== null;
      const start = ordered ? o.num : 1;
      out.push(ordered && start !== 1 ? `<ol start="${start}">\n` : ordered ? '<ol>\n' : '<ul>\n');
      let itemParts = [trimLine(ordered ? o.text : b)];
      i++;
      while (i < N) {
        const l = lines[i];
        const m = ordered ? orderedOf(l) : bulletOf(l);
        if (m !== null) {
          const joined = itemParts.join('\n');
          out.push('<li>');
          renderInline(joined, 0, joined.length, linkFn, out);
          out.push('</li>\n');
          itemParts = [trimLine(ordered ? m.text : m)];
          i++;
        } else if (isContinued(l)) {
          itemParts.push(trimLine(l));
          i++;
        } else break;
      }
      {
        const joined = itemParts.join('\n');
        out.push('<li>');
        renderInline(joined, 0, joined.length, linkFn, out);
        out.push('</li>\n');
      }
      out.push(ordered ? '</ol>\n' : '</ul>\n');
      continue;
    }
    const parts = [trimLine(line)];
    i++;
    while (i < N && !endsParagraph(lines[i])) {
      parts.push(trimLine(lines[i]));
      i++;
    }
    const joined = parts.join('\n');
    if (excerpt === null) {
      const html = inlineStr(joined, linkFn);
      excerpt = html;
      out.push('<p>', html, '</p>\n');
    } else {
      out.push('<p>');
      renderInline(joined, 0, joined.length, linkFn, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '', wordCount };
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
    res = escapeHtml(res);
    cache.set(target, res);
    return res;
  };
}

// ---------------------------------------------------------------- build

export function run(input) {
  const ctx = { slugCache: new Map(), dateCache: new Map() };
  const report = [];
  const templateFns = Object.create(null);
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templateFns[name] = compileTemplate(parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }
  const H = {
    f: templateFns,
    g: (v, k) => (v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined),
    t: textOf,
    v: (v) => escapeHtml(textOf(v)),
    y: truthy,
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
    if (templateFns[layout] === undefined) {
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
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.wordCount = md.wordCount;
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
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(ctx, s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(ctx, s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.wordCount / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = templateFns[name];
    if (fn === undefined) return null;
    const R = Object.create(null);
    R.site = site;
    R.tags = allTags;
    R.recent = recent;
    for (const k of Object.keys(vars)) R[k] = vars[k];
    return fn(R, H, 0);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${kept.filter((s) => !s.post).length} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
