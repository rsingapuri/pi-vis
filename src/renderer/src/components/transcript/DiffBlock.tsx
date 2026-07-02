import type React from "react";
import "./DiffBlock.css";

interface DiffBlockProps {
  diff: string;
}

export function DiffBlock({ diff }: DiffBlockProps): React.ReactElement {
  const lines = diff.split("\n");
  return (
    <div className="diff-block">
      <div className="diff-block__inner">
        {lines.map((line, i) => {
          const cls =
            line.startsWith("+") && !line.startsWith("+++")
              ? "diff-block__line diff-block__line--add"
              : line.startsWith("-") && !line.startsWith("---")
                ? "diff-block__line diff-block__line--del"
                : line.startsWith("@@")
                  ? "diff-block__line diff-block__line--hunk"
                  : "diff-block__line";
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are stream-stable per render
            <div key={i} className={cls}>
              <span className="diff-block__text">{line}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
