export function importReview(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    console.error(error.message);
    return undefined;
  }
}
