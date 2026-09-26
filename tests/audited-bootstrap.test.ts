import { describe, test, expect } from "bun:test";
import { ConfigurationManager } from "../src/configuration";
import { TestClock } from "../src/clock";

describe("audited bootstrap configuration path", () => {
  test("a one-voter bootstrap commits through ordinary proposer quorum", async () => {
    const manager = new ConfigurationManager(new TestClock(), () => "a", () => {});
    await manager.load(["a"]);
    const proposal = manager.begin(["a", "b"], "a");
    expect(proposal.acknowledgements).toEqual(["a"]);
    expect(manager.readyToCommit()).toBe(true);
    const committed = await manager.commit(proposal.id);
    expect(committed.version).toBe(1n);
    expect(committed.voters).toEqual(["a", "b"]);
  });

  test("an empty receiver accepts the committed bootstrap proof using the bootstrap proposer as the authorizing voter", async () => {
    const receiver = new ConfigurationManager(new TestClock(), () => "b", () => {});
    await receiver.load([]);
    const proposal = {
      id: "bootstrap-test",
      baseVersion: 0n,
      nextVersion: 1n,
      voters: ["a", "b"],
      proposer: "a",
      acknowledgements: ["a"],
    };
    const committed = await receiver.installCommitted(proposal, "a");
    expect(committed.version).toBe(1n);
    expect(committed.voters).toEqual(["a", "b"]);
  });

  test("a bootstrap proof without an acknowledgement is rejected", async () => {
    const receiver = new ConfigurationManager(new TestClock(), () => "b", () => {});
    await receiver.load([]);
    const proposal = {
      id: "bootstrap-test-no-ack",
      baseVersion: 0n,
      nextVersion: 1n,
      voters: ["a", "b"],
      proposer: "a",
      acknowledgements: [],
    };
    await expect(receiver.installCommitted(proposal, "a")).rejects.toThrow("quorum");
  });
});
