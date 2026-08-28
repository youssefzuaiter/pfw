import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TiltCard } from "./tilt-card";

function mockMatchMedia(matches: { hoverFine: boolean; reducedMotionNoPreference: boolean }) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("pointer: fine") ? matches.hoverFine : matches.reducedMotionNoPreference,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe("TiltCard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders its children", () => {
    render(<TiltCard>Category card</TiltCard>);
    expect(screen.getByText("Category card")).toBeInTheDocument();
  });

  it("applies a rotation transform on pointer move when hover+fine-pointer and motion is allowed", () => {
    mockMatchMedia({ hoverFine: true, reducedMotionNoPreference: true });
    render(<TiltCard>Card</TiltCard>);
    const card = screen.getByText("Card");
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    fireEvent.pointerMove(card, { clientX: 100, clientY: 50 });

    expect(card.style.transform).toContain("rotateX");
    expect(card.style.transform).toContain("rotateY");
  });

  it("never applies a transform on a coarse/touch pointer device", () => {
    mockMatchMedia({ hoverFine: false, reducedMotionNoPreference: true });
    render(<TiltCard>Card</TiltCard>);
    const card = screen.getByText("Card");

    fireEvent.pointerMove(card, { clientX: 100, clientY: 50 });

    expect(card.style.transform).toBe("");
  });

  it("never applies a transform when the user prefers reduced motion", () => {
    mockMatchMedia({ hoverFine: true, reducedMotionNoPreference: false });
    render(<TiltCard>Card</TiltCard>);
    const card = screen.getByText("Card");

    fireEvent.pointerMove(card, { clientX: 100, clientY: 50 });

    expect(card.style.transform).toBe("");
  });

  it("resets the transform on pointer leave", () => {
    mockMatchMedia({ hoverFine: true, reducedMotionNoPreference: true });
    render(<TiltCard>Card</TiltCard>);
    const card = screen.getByText("Card");
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    fireEvent.pointerMove(card, { clientX: 100, clientY: 50 });
    expect(card.style.transform).not.toBe("");

    fireEvent.pointerLeave(card);
    expect(card.style.transform).toBe("");
  });
});
