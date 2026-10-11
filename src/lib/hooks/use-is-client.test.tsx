import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useIsClient } from "./use-is-client";

function Probe() {
  return <span>{useIsClient() ? "client" : "server"}</span>;
}

describe("useIsClient", () => {
  it("is false in server-rendered HTML, so client-only content never reaches it", () => {
    expect(renderToString(<Probe />)).toContain("server");
  });

  it("is true once mounted in a browser", () => {
    render(<Probe />);
    expect(screen.getByText("client")).toBeInTheDocument();
  });
});
