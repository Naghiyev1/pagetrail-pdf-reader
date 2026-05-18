import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import './styles.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

const PDFJS_ASSET_BASE = `${import.meta.env.BASE_URL || './'}pdfjs/`;
const STORAGE_KEY = 'pagetrail:v2';

const defaultLibrary = {
  documents: {},
  recent: [],
  settings: {
    theme: 'sepia',
    focusMode: false,
    sidePanel: true,
    zoom: 1.25,
    fitWidth: true,
    displayMode: 'pdfjs'
  }
};

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(value) {
  if (!value) return '';

  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatTime(value) {
  if (!value) return '';

  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));
  } catch {
    return '';
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizePage(value, totalPages) {
  const page = Number.parseInt(value, 10);
  if (!Number.isFinite(page)) return 1;
  return clamp(page, 1, totalPages || 999999);
}

function makeFingerprint(file) {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

function loadLibrary() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultLibrary;

    const parsed = JSON.parse(raw);

    return {
      ...defaultLibrary,
      ...parsed,
      settings: {
        ...defaultLibrary.settings,
        ...(parsed.settings || {})
      }
    };
  } catch {
    return defaultLibrary;
  }
}

function saveLibrary(library) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(library));
}

function createDocumentRecord(file) {
  const id = makeFingerprint(file);

  return {
    id,
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    addedAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
    currentPage: 1,
    scrollRatio: 0,
    totalPages: null,
    bookmarks: [],
    notes: [],
    structure: [],
    sessions: []
  };
}

