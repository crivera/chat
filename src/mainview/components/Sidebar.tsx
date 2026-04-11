/** @jsxImportSource preact */
import { useEffect, useRef } from "preact/hooks";
import {
  folderGroups,
  activeId,
  activePrompts,
  collapsedFolders,
  restoring,
  toggleFolderCollapsed,
  selectThread,
  closeTerminal,
  openNewTerminal,
  openFolderDialog,
  settingsOpen,
  type ThreadData,
} from "../state";

export function Sidebar() {
  const groups = folderGroups.value;

  return (
    <aside id="sidebar">
      <div class="sidebar-header">
        <span class="sidebar-title">PROJECTS</span>
        <button
          id="add-project-btn"
          title="Add project"
          onClick={() => openFolderDialog()}
        >
          +
        </button>
      </div>
      <div id="project-list">
        {restoring.value && groups.length === 0 && (
          <div class="sidebar-loading">
            <div class="sidebar-spinner" />
            <span>Restoring projects...</span>
          </div>
        )}
        {groups.map((group) => (
          <FolderGroup
            key={group.folderPath}
            folderPath={group.folderPath}
            name={group.name}
            threads={group.threads}
          />
        ))}
      </div>
      <div class="sidebar-footer">
        <button
          class="settings-label"
          onClick={() => (settingsOpen.value = true)}
        >
          &#x2699; Settings
        </button>
      </div>
    </aside>
  );
}

function FolderGroup({
  folderPath,
  name,
  threads,
}: {
  folderPath: string;
  name: string;
  threads: ThreadData[];
}) {
  const collapsed = collapsedFolders.value.has(folderPath);
  const prevCount = useRef(threads.length);

  useEffect(() => {
    if (threads.length > prevCount.current && collapsed) {
      toggleFolderCollapsed(folderPath);
    }
    prevCount.current = threads.length;
  }, [threads.length, collapsed, folderPath]);

  return (
    <div class={`folder-group${collapsed ? " collapsed" : ""}`}>
      <div
        class="folder-header"
        onClick={() => toggleFolderCollapsed(folderPath)}
      >
        <span class="folder-chevron">&#x276F;</span>
        <span class="folder-icon">&#x1F4C1;</span>
        <span class="folder-name">{name}</span>
        <button
          class="folder-add-thread"
          title="New thread"
          onClick={(e) => {
            e.stopPropagation();
            openNewTerminal(folderPath);
          }}
        >
          +
        </button>
      </div>
      <div class="folder-threads">
        {threads.map((thread) => (
          <ThreadItem key={thread.id} thread={thread} />
        ))}
      </div>
    </div>
  );
}

function ThreadItem({ thread }: { thread: ThreadData }) {
  const isActive = activeId.value === thread.id;
  const hasPrompt = activePrompts.value.has(thread.id);
  const cls = [
    "thread-item",
    isActive && "active",
    hasPrompt && "has-prompt",
    thread.status === "working" && "working",
    thread.status === "done" && "done",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div class={cls} onClick={() => selectThread(thread.id)}>
      <span class="thread-label">{thread.title}</span>
      <button
        class="thread-close"
        title="Close"
        onClick={(e) => {
          e.stopPropagation();
          closeTerminal(thread.id);
        }}
      >
        &#x2715;
      </button>
    </div>
  );
}
