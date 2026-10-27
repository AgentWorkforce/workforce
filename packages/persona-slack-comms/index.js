import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The slack-comms persona spec. A comms-only Slack liaison for a multi-agent
 * engineering team: it relays human Slack messages to the agent team and
 * surfaces team milestones, decisions, blockers, and security incidents back to
 * humans via relayfile writeback. It never writes code.
 *
 * Source of truth: `personas/slack-comms.json` (with its `slack-comms.md`
 * agentsMd sidecar). This compatibility export keeps programmatic consumers
 * working while the package also acts as an AgentWorkforce installable persona
 * pack.
 */
const persona = require('./personas/slack-comms.json');

export const slackCommsPersona = persona;

export default persona;
