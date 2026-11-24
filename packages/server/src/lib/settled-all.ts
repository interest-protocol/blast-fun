/** Retain ownership of every started operation even when a sibling fails first. */
export async function settledAll<const T extends readonly unknown[]>(tasks: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  try {
    return await Promise.all(tasks);
  } finally {
    await Promise.allSettled(tasks);
  }
}
