import { useEffect } from "react";

// A small centered confirmation modal — a nicer replacement for window.confirm.
// Backdrop click and Escape both cancel; the confirm button can be styled
// `destructive` (rose) for irreversible-feeling actions like "Skip day".
function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Close on Escape while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      {/* Backdrop — tap to cancel. */}
      <div
        className="animate-backdrop-in absolute inset-0 bg-ink/40 backdrop-blur-[2px]"
        onClick={onCancel}
        aria-hidden
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="animate-sheet-in relative w-full max-w-sm rounded-2xl border border-mist bg-white p-6 shadow-[0_18px_44px_rgba(27,46,42,0.18)]"
      >
        <h2 className="font-heading text-2xl text-calm-900">{title}</h2>
        {message && <p className="mt-2 text-sm text-stone-500">{message}</p>}

        <div className="mt-6 flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-full border border-mist py-3 text-sm font-medium text-calm-700 transition hover:bg-whisper active:scale-[0.97]"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`flex-1 rounded-full py-3 text-sm font-semibold text-white transition active:scale-[0.97] ${
              destructive
                ? "bg-rose-500 hover:bg-rose-600"
                : "bg-calm-600 hover:bg-calm-700"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
