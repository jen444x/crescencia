// A centered "nothing here" card, shared across pages. Pass the wording in so
// the component stays generic (no page-specific logic inside).
export function EmptyState({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div className="bg-white rounded-2xl p-10 text-center shadow-sm">
      <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-accent-100 flex items-center justify-center">
        <span className="text-3xl">&#x1F331;</span>
      </div>
      <h3 className="font-heading text-xl text-stone-900 mb-2">{title}</h3>
      <p className="text-stone-400 text-sm">{subtitle}</p>
    </div>
  );
}
