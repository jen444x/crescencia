import { useState } from "react";

// The inline "＋ Add time" row: a time picker + Add/Cancel. Opened from the
// toolbar menu (the page owns the open flag), but its own draft value is local
// here — the page only needs onAdd (create the block) and onClose. Unmounts when
// the page closes it, so the draft resets on the next open.
export function AddTimeInput({
  onAdd,
  onClose,
}: {
  onAdd: (time: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="mb-4 flex items-center gap-2">
      <input
        type="time"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="rounded-lg border border-mist px-2 py-1.5 text-sm text-stone-800"
      />
      <button
        type="button"
        onClick={() => {
          onAdd(value);
          onClose();
        }}
        disabled={!value}
        className="rounded-lg bg-calm-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
      >
        Add
      </button>
      <button
        type="button"
        onClick={onClose}
        className="rounded-lg px-2 py-1.5 text-sm text-calm-500"
      >
        Cancel
      </button>
    </div>
  );
}
