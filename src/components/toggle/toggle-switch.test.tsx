import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToggleSwitch } from "./toggle-switch";

describe("ToggleSwitch", () => {
  it("renders as a real, operable checkbox reflecting the checked state", () => {
    render(<ToggleSwitch id="tax-advantaged" checked={false} onChange={() => {}} label="Tax-advantaged" />);
    const input = screen.getByLabelText("Tax-advantaged") as HTMLInputElement;
    expect(input.type).toBe("checkbox");
    expect(input.checked).toBe(false);
  });

  it("calls onChange with the new checked value on click", () => {
    const onChange = vi.fn();
    render(<ToggleSwitch id="tax-advantaged" checked={false} onChange={onChange} label="Tax-advantaged" />);
    fireEvent.click(screen.getByLabelText("Tax-advantaged"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("reflects an externally-controlled checked=true state", () => {
    render(<ToggleSwitch id="tax-advantaged" checked={true} onChange={() => {}} label="Tax-advantaged" />);
    expect((screen.getByLabelText("Tax-advantaged") as HTMLInputElement).checked).toBe(true);
  });
});
