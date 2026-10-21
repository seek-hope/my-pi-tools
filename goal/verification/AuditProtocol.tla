-------------------------- MODULE AuditProtocol --------------------------
EXTENDS Naturals, FiniteSets

CONSTANTS SessionCount, TicketCount, MaxGeneration, MaxRepairs,
          IgnoreGeneration, IgnoreOwner, SkipChecks, SkipInspection, DropEvidence
Sessions == 1..SessionCount
Tickets == 1..TicketCount
Requirements == {"base", "extra"}
Statuses == {"draft", "active", "verifying", "paused", "blocked", "complete", "skipped"}
Terminal(s) == s \in {"complete", "skipped"}

VARIABLES status, generation, owner, alive, approved, pending, obligations,
          evidence, tickets, certificate, failures, charged,
          authorizedWrites, freshApplications, preservedEvidence, budgetRepairsOK
vars == <<status, generation, owner, alive, approved, pending, obligations,
          evidence, tickets, certificate, failures, charged,
          authorizedWrites, freshApplications, preservedEvidence, budgetRepairsOK>>
LiveOwner == owner # 0 /\ alive
CanBump == generation < MaxGeneration
EmptyTicket == [phase |-> "unused", gen |-> 0, writer |-> 0, contract |-> {},
                checked |-> FALSE, seen |-> FALSE, verdict |-> "fail", aborted |-> FALSE]
EmptyCertificate == [gen |-> 0, contract |-> {}, checked |-> FALSE, seen |-> FALSE]
Init == /\ status = "draft" /\ generation = 1 /\ owner = 0 /\ alive = FALSE
        /\ approved = FALSE /\ pending = TRUE /\ obligations = {"base"} /\ evidence = {}
        /\ tickets = [p \in Tickets |-> EmptyTicket]
        /\ certificate = EmptyCertificate /\ failures = 0 /\ charged = {}
        /\ authorizedWrites = TRUE /\ freshApplications = TRUE
        /\ preservedEvidence = TRUE /\ budgetRepairsOK = TRUE

\* Transactions are serialized by ProjectStore's lock (checked separately in JournalProtocol).
Claim(s) == /\ s \in Sessions /\ ~LiveOwner
            /\ (status \in {"active", "verifying"} => CanBump)
            /\ owner' = s /\ alive' = TRUE
            /\ status' = IF status \in {"active", "verifying"} THEN "paused" ELSE status
            /\ generation' = IF status \in {"active", "verifying"} THEN generation + 1 ELSE generation
            /\ UNCHANGED <<approved, pending, obligations, evidence, tickets, certificate,
                           failures, charged, authorizedWrites, freshApplications,
                           preservedEvidence, budgetRepairsOK>>
Crash == /\ LiveOwner /\ alive' = FALSE
         /\ UNCHANGED <<status, generation, owner, approved, pending, obligations, evidence,
                        tickets, certificate, failures, charged, authorizedWrites,
                        freshApplications, preservedEvidence, budgetRepairsOK>>
Release == /\ LiveOwner /\ (Terminal(status) \/ CanBump)
           /\ owner' = 0 /\ alive' = FALSE
           /\ status' = IF Terminal(status) THEN status ELSE "paused"
           /\ generation' = IF Terminal(status) THEN generation ELSE generation + 1
           /\ UNCHANGED <<approved, pending, obligations, evidence, tickets, certificate,
                          failures, charged, authorizedWrites, freshApplications,
                          preservedEvidence, budgetRepairsOK>>

Approve(r) == /\ LiveOwner /\ pending /\ CanBump /\ ~Terminal(status)
              /\ r \in {{"base"}, Requirements}
              /\ status' = "active" /\ approved' = TRUE /\ pending' = FALSE
              /\ generation' = generation + 1 /\ obligations' = r /\ evidence' = {}
              /\ UNCHANGED <<owner, alive, tickets, certificate, failures, charged,
                             authorizedWrites, freshApplications, preservedEvidence, budgetRepairsOK>>
Propose == /\ LiveOwner /\ status \in {"active", "paused"} /\ CanBump
           /\ pending' = TRUE /\ status' = "draft" /\ generation' = generation + 1
           /\ UNCHANGED <<owner, alive, approved, obligations, evidence, tickets, certificate,
                          failures, charged, authorizedWrites, freshApplications,
                          preservedEvidence, budgetRepairsOK>>
Progress(r) == /\ LiveOwner /\ status = "active" /\ r \in obligations
               /\ evidence' = evidence \cup {r}
               /\ UNCHANGED <<status, generation, owner, alive, approved, pending, obligations,
                              tickets, certificate, failures, charged, authorizedWrites,
                              freshApplications, preservedEvidence, budgetRepairsOK>>
