------------------------- MODULE CheckProtocol -------------------------
EXTENDS Naturals
CONSTANTS TrustMissingMetadata, IgnoreCancellation, IgnoreIdentity, SkipFailedCheck
VARIABLES available, stage, cancelled, epoch, ticket, exitOK, applied, safe
vars == <<available, stage, cancelled, epoch, ticket, exitOK, applied, safe>>
Init == /\ available \in BOOLEAN /\ stage = "idle" /\ cancelled = FALSE
        /\ epoch = 1 /\ ticket = 0 /\ exitOK = FALSE /\ applied = FALSE /\ safe = TRUE
Start == /\ stage = "idle" /\ ~cancelled
         /\ stage' = IF available \/ TrustMissingMetadata THEN "running" ELSE "error"
         /\ ticket' = epoch
         /\ safe' = (safe /\ (stage' # "running" \/ available))
         /\ UNCHANGED <<available, cancelled, epoch, exitOK, applied>>
Cancel == /\ stage \in {"idle", "running", "returned"} /\ ~cancelled
          /\ cancelled' = TRUE
          /\ UNCHANGED <<available, stage, epoch, ticket, exitOK, applied, safe>>
Replace == /\ epoch = 1 /\ epoch' = 2
           /\ UNCHANGED <<available, stage, cancelled, ticket, exitOK, applied, safe>>
Exit(ok) == /\ stage = "running" /\ ok \in BOOLEAN /\ exitOK' = ok
            /\ stage' = IF cancelled /\ ~IgnoreCancellation THEN "error" ELSE "returned"
            /\ UNCHANGED <<available, cancelled, epoch, ticket, applied, safe>>
Apply == /\ stage = "returned"
         /\ LET valid == (~cancelled \/ IgnoreCancellation) /\ (epoch = ticket \/ IgnoreIdentity)
                         /\ (exitOK \/ SkipFailedCheck)
            IN /\ applied' = valid /\ stage' = IF valid THEN "audit" ELSE "error"
               /\ safe' = (safe /\ (~valid \/ (available /\ ~cancelled /\ epoch = ticket /\ exitOK)))
         /\ UNCHANGED <<available, cancelled, epoch, ticket, exitOK>>
Next == Start \/ Cancel \/ Replace \/ (\E ok \in BOOLEAN : Exit(ok)) \/ Apply \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == /\ available \in BOOLEAN /\ stage \in {"idle", "running", "returned", "error", "audit"}
          /\ cancelled \in BOOLEAN /\ epoch \in 1..2 /\ ticket \in 0..2
          /\ exitOK \in BOOLEAN /\ applied \in BOOLEAN /\ safe \in BOOLEAN
CheckBeforeAudit == safe
=============================================================================
