/** @jsxImportSource preact */
import { useState, useEffect, useRef } from "preact/hooks";
import {
  threads,
  activeId,
  getCustomCommand,
  setCustomCommand,
  clearCustomCommand,
  runCustomCommand,
} from "../state";

export function CustomCommand() {
  const thread = activeId.value ? threads.value.get(activeId.value) : null;
  const folderPath = thread?.folderPath;

  const [cmd, setCmd] = useState<{ label: string; command: string } | null>(
    null,
  );
  const [editing, setEditing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [editLabel, setEditLabel] = useState("");
  const [editCommand, setEditCommand] = useState("");

  const popoverRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLoaded(false);
    setEditing(false);
    if (!folderPath) return;
    getCustomCommand(folderPath).then((result) => {
      setCmd(result);
      setLoaded(true);
    });
  }, [folderPath]);

  useEffect(() => {
    if (!editing) return;
    const onClick = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        setEditing(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [editing]);

  useEffect(() => {
    if (editing && labelRef.current) {
      labelRef.current.focus();
    }
  }, [editing]);

  if (!folderPath || !loaded) return null;

  function openEditor() {
    setEditLabel(cmd?.label || "");
    setEditCommand(cmd?.command || "");
    setEditing(true);
  }

  async function save() {
    const label = editLabel.trim();
    const command = editCommand.trim();
    if (!folderPath) return;
    if (!label || !command) {
      await clearCustomCommand(folderPath);
      setCmd(null);
    } else {
      await setCustomCommand(folderPath, label, command);
      setCmd({ label, command });
    }
    setEditing(false);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    }
    if (e.key === "Escape") {
      setEditing(false);
    }
  }

  return (
    <div class="custom-cmd" ref={popoverRef}>
      {cmd ? (
        <div class="custom-cmd-buttons">
          <button
            class="toolbar-btn custom-cmd-run"
            title={cmd.command}
            onClick={() => runCustomCommand(cmd.command)}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="currentColor"
              stroke="none"
            >
              <path d="M5 3l14 9-14 9V3z" />
            </svg>
            {cmd.label}
          </button>
          <button
            class="toolbar-btn custom-cmd-edit"
            title="Edit command"
            onClick={openEditor}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
        </div>
      ) : (
        <button
          class="toolbar-btn custom-cmd-add"
          title="Add quick command for this project"
          onClick={openEditor}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Quick cmd
        </button>
      )}

      {editing && (
        <div class="custom-cmd-popover">
          <div class="custom-cmd-field">
            <label>Label</label>
            <input
              ref={labelRef}
              type="text"
              placeholder="e.g. Ship"
              value={editLabel}
              onInput={(e) =>
                setEditLabel((e.target as HTMLInputElement).value)
              }
              onKeyDown={handleKeyDown}
            />
          </div>
          <div class="custom-cmd-field">
            <label>Command</label>
            <input
              type="text"
              placeholder="e.g. /commit push and tag"
              value={editCommand}
              onInput={(e) =>
                setEditCommand((e.target as HTMLInputElement).value)
              }
              onKeyDown={handleKeyDown}
            />
          </div>
          <div class="custom-cmd-actions">
            {cmd && (
              <button
                class="custom-cmd-delete"
                onClick={async () => {
                  if (folderPath) {
                    await clearCustomCommand(folderPath);
                    setCmd(null);
                    setEditing(false);
                  }
                }}
              >
                Remove
              </button>
            )}
            <button class="custom-cmd-save" onClick={save}>
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
