import { PencilIcon } from "../../../components/icons";
import { useState, useEffect, useRef } from "react";

// The chain's name, inline-editable. Shows `label` (the saved name, or the
// chainLabel fallback when unnamed) as a tappable title; tapping opens a small
// text input that saves on Enter/blur and cancels on Escape. Carries
// data-no-retime so a tap edits the name instead of starting the header's
// retime drag. Only rendered for timed blocks. `name` is the raw saved value
// ("" when unnamed) — what we seed the input with — while `label` is what we
// show when not editing.
export function ChainNameControl({
  name,
  label,
  onSave,
}: {
  name: string;
  label: string;
  onSave: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus + select when the input opens so a rename overwrites cleanly.
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function open() {
    setDraft(name);
    setEditing(true);
  }

  // Save only when the value actually changed (Enter/blur both land here), then
  // close. The parent trims + persists.
  function commit() {
    setEditing(false);
    if (draft.trim() !== name.trim()) onSave(draft);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        data-no-retime
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setEditing(false);
          }
        }}
        onBlur={commit}
        placeholder="Name this chain"
        maxLength={100}
        aria-label="Chain name"
        className="min-w-0 flex-1 rounded-lg border border-mist bg-white px-2 py-0.5 text-xs font-medium text-calm-900 focus:border-calm-500 focus:outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      data-no-retime
      onClick={open}
      title="Name this chain"
      aria-label={name ? `Rename chain "${name}"` : "Name this chain"}
      className="group inline-flex min-w-0 items-center gap-1 text-xs font-medium text-calm-600 transition-colors hover:text-calm-800"
    >
      <span className="truncate">{label}</span>
      <span className="shrink-0 text-calm-300 transition-colors group-hover:text-calm-500">
        <PencilIcon />
      </span>
    </button>
  );
}
