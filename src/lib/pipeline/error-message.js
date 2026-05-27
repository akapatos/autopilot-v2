/**
 * Readable error string for logs and API responses (avoids "[object Object]").
 */
export function getErrorMessage(error) {
  return (
    error?.message ||
    (() => {
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    })() ||
    String(error)
  );
}
