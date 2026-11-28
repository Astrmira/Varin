const attachments = new WeakMap<object, Buffer>();

/** Internal readers consume the transferred bytes directly. JSON callers keep the same public shape. */
export function attachKernelBytes(result: Record<string, unknown>, bytes: Buffer): void {
  if (result.bytesBase64 !== '') throw new Error('Invalid binary result metadata');
  attachments.set(result, bytes);
  Object.defineProperty(result, 'bytesBase64', {
    enumerable: true, configurable: true,
    get() { return bytes.toString('base64'); },
  });
}

export function kernelResultBytes(result: { bytesBase64: string }): Buffer {
  return attachments.get(result) ?? Buffer.from(result.bytesBase64, 'base64');
}
