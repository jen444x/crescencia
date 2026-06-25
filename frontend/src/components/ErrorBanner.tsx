// A red error banner, shared across pages that show a load/save error.
export function ErrorBanner({ error }: { error: string }) {
  return (
    <div className="bg-red-50 rounded-xl p-4 text-center">
      <p className="text-red-500 text-sm">{error}</p>
    </div>
  );
}
