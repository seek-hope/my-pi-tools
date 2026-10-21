-------------------------- MODULE JournalProtocol --------------------------
EXTENDS Naturals, Sequences, FiniteSets
CONSTANTS WriterCount, MaxCommits, IgnoreLock, IgnoreOwnership
Writers == 1..WriterCount
Kinds == {"claim", "write", "release"}
VARIABLES journal, alive, locks, phase, kind, snapshot, snapshotOwner,
          snapshotData, authorizedCommits
vars == <<journal, alive, locks, phase, kind, snapshot, snapshotOwner,
          snapshotData, authorizedCommits>>
Revision == Len(journal)
Owner == IF journal = <<>> THEN 0 ELSE journal[Revision].owner
Data == IF journal = <<>> THEN 0 ELSE journal[Revision].data
Allowed(w, k) == IF k = "claim" THEN Owner = 0 \/ Owner = w \/ Owner \notin alive
                 ELSE Owner = w
Init == /\ journal = <<>> /\ alive = Writers /\ locks = {}
        /\ phase = [w \in Writers |-> "idle"]
        /\ kind = [w \in Writers |-> "write"]
        /\ snapshot = [w \in Writers |-> 0]
        /\ snapshotOwner = [w \in Writers |-> 0]
        /\ snapshotData = [w \in Writers |-> 0]
        /\ authorizedCommits = TRUE

\* mkdir(transaction.lock), read/validate latest snapshot, mutate+append, unlock.
Begin(w, k) == /\ w \in alive /\ phase[w] = "idle" /\ Revision < MaxCommits
               /\ (IgnoreLock \/ locks = {})
               /\ phase' = [phase EXCEPT ![w] = "locked"]
               /\ locks' = locks \cup {w} /\ kind' = [kind EXCEPT ![w] = k]
               /\ UNCHANGED <<journal, alive, snapshot, snapshotOwner, snapshotData, authorizedCommits>>
Read(w) == /\ w \in alive /\ w \in locks /\ phase[w] = "locked"
           /\ (IgnoreOwnership \/ Allowed(w, kind[w]))
           /\ phase' = [phase EXCEPT ![w] = "ready"]
           /\ snapshot' = [snapshot EXCEPT ![w] = Revision]
           /\ snapshotOwner' = [snapshotOwner EXCEPT ![w] = Owner]
           /\ snapshotData' = [snapshotData EXCEPT ![w] = Data]
           /\ UNCHANGED <<journal, alive, locks, kind, authorizedCommits>>
Commit(w) == /\ w \in alive /\ w \in locks /\ phase[w] = "ready" /\ Revision < MaxCommits
             /\ journal' = Append(journal,
                  [rev |-> snapshot[w] + 1, parent |-> snapshot[w], writer |-> w, op |-> kind[w],
                   owner |-> CASE kind[w] = "claim" -> w [] kind[w] = "release" -> 0
                               [] OTHER -> snapshotOwner[w],
                   data |-> snapshotData[w] + IF kind[w] = "write" THEN 1 ELSE 0])
             /\ authorizedCommits' = (authorizedCommits /\ Allowed(w, kind[w]))
             /\ phase' = [phase EXCEPT ![w] = "idle"] /\ locks' = locks \ {w}
             /\ UNCHANGED <<alive, kind, snapshot, snapshotOwner, snapshotData>>
Abandon(w) == /\ w \in alive /\ w \in locks
              /\ locks' = locks \ {w} /\ phase' = [phase EXCEPT ![w] = "idle"]
              /\ UNCHANGED <<journal, alive, kind, snapshot, snapshotOwner, snapshotData, authorizedCommits>>
Crash(w) == /\ w \in alive /\ alive' = alive \ {w}
            /\ UNCHANGED <<journal, locks, phase, kind, snapshot, snapshotOwner, snapshotData, authorizedCommits>>
\* Manual stale-lock recovery is legal only after that process is known dead.
Recover(w) == /\ w \in locks /\ w \notin alive
              /\ locks' = locks \ {w} /\ phase' = [phase EXCEPT ![w] = "idle"]
              /\ UNCHANGED <<journal, alive, kind, snapshot, snapshotOwner, snapshotData, authorizedCommits>>
Next == (\E w \in Writers :
           (\E k \in Kinds : Begin(w, k)) \/ Read(w) \/ Commit(w) \/ Abandon(w) \/ Crash(w) \/ Recover(w))
        \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == /\ alive \subseteq Writers /\ locks \subseteq Writers
          /\ phase \in [Writers -> {"idle", "locked", "ready"}]
          /\ kind \in [Writers -> Kinds]
          /\ Len(journal) <= MaxCommits /\ Owner \in Writers \cup {0}
OneTransaction == Cardinality(locks) <= 1
AuthorizedCommits == authorizedCommits
ChainIntegrity == \A i \in 1..Len(journal) : journal[i].rev = i /\ journal[i].parent = i-1
NoLostUpdates == \A i \in 1..Len(journal) :
                   journal[i].data = (IF i = 1 THEN 0 ELSE journal[i-1].data)
                                    + (IF journal[i].op = "write" THEN 1 ELSE 0)
=============================================================================
