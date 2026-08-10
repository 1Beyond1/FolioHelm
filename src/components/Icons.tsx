import type { SVGProps } from "react";

export type IconName =
  | "calendar"
  | "chevron-down"
  | "eye"
  | "orders"
  | "search"
  | "settings"
  | "trade"
  | "watchlist";

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
}

export function Icon({ name, ...props }: IconProps) {
  const commonProps: SVGProps<SVGSVGElement> = {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    strokeWidth: 1.7,
    "aria-hidden": true,
    ...props,
  };

  switch (name) {
    case "search":
      return (
        <svg viewBox="0 0 24 24" {...commonProps}>
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
      );
    case "settings":
      return (
        <svg viewBox="0 0 24 24" {...commonProps}>
          <circle cx="12" cy="12" r="3.2" />
          <path d="M19 13.8v-3.6l-2-.5a7 7 0 0 0-.6-1.4l1.1-1.8L15 4l-1.8 1.1a7 7 0 0 0-1.4-.6l-.5-2H7.8l-.5 2a7 7 0 0 0-1.4.6L4 4 1.5 6.5l1.1 1.8a7 7 0 0 0-.6 1.4l-2 .5v3.6l2 .5a7 7 0 0 0 .6 1.4l-1.1 1.8L4 20l1.8-1.1a7 7 0 0 0 1.4.6l.5 2h3.6l.5-2a7 7 0 0 0 1.4-.6L15 20l2.5-2.5-1.1-1.8a7 7 0 0 0 .6-1.4l2-.5Z" transform="translate(2 0)" />
        </svg>
      );
    case "eye":
      return (
        <svg viewBox="0 0 24 24" {...commonProps}>
          <path d="M2.5 12s3.6-6 9.5-6 9.5 6 9.5 6-3.6 6-9.5 6-9.5-6-9.5-6Z" />
          <circle cx="12" cy="12" r="2.7" />
        </svg>
      );
    case "chevron-down":
      return (
        <svg viewBox="0 0 16 16" {...commonProps}>
          <path d="m4 6 4 4 4-4" />
        </svg>
      );
    case "trade":
      return (
        <svg viewBox="0 0 24 24" {...commonProps}>
          <path d="M5 17 17 5M8 5h9v9" />
        </svg>
      );
    case "watchlist":
      return (
        <svg viewBox="0 0 24 24" {...commonProps}>
          <path d="M6.5 4.5h11v15l-5.5-3-5.5 3Z" />
        </svg>
      );
    case "orders":
      return (
        <svg viewBox="0 0 24 24" {...commonProps}>
          <rect x="5" y="4" width="14" height="16" rx="2" />
          <path d="M8.5 9h7M8.5 13h7M8.5 17h4" />
        </svg>
      );
    case "calendar":
      return (
        <svg viewBox="0 0 24 24" {...commonProps}>
          <rect x="4" y="5" width="16" height="15" rx="2" />
          <path d="M8 3v4M16 3v4M4 10h16" />
        </svg>
      );
  }
}
