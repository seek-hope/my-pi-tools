-------------------------- MODULE QueueProtocol --------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS GoalCount, LegacyAddSelection, IgnoreApproval, BypassHead,
          DropContinuation
Goals == 1..GoalCount
None == 0
Terminal(s) == s \in {"complete", "skipped"}

VARIABLES present, status, active, queuePaused, fifoOK, approvedExecution, approved
vars == <<present, status, active, queuePaused, fifoOK, approvedExecution, approved>>
Pending == {g \in present : status[g] \in {"draft", "queued"}}
Head == IF Pending = {} THEN None
        ELSE CHOOSE g \in Pending : \A h \in Pending : g <= h
FirstUnfinished == IF {g \in present : ~Terminal(status[g])} = {} THEN None
                   ELSE CHOOSE g \in present :
                     /\ ~Terminal(status[g])
                     /\ \A h \in present : ~Terminal(status[h]) => g <= h
NextQueued == IF Head = None THEN None
              ELSE IF status[Head] = "queued" THEN Head ELSE None
HasCurrent == active # None
CurrentTerminal == IF HasCurrent THEN Terminal(status[active]) ELSE TRUE

Init == /\ present = {}
        /\ status = [g \in Goals |-> "draft"]
        /\ active = None
        /\ queuePaused = TRUE
        /\ fifoOK = TRUE
        /\ approvedExecution = TRUE /\ approved = {}

\* /goal add appends a draft. It is not an explicit /goal resume <id> override.
Add == \E g \in Goals \ present :
         /\ g = Cardinality(present) + 1
         /\ LET expected == IF FirstUnfinished = None THEN g
                            ELSE IF HasCurrent THEN active ELSE FirstUnfinished
                selected == IF CurrentTerminal
                            THEN IF LegacyAddSelection THEN g ELSE expected
                            ELSE active
            IN /\ active' = selected
               /\ fifoOK' = (fifoOK /\ (CurrentTerminal => selected = expected))
         /\ present' = present \cup {g}
         /\ UNCHANGED <<status, queuePaused, approvedExecution, approved>>

Approve(g) == /\ g \in present /\ status[g] = "draft"
              /\ status' = [status EXCEPT ![g] = IF active = g THEN "active" ELSE "queued"]
              /\ queuePaused' = IF active = g THEN FALSE ELSE queuePaused
              /\ approved' = approved \cup {g}
              /\ UNCHANGED <<present, active, fifoOK, approvedExecution>>

Complete == /\ HasCurrent /\ status[active] = "active" /\ ~queuePaused
            /\ status' = [status EXCEPT ![active] = "complete"]
            /\ UNCHANGED <<present, active, queuePaused, fifoOK, approvedExecution, approved>>

\* Completion is an abstract successful current audit; AuditProtocol checks that gate.
Advance == /\ ~DropContinuation
           /\ HasCurrent /\ status[active] = "complete" /\ ~queuePaused
           /\ \E g \in Pending :
                /\ (BypassHead \/ g = Head)
                /\ (IgnoreApproval \/ status[g] = "queued")
                /\ active' = g
                /\ status' = [status EXCEPT ![g] = "active"]
                /\ fifoOK' = (fifoOK /\ g = Head)
                /\ approvedExecution' = (approvedExecution /\ status[g] = "queued")
           /\ UNCHANGED <<present, queuePaused, approved>>

Pause == /\ HasCurrent /\ ~Terminal(status[active])
         /\ status' = [status EXCEPT ![active] = "paused"]
         /\ queuePaused' = TRUE
         /\ UNCHANGED <<present, active, fifoOK, approvedExecution, approved>>

\* Explicit resume <id> may deliberately select a different approved goal.
\* It must not create two running goals; it is not an automatic FIFO step.
Resume(g) == /\ g \in present /\ g \in approved /\ status[g] \in {"queued", "paused"}
             /\ \A h \in present : status[h] # "active"
             /\ active' = g /\ status' = [status EXCEPT ![g] = "active"]
             /\ queuePaused' = FALSE
             /\ UNCHANGED <<present, fifoOK, approvedExecution, approved>>

Skip(g) == /\ g \in present /\ ~Terminal(status[g])
           /\ status' = [status EXCEPT ![g] = "skipped"]
           /\ active' = IF active = g
                        THEN LET p == Pending \ {g}
                                 h == IF p = {} THEN None
                                      ELSE CHOOSE x \in p : \A y \in p : x <= y
                             IN IF h = None THEN None
                                ELSE IF status[h] = "queued" THEN h ELSE None
                        ELSE active
           /\ queuePaused' = IF active = g THEN TRUE ELSE queuePaused
           /\ UNCHANGED <<present, fifoOK, approvedExecution, approved>>

Next == Add \/ Complete \/ Advance \/ Pause
        \/ (\E g \in Goals : Approve(g) \/ Resume(g) \/ Skip(g))
        \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars

TypeOK == /\ present \subseteq Goals /\ approved \subseteq present
          /\ status \in [Goals -> {"draft", "queued", "active", "paused", "complete", "skipped"}]
          /\ active \in present \cup {None}
          /\ queuePaused \in BOOLEAN /\ fifoOK \in BOOLEAN /\ approvedExecution \in BOOLEAN
OneRunning == Cardinality({g \in present : status[g] = "active"}) <= 1
RunningIsSelected == \A g \in present : status[g] = "active" => active = g
AutomaticFIFO == fifoOK
NoUnapprovedExecution == approvedExecution /\
  (\A g \in present : status[g] \in {"active", "complete"} => g \in approved)

\* Conditional liveness: every goal was approved, the current goal can successfully
\* complete, the host services continuation, and no user/crash/budget intervenes.
LiveInit == /\ present = Goals
            /\ status = [g \in Goals |-> IF g = 1 THEN "active" ELSE "queued"]
            /\ active = 1 /\ queuePaused = FALSE
            /\ fifoOK = TRUE /\ approvedExecution = TRUE /\ approved = Goals
LiveNext == Complete \/ Advance \/ UNCHANGED vars
LiveSpec == LiveInit /\ [][LiveNext]_vars /\ WF_vars(Complete) /\ WF_vars(Advance)
EventuallyDrained == <> (\A g \in Goals : status[g] = "complete")
=============================================================================
