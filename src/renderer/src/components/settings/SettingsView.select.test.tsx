// @vitest-environment jsdom
import { type ReactElement, act } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsSelect } from "./SettingsView.js";

vi.mock("../auth/LoginTerminal.js", () => ({ LoginTerminal: () => null }));

const options = [
  { value: "alpha", label: "Alpha Sans" },
  { value: "beta", label: "Beta Serif With A Deliberately Long Family Name" },
  { value: "gamma", label: "Gamma Mono" },
] as const;

function mount(node: ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => flushSync(() => root.render(node)));
  return { container, root };
}

function key(target: Element, value: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: value,
    bubbles: true,
    cancelable: true,
  });
  act(() => target.dispatchEvent(event));
  return event;
}

function optionButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("[role='option']")];
}

describe("SettingsSelect", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal(
      "MutationObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("uses FadeText and moves one roving focus with navigation and typeahead", () => {
    const onChange = vi.fn();
    const { container, root } = mount(
      <SettingsSelect
        value="beta"
        options={options}
        onChange={onChange}
        ariaLabel="Transcript body font family"
      />,
    );
    const trigger = container.querySelector<HTMLButtonElement>(".settings-select__trigger")!;

    expect(trigger.classList).toContain("fade-scope");
    expect(trigger.getAttribute("aria-label")).toBe(
      `Transcript body font family: ${options[1].label}`,
    );
    expect(trigger.querySelector(".settings-select__label.fade-text")?.getAttribute("title")).toBe(
      options[1].label,
    );

    act(() => trigger.click());
    let rows = optionButtons(container);
    expect(container.querySelector("[role='listbox']")?.getAttribute("aria-label")).toBe(
      "Transcript body font family",
    );
    expect(document.activeElement).toBe(rows[1]);
    expect(rows.map((row) => row.tabIndex)).toEqual([-1, 0, -1]);
    expect(rows.every((row) => row.classList.contains("fade-scope"))).toBe(true);
    expect(
      rows[1]?.querySelector(".settings-select__option-label.fade-text")?.getAttribute("title"),
    ).toBe(options[1].label);

    key(rows[1]!, "ArrowDown");
    rows = optionButtons(container);
    expect(document.activeElement).toBe(rows[2]);
    key(rows[2]!, "ArrowDown");
    rows = optionButtons(container);
    expect(document.activeElement).toBe(rows[0]);
    key(rows[0]!, "ArrowUp");
    rows = optionButtons(container);
    expect(document.activeElement).toBe(rows[2]);
    key(rows[2]!, "Home");
    rows = optionButtons(container);
    expect(document.activeElement).toBe(rows[0]);
    key(rows[0]!, "End");
    rows = optionButtons(container);
    expect(document.activeElement).toBe(rows[2]);
    key(rows[2]!, "b");
    rows = optionButtons(container);
    expect(document.activeElement).toBe(rows[1]);
    expect(rows.map((row) => row.tabIndex)).toEqual([-1, 0, -1]);
    expect(onChange).not.toHaveBeenCalled();

    act(() => flushSync(() => root.unmount()));
  });

  it("selects once and restores trigger focus for selection and Escape", () => {
    const onChange = vi.fn();
    const { container, root } = mount(
      <SettingsSelect
        value="beta"
        options={options}
        onChange={onChange}
        ariaLabel="Title font family"
      />,
    );
    const trigger = container.querySelector<HTMLButtonElement>(".settings-select__trigger")!;

    key(trigger, "ArrowDown");
    let rows = optionButtons(container);
    expect(document.activeElement).toBe(rows[1]);
    key(rows[1]!, "End");
    rows = optionButtons(container);
    key(rows[2]!, "Enter");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("gamma");
    expect(container.querySelector("[role='listbox']")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    key(trigger, "g");
    rows = optionButtons(container);
    expect(document.activeElement).toBe(rows[2]);
    const leakedEscape = vi.fn();
    window.addEventListener("keydown", leakedEscape);
    const escapeEvent = key(rows[2]!, "Escape");
    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(leakedEscape).not.toHaveBeenCalled();
    expect(container.querySelector("[role='listbox']")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    window.removeEventListener("keydown", leakedEscape);

    act(() => flushSync(() => root.unmount()));
  });

  it("reconciles focus when an open list replaces every option with the same length", () => {
    const onChange = vi.fn();
    const { container, root } = mount(
      <SettingsSelect
        value="beta"
        options={options}
        onChange={onChange}
        ariaLabel="Title font family"
      />,
    );
    const trigger = container.querySelector<HTMLButtonElement>(".settings-select__trigger")!;
    act(() => trigger.click());
    expect(document.activeElement?.textContent).toBe(options[1].label);

    const replacements = [
      { value: "delta", label: "Delta Sans" },
      { value: "epsilon", label: "Epsilon Serif" },
      { value: "zeta", label: "Zeta Mono" },
    ] as const;
    act(() =>
      flushSync(() =>
        root.render(
          <SettingsSelect
            value="epsilon"
            options={replacements}
            onChange={onChange}
            ariaLabel="Title font family"
          />,
        ),
      ),
    );
    expect(document.activeElement?.textContent).toBe("Epsilon Serif");
    expect(optionButtons(container).map((row) => row.tabIndex)).toEqual([-1, 0, -1]);

    const reordered = [replacements[0], replacements[2], replacements[1]] as const;
    act(() =>
      flushSync(() =>
        root.render(
          <SettingsSelect
            value="delta"
            options={reordered}
            onChange={onChange}
            ariaLabel="Title font family"
          />,
        ),
      ),
    );
    expect(document.activeElement?.textContent).toBe("Epsilon Serif");
    expect(optionButtons(container).map((row) => row.tabIndex)).toEqual([-1, -1, 0]);

    const noSelection = [
      { value: "eta", label: "Eta Sans" },
      { value: "theta", label: "Theta Serif" },
      { value: "iota", label: "Iota Mono" },
    ] as const;
    act(() =>
      flushSync(() =>
        root.render(
          <SettingsSelect
            value="missing"
            options={noSelection}
            onChange={onChange}
            ariaLabel="Title font family"
          />,
        ),
      ),
    );
    expect(document.activeElement?.textContent).toBe("Eta Sans");
    expect(optionButtons(container).map((row) => row.tabIndex)).toEqual([0, -1, -1]);

    const leakedEscape = vi.fn();
    window.addEventListener("keydown", leakedEscape);
    const escapeEvent = key(document.activeElement!, "Escape");
    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(leakedEscape).not.toHaveBeenCalled();
    expect(container.querySelector("[role='listbox']")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    window.removeEventListener("keydown", leakedEscape);

    act(() => flushSync(() => root.unmount()));
  });

  it("closes before Tab resumes from the trigger", () => {
    const { container, root } = mount(
      <SettingsSelect
        value="beta"
        options={options}
        onChange={vi.fn()}
        ariaLabel="Transcript header and thinking font family"
      />,
    );
    const trigger = container.querySelector<HTMLButtonElement>(".settings-select__trigger")!;
    act(() => trigger.click());
    const selected = optionButtons(container)[1]!;
    const tab = key(selected, "Tab");

    expect(tab.defaultPrevented).toBe(false);
    expect(container.querySelector("[role='listbox']")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    act(() => flushSync(() => root.unmount()));
  });
});
