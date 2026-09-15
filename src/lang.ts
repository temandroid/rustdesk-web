// English strings generated from src/lang/en.rs (keys whose display text
// differs from the key). Other locales fall back to the key itself.
import en from "./proto/lang_en.json";

const EN: Record<string, string> = en as Record<string, string>;

export function translate(_locale: string, text: string): string {
  const v = EN[text];
  return v !== undefined && v !== "" ? v : text;
}
