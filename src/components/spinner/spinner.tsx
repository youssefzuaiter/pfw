const SIZE_CLASS = {
  sm: "h-3.5 w-3.5",
  md: "h-5 w-5",
} as const;

/** A single continuously-rotating ring (`uv-spin`, transform-only — see globals.css). Color inherits from the parent via `border-current` so it matches whatever button/text it's sitting in. */
export function Spinner({ size = "sm" }: { size?: keyof typeof SIZE_CLASS }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`uv-spinner inline-block shrink-0 rounded-full border-2 border-current border-t-transparent opacity-70 ${SIZE_CLASS[size]}`}
    />
  );
}
