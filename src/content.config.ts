import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const posts = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    /** Drafts are visible in `npm run dev` but excluded from the deployed build. */
    draft: z.boolean().default(false),
    /** Home-page excerpt override; defaults to the first paragraph. */
    description: z.string().optional(),
  }),
});

export const collections = { posts };
