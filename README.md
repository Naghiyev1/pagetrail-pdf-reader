# PageTrail PDF Reader

A private, browser-based reading desk for long PDFs.

No summaries. No backend. No account. No paid hosting.

## Features

- Open local PDF files in the browser
- Render PDF pages using PDF.js
- Save progress per file
- Recent documents library
- Bookmarks
- Page notes
- Manual chapter / section structure
- Reading trail / session log
- Light, sepia, and dark modes
- Focus mode
- Zoom controls
- Keyboard shortcuts
- Export/import your reading library as JSON
- Export notes as Markdown

## Keyboard shortcuts

- `ArrowLeft`: previous page
- `ArrowRight`: next page
- `b`: bookmark current page
- `n`: focus note box
- `f`: focus mode
- `s`: save reading session
- `/`: search notes

## Local development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Deploy to GitHub Pages

### Option 1: GitHub Pages from `/docs`

If you prefer the simplest GitHub Pages setup without GitHub Actions:

```bash
npm run build
cp -r dist docs
```

Then in GitHub:

Settings → Pages → Deploy from branch → `main` → `/docs`

### Option 2: GitHub Actions

You can also deploy the `dist` folder using a GitHub Pages workflow.

## Important privacy note

Your PDF files are not uploaded anywhere. The app reads local files in your browser. Reading progress, bookmarks, notes, structure, and sessions are stored in localStorage.

If you clear browser storage, your reading data can be lost. Use Export Library regularly as a backup.

## Technical note

This app uses `pdfjs-dist` to render pages to canvas and render selectable text layers. It is intentionally static-hosting friendly and should work on GitHub Pages.
