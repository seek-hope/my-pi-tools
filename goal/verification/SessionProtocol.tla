------------------------- MODULE SessionProtocol -------------------------
EXTENDS Naturals, FiniteSets, TLC
CONSTANTS SharedDirectory, GlobalPanel, ClearAll, IgnoreResultFence, IgnoreLease
Sessions == 1..2
Tickets == 1..2
MaxGoals == 2
MaxLeases == 2
Phases == {"none", "active", "verifying", "paused", "complete"}
VARIABLES state, view, shown, tickets, used, finished, isolationOK, resultsOK
vars == <<state, view, shown, tickets, used, finished, isolationOK, resultsOK>>
Route(s) == IF SharedDirectory THEN 1 ELSE s
Visible(records, s) == records[s].goal # 0 /\ records[s].panel
Empty == [goal |-> 0, issued |-> 0, phase |-> "none", panel |-> FALSE,
          owned |-> FALSE, lease |-> 0, certGoal |-> 0]
Init == /\ state = [s \in Sessions |-> Empty]
        /\ view = 1 /\ shown = FALSE
        /\ tickets = [t \in Tickets |-> [session |-> 1, goal |-> 0, lease |-> 0]]
        /\ used = {} /\ finished = {}
        /\ isolationOK = TRUE /\ resultsOK = TRUE

(* Ghost flag compares actual before/after records outside the calling session.
   It is not an assumed invariant: SharedDirectory and ClearAll can falsify it. *)
Publish(next) == /\ state' = next
                 /\ isolationOK' = (isolationOK /\
                       (\A s \in Sessions \ {view} : next[s] = state[s]))
                 /\ shown' = Visible(next, view)

Acquire == LET k == Route(view) IN
           /\ ~state[k].owned /\ state[k].lease < MaxLeases
           /\ state[1].lease + state[2].lease < 3
           /\ Publish([state EXCEPT ![k].owned = TRUE, ![k].lease = @ + 1])
           /\ UNCHANGED <<view, tickets, used, finished, resultsOK>>
ReleaseIdle == LET k == Route(view) IN
               /\ state[k].owned /\ state[k].phase \notin {"active", "verifying"}
               /\ Publish([state EXCEPT ![k].owned = FALSE])
               /\ UNCHANGED <<view, tickets, used, finished, resultsOK>>
Create == LET k == Route(view) IN
          /\ state[k].owned /\ state[k].goal = 0 /\ state[k].issued < MaxGoals
          /\ state[1].issued + state[2].issued < 2
          /\ Publish([state EXCEPT ![k].goal = state[k].issued + 1,
                       ![k].issued = @ + 1, ![k].phase = "active",
                       ![k].panel = TRUE, ![k].certGoal = 0])
          /\ UNCHANGED <<view, tickets, used, finished, resultsOK>>
Pause == LET k == Route(view) IN
         /\ state[k].owned /\ state[k].phase \in {"active", "verifying"}
         /\ Publish([state EXCEPT ![k].phase = "paused"])
         /\ UNCHANGED <<view, tickets, used, finished, resultsOK>>
Resume == LET k == Route(view) IN
          /\ state[k].owned /\ state[k].phase = "paused"
          /\ Publish([state EXCEPT ![k].phase = "active"])
          /\ UNCHANGED <<view, tickets, used, finished, resultsOK>>
Cleared(record) == [record EXCEPT !.goal = 0, !.phase = "none", !.panel = FALSE,
                                  !.owned = FALSE, !.certGoal = 0]
Clear == LET k == Route(view) IN
         /\ state[k].owned
         /\ Publish(IF ClearAll THEN [s \in Sessions |-> Cleared(state[s])]
                    ELSE [state EXCEPT ![k] = Cleared(@)])
         /\ UNCHANGED <<view, tickets, used, finished, resultsOK>>
Panel == LET k == Route(view) IN
         /\ Publish([state EXCEPT ![k].panel = ~@])
         /\ UNCHANGED <<view, tickets, used, finished, resultsOK>>
Switch(s) == /\ s \in Sessions /\ s # view /\ view' = s
             /\ shown' = IF GlobalPanel THEN shown ELSE Visible(state, s)
             /\ UNCHANGED <<state, tickets, used, finished, isolationOK, resultsOK>>
Start(t) == LET k == Route(view) IN
            /\ t \in Tickets \ used /\ state[k].owned /\ state[k].phase = "active"
            /\ Publish([state EXCEPT ![k].phase = "verifying"])
            /\ tickets' = [tickets EXCEPT ![t] =
                  [session |-> view, goal |-> state[k].goal, lease |-> state[k].lease]]
            /\ used' = used \cup {t}
            /\ UNCHANGED <<view, finished, resultsOK>>
Finish(t) == LET stamp == tickets[t]
                 k == Route(view)
                 current == stamp.session = view /\ stamp.goal = state[k].goal
                            /\ stamp.lease = state[k].lease
                 apply == stamp.session = view /\ state[k].owned
                          /\ state[k].phase = "verifying"
                          /\ (IgnoreResultFence \/ (stamp.goal = state[k].goal
                              /\ (IgnoreLease \/ stamp.lease = state[k].lease)))
             IN /\ t \in used \ finished
                /\ finished' = finished \cup {t}
                /\ Publish(IF apply THEN [state EXCEPT ![k].phase = "complete",
                                                        ![k].certGoal = stamp.goal]
                           ELSE state)
                /\ resultsOK' = (resultsOK /\ (~apply \/ current))
                /\ UNCHANGED <<view, tickets, used>>

Next == Acquire \/ ReleaseIdle \/ Create \/ Pause \/ Resume \/ Clear \/ Panel
        \/ (\E s \in Sessions : Switch(s))
        \/ (\E t \in Tickets : Start(t) \/ Finish(t))
        \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == /\ state \in [Sessions -> [goal : 0..MaxGoals, issued : 0..MaxGoals,
                       phase : Phases, panel : BOOLEAN, owned : BOOLEAN,
                       lease : 0..MaxLeases, certGoal : 0..MaxGoals]]
          /\ view \in Sessions /\ shown \in BOOLEAN
          /\ tickets \in [Tickets -> [session : Sessions, goal : 0..MaxGoals,
                                     lease : 0..MaxLeases]]
          /\ finished \subseteq used /\ used \subseteq Tickets
          /\ isolationOK \in BOOLEAN /\ resultsOK \in BOOLEAN
SessionIsolation == isolationOK
PanelBinding == shown = Visible(state, view)
NoStaleResult == resultsOK
CompleteBound == \A s \in Sessions : state[s].phase = "complete" =>
                  (state[s].goal # 0 /\ state[s].certGoal = state[s].goal)
=============================================================================
