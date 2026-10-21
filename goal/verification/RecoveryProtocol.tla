------------------------- MODULE RecoveryProtocol -------------------------
EXTENDS Naturals
CONSTANTS SkipValidation, OverwriteTarget, WrongSession, DropTail, RewriteHistory
VARIABLES sourceValid, lastOwner, liveOwner, target, stage, tail, backup,
          validated, commits, installed, safe, sourceBytes
vars == <<sourceValid, lastOwner, liveOwner, target, stage, tail, backup,
          validated, commits, installed, safe, sourceBytes>>
Init == /\ sourceValid \in BOOLEAN /\ lastOwner \in 1..2 /\ liveOwner \in BOOLEAN
        /\ target \in {"absent", "cleared", "full"} /\ stage = "idle"
        /\ tail \in BOOLEAN /\ backup = FALSE /\ validated = FALSE
        /\ commits = 0 /\ installed = FALSE /\ safe = TRUE /\ sourceBytes = "original"
(* Last-owner session is 1; live ownership and broken chains forbid import.
   The complete lock interval is Start -> Copy -> Install; target changes only idle. *)
Start == /\ stage = "idle"
         /\ (~liveOwner) /\ (lastOwner = 1 \/ WrongSession)
         /\ (sourceValid \/ SkipValidation)
         /\ (target = "absent" \/ OverwriteTarget)
         /\ stage' = "locked" /\ validated' = sourceValid
         /\ UNCHANGED <<sourceValid, lastOwner, liveOwner, target, tail, backup,
                        commits, installed, safe, sourceBytes>>
Copy == /\ stage = "locked" /\ stage' = "copied"
        /\ UNCHANGED <<sourceValid, lastOwner, liveOwner, target, tail, backup,
                       validated, commits, installed, safe, sourceBytes>>
Install == /\ stage = "copied" /\ stage' = "done" /\ target' = "full" /\ installed' = TRUE
           /\ safe' = (safe /\ sourceValid /\ lastOwner = 1 /\ ~liveOwner /\ target = "absent")
           /\ sourceBytes' = IF RewriteHistory THEN "normalized" ELSE sourceBytes
           /\ UNCHANGED <<sourceValid, lastOwner, liveOwner, tail, backup, validated, commits>>
Crash == /\ stage \in {"locked", "copied"} /\ stage' = "idle"
         /\ UNCHANGED <<sourceValid, lastOwner, liveOwner, target, tail, backup,
                        validated, commits, installed, safe, sourceBytes>>
UserClear == /\ stage = "idle" /\ target # "cleared" /\ target' = "cleared"
             /\ UNCHANGED <<sourceValid, lastOwner, liveOwner, stage, tail, backup,
                            validated, commits, installed, safe, sourceBytes>>
Append == /\ stage \in {"idle", "done"} /\ target # "absent" /\ commits < 2
          /\ (sourceValid \/ SkipValidation)
          /\ backup' = (backup \/ (tail /\ ~DropTail))
          /\ tail' = FALSE /\ commits' = commits + 1
          /\ safe' = (safe /\ sourceValid /\ (~tail \/ backup'))
          /\ sourceBytes' = IF RewriteHistory THEN "normalized" ELSE sourceBytes
          /\ UNCHANGED <<sourceValid, lastOwner, liveOwner, target, stage, validated, installed>>
Next == Start \/ Copy \/ Install \/ Crash \/ UserClear \/ Append \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == /\ sourceValid \in BOOLEAN /\ lastOwner \in 1..2 /\ liveOwner \in BOOLEAN
          /\ target \in {"absent", "cleared", "full"}
          /\ stage \in {"idle", "locked", "copied", "done"}
          /\ tail \in BOOLEAN /\ backup \in BOOLEAN /\ validated \in BOOLEAN
          /\ commits \in 0..2 /\ installed \in BOOLEAN /\ safe \in BOOLEAN
          /\ sourceBytes \in {"original", "normalized"}
SafeRecovery == safe
HistoryPreserved == sourceBytes = "original"
AtomicImport == installed => target # "absent"
=============================================================================
