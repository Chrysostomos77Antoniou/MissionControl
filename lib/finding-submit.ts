// Structured finding submission (7b): gate -> duplicate check -> save.
//
// Called by the save_suggestion tool (tools/registry.ts). The loop
// (agents/free-loop.ts) supplies the run's FindingRun (evidence ledger,
// history, what was already submitted this run) and the claim-guarded prose;
// none of it can be set by the model.
//
// Writes are exactly the ones save_suggestion already had: one suggestions
// insert through lib/suggestions.ts saveSuggestion, plus activity_log rows
// through lib/memory.ts logActivity. No new write authority.

import { EvidenceLedger } from "./evidence-ledger";
import { evaluateFinding, ideaCategory, CLASS_LABEL, type FindingClass, type Priority, type ValidatedEvidence } from "./finding-gate";
import { fingerprintFinding, compareFindings, newAnchors, renderFingerprintFooter, type FindingPrint, type DuplicateVerdict } from "./finding-fingerprint";
import { loadFindingHistory, rejectedDetail, REJECTED_ACTION, type FindingHistory, type HistoryEntry, type RejectCode } from "./finding-history";
import { verifyFinding, createVerifierRuntime, type VerificationResult, type VerifierRuntime } from "./finding-verifier";
import { saveSuggestion } from "./suggestions";
import { logActivity } from "./memory";
import type { AgentId } from "./types";

export interface FindingRun {
  ledger: EvidenceLedger;
  history: FindingHistory | null; // null = not loaded yet (loaded on first submission)
  accepted: { title: string; cls: FindingClass; print: FindingPrint }[];
  rejected: { title: string; code: RejectCode; print: FindingPrint }[];
  verifier: VerifierRuntime; // 7c: independent verification, bounded per run
}

export function createFindingRun(opts: { commit?: string; history?: FindingHistory | null; verifier?: VerifierRuntime } = {}): FindingRun {
  return { ledger: new EvidenceLedger({ commit: opts.commit }), history: opts.history ?? null, accepted: [], rejected: [], verifier: opts.verifier ?? createVerifierRuntime({ commit: opts.commit }) };
}

// Loop-supplied context for one save_suggestion call.
export interface FindingContext {
  run: FindingRun;
  title: string; // claim-guarded title (figures marked)
  body: string; // claim-guarded prose
  appendix?: string; // claim-guard footer: unverified-figures note + provenance
}

export interface SubmitOutcome {
  message: string;
  // verified = the independent verifier returned SURVIVES (7c). Only a
  // verified bug may ever alert.
  saved?: { finalClass: FindingClass; priority: Priority; title: string; verified: boolean };
}

// Gate codes that mean "the finding is wrong", not "the evidence was thin":
// resubmitting such a finding is blocked for HISTORY_DAYS.
// A deterministic verifier contradiction (7c) is remembered the same way; a
// model REJECT is recorded but not blocking (the model may be wrong).
const HARD_REJECTS: ReadonlySet<RejectCode> = new Set(["contradicted", "unsupported_absence", "verifier_contradicted"]);

async function safeLog(agent: AgentId, action: string, detail: string): Promise<void> {
  try {
    await logActivity(agent, action, detail);
  } catch {
    // logging must never change the outcome
  }
}

const EXCERPT_MAX = 240;
function renderEvidence(evs: ValidatedEvidence[], commit: string | undefined): string {
  if (!evs.length) return "";
  const rows = evs.map((e) => {
    const where = e.file ? `${e.file}:${e.startLine === e.endLine ? e.startLine : `${e.startLine}-${e.endLine}`}` : "";
    const ex = e.excerpt.replace(/\n/g, " ⏎ ");
    return `- ${e.tool}${where ? ` ${where}` : ""} — \`${ex.length > EXCERPT_MAX ? `${ex.slice(0, EXCERPT_MAX)}…` : ex}\``;
  });
  return `**Evidence (tool output recorded in this run${commit ? `, FootRank commit ${commit.slice(0, 7)}` : ""}):**\n${rows.join("\n")}`;
}

