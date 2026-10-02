import { describe, expect, it, vi } from "vitest";
import { createUiRequestSender } from "./ui-request-router.mjs";

function harness() {
  const sent = [];
  const published = [];
  const sender = createUiRequestSender({
    send: (message) => {
      sent.push(message);
      return true;
    },
    publishExtensionUi: (request) => published.push(request),
    hostInstanceId: "host-a",
    getSessionEpoch: () => 7,
  });
  return { sender, sent, published };
}

describe("host UI request routing", () => {
  it.each([
    {
      type: "unified_submit_request",
      id: "submit-a",
      text: "steer now",
      editorRevision: 3,
    },
    { type: "clipboard_read_image_request", id: "clipboard-a" },
    {
      type: "editor_source_cleared",
      intentId: "intent-a",
      editorRevision: 3,
      editor: { revision: 4, text: "", attachments: [] },
    },
  ])("keeps private $type off the typed extension-UI plane", (request) => {
    const { sender, sent, published } = harness();

    sender(request);

    expect(published).toEqual([]);
    expect(sent).toEqual([request]);
    expect(sent[0]).toBe(request);
  });

  it("routes only a discriminated extension request through both presentation paths", () => {
    const { sender, sent, published } = harness();

    sender({ type: "extension_ui_request", method: "notify", message: "ready" });

    expect(published).toEqual([
      {
        type: "extension_ui_request",
        id: "extension-ui-1",
        method: "notify",
        message: "ready",
        hostInstanceId: "host-a",
        sessionEpoch: 7,
      },
    ]);
    expect(sent).toEqual(published);
  });

  it("does not infer authority-plane eligibility from a private message's fields", () => {
    const { sender, sent, published } = harness();
    const privateRequest = {
      type: "unified_submit_request",
      id: "submit-b",
      method: "notify",
      text: "field-confusion probe",
    };

    sender(privateRequest);

    expect(published).toEqual([]);
    expect(sent).toEqual([privateRequest]);
  });

  it("validates its routing dependencies", () => {
    expect(() =>
      createUiRequestSender({
        send: vi.fn(),
        publishExtensionUi: undefined,
        hostInstanceId: "host-a",
        getSessionEpoch: () => 0,
      }),
    ).toThrow("publishExtensionUi must be a function");
  });
});
