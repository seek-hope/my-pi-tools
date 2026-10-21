------------------------- MODULE PermissionProtocol -------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS IgnoreFence, ReuseOtherKey, IgnoreOverrides, IgnoreScope
Keys == 1..2
Kinds == {"local", "external", "network", "install"}
VARIABLES epoch, mode, askNetwork, askInstall, phase, grants, dialog, safe
vars == <<epoch, mode, askNetwork, askInstall, phase, grants, dialog, safe>>
Need(k) == (k = "external" /\ mode = "confirm") \/ (k = "network" /\ askNetwork) \/ (k = "install" /\ askInstall)
Init == /\ epoch = 1 /\ mode \in {"autonomous", "confirm"}
        /\ askNetwork \in BOOLEAN /\ askInstall \in BOOLEAN
        /\ phase = "active" /\ grants = {}
        /\ dialog = [open |-> FALSE, key |-> 1, epoch |-> 1]
        /\ safe = TRUE
Request(key, kind) ==
  LET needed == Need(kind)
      cached == key \in grants \/ (ReuseOtherKey /\ grants # {})
      scope == phase = "active"
      prompt == needed /\ ~cached /\ ~(IgnoreOverrides /\ mode = "autonomous")
      execute == (scope \/ IgnoreScope) /\ ~prompt
  IN /\ ~dialog.open /\ key \in Keys /\ kind \in Kinds
     /\ dialog' = IF (scope \/ IgnoreScope) /\ prompt
                    THEN [open |-> TRUE, key |-> key, epoch |-> epoch] ELSE dialog
     /\ safe' = (safe /\ (~execute \/ (scope /\ (~needed \/ key \in grants))))
     /\ UNCHANGED <<epoch, mode, askNetwork, askInstall, phase, grants>>
Answer(accepted) ==
  LET fresh == dialog.epoch = epoch /\ phase = "active"
      execute == accepted /\ (fresh \/ IgnoreFence)
  IN /\ dialog.open /\ accepted \in BOOLEAN
     /\ grants' = IF execute THEN grants \cup {dialog.key} ELSE grants
     /\ safe' = (safe /\ (~execute \/ fresh))
     /\ dialog' = [dialog EXCEPT !.open = FALSE]
     /\ UNCHANGED <<epoch, mode, askNetwork, askInstall, phase>>
Change(m, n, i, p) == /\ epoch < 3 /\ m \in {"autonomous", "confirm"}
                       /\ n \in BOOLEAN /\ i \in BOOLEAN /\ p \in {"active", "draft", "paused"}
                       /\ epoch' = epoch + 1 /\ mode' = m /\ askNetwork' = n /\ askInstall' = i
                       /\ phase' = p /\ grants' = {}
                       /\ UNCHANGED <<dialog, safe>>
Next == (\E key \in Keys, k \in Kinds : Request(key, k))
        \/ (\E a \in BOOLEAN : Answer(a))
        \/ (\E m \in {"autonomous", "confirm"}, n \in BOOLEAN, i \in BOOLEAN,
                p \in {"active", "draft", "paused"} : Change(m, n, i, p))
        \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == /\ epoch \in 1..3 /\ mode \in {"autonomous", "confirm"}
          /\ askNetwork \in BOOLEAN /\ askInstall \in BOOLEAN
          /\ phase \in {"active", "draft", "paused"} /\ grants \subseteq Keys
          /\ dialog \in [open : BOOLEAN, key : Keys, epoch : 1..3] /\ safe \in BOOLEAN
AuthorizedOperations == safe
=============================================================================
