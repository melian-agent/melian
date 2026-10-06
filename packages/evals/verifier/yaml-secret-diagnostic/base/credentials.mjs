import { parse } from "yaml";
export function readCredentials(text) {
  try {
    return parse(text);
  } catch {
    console.error("Invalid credential YAML");
    return undefined;
  }
}