\* User approval of a pending task refinement preserves existing obligations/evidence.
Refine == /\ LiveOwner /\ status = "draft" /\ pending /\ approved /\ CanBump
          /\ obligations # Requirements
          /\ status' = "active" /\ pending' = FALSE
          /\ obligations' = Requirements /\ generation' = generation + 1
          /\ evidence' = IF DropEvidence THEN {} ELSE evidence
          /\ preservedEvidence' = (preservedEvidence /\ evidence \subseteq evidence')
          /\ UNCHANGED <<owner, alive, approved, tickets, certificate,
                         failures, charged, authorizedWrites, freshApplications, budgetRepairsOK>>
Supplement == /\ LiveOwner /\ ~Terminal(status) /\ CanBump
              /\ generation' = generation + 1
              /\ status' = IF status = "verifying" THEN "active" ELSE status
              /\ UNCHANGED <<owner, alive, approved, pending, obligations, evidence, tickets,
                             certificate, failures, charged, authorizedWrites, freshApplications,
                             preservedEvidence, budgetRepairsOK>>
Stop(s) == /\ LiveOwner /\ ~Terminal(status) /\ CanBump
           /\ s \in {"paused", "blocked", "skipped"}
           /\ status' = s /\ generation' = generation + 1
           /\ UNCHANGED <<owner, alive, approved, pending, obligations, evidence, tickets,
                          certificate, failures, charged, authorizedWrites, freshApplications,
                          preservedEvidence, budgetRepairsOK>>
Resume == /\ LiveOwner /\ status \in {"paused", "blocked"} /\ approved /\ ~pending /\ CanBump
          /\ status' = "active" /\ generation' = generation + 1 /\ failures' = 0
          /\ UNCHANGED <<owner, alive, approved, pending, obligations, evidence, tickets,
                         certificate, charged, authorizedWrites, freshApplications,
                         preservedEvidence, budgetRepairsOK>>

Start(p) == /\ LiveOwner /\ status = "active" /\ approved /\ ~pending
            /\ evidence = obligations /\ tickets[p].phase = "unused"
            /\ status' = "verifying"
            /\ tickets' = [tickets EXCEPT ![p] =
                 [phase |-> IF SkipChecks THEN "inspect" ELSE "checks",
                  gen |-> generation, writer |-> owner, contract |-> obligations,
                  checked |-> FALSE, seen |-> FALSE, verdict |-> "fail", aborted |-> FALSE]]
            /\ UNCHANGED <<generation, owner, alive, approved, pending, obligations, evidence,
                           certificate, failures, charged, authorizedWrites, freshApplications,
                           preservedEvidence, budgetRepairsOK>>
Checks(p, ok) == /\ tickets[p].phase = "checks"
                 /\ tickets' = [tickets EXCEPT ![p].phase = IF ok THEN "inspect" ELSE "result",
                                 ![p].checked = ok]
                 /\ UNCHANGED <<status, generation, owner, alive, approved, pending, obligations,
                                evidence, certificate, failures, charged, authorizedWrites,
                                freshApplications, preservedEvidence, budgetRepairsOK>>
Inspect(p) == /\ tickets[p].phase = "inspect"
              /\ tickets' = [tickets EXCEPT ![p].phase = "seen", ![p].seen = TRUE]
              /\ UNCHANGED <<status, generation, owner, alive, approved, pending, obligations,
                             evidence, certificate, failures, charged, authorizedWrites,
                             freshApplications, preservedEvidence, budgetRepairsOK>>
Verdict(p, v) == /\ (tickets[p].phase = "seen" \/ (SkipInspection /\ tickets[p].phase = "inspect"))
                 /\ v \in {"pass", "fail", "budget"}
                 /\ tickets' = [tickets EXCEPT ![p].phase = "result", ![p].verdict = v]
                 /\ UNCHANGED <<status, generation, owner, alive, approved, pending, obligations,
                                evidence, certificate, failures, charged, authorizedWrites,
                                freshApplications, preservedEvidence, budgetRepairsOK>>
CancelRequest(p) == /\ tickets[p].phase \notin {"unused", "done"} /\ ~tickets[p].aborted
                    /\ tickets' = [tickets EXCEPT ![p].aborted = TRUE]
                    /\ UNCHANGED <<status, generation, owner, alive, approved, pending, obligations,
                                   evidence, certificate, failures, charged, authorizedWrites,
                                   freshApplications, preservedEvidence, budgetRepairsOK>>

