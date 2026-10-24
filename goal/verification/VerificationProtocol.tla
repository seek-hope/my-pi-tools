------------------------- MODULE VerificationProtocol -------------------------
EXTENDS Naturals
CONSTANTS IgnoreVersion, CountRequestRepair, CompleteUnanswered, SkipFreshInspection
VARIABLES version, ticket, phase, requested, answered, inspected,
          current, noRequestRepair, answeredBeforePass, freshBeforePass
vars == <<version, ticket, phase, requested, answered, inspected,
          current, noRequestRepair, answeredBeforePass, freshBeforePass>>
Init == /\ version = 1 /\ ticket = 0 /\ phase = "idle"
        /\ requested = FALSE /\ answered = FALSE /\ inspected = FALSE
        /\ current = TRUE /\ noRequestRepair = TRUE
        /\ answeredBeforePass = TRUE /\ freshBeforePass = TRUE
Start == /\ phase \in {"idle", "answered"}
         /\ phase' = "review" /\ ticket' = version /\ inspected' = FALSE
         /\ UNCHANGED <<version, requested, answered, current, noRequestRepair,
                         answeredBeforePass, freshBeforePass>>
Inspect == /\ phase = "review" /\ inspected' = TRUE
           /\ UNCHANGED <<version, ticket, phase, requested, answered, current,
                           noRequestRepair, answeredBeforePass, freshBeforePass>>
Request == /\ phase = "review" /\ phase' = "requested"
           /\ requested' = TRUE /\ answered' = FALSE /\ inspected' = FALSE
           /\ noRequestRepair' = (noRequestRepair /\ ~CountRequestRepair)
           /\ UNCHANGED <<version, ticket, current, answeredBeforePass, freshBeforePass>>
Edit == /\ version = 1 /\ phase # "passed" /\ version' = 2
        /\ UNCHANGED <<ticket, phase, requested, answered, inspected, current,
                        noRequestRepair, answeredBeforePass, freshBeforePass>>
Reply == /\ phase = "requested" /\ (ticket = version \/ IgnoreVersion)
         /\ phase' = "answered" /\ answered' = TRUE
         /\ current' = (current /\ ticket = version)
         /\ UNCHANGED <<version, ticket, requested, inspected, noRequestRepair,
                         answeredBeforePass, freshBeforePass>>
Finish == /\ ((phase = "review" /\ inspected)
              \/ (phase = "requested" /\ CompleteUnanswered)
              \/ (phase = "answered" /\ SkipFreshInspection))
          /\ (ticket = version \/ IgnoreVersion)
          /\ phase' = "passed"
          /\ current' = (current /\ ticket = version)
          /\ answeredBeforePass' = (answeredBeforePass /\ (~requested \/ answered))
          /\ freshBeforePass' = (freshBeforePass /\ (~answered \/ (phase = "review" /\ inspected)))
          /\ UNCHANGED <<version, ticket, requested, answered, inspected, noRequestRepair>>
Next == Start \/ Inspect \/ Request \/ Edit \/ Reply \/ Finish \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == /\ version \in 1..2 /\ ticket \in 0..2
          /\ phase \in {"idle", "review", "requested", "answered", "passed"}
          /\ requested \in BOOLEAN /\ answered \in BOOLEAN /\ inspected \in BOOLEAN
          /\ current \in BOOLEAN /\ noRequestRepair \in BOOLEAN
          /\ answeredBeforePass \in BOOLEAN /\ freshBeforePass \in BOOLEAN
CurrentVersion == current
RequestIsNotRepair == noRequestRepair
NoUnansweredCompletion == answeredBeforePass
FreshReviewAfterReply == freshBeforePass
=============================================================================
