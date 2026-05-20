# Claude.ai Discussion Regarding Supercession (Trageti + Cairn)

You said: I suppose I'm somewhat concerned that we're creating a sense of binary assertions. It could work perhaps if handled well, but in terms of our immediate use case -- Cairn -- humans are rarely so straightforward about _anything_. Factual assertions about a person may be binary -- "married" vs. "divorced" -- but they can also be nuanced. Mental health information may be even more so. But again it depends on how information is broken down, I guess.

11:33 AM
Claude responded: You're right to flag this, and it's worth thinking through carefully before it becomes a design assumption baked into the data model.
You're right to flag this, and it's worth thinking through carefully before it becomes a design assumption baked into the data model.

Where the binary assumption creeps in

The supersession model as designed implies: assertion A was true, then assertion B replaced it, and now B is the current understanding. One thing at a time, clean handoff. That works well for facts that genuinely flip — a diagnosis changes, a relationship status changes, a goal is met.

But clinical reality is rarely that clean. Consider:

A patient's relationship with her mother is "complicated and painful" in session 3. In session 11 she discloses abuse. In session 15 she expresses grief and love alongside the pain. In session 20 she describes a partial reconciliation. None of these replace each other — they layer. The session 3 understanding isn't wrong, it's incomplete. The session 11 disclosure doesn't supersede the earlier observation, it deepens it.
A patient reports anxiety as 7/10 in session 4, 4/10 in session 8, 8/10 in session 14 after a stressor, 5/10 in session 18. There's no supersession here at all — these are measurements on a continuous dimension over time, and the pattern is the meaning.
A patient holds two contradictory beliefs simultaneously — "I know I'm capable" and "I feel fundamentally worthless" — and the therapeutic work is precisely about that tension. Neither supersedes the other. They coexist and the relationship between them is itself clinically significant.
What the model actually needs

The supersession chain is the right model for one specific relationship between assertions — genuine replacement, where later understanding makes earlier understanding obsolete. It should stay exactly as designed for that case.

But it's not the only relationship assertions can have. The trl_links table already exists and supports typed relationships between assertions. The missing piece is recognizing that some of those link types are specifically about how understanding accumulates rather than replaces:

deepens — B adds nuance or dimension to A without replacing it. Both remain valid.
contradicts — B is in tension with A; the tension itself is clinically significant. Neither supersedes the other.
contextualizes — B changes how A should be interpreted without changing A's factual content.
qualifies — B limits or conditions A. "Usually avoids conflict" qualified by "except when she feels safe."
measures — B is a data point in a series. The series has meaning; individual readings don't supersede each other.
These are all link types, not supersession events. The assertion model doesn't need to change — it needs to be used differently. Supersession is for replacement. Links are for everything else.

The practical implication for Cairn

The extraction pipeline needs to make this distinction explicitly. When a new session produces content related to an existing assertion, the extraction pass should be asking not just "does this supersede prior understanding" but "what is the relationship between this new observation and the existing one?" The answer determines whether the output is a supersession (write new assertion with supersedesId) or a link (write new assertion and a typed link to the prior one, both remain valid).

This is actually a more demanding prompt task than pure supersession detection — but it's also more honest about clinical reality. And it produces richer data: a theme with five deepens links is telling you something different than a theme that's been superseded three times.

The good news is the data model already supports this. Nothing needs to change in trageti — the link types taxonomy just needs to expand to include accumulation relationships alongside the structural ones that are currently there. That's a one-line addition to the recommended vocabulary, not a redesign.

You said: Can you give me an example of this type of layering using trageti's proposed v0.
Can you give me an example of this type of layering using trageti's proposed v0.2 api?

11:35 AM
Claude responded: Sure.
Sure. Let me walk through a realistic scenario using the API as specified.

The scenario

A patient's relationship with her mother. Across six sessions it never "changes" in the binary sense — it deepens, complicates, and accumulates meaning.

Session 3 — initial observation

typescript
// Register the episode
store.writeEpisode({
id: 'ep-003',
namespace: 'patient-0047',
position: 3,
occurredAt: '2024-01-18T10:00:00Z',
type: 'session',
content: 'Session 3 summary...'
})

// Write the initial assertion
store.writeAssertion({
id: 'a-003-001',
namespace: 'patient-0047',
type: 'fact',
content: 'Patient describes relationship with mother as complicated and painful; avoids discussing specifics',
validFrom: 3,
validUntil: null,
confidence: 0.85,
sourceEpisodeId: 'ep-003',
supersedesId: null,
entityId: 'theme-mother-relationship',
entityType: 'theme',
citations: [{
id: 'cit-003-001',
assertionId: 'a-003-001',
episodeId: 'ep-003',
sourceRef: 'chunk:2',
excerpt: 'I don\'t really want to talk about my mom. It\'s just... complicated.',
excerptStart: '0:08:42',
excerptEnd: '0:08:51'
}]
})
Nothing superseded. One assertion, currently valid, anchored to position 3.

