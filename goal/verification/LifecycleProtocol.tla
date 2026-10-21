----------------------- MODULE LifecycleProtocol -----------------------
EXTENDS Naturals, FiniteSets
CONSTANTS IgnoreCreateIdentity, AutoApplyProposal, IgnoreStop, IgnoreBudget
MaxRevision == 5
MaxInputs == 2
Tickets == 1..2
Contracts == 1..2
VARIABLES revision, status, contract, accepted, pending, inputs, stoppedAfter,
          overBudget, tickets, used, finished, freshCreates, stopRespected, budgetRespected
vars == <<revision, status, contract, accepted, pending, inputs, stoppedAfter,
          overBudget, tickets, used, finished, freshCreates, stopRespected, budgetRespected>>
CanWrite == revision < MaxRevision
Init == /\ revision = 0 /\ status = "none" /\ contract = 0 /\ accepted = 0 /\ pending = 0
        /\ inputs = 0 /\ stoppedAfter = 0 /\ overBudget = FALSE
        /\ tickets = [t \in Tickets |-> [session |-> 1, rev |-> 0]]
        /\ used = {} /\ finished = {}
        /\ freshCreates = TRUE /\ stopRespected = TRUE /\ budgetRespected = TRUE

(* One current session (ID 1). ID 2 represents a request copied from another
   session. Ownership/locking are delegated to the Journal and Session models. *)
Read(t, s) == /\ t \in Tickets \ used /\ s \in 1..2
              /\ tickets' = [tickets EXCEPT ![t] = [session |-> s, rev |-> revision]]
              /\ used' = used \cup {t}
              /\ UNCHANGED <<revision, status, contract, accepted, pending, inputs,
                             stoppedAfter, overBudget, finished, freshCreates, stopRespected, budgetRespected>>
Create(t) == LET fresh == tickets[t].session = 1 /\ tickets[t].rev = revision
                 apply == status = "none" /\ (IgnoreCreateIdentity \/ fresh)
             IN /\ t \in used \ finished /\ CanWrite
                /\ finished' = finished \cup {t}
                /\ status' = IF apply THEN "draft" ELSE status
                /\ revision' = IF apply THEN revision + 1 ELSE revision
                /\ freshCreates' = (freshCreates /\ (~apply \/ fresh))
                /\ UNCHANGED <<contract, accepted, pending, inputs, stoppedAfter, overBudget,
                               tickets, used, stopRespected, budgetRespected>>
Clear == /\ CanWrite /\ revision' = revision + 1 /\ status' = "none"
         /\ contract' = 0 /\ accepted' = 0 /\ pending' = 0 /\ overBudget' = FALSE
         /\ UNCHANGED <<inputs, stoppedAfter, tickets, used, finished,
                        freshCreates, stopRespected, budgetRespected>>
(* Abstract an allowed initial plan. Complex initial scope uses user approval
   in the implementation; heuristic classification is outside this model. *)
InitialPlan(c) == /\ CanWrite /\ status = "draft" /\ contract = 0 /\ c \in Contracts
                  /\ revision' = revision + 1 /\ status' = "active"
                  /\ contract' = c /\ accepted' = c
                  /\ UNCHANGED <<pending, inputs, stoppedAfter, overBudget, tickets, used,
                                 finished, freshCreates, stopRespected, budgetRespected>>
Propose(c) == /\ CanWrite /\ status \in {"active", "paused", "draft"} /\ contract # 0
              /\ c \in Contracts \ {contract}
              /\ revision' = revision + 1 /\ pending' = c
              /\ status' = IF AutoApplyProposal THEN "active" ELSE "draft"
              /\ contract' = IF AutoApplyProposal THEN c ELSE contract
              /\ UNCHANGED <<accepted, inputs, stoppedAfter, overBudget, tickets, used,
                             finished, freshCreates, stopRespected, budgetRespected>>
UserApprove == /\ CanWrite /\ status = "draft" /\ pending # 0
               /\ revision' = revision + 1 /\ status' = "active"
               /\ contract' = pending /\ accepted' = pending /\ pending' = 0
               /\ UNCHANGED <<inputs, stoppedAfter, overBudget, tickets, used, finished,
                              freshCreates, stopRespected, budgetRespected>>
Stop == /\ CanWrite /\ status = "active"
        /\ revision' = revision + 1 /\ status' = "paused" /\ stoppedAfter' = inputs
        /\ UNCHANGED <<contract, accepted, pending, inputs, overBudget, tickets, used,
                       finished, freshCreates, stopRespected, budgetRespected>>
ExhaustBudget == /\ CanWrite /\ status = "active" /\ ~overBudget
                 /\ revision' = revision + 1 /\ status' = "paused"
                 /\ stoppedAfter' = inputs /\ overBudget' = TRUE
                 /\ UNCHANGED <<contract, accepted, pending, inputs, tickets, used,
                                finished, freshCreates, stopRespected, budgetRespected>>
UserInput == /\ CanWrite /\ inputs < MaxInputs
             /\ revision' = revision + 1 /\ inputs' = inputs + 1
             /\ UNCHANGED <<status, contract, accepted, pending, stoppedAfter, overBudget,
                            tickets, used, finished, freshCreates, stopRespected, budgetRespected>>
ModelResume == /\ CanWrite /\ status = "paused" /\ pending = 0 /\ contract = accepted
               /\ (IgnoreStop \/ inputs > stoppedAfter) /\ (IgnoreBudget \/ ~overBudget)
               /\ revision' = revision + 1 /\ status' = "active"
               /\ stopRespected' = (stopRespected /\ (inputs > stoppedAfter))
               /\ budgetRespected' = (budgetRespected /\ ~overBudget)
               /\ UNCHANGED <<contract, accepted, pending, inputs, stoppedAfter, overBudget,
                              tickets, used, finished, freshCreates>>
Next == (\E t \in Tickets : (\E s \in 1..2 : Read(t, s)) \/ Create(t))
        \/ Clear \/ (\E c \in Contracts : InitialPlan(c) \/ Propose(c))
        \/ UserApprove \/ Stop \/ ExhaustBudget \/ UserInput \/ ModelResume
        \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == /\ revision \in 0..MaxRevision /\ status \in {"none", "draft", "active", "paused"}
          /\ contract \in 0..2 /\ accepted \in 0..2 /\ pending \in 0..2
          /\ inputs \in 0..MaxInputs /\ stoppedAfter \in 0..MaxInputs
          /\ overBudget \in BOOLEAN /\ used \subseteq Tickets /\ finished \subseteq used
          /\ tickets \in [Tickets -> [session : 1..2, rev : 0..MaxRevision]]
          /\ freshCreates \in BOOLEAN /\ stopRespected \in BOOLEAN /\ budgetRespected \in BOOLEAN
NoStaleCreation == freshCreates
ApprovedExecution == status = "active" => contract = accepted /\ pending = 0
StopBoundary == stopRespected
ResumeBudget == budgetRespected
=============================================================================
