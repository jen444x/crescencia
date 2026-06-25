// A centered spinner with a label, shared across pages that load on mount.
// e.g. <LoadingSpinner label="habits" /> renders "Loading habits...".
export function LoadingSpinner({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center justify-center py-12">
      <div
        aria-hidden="true"
        className="w-6 h-6 border-2 border-calm-300 border-t-calm-600 rounded-full animate-spin"
      ></div>
      <span className="ml-3 text-stone-400 text-sm">Loading {label}...</span>
    </div>
  );
}
