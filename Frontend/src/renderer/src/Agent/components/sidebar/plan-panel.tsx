import { Check, CheckCheck, X } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useAgentStore } from "../../agentStore";

export default function PlanPanel() {
  const session = useAgentStore((s) => s.activeSession());
  const approvePlan = useAgentStore((s) => s.approvePlan);
  const rejectPlan = useAgentStore((s) => s.rejectPlan);
  if (!session?.plan) {
    return session?.approvalPending ? (
      <div className="flex flex-col gap-2">
        <p className="font-body-sm text-body-sm text-secondary">{session.approvalDescription ?? "The agent needs approval to continue."}</p>
        <div className="flex gap-2">
          <button type="button" onClick={approvePlan} className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 font-label-xs text-label-xs font-medium text-on-primary"><CheckCheck size={12} /> Approve</button>
          <button type="button" onClick={rejectPlan} className="flex items-center gap-1.5 rounded-md border border-outline-variant px-2.5 py-1.5 font-label-xs text-label-xs text-secondary hover:bg-surface-container"><X size={12} /> Decline</button>
        </div>
      </div>
    ) : <p className="font-label-xs text-label-xs text-secondary">No plan available.</p>;
  }

  const plan = session.plan;
  const doneCount = plan.steps.filter((s) => s.done).length;
  const progress = plan.steps.length > 0 ? (doneCount / plan.steps.length) * 100 : 0;

  return (
    <div className="flex flex-col gap-2">
      <p className="font-body-sm text-body-sm text-on-surface">{plan.goal}</p>

      <div className="flex items-center gap-2">
        <span className="h-1 flex-1 overflow-hidden rounded-full bg-surface-container-high">
          <span
            className="block h-full rounded-full bg-secondary transition-all"
            style={{ width: `${progress}%` }}
          />
        </span>
        <span className="font-label-xs text-label-xs text-secondary">
          {doneCount}/{plan.steps.length}
        </span>
      </div>

      <div className="flex flex-col">
        {plan.steps.map((step) => (
          <div key={step.id} className="flex items-center gap-2 py-0.5">
            {step.done ? (
              <Check size={12} className="shrink-0 text-secondary" strokeWidth={2.5} />
            ) : (
              <span className="h-3 w-3 shrink-0 rounded-full border border-outline-variant" />
            )}
            <span
              className={cn(
                "font-body-sm text-body-sm",
                step.done ? "text-secondary line-through" : "text-on-surface"
              )}
            >
              {step.label}
            </span>
          </div>
        ))}
      </div>

      {plan.risks.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {plan.risks.map((risk, i) => (
            <p key={i} className="font-body-sm text-body-sm text-secondary">
              {risk}
            </p>
          ))}
        </div>
      )}

      {session.approvalPending && (
        <div className="mt-2 flex flex-col gap-2 border-t border-outline-variant pt-2">
          <p className="font-body-sm text-body-sm text-secondary">{session.approvalDescription ?? "Review and approve this plan before changes are made."}</p>
          <div className="flex gap-2">
            <button type="button" onClick={approvePlan} className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 font-label-xs text-label-xs font-medium text-on-primary"><CheckCheck size={12} /> Approve plan</button>
            <button type="button" onClick={rejectPlan} className="flex items-center gap-1.5 rounded-md border border-outline-variant px-2.5 py-1.5 font-label-xs text-label-xs text-secondary hover:bg-surface-container"><X size={12} /> Decline</button>
          </div>
        </div>
      )}
    </div>
  );
}