Session 11 — abuse disclosure

This doesn't replace session 3's observation. It deepens it — we now understand why it was complicated and painful. Both remain true simultaneously.

typescript
store.writeEpisode({
id: 'ep-011',
namespace: 'patient-0047',
position: 11,
occurredAt: '2024-03-14T10:00:00Z',
type: 'session',
content: 'Session 11 summary...'
})

// New assertion — does NOT supersede a-003-001
store.writeAssertion({
id: 'a-011-001',
namespace: 'patient-0047',
type: 'recontextualization',
content: 'Patient disclosed emotional abuse by mother throughout childhood; prior avoidance of topic now understood as protective rather than incidental',
validFrom: 11,
validUntil: null,
confidence: 0.95,
sourceEpisodeId: 'ep-011',
supersedesId: null, // not a replacement — both assertions remain valid
entityId: 'theme-mother-relationship',
entityType: 'theme',
citations: [{
id: 'cit-011-001',
assertionId: 'a-011-001',
episodeId: 'ep-011',
sourceRef: 'chunk:4',
excerpt: 'She used to tell me I was too sensitive, that nothing I felt was real. Every day.',
excerptStart: '0:31:14',
excerptEnd: '0:31:24'
}]
})

// Link the two assertions — deepens, not supersedes
store.writeLink({
id: 'link-011-001',
namespace: 'patient-0047',
fromId: 'a-011-001',
toId: 'a-003-001',
linkType: 'deepens',
validFrom: 11,
validUntil: null,
sourceEpisodeId: 'ep-011'
})
Now both assertions are active. The link says: the session 11 assertion deepens — but does not replace — the session 3 one.

Session 15 — grief and love alongside the pain

A third layer. She loves her mother and she was hurt by her. Neither the pain nor the love cancels the other. This coexists with both prior assertions.

typescript
store.writeAssertion({
id: 'a-015-001',
namespace: 'patient-0047',
type: 'fact',
content: 'Patient expressed grief and love for mother alongside pain from abuse; describes missing who her mother "could have been"',
validFrom: 15,
validUntil: null,
confidence: 0.90,
sourceEpisodeId: 'ep-015',
supersedesId: null,
entityId: 'theme-mother-relationship',
entityType: 'theme',
citations: [{
id: 'cit-015-001',
assertionId: 'a-015-001',
episodeId: 'ep-015',
sourceRef: 'chunk:3',
excerpt: 'I still love her. I hate that I love her. She\'s my mom.',
excerptStart: '0:19:08',
excerptEnd: '0:19:15'
}]
})

// Links to both prior assertions
store.writeLink({
id: 'link-015-001',
namespace: 'patient-0047',
fromId: 'a-015-001',
toId: 'a-011-001',
linkType: 'contradicts', // love and abuse coexist in tension
validFrom: 15,
validUntil: null,
sourceEpisodeId: 'ep-015'
})

store.writeLink({
id: 'link-015-002',
namespace: 'patient-0047',
fromId: 'a-015-001',
toId: 'a-003-001',
linkType: 'deepens',
validFrom: 15,
validUntil: null,
sourceEpisodeId: 'ep-015'
})
Now a genuinely binary event — session 20

She decides to cut contact with her mother. This is a state change — "in contact" becomes "no contact." This one warrants supersession.

typescript
// Prior status assertion (written back in session 3 or intake)
// a-intake-contact: "Patient is in regular contact with mother"

store.writeAssertion({
id: 'a-020-001',
namespace: 'patient-0047',
type: 'update',
content: 'Patient has decided to cease contact with mother; decision described as deliberate and considered',
validFrom: 20,
validUntil: null,
confidence: 0.95,
sourceEpisodeId: 'ep-020',
supersedesId: 'a-intake-contact', // THIS one supersedes — genuine state change
entityId: 'theme-mother-contact-status',
entityType: 'status',
citations: [{
id: 'cit-020-001',
assertionId: 'a-020-001',
episodeId: 'ep-020',
sourceRef: 'chunk:5',
excerpt: 'I\'ve decided I\'m not going to call her anymore. I need some space to heal.',
excerptStart: '0:44:20',
excerptEnd: '0:44:31'
}]
})
writeAssertion() automatically closes a-intake-contact by setting its valid_until = 20 in the same transaction.

What retrieval looks like at session 22

typescript
const context = store.assembleContext({
namespace: 'patient-0047',
queryEmbedding: await embed('mother relationship'),
queryText: 'mother',
temporalAnchor: 22,
tokenBudget: 1500,
mode: 'trajectory',
expandLinks: true
})
What comes back:

All three theme-mother-relationship assertions are active and valid at position 22 — none superseded each other
Each carries its citation with the verbatim excerpt
expandLinks: true pulls in the typed links between them, so the context block shows not just what was observed but how those observations relate
The contact status assertion (a-020-001) is also retrieved, with a-intake-contact in its supersessionChain showing the state change
The assembled prose block gives the note generation model a genuinely layered picture: complicated and painful from the start, abuse disclosed in session 11, grief and love coexisting since session 15, contact ended at session 20
The key distinction in the data

