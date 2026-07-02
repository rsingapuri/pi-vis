// Shared icon set — the app's ONE source of chrome glyphs. Every ▾ / ✓ / ×
// used to be a typeset character, which sat differently on the baseline and
// changed weight with the font; these stroke SVGs render identically
// everywhere. All icons share a 12×12 viewBox, 1.5px rounded strokes, and
// currentColor, and default to 1em so they scale with the surrounding type
// (the `icon` class in theme.css supplies sizing + baseline alignment).
//
// Pair interactive icons with the global `.icon-btn` ghost-button class so
// hit targets, hover fills, and padding stay consistent across components.

import type React from "react";

interface IconProps {
  className?: string;
  /** Override the 1em default (e.g. "0.75em" for a caret inside a chip). */
  size?: string;
}

function Icon({
  className,
  size,
  children,
}: IconProps & { children: React.ReactNode }): React.ReactElement {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={size ? { width: size, height: size } : undefined}
    >
      {children}
    </svg>
  );
}

export function IconChevronDown(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <polyline points="3 5 6 8 9 5" />
    </Icon>
  );
}

export function IconChevronUp(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <polyline points="3 7 6 4 9 7" />
    </Icon>
  );
}

export function IconChevronRight(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <polyline points="5 3 9 7 5 11" />
    </Icon>
  );
}

export function IconCheck(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <polyline points="2.5 6.5 5 9 9.5 3.5" />
    </Icon>
  );
}

export function IconClose(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <path d="M3 3l6 6M9 3l-6 6" />
    </Icon>
  );
}

/** Git branch — a trunk with one fork, for worktree chips. */
export function IconBranch(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <circle cx="3.5" cy="2.75" r="1.35" />
      <circle cx="3.5" cy="9.25" r="1.35" />
      <circle cx="8.75" cy="4" r="1.35" />
      <path d="M3.5 4.1v3.8M8.75 5.35c0 2-1.5 2.4-3.4 2.6" />
    </Icon>
  );
}
