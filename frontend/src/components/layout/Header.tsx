import { useState } from "react";
import type { ReactNode } from "react";

// The shared page header: a small green eyebrow, a left-set serif title with an
// optional action pill on the baseline, and a mist hairline underneath. `body`
// (optional) sits between the title and the rule; long ones clamp to two lines
// and expand on tap.
function Header({
  title,
  body = "",
  eyebrow = "",
  action,
}: {
  title: string;
  body?: string;
  eyebrow?: string;
  action?: ReactNode;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="mb-5">
      {eyebrow && (
        <div className="text-[11px] font-semibold uppercase tracking-[0.13em] text-calm-600">
          {eyebrow}
        </div>
      )}
      <div className="mt-1 flex items-baseline justify-between gap-3">
        <h1 className="font-heading text-3xl font-medium capitalize leading-tight text-ink">
          {title}
        </h1>
        {action}
      </div>
      {body && (
        <p
          onClick={() => setIsExpanded(!isExpanded)}
          className={`mt-2 cursor-pointer text-sm text-stone-400 ${
            isExpanded ? "" : "line-clamp-2"
          }`}
        >
          {body}
        </p>
      )}
      <div className="mt-3 h-px bg-mist" />
    </div>
  );
}

export default Header;
