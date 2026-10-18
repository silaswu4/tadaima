import assert from "node:assert/strict";
import { test } from "node:test";
import { voiceAgentConfig } from "./agent-config";
import { createRoomAgentTools } from "../../spatial/rooms/agent-tools";

/** The hosted agent must advertise the same tools the active room can execute. */
test("voice agent configuration and canonical room tool handlers stay in sync", () => {
  const unused = (): never => { throw new Error("Configuration inspection must not execute a room action."); };
  const handlers = createRoomAgentTools({ projectId: "configuration-test", active: () => false, context: unused,
    refresh: unused, propose: unused, apply: unused, proposal: unused, setBudget: unused,
    search: unused, preview: unused, place: unused, spot: unused, move: unused, store: unused,
    remove: unused, replace: unused, undo: unused, liveSearch: false });
  const tools = voiceAgentConfig.conversation_config.agent.prompt.tools;
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), Object.keys(handlers).sort());
  for (const name of ["preview_product", "place_product"]) {
    const tool = tools.find((entry) => entry.name === name)!;
    assert.equal(tool.type, "client"); assert.equal(tool.expects_response, true);
    assert.equal(tool.parameters.properties.product_id?.type, "string");
    assert.equal(tool.parameters.properties.job_id?.type, "string");
  }
});
