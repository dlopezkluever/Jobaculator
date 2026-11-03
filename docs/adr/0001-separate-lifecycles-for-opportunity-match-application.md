# Opportunity, Match, and Application have separate lifecycles

PRD §53 sketched one state machine running from DISCOVERED to an offer. We split it across three objects, because those states describe different things and change for different reasons. An **Opportunity** tracks only the posting (open or closed). A **Match** holds one Hunt's judgement of one Opportunity (qualified or not, Fit Score, policy decision). An **Application** exists only once some Match decides to apply, and there is never more than one per Opportunity. A single state machine would have forced a skipped job to carry an Application, and would have let a second Hunt's judgement overwrite the first's.

## Consequences

- No Application is ever created for a job that was skipped. "DUPLICATE" is not a state: duplicate sightings merge into the existing Opportunity.
- When several Hunts want the same Opportunity, the highest-fit one becomes the Application's **driving Hunt** and sets its positioning. The decision follows autonomy by default: any qualifying Match that wants to apply wins over Skips from other Hunts, and an explicit Review rule in any qualifying Match is honoured. Review is opt-in and is never added by default.
- The Application keeps a frozen copy of the evaluation and policy that authorized it, so editing a Hunt later never rewrites history.
