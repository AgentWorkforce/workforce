import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The slack-relayfile-doctor persona spec. A debugging specialist for the
 * Slack ↔ relayfile ↔ cloud sync/writeback stack: it localizes a symptom to
 * the right layer, confirms the root cause with concrete evidence (mount state,
 * the relayfile ops API, prod logs), and prescribes the fix to the owning repo.
 *
 * Source of truth: `personas/slack-relayfile-doctor.json` (with its
 * `slack-relayfile-doctor.md` claudeMd sidecar). This compatibility export
 * keeps programmatic consumers working while the package also acts as an
 * AgentWorkforce installable persona pack.
 */
const persona = require('./personas/slack-relayfile-doctor.json');

export const slackRelayfileDoctorPersona = persona;

export default persona;
