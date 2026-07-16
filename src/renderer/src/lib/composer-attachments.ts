export interface ImageAttachment {
  name: string;
  path: string;
  dataUrl: string;
}

export interface FileAttachment {
  name: string;
  path: string;
}

export type ReplicatedComposerAttachment =
  | { kind: "image"; name: string; path: string; dataUrl: string }
  | { kind: "file"; name: string; path: string };

export function serializeComposerAttachments(
  images: ImageAttachment[],
  files: FileAttachment[],
): ReplicatedComposerAttachment[] {
  return [
    ...images.map((item) => ({ kind: "image" as const, ...item })),
    ...files.map((item) => ({ kind: "file" as const, ...item })),
  ];
}

export function parseReplicatedAttachments(values: unknown[]): {
  images: ImageAttachment[];
  files: FileAttachment[];
} {
  const images: ImageAttachment[] = [];
  const files: FileAttachment[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const item = value as Partial<ReplicatedComposerAttachment>;
    if (typeof item.name !== "string" || typeof item.path !== "string") continue;
    if (item.kind === "image" && typeof item.dataUrl === "string") {
      images.push({ name: item.name, path: item.path, dataUrl: item.dataUrl });
    } else if (item.kind === "file") {
      files.push({ name: item.name, path: item.path });
    }
  }
  return { images, files };
}

export function textWithPrependedFilePaths(current: string, paths: string[]): string {
  if (paths.length === 0) return current;
  const separator = current.length === 0 || /^\r?\n/.test(current) ? "" : "\n";
  return `${paths.join("\n")}${separator}${current}`;
}

export function textWithAppendedFilePaths(current: string, paths: string[]): string {
  if (paths.length === 0) return current;
  const separator = current.length === 0 || /\s$/.test(current) ? "" : "\n";
  return `${current}${separator}${paths.join("\n")}`;
}

/** Convert retained runtime image payloads back into composer-owned files. */
export function restorationImagesToComposerAttachments(
  values: unknown[],
): ReplicatedComposerAttachment[] {
  const result: ReplicatedComposerAttachment[] = [];
  for (const [index, value] of values.entries()) {
    let dataUrl: string | undefined;
    if (typeof value === "string" && /^data:image\//.test(value)) dataUrl = value;
    else if (value && typeof value === "object") {
      const image = value as { data?: unknown; dataUrl?: unknown; mimeType?: unknown };
      if (typeof image.dataUrl === "string" && /^data:image\//.test(image.dataUrl)) {
        dataUrl = image.dataUrl;
      } else if (typeof image.data === "string") {
        dataUrl = image.data.startsWith("data:image/")
          ? image.data
          : `data:${typeof image.mimeType === "string" ? image.mimeType : "image/png"};base64,${image.data}`;
      }
    }
    if (dataUrl) {
      result.push({ kind: "image", name: `restored-image-${index + 1}.png`, path: "", dataUrl });
    }
  }
  return result;
}

export function runtimeImagesFromAttachments(images: ImageAttachment[]): Array<{
  data: string;
  mimeType: string;
  dataUrl: string;
}> {
  return images.map((attachment) => {
    const comma = attachment.dataUrl.indexOf(",");
    const header = attachment.dataUrl.slice(0, comma);
    return {
      data: attachment.dataUrl.slice(comma + 1),
      mimeType: /^data:([^;]+)/.exec(header)?.[1] ?? "image/png",
      dataUrl: attachment.dataUrl,
    };
  });
}
