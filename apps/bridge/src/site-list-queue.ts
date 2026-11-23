// Shared by the worker's message handler and Keep signed in expiry writes.
// Queue only storage work here; browser activity must remain outside it.
let tail: Promise<void> = Promise.resolve();

export const runSiteListMutation = <T>(work: () => Promise<T>): Promise<T> => {
  const result = tail.then(work);
  tail = result.then(() => undefined, () => undefined);
  return result;
};
