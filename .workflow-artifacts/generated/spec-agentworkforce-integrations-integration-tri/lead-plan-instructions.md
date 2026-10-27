# Lead Plan Instructions

Plan the workflow execution from the packaged context files, not from the short task prompt.

Required sections:

- Non-goals
- Routing contract
- Implementation contract
- Deliverables
- Verification gates

Use this exact section heading in the lead plan. Do not rename "Non-goals" to "Out of scope" or another synonym.

Write .workflow-artifacts/generated/spec-agentworkforce-integrations-integration-tri/lead-plan.md and end it with GENERATION_LEAD_PLAN_READY.

Generation-time skill boundary:

- Read .workflow-artifacts/generated/spec-agentworkforce-integrations-integration-tri/skill-application-boundary.json and treat it as generator metadata only.
- Skills are applied by Ricky during selection, loading, and template rendering.
- Do not claim generated agents load, retain, or embody skill files at runtime unless a future runtime test proves that path.

Loaded skills summary:

choosing-swarm-patterns confidence=1 reason=Spec text mentions "agents". Spec text mentions "agent". Spec text mentions "relay". Spec text mentions "covers". Spec text mentions "core". Spec text mentions "decision". evidence=keyword:agents, keyword:agent, keyword:relay, keyword:covers, keyword:core, keyword:decision
relay-80-100-workflow confidence=1 reason=Spec text mentions "writing". Spec text mentions "must". Spec text mentions "before". Spec text mentions "covers". Spec text mentions "code". Spec text mentions "works". Spec text mentions "validation". Spec text mentions "test". Spec text mentions "mock". Spec text mentions "after". Spec text mentions "every". Spec text mentions "full". Spec text mentions "implementation". Spec text mentions "through". Spec text mentions "tests". evidence=keyword:writing, keyword:must, keyword:before, keyword:covers, keyword:code, keyword:works, keyword:validation, keyword:test, keyword:mock, keyword:after, keyword:every, keyword:full, keyword:implementation, keyword:through, keyword:tests
review-fix-signoff-loop confidence=1 reason=Spec text mentions "writing". Spec text mentions "agent". Spec text mentions "relay". Spec text mentions "must". Spec text mentions "validation". Spec text mentions "independent". Spec text mentions "agents". Spec text mentions "both". Spec text mentions "work". Spec text mentions "covers". evidence=keyword:writing, keyword:agent, keyword:relay, keyword:must, keyword:validation, keyword:independent, keyword:agents, keyword:both, keyword:work, keyword:covers
writing-agent-relay-workflows confidence=1 reason=Spec text mentions "building". Spec text mentions "relay". Spec text mentions "covers". Spec text mentions "agents". Spec text mentions "test". Spec text mentions "error". Spec text mentions "event". evidence=keyword:building, keyword:relay, keyword:covers, keyword:agents, keyword:test, keyword:error, keyword:event
