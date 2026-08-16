import { expect, test } from "bun:test"
import { sanitizeMessages } from "../src/message-sanitizer.ts"

test("sanitizeMessages drops empty assistant messages", () => {
  const kept = { role: "user", content: "hello" }
  const messages = [
    kept,
    { role: "assistant", content: "" },
    { role: "assistant", content: null },
    { role: "assistant" },
    { role: "assistant", content: [{ type: "text", text: "" }, { type: "text" }] },
  ]

  expect(sanitizeMessages(messages)).toEqual([kept])
})

test("sanitizeMessages keeps assistant tool calls with empty content", () => {
  const message = {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "call-1", type: "function" }],
  }

  expect(sanitizeMessages([message])).toEqual([message])
})

test("sanitizeMessages keeps other roles and non-empty content untouched", () => {
  const messages = [
    { role: "user", content: "" },
    { role: "system", content: null },
    { role: "tool", content: "" },
    { role: "assistant", content: [{ type: "text", text: "response" }] },
    { role: "assistant", content: [{ type: "text" }, { type: "text", text: "response" }] },
  ]

  expect(sanitizeMessages(messages)).toBe(messages)
})
