// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HowBorrowingWorks, HowP2PWorks } from "./HowBorrowingWorks";

beforeEach(() => {
  // jsdom does not implement the native dialog methods.
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value: vi.fn(function(this: HTMLDialogElement) {
        this.setAttribute("open", "");
      }),
    },
    close: {
      configurable: true,
      value: vi.fn(function(this: HTMLDialogElement) {
        this.removeAttribute("open");
      }),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.style.overflow = "";
});

describe("How borrowing works video", () => {
  it("opens the P2P companion with its own video, captions and download", async () => {
    const { container } = render(<HowP2PWorks />);
    expect(container.querySelector("video")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "How P2P loans work" }));
    const modal = screen.getByRole("dialog", { name: "How P2P loans work" });
    expect(modal.querySelector("video")).toHaveAttribute("src", "/videos/turret-how-p2p-works-v1.mp4");
    expect(modal.querySelector("track")).toHaveAttribute("src", "/videos/turret-how-p2p-works-v1.vtt");
    expect(screen.getByText("54 seconds · Captioned")).toBeVisible();
    expect(screen.getByRole("link", { name: "Download video" })).toHaveAttribute("href", "/videos/turret-how-p2p-works-v1.mp4");
    await userEvent.click(screen.getByRole("button", { name: "Close video" }));
    expect(container.querySelector("video")).toBeNull();
  });

  it("does not load the video before the user opens it", () => {
    const { container } = render(<HowBorrowingWorks />);
    expect(container.querySelector("video")).toBeNull();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "How borrowing works" })).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("shows the explainer without a contracts-pending badge", () => {
    render(<HowBorrowingWorks />);
    expect(screen.queryByText(/contracts pending/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "How borrowing works" })).toBeEnabled();
  });

  it("opens with keyboard activation and supplies native controls, captions and a download", async () => {
    render(<HowBorrowingWorks />);
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    const modal = screen.getByRole("dialog", { name: "How borrowing works" });
    const video = modal.querySelector("video");
    expect(video).toHaveAttribute("src", "/videos/dockyard-how-borrowing-works-v1.mp4");
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("playsinline");
    expect(video?.querySelector("track")).toHaveAttribute("kind", "captions");
    expect(screen.getByRole("link", { name: "Download video" })).toHaveAttribute("download");
    expect(document.documentElement.style.overflow).toBe("hidden");
  });

  it("unmounts playback and restores existing scroll styling on close", async () => {
    document.documentElement.style.overflow = "auto";
    const { container } = render(<HowBorrowingWorks />);
    await userEvent.click(screen.getByRole("button", { name: "How borrowing works" }));
    await userEvent.click(screen.getByRole("button", { name: "Close video" }));
    expect(container.querySelector("video")).toBeNull();
    expect(document.documentElement.style.overflow).toBe("auto");
  });

  it("syncs native dismissal and can reopen", async () => {
    render(<HowBorrowingWorks />);
    await userEvent.click(screen.getByRole("button", { name: "How borrowing works" }));
    fireEvent(screen.getByRole("dialog"), new Event("close"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "How borrowing works" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    render(<HowBorrowingWorks />);
    await userEvent.click(screen.getByRole("button", { name: "How borrowing works" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers recovery on failure and clears the error on reopening", async () => {
    render(<HowBorrowingWorks />);
    await userEvent.click(screen.getByRole("button", { name: "How borrowing works" }));
    fireEvent.error(screen.getByLabelText("How borrowing with Turret works"));
    expect(screen.getByRole("alert")).toHaveTextContent("Try downloading it instead");
    await userEvent.click(screen.getByRole("button", { name: "Close video" }));
    await userEvent.click(screen.getByRole("button", { name: "How borrowing works" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("restores scrolling if the page unmounts during playback", async () => {
    const { unmount } = render(<HowBorrowingWorks />);
    await userEvent.click(screen.getByRole("button", { name: "How borrowing works" }));
    unmount();
    expect(document.documentElement.style.overflow).toBe("");
  });
});
