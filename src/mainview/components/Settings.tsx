/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
import {
  settingsOpen,
  threads,
  getAppInfo,
  getSettings,
  setSettings,
  closeTerminal,
  showToast,
} from "../state";

export function Settings() {
  const isOpen = settingsOpen.value;
  const [version, setVersion] = useState("-");
  const [useWorktree, setUseWorktree] = useState(false);
  const terminalCount = threads.value.size;

  useEffect(() => {
    if (!isOpen) return;
    Promise.all([getAppInfo(), getSettings()]).then(([info, settings]) => {
      setVersion(info.version);
      setUseWorktree(settings.useWorktree);
    });
  }, [isOpen]);

  return (
    <div class={`settings-panel${isOpen ? " open" : ""}`}>
      <div class="settings-header">
        <button
          class="settings-back-btn"
          onClick={() => (settingsOpen.value = false)}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
        </button>
        <span class="settings-title">Settings</span>
      </div>
      <div class="settings-body">
        <div class="settings-hero">
          <div class="settings-app-icon">
            <svg
              width="32"
              height="32"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
            </svg>
          </div>
          <div class="settings-app-name">Chat</div>
          <div class="settings-app-version">{version}</div>
        </div>

        <div class="settings-card">
          <div class="settings-section-title">Session</div>
          <div class="settings-row">
            <span class="settings-row-label">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
              </svg>
              Open projects
            </span>
            <span class="settings-row-badge">{terminalCount}</span>
          </div>
          <div class="settings-row">
            <span class="settings-row-label">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
              Runtime
            </span>
            <span class="settings-row-value">Electrobun</span>
          </div>
          <div class="settings-row settings-row-last">
            <span class="settings-row-label">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                <polyline points="9 22 9 12 15 12 15 22" />
              </svg>
              Config
            </span>
            <span class="settings-row-value settings-row-mono">
              ~/.config/chat-app/
            </span>
          </div>
        </div>

        <div class="settings-card">
          <div class="settings-section-title">Preferences</div>
          <div class="settings-row settings-row-last">
            <span class="settings-row-label">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M6 3v12" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 01-9 9" />
              </svg>
              Use worktree
            </span>
            <label class="settings-toggle">
              <input
                type="checkbox"
                checked={useWorktree}
                onChange={(e) => {
                  const checked = (e.target as HTMLInputElement).checked;
                  setUseWorktree(checked);
                  setSettings({ useWorktree: checked });
                }}
              />
              <span class="settings-toggle-slider" />
            </label>
          </div>
        </div>

        <div class="settings-card">
          <div class="settings-section-title">Actions</div>
          <button
            class="settings-action-btn"
            onClick={() => {
              if (threads.value.size === 0) return;
              if (confirm(`Close all ${threads.value.size} open projects?`)) {
                for (const id of [...threads.value.keys()]) {
                  closeTerminal(id);
                }
                showToast("Settings", "All projects closed", true);
                settingsOpen.value = false;
              }
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
            Close all projects
          </button>
          <button
            class="settings-action-btn settings-action-danger"
            onClick={() => {
              if (
                confirm(
                  "Clear all saved project data? Open sessions will not be affected.",
                )
              ) {
                localStorage.clear();
                showToast("Settings", "Local data cleared", true);
              }
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
            </svg>
            Clear saved data
          </button>
        </div>

        <div class="settings-footer">Built with Electrobun + xterm.js</div>
      </div>
    </div>
  );
}
