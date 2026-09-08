import { base64ToText, createClient, fileToBase64, textToBase64 } from './github.js';
import { createCommandPalette } from './command-palette.js';
import {
  clearRecovery,
  getPreference,
  loadRecovery,
  saveRecovery,
  setPreference,
} from './storage.js';

let createMarkdownEditor;
let buildFile;
let escapeAttribute;
let getOutline;
let getWritingStats;
let renderMarkdown;
let sanitizeFilename;
let slugify;
let splitFrontmatter;
let today;
let validateMdxBody;
let prepareObsidianImport;

async function loadEditorModules() {
  if (createMarkdownEditor) return;
  const [editorModule, markdownModule, obsidianModule] = await Promise.all([
    import('./codemirror.js'),
    import('./markdown.js'),
    import('./obsidian.js'),
  ]);
  createMarkdownEditor = editorModule.createMarkdownEditor;
  prepareObsidianImport = obsidianModule.prepareObsidianImport;
  ({
    buildFile,
    escapeAttribute,
    getOutline,
    getWritingStats,
    renderMarkdown,
    sanitizeFilename,
    slugify,
    splitFrontmatter,
    today,
    validateMdxBody,
  } = markdownModule);
}

const $ = (id) => document.getElementById(id);
const root = $('editor');
const cfg = root.dataset;
const BASE = cfg.base.replace(/\/?$/, '/');
const LS_TOKEN = 'blog-editor:token';
const LS_REPO = 'blog-editor:repo';

const elements = {
  gate: $('gate'),
  gateForm: $('gate-form'),
  gateOwner: $('gate-owner'),
  gateRepo: $('gate-repo'),
  gateToken: $('gate-token'),
  gateError: $('gate-error'),
  app: $('app'),
  status: $('status'),
  currentLabel: $('current-label'),
  repoLabel: $('repo-label'),
  postCount: $('post-count'),
  list: $('post-list'),
  search: $('post-search'),
  title: $('f-title'),
  description: $('f-desc'),
  slug: $('f-slug'),
  date: $('f-date'),
  tags: $('f-tags'),
  draft: $('f-draft'),
  extra: $('f-extra'),
  save: $('btn-save'),
  delete: $('btn-delete'),
  panes: $('panes'),
  sourcePane: $('source-pane'),
  previewPane: $('preview-pane'),
  preview: $('preview'),
  outline: $('outline'),
  outlineCount: $('outline-count'),
  saveState: $('save-state'),
  localState: $('local-state'),
  wordCount: $('word-count'),
  characterCount: $('character-count'),
  readTime: $('read-time'),
  selectionCount: $('selection-count'),
};

let client = null;
let connectedRepo = `${cfg.owner}/${cfg.repo}`;
let posts = [];
let current = null;
let dirty = false;
let loadingDocument = false;
let newExtension = '.mdx';
let markdownEditor = null;
let listFilter = 'all';
let previewTimer = null;
let recoveryTimer = null;
let statusTimer = null;
let pendingAssets = new Map();
let assetState = { kind: 'images', file: null, source: 'upload' };
let importData = null;
let importFiles = new Map();
let syncingScroll = false;

function flashStatus(message, type = '', timeout = 4500) {
  clearTimeout(statusTimer);
  elements.status.textContent = message;
  elements.status.className = `status-message ${type}`.trim();
  if (message && timeout) {
    statusTimer = window.setTimeout(() => {
      if (elements.status.textContent === message) elements.status.textContent = '';
    }, timeout);
  }
}

function setSyncState(state, label) {
  elements.saveState.dataset.state = state;
  elements.saveState.lastChild.textContent = ` ${label}`;
}

function recoveryKey() {
  return current?.path || '__new__';
}

function snapshot() {
  return {
    title: elements.title.value,
    description: elements.description.value,
    slug: elements.slug.value,
    date: elements.date.value,
    tags: elements.tags.value,
    draft: elements.draft.checked,
    extra: elements.extra.value,
    body: markdownEditor?.getValue() || '',
    baseSha: current?.sha || null,
    extension: current?.filename.match(/\.(md|mdx)$/)?.[0] || newExtension,
  };
}

