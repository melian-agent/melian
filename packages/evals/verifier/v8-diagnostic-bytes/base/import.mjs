export function importReview(text) {
  try {
    return JSON.parse(text);
  } catch {
    console.error("Invalid review JSON");
    return undefined;
  }
}
