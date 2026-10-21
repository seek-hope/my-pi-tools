------------------------- MODULE ContextProtocol -------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS KeepStale, OmitEmpty, DropConversation, AccumulateRules
Sessions == 1..2
Goals == 1..2
Messages == [kind : {"work", "current", "cleared"}, session : Sessions, goal : Goals, gen : 1..2]
VARIABLES session, goals, gen, owned, terminal, projection, hasCurrent, conversation, rendered, policyCopies, rounds
vars == <<session, goals, gen, owned, terminal, projection, hasCurrent, conversation, rendered, policyCopies, rounds>>
Init == /\ session \in Sessions /\ goals \in SUBSET Goals /\ gen \in 1..2
        /\ owned \in BOOLEAN /\ terminal \in SUBSET goals
        /\ projection = {} /\ hasCurrent = FALSE /\ conversation = TRUE /\ rendered = FALSE
        /\ policyCopies = 0 /\ rounds = 0
Project == /\ rounds < 2
           /\ projection' = {m \in Messages : m.kind = "work" /\
                  (KeepStale \/ (owned /\ m.session = session /\ m.goal \in goals \ terminal /\ m.gen = gen))}
           /\ hasCurrent' = ~(OmitEmpty /\ goals = {})
           /\ conversation' = ~DropConversation /\ rendered' = TRUE
           /\ policyCopies' = IF owned /\ goals \ terminal # {}
                              THEN IF AccumulateRules THEN policyCopies + 1 ELSE 1
                              ELSE 0
           /\ rounds' = rounds + 1
           /\ UNCHANGED <<session, goals, gen, owned, terminal>>
Next == Project \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
TypeOK == /\ session \in Sessions /\ goals \subseteq Goals /\ terminal \subseteq goals
          /\ gen \in 1..2 /\ owned \in BOOLEAN /\ projection \subseteq Messages
          /\ hasCurrent \in BOOLEAN /\ conversation \in BOOLEAN /\ rendered \in BOOLEAN
          /\ policyCopies \in 0..2 /\ rounds \in 0..2
OnlyLiveControls == rendered => \A m \in projection :
                       m.kind = "work" /\ owned /\ m.session = session /\
                       m.goal \in goals \ terminal /\ m.gen = gen
EmptyIsExplicit == rendered => hasCurrent
ConversationPreserved == conversation
SinglePolicy == rendered => policyCopies = (IF owned /\ goals \ terminal # {} THEN 1 ELSE 0)
=============================================================================
