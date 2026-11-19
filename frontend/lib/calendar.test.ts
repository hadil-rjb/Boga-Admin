import { describe, expect, it } from "vitest";
import { dropTime, gmtLabel, hourLanes, minutesOf, monday, monthCells, moveStatus, tileTop } from "./calendar";

const d = (s: string) => new Date(s + "T00:00:00");
const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;

describe("monday", () => {
  it("returns the Monday of the week, Sunday included", () => {
    expect(iso(monday(d("2026-11-19")))).toBe("2026-11-16");
    expect(iso(monday(d("2026-11-22")))).toBe("2026-11-16");
    expect(iso(monday(d("2026-11-16")))).toBe("2026-11-16");
  });
});

describe("monthCells", () => {
  it("starts on a Monday and covers whole weeks", () => {
    const c = monthCells(d("2026-11-10"));
    expect(iso(c[0])).toBe("2026-10-26");
    expect(c.length % 7).toBe(0);
    expect(iso(c[c.length - 1])).toBe("2026-12-06");
  });
  it("drops a sixth row that holds no day of the month", () => {
    expect(monthCells(d("2027-02-01")).length).toBe(28);
  });
});

describe("minutesOf", () => {
  it("reads HH:MM and falls back to 09:00", () => {
    expect(minutesOf("13:45")).toBe(825);
    expect(minutesOf("")).toBe(540);
    expect(minutesOf("nope")).toBe(540);
  });
});

describe("dropTime", () => {
  it("moves to the dropped hour and keeps the minutes", () => {
    expect(dropTime("09:30", 14)).toBe("14:30");
    expect(dropTime("", 7)).toBe("07:00");
  });
});

describe("hourLanes", () => {
  it("shares the width between articles whose tiles would overlap", () => {
    const L = hourLanes([{ time: "09:00" }, { time: "09:20" }, { time: "09:40" }, { time: "11:00" }]);
    expect(L).toEqual([{ i: 0, n: 3 }, { i: 1, n: 3 }, { i: 2, n: 3 }, { i: 0, n: 1 }]);
  });
  it("gives articles far enough apart the full width", () => {
    expect(hourLanes([{ time: "09:00" }, { time: "09:40" }])).toEqual([{ i: 0, n: 1 }, { i: 0, n: 1 }]);
  });
});

describe("tileTop", () => {
  it("places a tile at its time and keeps it inside the day", () => {
    expect(tileTop("10:30", 100)).toBe(1060);
    expect(tileTop("23:59", 100)).toBe(24 * 100 - 56);
  });
});

describe("moveStatus", () => {
  const t = "2026-11-19";
  it("schedules a draft moved to the future and drafts one moved to the past", () => {
    expect(moveStatus("Draft", "2026-11-25", t)).toBe("Scheduled");
    expect(moveStatus("Scheduled", "2026-11-10", t)).toBe("Draft");
  });
  it("keeps a live article live in the past and unschedules to a draft", () => {
    expect(moveStatus("Live", "2026-11-10", t)).toBe("Live");
    expect(moveStatus("Scheduled", "", t)).toBe("Draft");
  });
  it("sets a live article moved to the future back to Scheduled", () => {
    expect(moveStatus("Live", "2026-11-25", t)).toBe("Scheduled");
  });
});

describe("gmtLabel", () => {
  it("writes the offset like the Planner", () => {
    expect(gmtLabel(-60)).toBe("GMT+1");
    expect(gmtLabel(0)).toBe("GMT");
    expect(gmtLabel(330)).toBe("GMT-5:30");
  });
});
