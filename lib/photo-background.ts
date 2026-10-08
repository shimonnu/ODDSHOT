/** Finish the initial upload before draining the filename revision queued by a late title. */
export async function processPhotoBackground(
  titles: Promise<void> | undefined,
  dispatch: () => Promise<unknown>,
  onFailure: () => void,
): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(dispatch),
    titles ?? Promise.resolve(),
  ]);
  for (const result of results) {
    if (result.status === "rejected") onFailure();
  }
  if (!titles) return;
  // The first upload may hold the lease when titles finish; its queued revision is now ready.
  try { await dispatch(); }
  catch { onFailure(); }
}
