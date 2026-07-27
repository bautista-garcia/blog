import { marked } from 'marked';
import katex from 'katex';
import { createClient, textToBase64, base64ToText, fileToBase64 } from './github.js';

/* ------------------------------------------------------------------ *
 * Config + state
 * ------------------------------------------------------------------ */
const root = document.getElementById('editor');
const cfg = root.dataset; // owner, repo, branch, base
const BASE = cfg.base.replace(/\/?$/, '/'); // BASE_URL may lack the trailing slash

const LS_TOKEN = 'blog-editor:token';
const LS_REPO = 'blog-editor:repo';

let client = null;
let posts = []; // { name, path, sha, raw, meta }
let current = null; // { path, sha, filename }
let dirty = false;
let modal = { kind: 'images', file: null };
let pendingAssets = new Map(); // repo path -> File, uploaded on save (Obsidian import)
let newExt = '.mdx'; // extension for the next new post ('.md' for Obsidian imports)

/* ------------------------------------------------------------------ *
 * DOM refs
 * ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const gate = $('gate');
const app = $('app');
const statusEl = $('status');
const listEl = $('post-list');
const titleEl = $('f-title');
const descEl = $('f-desc');
const slugEl = $('f-slug');
const dateEl = $('f-date');
const tagsEl = $('f-tags');
const draftEl = $('f-draft');
const bodyEl = $('body');
const previewEl = $('preview');
const panesEl = $('panes');
const saveBtn = $('btn-save');
const deleteBtn = $('btn-delete');

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */
function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
  if (msg && !isError) setTimeout(() => statusEl.textContent === msg && (statusEl.textContent = ''), 5000);
}

function slugify(s) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function sanitizeFilename(name) {
  return name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/-+/g, '-');
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function markDirty() {
  dirty = true;
}

/* ------------------------------------------------------------------ *
 * Frontmatter: parse + serialize (known keys, rest preserved verbatim)
 * ------------------------------------------------------------------ */
function splitFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { data: {}, extra: '', body: raw };
  const data = {};
  const extra = [];
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let mm;
    if ((mm = line.match(/^title:\s*(.*)$/))) data.title = unquote(mm[1]);
    else if ((mm = line.match(/^description:\s*(.*)$/))) data.description = unquote(mm[1]);
    else if ((mm = line.match(/^date:\s*(.*)$/))) data.date = unquote(mm[1]).slice(0, 10);
    else if ((mm = line.match(/^draft:\s*(.*)$/))) data.draft = mm[1].trim() === 'true';
    else if ((mm = line.match(/^tags:\s*\[(.*)\]\s*$/))) {
      data.tags = mm[1].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (line.match(/^tags:\s*$/) && lines[i + 1]?.match(/^\s+-\s/)) {
      data.tags = [];
      while (lines[i + 1]?.match(/^\s+-\s/)) {
        data.tags.push(lines[++i].replace(/^\s+-\s*/, '').trim());
      }
    } else if ((mm = line.match(/^tags:\s+(.+)$/))) {
      // Obsidian-style: `tags: foo, bar` (no brackets)
      data.tags = mm[1].split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean);
    } else extra.push(line);
  }
  return { data, extra: extra.join('\n').trim(), body: raw.slice(m[0].length) };
}

function unquote(s) {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))
    ? t.slice(1, -1)
    : t;
}