function classHeader(finalClass: FindingClass, requested: FindingClass, downgraded: string[], sources: number): string {
  if (finalClass === "verified_bug") return `**Class:** Verified bug — passed Mission Control's deterministic evidence gate (${sources} independent source(s) from this run) and independent verification.`;
  if (finalClass === "plausible_risk") {
    const why = requested === "verified_bug" && downgraded.length ? ` Submitted as a verified bug; downgraded because: ${downgraded.join("; ")}.` : "";
    return `**Class:** Risk — NOT a confirmed defect.${why}`;
  }
  return "**Class:** Idea — a product suggestion, NOT a bug.";
}

// Deterministic summary of the verification (no model prose is stored).
function renderVerification(v: VerificationResult): string {
  if (v.stage === "skipped") return "**Independent verification:** not applicable (product idea — no defect claim to verify).";
  const change = v.to && v.to !== v.from ? ` — ${CLASS_LABEL[v.from]} → ${CLASS_LABEL[v.to]}` : "";
  const checked = v.probes.length ? `\nChecked: ${v.probes.map((p) => `${p.id} ${p.what}`).join("; ")}.` : "";
  const relied = v.supporting.length ? `\nRelied on: ${v.supporting.join(", ")}.` : "";
  return `**Independent verification:** ${v.verdict} (${v.reason})${change}${v.provider ? ` · verifier ${v.provider}` : ""}${checked}${relied}`;
}

function verificationDetail(v: VerificationResult, fp: string | null, rt: VerifierRuntime): string {
  return JSON.stringify({
    v: 1,
    fp,
    verdict: v.verdict,
    reason: v.reason,
    from: v.from,
    to: v.to,
    downgraded: v.to !== null && v.to !== v.from,
    failed: v.failed,
    hard: v.hard,
    stage: v.stage,
    usage: { modelCalls: v.modelCalls, toolCalls: v.toolCalls, runModelCalls: `${rt.budget.modelCalls}/${rt.budget.maxModelCalls}`, runToolCalls: `${rt.budget.toolCalls}/${rt.budget.maxToolCalls}` },
    ...(v.provider ? { provider: v.provider } : {}),
    probes: v.probes.map((p) => p.id + " " + p.what).slice(0, 8),
    supporting: v.supporting.slice(0, 8),
    contradicting: v.contradicting.slice(0, 8),
  });
}

function relationDetail(v: DuplicateVerdict, existing: { id: string | null; title: string; source: string; print: FindingPrint }, print: FindingPrint, cls: FindingClass, title: string, added: string[], upgrade: boolean): string {
  return JSON.stringify({
    v: 1,
    rule: v.rule,
    reason: v.reason,
    existing: { id: existing.id, source: existing.source, title: existing.title.slice(0, 120), cls: existing.print.cls ?? null },
    submitted: { title: title.slice(0, 120), cls, fp: print.fp },
    newAnchors: added.slice(0, 12),
    upgrade,
  });
}

