/** @jsxImportSource preact */
import { useEffect, useRef, useCallback } from "preact/hooks";
import {
  threads,
  activeId,
  browserUrl,
  openFolderDialog,
  openNewTerminal,
  closeBrowser,
  openExternal,
  shellAction,
  refitActiveTerminal,
} from "../state";
import { Sidebar } from "./Sidebar";
import { Settings } from "./Settings";
import { PromptPopup } from "./PromptPopup";

export function App() {
  const hasTerminals = threads.value.size > 0;

  useEffect(() => {
    const onResize = () => refitActiveTerminal();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "o") {
        e.preventDefault();
        openFolderDialog();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        const active = activeId.value;
        const thread = active ? threads.value.get(active) : undefined;
        if (thread) openNewTerminal(thread.folderPath);
      }
      if (e.key === "Escape" && browserUrl.value) {
        closeBrowser();
      }
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, []);

  return (
    <>
      <Sidebar />
      <div id="main-content">
        {hasTerminals && <Toolbar />}
        <div id="terminal-area">
          {!hasTerminals && !browserUrl.value && (
            <div id="empty-state">
              <p>
                Click <strong>+</strong> to open a project folder
              </p>
            </div>
          )}
          {browserUrl.value && <BrowserOverlay />}
        </div>
      </div>
      <Settings />
      <PromptPopup />
    </>
  );
}

function Toolbar() {
  return (
    <div id="toolbar">
      <div class="toolbar-group">
        <button
          class="toolbar-btn"
          title="Open in VS Code"
          onClick={() => shellAction("vscode")}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M16 3l5 2.5v13L16 21l-11-5.5L16 3z" />
            <path d="M5 15.5L2 17V7l3 1.5" />
            <path d="M16 3L5 9.5v6L16 21" />
          </svg>
          VS Code
        </button>
        <button
          class="toolbar-btn"
          title="Reveal in Finder"
          onClick={() => shellAction("finder")}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          </svg>
          Finder
        </button>
      </div>
      <div class="toolbar-group">
        <button
          class="toolbar-btn"
          title="Git status"
          onClick={() => shellAction("git-status")}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <circle cx="18" cy="18" r="3" />
            <circle cx="6" cy="6" r="3" />
            <path d="M6 21V9a9 9 0 009 9" />
          </svg>
          Status
        </button>
        <button
          class="toolbar-btn"
          title="Git pull"
          onClick={() => shellAction("git-pull")}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
          Pull
        </button>
        <button
          class="toolbar-btn"
          title="Git commit"
          onClick={() => shellAction("git-commit")}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <circle cx="12" cy="12" r="4" />
            <path d="M1.05 12H7m10 0h5.95" />
          </svg>
          Commit
        </button>
        <button
          class="toolbar-btn"
          title="Switch to main/develop and pull"
          onClick={() => shellAction("git-reset")}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" />
          </svg>
          Reset
        </button>
      </div>
    </div>
  );
}

function BrowserOverlay() {
  const url = browserUrl.value!;
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const handleLoad = useCallback(() => {
    try {
      const doc = iframeRef.current?.contentDocument;
      if (doc && doc.body && doc.body.innerHTML === "") {
        openExternal(url);
      }
    } catch {
      // Cross-origin access denied — loaded successfully
    }
  }, [url]);

  return (
    <div id="browser-overlay">
      <div class="browser-toolbar">
        <span class="browser-url">{url}</span>
        <button
          class="browser-close-btn"
          title="Close browser"
          onClick={() => closeBrowser()}
        >
          &#x2715; Close
        </button>
      </div>
      <iframe
        ref={iframeRef}
        src={url}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        onLoad={handleLoad}
      />
    </div>
  );
}