function quoteIfNeeded(s) {
  return /[:#"'\[\]{}&*?]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function buildFile({ title, description, date, tags, draft, extra, body }) {
  const fm = ['---', `title: ${quoteIfNeeded(title)}`];
  if (description) fm.push(`description: ${quoteIfNeeded(description)}`);
  fm.push(`date: ${date}`, `tags: [${tags.join(', ')}]`, `draft: ${draft ? 'true' : 'false'}`);
  if (extra) fm.push(extra);
  fm.push('---', '');
  return fm.join('\n') + body.replace(/^\n+/, '');
}

/* ------------------------------------------------------------------ *
 * Textarea editing helpers
 * ------------------------------------------------------------------ */
function wrapSelection(before, after, placeholder = '') {
  const { selectionStart: s, selectionEnd: e, value } = bodyEl;
  const sel = value.slice(s, e) || placeholder;
  bodyEl.value = value.slice(0, s) + before + sel + after + value.slice(e);
  bodyEl.focus();
  bodyEl.setSelectionRange(s + before.length, s + before.length + sel.length);
  markDirty();
  schedulePreview();
}

function wrapBlock(open, close) {
  const { selectionStart: s, selectionEnd: e, value } = bodyEl;
  const sel = value.slice(s, e);
  const block = `${open}\n${sel}\n${close}`;
  bodyEl.value = value.slice(0, s) + block + value.slice(e);
  bodyEl.focus();
  bodyEl.setSelectionRange(s + open.length + 1, s + open.length + 1 + sel.length);
  markDirty();
  schedulePreview();
}

function insertBlock(text) {
  const { selectionStart: s, value } = bodyEl;
  const before = value.slice(0, s).replace(/\n{0,2}$/, '\n\n');
  const after = value.slice(s).replace(/^\n{0,2}/, '\n\n');
  bodyEl.value = before + text + after;
  bodyEl.focus();
  markDirty();
  schedulePreview();
}

const toolbarActions = {
  bold: () => wrapSelection('**', '**', 'bold'),
  italic: () => wrapSelection('*', '*', 'italic'),
  h2: () => wrapSelection('\n## ', '\n', 'Heading'),
  link: () => wrapSelection('[', '](https://)', 'link text'),
  icode: () => wrapSelection('`', '`', 'code'),
  codeblock: () => wrapBlock('```', '```'),
  math: () => {
    const sel = bodyEl.value.slice(bodyEl.selectionStart, bodyEl.selectionEnd);
    if (sel.includes('\n') || sel.length > 60 || !sel) wrapBlock('$$', '$$');
    else wrapSelection('$', '$');
  },
  sidenote: () => wrapSelection('<Sidenote>', '</Sidenote>', 'note text'),
  image: () => openModal('images'),
  diagram: () => openModal('diagrams'),
};

/* ------------------------------------------------------------------ *
 * Preview (approximation: marked + KaTeX; sidenotes shown inline)
 * ------------------------------------------------------------------ */
let previewTimer = null;
function schedulePreview() {
  if (previewEl.hidden) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 250);
}

function renderPreview() {
  let src = bodyEl.value.replace(/^import .*$/gm, '');
  src = src.replace(/<Sidenote>([\s\S]*?)<\/Sidenote>/g, (_, n) => `<span class="pv-sn">${n}</span>`);

  // Extract math BEFORE marked runs, otherwise Markdown mangles formulas
  // (e.g. underscores in x_tile become <em>). Fenced code blocks are left
  // untouched. Rendered KaTeX is substituted back into the HTML at the end.
  const math = [];
  const stash = (source, displayMode) => {
    math.push(katex.renderToString(source, { displayMode, throwOnError: false }));
    return `XQMATHX${math.length - 1}XQ`;
  };
  const extractMath = (s) =>
    s
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => stash(m, true))
      .replace(/\$([^$\n]+?)\$/g, (_, m) => stash(m, false));

  const processed = src
    .split(/(```[\s\S]*?```)/)
    .map((part, i) => (i % 2 === 1 ? part : extractMath(part)))
    .join('');

  let html = marked.parse(processed);
  html = html.replace(/XQMATHX(\d+)XQ/g, (_, i) => math[Number(i)]);
  previewEl.innerHTML = html;
  hydratePreviewImages();
}

/* ------------------------------------------------------------------ *
 * Preview images: repo files can't be reached from the editor (private
 * repo, or not pulled locally), so fetch them via the API as data URLs.
 * Handles both editor uploads ({base}assets/…) and pipeline images
 * (../../assets/…).
 * ------------------------------------------------------------------ */
