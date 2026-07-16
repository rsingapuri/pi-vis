/** Convert raw Electron IPC failures at UI boundaries into safe copy. */
export function describeIpcError(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const stripped = message.replace(/^Error invoking remote method '[^']+':\s*/i, "");
  if (
    /Session changed (before query dispatch|during query)|Session lifecycle changed before runtime resynchronization completed|Authority-frame baseline is not available from this host|authority attach/i.test(
      stripped,
    )
  ) {
    return undefined;
  }
  // Keep diagnostics useful without exposing Electron's handler wrapper in a toast.
  console.error("IPC operation failed", error);
  return "The operation could not be completed. Please try again.";
}
