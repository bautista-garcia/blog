# blog

A minimalist personal blog built with [Astro](https://astro.build), deployed to GitHub Pages.

## The editor (easiest way to write)

Open **`/editor/`** on the deployed site or in dev (`npm run dev` → http://localhost:4321/blog/editor/). On first visit, paste a GitHub token (fine-grained, this repo only, **Contents: read and write** — or classic `repo` scope). It's stored only in your browser.

From there the editor works like a small, GitHub-backed writing app:

- **Modern Markdown editing** — CodeMirror provides syntax highlighting, line numbers, folding, bracket matching, multiple cursors, selection matching, undo/redo, search/replace, list continuation, and keyboard-driven indentation.
- **Write, split, and preview views** — live GFM, table, checklist, math, footnote, image, figure, and sidenote rendering with synchronized scrolling in split view.
- **Fast authoring** — formatting toolbar, insert menu, document outline, focus mode, command menu (`Cmd/Ctrl+K`), word/character counts, and estimated reading time.
- **Publishing metadata** — title, description, slug, date, tags, draft status, plus a raw field for additional frontmatter. `Cmd/Ctrl+S` publishes the change as a GitHub commit.
- **Safe recovery and history** — unpublished work is recovered from browser storage. Published posts expose their Git commit history and any earlier version can be restored into the editor before republishing.
- **Post management** — search the library, filter published posts and drafts, rename via the slug, create, export, or delete posts.
- **Images & Excalidraw diagrams** — use the insert menu, or paste/drop directly into the editor. Excalidraw's copied SVG markup is recognized automatically. Files are committed to `public/assets/` and inserted at the cursor with optional alt text, width, and caption. Clipboard images receive unique names, and all uploads avoid replacing an existing asset.
- **Import from Obsidian** — import a `.md` file with its images. `![[embeds]]`, `[[wikilinks]]`, frontmatter, widths, and captions are converted; missing files are reported before import.

The editor code is deliberately split by responsibility so changes stay approachable:

- `src/pages/editor/index.astro` — semantic app markup
- `src/editor/editor.css` — the complete editor theme and responsive layout
- `src/editor/codemirror.js` — editor engine and Markdown commands
- `src/editor/command-palette.js` — searchable keyboard command UI
- `src/editor/markdown.js` — frontmatter, preview rendering, outline, and writing stats
- `src/editor/obsidian.js` — Markdown/Obsidian import conversion
- `src/editor/storage.js` — local recovery and preferences
- `src/editor/github.js` — the small GitHub Contents API client
- `src/editor/app.js` — product state and interaction wiring

Saving pushes a commit, so the GitHub Action rebuilds and the change is live in ~a minute.

## Publishing a post (by hand)

1. Create `src/content/posts/my-post.md` with frontmatter:

   ```yaml
   ---
   title: My post title
   date: 2026-07-21
   tags: [some-topic]
   draft: false
   ---
   ```

2. Preview locally with `npm run dev` (drafts are visible here, with a badge).
3. `git push` — the GitHub Action builds and deploys the site automatically.

**Editing** a post: edit the file, push. **Drafts:** set `draft: true`; they're excluded from the deployed build. **Sidenotes:** write the post as `.mdx` and use the `<Sidenote>` component — see `src/content/posts/how-this-blog-works.mdx` for an example.

**Math:** LaTeX via KaTeX, rendered at build time. Inline `$e_t^T$`, display `$$...$$`. Works in `.md` and `.mdx`.

**Diagrams (Excalidraw):** export SVG from excalidraw.com (tick "Embed scene"), save to `src/assets/diagrams/`, embed with a relative path: `![alt](../../assets/diagrams/foo.svg)`. (Or just use the editor, which handles upload + sizing for you.)

**Dark mode:** manual toggle in the nav (default: light), persisted in `localStorage`. Sidenotes float in the margin on desktop; on mobile they expand inline via the number and are also listed at the end of the post.

## Local development

```sh
npm install
npm run dev      # http://localhost:4321/blog/
npm run build    # production build to dist/
npm run preview  # preview the production build
```

## Configuration

- `src/site.config.ts` — site name, author, intro line, GitHub link.
- `astro.config.mjs` — `site` and `base`. If the repo is renamed or you use a custom domain / user site, update these.

## First deploy to GitHub Pages

1. Push this repo to GitHub as `blog`.
2. In the repo: **Settings → Pages → Source: GitHub Actions**.
3. Push to `main`; the workflow in `.github/workflows/deploy.yml` publishes to `https://<handle>.github.io/blog`.
