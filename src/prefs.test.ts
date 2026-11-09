import { describe, expect, it } from "vitest";
import { PREF_META, checkPref, getPref, importPrefs, resetPrefs, setPref } from "./prefs";

describe("preferences", () => {
  it("reads defaults when nothing is stored", () => {
    expect(getPref("uiScale")).toBe(100);
    expect(getPref("glow")).toBe(true);
  });

  it("pulls numbers into range and refuses the wrong kind of value", () => {
    expect(checkPref("uiScale", 500)).toBe(140);
    expect(checkPref("uiScale", 10)).toBe(80);
    expect(checkPref("uiScale", "120")).toBeUndefined();
    expect(checkPref("uiScale", Number.NaN)).toBeUndefined();
  });

  it("accepts only listed choices", () => {
    expect(checkPref("motion", "reduce")).toBe("reduce");
    expect(checkPref("motion", "sideways")).toBeUndefined();
  });

  it("takes a single character for a shortcut, lower-cased", () => {
    expect(checkPref("shortcutSettings", "K")).toBe("k");
    expect(checkPref("shortcutSettings", "ab")).toBeUndefined();
    expect(checkPref("shortcutSettings", "")).toBeUndefined();
  });

  it("changes and resets a preference", () => {
    setPref("uiFont", "mono");
    expect(getPref("uiFont")).toBe("mono");
    resetPrefs();
    expect(getPref("uiFont")).toBe(PREF_META.uiFont.default);
  });

  it("imports what is valid and skips the rest", () => {
    const applied = importPrefs({
      uiFont: "serif",
      motion: "nonsense",
      uiScale: "big",
      unknown: true,
      glow: false,
    });
    expect(applied).toBe(2);
    expect(getPref("uiFont")).toBe("serif");
    expect(getPref("motion")).toBe("system");
    expect(getPref("glow")).toBe(false);
    resetPrefs();
  });
});
