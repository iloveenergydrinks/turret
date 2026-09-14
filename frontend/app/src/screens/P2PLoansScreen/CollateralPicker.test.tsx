// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CollateralPicker } from "./CollateralPicker";
afterEach(cleanup);
const assets = [
  { address: "0x1", collateralSymbol: "AAPL", collateralName: "Apple • Robinhood Token" },
  { address: "0x2", collateralSymbol: "MSFT", collateralName: "Microsoft • Robinhood Token" },
];
test("filters by name and commits only the selected result", () => {
  const onChange = vi.fn();
  const { rerender } = render(<CollateralPicker assets={assets} value="0x1" onChange={onChange} />);
  const input = screen.getByRole("combobox", { name: "Collateral asset" });
  expect(input).toHaveValue("AAPL · Apple • Robinhood Token");
  fireEvent.focus(input);
  expect(screen.getAllByRole("option")).toHaveLength(2);
  fireEvent.change(input, { target: { value: "micro" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("option", { name: /MSFT/ }));
  expect(onChange).toHaveBeenCalledWith("0x2");
  rerender(<CollateralPicker assets={assets} value="0x2" onChange={onChange} />);
  expect(input).toHaveValue("MSFT · Microsoft • Robinhood Token");
  expect(input).toHaveAttribute("aria-expanded", "false");
});
test("supports keyboard selection, empty results and cancellation without changing collateral", () => {
  const onChange = vi.fn();
  render(<CollateralPicker assets={assets} value="0x1" onChange={onChange} />);
  const input = screen.getByRole("combobox");
  fireEvent.focus(input);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).toHaveBeenCalledWith("0x2");
  onChange.mockClear();
  fireEvent.click(input);
  fireEvent.change(input, { target: { value: "unknown" } });
  expect(screen.getByRole("status")).toHaveTextContent("No matching assets");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input).toHaveValue("AAPL · Apple • Robinhood Token");
  fireEvent.click(input);
  fireEvent.change(input, { target: { value: "msft" } });
  fireEvent.blur(input);
  expect(input).toHaveValue("AAPL · Apple • Robinhood Token");
  expect(onChange).not.toHaveBeenCalled();
});
