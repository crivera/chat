/** @jsxImportSource preact */
import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import { getBranches, checkoutBranch, showToast } from "../state";

export function BranchSwitcher() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const data = await getBranches();
    setCurrent(data.current);
    setBranches(data.branches);
  }, []);

  // Load current branch on mount and when dropdown opens
  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (open) {
      load();
      setSearch("");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, load]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const filtered = search
    ? branches.filter((b) => b.toLowerCase().includes(search.toLowerCase()))
    : branches;

  const handleSelect = async (branch: string) => {
    if (branch === current) {
      setOpen(false);
      return;
    }
    setLoading(true);
    setOpen(false);
    const result = await checkoutBranch(branch);
    setLoading(false);
    if (result.ok) {
      setCurrent(branch);
    }
    showToast(`git checkout`, result.output, result.ok);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
    }
  };

  if (!current) return null;

  return (
    <div class="branch-switcher" ref={dropdownRef}>
      <button
        class="toolbar-btn branch-btn"
        onClick={() => setOpen(!open)}
        disabled={loading}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 01-9 9" />
        </svg>
        <span class="branch-name">{current}</span>
        <svg
          class="branch-chevron"
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div class="branch-dropdown" onKeyDown={handleKeyDown}>
          <input
            ref={inputRef}
            class="branch-search"
            type="text"
            placeholder="Search branches..."
            value={search}
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          />
          <div class="branch-list">
            {filtered.map((branch) => (
              <button
                key={branch}
                class={`branch-item ${branch === current ? "branch-current" : ""}`}
                onClick={() => handleSelect(branch)}
              >
                <span class="branch-item-name">{branch}</span>
                {branch === current && (
                  <span class="branch-item-badge">current</span>
                )}
              </button>
            ))}
            {filtered.length === 0 && (
              <div class="branch-empty">No matching branches</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
