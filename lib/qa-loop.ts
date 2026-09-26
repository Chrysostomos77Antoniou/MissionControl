import { runFixAgent } from "../agents/fix-agent";
import { updateQa, getSuggestion } from "./suggestions";
import { logActivity } from "./memory";
import { latestRunId, runStatus, runFailureSummary, deleteBranch, openPullRequest, pullRequestState } from "../tools/github-ci";
import { notify } from "./notify";
import { withinBudget } from "./usage";
import { AGENT_BY_ID } from "../agents/registry";
import type { Suggestion } from "./types";

const MAX_ATTEMPTS = 3;

function branchFor(s: Suggestion): string {
  return `qa/s-${s.id.slice(0, 8)}`;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Okay → agent prepares the fix on a QA branch (triggers the emulator suite).
// Nothing goes live. Returns the new qa_status for the UI to start polling.
export async function startHandling(s: Suggestion): Promise<{ qa_status: string; result: string }> {
  const budget = await withinBudget();
  if (!budget.ok) {
    return { qa_status: "needs_owner", result: `⚠ Budget guard: ${budget.detail}` };
  }
  const branch = branchFor(s);
  // Always start fresh from current master (so the branch has the latest test
  // workflow + suite); a leftover branch from a prior run would be stale.
  await deleteBranch(branch);
  const { text, committed } = await runFixAgent(s, branch, null);

  if (!committed) {
    // Couldn't express it as a code change — owner must act. No QA loop.
    await updateQa(s.id, { result: text, outcome: "action_needed", qa_status: null });
    await logActivity(s.agent, "handle:needs-owner", s.title.slice(0, 100));
    return { qa_status: "needs_owner", result: text };
  }

  await sleep(6000); // let the push register a workflow run
  const runId = await latestRunId(branch);
  await updateQa(s.id, {
    result: text,
    outcome: "fixed",
    qa_status: "testing",
    qa_branch: branch,
    qa_run_id: runId,
    qa_attempts: 1,
    qa_log: null,
    pr_url: null,
  });
  await logActivity(s.agent, "qa:testing", `${branch} (attempt 1)`);
  return { qa_status: "testing", result: text };
}

// Client polls this. Advances the loop: check CI → on fail, send back to the
// agent to fix and re-test → on pass, mark ready for the owner to push live.
export async function tick(s: Suggestion): Promise<{ qa_status: string; qa_log?: string | null; pr_url?: string }> {
  if (s.qa_status !== "testing" || !s.qa_branch) {
    return { qa_status: s.qa_status ?? "needs_owner", qa_log: s.qa_log };
  }
  const branch = s.qa_branch;
  const runId = (await latestRunId(branch)) ?? s.qa_run_id;
  if (!runId) return { qa_status: "testing" };

  const { status, conclusion } = await runStatus(runId);
  if (status !== "completed") {
    await updateQa(s.id, { qa_run_id: runId });
    return { qa_status: "testing" };
  }

  if (conclusion === "success") {
    // QA passed -> open a pull request for HUMAN review. Mission Control never
    // merges and never applies migrations; the owner reviews, merges on
    // GitHub (where the normal CI + security scan run on the PR), and applies
    // any migration file themselves.
    const pr = await openPullRequest(
      branch,
      `mc: ${s.title.slice(0, 80)}`,
      `Proposed by the ${AGENT_BY_ID[s.agent]?.name ?? s.agent} agent in FootRank Mission Control.\n\n` +
        `Emulator QA passed on \`${branch}\`.\n\n**Human review required.** Mission Control will not merge this PR. ` +
        `If it contains a file under \`supabase/migrations/\`, it has NOT been applied to any database — review it and apply it yourself after merging.\n\n` +
        `---\n${s.body.slice(0, 3000)}`,
    );
    if (!pr.ok) {
      await updateQa(s.id, { qa_status: "needs_owner", qa_run_id: runId, qa_log: `QA passed, but opening the PR failed: ${pr.detail}` });
      await logActivity(s.agent, "qa:pr-failed", pr.detail.slice(0, 200));
      return { qa_status: "needs_owner", qa_log: pr.detail };
    }
    await updateQa(s.id, { qa_status: "passed", qa_run_id: runId, pr_url: pr.url });
    await logActivity(s.agent, "qa:passed", `${branch} -> PR ${pr.url}`);
    await notify(`✅ ${AGENT_BY_ID[s.agent]?.name ?? s.agent}: "${s.title}" passed QA — PR ready for your review: ${pr.url}`);
    return { qa_status: "passed", pr_url: pr.url };
  }

  // Failed. Either retry via the agent, or hand back to the owner.
  const attempts = s.qa_attempts ?? 1;
  const failure = await runFailureSummary(runId);
  if (attempts >= MAX_ATTEMPTS) {
    await updateQa(s.id, { qa_status: "needs_owner", qa_log: failure });
    await logActivity(s.agent, "qa:gave-up", `${branch} after ${attempts} attempts`);
    await notify(`⚠ ${AGENT_BY_ID[s.agent]?.name ?? s.agent}: "${s.title}" couldn't pass QA after ${attempts} tries — needs you.`);
    return { qa_status: "needs_owner", qa_log: failure };
  }

  const fresh = (await getSuggestion(s.id)) ?? s;
  const { committed } = await runFixAgent(fresh, branch, failure);
  if (!committed) {
    await updateQa(s.id, { qa_status: "needs_owner", qa_log: failure });
    return { qa_status: "needs_owner", qa_log: failure };
  }
  await sleep(6000);
  const newRun = await latestRunId(branch);
  await updateQa(s.id, { qa_status: "testing", qa_run_id: newRun, qa_attempts: attempts + 1 });
  await logActivity(s.agent, "qa:retesting", `${branch} (attempt ${attempts + 1})`);
  return { qa_status: "testing" };
}

// Owner clicked "I merged it" — CHECK (never perform) the merge. The merge
// itself only ever happens by the owner on GitHub.
export async function goLive(s: Suggestion): Promise<{ ok: boolean; detail: string }> {
  if (s.qa_status !== "passed" || !s.pr_url) {
    return { ok: false, detail: "Not ready — no pull request has been opened yet." };
  }
  const pr = await pullRequestState(s.pr_url);
  if (pr.state !== "merged") {
    return { ok: false, detail: `Not merged yet (${pr.detail}) Review and merge it on GitHub: ${s.pr_url}` };
  }
  await logActivity(s.agent, "live", `Owner merged ${s.pr_url}`);
  return { ok: true, detail: "PR merged by owner." };
}
