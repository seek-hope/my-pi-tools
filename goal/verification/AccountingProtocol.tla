------------------------- MODULE AccountingProtocol -------------------------
EXTENDS Naturals, Sequences, FiniteSets
CONSTANTS ResetUsage, LoseFinalTurn, DoubleReasoning, RepeatIsProgress, IgnoreBudget
VARIABLES status, worker, audit, ledger, stalled, seen, turns, resumes, authorized
vars == <<status, worker, audit, ledger, stalled, seen, turns, resumes, authorized>>
RECURSIVE Sum(_)
Sum(s) == IF Len(s) = 0 THEN 0 ELSE s[1] + Sum(Tail(s))
Init == /\ status = "active" /\ worker = 0 /\ audit = 0 /\ ledger = <<>>
        /\ stalled = 0 /\ seen = {} /\ turns = 0 /\ resumes = 0 /\ authorized = TRUE
(* input and cache are separate from output. Reasoning is already inside output. *)
Turn(fp, changed, final) ==
  LET cost == 1 + 1 + 1
      progress == fp \notin seen \/ changed \/ RepeatIsProgress
      charge == ~(final /\ LoseFinalTurn)
  IN /\ status = "active" /\ turns < 4 /\ fp \in 1..2 /\ changed \in BOOLEAN /\ final \in BOOLEAN
     /\ worker' = worker + (IF charge THEN cost + (IF DoubleReasoning THEN 1 ELSE 0) ELSE 0)
     /\ ledger' = Append(ledger, cost)
     /\ stalled' = IF progress THEN 0 ELSE stalled + 1
     /\ seen' = seen \cup {fp} /\ turns' = turns + 1
     /\ status' = IF final THEN "complete" ELSE IF stalled' >= 3 THEN "blocked" ELSE "active"
     /\ authorized' = (authorized /\ (progress => (fp \notin seen \/ changed)))
     /\ UNCHANGED <<audit, resumes>>
AuditCharge == /\ status = "active" /\ audit < 4
               /\ audit' = audit + 2 /\ ledger' = Append(ledger, 2)
               /\ UNCHANGED <<status, worker, stalled, seen, turns, resumes, authorized>>
Pause == /\ status = "active" /\ status' = "blocked"
         /\ UNCHANGED <<worker, audit, ledger, stalled, seen, turns, resumes, authorized>>
Resume == /\ status = "blocked" /\ resumes < 2
          /\ (worker + audit < 6 \/ IgnoreBudget)
          /\ status' = "active" /\ resumes' = resumes + 1 /\ stalled' = 0
          /\ worker' = IF ResetUsage THEN 0 ELSE worker
          /\ audit' = IF ResetUsage THEN 0 ELSE audit
          /\ authorized' = (authorized /\ worker + audit < 6)
          /\ UNCHANGED <<ledger, seen, turns>>
Next == (\E fp \in 1..2, changed \in BOOLEAN, final \in BOOLEAN : Turn(fp, changed, final))
        \/ AuditCharge \/ Pause \/ Resume \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == /\ status \in {"active", "blocked", "complete"} /\ worker \in 0..16 /\ audit \in 0..4
          /\ ledger \in Seq(2..3) /\ stalled \in 0..3 /\ seen \subseteq 1..2
          /\ turns \in 0..4 /\ resumes \in 0..2 /\ authorized \in BOOLEAN
MeteredUsage == worker + audit = Sum(ledger)
ProgressAndBudget == authorized
=============================================================================
