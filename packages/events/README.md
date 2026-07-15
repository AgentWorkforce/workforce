# @agentworkforce/events

Canonical, transport-independent Event wire contracts for AgentWorkforce.

```ts
import { decodeEventFrame, getEventContract } from '@agentworkforce/events';

const decoded = decodeEventFrame(input);
const contract = getEventContract(decoded.frame.type, decoded.frame.contractVersion);
```

`decodeEventFrame` accepts the canonical `EventFrameV1` and the legacy
Workforce gateway envelope. Legacy decoding is explicit in the returned
`compatibility` metadata. Known versioned frames reject unknown top-level
fields; forward-compatible data belongs in `extensions`.
