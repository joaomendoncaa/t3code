import { describe, expect, it } from "vite-plus/test";

import { museApprovalChoices, museApprovalOptions } from "./museProtocol.ts";

describe("Muse approval choices", () => {
  // The choices Muse 1.4.3 offers for a shell command: no `denied`, only `abort`.
  const shellApproval = {
    availableChoices: [
      { choiceId: "allow_once", label: "Allow once", decision: "approved", scope: "once" },
      {
        choiceId: "allow_local_prefix",
        label: "Always allow in this workspace: touch ...",
        decision: "approvedPolicyAmendment",
        scope: "localPersistent",
      },
      { choiceId: "abort", label: "Reject", decision: "abort", scope: "once" },
    ],
  };

  it("declines through abort when Muse offers no denied choice", () => {
    const choices = museApprovalChoices(shellApproval);
    expect(choices.get("decline")?.choiceId).toBe("abort");
    expect(choices.get("cancel")?.choiceId).toBe("abort");
    expect(museApprovalOptions(shellApproval)).toEqual([
      { decision: "accept", label: "Allow once" },
      { decision: "acceptAlways", label: "Always allow in this workspace: touch ..." },
      { decision: "decline", label: "Reject" },
    ]);
  });

  it("keeps denied and abort separate when Muse offers both", () => {
    const choices = museApprovalChoices({
      availableChoices: [
        { choiceId: "deny", label: "Deny", decision: "denied", scope: "once" },
        { choiceId: "abort", label: "Stop", decision: "abort", scope: "once" },
      ],
    });
    expect(choices.get("decline")?.choiceId).toBe("deny");
    expect(choices.get("cancel")?.choiceId).toBe("abort");
  });

  it.each([
    ["session", "acceptForSession"],
    ["localPersistent", "acceptAlways"],
    ["once", undefined],
    ["unknown", undefined],
    ["", undefined],
  ] as const)("maps policy amendments with scope %s to %s", (scope, decision) => {
    const choices = museApprovalChoices({
      availableChoices: [
        { choiceId: "choice", label: "Choice", decision: "approvedPolicyAmendment", scope },
      ],
    });
    expect([...choices.keys()]).toEqual(decision ? [decision] : []);
  });

  it("omits an unknown scope without hiding a recognized persistent choice", () => {
    const choices = museApprovalChoices({
      availableChoices: [
        {
          choiceId: "unknown",
          label: "Unknown scope",
          decision: "approvedPolicyAmendment",
          scope: "futureScope",
        },
        {
          choiceId: "persistent",
          label: "Always allow",
          decision: "approvedPolicyAmendment",
          scope: "localPersistent",
        },
      ],
    });
    expect([...choices].map(([decision, choice]) => [decision, choice.choiceId])).toEqual([
      ["acceptAlways", "persistent"],
    ]);
  });
});
