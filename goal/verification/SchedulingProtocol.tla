------------------------- MODULE SchedulingProtocol -------------------------
EXTENDS Naturals
CONSTANTS IgnoreInput, IgnoreOutcome, IgnoreGates, ReleaseEarly
VARIABLES status, pendingInput, outcome, toolEnabled, hasBudget, stalled,
          owned, queuePaused, nextApproved, finalUsagePending, phase, steps, safe
vars == <<status, pendingInput, outcome, toolEnabled, hasBudget, stalled,
          owned, queuePaused, nextApproved, finalUsagePending, phase, steps, safe>>
Init == /\ status = "active" /\ pendingInput \in BOOLEAN
        /\ outcome \in {"completed", "aborted", "error"}
        /\ toolEnabled \in BOOLEAN /\ hasBudget \in BOOLEAN /\ stalled \in BOOLEAN
        /\ owned = TRUE /\ queuePaused = FALSE /\ nextApproved \in BOOLEAN
        /\ finalUsagePending = FALSE /\ phase = "run" /\ steps = 0 /\ safe = TRUE
Complete == /\ phase = "run" /\ status = "active" /\ owned
            /\ status' = "complete" /\ finalUsagePending' = TRUE /\ phase' = "charge"
            /\ UNCHANGED <<pendingInput, outcome, toolEnabled, hasBudget, stalled, owned,
                           queuePaused, nextApproved, steps, safe>>
Charge == /\ phase = "charge" /\ finalUsagePending /\ finalUsagePending' = FALSE /\ phase' = "run"
          /\ UNCHANGED <<status, pendingInput, outcome, toolEnabled, hasBudget, stalled, owned,
                         queuePaused, nextApproved, steps, safe>>
Boundary ==
  LET inputOK == ~pendingInput \/ IgnoreInput
      outcomeOK == outcome = "completed" \/ IgnoreOutcome
      gates == toolEnabled /\ hasBudget /\ ~stalled
      work == status = "active" \/ (status = "complete" /\ nextApproved)
      continue == owned /\ ~queuePaused /\ inputOK /\ outcomeOK /\ work /\ (gates \/ IgnoreGates)
  IN /\ phase = "run" /\ steps < 2 /\ ~finalUsagePending
     /\ steps' = steps + 1 /\ phase' = IF continue THEN "run" ELSE "settled"
     /\ status' = IF continue THEN "active" ELSE IF status = "active" THEN "paused" ELSE status
     /\ queuePaused' = ~continue
     /\ safe' = (safe /\ (~continue \/ (~pendingInput /\ outcome = "completed" /\ gates /\ owned)))
     /\ UNCHANGED <<pendingInput, outcome, toolEnabled, hasBudget, stalled,
                    owned, nextApproved, finalUsagePending>>
Release ==
  LET eligible == phase = "settled" /\ ~finalUsagePending /\ status # "active"
  IN /\ owned /\ (eligible \/ ReleaseEarly)
     /\ owned' = FALSE /\ queuePaused' = TRUE
     /\ safe' = (safe /\ eligible)
     /\ UNCHANGED <<status, pendingInput, outcome, toolEnabled, hasBudget, stalled,
                    nextApproved, finalUsagePending, phase, steps>>
Next == Complete \/ Charge \/ Boundary \/ Release \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == /\ status \in {"active", "complete", "paused"} /\ pendingInput \in BOOLEAN
          /\ outcome \in {"completed", "aborted", "error"}
          /\ toolEnabled \in BOOLEAN /\ hasBudget \in BOOLEAN /\ stalled \in BOOLEAN
          /\ owned \in BOOLEAN /\ queuePaused \in BOOLEAN /\ nextApproved \in BOOLEAN
          /\ finalUsagePending \in BOOLEAN /\ phase \in {"run", "charge", "settled"}
          /\ steps \in 0..2 /\ safe \in BOOLEAN
SafeContinuationAndRelease == safe
=============================================================================