export async function submitFinding(agent: AgentId, input: Record<string, unknown>, fc: FindingContext | undefined, load: () => Promise<FindingHistory> = loadFindingHistory): Promise<SubmitOutcome> {
  if (!fc) return { message: "Not saved: findings can only be submitted from an investigation run (no run evidence ledger). Nothing was saved." };
  const run = fc.run;
  const gate = evaluateFinding(input, run.ledger);

  // ---- rejected by the gate: remembered, never saved ----
  if (gate.decision === "reject") {
    const print = gate.finding ? fingerprintFinding(gate.finding, gate.evidence) : null;
    if (print) {
      run.rejected.push({ title: fc.title, code: gate.code, print });
      await safeLog(agent, REJECTED_ACTION, rejectedDetail({ code: gate.code, ...(gate.requestedClass ? { cls: gate.requestedClass } : {}), title: fc.title, print }));
    } else {
      await safeLog(agent, "finding:invalid", `${gate.code}: ${gate.reasons.join("; ")}`.slice(0, 300));
    }
    return { message: `Not saved — rejected by the evidence gate (${gate.code}): ${gate.reasons.join("; ")}` };
  }

  const finalClass = gate.finalClass;
  const print = fingerprintFinding({ ...gate.finding, class: finalClass }, gate.evidence);

  // ---- duplicates: same run first, then history ----
  if (!run.history) {
    try {
      run.history = await load();
    } catch (e) {
      await safeLog(agent, "finding:history-unavailable", (e instanceof Error ? e.message : String(e)).slice(0, 200));
      return { message: "Not saved: the duplicate check could not load existing findings, so nothing was saved (fail-closed). Try again next run." };
    }
  }

  const dup = await checkDuplicates(agent, run, print, finalClass, fc.title);
  if ("blocked" in dup) return { message: dup.blocked };

  // ---- 7c: independent verification (bounded, fail-closed, keep-or-weaken only) ----
  const ver = await verifyFinding({ finding: gate.finding, cls: finalClass, evidence: gate.evidence }, run.ledger, run.verifier);
  await safeLog(agent, "finding:verified", verificationDetail(ver, print.fp, run.verifier));
  if (ver.verdict === "REJECT" || !ver.to) {
    if (ver.failed) {
      // Not remembered as a rejection: the finding was not judged, it may be resubmitted later.
      return { message: `Not saved — independent verification could not be completed (${ver.reason}), so the finding is not verified and nothing was saved.` };
    }
    const code: RejectCode = ver.hard ? "verifier_contradicted" : "verifier_rejected";
    run.rejected.push({ title: fc.title, code, print });
    await safeLog(agent, REJECTED_ACTION, rejectedDetail({ code, cls: finalClass, title: fc.title, print }));
    return { message: `Not saved — rejected by independent verification (${ver.reason}).` };
  }

  const verifiedClass = ver.to;
  let savePrint = print;
  let resubmission = dup.resubmission;
  if (verifiedClass !== finalClass) {
    savePrint = fingerprintFinding({ ...gate.finding, class: verifiedClass }, gate.evidence);
    if (savePrint.family !== print.family) {
      // Downgraded into a different family (e.g. risk -> idea): check that family too.
      const again = await checkDuplicates(agent, run, savePrint, verifiedClass, fc.title);
      if ("blocked" in again) return { message: again.blocked };
      resubmission = resubmission ?? again.resubmission;
    }
  }
  const priority: Priority = verifiedClass === "product_idea" ? "low" : verifiedClass === "plausible_risk" && gate.priority === "high" ? "medium" : gate.priority;
  const category = verifiedClass === "verified_bug" ? "bug" : verifiedClass === "plausible_risk" ? "risk" : ideaCategory(gate.finding.category);
  const downgrades = [...gate.downgraded, ...(ver.verdict === "DOWNGRADE" ? [`independent verification: ${ver.reason}`] : [])];

  // ---- save ----
  const commit = run.ledger.commit;
  const sources = new Set(gate.evidence.map((e) => e.ref)).size;
  const body = [
    classHeader(verifiedClass, gate.requestedClass, downgrades, sources),
    fc.body,
    renderEvidence(gate.evidence, commit),
    renderVerification(ver),
    fc.appendix ?? "",
    renderFingerprintFooter(savePrint),
  ].filter(Boolean).join("\n\n");
  const title = `[${CLASS_LABEL[verifiedClass]}] ${fc.title}`;
  await saveSuggestion({ agent, category, title, body, priority });
  run.accepted.push({ title, cls: verifiedClass, print: savePrint });
  if (resubmission) await safeLog(agent, "finding:resubmitted", JSON.stringify({ v: 1, previous: { id: resubmission.id, title: resubmission.title.slice(0, 120), code: resubmission.rejectCode }, fp: savePrint.fp }));
  if (downgrades.length) await safeLog(agent, "finding:downgraded", `${gate.requestedClass} -> ${verifiedClass}: ${downgrades.join("; ")}`.slice(0, 400));
  await safeLog(agent, "finding:accepted", JSON.stringify({ v: 1, cls: verifiedClass, requested: gate.requestedClass, priority, fp: savePrint.fp, sources, verdict: ver.verdict }));

  const label = verifiedClass === "verified_bug" ? "a VERIFIED BUG" : verifiedClass === "plausible_risk" ? "a RISK (not a confirmed defect)" : "a PRODUCT IDEA (not a bug)";
  const down = downgrades.length ? ` It was downgraded from ${gate.requestedClass} because: ${downgrades.join("; ")}.` : "";
  return { message: `Saved to the owner's suggestions inbox as ${label} (independent verification: ${ver.verdict}).${down}`, saved: { finalClass: verifiedClass, priority, title, verified: ver.verdict === "SURVIVES" } };
}