function persistRecovery() {
  clearTimeout(recoveryTimer);
  recoveryTimer = window.setTimeout(() => {
    if (!dirty) return;
    saveRecovery(connectedRepo, recoveryKey(), snapshot());
    elements.localState.textContent = `Local recovery · ${new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  }, 700);
}

function markDirty() {
  if (loadingDocument) return;
  dirty = true;
  setSyncState('dirty', 'Unpublished changes');
  persistRecovery();
}

function canLeaveDocument() {
  if (!dirty) return true;
  const confirmed = window.confirm('Leave this post? Your unpublished changes are saved locally.');
  if (confirmed) saveRecovery(connectedRepo, recoveryKey(), snapshot());
  return confirmed;
}

function updateStats(source, selection = '') {
  const stats = getWritingStats(source);
  elements.wordCount.textContent = `${stats.words} ${stats.words === 1 ? 'word' : 'words'}`;
  elements.characterCount.textContent = `${stats.characters.toLocaleString()} characters`;
  elements.readTime.textContent = `${stats.minutes} min read`;
  const selectionWords = getWritingStats(selection).words;
  elements.selectionCount.hidden = selectionWords === 0;
  elements.selectionCount.textContent = `${selectionWords} selected`;
}

function initMarkdownEditor() {
  if (markdownEditor) return;
  markdownEditor = createMarkdownEditor($('editor-host'), {
    onSave: savePost,
    onChange(source) {
      if (!loadingDocument) markDirty();
      updateStats(source);
      schedulePreview();
    },
    onSelectionChange(selection) {
      updateStats(markdownEditor.getValue(), selection);
    },
    onFiles(files, source) {
      const file = files.find((candidate) =>
        candidate.type.startsWith('image/') || /\.svg$/i.test(candidate.name),
      );
      if (!file) return false;
      openAssetDialog(/\.svg$/i.test(file.name) ? 'diagrams' : 'images', file, source);
      return true;
    },
    onSvgPaste(svg) {
      const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 17);
      openAssetDialog(
        'diagrams',
        new File([svg], `diagram-${stamp}.svg`, { type: 'image/svg+xml' }),
        'paste',
      );
    },
    onSlashCommand: openCommandDialog,
  });

  markdownEditor.view.scrollDOM.addEventListener('scroll', () => {
    if (elements.panes.dataset.mode !== 'split' || syncingScroll) return;
    syncingScroll = true;
    const source = markdownEditor.view.scrollDOM;
    const sourceRange = source.scrollHeight - source.clientHeight;
    const previewRange = elements.previewPane.scrollHeight - elements.previewPane.clientHeight;
    if (sourceRange > 0) elements.previewPane.scrollTop = (source.scrollTop / sourceRange) * previewRange;
    requestAnimationFrame(() => (syncingScroll = false));
  });

  elements.previewPane.addEventListener('scroll', () => {
    if (elements.panes.dataset.mode !== 'split' || syncingScroll) return;
    syncingScroll = true;
    const source = markdownEditor.view.scrollDOM;
    const sourceRange = source.scrollHeight - source.clientHeight;
    const previewRange = elements.previewPane.scrollHeight - elements.previewPane.clientHeight;
    if (previewRange > 0) source.scrollTop = (elements.previewPane.scrollTop / previewRange) * sourceRange;
    requestAnimationFrame(() => (syncingScroll = false));
  });
}

function setDocument(values, body, options = {}) {
  clearImageCache();
  loadingDocument = true;
  elements.title.value = values.title || '';
  elements.description.value = values.description || '';
  elements.slug.value = values.slug || '';
  elements.date.value = values.date || today();
  elements.tags.value = Array.isArray(values.tags) ? values.tags.join(', ') : values.tags || '';
  elements.draft.checked = values.draft ?? true;
  elements.extra.value = values.extra || '';
  markdownEditor.setValue((body || '').replace(/^\n+/, ''));
  loadingDocument = false;

  elements.slug.dataset.touched = values.slug ? '1' : '';
  elements.currentLabel.textContent = values.title || 'Untitled';
  dirty = !!options.dirty;
  setSyncState(dirty ? 'dirty' : 'saved', dirty ? 'Recovered local changes' : 'Synced with GitHub');
  elements.localState.textContent = options.recovered ? 'Recovered from this browser' : '';
  updateStats(markdownEditor.getValue());
  renderPreview();
}

function recoveryDifferences(recovery, remote, body) {
  const normalize = (value) => String(value ?? '').trim();
  const differences = [];
  if (normalize(recovery.title) !== normalize(remote.title)) differences.push('title');
  if (normalize(recovery.description) !== normalize(remote.description)) differences.push('description');
  if (normalize(recovery.slug) !== normalize(remote.slug)) differences.push('slug');
  if (normalize(recovery.date) !== normalize(remote.date || today())) differences.push('date');
  if (normalize(recovery.tags) !== normalize((remote.tags || []).join(', '))) differences.push('tags');
  if (Boolean(recovery.draft) !== Boolean(remote.draft)) differences.push('draft');
  if (normalize(recovery.extra) !== normalize(remote.extra)) differences.push('extra');
  if (normalize(recovery.body) !== normalize(body)) differences.push('body');
  return differences;
}

function renderPostList() {
  const query = elements.search.value.trim().toLowerCase();
  const visible = posts.filter((post) => {
    if (listFilter === 'draft' && !post.meta.draft) return false;
    if (listFilter === 'published' && post.meta.draft) return false;
    if (!query) return true;
    return [post.meta.title, post.meta.description, post.name, ...(post.meta.tags || [])]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });

  elements.postCount.textContent = posts.length;
  elements.list.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('li');
    empty.className = 'empty-library';
    empty.textContent = posts.length ? 'No posts match this view.' : 'Your first post starts here.';
    elements.list.append(empty);
    return;
  }

  for (const post of visible) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `library-item${post.meta.draft ? ' draft' : ''}${
      current?.path === post.path ? ' active' : ''
    }`;
    button.setAttribute('aria-current', current?.path === post.path ? 'page' : 'false');

    const state = document.createElement('span');
    state.className = 'post-state';
    state.title = post.meta.draft ? 'Draft' : 'Published';
    const info = document.createElement('span');
    info.className = 'post-info';
    const title = document.createElement('span');
    title.className = 'post-title';
    title.textContent = post.meta.title || post.name;
    const meta = document.createElement('span');
    meta.className = 'post-meta';
    const date = post.meta.date
      ? new Date(`${post.meta.date}T12:00:00`).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : 'No date';
    meta.textContent = `${date}${post.meta.tags?.length ? ` · ${post.meta.tags.slice(0, 2).join(', ')}` : ''}`;
    info.append(title, meta);
    button.append(state, info);
    button.addEventListener('click', () => openPost(post));
    item.append(button);
    elements.list.append(item);
  }
}

async function refreshPosts({ selectInitial = false } = {}) {
  elements.list.innerHTML = '<li class="empty-library">Loading your library…</li>';
  try {
    const items = await client.listPosts();
    const files = items.filter((item) => item.type === 'file' && /\.(md|mdx)$/.test(item.name));
    posts = await Promise.all(
      files.map(async (item) => {
        const file = await client.getFile(item.path);
        const raw = base64ToText(file.content);
        return { name: item.name, path: item.path, sha: file.sha, raw, meta: splitFrontmatter(raw).data };
      }),
    );
    posts.sort((left, right) => (right.meta.date || '').localeCompare(left.meta.date || ''));
    renderPostList();
    if (selectInitial) {
      const recoveredNewPost = loadRecovery(connectedRepo, '__new__');
      if (recoveredNewPost) newPost({ force: true, recovery: recoveredNewPost });
      else if (posts[0]) openPost(posts[0], { force: true });
      else newPost({ force: true });
    }
  } catch (error) {
    if (error.status === 401) {
      localStorage.removeItem(LS_TOKEN);
      location.reload();
      return;
    }
    elements.list.innerHTML = '<li class="empty-library">The library could not be loaded.</li>';
    flashStatus(error.message, 'error', 0);
  }
}

function openPost(post, { force = false } = {}) {
  if (!force && !canLeaveDocument()) return;
  clearTimeout(recoveryTimer);
  pendingAssets = new Map();
  const { data, extra, body } = splitFrontmatter(post.raw);
  current = { path: post.path, sha: post.sha, filename: post.name };
  newExtension = post.name.match(/\.(md|mdx)$/)?.[0] || '.mdx';
  const recovery = loadRecovery(connectedRepo, post.path);
  const remote = {
    title: data.title,
    description: data.description,
    slug: post.name.replace(/\.(md|mdx)$/, ''),
    date: data.date,
    tags: data.tags || [],
    draft: !!data.draft,
    extra,
  };
  const recoveryDifferencesList = recovery ? recoveryDifferences(recovery, remote, body) : [];
  const canRecover =
    recovery &&
    (!recovery.baseSha || recovery.baseSha === post.sha) &&
    recoveryDifferencesList.length;

  if (canRecover) {
    setDocument(recovery, recovery.body, { dirty: true, recovered: true });
    newExtension = recovery.extension || newExtension;
    flashStatus('Recovered unpublished changes from this browser.', 'success');
  } else {
    if (recovery) clearRecovery(connectedRepo, post.path);
    setDocument(remote, body);
  }

  elements.delete.hidden = false;
  renderPostList();
  closeSidebar();
  markdownEditor.focus();
}

function newPost({ force = false, recovery = null } = {}) {
  if (!force && !canLeaveDocument()) return false;
  clearTimeout(recoveryTimer);
  pendingAssets = new Map();
  newExtension = recovery?.extension || '.mdx';
  current = null;
  if (recovery) {
    setDocument(recovery, recovery.body, { dirty: true, recovered: true });
    flashStatus('Recovered your unpublished post.', 'success');
  } else {
    setDocument(
      { title: '', description: '', slug: '', date: today(), tags: [], draft: true, extra: '' },
      '',
    );
  }
  elements.delete.hidden = true;
  renderPostList();
  closeSidebar();
  elements.title.focus();
  return true;
}

function renderOutline() {
  const headings = getOutline(markdownEditor.getValue());
  elements.outlineCount.textContent = headings.length || '';
  elements.outline.replaceChildren();
  if (!headings.length) {
    const empty = document.createElement('p');
    empty.className = 'outline-empty';
    empty.textContent = 'Add a heading to build the outline.';
    elements.outline.append(empty);
    return;
  }
  headings.forEach((heading) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.level = Math.min(heading.level, 3);
    button.textContent = heading.label;
    button.title = `Line ${heading.line}`;
    button.addEventListener('click', () => markdownEditor.goToLine(heading.line));
    elements.outline.append(button);
  });
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(renderPreview, 180);
}

function renderPreview() {
  if (!markdownEditor) return;
  elements.preview.innerHTML = renderMarkdown(markdownEditor.getValue());
  elements.preview.querySelectorAll('a[href^="http"]').forEach((link) => {
    link.target = '_blank';
    link.rel = 'noopener';
  });
  renderOutline();
  hydratePreviewImages();
}

const imageCache = new Map();
const MIME = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

function clearImageCache() {
  for (const value of imageCache.values()) {
    if (value.startsWith('blob:')) URL.revokeObjectURL(value);
  }
  imageCache.clear();
}

function cacheLocalImage(path, file) {
  const previous = imageCache.get(path);
  if (previous?.startsWith('blob:')) URL.revokeObjectURL(previous);
  imageCache.set(path, URL.createObjectURL(file));
}

function suffixFilename(name, number) {
  const extensionAt = name.lastIndexOf('.');
  if (extensionAt <= 0) return `${name}-${number}`;
  return `${name.slice(0, extensionAt)}-${number}${name.slice(extensionAt)}`;
}

function pastedAssetFilename(file, kind) {
  const extension = file.name.match(/\.[a-z0-9]+$/i)?.[0].toLowerCase() || '.png';
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 17);
  return `pasted-${kind === 'diagrams' ? 'diagram' : 'image'}-${stamp}${extension}`;
}

async function findUnusedAssetPath(kind, requestedName, reservedPaths = new Set()) {
  for (let index = 0; index < 100; index += 1) {
    const name = index ? suffixFilename(requestedName, index + 1) : requestedName;
    const path = `public/assets/${kind}/${name}`;
    if (reservedPaths.has(path)) continue;
    try {
      await client.getFile(path);
    } catch (error) {
      if (error.status === 404) return { name, path, renamed: name !== requestedName };
      throw error;
    }
  }
  throw new Error('Could not find an unused file name for this image.');
}

async function uploadNewAsset(kind, file, requestedName, reservedPaths = new Set()) {
  const content = await fileToBase64(file);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const destination = await findUnusedAssetPath(kind, requestedName, reservedPaths);
    try {
      await client.putFile(
        destination.path,
        content,
        `Add ${kind.slice(0, -1)}: ${destination.name}`,
      );
      reservedPaths.add(destination.path);
      cacheLocalImage(destination.path, file);
      return destination;
    } catch (error) {
      // A concurrent upload can claim the name between the availability check and commit.
      if (error.status !== 409 && error.status !== 422) throw error;
    }
  }
  throw new Error('The image name changed on GitHub while uploading. Please try again.');
}

function publicAssetUrl(path) {
  return `${BASE}${path.replace(/^public\//, '')}`;
}

async function hydratePreviewImages() {
  for (const image of elements.preview.querySelectorAll('img')) {
    const source = image.getAttribute('src') || '';
    let path = null;
    if (source.startsWith(`${BASE}assets/`)) path = `public/${source.slice(BASE.length)}`;
    else if (source.startsWith('../../assets/')) path = `src/${source.slice('../../'.length)}`;
    if (!path) continue;

    const pending = pendingAssets.get(path);
    if (pending) {
      if (!imageCache.has(path)) imageCache.set(path, URL.createObjectURL(pending));
      image.src = imageCache.get(path);
      continue;
    }
    if (imageCache.has(path)) {
      image.src = imageCache.get(path);
      continue;
    }
    try {
      const file = await client.getFile(path);
      const mime = MIME[path.split('.').pop().toLowerCase()] || 'application/octet-stream';
      const url = `data:${mime};base64,${file.content.replace(/\n/g, '')}`;
      imageCache.set(path, url);
      image.src = url;
    } catch {
      // Leave unresolved images untouched; their path remains useful for editing.
    }
  }
}

function currentFile() {
  const title = elements.title.value.trim();
  const date = elements.date.value;
  const slug = slugify(elements.slug.value || title);
  const tags = elements.tags.value
    .split(',')
    .map((tag) => tag.trim().replace(/^#/, ''))
    .filter(Boolean);
  let body = markdownEditor.getValue();
  let extension = current?.filename.match(/\.(md|mdx)$/)?.[0] || newExtension;
  if (body.includes('<Sidenote')) extension = '.mdx';
  if (body.includes('<Sidenote') && !body.includes('import Sidenote')) {
    body = `import Sidenote from '../../components/Sidenote.astro';\n\n${body}`;
  }
  return {
    title,
    date,
    slug,
    tags,
    body,
    extension,
    filename: `${slug}${extension}`,
    path: `src/content/posts/${slug}${extension}`,
    content: buildFile({
      title,
      description: elements.description.value.trim(),
      date,
      tags,
      draft: elements.draft.checked,
      extra: elements.extra.value.trim(),
      body,
    }),
  };
}

async function savePost() {
  if (!client || elements.save.disabled) return;
  const file = currentFile();
  if (!file.title) return flashStatus('Add a title before publishing.', 'error', 0);
  if (!file.date) return flashStatus('Choose a publish date.', 'error', 0);
  if (!file.slug) return flashStatus('Add a valid slug.', 'error', 0);
  const mdxError = validateMdxBody(file.body);
  if (mdxError) return flashStatus(mdxError, 'error', 0);

  const renamed = current && file.filename !== current.filename;
  const oldRecoveryKey = recoveryKey();
  elements.save.disabled = true;
  setSyncState('saving', 'Publishing to GitHub…');
  flashStatus('Publishing changes…', '', 0);

  try {
    if (pendingAssets.size) {
      let uploaded = 0;
      const totalAssets = pendingAssets.size;
      const reservedPaths = new Set();
      let visibleBody = markdownEditor.getValue();
      for (const [assetPath, asset] of [...pendingAssets]) {
        flashStatus(`Uploading image ${uploaded + 1} of ${totalAssets}…`, '', 0);
        const match = assetPath.match(/^public\/assets\/([^/]+)\/(.+)$/);
        if (!match) throw new Error(`Unsupported asset path: ${assetPath}`);
        const destination = await uploadNewAsset(match[1], asset, match[2], reservedPaths);
        if (destination.path !== assetPath) {
          const oldUrl = publicAssetUrl(assetPath);
          const newUrl = publicAssetUrl(destination.path);
          file.body = file.body.split(oldUrl).join(newUrl);
          file.content = file.content.split(oldUrl).join(newUrl);
          visibleBody = visibleBody.split(oldUrl).join(newUrl);
        }
        pendingAssets.delete(assetPath);
        uploaded += 1;
      }
      if (visibleBody !== markdownEditor.getValue()) {
        loadingDocument = true;
        markdownEditor.setValue(visibleBody);
        loadingDocument = false;
        persistRecovery();
      }
    }

    if (renamed) {
      try {
        await client.getFile(file.path);
        throw new Error(`A post named ${file.filename} already exists.`);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }

    const message = renamed
      ? `Rename post: ${current.filename} → ${file.filename}`
      : current
        ? `Edit post: ${file.title}`
        : `New post: ${file.title}`;
    let response;
    try {
      response = await client.putFile(
        file.path,
        textToBase64(file.content),
        message,
        renamed ? undefined : current?.sha,
      );
    } catch (error) {
      if (error.status === 409) {
        throw new Error('This post changed on GitHub. Refresh it before publishing to avoid overwriting work.');
      }
      throw error;
    }

    if (renamed) {
      await client.deleteFile(current.path, `Remove old name: ${current.filename}`, current.sha);
    }

    current = {
      path: file.path,
      sha: response.content.sha,
      filename: file.filename,
    };
    newExtension = file.extension;
    elements.slug.value = file.slug;
    elements.slug.dataset.touched = '1';
    elements.delete.hidden = false;
    elements.currentLabel.textContent = file.title;
    clearRecovery(connectedRepo, oldRecoveryKey);
    clearRecovery(connectedRepo, file.path);
    dirty = false;
    elements.localState.textContent = '';
    setSyncState('saved', 'Synced with GitHub');
    flashStatus(elements.draft.checked ? 'Draft saved to GitHub.' : 'Published to GitHub.', 'success');
    await refreshPosts();
    renderPostList();
  } catch (error) {
    setSyncState('error', 'Publish failed');
    flashStatus(error.message, 'error', 0);
  } finally {
    elements.save.disabled = false;
  }
}

async function deletePost() {
  if (!current) return;
  if (!window.confirm(`Delete ${current.filename}? This creates a deletion commit on GitHub.`)) return;
  try {
    elements.delete.disabled = true;
    await client.deleteFile(
      current.path,
      `Delete post: ${elements.title.value.trim() || current.filename}`,
      current.sha,
    );
    clearRecovery(connectedRepo, current.path);
    dirty = false;
    flashStatus('Post deleted.', 'success');
    await refreshPosts({ selectInitial: true });
  } catch (error) {
    flashStatus(error.message, 'error', 0);
  } finally {
    elements.delete.disabled = false;
  }
}

function setView(mode) {
  const allowed = ['write', 'split', 'preview'];
  const value = allowed.includes(mode) ? mode : 'split';
  elements.panes.dataset.mode = value;
  document.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  setPreference('view', value);
  renderPreview();
  if (value !== 'preview') requestAnimationFrame(() => markdownEditor.focus());
}

function closeMenus() {
  document.querySelectorAll('#toolbar details[open], #properties-menu[open]').forEach((menu) => {
    menu.open = false;
  });
}

function runEditorCommand(command) {
  closeMenus();
  if (command === 'undo') markdownEditor.undo();
  else if (command === 'redo') markdownEditor.redo();
  else if (command === 'image') openAssetDialog('images');
  else if (command === 'diagram') openAssetDialog('diagrams');
  else markdownEditor.format(command);
}

function toggleFocus() {
  const active = root.classList.toggle('focus-mode');
  $('btn-focus').classList.toggle('active', active);
  $('btn-focus').setAttribute('aria-pressed', String(active));
  requestAnimationFrame(() => markdownEditor.focus());
}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  if (dark) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = 'dark';
  localStorage.setItem('theme', dark ? 'light' : 'dark');
}

function openSidebar() {
  root.classList.add('sidebar-open');
}

function closeSidebar() {
  root.classList.remove('sidebar-open');
}

/* Asset uploads */
const assetDialog = $('asset-dialog');
const assetFile = $('asset-file');
const assetName = $('asset-name');
const assetAlt = $('asset-alt');
const assetWidth = $('asset-width');
const assetCaption = $('asset-caption');
const assetPreview = $('asset-preview');
const assetInsert = $('asset-insert');
const assetError = $('asset-error');

function openAssetDialog(kind, file = null, source = 'upload') {
  assetState = { kind, file: null, source };
  $('asset-title').textContent = kind === 'diagrams' ? 'Insert an Excalidraw diagram' : 'Insert an image';
  $('asset-hint').textContent =
    kind === 'diagrams'
      ? 'Export the drawing as SVG with “Embed scene” enabled so you can edit it again later.'
      : 'PNG, JPG, GIF, WebP, AVIF, and SVG are supported.';
  $('asset-excalidraw').hidden = kind !== 'diagrams';
  assetFile.value = '';
  assetName.value = '';
  assetAlt.value = '';
  assetWidth.value = '';
  assetCaption.value = '';
  assetPreview.replaceChildren();
  assetPreview.hidden = true;
  assetInsert.disabled = true;
  assetError.textContent = '';
  assetDialog.showModal();
  if (file) setAssetFile(file);
}

function setAssetFile(file) {
  if (!file.type.startsWith('image/') && !/\.svg$/i.test(file.name)) {
    assetError.textContent = 'Choose an image or SVG file.';
    return;
  }
  assetState.file = file;
  const sanitizedName = sanitizeFilename(file.name);
  const genericClipboardName = /^(?:image|clipboard|blob)(?:-\d+)?(?:\.[a-z0-9]+)?$/i.test(
    sanitizedName,
  );
  assetName.value =
    assetState.source === 'paste' && genericClipboardName
      ? pastedAssetFilename(file, assetState.kind)
      : sanitizedName;
  assetAlt.value ||= file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
  assetPreview.replaceChildren();
  const image = document.createElement('img');
  image.src = URL.createObjectURL(file);
  image.alt = '';
  assetPreview.append(image);
  assetPreview.hidden = false;
  assetInsert.disabled = false;
  assetError.textContent = '';
}

async function insertAsset(event) {
  event.preventDefault();
  if (!assetState.file) return;
  assetInsert.disabled = true;
  assetError.textContent = 'Uploading to GitHub…';
  try {
    let name = sanitizeFilename(assetName.value.trim() || assetState.file.name);
    if (!/\.[a-z0-9]+$/i.test(name)) {
      name += assetState.file.name.match(/\.[a-z0-9]+$/i)?.[0] || '.png';
    }
    const destination = await uploadNewAsset(assetState.kind, assetState.file, name);
    name = destination.name;
    assetName.value = name;
    const width = assetWidth.value ? ` width="${Number(assetWidth.value)}"` : '';
    const alt = escapeAttribute(assetAlt.value.trim());
    const caption = escapeAttribute(assetCaption.value.trim());
    const image = `<img src="${BASE}assets/${assetState.kind}/${name}" alt="${alt}"${width} />`;
    markdownEditor.insertBlock(
      caption ? `<figure>\n${image}\n<figcaption>${caption}</figcaption>\n</figure>` : image,
    );
    assetDialog.close();
    flashStatus(
      destination.renamed
        ? `Image saved as ${name} so an existing asset was not replaced.`
        : 'Image uploaded and inserted.',
      'success',
    );
  } catch (error) {
    assetError.textContent = error.message;
  } finally {
    assetInsert.disabled = false;
  }
}

/* Markdown and Obsidian import */
const importDialog = $('import-dialog');
const importFilesInput = $('import-files');
const importStatus = $('import-status');
const importMissing = $('import-missing');
const importGo = $('import-go');
const importError = $('import-error');

function openImportDialog() {
  closeMenus();
  importData = null;
  importFiles = new Map();
  importFilesInput.value = '';
  importStatus.textContent = '';
  importMissing.replaceChildren();
  importError.textContent = '';
  importGo.disabled = true;
  importGo.textContent = 'Import post';
  importDialog.showModal();
}

async function analyzeImport(fileList) {
  [...fileList].forEach((file) => importFiles.set(file.name, file));
  importError.textContent = '';
  importMissing.replaceChildren();
  importGo.disabled = true;
  importData = null;

  try {
    const result = await prepareObsidianImport([...importFiles.values()], BASE);
    if (result.waiting) {
      importStatus.textContent = `${result.fileCount} file(s) ready. Add the Markdown note next.`;
      return;
    }
    importData = result;
    importStatus.textContent = `${result.filename} · ${
      result.total ? `${result.matched} of ${result.total} referenced images matched` : 'no image references found'
    }`;
    result.missing.forEach((reference) => {
      const item = document.createElement('li');
      item.textContent = reference;
      importMissing.append(item);
    });
    importGo.disabled = false;
    importGo.textContent = result.missing.length ? 'Import with missing images' : 'Import post';
  } catch (error) {
    importStatus.textContent = '';
    importError.textContent = error.message;
  }
}

function importPost(event) {
  event.preventDefault();
  if (!importData || !canLeaveDocument()) return;
  newPost({ force: true });
  current = null;
  newExtension = '.md';
  pendingAssets = importData.assets;
  setDocument(importData, importData.body, { dirty: true });
  markDirty();
  importDialog.close();
  flashStatus(
    pendingAssets.size
      ? `Imported. ${pendingAssets.size} image(s) will upload when you publish.`
      : 'Imported. Review the post, then publish.',
    'success',
  );
  markdownEditor.focus();
}

/* Export */
function exportMarkdown() {
  closeMenus();
  const file = currentFile();
  if (!file.slug) return flashStatus('Add a title or slug before exporting.', 'error');
  const url = URL.createObjectURL(new Blob([file.content], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  flashStatus(`Exported ${file.filename}.`, 'success');
}

/* Version history */
const historyDialog = $('history-dialog');
const historyList = $('history-list');

async function openHistory() {
  closeMenus();
  if (!current) return flashStatus('Publish this post once to start its version history.', 'error');
  historyList.innerHTML = '<p class="history-empty">Loading versions…</p>';
  historyDialog.showModal();
  try {
    const commits = await client.listCommits(current.path);
    historyList.replaceChildren();
    if (!commits.length) {
      historyList.innerHTML = '<p class="history-empty">No earlier versions found.</p>';
      return;
    }
    commits.forEach((commit, index) => {
      const item = document.createElement('div');
      item.className = 'history-item';
      const node = document.createElement('span');
      node.className = 'history-node';
      const copy = document.createElement('span');
      copy.className = 'history-copy';
      const title = document.createElement('strong');
      title.textContent = commit.commit.message.split('\n')[0];
      const meta = document.createElement('span');
      meta.textContent = `${new Date(commit.commit.author.date).toLocaleString()} · ${
        commit.author?.login || commit.commit.author.name
      }`;
      copy.append(title, meta);
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.textContent = index === 0 ? 'Current' : 'Restore';
      restore.disabled = index === 0;
      restore.addEventListener('click', async () => {
        if (dirty && !window.confirm('Replace the current editor contents with this version?')) return;
        restore.disabled = true;
        restore.textContent = 'Loading…';
        try {
          const version = await client.getFile(current.path, commit.sha);
          const { data, extra, body } = splitFrontmatter(base64ToText(version.content));
          setDocument(
            {
              title: data.title,
              description: data.description,
              slug: current.filename.replace(/\.(md|mdx)$/, ''),
              date: data.date,
              tags: data.tags || [],
              draft: !!data.draft,
              extra,
            },
            body,
            { dirty: true },
          );
          markDirty();
          historyDialog.close();
          flashStatus('Earlier version restored locally. Publish to make it current.', 'success');
        } catch (error) {
          flashStatus(error.message, 'error', 0);
          restore.disabled = false;
          restore.textContent = 'Restore';
        }
      });
      item.append(node, copy, restore);
      historyList.append(item);
    });
  } catch (error) {
    historyList.innerHTML = `<p class="history-empty">${escapeAttribute(error.message)}</p>`;
  }
}

/* Command menu */
const commandDialog = $('command-dialog');
const commandSearch = $('command-search');
const commandList = $('command-list');

const commands = [
  { section: 'Post', name: 'New post', icon: '+', keys: '⌘ N', run: () => newPost() },
  { section: 'Post', name: 'Publish changes', icon: '↑', keys: '⌘ S', run: savePost },
  { section: 'Post', name: 'Import Markdown', icon: 'I', run: openImportDialog },
  { section: 'Post', name: 'Export Markdown', icon: 'E', run: exportMarkdown },
  { section: 'Post', name: 'Version history', icon: '↶', run: openHistory },
  { section: 'View', name: 'Write view', icon: 'W', run: () => setView('write') },
  { section: 'View', name: 'Split view', icon: 'S', run: () => setView('split') },
  { section: 'View', name: 'Preview view', icon: 'P', run: () => setView('preview') },
  { section: 'View', name: 'Toggle focus mode', icon: '↗', run: toggleFocus },
  { section: 'Formatting', name: 'Heading 2', icon: 'H', run: () => runEditorCommand('h2') },
  { section: 'Formatting', name: 'Bold', icon: 'B', keys: '⌘ B', run: () => runEditorCommand('bold') },
  { section: 'Formatting', name: 'Link', icon: '↗', run: () => runEditorCommand('link') },
  { section: 'Formatting', name: 'Code block', icon: '<>', run: () => runEditorCommand('codeblock') },
  { section: 'Insert', name: 'Image', icon: '▧', run: () => openAssetDialog('images') },
  { section: 'Insert', name: 'Excalidraw diagram', icon: '◇', run: () => openAssetDialog('diagrams') },
  { section: 'Insert', name: 'Table', icon: '#', run: () => runEditorCommand('table') },
  { section: 'Insert', name: 'Equation', icon: '∑', run: () => runEditorCommand('math') },
  { section: 'Insert', name: 'Sidenote', icon: 'N', run: () => runEditorCommand('sidenote') },
  { section: 'Insert', name: 'Footnote', icon: '¹', run: () => runEditorCommand('footnote') },
];

const commandPalette = createCommandPalette({
  dialog: commandDialog,
  input: commandSearch,
  list: commandList,
  commands,
});

function openCommandDialog() {
  commandPalette.open();
}

/* Authentication */
async function connect(event) {
  event?.preventDefault();
  const owner = elements.gateOwner.value.trim();
  const repo = elements.gateRepo.value.trim();
  const token = elements.gateToken.value.trim();
  if (!owner || !repo || !token) {
    elements.gateError.textContent = 'Complete all three fields.';
    return;
  }
  client = createClient({ token, owner, repo, branch: cfg.branch });
  elements.gateError.textContent = 'Connecting securely to GitHub…';
  try {
    await client.test();
    localStorage.setItem(LS_TOKEN, token);
    localStorage.setItem(LS_REPO, JSON.stringify({ owner, repo }));
    connectedRepo = `${owner}/${repo}`;
    elements.repoLabel.textContent = connectedRepo;
    await enter();
  } catch (error) {
    elements.gateError.textContent = `${error.message}. Check the token and repository.`;
  }
}

async function enter() {
  elements.gate.hidden = true;
  elements.app.hidden = false;
  await loadEditorModules();
  initMarkdownEditor();
  setView(getPreference('view', 'split'));
  await refreshPosts({ selectInitial: true });
}

/* Event wiring */
elements.gateForm.addEventListener('submit', connect);
elements.save.addEventListener('click', savePost);
$('btn-new').addEventListener('click', () => newPost());
$('btn-refresh').addEventListener('click', () => refreshPosts());
elements.delete.addEventListener('click', deletePost);
$('btn-import').addEventListener('click', openImportDialog);
$('btn-export').addEventListener('click', exportMarkdown);
$('btn-history').addEventListener('click', openHistory);
$('btn-shortcuts').addEventListener('click', () => {
  closeMenus();
  $('shortcuts-dialog').showModal();
});
$('btn-command').addEventListener('click', openCommandDialog);
$('btn-theme').addEventListener('click', toggleTheme);
$('btn-focus').addEventListener('click', toggleFocus);
$('btn-sidebar').addEventListener('click', () =>
  root.classList.contains('sidebar-open') ? closeSidebar() : openSidebar(),
);
$('sidebar-scrim').addEventListener('click', closeSidebar);
$('btn-forget').addEventListener('click', () => {
  localStorage.removeItem(LS_TOKEN);
  location.reload();
});

elements.search.addEventListener('input', renderPostList);
$('post-filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  listFilter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach((filter) => {
    const active = filter === button;
    filter.classList.toggle('active', active);
    filter.setAttribute('aria-selected', String(active));
  });
  renderPostList();
});

[elements.title, elements.description, elements.slug, elements.date, elements.tags, elements.draft, elements.extra]
  .forEach((field) => {
    field.addEventListener('input', () => {
      markDirty();
      if (field === elements.title) {
        elements.currentLabel.textContent = elements.title.value || 'Untitled';
        if (!current && !elements.slug.dataset.touched) elements.slug.value = slugify(elements.title.value);
      }
    });
  });
elements.slug.addEventListener('input', () => (elements.slug.dataset.touched = '1'));

document.querySelectorAll('[data-command]').forEach((button) => {
  button.addEventListener('click', () => runEditorCommand(button.dataset.command));
});
$('heading-select').addEventListener('change', (event) => {
  runEditorCommand(event.target.value);
  event.target.value = 'paragraph';
});
document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => setView(button.dataset.view));
});

$('asset-form').addEventListener('submit', insertAsset);
assetFile.addEventListener('change', () => assetFile.files[0] && setAssetFile(assetFile.files[0]));
const assetDrop = $('asset-drop');
assetDrop.addEventListener('dragover', (event) => {
  event.preventDefault();
  assetDrop.classList.add('dragging');
});
assetDrop.addEventListener('dragleave', () => assetDrop.classList.remove('dragging'));
assetDrop.addEventListener('drop', (event) => {
  event.preventDefault();
  assetDrop.classList.remove('dragging');
  if (event.dataTransfer.files[0]) setAssetFile(event.dataTransfer.files[0]);
});

$('import-form').addEventListener('submit', importPost);
importFilesInput.addEventListener('change', () => {
  if (importFilesInput.files.length) analyzeImport(importFilesInput.files);
});
const importDrop = $('import-drop');
importDrop.addEventListener('dragover', (event) => {
  event.preventDefault();
  importDrop.classList.add('dragging');
});
importDrop.addEventListener('dragleave', () => importDrop.classList.remove('dragging'));
importDrop.addEventListener('drop', (event) => {
  event.preventDefault();
  importDrop.classList.remove('dragging');
  if (event.dataTransfer.files.length) analyzeImport(event.dataTransfer.files);
});

elements.sourcePane.addEventListener('dragenter', (event) => {
  if ([...(event.dataTransfer?.items || [])].some((item) => item.kind === 'file')) {
    elements.sourcePane.classList.add('dragging');
  }
});
elements.sourcePane.addEventListener('dragleave', (event) => {
  if (!elements.sourcePane.contains(event.relatedTarget)) elements.sourcePane.classList.remove('dragging');
});
elements.sourcePane.addEventListener('drop', () => elements.sourcePane.classList.remove('dragging'));

document.querySelectorAll('[data-close-dialog]').forEach((button) => {
  button.addEventListener('click', () => $(button.dataset.closeDialog).close());
});
document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
});