Finish(p) ==
  /\ tickets[p].phase = "result"
  /\ LET c == tickets[p]
         writes == LiveOwner /\ (IgnoreOwner \/ owner = c.writer)
         applies == writes /\ status = "verifying" /\ (IgnoreGeneration \/ generation = c.gen)
         nextStatus == IF ~applies THEN status
                       ELSE IF c.aborted THEN "paused"
                       ELSE CASE c.verdict = "pass" -> "complete"
                              [] c.verdict = "budget" -> "blocked"
                              [] OTHER -> IF failures >= MaxRepairs THEN "blocked" ELSE "active"
         bump == applies /\ nextStatus # "active"
     IN /\ (bump => CanBump)
        /\ status' = nextStatus
        /\ generation' = IF bump THEN generation + 1 ELSE generation
        /\ failures' = IF applies /\ ~c.aborted /\ c.verdict = "fail" THEN failures + 1 ELSE failures
        /\ charged' = IF writes THEN charged \cup {p} ELSE charged
        /\ authorizedWrites' = (authorizedWrites /\ (writes => owner = c.writer))
        /\ freshApplications' = (freshApplications /\ (applies => generation = c.gen))
        /\ budgetRepairsOK' = (budgetRepairsOK /\ (applies /\ c.verdict = "budget" => failures' = failures))
        /\ certificate' = IF applies /\ ~c.aborted /\ c.verdict = "pass"
                          THEN [gen |-> c.gen, contract |-> c.contract, checked |-> c.checked, seen |-> c.seen]
                          ELSE certificate
  /\ tickets' = [tickets EXCEPT ![p].phase = "done"]
  /\ UNCHANGED <<owner, alive, approved, pending, obligations, evidence, preservedEvidence>>

Next == (\E s \in Sessions : Claim(s)) \/ Crash \/ Release
        \/ (\E r \in {{"base"}, Requirements} : Approve(r))
        \/ Propose \/ Refine \/ Supplement \/ Resume
        \/ (\E s \in {"paused", "blocked", "skipped"} : Stop(s))
        \/ (\E r \in Requirements : Progress(r))
        \/ (\E p \in Tickets : Start(p) \/ Checks(p, TRUE) \/ Checks(p, FALSE)
              \/ Inspect(p) \/ (\E v \in {"pass", "fail", "budget"} : Verdict(p, v))
              \/ CancelRequest(p) \/ Finish(p))
        \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars

TypeOK == /\ status \in Statuses /\ generation \in 1..MaxGeneration
          /\ owner \in Sessions \cup {0} /\ alive \in BOOLEAN
          /\ approved \in BOOLEAN /\ pending \in BOOLEAN
          /\ obligations \subseteq Requirements /\ "base" \in obligations
          /\ evidence \subseteq obligations /\ charged \subseteq Tickets
          /\ failures \in 0..(MaxRepairs+1)
          /\ DOMAIN tickets = Tickets
          /\ \A p \in Tickets :
               /\ tickets[p].phase \in {"unused", "checks", "inspect", "seen", "result", "done"}
               /\ tickets[p].gen \in 0..MaxGeneration
               /\ tickets[p].writer \in Sessions \cup {0}
NoUnapprovedExecution == status \in {"active", "verifying", "complete"} => approved /\ ~pending
NoUnauthorizedWrites == authorizedWrites
NoStaleApplication == freshApplications
EvidencePreserved == preservedEvidence
BudgetDoesNotConsumeRepairs == budgetRepairsOK
CompleteCertified == status = "complete" =>
  /\ certificate.gen + 1 = generation
  /\ certificate.contract = obligations
  /\ certificate.checked /\ certificate.seen
  /\ evidence = obligations

\* A finite successful environment, not a promise that an arbitrary LLM terminates.
LiveInit == /\ status = "active" /\ generation = 1 /\ owner = 1 /\ alive = TRUE
            /\ approved = TRUE /\ pending = FALSE /\ obligations = {"base"} /\ evidence = {"base"}
            /\ tickets = [p \in Tickets |-> EmptyTicket]
            /\ certificate = EmptyCertificate /\ failures = 0 /\ charged = {}
            /\ authorizedWrites = TRUE /\ freshApplications = TRUE
            /\ preservedEvidence = TRUE /\ budgetRepairsOK = TRUE
LiveNext == Start(1) \/ Checks(1, TRUE) \/ Inspect(1) \/ Verdict(1, "pass") \/ Finish(1)
            \/ (status = "complete" /\ UNCHANGED vars)
UnfairLiveSpec == LiveInit /\ [][LiveNext]_vars
LiveSpec == LiveInit /\ [][LiveNext]_vars
            /\ WF_vars(Start(1)) /\ WF_vars(Checks(1, TRUE)) /\ WF_vars(Inspect(1))
            /\ WF_vars(Verdict(1, "pass")) /\ WF_vars(Finish(1))
EventuallyComplete == <> (status = "complete")
=============================================================================
