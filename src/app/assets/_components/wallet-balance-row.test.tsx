import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WalletBalanceRow, type WalletBalanceRowProps } from "./wallet-balance-row";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const BASE_PROPS: WalletBalanceRowProps = {
  id: "wallet-1",
  address: "0x1ad7c10de6a97ad325ef1bff74f5b47a448885c7",
  label: "Main wallet",
  chainId: 1,
  balanceWei: "1500000000000000000", // 1.5 ETH
  valueAgorot: 1_800_075, // ₪18,000.75
  stakingYieldBps: null,
  cumulativeGasFeesWei: null,
  rpcError: null,
};

describe("WalletBalanceRow — multi-currency display", () => {
  it("shows the native ETH balance AND its ILS-converted value side by side, never conflating the two", () => {
    render(<WalletBalanceRow {...BASE_PROPS} />);

    expect(screen.getByText("1.5 ETH")).toBeInTheDocument();
    expect(screen.getByText("≈ ₪18,000.75")).toBeInTheDocument();
  });

  it("renders the full 18-decimal-precision fractional amount, not a truncated/rounded display", () => {
    render(<WalletBalanceRow {...BASE_PROPS} balanceWei="123456789012345678" valueAgorot={0} />);
    expect(screen.getByText("0.123456789012345678 ETH")).toBeInTheDocument();
  });

  it("shows a shortened address, not the full 42-character address inline", () => {
    render(<WalletBalanceRow {...BASE_PROPS} />);
    expect(screen.getByText("0x1ad7…85c7")).toBeInTheDocument();
    expect(screen.queryByText(BASE_PROPS.address)).not.toBeInTheDocument();
  });

  it("shows a zero balance correctly as '0 ETH', not blank or an error", () => {
    render(<WalletBalanceRow {...BASE_PROPS} balanceWei="0" valueAgorot={0} />);
    expect(screen.getByText("0 ETH")).toBeInTheDocument();
    expect(screen.getByText("≈ ₪0.00")).toBeInTheDocument();
  });

  it("shows an RPC error state instead of a fabricated balance when the live fetch failed", () => {
    render(<WalletBalanceRow {...BASE_PROPS} balanceWei={null} valueAgorot={0} rpcError="EVM RPC request timed out after 3000ms" />);
    expect(screen.getByText(/Couldn't fetch a live balance/)).toBeInTheDocument();
    expect(screen.queryByText(/ETH$/)).not.toBeInTheDocument();
  });

  it("shows staking yield and cumulative gas fees when present, and hides that row entirely when both are absent", () => {
    const { rerender } = render(<WalletBalanceRow {...BASE_PROPS} />);
    expect(screen.queryByText(/Staking/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Gas paid/)).not.toBeInTheDocument();

    rerender(<WalletBalanceRow {...BASE_PROPS} stakingYieldBps={420} cumulativeGasFeesWei="50000000000000000" />);
    expect(screen.getByText("Staking 4.20% APY")).toBeInTheDocument();
    expect(screen.getByText("Gas paid: 0.05 ETH")).toBeInTheDocument();
  });

  it("has an accessible, keyboard-focusable remove control", () => {
    render(<WalletBalanceRow {...BASE_PROPS} />);
    const button = screen.getByRole("button", { name: /remove/i });
    expect(button).toBeEnabled();
  });
});
