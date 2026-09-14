const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function getTransactionEventually(client, hash, options = {}) {
  const attempts = options.attempts ?? 30;
  const delayMs = options.delayMs ?? 1_000;
  if (!Number.isInteger(attempts) || attempts < 1) throw new TypeError('attempts must be a positive integer');

  let finalError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await client.getTransaction({hash});
    } catch (error) {
      finalError = error;
      if (attempt < attempts && delayMs > 0) await wait(delayMs);
    }
  }
  throw finalError;
}
