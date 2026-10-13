import { describe, expect, it } from "vitest";
import { resolveLang, translate } from "../src/lang";

describe("lang (port of src/lang.rs)", () => {
  it("follows the saved language, then the browser locale", () => {
    expect(resolveLang("", "ru-RU")).toBe("ru");
    expect(resolveLang("", "ru_RU")).toBe("ru");
    expect(resolveLang("default", "ru")).toBe("ru");
    expect(resolveLang("en", "ru-RU")).toBe("en");
  });

  it("translates to Russian and falls back to English, then to the key", () => {
    expect(translate("ru-RU", "Address book", "")).toBe("Адресная книга");
    expect(translate("en-US", "Address book", "")).toBe("Address book");
    expect(translate("ru-RU", "no-such-key-zz", "")).toBe("no-such-key-zz");
    // unknown locale uses the English table (desk_tip has an English text)
    expect(translate("xx", "desk_tip", "")).not.toBe("desk_tip");
  });

  it("fills {placeholders}", () => {
    expect(translate("en", "{3} sessions", "")).toContain("3");
  });
});
