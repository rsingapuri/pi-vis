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
