import { it, expect } from "vitest";
import {
  parseJson,
  identifier,
  activeLessons,
  questions,
  resourcesFromSummary,
} from "../src/protocol.js";
it("retains exact large numeric IDs while preserving strings and ordinary numbers", () => {
  const d = parseJson(
    '{"lessonId":1654713171234567890,"name":"id 1654713171234567890","time":1700000000000,"value":1.2}',
  );
  expect(d.lessonId).toBe("1654713171234567890");
  expect(d.name).toBe("id 1654713171234567890");
  expect(d.time).toBe(1700000000000);
  expect(() => identifier(1654713171234567890)).toThrow();
});
it("normalizes active lesson IDs and explicitly published questions", () => {
  expect(
    activeLessons({
      data: {
        onLessonClassrooms: [
          {
            lessonId: "1654713171234567890",
            classroomId: 32,
            classroomName: "测试",
          },
        ],
      },
    })[0],
  ).toMatchObject({
    id: "1654713171234567890",
    classroomId: "32",
    status: "active",
  });
  const rows = questions(
    {
      data: {
        slides: [
          {
            id: 10,
            cover: "https://a.xuetangx.com/a.jpg",
            problem: {
              problemId: 22,
              problemType: 1,
              body: "题目",
              options: ["A选项", "B选项"],
            },
          },
        ],
      },
    },
    "9",
    "8",
    new Set(["22"]),
  );
  expect(rows[0]).toMatchObject({
    id: "22",
    type: "single",
    published: true,
    options: [
      { key: "A", text: "A选项" },
      { key: "B", text: "B选项" },
    ],
  });
  expect(
    questions(
      { data: { slides: [{ id: 10, problem: { id: 22, type: 1 } }] } },
      "9",
      "8",
      new Set(),
    )[0].published,
  ).toBe(false);
});
it("collects stable resource IDs and retains remote capabilities only in the private record", () => {
  const r = resourcesFromSummary(
    "lesson1",
    { presentations: [{ id: "7", title: "第一讲" }] },
    {
      "7": {
        slides: [
          { id: "9", cover: "https://cdn.xuetangx.com/9.jpg?token=signed" },
        ],
      },
    },
    { live: [{ url: "https://cdn.xuetangx.com/v.mp4" }] },
  );
  expect(r).toHaveLength(2);
  expect(new Set(r.map((x) => x.id)).size).toBe(2);
  expect(r[0].kind).toBe("slide");
  expect(r[1].kind).toBe("video");
});
