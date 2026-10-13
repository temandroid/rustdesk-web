import { describe, expect, it } from "vitest";
import { deinterleave, nextStart, supportedChannels } from "../src/audio";

describe("audio (port of client.rs AudioHandler)", () => {
  it("accepts mono and stereo only", () => {
    expect(supportedChannels(1)).toBe(true);
    expect(supportedChannels(2)).toBe(true);
    expect(supportedChannels(6)).toBe(false);
  });

  it("splits interleaved stereo into planes", () => {
    const [l, r] = deinterleave(Float32Array.from([1, -1, 2, -2, 3, -3]), 2);
    expect(Array.from(l!)).toEqual([1, 2, 3]);
    expect(Array.from(r!)).toEqual([-1, -2, -3]);
  });

  it("schedules packets back to back with a small lead", () => {
    // empty queue: start a little ahead of now
    expect(nextStart(0, 10, 0.02)).toBeCloseTo(10.06);
    // queued: continue right after the previous packet
    expect(nextStart(10.1, 10, 0.02)).toBe(10.1);
    // fell behind (underrun): restart with the lead
    expect(nextStart(9.9, 10, 0.02)).toBeCloseTo(10.06);
  });

  it("drops audio that would play too far behind the picture", () => {
    expect(nextStart(10.6, 10, 0.02)).toBeNull();
  });
});
