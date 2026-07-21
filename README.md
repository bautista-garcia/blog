# blog

A minimalist personal blog built with [Astro](https://astro.build), deployed to GitHub Pages.

## The editor (easiest way to write)

Open **`/editor/`** on the deployed site or in dev (`npm run dev` → http://localhost:4321/blog/editor/). On first visit, paste a GitHub token (fine-grained, this repo only, **Contents: read and write** — or classic `repo` scope). It's stored only in your browser.

From there everything is a commit to this repo:

- **Write/edit posts** — title, date, tags, draft, and Markdown body with a toolbar (code blocks, math, sidenotes, links). `Cmd/Ctrl+S` saves.
- **Images & Excalidraw diagrams** — click *Image…* / *Diagram…*, or just **paste/drop a file into the text area**. Diagrams: draw at excalidraw.com, export SVG ("Embed scene" ticked), drop it in. The file is uploaded to `public/assets/` and an `<img>` tag is inserted at the cursor.
- **Resizing** — set a pixel width in the upload dialog (or edit the `width="..."` attribute afterwards). Empty means full column width.
- **Preview** — approximate preview (Markdown + KaTeX); check the real rendering in `npm run dev`.

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
