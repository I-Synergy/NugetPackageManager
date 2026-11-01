export default function createNonce(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}
