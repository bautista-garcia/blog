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

/* ------------------------------------------------------------------ *
 * DOM refs
 * ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const gate = $('gate');
const app = $('app');
const statusEl = $('status');
const listEl = $('post-list');
const titleEl = $('f-title');
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
    else if ((mm = line.match(/^date:\s*(.*)$/))) data.date = mm[1].trim().slice(0, 10);
    else if ((mm = line.match(/^draft:\s*(.*)$/))) data.draft = mm[1].trim() === 'true';
    else if ((mm = line.match(/^tags:\s*\[(.*)\]\s*$/))) {
      data.tags = mm[1].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (line.match(/^tags:\s*$/) && lines[i + 1]?.match(/^\s+-\s/)) {
      data.tags = [];
      while (lines[i + 1]?.match(/^\s+-\s/)) {
        data.tags.push(lines[++i].replace(/^\s+-\s*/, '').trim());
      }
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

function buildFile({ title, date, tags, draft, extra, body }) {
  const fm = [
    '---',
    `title: ${quoteIfNeeded(title)}`,
    `date: ${date}`,
    `tags: [${tags.join(', ')}]`,
    `draft: ${draft ? 'true' : 'false'}`,
  ];
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
  const { data, extra, body } = splitFrontmatter(p.raw);
  current = { path: p.path, sha: p.sha, filename: p.name, extra };
  titleEl.value = data.title || '';
  slugEl.value = p.name.replace(/\.(md|mdx)$/, '');
  slugEl.disabled = true;
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
  current = null;
  titleEl.value = '';
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

  const filename = current ? current.filename : `${slugify(slugEl.value || title)}.mdx`;
  if (!slugify(slugEl.value || title)) return setStatus('Slug is required', true);
  const path = `src/content/posts/${filename}`;

  let body = bodyEl.value;
  if (body.includes('<Sidenote') && !body.includes('import Sidenote')) {
    body = `import Sidenote from '../../components/Sidenote.astro';\n\n` + body;
  }
  const tags = tagsEl.value.split(',').map((t) => t.trim()).filter(Boolean);
  const content = buildFile({
    title,
    date,
    tags,
    draft: draftEl.checked,
    extra: current?.extra || '',
    body,
  });

  saveBtn.disabled = true;
  setStatus('Saving…');
  try {
    const message = current ? `Edit post: ${title}` : `New post: ${title}`;
    let res;
    try {
      res = await client.putFile(path, textToBase64(content), message, current?.sha);
    } catch (e) {
      if (e.status !== 409) throw e;
      const fresh = await client.getFile(path); // sha went stale — retry once
      res = await client.putFile(path, textToBase64(content), message, fresh.sha);
    }
    current = { path, sha: res.content.sha, filename, extra: current?.extra || '' };
    slugEl.value = filename.replace(/\.(md|mdx)$/, '');
    slugEl.disabled = true;
    deleteBtn.hidden = false;
    dirty = false;
    setStatus('Saved — committed to the repo ✓');
    refreshList();
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
    insertBlock(`<img src="${BASE}assets/${modal.kind}/${name}" alt="${alt}"${width} />`);
    setStatus('Uploaded ✓');
    closeModal();
  } catch (e) {
    mError.textContent = e.message;
    mInsert.disabled = false;
  }
}

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

[titleEl, slugEl, dateEl, tagsEl, draftEl].forEach((el) => el.addEventListener('input', markDirty));
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
