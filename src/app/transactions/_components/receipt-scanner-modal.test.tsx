import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));

const recognizeReceiptTextMock = vi.fn();
vi.mock("../../../lib/receipt-ocr", () => ({ recognizeReceiptText: recognizeReceiptTextMock }));

const { ReceiptScannerModal } = await import("./receipt-scanner-modal");

const BANK_ACCOUNTS = [{ id: "acc-1", label: "Checking (…1234)" }];

function makeImageFile(name = "receipt.jpg") {
  return new File(["fake-image-bytes"], name, { type: "image/jpeg" });
}

describe("ReceiptScannerModal", () => {
  beforeEach(() => {
    recognizeReceiptTextMock.mockReset();
    refreshMock.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, transaction: { id: "txn-1" } }),
      }),
    );
  });

  it("is closed by default and opens on trigger click", () => {
    render(<ReceiptScannerModal bankAccounts={BANK_ACCOUNTS} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Scan a receipt" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("runs OCR + parsing on a dropped image and pre-fills the review form", async () => {
    recognizeReceiptTextMock.mockResolvedValue(`Cafe Aroma\n05/03/2026\nTotal 26.90`);

    render(<ReceiptScannerModal bankAccounts={BANK_ACCOUNTS} />);
    fireEvent.click(screen.getByRole("button", { name: "Scan a receipt" }));

    const fileInput = screen.getByRole("dialog").querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeImageFile()] } });

    await waitFor(() => expect(screen.getByLabelText("Merchant")).toBeInTheDocument());

    expect(screen.getByLabelText("Merchant")).toHaveValue("Cafe Aroma");
    expect(screen.getByLabelText("Total (₪)")).toHaveValue("26.90");
    expect(recognizeReceiptTextMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-image file without ever calling the OCR engine", async () => {
    render(<ReceiptScannerModal bankAccounts={BANK_ACCOUNTS} />);
    fireEvent.click(screen.getByRole("button", { name: "Scan a receipt" }));

    const fileInput = screen.getByRole("dialog").querySelector('input[type="file"]') as HTMLInputElement;
    const pdfFile = new File(["%PDF-1.4"], "receipt.pdf", { type: "application/pdf" });
    fireEvent.change(fileInput, { target: { files: [pdfFile] } });

    await waitFor(() => expect(screen.getByText(/Only image files/)).toBeInTheDocument());
    expect(recognizeReceiptTextMock).not.toHaveBeenCalled();
  });

  it("shows a clear error state when OCR fails, without crashing", async () => {
    recognizeReceiptTextMock.mockRejectedValue(new Error("worker failed to load"));

    render(<ReceiptScannerModal bankAccounts={BANK_ACCOUNTS} />);
    fireEvent.click(screen.getByRole("button", { name: "Scan a receipt" }));

    const fileInput = screen.getByRole("dialog").querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeImageFile()] } });

    await waitFor(() => expect(screen.getByText("worker failed to load")).toBeInTheDocument());
  });

  it("submits the reviewed fields as a negative (expense) amount and refreshes on success", async () => {
    recognizeReceiptTextMock.mockResolvedValue(`Cafe Aroma\n05/03/2026\nTotal 26.90`);

    render(<ReceiptScannerModal bankAccounts={BANK_ACCOUNTS} />);
    fireEvent.click(screen.getByRole("button", { name: "Scan a receipt" }));

    const fileInput = screen.getByRole("dialog").querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [makeImageFile()] } });
    await waitFor(() => expect(screen.getByLabelText("Merchant")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Add transaction" }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalled());

    const [, requestInit] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(requestInit.body as string);
    expect(body.amount).toBe("-26.90");
    expect(body.merchantName).toBe("Cafe Aroma");
    expect(body.bankAccountId).toBe("acc-1");
  });

  it("closes and resets on Escape", async () => {
    recognizeReceiptTextMock.mockResolvedValue(`Cafe Aroma\nTotal 26.90`);
    render(<ReceiptScannerModal bankAccounts={BANK_ACCOUNTS} />);
    fireEvent.click(screen.getByRole("button", { name: "Scan a receipt" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