const imgCache = new Map(); // repo path -> data URL
const MIME = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

async function hydratePreviewImages() {
  for (const img of previewEl.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    let path = null;
    if (src.startsWith(`${BASE}assets/`)) path = `public/${src.slice(BASE.length)}`;
    else if (src.startsWith('../../assets/')) path = `src/${src.slice('../../'.length)}`;
    if (!path) continue;
    // Imported but not yet saved: the file only exists in browser memory.
    const pending = pendingAssets.get(path);
    if (pending) {
      if (!imgCache.has(path)) imgCache.set(path, URL.createObjectURL(pending));
      img.src = imgCache.get(path);
      continue;
    }
    const cached = imgCache.get(path);
    if (cached) {
      img.src = cached;
      continue;
    }
    try {
      const file = await client.getFile(path);
      const mime = MIME[path.split('.').pop().toLowerCase()] || 'application/octet-stream';
      const url = `data:${mime};base64,${file.content.replace(/\n/g, '')}`;
      imgCache.set(path, url);
      img.src = url;
    } catch {
      /* not in the repo — leave the src as-is */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Post list
 * ------------------------------------------------------------------ */
async function refreshList() {
  listEl.innerHTML = '<li class="muted">Loading…</li>';
  try {
    const items = await client.listPosts();
    const files = items.filter((i) => i.type === 'file' && /\.(md|mdx)$/.test(i.name));
    posts = await Promise.all(
      files.map(async (f) => {
        const file = await client.getFile(f.path);
        const raw = base64ToText(file.content);
        return { name: f.name, path: f.path, sha: file.sha, raw, meta: splitFrontmatter(raw).data };
      }),
    );
    posts.sort((a, b) => (b.meta.date || '').localeCompare(a.meta.date || ''));
    listEl.innerHTML = '';
    for (const p of posts) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'post-item' + (current?.path === p.path ? ' active' : '');
      btn.innerHTML = `<span class="t"></span><span class="f"></span>`;
      btn.querySelector('.t').textContent = p.meta.title || p.name;
      btn.querySelector('.f').textContent = p.name + (p.meta.draft ? ' · draft' : '');
      btn.onclick = () => openPost(p);
      li.appendChild(btn);
      listEl.appendChild(li);
    }
    if (!posts.length) listEl.innerHTML = '<li class="muted">No posts yet</li>';
  } catch (e) {
    if (e.status === 401) {
      localStorage.removeItem(LS_TOKEN); // token revoked/expired — back to the gate
      location.reload();
      return;
    }
    listEl.innerHTML = '<li class="muted">Failed to load</li>';
    setStatus(e.message, true);
  }
}

function openPost(p) {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  pendingAssets = new Map(); // abandon any import uploads not yet saved
  const { data, extra, body } = splitFrontmatter(p.raw);
  current = { path: p.path, sha: p.sha, filename: p.name, extra };
  titleEl.value = data.title || '';
  descEl.value = data.description || '';
  slugEl.value = p.name.replace(/\.(md|mdx)$/, '');
  dateEl.value = data.date || today();
  tagsEl.value = (data.tags || []).join(', ');
  draftEl.checked = !!data.draft;
  bodyEl.value = body.replace(/^\n+/, '');
  deleteBtn.hidden = false;
  dirty = false;
  setStatus(`Opened ${p.name}`);
  schedulePreview();
  bodyEl.focus();
}

function newPost() {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  pendingAssets = new Map();
  newExt = '.mdx';
  current = null;
  titleEl.value = '';
  descEl.value = '';
  slugEl.value = '';
  slugEl.disabled = false;
  dateEl.value = today();
  tagsEl.value = '';
  draftEl.checked = true;
  bodyEl.value = '';
  deleteBtn.hidden = true;
  dirty = false;
  listEl.querySelectorAll('.post-item.active').forEach((b) => b.classList.remove('active'));
  titleEl.focus();
}

/* ------------------------------------------------------------------ *
 * Save / delete
 * ------------------------------------------------------------------ */
async function save() {
  const title = titleEl.value.trim();
  const date = dateEl.value;
  if (!title) return setStatus('Title is required', true);
  if (!date) return setStatus('Date is required', true);

  const slug = slugify(slugEl.value || title);
  if (!slug) return setStatus('Slug is required', true);
  // Editing keeps the post's extension; changing the slug renames the file.
  const ext = current?.filename.match(/\.(md|mdx)$/)?.[0] || newExt;
  const filename = `${slug}${ext}`;
  const path = `src/content/posts/${filename}`;
  const renamed = current && filename !== current.filename;

  let body = bodyEl.value;
  // MDX rejects inline JSX that isn't closed on the same line — catch the
  // two mistakes we've seen break the build, before committing.
  if (body.split('\n').some((l) => l.includes('<Sidenote') && !l.includes('</Sidenote>'))) {
    return setStatus('A <Sidenote> is not closed on the same line — MDX needs each sidenote on one line.', true);
  }
  if (body.split('\n').some((l) => l.includes('<img') && !l.includes('/>'))) {
    return setStatus('An <img> tag is missing its self-closing "/>" — MDX requires it.', true);
  }
  if (body.includes('<Sidenote') && !body.includes('import Sidenote')) {
    body = `import Sidenote from '../../components/Sidenote.astro';\n\n` + body;
  }
  const tags = tagsEl.value.split(',').map((t) => t.trim()).filter(Boolean);
  const content = buildFile({
    title,
    description: descEl.value.trim(),
    date,
    tags,
    draft: draftEl.checked,
    extra: current?.extra || '',
    body,
  });

  saveBtn.disabled = true;
  setStatus('Saving…');
  try {
    if (pendingAssets.size) {
      // Imported images: upload each before the post that references them.
      setStatus(`Uploading ${pendingAssets.size} image(s)…`);
      for (const [assetPath, file] of pendingAssets) {
        const b64 = await fileToBase64(file);
        let assetSha;
        try {
          assetSha = (await client.getFile(assetPath)).sha; // overwrite if it exists
        } catch {}
        await client.putFile(assetPath, b64, `Add image: ${assetPath.split('/').pop()}`, assetSha);
        pendingAssets.delete(assetPath);
      }
      setStatus('Saving…');
    }
    if (renamed) {
      // Don't clobber a different post that already has the target slug.
      try {
        await client.getFile(path);
        return setStatus(`A post named ${filename} already exists.`, true);
      } catch {
        /* 404 — name is free */
      }
    }
    const message = renamed
      ? `Rename post: ${current.filename} → ${filename}`
      : current
        ? `Edit post: ${title}`
        : `New post: ${title}`;
    let res;
    try {
      // A rename creates a new file — the old sha must not be sent.
      res = await client.putFile(path, textToBase64(content), message, renamed ? undefined : current?.sha);
    } catch (e) {
      if (e.status !== 409) throw e;
      const fresh = await client.getFile(path); // sha went stale — retry once
      res = await client.putFile(path, textToBase64(content), message, fresh.sha);
    }
    if (renamed) {
      await client.deleteFile(current.path, `Remove old name: ${current.filename}`, current.sha);
    }
    current = { path, sha: res.content.sha, filename, extra: current?.extra || '' };
    slugEl.value = filename.replace(/\.(md|mdx)$/, '');
    deleteBtn.hidden = false;
    dirty = false;
    setStatus(renamed ? `Renamed to ${filename} ✓` : 'Saved — committed to the repo ✓');
    refreshList();
    schedulePreview(); // newly uploaded images can now hydrate
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    saveBtn.disabled = false;
  }
}

async function deletePost() {
  if (!current) return;
  if (!confirm(`Delete ${current.filename}? This commits a deletion to the repo.`)) return;
  try {
    await client.deleteFile(current.path, `Delete post: ${titleEl.value.trim() || current.filename}`, current.sha);
    setStatus('Deleted ✓');
    newPost();
    dirty = false;
    refreshList();
  } catch (e) {
    setStatus(e.message, true);
  }
}

/* ------------------------------------------------------------------ *
 * Upload modal (images + diagrams, with optional width)
 * ------------------------------------------------------------------ */
const modalEl = $('modal');
const mFile = $('m-file');
const mName = $('m-name');
const mAlt = $('m-alt');
const mCaption = $('m-caption');
const mWidth = $('m-width');
const mInsert = $('m-insert');
const mError = $('m-error');
const mPreview = $('m-preview');

function openModal(kind, file = null) {
  modal = { kind, file: null };
  $('modal-title').textContent = kind === 'diagrams' ? 'Insert diagram' : 'Insert image';
  $('modal-hint').textContent =
    kind === 'diagrams'
      ? 'Draw at excalidraw.com, export as SVG (tick “Embed scene”), then drop the file below.'
      : 'PNG, JPG, GIF, WebP or SVG.';
  $('modal-excalidraw').hidden = kind !== 'diagrams';
  mFile.value = '';
  mName.value = '';
  mAlt.value = '';
  mCaption.value = '';
  mWidth.value = '';
  mError.textContent = '';
  mPreview.innerHTML = '';
  mInsert.disabled = true;
  modalEl.hidden = false;
  if (file) setModalFile(file);
}

function closeModal() {
  modalEl.hidden = true;
  modal.file = null;
}

function setModalFile(file) {
  const isImage = file.type.startsWith('image/');
  const isSvg = /\.svg$/i.test(file.name) || file.type === 'image/svg+xml';
  if (!isImage && !isSvg) {
    mError.textContent = 'Only image or SVG files.';
    return;
  }
  modal.file = file;
  mInsert.disabled = false;
  mError.textContent = '';
  mName.value = sanitizeFilename(file.name);
  if (!mAlt.value) mAlt.value = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
  mPreview.innerHTML = '';
  const img = document.createElement('img');
  img.src = URL.createObjectURL(file);
  mPreview.appendChild(img);
}

async function doInsert() {
  if (!modal.file) return;
  mInsert.disabled = true;
  mError.textContent = 'Uploading…';
  try {
    let name = sanitizeFilename(mName.value.trim() || modal.file.name);
    if (!/\.[a-z0-9]+$/i.test(name)) {
      const ext =
        modal.file.name.match(/\.[a-z0-9]+$/i)?.[0] ||
        (modal.file.type === 'image/svg+xml' ? '.svg' : '.png');
      name += ext;
    }
    const path = `public/assets/${modal.kind}/${name}`;
    const b64 = await fileToBase64(modal.file);
    let sha;
    try {
      sha = (await client.getFile(path)).sha; // overwrite if it already exists
    } catch {}
    await client.putFile(path, b64, `Add ${modal.kind.slice(0, -1)}: ${name}`, sha);
    const width = mWidth.value ? ` width="${Number(mWidth.value)}"` : '';
    const alt = mAlt.value.trim().replace(/"/g, '&quot;');
    const caption = mCaption.value
      .trim()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const imgTag = `<img src="${BASE}assets/${modal.kind}/${name}" alt="${alt}"${width} />`;
    insertBlock(caption ? `<figure>\n${imgTag}\n<figcaption>${caption}</figcaption>\n</figure>` : imgTag);
    setStatus('Uploaded ✓');
    closeModal();
  } catch (e) {
    mError.textContent = e.message;
    mInsert.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * Obsidian import: drop a .md file (+ its images) and get a ready post.
 * Image references are autodetected from the markdown; dropped image
 * files are matched by file name. Unmatched references still convert to
 * their final <img> paths and are listed as missing.
 * ------------------------------------------------------------------ */
const importModalEl = $('import-modal');
const importFilesEl = $('import-files');
const importStatusEl = $('import-status');
const importMissingEl = $('import-missing');
const importGoBtn = $('import-go');
const importErrorEl = $('import-error');

let importData = null; // { title, slug, date, tags, body, assets: Map }
let importFiles = new Map(); // name -> File, accumulates across drops

function openImport() {
  importData = null;
  importFiles = new Map();
  importFilesEl.value = '';
  importStatusEl.textContent = '';
  importMissingEl.innerHTML = '';
  importErrorEl.textContent = '';
  importGoBtn.textContent = 'Import';
  importGoBtn.disabled = true;
  importModalEl.hidden = false;
}

function closeImport() {
  importModalEl.hidden = true;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Match a referenced image to a dropped file by file name
// (exact, %20-decoded, then case-insensitive).
function findImageFile(ref, files) {
  const base = ref.split('/').pop();
  const decoded = safeDecode(base);
  return (
    files.find((f) => f.name === base) ||
    files.find((f) => f.name === decoded) ||
    files.find((f) => f.name.toLowerCase() === decoded.toLowerCase())
  );
}

function escapeAttr(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function analyzeImport(fileList) {
  // Files accumulate: drop the .md first, then the images — the dialog
  // stays open and the analysis updates with every drop.
  for (const f of fileList) importFiles.set(f.name, f);
  importErrorEl.textContent = '';
  importMissingEl.innerHTML = '';
  importGoBtn.disabled = true;
  importData = null;

  const files = [...importFiles.values()];
  const mds = files.filter((f) => /\.(md|markdown)$/i.test(f.name));
  if (mds.length === 0) {
    importStatusEl.textContent = `${files.length} file(s) loaded — now drop the .md file.`;
    return;
  }
  if (mds.length > 1) {
    importStatusEl.textContent = '';
    importErrorEl.textContent = `You dropped ${mds.length} .md files — import one at a time (Cancel to start over).`;
    return;
  }
  importStatusEl.textContent = '';
  const md = mds[0];
  const images = files.filter((f) => f !== md);
  const text = await md.text();
  const { data, body: rawBody } = splitFrontmatter(text);

  const assets = new Map(); // repo path -> File
  const missing = [];
  let body = rawBody;

  // Obsidian embeds: ![[image.png]], ![[image.png|300]], ![[image.png|caption]]
  body = body.replace(/!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (match, ref, alias) => {
    ref = ref.trim();
    const file = findImageFile(ref, images);
    const name = sanitizeFilename(safeDecode(ref.split('/').pop()));
    const a = (alias || '').trim();
    const width = /^\d+$/.test(a) ? ` width="${a}"` : '';
    const alt = escapeAttr(a && !/^\d+$/.test(a) ? a : name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '));
    if (file) assets.set(`public/assets/images/${name}`, file);
    else missing.push(ref);
    return `<img src="${BASE}assets/images/${name}" alt="${alt}"${width} />`;
  });

  // Standard markdown images with relative paths (external URLs untouched)
  body = body.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g, (match, alt, url) => {
    if (/^https?:\/\//i.test(url)) return match;
    const file = findImageFile(url.trim(), images);
    const name = sanitizeFilename(safeDecode(url.trim().split('/').pop()));
    if (file) assets.set(`public/assets/images/${name}`, file);
    else missing.push(url.trim());
    return `<img src="${BASE}assets/images/${name}" alt="${escapeAttr(alt)}" />`;
  });

  // Wikilinks -> plain text (their target notes don't exist on the blog)
  body = body.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  body = body.replace(/\[\[([^\]]+)\]\]/g, '$1');

  const base = md.name.replace(/\.(md|markdown)$/i, '');
  importData = {
    title: data.title || base.replace(/[-_]+/g, ' '),
    description: data.description || '',
    slug: slugify(base),
    date: data.date || today(),
    tags: data.tags || [],
    body,
    assets,
  };

  const total = assets.size + missing.length;
  importStatusEl.textContent = `${md.name}: ${
    total === 0 ? 'no image references found' : `${assets.size} of ${total} referenced image(s) matched`
  }.`;
  for (const m of missing) {
    const li = document.createElement('li');
    li.textContent = m;
    importMissingEl.appendChild(li);
  }
  importGoBtn.textContent = missing.length ? 'Import anyway' : 'Import';
  importGoBtn.disabled = false;
}

function doImport() {
  if (!importData) return;
  newPost(); // resets pendingAssets + newExt; also guards unsaved changes
  titleEl.value = importData.title;
  descEl.value = importData.description;
  slugEl.value = importData.slug;
  slugEl.dataset.touched = '1';
  dateEl.value = importData.date;
  tagsEl.value = importData.tags.join(', ');
  draftEl.checked = true;
  bodyEl.value = importData.body.replace(/^\n+/, '');
  pendingAssets = importData.assets;
  newExt = '.md'; // plain Markdown — arbitrary Obsidian content can't hit MDX parse errors
  dirty = true;
  schedulePreview();
  setStatus(
    importData.assets.size
      ? `Imported — review, then Save. ${importData.assets.size} image(s) upload on save.`
      : 'Imported — review, then Save.',
  );
  closeImport();
  bodyEl.focus();
}

$('btn-import').onclick = openImport;
$('import-cancel').onclick = closeImport;
importGoBtn.onclick = doImport;
importFilesEl.onchange = () => importFilesEl.files.length && analyzeImport(importFilesEl.files);
importModalEl.addEventListener('click', (e) => e.target === importModalEl && closeImport());
const importDrop = $('import-drop');
importDrop.addEventListener('dragover', (e) => e.preventDefault());
importDrop.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length) analyzeImport(e.dataTransfer.files);
});

/* ------------------------------------------------------------------ *
 * Auth gate
 * ------------------------------------------------------------------ */
function enter() {
  gate.hidden = true;
  app.hidden = false;
  newPost();
  refreshList();
}

async function connect() {
  const owner = $('gate-owner').value.trim();
  const repo = $('gate-repo').value.trim();
  const token = $('gate-token').value.trim();
  if (!owner || !repo || !token) {
    $('gate-error').textContent = 'All three fields are required.';
    return;
  }
  client = createClient({ token, owner, repo, branch: cfg.branch });
  $('gate-error').textContent = 'Connecting…';
  try {
    await client.test();
    localStorage.setItem(LS_TOKEN, token);
    localStorage.setItem(LS_REPO, JSON.stringify({ owner, repo }));
    enter();
  } catch (e) {
    $('gate-error').textContent = `${e.message} — check the token and repo names.`;
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */
$('gate-save').onclick = connect;
$('btn-new').onclick = newPost;
$('btn-refresh').onclick = refreshList;
saveBtn.onclick = save;
deleteBtn.onclick = deletePost;
$('btn-forget').onclick = () => {
  localStorage.removeItem(LS_TOKEN);
  location.reload();
};
$('btn-preview').onclick = () => {
  previewEl.hidden = !previewEl.hidden;
  panesEl.classList.toggle('split', !previewEl.hidden);
  $('btn-preview').classList.toggle('primary', !previewEl.hidden);
  if (!previewEl.hidden) renderPreview();
};

document.querySelectorAll('[data-tb]').forEach((btn) => {
  btn.onclick = () => toolbarActions[btn.dataset.tb]?.();
});

[titleEl, descEl, slugEl, dateEl, tagsEl, draftEl].forEach((el) => el.addEventListener('input', markDirty));
titleEl.addEventListener('input', () => {
  if (!current && !slugEl.dataset.touched) slugEl.value = slugify(titleEl.value);
});
slugEl.addEventListener('input', () => (slugEl.dataset.touched = '1'));
bodyEl.addEventListener('input', () => {
  markDirty();
  schedulePreview();
});

// Modal events
$('m-cancel').onclick = closeModal;
mInsert.onclick = doInsert;
mFile.onchange = () => mFile.files[0] && setModalFile(mFile.files[0]);
modalEl.addEventListener('click', (e) => e.target === modalEl && closeModal());

const drop = $('drop');
drop.addEventListener('dragover', (e) => e.preventDefault());
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) setModalFile(f);
});

// Paste / drop files straight into the textarea.
bodyEl.addEventListener('paste', (e) => {
  const f = [...(e.clipboardData?.files || [])].find(
    (f) => f.type.startsWith('image/') || /\.svg$/i.test(f.name),
  );
  if (f) {
    e.preventDefault();
    openModal(/\.svg$/i.test(f.name) ? 'diagrams' : 'images', f);
    return;
  }
  // Excalidraw's "copy SVG to clipboard" puts SVG markup on the clipboard as text.
  const text = e.clipboardData?.getData('text/plain') || '';
  if (/^\s*<svg[\s>]/i.test(text) && text.includes('</svg>')) {
    e.preventDefault();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const file = new File([text], `diagram-${stamp}.svg`, { type: 'image/svg+xml' });
    openModal('diagrams', file);
  }
});
bodyEl.addEventListener('dragover', (e) => e.preventDefault());
bodyEl.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f && (f.type.startsWith('image/') || /\.svg$/i.test(f.name))) {
    e.preventDefault();
    openModal(/\.svg$/i.test(f.name) ? 'diagrams' : 'images', f);
  }
});

