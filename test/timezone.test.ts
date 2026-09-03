import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOffsetTimeline,
  localDate,
  localizeHeader,
  localizeThread,
  offsetAt,
  offsetMinutesOf,
} from "../src/shared/dates.js";
import { message, USER } from "./helpers.js";

const at = (iso: string) => Date.parse(iso) / 1_000;
function mine(id: string, iso: string) {
  return { ...message(id, iso.slice(0, 10), USER), date: iso, timestamp: at(iso) };
}

test("days follow the user's own offset at the time, taken from their sent mail as a timeline", () => {
  assert.equal(offsetMinutesOf("2026-08-30T00:23+00:00"), 0);
  assert.equal(offsetMinutesOf("2026-08-29T20:23-04:00"), -240);
  assert.equal(offsetMinutesOf("2026-08-29T20:23"), undefined);
  const timeline = buildOffsetTimeline(
    [
      {
        id: "t",
        messages: [
          mine("a", "2019-03-01T10:00:00+05:30"),
          mine("b", "2020-06-01T10:00:00+05:30"),
          mine("c", "2023-01-10T10:00:00-05:00"),
          mine("d", "2023-07-10T10:00:00-04:00"),
          mine("e", "2026-08-20T10:00:00-04:00"),
          {
            ...message("x", "2026-08-30", "no-reply@doordash.com"),
            date: "2026-08-30T00:23+00:00",
            timestamp: at("2026-08-30T00:23:00Z"),
          },
        ],
      },
    ],
    USER,
  );
  assert.deepEqual(
    timeline.map(([, offset]) => offset),
    [330, -300, -240],
    "consecutive repeats collapse; the sender's mail never votes",
  );
  assert.equal(offsetAt(timeline, at("2019-12-01T00:00:00Z")), 330, "India in 2019");
  assert.equal(offsetAt(timeline, at("2023-03-01T00:00:00Z")), -300, "winter Eastern");
  assert.equal(offsetAt(timeline, at("2026-08-30T00:23:00Z")), -240, "summer Eastern");
  assert.equal(offsetAt([], at("2026-08-30T00:23:00Z")), 0, "no sent mail means UTC");
  // A DoorDash receipt stamped 00:23 UTC on Aug 30 is an Aug 29 order for a user in New York.
  assert.deepEqual(localDate(at("2026-08-30T00:23:00Z"), -240), { date: "2026-08-29T20:23-04:00", day: "2026-08-29" });
  const receipt = {
    id: "r",
    messages: [
      {
        ...message("r", "2026-08-30", "no-reply@doordash.com"),
        date: "2026-08-30T00:23+00:00",
        timestamp: at("2026-08-30T00:23:00Z"),
      },
    ],
  };
  assert.equal(localizeThread(receipt, timeline).messages[0]!.day, "2026-08-29");
  const old = {
    id: "o",
    messages: [
      {
        ...message("o", "2019-05-01", "no-reply@doordash.com"),
        date: "2019-05-01T22:00+00:00",
        timestamp: at("2019-05-01T22:00:00Z"),
      },
    ],
  };
  assert.equal(
    localizeThread(old, timeline).messages[0]!.day,
    "2019-05-02",
    "the same clock in 2019 is the next Indian day",
  );
  assert.equal(
    localizeHeader(
      {
        id: "m",
        threadId: "r",
        timestamp: at("2026-08-30T00:23:00Z"),
        day: "2026-08-30",
        fromName: "",
        fromEmail: "x@y",
        subject: "",
        labels: [],
        listId: "",
      },
      timeline,
    ).day,
    "2026-08-29",
  );
});
