import DOMPurify from 'dompurify';
import katex from 'katex';
import { marked } from 'marked';

marked.use({ gfm: true, breaks: false });

export function slugify(value) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function sanitizeFilename(value) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function today() {
  const date = new Date();
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => (index ? String(part).padStart(2, '0') : part))
    .join('-');
}

function unquote(value) {
  const trimmed = value.trim();
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  return quoted ? trimmed.slice(1, -1).replace(/\\"/g, '"') : trimmed;
}

function quoteIfNeeded(value) {
  const string = String(value);
  return /[:#"'\[\]{},&*?]|^\s|\s$/.test(string)
    ? `"${string.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    : string;
}

/** Parse the fields the blog understands while preserving every unknown line. */
export function splitFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, extra: '', body: raw };

  const data = {};
  const extra = [];
  const lines = match[1].split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let field;
    if ((field = line.match(/^title:\s*(.*)$/))) data.title = unquote(field[1]);
    else if ((field = line.match(/^description:\s*(.*)$/))) data.description = unquote(field[1]);
    else if ((field = line.match(/^date:\s*(.*)$/))) data.date = unquote(field[1]).slice(0, 10);
    else if ((field = line.match(/^draft:\s*(.*)$/))) data.draft = field[1].trim() === 'true';
    else if ((field = line.match(/^tags:\s*\[(.*)\]\s*$/))) {
      data.tags = field[1]
        .split(',')
        .map((tag) => unquote(tag).trim().replace(/^#/, ''))
        .filter(Boolean);
    } else if (/^tags:\s*$/.test(line) && /^\s+-\s/.test(lines[index + 1] || '')) {
      data.tags = [];
      while (/^\s+-\s/.test(lines[index + 1] || '')) {
        data.tags.push(unquote(lines[(index += 1)].replace(/^\s+-\s*/, '')).replace(/^#/, ''));
      }
    } else if ((field = line.match(/^tags:\s+(.+)$/))) {
      data.tags = field[1]
        .split(',')
        .map((tag) => unquote(tag).trim().replace(/^#/, ''))
        .filter(Boolean);
    } else {
      extra.push(line);
    }
  }

  return {
    data,
    extra: extra.join('\n').trim(),
    body: raw.slice(match[0].length),
  };
}

export function buildFile({ title, description, date, tags, draft, extra, body }) {
  const frontmatter = ['---', `title: ${quoteIfNeeded(title)}`];
  if (description) frontmatter.push(`description: ${quoteIfNeeded(description)}`);
  frontmatter.push(
    `date: ${date}`,
    `tags: [${tags.map(quoteIfNeeded).join(', ')}]`,
    `draft: ${draft ? 'true' : 'false'}`,
  );
  if (extra) frontmatter.push(extra.trim());
  frontmatter.push('---', '');
  return frontmatter.join('\n') + body.replace(/^\n+/, '');
}

export function validateMdxBody(body) {
  if (body.split('\n').some((line) => line.includes('<Sidenote') && !line.includes('</Sidenote>'))) {
    return 'A <Sidenote> must open and close on the same line.';
  }
  if (body.split('\n').some((line) => line.includes('<img') && !line.includes('/>'))) {
    return 'An <img> tag is missing its self-closing "/>".';
  }
  return '';
}

function extractFootnotes(source) {
  const definitions = new Map();
  let cleaned = source.replace(/^\[\^([^\]]+)\]:\s*(.+)$/gm, (_, id, value) => {
    definitions.set(id, value.trim());
    return '';
  });
  const order = [];
  cleaned = cleaned.replace(/\[\^([^\]]+)\]/g, (match, id) => {
    if (!definitions.has(id)) return match;
    if (!order.includes(id)) order.push(id);
    const number = order.indexOf(id) + 1;
    return `<sup class="footnote-ref"><a href="#fn-${id}" id="fnref-${id}">${number}</a></sup>`;
  });
  return { source: cleaned, definitions, order };
}

/** Render the client-side approximation used by the editor preview. */
export function renderMarkdown(source) {
  let prepared = source.replace(/^import\s+.*$/gm, '');
  prepared = prepared.replace(
    /<Sidenote>([\s\S]*?)<\/Sidenote>/g,
    (_, note) => `<span class="preview-sidenote" role="note">${note}</span>`,
  );

  const footnotes = extractFootnotes(prepared);
  const math = [];
  const stashMath = (formula, displayMode) => {
    math.push(katex.renderToString(formula, { displayMode, throwOnError: false, strict: false }));
    return `XQMATHX${math.length - 1}XQ`;
  };
  const extractMath = (part) =>
    part
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, formula) => stashMath(formula, true))
      .replace(/\$([^$\n]+?)\$/g, (_, formula) => stashMath(formula, false));

  const processed = footnotes.source
    .split(/(```[\s\S]*?```)/)
    .map((part, index) => (index % 2 ? part : extractMath(part)))
    .join('');

  let html = marked.parse(processed);
  html = html.replace(/XQMATHX(\d+)XQ/g, (_, index) => math[Number(index)]);

  if (footnotes.order.length) {
    const items = footnotes.order
      .map((id) => {
        const value = marked.parseInline(footnotes.definitions.get(id));
        return `<li id="fn-${id}">${value} <a class="footnote-back" href="#fnref-${id}" aria-label="Back to reference">↩</a></li>`;
      })
      .join('');
    html += `<section class="preview-footnotes" aria-label="Footnotes"><ol>${items}</ol></section>`;
  }

  return DOMPurify.sanitize(html, {
    ADD_ATTR: [
      'autoplay',
      'controls',
      'loop',
      'muted',
      'playsinline',
      'poster',
      'preload',
      'target',
    ],
    ADD_TAGS: ['annotation', 'math', 'mrow', 'semantics', 'source', 'video'],
  });
}

export function getOutline(source) {
  const outline = [];
  let inFence = false;
  source.split('\n').forEach((line, index) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) return;
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!heading) return;
    outline.push({
      level: heading[1].length,
      line: index + 1,
      label: heading[2].replace(/[*_`~\[\]]/g, '').trim(),
    });
  });
  return outline;
}

export function getWritingStats(source) {
  const plain = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_`~\[\]()-]/g, ' ')
    .trim();
  const words = plain ? plain.split(/\s+/).filter(Boolean).length : 0;
  return {
    words,
    characters: source.length,
    minutes: Math.max(1, Math.ceil(words / 220)),
  };
}

export function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
