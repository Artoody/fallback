import assert from "node:assert/strict";
import test from "node:test";
import { createStateEnvelope, StateEnvelopeError } from "../../src/codex/stateEnvelope.js";

const SECRET = "11".repeat(32);

test("state envelopes round-trip and bind to the authenticated client", () => {
  const envelope = createStateEnvelope({ secret: SECRET });
  const payload = {
    version: 1,
    steps: [{ type: "thought", signature: "opaque", summary: [] }],
    coveredItemIds: ["item_1"],
    calls: {},
  };
  const token = envelope.seal(payload, "client-a");
  assert.match(token, /^gemini-state\.v1\./);
  assert.deepEqual(envelope.open(token, "client-a"), payload);
  assert.throws(
    () => envelope.open(token, "client-b"),
    (error) => error instanceof StateEnvelopeError && error.code === "invalid_state_envelope"
  );
});

test("tampering, secret rotation, and unknown versions fail closed", () => {
  const first = createStateEnvelope({ secret: SECRET });
  const second = createStateEnvelope({ secret: "22".repeat(32) });
  const token = first.seal({ version: 1, steps: [] }, "client");
  const last = token.at(-1);
  const tampered = token.slice(0, -1) + (last === "A" ? "B" : "A");

  assert.throws(() => first.open(tampered, "client"), StateEnvelopeError);
  assert.throws(() => second.open(token, "client"), StateEnvelopeError);
  assert.throws(
    () => first.open(token.replace(".v1.", ".v9."), "client"),
    (error) => error.code === "unsupported_state_envelope_version"
  );
});

test("decompression limits reject oversized reasoning state", () => {
  const generous = createStateEnvelope({ secret: SECRET, maxPlaintextBytes: 4096 });
  const token = generous.seal({ version: 1, steps: [{ type: "thought", summary: ["x".repeat(2000)] }] }, "c");
  const strict = createStateEnvelope({ secret: SECRET, maxPlaintextBytes: 128 });
  assert.throws(
    () => strict.open(token, "c"),
    (error) =>
      error instanceof StateEnvelopeError &&
      ["state_envelope_too_large", "invalid_state_envelope"].includes(error.code)
  );
});

test("configuration requires exactly 32 bytes", () => {
  assert.throws(() => createStateEnvelope({ secret: "" }), /required/);
  assert.throws(() => createStateEnvelope({ secret: "too-short" }), /32 bytes/);
});
