import assert from 'node:assert/strict';

/** The stdio fixtures deliver JSON to the real Rust handlers. Inline the private data-lane bytes there. */
export function jsonFixtureParams(method: string, params: unknown, binary?: Buffer): unknown {
  if (!binary) return params;
  assert(params && typeof params === 'object');
  if (method === 'text.serialize') {
    if ('sourceBytesBase64' in params) {
      assert.equal(params.sourceBytesBase64, '');
      return { ...params, sourceBytesBase64: binary.toString('base64') };
    }
    assert.equal(binary.length, 0);
    return params;
  }
  assert(method === 'storage.putBlob.chunk' || method === 'text.decode', `Unexpected binary attachment for ${method}`);
  assert('bytesBase64' in params && params.bytesBase64 === '');
  return { ...params, bytesBase64: binary.toString('base64') };
}
