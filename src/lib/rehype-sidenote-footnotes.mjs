/**
 * Rehype plugin: collects <Sidenote> JSX elements in MDX documents and
 * appends a footnotes section (visible on small screens via CSS) at the
 * end of the content. Runs after rehype-katex so notes contain fully
 * rendered math. Per-document — no shared state between pages.
 */
export function rehypeSidenoteFootnotes() {
  return (tree) => {
    const notes = [];
    const walk = (node) => {
      if (
        (node.type === 'mdxJsxTextElement' || node.type === 'mdxJsxFlowElement') &&
        node.name === 'Sidenote'
      ) {
        notes.push(node.children);
      }
      if (node.children) node.children.forEach(walk);
    };
    walk(tree);
    if (!notes.length) return;

    tree.children.push({
      type: 'element',
      tagName: 'section',
      properties: { className: ['footnotes'] },
      children: [
        { type: 'element', tagName: 'hr', properties: {}, children: [] },
        {
          type: 'element',
          tagName: 'ol',
          properties: {},
          children: notes.map((children) => ({
            type: 'element',
            tagName: 'li',
            properties: {},
            children: structuredClone(children),
          })),
        },
      ],
    });
  };
}
