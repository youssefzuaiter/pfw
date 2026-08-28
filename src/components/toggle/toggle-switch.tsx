"use client";

import type { ChangeEvent } from "react";

/**
 * An accessible toggle switch: a real `<input type="checkbox">` (visually
 * hidden but focusable/operable exactly like any checkbox) driving a
 * styled track+thumb via Tailwind's `peer-*` variants. The thumb's slide
 * (`uv-toggle-thumb`, globals.css) animates `transform: translateX` only.
 */
export function ToggleSwitch({
  id,
  checked,
  onChange,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    onChange(event.target.checked);
  }

  return (
    <label htmlFor={id} className="inline-flex cursor-pointer items-center gap-2">
      <span className="relative inline-block h-5 w-9 shrink-0">
        <input id={id} type="checkbox" checked={checked} onChange={handleChange} className="peer sr-only" />
        <span
          aria-hidden="true"
          className="uv-toggle-track absolute inset-0 rounded-full bg-border peer-checked:bg-accent peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2"
        />
        <span
          aria-hidden="true"
          className="uv-toggle-thumb pointer-events-none absolute top-0.5 left-0.5 h-4 w-4 translate-x-0 rounded-full bg-surface shadow peer-checked:translate-x-4"
        />
      </span>
      <span className="text-xs font-medium text-muted">{label}</span>
    </label>
  );
}
