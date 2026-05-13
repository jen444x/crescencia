import { useState } from "react";

function Header({ title, body }: { title: string; body: string }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="text-center mb-10">
      <div className="text-5xl mb-4">🌿</div>
      <h1 className="font-heading text-4xl capitalize text-calm-900 mb-2">
        {title}
      </h1>
      {body && (
        <p
          onClick={() => setIsExpanded(!isExpanded)}
          className={`text-gray-400 text-sm max-w-xs mx-auto cursor-pointer ${
            isExpanded ? "" : "line-clamp-2"
          }`}
        >
          {body}
        </p>
      )}
    </div>
  );
}

export default Header;
