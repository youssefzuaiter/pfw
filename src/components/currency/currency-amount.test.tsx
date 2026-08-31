import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { setCurrencyDisplayMode } from "../../lib/hooks/use-currency-display-mode";
import { nativeAmount } from "../../lib/currency";
import { agorot } from "../../lib/money";
import { CurrencyAmount } from "./currency-amount";

describe("CurrencyAmount", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("shows the ₪ figure as primary and the native figure as secondary by default (mode='ils')", () => {
    render(<CurrencyAmount agorotValue={agorot(370_00)} nativeValue={nativeAmount(100_00)} currency="USD" />);
    const [primary, secondary] = screen.getAllByText(/./, { selector: "p" });
    expect(primary).toHaveTextContent("₪370.00");
    expect(secondary).toHaveTextContent("$100.00");
  });

  it("swaps to native-primary / ₪-secondary when mode is set to 'native'", () => {
    setCurrencyDisplayMode("native");
    render(<CurrencyAmount agorotValue={agorot(370_00)} nativeValue={nativeAmount(100_00)} currency="USD" />);
    const [primary, secondary] = screen.getAllByText(/./, { selector: "p" });
    expect(primary).toHaveTextContent("$100.00");
    expect(secondary).toHaveTextContent("₪370.00");
  });

  it("renders only ONE figure for an ILS-currency amount — no secondary line, no native/₪ distinction to toggle", () => {
    render(<CurrencyAmount agorotValue={agorot(370_00)} nativeValue={nativeAmount(370_00)} currency="ILS" />);
    const paragraphs = screen.getAllByText(/./, { selector: "p" });
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]).toHaveTextContent("₪370.00");
  });

  it("stays ₪-only for ILS even when the app-wide mode is 'native'", () => {
    setCurrencyDisplayMode("native");
    render(<CurrencyAmount agorotValue={agorot(370_00)} nativeValue={nativeAmount(370_00)} currency="ILS" />);
    const paragraphs = screen.getAllByText(/./, { selector: "p" });
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]).toHaveTextContent("₪370.00");
  });

  it("applies custom primary/secondary class names when provided", () => {
    render(
      <CurrencyAmount
        agorotValue={agorot(100)}
        nativeValue={nativeAmount(27)}
        currency="EUR"
        primaryClassName="custom-primary"
        secondaryClassName="custom-secondary"
      />,
    );
    expect(document.querySelector(".custom-primary")).not.toBeNull();
    expect(document.querySelector(".custom-secondary")).not.toBeNull();
  });
});
