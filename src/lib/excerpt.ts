function plainText(block: string): string {
  return block
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

/** Derive a short card excerpt from the first prose paragraph in a post. */
export function getExcerpt(body: string): string {
  const firstParagraph = body
    .replace(/^import\s.*$/gm, '')
    .replace(/^#{1,6}\s+.*$/gm, '')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block && !/^(?:\$\$|<figure|<img|<video)/i.test(block))
    .map(plainText)
    .find(Boolean) ?? '';

  if (firstParagraph.length <= 190) return firstParagraph;
  const shortened = firstParagraph.slice(0, 190).replace(/\s+\S*$/, '').replace(/[,:;.!?]?$/, '');
  return `${shortened}…`;
}
