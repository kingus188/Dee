// Dee uses the Chinese editor strings; no desktop locale state is required.
export function t(message: string, ...values: unknown[]): string {
  return message.replace(/\{(\d+)\}/g, (marker, index) => String(values[Number(index)] ?? marker));
}