// Tab / Shift+Tab: indent or unindent. With a selection, every line it
// touches is shifted; with just a cursor, Tab inserts two spaces and
// Shift+Tab removes up to two from the start of the current line.
const INDENT = '  ';

bodyEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const { selectionStart: s, selectionEnd: end, value } = bodyEl;
  const lineStart = value.lastIndexOf('\n', s - 1) + 1;
  const block = value.slice(lineStart, end);

  if (e.shiftKey) {
    const unindented = block.replace(/^ {1,2}/gm, '');
    bodyEl.value = value.slice(0, lineStart) + unindented + value.slice(end);
    if (s === end) {
      const removed = block.length - unindented.length;
      const pos = Math.max(lineStart, s - removed);
      bodyEl.setSelectionRange(pos, pos);
    } else {
      bodyEl.setSelectionRange(lineStart, lineStart + unindented.length);
    }
  } else if (s === end) {
    bodyEl.value = value.slice(0, s) + INDENT + value.slice(end);
    bodyEl.setSelectionRange(s + INDENT.length, s + INDENT.length);
  } else {
    const indented = block.replace(/^/gm, INDENT);
    bodyEl.value = value.slice(0, lineStart) + indented + value.slice(end);
    bodyEl.setSelectionRange(lineStart, lineStart + indented.length);
  }
  markDirty();
  schedulePreview();
});

// Keyboard: Cmd/Ctrl+S saves; Cmd/Ctrl+B / Cmd/Ctrl+I format in the textarea.
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || app.hidden) return;
  if (e.key === 's') {
    e.preventDefault();
    save();
  } else if (e.target === bodyEl && e.key === 'b') {
    e.preventDefault();
    toolbarActions.bold();
  } else if (e.target === bodyEl && e.key === 'i') {
    e.preventDefault();
    toolbarActions.italic();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault();
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
const savedRepo = JSON.parse(localStorage.getItem(LS_REPO) || 'null');
$('gate-owner').value = savedRepo?.owner || cfg.owner;
$('gate-repo').value = savedRepo?.repo || cfg.repo;

const savedToken = localStorage.getItem(LS_TOKEN);
if (savedToken) {
  client = createClient({
    token: savedToken,
    owner: $('gate-owner').value,
    repo: $('gate-repo').value,
    branch: cfg.branch,
  });
  enter();
} else {
  gate.hidden = false; // no stored token — show the sign-in gate
}
