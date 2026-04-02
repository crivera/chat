import { describe, test, expect } from "bun:test";

/**
 * Tests for the BrowserOverlay handleLoad logic.
 *
 * The bug: WebKit returns null for contentDocument on cross-origin iframes
 * (e.g. http://localhost:65275/ loaded inside views://mainview/).
 * The old code treated null as "failed to load" and opened the URL externally.
 *
 * The fix: null contentDocument means cross-origin — assume loaded OK since
 * canEmbed already verified the URL is embeddable.
 */

/**
 * Mirrors the fixed handleLoad logic from App.tsx BrowserOverlay.
 * Returns true if it would call openExternal, false otherwise.
 */
function shouldOpenExternal(
  contentDocument: {
    body: { innerHTML: string } | null;
  } | null,
): boolean {
  // This mirrors the fixed code:
  //   const doc = iframeRef.current?.contentDocument;
  //   if (doc && (!doc.body || doc.body.innerHTML === "")) {
  //     openExternal(url);
  //   }
  if (
    contentDocument &&
    (!contentDocument.body || contentDocument.body.innerHTML === "")
  ) {
    return true;
  }
  return false;
}

describe("BrowserOverlay handleLoad", () => {
  test("null contentDocument (cross-origin) does NOT open external", () => {
    // WebKit returns null for cross-origin iframe contentDocument
    expect(shouldOpenExternal(null)).toBe(false);
  });

  test("document with content does NOT open external", () => {
    expect(
      shouldOpenExternal({ body: { innerHTML: "<div>Hello</div>" } }),
    ).toBe(false);
  });

  test("document with empty body opens external (failed load)", () => {
    expect(shouldOpenExternal({ body: { innerHTML: "" } })).toBe(true);
  });

  test("document with null body opens external (broken page)", () => {
    expect(shouldOpenExternal({ body: null })).toBe(true);
  });
});