Three assertions about theme-mother-relationship, all with valid_until: null, all simultaneously active. The relationship between them is in the links, not in supersession. The contact status has a clean supersession because it actually flipped.

This is the difference between accumulation and replacement — and it shows up clearly in the API usage. When you find yourself reaching for supersedesId: null and writeLink() instead of supersedesId: 'prior-id', that's the signal that you're dealing with layering rather than replacement.

You said: I guess the real challenge in Cairn, then, is going to be figuring out how to direct the indexing system using trageti.
I guess the real challenge in Cairn, then, is going to be figuring out how to direct the indexing system using trageti...

11:42 AM
Claude responded: Yes.
Yes. And it's worth being precise about where the hard part actually lives.

trageti's job is simple

The library stores what it's given. It doesn't decide whether something is a supersession or a deepening. It doesn't decide whether two observations about the same patient should be linked as contradicts or coexists. It just persists assertions, enforces the validity window constraints, and retrieves correctly by temporal position.

The library is a filing system with good retrieval. It has no opinion about what gets filed or how it's categorized.

Cairn's job is hard

Cairn has to make all the decisions trageti doesn't. After each session, the extraction pipeline has to answer questions like:

Is this new observation about the mother relationship a replacement of prior understanding, or does it layer on top?
If it layers, what's the relationship — does it deepen, contradict, qualify, contextualize?
Which prior assertions does it relate to? One? Several?
How confident are we in that classification?
And these are questions a local 4B–9B model is being asked to answer, from a transcript chunk, with imperfect context about what came before.

The specific failure modes to design around

Over-supersession. The model decides something is a replacement when it's actually an addition. You lose accumulation — the layered picture flattens into a sequence of replacements, and the depth is gone. This is probably the most common failure mode because supersession is the simpler mental model and the model will default to it.

Under-supersession. The opposite — the model treats a genuine state change as a new layer. Now you have two contradictory active assertions with no supersession relationship, and retrieval returns both as equally valid current understanding. This is less common but harder to catch.

Wrong link type. The model links two assertions as deepens when it should be contradicts, or vice versa. The data is structurally correct but semantically imprecise. Less catastrophic than the above two, but it degrades the quality of context the model gets in future sessions.

Missing links entirely. The model writes a new assertion correctly but doesn't establish any link to the related prior assertion. The new assertion floats free, not connected to the accumulating picture. Over time the graph becomes sparse and expandLinks returns less and less useful context.

How to design around them

The three-tier extraction architecture in the v0.6 spec already points in the right direction — decomposed narrow passes rather than one broad synthesis. That principle needs to extend to the supersession/link classification decision specifically.

The extraction prompt should not be asking: "write an assertion and decide if it supersedes anything." That collapses two distinct decisions into one and invites the model to take the path of least resistance.

Instead, the prompt sequence should be:

Step 1: Extract what happened in this chunk as a raw observation. No classification yet. Just: what was said, what was observed?

Step 2: Given this observation and the list of existing active assertions for this entity, ask: does this observation change any existing assertion, add to it, or is it entirely new? Force a classification: replaces | adds-to | new.

Step 3: If replaces — write with supersedesId. If adds-to — write without supersedesId and classify the link type. If new — write without either.

Separating steps 2 and 3 means the model is never choosing between supersession and linking in one pass — it first decides the relationship category, then decides the specific relationship type within that category. Narrower decisions, less surface area for error.

The validation surface

This is also where Anna's review is most valuable and most irreplaceable. The approval UI surfaces not just "here's a proposed assertion" but "here's the proposed relationship to prior assertions." She can see: the model thinks this supersedes the session 3 observation — does it? And her correction is the most precise possible training signal, because she's not correcting the assertion content, she's correcting the structural relationship. That's exactly the thing the model will consistently get wrong in domain-specific ways that are hard to capture any other way.

Over time her correction patterns tell you: this model tends to over-supersede emotional observations but gets factual state changes right. That's actionable for prompt refinement and eventually for fine-tuning.

The honest uncertainty

How well a local 4B–9B model can reliably make the supersession-vs-accumulation distinction in clinical text is genuinely unknown until you test it. The decomposed prompt approach reduces the risk significantly. Anna's review catches the failures. But there's a real possibility that this particular classification is harder than note generation or entity extraction — it requires understanding not just what was said but the clinical relationship between observations across time, which is a more abstract reasoning task.

If the model consistently gets it wrong, the fallback is: default everything to adds-to and let Anna promote to supersession in the review UI when she sees a genuine replacement. That's conservative, slightly more work for Anna, but it preserves the layered picture at the cost of some curation overhead. Better to over-accumulate than to over-supersede.
