/**
 * Derive a plain-text excerpt from a post's raw Markdown/MDX body:
 * the first block, with inline markup stripped.
 */
export function getExcerpt(body: string): string {
  const withoutImports = body.replace(/^import\s.*$/gm, '');
  const firstBlock =
    withoutImports
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .find((block) => block.length > 0) ?? '';
  return firstBlock
    .replace(/<Sidenote[\s\S]*?<\/Sidenote>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    // LaTeX: unwrap math, then reduce commands to readable plain text
    .replace(/\$\$([\s\S]+?)\$\$/g, '$1')
    .replace(/\$([^$\n]+?)\$/g, '$1')
    .replace(/\\text\{([^}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