function humanFileSize(bytes) {
  if (!bytes) return 'Unknown size';

  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function progressPercent(doc) {
  if (!doc || !doc.totalPages) return null;
  return Math.round((doc.currentPage / doc.totalPages) * 100);
}

function downloadText(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');

  a.href = url;
  a.download = filename;

  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
}

function exportMarkdown(doc) {
  const lines = [];

  lines.push(`# ${doc.name}`);
  lines.push('');
  lines.push(`Current page: ${doc.currentPage}${doc.totalPages ? ` / ${doc.totalPages}` : ''}`);
  lines.push(`Progress: ${progressPercent(doc) ?? 'Unknown'}%`);
  lines.push(`Last opened: ${doc.lastOpenedAt}`);
  lines.push('');

  lines.push('## Manual structure');
  if (!doc.structure?.length) lines.push('No manual structure added yet.');

  [...(doc.structure || [])]
    .sort((a, b) => a.page - b.page)
    .forEach((item) => {
      lines.push(`- Page ${item.page}: ${item.title}`);
    });

  lines.push('');

  lines.push('## Bookmarks');
  if (!doc.bookmarks?.length) lines.push('No bookmarks yet.');

  [...(doc.bookmarks || [])]
    .sort((a, b) => a.page - b.page)
    .forEach((item) => {
      lines.push(`### Page ${item.page}`);
      lines.push(item.label || 'No label');
      lines.push(`Added: ${item.createdAt}`);
      lines.push('');
    });

  lines.push('## Notes');
  if (!doc.notes?.length) lines.push('No notes yet.');

  [...(doc.notes || [])]
    .sort((a, b) => a.page - b.page)
    .forEach((note) => {
      lines.push(`### Page ${note.page}`);
      lines.push(note.text);
      lines.push('');
      lines.push(`Added: ${note.createdAt}`);
      lines.push('');
    });

  lines.push('## Reading trail');
  if (!doc.sessions?.length) lines.push('No sessions yet.');

  [...(doc.sessions || [])]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .forEach((session) => {
      lines.push(`- ${session.date}: pages ${session.startPage}–${session.endPage}, ${session.pagesRead} pages logged`);
    });

  return lines.join('\n');
}

function App() {
  const [library, setLibrary] = useState(loadLibrary);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pdfBytes, setPdfBytes] = useState(null);
  const [fileUrl, setFileUrl] = useState(null);
  const [currentId, setCurrentId] = useState(null);
  const [pageInput, setPageInput] = useState('1');
  const [activeTab, setActiveTab] = useState('notes');
  const [noteDraft, setNoteDraft] = useState('');
  const [bookmarkDraft, setBookmarkDraft] = useState('');
  const [structureDraft, setStructureDraft] = useState('');
  const [noteSearch, setNoteSearch] = useState('');
  const [status, setStatus] = useState('Open a PDF to begin.');
  const [sessionStart, setSessionStart] = useState(null);
  const [isLoadingPdf, setIsLoadingPdf] = useState(false);

  const fileInputRef = useRef(null);
  const importInputRef = useRef(null);
  const noteBoxRef = useRef(null);

  const currentDoc = currentId ? library.documents[currentId] : null;

  useEffect(() => {
    saveLibrary(library);
  }, [library]);

  useEffect(() => {
    return () => {
      if (fileUrl) {
        URL.revokeObjectURL(fileUrl);
      }
    };
  }, [fileUrl]);

  const patchLibrary = useCallback((updater) => {
    setLibrary((prev) => updater(prev));
  }, []);

  const patchCurrentDoc = useCallback((mutator) => {
    if (!currentId) return;

    patchLibrary((prev) => {
      const existing = prev.documents[currentId];
      if (!existing) return prev;

      const updated = { ...existing };
      mutator(updated);

      return {
        ...prev,
        documents: {
          ...prev.documents,
          [currentId]: updated
        }
      };
    });
  }, [currentId, patchLibrary]);

  async function openPdfFile(file) {
    if (!file) return;

    setIsLoadingPdf(true);
    setStatus('Loading PDF...');

    try {
      const bytes = await file.arrayBuffer();

      if (fileUrl) {
        URL.revokeObjectURL(fileUrl);
      }

      const nextFileUrl = URL.createObjectURL(file);
      setFileUrl(nextFileUrl);

      const loadingTask = pdfjsLib.getDocument({
        data: bytes.slice(0),
        wasmUrl: `${PDFJS_ASSET_BASE}wasm/`,
        useWorkerFetch: true,
        isEvalSupported: false
      });

      const loadedPdf = await loadingTask.promise;
      const id = makeFingerprint(file);

      const existingCurrentPage = library.documents[id]?.currentPage || 1;

      setPdfBytes(bytes);
      setPdfDoc(loadedPdf);
      setCurrentId(id);
      setPageInput(String(existingCurrentPage));

      patchLibrary((prev) => {
        const existing = prev.documents[id] || createDocumentRecord(file);

        const updated = {
          ...existing,
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          lastOpenedAt: new Date().toISOString(),
          totalPages: loadedPdf.numPages,
          currentPage: normalizePage(existing.currentPage || 1, loadedPdf.numPages)
        };

        return {
          ...prev,
          documents: {
            ...prev.documents,
            [id]: updated
          },
          recent: [id, ...prev.recent.filter((item) => item !== id)].slice(0, 30)
        };
      });

      setSessionStart({
        docId: id,
        startPage: existingCurrentPage,
        openedAt: Date.now()
      });

      setStatus(`Loaded ${file.name}`);
    } catch (error) {
      console.error(error);
      setStatus('Could not open this PDF. It may be encrypted, damaged, or unsupported.');
    } finally {
      setIsLoadingPdf(false);
    }
  }

  function selectRecentDocument(id) {
    setCurrentId(id);
    setPdfDoc(null);
    setPdfBytes(null);
    setFileUrl(null);
    setStatus('Reading data loaded. Reopen the local PDF file to display pages.');
  }

  function updatePage(value) {
    if (!currentDoc) return;

    const page = normalizePage(value, currentDoc.totalPages || pdfDoc?.numPages);
    setPageInput(String(page));

    patchCurrentDoc((doc) => {
      doc.currentPage = page;
      doc.lastOpenedAt = new Date().toISOString();
    });
  }

  function setZoom(value) {
    patchLibrary((prev) => ({
      ...prev,
      settings: {
        ...prev.settings,
        zoom: clamp(Number(value), 0.5, 3),
        fitWidth: false
      }
    }));
  }

  function setFitWidth(value) {
    patchLibrary((prev) => ({
      ...prev,
      settings: {
        ...prev.settings,
        fitWidth: value
      }
    }));
  }

  function setDisplayMode(value) {
    patchLibrary((prev) => ({
      ...prev,
      settings: {
        ...prev.settings,
        displayMode: value
      }
    }));
  }

  function toggleSetting(key) {
    patchLibrary((prev) => ({
      ...prev,
      settings: {
        ...prev.settings,
        [key]: !prev.settings[key]
      }
    }));
  }

  function cycleTheme() {
    patchLibrary((prev) => {
      const nextTheme = prev.settings.theme === 'sepia'
        ? 'dark'
        : prev.settings.theme === 'dark'
          ? 'light'
          : 'sepia';

      return {
        ...prev,
        settings: {
          ...prev.settings,
          theme: nextTheme
        }
      };
    });
  }

  function addBookmark() {
    if (!currentDoc) return;

    patchCurrentDoc((doc) => {
      doc.bookmarks = [
        {
          id: uid(),
          page: doc.currentPage,
          label: bookmarkDraft.trim(),
          createdAt: new Date().toISOString()
        },
        ...(doc.bookmarks || [])
      ];
    });

    setBookmarkDraft('');
  }

  function addNote() {
    if (!currentDoc || !noteDraft.trim()) return;

    patchCurrentDoc((doc) => {
      doc.notes = [
        {
          id: uid(),
          page: doc.currentPage,
          text: noteDraft.trim(),
          createdAt: new Date().toISOString()
        },
        ...(doc.notes || [])
      ];
    });

    setNoteDraft('');
  }

  function addStructureItem() {
    if (!currentDoc || !structureDraft.trim()) return;

    patchCurrentDoc((doc) => {
      doc.structure = [
        ...(doc.structure || []),
        {
          id: uid(),
          page: doc.currentPage,
          title: structureDraft.trim(),
          createdAt: new Date().toISOString()
        }
      ].sort((a, b) => a.page - b.page);
    });

    setStructureDraft('');
  }

  function deleteFrom(collection, id) {
    patchCurrentDoc((doc) => {
      doc[collection] = (doc[collection] || []).filter((item) => item.id !== id);
    });
  }

  function saveSession() {
    if (!currentDoc || !sessionStart) return;

    const startPage = sessionStart.docId === currentDoc.id
      ? sessionStart.startPage
      : currentDoc.currentPage;

    const endPage = currentDoc.currentPage;
    const pagesRead = Math.max(0, Math.abs(endPage - startPage) + 1);

    patchCurrentDoc((doc) => {
      doc.sessions = [
        {
          id: uid(),
          date: todayKey(),
          startedAt: new Date(sessionStart.openedAt).toISOString(),
          endedAt: new Date().toISOString(),
          startPage,
          endPage,
          pagesRead
        },
        ...(doc.sessions || [])
      ];
    });

    setSessionStart({
      docId: currentDoc.id,
      startPage: currentDoc.currentPage,
      openedAt: Date.now()
    });

    setStatus('Reading session saved.');
  }

  function exportLibraryJson() {
    downloadText('pagetrail-library.json', JSON.stringify(library, null, 2), 'application/json');
  }

  function exportCurrentMarkdown() {
    if (!currentDoc) return;

    const safeName = currentDoc.name
      .replace(/[^a-z0-9\-_]+/gi, '_')
      .slice(0, 80);

    downloadText(`${safeName}_notes.md`, exportMarkdown(currentDoc), 'text/markdown');
  }

  function importLibrary(file) {
    if (!file) return;

    const reader = new FileReader();

    reader.onload = () => {
      try {
        const imported = JSON.parse(String(reader.result));

        if (!imported.documents || !imported.recent) {
          throw new Error('Invalid file');
        }

        setLibrary({
          ...defaultLibrary,
          ...imported,
          settings: {
            ...defaultLibrary.settings,
            ...(imported.settings || {})
          }
        });

        setStatus('Imported PageTrail library.');
      } catch {
        setStatus('This does not look like a valid PageTrail export.');
      }
    };

    reader.readAsText(file);
  }

  useEffect(() => {
    function onKeyDown(event) {
      const tagName = document.activeElement?.tagName?.toLowerCase();
      const typing = ['input', 'textarea'].includes(tagName);

      if (typing) return;

      if (event.key === 'ArrowRight') updatePage((currentDoc?.currentPage || 1) + 1);
      if (event.key === 'ArrowLeft') updatePage((currentDoc?.currentPage || 1) - 1);
      if (event.key.toLowerCase() === 'b') addBookmark();
      if (event.key.toLowerCase() === 'f') toggleSetting('focusMode');
      if (event.key.toLowerCase() === 's') saveSession();
      if (event.key.toLowerCase() === 'n') noteBoxRef.current?.focus();

      if (event.key === '/') {
        event.preventDefault();
        setActiveTab('notes');
        setTimeout(() => document.querySelector('#note-search')?.focus(), 0);
      }
    }

    window.addEventListener('keydown', onKeyDown);

    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentDoc, currentId, bookmarkDraft, sessionStart]);

  const recentDocs = useMemo(() => {
    return library.recent.map((id) => library.documents[id]).filter(Boolean);
  }, [library]);

  const filteredNotes = useMemo(() => {
    const notes = currentDoc?.notes || [];
    const q = noteSearch.trim().toLowerCase();

    if (!q) return notes;

    return notes.filter((note) => {
      return note.text.toLowerCase().includes(q) || String(note.page).includes(q);
    });
  }, [currentDoc, noteSearch]);

  const appClass = `app theme-${library.settings.theme} ${library.settings.focusMode ? 'is-focus' : ''}`;

  return (
    <div className={appClass}>
      <header className="topbar">
        <div
          className="brand"
          onClick={() => setCurrentId(null)}
          role="button"
          tabIndex="0"
        >
          <div className="brand-mark">PT</div>
          <div>
            <div className="brand-title">PageTrail</div>
            <div className="brand-subtitle">No summaries. Just reading.</div>
          </div>
        </div>

        <div className="top-actions">
          <button className="button primary" onClick={() => fileInputRef.current?.click()}>
            Open PDF
          </button>
          <button className="button" onClick={cycleTheme}>
            Theme
          </button>
          <button className="button" onClick={() => toggleSetting('focusMode')}>
            Focus
          </button>
          <button className="button" onClick={() => toggleSetting('sidePanel')}>
            Panel
          </button>
          <button className="button" onClick={() => importInputRef.current?.click()}>
            Import
          </button>
          <button className="button" onClick={exportLibraryJson}>
            Export
          </button>
        </div>
      </header>

      <input
        ref={fileInputRef}
        className="hidden"
        type="file"
        accept="application/pdf,.pdf"
        onChange={(event) => openPdfFile(event.target.files?.[0])}
      />

      <input
        ref={importInputRef}
        className="hidden"
        type="file"
        accept="application/json,.json"
        onChange={(event) => importLibrary(event.target.files?.[0])}
      />

      {!currentDoc ? (
        <LibraryScreen
          docs={recentDocs}
          onOpen={() => fileInputRef.current?.click()}
          onSelect={selectRecentDocument}
          status={status}
        />
      ) : (
        <div className={`reader-shell ${library.settings.sidePanel && !library.settings.focusMode ? 'with-panel' : 'no-panel'}`}>
          <main className="reader-main">
            {!library.settings.focusMode && (
              <ReaderToolbar
                doc={currentDoc}
                pageInput={pageInput}
                setPageInput={setPageInput}
                updatePage={updatePage}
                zoom={library.settings.zoom}
                setZoom={setZoom}
                fitWidth={library.settings.fitWidth}
                setFitWidth={setFitWidth}
                displayMode={library.settings.displayMode}
                setDisplayMode={setDisplayMode}
                onBack={() => setCurrentId(null)}
                onSaveSession={saveSession}
                onExportMarkdown={exportCurrentMarkdown}
                status={status}
                isLoadingPdf={isLoadingPdf}
              />
            )}

            <PdfReader
              pdfDoc={pdfDoc}
              pdfBytes={pdfBytes}
              fileUrl={fileUrl}
              displayMode={library.settings.displayMode}
              doc={currentDoc}
              zoom={library.settings.zoom}
              fitWidth={library.settings.fitWidth}
              updatePage={updatePage}
              patchCurrentDoc={patchCurrentDoc}
              requestFileOpen={() => fileInputRef.current?.click()}
            />
          </main>

          {library.settings.sidePanel && !library.settings.focusMode && (
            <SidePanel
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              doc={currentDoc}
              noteDraft={noteDraft}
              setNoteDraft={setNoteDraft}
              noteBoxRef={noteBoxRef}
              addNote={addNote}
              bookmarkDraft={bookmarkDraft}
              setBookmarkDraft={setBookmarkDraft}
              addBookmark={addBookmark}
              structureDraft={structureDraft}
              setStructureDraft={setStructureDraft}
              addStructureItem={addStructureItem}
              deleteFrom={deleteFrom}
              updatePage={updatePage}
              noteSearch={noteSearch}
              setNoteSearch={setNoteSearch}
              filteredNotes={filteredNotes}
            />
          )}
        </div>
      )}
    </div>
  );
}

