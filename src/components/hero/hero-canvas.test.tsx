import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

function mockMatchMedia(reducedMotionMatches: boolean) {
  const removeEventListener = vi.fn();
  const addEventListener = vi.fn();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? reducedMotionMatches : false,
    media: query,
    addEventListener,
    removeEventListener,
  })) as unknown as typeof window.matchMedia;
  return { addEventListener, removeEventListener };
}

// HeroScene touches @react-three/fiber's <Canvas>, which needs a real
// WebGL context — jsdom has none, and forcing R3F through it would just
// test three.js/R3F's own internals, not this component's gating logic.
// Stubbed here so these tests can verify *which* branch HeroCanvas picks
// without dragging a real WebGL renderer into jsdom.
vi.mock("./hero-scene", () => ({
  HeroScene: ({ active }: { active: boolean }) => <div data-active={active}>stub-hero-scene</div>,
}));

const { HeroCanvas } = await import("./hero-canvas");

describe("HeroCanvas", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to the static gradient when the browser has no WebGL support (jsdom's default)", async () => {
    mockMatchMedia(false);

    const { container } = render(<HeroCanvas />);

    await waitFor(() => {
      expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
    });
    expect(screen.queryByText("stub-hero-scene")).not.toBeInTheDocument();
  });

  it("falls back to the static gradient under prefers-reduced-motion: reduce, even with WebGL support", async () => {
    vi.doMock("./supports-webgl", () => ({ supportsWebGL: () => true }));
    vi.resetModules();
    const { HeroCanvas: HeroCanvasReducedMotion } = await import("./hero-canvas");
    mockMatchMedia(true);

    const { container } = render(<HeroCanvasReducedMotion />);

    await waitFor(() => {
      expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
    });
    expect(screen.queryByText("stub-hero-scene")).not.toBeInTheDocument();
  });

  it("mounts the R3F scene when WebGL is supported and motion is allowed", async () => {
    vi.doMock("./supports-webgl", () => ({ supportsWebGL: () => true }));
    vi.resetModules();
    const { HeroCanvas: HeroCanvasMotionOk } = await import("./hero-canvas");
    mockMatchMedia(false);

    render(<HeroCanvasMotionOk />);

    await waitFor(() => {
      expect(screen.getByText("stub-hero-scene")).toBeInTheDocument();
    });
  });

  it("registers and cleans up its prefers-reduced-motion media-query listener on unmount", async () => {
    const { addEventListener, removeEventListener } = mockMatchMedia(false);

    const { unmount } = render(<HeroCanvas />);
    await waitFor(() => expect(addEventListener).toHaveBeenCalledWith("change", expect.any(Function)));

    unmount();
    expect(removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("disconnects its IntersectionObserver on unmount", async () => {
    const disconnect = vi.fn();
    const observe = vi.fn();
    const originalIntersectionObserver = window.IntersectionObserver;
    window.IntersectionObserver = class {
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
    } as unknown as typeof IntersectionObserver;
    mockMatchMedia(false);

    const { unmount } = render(<HeroCanvas />);
    await waitFor(() => expect(observe).toHaveBeenCalled());

    unmount();
    expect(disconnect).toHaveBeenCalled();

    window.IntersectionObserver = originalIntersectionObserver;
  });
});
