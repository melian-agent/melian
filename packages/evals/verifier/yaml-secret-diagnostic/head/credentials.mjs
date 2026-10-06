import { parse } from "yaml";
export function readCredentials(text) {
  try {
    return parse(text);
  } catch (error) {
    console.error(error.message);
    return undefined;
  }
}
