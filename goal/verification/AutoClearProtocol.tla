------------------------- MODULE AutoClearProtocol -------------------------
EXTENDS Naturals
CONSTANTS IgnoreVerification, IgnoreInput, IgnoreQueue, IgnoreCharge, AbortMessage
VARIABLES status, passed, queued, pendingCharge, charged, request, delivered, safe
vars == <<status, passed, queued, pendingCharge, charged, request, delivered, safe>>
Init == /\ status \in {"active", "verifying", "paused", "complete", "skipped"}
        /\ passed \in BOOLEAN /\ queued \in BOOLEAN /\ pendingCharge \in BOOLEAN
        /\ charged = ~pendingCharge /\ request = "none" /\ delivered = FALSE /\ safe = TRUE
Input(source) == /\ request = "none" /\ source \in {"user", "extension"}
                 /\ request' = source /\ delivered' = TRUE
                 /\ UNCHANGED <<status, passed, queued, pendingCharge, charged, safe>>
Charge == /\ pendingCharge /\ pendingCharge' = FALSE /\ charged' = TRUE
          /\ UNCHANGED <<status, passed, queued, request, delivered, safe>>
Clear == /\ status # "empty"
         /\ ((status = "complete" /\ passed) \/ IgnoreVerification)
         /\ (request = "user" \/ IgnoreInput)
         /\ (~queued \/ IgnoreQueue)
         /\ (~pendingCharge \/ IgnoreCharge)
         /\ status' = "empty"
         /\ delivered' = IF AbortMessage THEN FALSE ELSE delivered
         /\ safe' = (safe /\ status = "complete" /\ passed /\ request = "user"
                         /\ ~queued /\ charged /\ delivered')
         /\ UNCHANGED <<passed, queued, pendingCharge, charged, request>>
Next == (\E source \in {"user", "extension"} : Input(source)) \/ Charge \/ Clear \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == /\ status \in {"active", "verifying", "paused", "complete", "skipped", "empty"}
          /\ passed \in BOOLEAN /\ queued \in BOOLEAN /\ pendingCharge \in BOOLEAN
          /\ charged \in BOOLEAN /\ request \in {"none", "user", "extension"}
          /\ delivered \in BOOLEAN /\ safe \in BOOLEAN
SafeAutomaticClear == safe
=============================================================================
