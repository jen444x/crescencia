import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

// A tiny app-wide toast. One toast shows at a time (a newer one replaces the
// current); it auto-dismisses, and can carry a single action button — that's
// what powers "Skipped day · Undo". Use it via the `useToast()` hook:
//
//   const toast = useToast();
//   toast("Couldn't save", { variant: "error" });
//   toast("Day skipped", { action: { label: "Undo", onClick: undo } });

type ToastVariant = "info" | "success" | "error";

type ToastAction = { label: string; onClick: () => void };

type ToastOptions = {
  variant?: ToastVariant;
  action?: ToastAction;
  duration?: number; // ms before auto-dismiss
};

type ToastState = {
  id: number;
  message: string;
  variant: ToastVariant;
  action?: ToastAction;
};

type ShowToast = (message: string, options?: ToastOptions) => void;

const ToastContext = createContext<ShowToast | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (!show) throw new Error("useToast must be used inside a <ToastProvider>.");
  return show;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const dismiss = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    setToast(null);
  }, []);

  const show = useCallback<ShowToast>((message, options = {}) => {
    const { variant = "info", action, duration = 4000 } = options;
    if (timer.current) window.clearTimeout(timer.current);
    setToast({ id: Date.now(), message, variant, action });
    timer.current = window.setTimeout(() => setToast(null), duration);
  }, []);

  // Clear any pending timer if the provider unmounts.
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <ToastView key={toast.id} toast={toast} onDismiss={dismiss} />
      )}
    </ToastContext.Provider>
  );
}

const VARIANT_STYLES: Record<ToastVariant, string> = {
  info: "bg-calm-900 text-white",
  success: "bg-calm-700 text-white",
  error: "bg-rose-600 text-white",
};

// The toast itself: a centered pill floating above the bottom nav. Tapping the
// action (if any) runs it and dismisses; the × always dismisses.
function ToastView({
  toast,
  onDismiss,
}: {
  toast: ToastState;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-28 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2"
    >
      <div
        className={`animate-toast-in flex items-center gap-3 rounded-full px-5 py-3 text-sm shadow-lg ${VARIANT_STYLES[toast.variant]}`}
      >
        <span className="flex-1">{toast.message}</span>

        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              onDismiss();
            }}
            className="shrink-0 rounded-lg px-2 py-1 text-sm font-semibold underline-offset-2 hover:underline"
          >
            {toast.action.label}
          </button>
        )}

        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 text-white/70 transition-colors hover:text-white"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
