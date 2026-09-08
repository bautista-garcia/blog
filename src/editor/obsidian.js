import { escapeAttribute, sanitizeFilename, slugify, splitFrontmatter, today } from './markdown.js';

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function findImage(reference, files) {
  const basename = reference.split('/').pop();
  const decoded = safeDecode(basename);
  return (
    files.find((file) => file.name === basename) ||
    files.find((file) => file.name === decoded) ||
    files.find((file) => file.name.toLowerCase() === decoded.toLowerCase())
  );
}

/** Convert one Markdown/Obsidian note plus its dropped images into editor state. */
export async function prepareObsidianImport(files, baseUrl) {
  const markdownFiles = files.filter((file) => /\.(md|markdown)$/i.test(file.name));
  if (!markdownFiles.length) return { waiting: true, fileCount: files.length };
  if (markdownFiles.length > 1) throw new Error('Import one Markdown note at a time.');

  const markdownFile = markdownFiles[0];
  const images = files.filter((file) => file !== markdownFile);
  const { data, body: originalBody } = splitFrontmatter(await markdownFile.text());
  const assets = new Map();
  const missing = [];
  let body = originalBody;

  body = body.replace(/!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_, reference, alias) => {
    const ref = reference.trim();
    const file = findImage(ref, images);
    const name = sanitizeFilename(safeDecode(ref.split('/').pop()));
    const value = (alias || '').trim();
    const width = /^\d+$/.test(value) ? ` width="${value}"` : '';
    const alt = escapeAttribute(
      value && !/^\d+$/.test(value) ? value : name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '),
    );
    if (file) assets.set(`public/assets/images/${name}`, file);
    else missing.push(ref);
    return `<img src="${baseUrl}assets/images/${name}" alt="${alt}"${width} />`;
  });

  body = body.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g, (match, alt, url) => {
    if (/^https?:\/\//i.test(url)) return match;
    const file = findImage(url.trim(), images);
    const name = sanitizeFilename(safeDecode(url.trim().split('/').pop()));
    if (file) assets.set(`public/assets/images/${name}`, file);
    else missing.push(url.trim());
    return `<img src="${baseUrl}assets/images/${name}" alt="${escapeAttribute(alt)}" />`;
  });

  body = body.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1');
  const basename = markdownFile.name.replace(/\.(md|markdown)$/i, '');

  return {
    waiting: false,
    filename: markdownFile.name,
    title: data.title || basename.replace(/[-_]+/g, ' '),
    description: data.description || '',
    slug: slugify(basename),
    date: data.date || today(),
    tags: data.tags || [],
    draft: true,
    extra: '',
    body,
    assets,
    missing,
    matched: assets.size,
    total: assets.size + missing.length,
  };
}
