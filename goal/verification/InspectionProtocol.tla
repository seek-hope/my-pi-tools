------------------------- MODULE InspectionProtocol -------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS SameResponse, CountRecord, IgnoreCoverage, AllowOutside
Criteria == {1, 2}
VARIABLES response, inspected, realInspection, seenAtStart, findings, verdict, safeRead
vars == <<response, inspected, realInspection, seenAtStart, findings, verdict, safeRead>>
Init == /\ response = 0 /\ inspected = FALSE /\ realInspection = FALSE /\ seenAtStart = FALSE
        /\ findings = {} /\ verdict = "none" /\ safeRead = TRUE
BeginResponse == /\ response < 2 /\ verdict = "none" /\ response' = response + 1
                 /\ seenAtStart' = inspected
                 /\ UNCHANGED <<inspected, realInspection, findings, verdict, safeRead>>
Read(kind, inside, valid) ==
  LET succeeds == (inside \/ AllowOutside) /\ valid
      counts == (kind = "artifact" /\ succeeds) \/ (kind = "record" /\ CountRecord)
  IN /\ response > 0 /\ verdict = "none"
     /\ kind \in {"artifact", "record", "list"} /\ inside \in BOOLEAN /\ valid \in BOOLEAN
     /\ inspected' = (inspected \/ counts)
     /\ realInspection' = (realInspection \/ (kind = "artifact" /\ succeeds))
     /\ safeRead' = (safeRead /\ (kind # "artifact" \/ ~succeeds \/ inside))
     /\ UNCHANGED <<response, seenAtStart, findings, verdict>>
Result(ids) == /\ response > 0 /\ verdict = "none" /\ ids \subseteq {1, 2, 3}
               /\ (seenAtStart \/ (SameResponse /\ inspected))
               /\ (ids = Criteria \/ IgnoreCoverage)
               /\ findings' = ids /\ verdict' = "pass"
               /\ UNCHANGED <<response, inspected, realInspection, seenAtStart, safeRead>>
Next == BeginResponse \/ (\E k \in {"artifact", "record", "list"}, i \in BOOLEAN, v \in BOOLEAN : Read(k, i, v))
        \/ (\E ids \in SUBSET {1, 2, 3} : Result(ids)) \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == /\ realInspection \in BOOLEAN /\ response \in 0..2 /\ inspected \in BOOLEAN /\ seenAtStart \in BOOLEAN
          /\ findings \subseteq {1, 2, 3} /\ verdict \in {"none", "pass"} /\ safeRead \in BOOLEAN
RealInspection == verdict = "pass" => realInspection
ReadBoundary == safeRead
LaterResponse == verdict = "pass" => seenAtStart
CompleteFindings == verdict = "pass" => findings = Criteria
=============================================================================
