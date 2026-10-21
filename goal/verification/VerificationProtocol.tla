------------------------- MODULE VerificationProtocol -------------------------
EXTENDS Naturals
CONSTANTS IgnoreSnapshot, CountEnvironmentFailure, SkipEnvironmentPause,
          CompleteEnvironmentFailure
VARIABLES env, used, phase, envFailures, repairs, envFailure, repairGranted
vars == <<env, used, phase, envFailures, repairs, envFailure, repairGranted>>

Init == /\ env \in 1..2
        /\ used = 0
        /\ phase = "idle"
        /\ envFailures = 0
        /\ repairs = 0
        /\ envFailure = FALSE
        /\ repairGranted = FALSE

Submit == /\ phase = "idle"
          /\ used' = IF IgnoreSnapshot THEN (IF env = 1 THEN 2 ELSE 1) ELSE env
          /\ phase' = "running"
          /\ envFailure' = FALSE
          /\ repairGranted' = FALSE
          /\ UNCHANGED <<env, envFailures, repairs>>

Finish(failed, envIssue) ==
  /\ phase = "running"
  /\ failed \in BOOLEAN
  /\ envIssue \in BOOLEAN
  /\ envFailure' = (failed /\ envIssue)
  /\ envFailures' = IF failed /\ envIssue /\ ~CompleteEnvironmentFailure
                     THEN (IF envFailures >= 2 THEN 2 ELSE envFailures + 1)
                     ELSE envFailures
  /\ phase' = IF failed /\ envIssue /\ CompleteEnvironmentFailure THEN "passed"
              ELSE IF ~failed THEN "passed"
              ELSE IF failed /\ envIssue THEN
                     IF envFailures + 1 >= 2 /\ ~SkipEnvironmentPause THEN "paused"
                     ELSE "active"
              ELSE "active"
  /\ UNCHANGED <<env, used, repairs, repairGranted>>

Repair == /\ phase = "active" /\ ~envFailure
          /\ repairs' = IF repairs >= 2 THEN 2 ELSE repairs + 1
          /\ repairGranted' = TRUE
          /\ phase' = "idle"
          /\ used' = 0
          /\ UNCHANGED <<env, envFailures, envFailure>>

EnvironmentRepair == /\ phase = "active" /\ envFailure /\ CountEnvironmentFailure
                     /\ repairs' = IF repairs >= 2 THEN 2 ELSE repairs + 1
                     /\ repairGranted' = TRUE
                     /\ phase' = "idle"
                     /\ used' = 0
                     /\ UNCHANGED <<env, envFailures, envFailure>>

AdjustEnvironment == /\ phase \in {"active", "paused"}
                     /\ env' \in 1..2
                     /\ envFailures' = 0
                     /\ envFailure' = FALSE
                     /\ repairGranted' = FALSE
                     /\ phase' = "idle"
                     /\ used' = 0
                     /\ UNCHANGED <<repairs>>

Retry == /\ phase = "active"
         /\ phase' = "idle"
         /\ repairGranted' = FALSE
         /\ UNCHANGED <<env, used, envFailures, envFailure, repairs>>

Next == Submit \/ (\E failed, envIssue \in BOOLEAN : Finish(failed, envIssue))
        \/ Repair \/ EnvironmentRepair \/ AdjustEnvironment \/ Retry
        \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars

TypeOK == /\ env \in 1..2 /\ used \in 0..2
          /\ phase \in {"idle", "running", "active", "paused", "passed"}
          /\ envFailures \in 0..2 /\ repairs \in 0..2
          /\ envFailure \in BOOLEAN /\ repairGranted \in BOOLEAN
SnapshotUsed == used = 0 \/ used = env
EnvironmentIsNotRepair == ~(envFailure /\ repairGranted)
NoEnvironmentCompletion == ~(envFailure /\ phase = "passed")
EnvironmentStops == envFailures < 2 \/ phase \in {"paused", "idle"}
=============================================================================
