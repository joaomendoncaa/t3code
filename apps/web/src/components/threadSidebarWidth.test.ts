import { describe, expect, it } from "vite-plus/test";
import {
  clampThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  THREAD_SIDEBAR_MIN_WIDTH,
} from "./threadSidebarWidth";

describe("resolveThreadSidebarMaximumWidth", () => {
  it("never drops below a raised minimum on a narrow viewport", () => {
    expect(resolveThreadSidebarMaximumWidth(800, 238)).toBe(238);
    expect(resolveThreadSidebarMaximumWidth(1200, 238)).toBe(560);
  });
});

describe("clampThreadSidebarWidth", () => {
  it("widens a stored width below a raised minimum", () => {
    expect(clampThreadSidebarWidth(208, 238, 560)).toBe(238);
  });

  it("keeps widths inside the range and caps wide ones", () => {
    expect(clampThreadSidebarWidth(300, 238, 560)).toBe(300);
    expect(clampThreadSidebarWidth(900, 238, 560)).toBe(560);
  });
});
