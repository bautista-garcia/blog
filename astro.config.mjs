// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { rehypeSidenoteFootnotes } from './src/lib/rehype-sidenote-footnotes.mjs';

// If you fork/rename the repo, update these two values.
// For a user site (<handle>.github.io as repo name), set base: '/'.
export default defineConfig({
  site: 'https://bautista-garcia.github.io',
  base: '/blog',
  integrations: [mdx()],
  markdown: {
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeKatex, rehypeSidenoteFootnotes],
  },
});