// The 7b duplicate check (same run, then history), unchanged in behaviour;
// factored out so a finding downgraded into another family is checked again.
async function checkDuplicates(agent: AgentId, run: FindingRun, print: FindingPrint, finalClass: FindingClass, title: string): Promise<{ blocked: string } | { resubmission: HistoryEntry | null }> {
  const relate = async (v: DuplicateVerdict, existing: { id: string | null; title: string; source: string; print: FindingPrint }) => {
    const added = newAnchors(existing.print, print);
    const upgrade = finalClass === "verified_bug" && existing.print.cls !== "verified_bug";
    const action = added.length || upgrade ? "finding:evidence-added" : "finding:duplicate";
    await safeLog(agent, action, relationDetail(v, existing, print, finalClass, title, added, upgrade));
    return { added, upgrade };
  };

  for (const prev of run.accepted) {
    const v = compareFindings(print, prev.print);
    if (!v.duplicate) continue;
    const { added } = await relate(v, { id: null, title: prev.title, source: "this-run", print: prev.print });
    return { blocked: `Not saved — duplicate of "${prev.title}" submitted earlier in this run (${v.reason}).${added.length ? ` Your additional evidence (${added.join(", ")}) was linked to it in the activity log.` : ""}` };
  }
  for (const prev of run.rejected) {
    if (!HARD_REJECTS.has(prev.code)) continue;
    const v = compareFindings(print, prev.print);
    if (v.duplicate) {
      await safeLog(agent, "finding:duplicate", relationDetail(v, { id: null, title: prev.title, source: `rejected-this-run:${prev.code}`, print: prev.print }, print, finalClass, title, [], false));
      return { blocked: `Not saved — this is the same finding ${prev.code.startsWith("verifier_") ? "independent verification" : "the evidence gate"} rejected earlier in this run (${prev.code}).` };
    }
  }

  const order: Record<HistoryEntry["source"], number> = { open: 0, dismissed: 1, done: 2, rejected: 3 };
  const entries = [...(run.history?.entries ?? [])].sort((a, b) => order[a.source] - order[b.source]);
  let resubmission: HistoryEntry | null = null;
  for (const h of entries) {
    const v = compareFindings(print, h.print);
    if (!v.duplicate) continue;
    if (h.source === "rejected") {
      if (h.rejectCode && HARD_REJECTS.has(h.rejectCode)) {
        await safeLog(agent, "finding:duplicate", relationDetail(v, { id: h.id, title: h.title, source: `rejected:${h.rejectCode}`, print: h.print }, print, finalClass, title, [], false));
        return { blocked: `Not saved — ${h.rejectCode.startsWith("verifier_") ? "independent verification" : "the evidence gate"} already rejected this finding (${h.rejectCode}) within the last 90 days: "${h.title}".` };
      }
      resubmission = resubmission ?? h; // thin evidence before, it passes the gate now
      continue;
    }
    const { added, upgrade } = await relate(v, { id: h.id, title: h.title, source: h.source, print: h.print });
    const status = h.source === "open" ? "is already open in the owner's inbox" : h.source === "done" ? "was already handled (done)" : "was dismissed by the owner";
    const extra = added.length || upgrade ? ` Your new evidence${added.length ? ` (${added.join(", ")})` : ""}${upgrade ? " and verified-bug status" : ""} was linked to it in the activity log instead of creating a second suggestion.` : "";
    return { blocked: `Not saved — duplicate: "${h.title}" ${status} (${v.reason}).${extra}` };
  }
  return { resubmission };
}
