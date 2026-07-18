import { z } from "zod";

const BaseUiRequest = z.object({
  type: z.literal("extension_ui_request"),
  id: z.string(),
  operationId: z.string().optional(),
  hostInstanceId: z.string().uuid().optional(),
  sessionEpoch: z.number().int().nonnegative().optional(),
});

export const SelectUiRequestSchema = BaseUiRequest.extend({
  method: z.literal("select"),
  title: z.string(),
  options: z.array(z.string()),
  timeout: z.number().optional(),
});

export const ConfirmUiRequestSchema = BaseUiRequest.extend({
  method: z.literal("confirm"),
  title: z.string(),
  message: z.string().optional(),
  timeout: z.number().optional(),
});

export const InputUiRequestSchema = BaseUiRequest.extend({
  method: z.literal("input"),
  title: z.string(),
  placeholder: z.string().optional(),
  timeout: z.number().optional(),
});

export const EditorUiRequestSchema = BaseUiRequest.extend({
  method: z.literal("editor"),
  title: z.string(),
  prefill: z.string().optional(),
  timeout: z.number().optional(),
});

// Fire-and-forget (no response needed)
export const NotifyUiRequestSchema = BaseUiRequest.extend({
  method: z.literal("notify"),
  message: z.string(),
  notifyType: z.string().optional(),
});

// `statusText` is optional: pi sends `undefined` (which JSON.stringify omits
// from the wire) to clear an existing segment. See sessions-store.addUiRequest.
export const SetStatusUiRequestSchema = BaseUiRequest.extend({
  method: z.literal("setStatus"),
  statusKey: z.string(),
  statusText: z.string().optional(),
});

// `widgetLines` is optional for the same reason as `statusText` above — an
// absent payload field means "remove this widget".
export const SetWidgetUiRequestSchema = BaseUiRequest.extend({
  method: z.literal("setWidget"),
  widgetKey: z.string(),
  widgetLines: z.array(z.string()).optional(),
  widgetPlacement: z.string().optional(),
});

export const SetTitleUiRequestSchema = BaseUiRequest.extend({
  method: z.literal("setTitle"),
  title: z.string(),
});

export const SetEditorTextUiRequestSchema = BaseUiRequest.extend({
  method: z.literal("set_editor_text"),
  text: z.string(),
});

// Native provider authentication is app-owned, not an extension dialog. Updates
// reuse the same id/operationId so the authority plane replaces its surface.
export const ProviderAuthUiRequestSchema = BaseUiRequest.extend({
  method: z.literal("providerAuth"),
  providerName: z.string().max(160),
  authType: z.string().max(80),
  phase: z.enum(["oauth", "device", "prompt", "error"]),
  authUrl: z.string().max(4096).optional(),
  deviceCode: z.string().max(512).optional(),
  message: z.string().max(1000).optional(),
  prompt: z.string().max(1000).optional(),
  secret: z.boolean().optional(),
  options: z.array(z.string().max(240)).max(100).optional(),
});

export const ExtensionUiRequestSchema = z.discriminatedUnion("method", [
  SelectUiRequestSchema,
  ConfirmUiRequestSchema,
  InputUiRequestSchema,
  EditorUiRequestSchema,
  ProviderAuthUiRequestSchema,
  NotifyUiRequestSchema,
  SetStatusUiRequestSchema,
  SetWidgetUiRequestSchema,
  SetTitleUiRequestSchema,
  SetEditorTextUiRequestSchema,
]);

export type ExtensionUiRequest = z.infer<typeof ExtensionUiRequestSchema>;
export type SelectUiRequest = z.infer<typeof SelectUiRequestSchema>;
export type ConfirmUiRequest = z.infer<typeof ConfirmUiRequestSchema>;
export type InputUiRequest = z.infer<typeof InputUiRequestSchema>;
export type EditorUiRequest = z.infer<typeof EditorUiRequestSchema>;
export type ProviderAuthUiRequest = z.infer<typeof ProviderAuthUiRequestSchema>;
export type NotifyUiRequest = z.infer<typeof NotifyUiRequestSchema>;
export type SetStatusUiRequest = z.infer<typeof SetStatusUiRequestSchema>;
export type SetWidgetUiRequest = z.infer<typeof SetWidgetUiRequestSchema>;

export type DialogUiRequest = SelectUiRequest | ConfirmUiRequest | InputUiRequest | EditorUiRequest;

export function isDialogRequest(req: ExtensionUiRequest): req is DialogUiRequest {
  return ["select", "confirm", "input", "editor"].includes(req.method);
}

export const ExtensionUiResponseSchema = z.union([
  z.object({
    type: z.literal("extension_ui_response"),
    id: z.string(),
    value: z.string(),
  }),
  z.object({
    type: z.literal("extension_ui_response"),
    id: z.string(),
    confirmed: z.boolean(),
  }),
  z.object({
    type: z.literal("extension_ui_response"),
    id: z.string(),
    cancelled: z.literal(true),
  }),
]);

export type ExtensionUiResponse = z.infer<typeof ExtensionUiResponseSchema>;
