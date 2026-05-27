export async function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// TODO: Scan the project and reuse withTimeout wherever the same Promise.race +
// deadline + clearTimeout pattern appears, when the swap is straightforward.
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(onTimeout());
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