document.addEventListener('click', (event) => {
  document.querySelectorAll('#toolbar details[open], #properties-menu[open]').forEach((menu) => {
    if (!menu.contains(event.target)) menu.open = false;
  });
});

document.addEventListener('keydown', (event) => {
  if (elements.app.hidden) return;
  const commandKey = event.metaKey || event.ctrlKey;
  if (commandKey && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openCommandDialog();
  } else if (commandKey && event.key.toLowerCase() === 's') {
    event.preventDefault();
    savePost();
  } else if (commandKey && event.key === '/') {
    event.preventDefault();
    openSidebar();
    elements.search.focus();
  } else if (commandKey && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    newPost();
  } else if (event.key === 'Escape') {
    if (root.classList.contains('sidebar-open')) closeSidebar();
    else if (root.classList.contains('focus-mode')) toggleFocus();
  }
});

window.addEventListener('beforeunload', (event) => {
  if (dirty) event.preventDefault();
});

/* Boot */
let savedRepo = null;
try {
  savedRepo = JSON.parse(localStorage.getItem(LS_REPO) || 'null');
} catch {
  savedRepo = null;
}
elements.gateOwner.value = savedRepo?.owner || cfg.owner;
elements.gateRepo.value = savedRepo?.repo || cfg.repo;
connectedRepo = `${elements.gateOwner.value}/${elements.gateRepo.value}`;
elements.repoLabel.textContent = connectedRepo;

const savedToken = localStorage.getItem(LS_TOKEN);
if (savedToken) {
  client = createClient({
    token: savedToken,
    owner: elements.gateOwner.value,
    repo: elements.gateRepo.value,
    branch: cfg.branch,
  });
  enter();
} else {
  elements.gate.hidden = false;
}
