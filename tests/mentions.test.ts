import { describe, expect, test } from "bun:test";
import { parseMentions } from "../server/mentions";

const agents = [
  { id: "a", name: "Alice" },
  { id: "b", name: "Bob" },
  { id: "bb", name: "BobBuilder" },
  { id: "x", name: "小明" },
];

describe("parseMentions", () => {
  test("finds mentions in first-mention order without duplicates", () => {
    expect(parseMentions("@Bob 和 @Alice 看看，@bob 也是", agents)).toEqual(["b", "a"]);
  });
  test("prefers the longest matching name", () => {
    expect(parseMentions("@BobBuilder 你好", agents)).toEqual(["bb"]);
  });
  test("latin names need a word boundary", () => {
    expect(parseMentions("@Bobby hi", agents)).toEqual([]);
    expect(parseMentions("@Bob,hi", agents)).toEqual(["b"]);
  });
  test("CJK names match without spaces", () => {
    expect(parseMentions("@小明你看下", agents)).toEqual(["x"]);
  });
  test("ignores emails and code", () => {
    expect(parseMentions("mail bob@Alice.com", agents)).toEqual([]);
    expect(parseMentions("`@Alice` 和 ```\n@Bob\n``` 不算", agents)).toEqual([]);
  });
  test("unknown names are ignored", () => {
    expect(parseMentions("@Carol hi", agents)).toEqual([]);
  });
});