function LibraryScreen({ docs, onOpen, onSelect, status }) {
  return (
    <main className="library-screen">
      <section className="hero-card">
        <div className="pill">Local-first PDF reading desk</div>
        <h1>Read long PDFs without losing the thread.</h1>
        <p>
          Open a local PDF, continue exactly where you stopped, build your own chapter map,
          keep notes, and preserve a reading trail.
        </p>
        <div className="hero-actions">
          <button className="button primary big" onClick={onOpen}>
            Open PDF
          </button>
          <span className="muted">Files stay in your browser. Nothing is uploaded.</span>
        </div>
      </section>

      <section className="library-card">
        <div className="section-heading">
          <h2>Recent files</h2>
          <span>{status}</span>
        </div>

        {docs.length === 0 ? (
          <div className="empty-box">
            Your reading library will appear here after you open a PDF.
          </div>
        ) : (
          <div className="doc-list">
            {docs.map((doc) => (
              <button className="doc-row" key={doc.id} onClick={() => onSelect(doc.id)}>
                <div className="doc-name">{doc.name}</div>
                <div className="doc-meta">
                  Page {doc.currentPage}{doc.totalPages ? ` / ${doc.totalPages}` : ''}
                  {progressPercent(doc) !== null ? ` · ${progressPercent(doc)}%` : ''} · {humanFileSize(doc.size)}
                </div>

                {progressPercent(doc) !== null && (
                  <div className="progress-track">
                    <div
                      className="progress-fill"
                      style={{ width: `${progressPercent(doc)}%` }}
                    />
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function ReaderToolbar({
  doc,
  pageInput,
  setPageInput,
  updatePage,
  zoom,
  setZoom,
  fitWidth,
  setFitWidth,
  displayMode,
  setDisplayMode,
  onBack,
  onSaveSession,
  onExportMarkdown,
  status,
  isLoadingPdf
}) {
  return (
    <div className="reader-toolbar">
      <div className="toolbar-top">
        <div className="title-block">
          <button className="link-button" onClick={onBack}>
            ← Library
          </button>
          <h1>{doc.name}</h1>
          <div className="doc-meta">
            Page {doc.currentPage}{doc.totalPages ? ` of ${doc.totalPages}` : ''}
            {progressPercent(doc) !== null ? ` · ${progressPercent(doc)}% complete` : ''}
            {isLoadingPdf ? ' · Loading...' : ''}
          </div>
        </div>

        <div className="toolbar-actions">
          <label className="field compact">
            <span>Page</span>
            <input
              value={pageInput}
              onChange={(event) => setPageInput(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && updatePage(pageInput)}
            />
          </label>

          <button className="button" onClick={() => updatePage(pageInput)}>
            Go
          </button>
          <button className="button" onClick={() => updatePage(doc.currentPage - 1)}>
            Prev
          </button>
          <button className="button" onClick={() => updatePage(doc.currentPage + 1)}>
            Next
          </button>
          <button className="button" onClick={onSaveSession}>
            Save session
          </button>
          <button className="button" onClick={onExportMarkdown}>
            Notes MD
          </button>
        </div>
      </div>

      <div className="toolbar-bottom">
        <div className="progress-track wide">
          <div
            className="progress-fill"
            style={{ width: `${progressPercent(doc) || 0}%` }}
          />
        </div>

        <div className="display-mode-controls">
          <button
            className={`button small ${displayMode === 'pdfjs' ? 'active' : ''}`}
            onClick={() => setDisplayMode('pdfjs')}
          >
            PDF.js
          </button>

          <button
            className={`button small ${displayMode === 'browser' ? 'active' : ''}`}
            onClick={() => setDisplayMode('browser')}
          >
            Browser
          </button>
        </div>

        <div className="zoom-controls">
          <button
            className={`button small ${fitWidth ? 'active' : ''}`}
            onClick={() => setFitWidth(!fitWidth)}
            disabled={displayMode === 'browser'}
            title={displayMode === 'browser' ? 'Zoom is controlled by the browser PDF viewer in Browser Mode.' : ''}
          >
            Fit width
          </button>

          <button
            className="button small"
            onClick={() => setZoom(zoom - 0.1)}
            disabled={displayMode === 'browser'}
          >
            -
          </button>

          <span className="zoom-label">{Math.round(zoom * 100)}%</span>

          <button
            className="button small"
            onClick={() => setZoom(zoom + 0.1)}
            disabled={displayMode === 'browser'}
          >
            +
          </button>
        </div>

        <div className="status-line">{status}</div>
      </div>
    </div>
  );
}

function PdfReader({
  pdfDoc,
  fileUrl,
  displayMode,
  doc,
  zoom,
  fitWidth,
  updatePage,
  patchCurrentDoc,
  requestFileOpen
}) {
  const viewportRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(900);

  useEffect(() => {
    if (!viewportRef.current) return;

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width;
      if (width) setContainerWidth(Math.max(320, width - 60));
    });

    observer.observe(viewportRef.current);

    return () => observer.disconnect();
  }, []);

  if (displayMode === 'browser') {
    return (
      <BrowserPdfReader
        fileUrl={fileUrl}
        doc={doc}
        updatePage={updatePage}
        patchCurrentDoc={patchCurrentDoc}
        requestFileOpen={requestFileOpen}
      />
    );
  }

  if (!pdfDoc) {
    return (
      <div className="pdf-empty">
        <h2>Reopen the PDF file to display pages.</h2>
        <p>
          Your progress, notes, bookmarks and reading trail are still saved locally.
          Browsers do not allow web apps to permanently keep access to local files
          without you choosing the file again.
        </p>
        <button className="button primary big" onClick={requestFileOpen}>
          Reopen PDF
        </button>
      </div>
    );
  }

  const totalPages = pdfDoc.numPages;
  const currentPage = normalizePage(doc.currentPage || 1, totalPages);

  function jumpToPage(pageNumber) {
    const normalizedPage = normalizePage(pageNumber, totalPages);

    updatePage(normalizedPage);

    patchCurrentDoc((draft) => {
      draft.currentPage = normalizedPage;
      draft.lastOpenedAt = new Date().toISOString();
    });

    if (viewportRef.current) {
      viewportRef.current.scrollTo({
        top: 0,
        behavior: 'auto'
      });
    }
  }

  return (
    <div className="pdf-viewport" ref={viewportRef}>
      <div className="pdf-window-reader">
        <div className="page-navigation-strip">
          <button
            className="button"
            disabled={currentPage <= 1}
            onClick={() => jumpToPage(1)}
          >
            First
          </button>

          <button
            className="button"
            disabled={currentPage <= 1}
            onClick={() => jumpToPage(currentPage - 1)}
          >
            Previous page
          </button>

          <div className="page-position">
            Page {currentPage} of {totalPages}
          </div>

          <button
            className="button"
            disabled={currentPage >= totalPages}
            onClick={() => jumpToPage(currentPage + 1)}
          >
            Next page
          </button>

          <button
            className="button"
            disabled={currentPage >= totalPages}
            onClick={() => jumpToPage(totalPages)}
          >
            Last
          </button>
        </div>

        <div className="single-page-stage">
          <PdfPage
            key={`${currentPage}-${zoom}-${fitWidth}-${containerWidth}`}
            pdfDoc={pdfDoc}
            pageNumber={currentPage}
            zoom={zoom}
            fitWidth={fitWidth}
            containerWidth={containerWidth}
            isCurrent={true}
            onJump={() => jumpToPage(currentPage)}
          />
        </div>
      </div>
    </div>
  );
}

function BrowserPdfReader({
  fileUrl,
  doc,
  updatePage,
  patchCurrentDoc,
  requestFileOpen
}) {
  const totalPages = doc.totalPages || 1;
  const currentPage = normalizePage(doc.currentPage || 1, totalPages);

  function jumpToPage(pageNumber) {
    const normalizedPage = normalizePage(pageNumber, totalPages);

    updatePage(normalizedPage);

    patchCurrentDoc((draft) => {
      draft.currentPage = normalizedPage;
      draft.lastOpenedAt = new Date().toISOString();
    });
  }

  if (!fileUrl) {
    return (
      <div className="pdf-empty">
        <h2>Reopen the PDF file to use Browser Mode.</h2>
        <p>
          Browser Mode uses your browser’s native PDF renderer. This is often better
          for scanned books and image-heavy PDFs, but the browser still requires you
          to choose the local file again.
        </p>
        <button className="button primary big" onClick={requestFileOpen}>
          Reopen PDF
        </button>
      </div>
    );
  }

  const browserPdfSrc = `${fileUrl}#page=${currentPage}&view=FitH`;

  return (
    <div className="browser-reader">
      <div className="page-navigation-strip">
        <button
          className="button"
          disabled={currentPage <= 1}
          onClick={() => jumpToPage(1)}
        >
          First
        </button>

        <button
          className="button"
          disabled={currentPage <= 1}
          onClick={() => jumpToPage(currentPage - 1)}
        >
          Previous page
        </button>

        <div className="page-position">
          Page {currentPage} of {totalPages}
        </div>

        <button
          className="button"
          disabled={currentPage >= totalPages}
          onClick={() => jumpToPage(currentPage + 1)}
        >
          Next page
        </button>

        <button
          className="button"
          disabled={currentPage >= totalPages}
          onClick={() => jumpToPage(totalPages)}
        >
          Last
        </button>
      </div>

      <div className="browser-frame-shell">
        <iframe
          key={browserPdfSrc}
          title={`Browser PDF viewer page ${currentPage}`}
          className="browser-pdf-frame"
          src={browserPdfSrc}
        />
      </div>
    </div>
  );
}

function PdfPage({
  pdfDoc,
  pageNumber,
  zoom,
  fitWidth,
  containerWidth,
  isCurrent,
  onJump
}) {
  const canvasRef = useRef(null);
  const textLayerRef = useRef(null);
  const renderTaskRef = useRef(null);

  const [pageSize, setPageSize] = useState({
    width: 800,
    height: 1100
  });

  const [renderStatus, setRenderStatus] = useState('loading');

  useEffect(() => {
    let cancelled = false;

    async function renderPage() {
      setRenderStatus('loading');

      try {
        const page = await pdfDoc.getPage(pageNumber);

        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1 });

        const scale = fitWidth
          ? Math.max(0.5, Math.min(2.5, containerWidth / baseViewport.width))
          : zoom;

        const viewport = page.getViewport({ scale });

        setPageSize({
          width: Math.floor(viewport.width),
          height: Math.floor(viewport.height)
        });

        await new Promise((resolve) => window.requestAnimationFrame(resolve));

        if (cancelled) return;

        const canvas = canvasRef.current;
        const textLayer = textLayerRef.current;

        if (!canvas) {
          setRenderStatus('error');
          return;
        }

        const context = canvas.getContext('2d', {
          alpha: false
        });

        const outputScale = window.devicePixelRatio || 1;

        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, viewport.width, viewport.height);

        if (renderTaskRef.current) {
          try {
            renderTaskRef.current.cancel();
          } catch {
            // Ignore cancelled render task.
          }
        }

        const renderTask = page.render({
          canvasContext: context,
          viewport
        });

        renderTaskRef.current = renderTask;

        await renderTask.promise;

        if (cancelled) return;

        if (textLayer) {
          textLayer.innerHTML = '';
          textLayer.style.width = `${Math.floor(viewport.width)}px`;
          textLayer.style.height = `${Math.floor(viewport.height)}px`;

          try {
            const textContent = await page.getTextContent();

            if (!cancelled && pdfjsLib.TextLayer) {
              const layer = new pdfjsLib.TextLayer({
                textContentSource: textContent,
                container: textLayer,
                viewport
              });

              await layer.render();
            }
          } catch (textError) {
            console.warn(`Text layer failed on page ${pageNumber}`, textError);
          }
        }

        if (!cancelled) {
          setRenderStatus('ready');
        }
      } catch (error) {
        if (error?.name !== 'RenderingCancelledException') {
          console.error(`Could not render page ${pageNumber}`, error);
          setRenderStatus('error');
        }
      }
    }

    renderPage();

    return () => {
      cancelled = true;

      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {
          // Ignore cancelled render task.
        }
      }
    };
  }, [pdfDoc, pageNumber, zoom, fitWidth, containerWidth]);

  return (
    <section
      className={`pdf-page-wrap ${isCurrent ? 'current-page' : ''}`}
      data-page-number={pageNumber}
    >
      <div className="page-label" onClick={onJump}>
        Page {pageNumber}
      </div>

      <div
        className="pdf-page"
        style={{
          width: `${pageSize.width}px`,
          height: `${pageSize.height}px`
        }}
      >
        {renderStatus === 'loading' && (
          <div className="page-loading">
            Rendering page {pageNumber}...
          </div>
        )}

        {renderStatus === 'error' && (
          <div className="page-loading error">
            Could not render page {pageNumber}. Open the browser console for details.
          </div>
        )}

        <canvas ref={canvasRef} className="pdf-canvas" />
        <div ref={textLayerRef} className="textLayer pdf-text-layer" />
      </div>
    </section>
  );
}

function SidePanel(props) {
  const tabs = [
    ['notes', 'Notes'],
    ['bookmarks', 'Bookmarks'],
    ['structure', 'Structure'],
    ['trail', 'Trail']
  ];

  return (
    <aside className="side-panel">
      <div className="tabs">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            className={props.activeTab === id ? 'active' : ''}
            onClick={() => props.setActiveTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="panel-body">
        {props.activeTab === 'notes' && <NotesTab {...props} />}
        {props.activeTab === 'bookmarks' && <BookmarksTab {...props} />}
        {props.activeTab === 'structure' && <StructureTab {...props} />}
        {props.activeTab === 'trail' && <TrailTab {...props} />}
      </div>
    </aside>
  );
}

function NotesTab({
  doc,
  noteDraft,
  setNoteDraft,
  noteBoxRef,
  addNote,
  noteSearch,
  setNoteSearch,
  filteredNotes,
  deleteFrom,
  updatePage
}) {
  return (
    <div className="panel-section">
      <h2>Notes</h2>
      <p className="muted">Attach your own thinking to page {doc.currentPage}.</p>

      <textarea
        ref={noteBoxRef}
        value={noteDraft}
        onChange={(event) => setNoteDraft(event.target.value)}
        placeholder="Write a note for this page..."
      />

      <button className="button primary full" onClick={addNote}>
        Add note
      </button>

      <input
        id="note-search"
        className="search-input"
        value={noteSearch}
        onChange={(event) => setNoteSearch(event.target.value)}
        placeholder="Search notes..."
      />

      <div className="item-list">
        {filteredNotes.length === 0 ? (
          <Empty text="No notes yet." />
        ) : (
          filteredNotes.map((note) => (
            <Item
              key={note.id}
              page={note.page}
              onGo={() => updatePage(note.page)}
              onDelete={() => deleteFrom('notes', note.id)}
            >
              <p className="note-text">{note.text}</p>
              <small>{formatDate(note.createdAt)} · {formatTime(note.createdAt)}</small>
            </Item>
          ))
        )}
      </div>
    </div>
  );
}

function BookmarksTab({
  doc,
  bookmarkDraft,
  setBookmarkDraft,
  addBookmark,
  deleteFrom,
  updatePage
}) {
  return (
    <div className="panel-section">
      <h2>Bookmarks</h2>
      <p className="muted">Mark structural or important places.</p>

      <input
        value={bookmarkDraft}
        onChange={(event) => setBookmarkDraft(event.target.value)}
        placeholder="Optional label for current page..."
      />

      <button className="button primary full" onClick={addBookmark}>
        Bookmark page {doc.currentPage}
      </button>

      <div className="item-list">
        {(doc.bookmarks || []).length === 0 ? (
          <Empty text="No bookmarks yet." />
        ) : (
          (doc.bookmarks || []).map((bookmark) => (
            <Item
              key={bookmark.id}
              page={bookmark.page}
              onGo={() => updatePage(bookmark.page)}
              onDelete={() => deleteFrom('bookmarks', bookmark.id)}
            >
              <p>{bookmark.label || 'No label'}</p>
              <small>{formatDate(bookmark.createdAt)} · {formatTime(bookmark.createdAt)}</small>
            </Item>
          ))
        )}
      </div>
    </div>
  );
}

function StructureTab({
  doc,
  structureDraft,
  setStructureDraft,
  addStructureItem,
  deleteFrom,
  updatePage
}) {
  return (
    <div className="panel-section">
      <h2>Manual structure</h2>
      <p className="muted">Build your own table of contents when the PDF has none.</p>

      <input
        value={structureDraft}
        onChange={(event) => setStructureDraft(event.target.value)}
        placeholder="Chapter / section title..."
      />

      <button className="button primary full" onClick={addStructureItem}>
        Add page {doc.currentPage}
      </button>

      <div className="item-list">
        {(doc.structure || []).length === 0 ? (
          <Empty text="No manual structure yet." />
        ) : (
          (doc.structure || []).map((item) => (
            <Item
              key={item.id}
              page={item.page}
              onGo={() => updatePage(item.page)}
              onDelete={() => deleteFrom('structure', item.id)}
            >
              <p>{item.title}</p>
              <small>{formatDate(item.createdAt)} · {formatTime(item.createdAt)}</small>
            </Item>
          ))
        )}
      </div>
    </div>
  );
}

function TrailTab({ doc }) {
  return (
    <div className="panel-section">
      <h2>Reading trail</h2>
      <p className="muted">A log of your actual reading sessions.</p>

      <div className="item-list">
        {(doc.sessions || []).length === 0 ? (
          <Empty text="No sessions saved yet. Use Save session when you stop reading." />
        ) : (
          (doc.sessions || []).map((session) => (
            <div className="item-card" key={session.id}>
              <strong>{formatDate(session.startedAt)}</strong>
              <p>Read pages {session.startPage}–{session.endPage}</p>
              <small>
                {formatTime(session.startedAt)}–{formatTime(session.endedAt)} · {session.pagesRead} page{session.pagesRead === 1 ? '' : 's'} logged
              </small>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Item({ page, onGo, onDelete, children }) {
  return (
    <div className="item-card">
      <div className="item-actions">
        <button className="page-chip" onClick={onGo}>
          Page {page}
        </button>
        <button className="delete-button" onClick={onDelete}>
          Delete
        </button>
      </div>

      {children}
    </div>
  );
}

function Empty({ text }) {
  return <div className="empty-box small">{text}</div>;
}

createRoot(document.getElementById('root')).render(<App />);