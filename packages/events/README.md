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

Consumers that compile the exported contract schemas with AJV must install the
package-owned cross-field keywords before adding the schemas. These enforce
canonical coordinates that JSON Schema cannot express on its own, including
the URL-encoded Composio trigger resource path.

```ts
import addFormats from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  addEventContractJsonSchemaKeywords,
  EVENT_CONTRACT_JSON_SCHEMAS
} from '@agentworkforce/events';

const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
addEventContractJsonSchemaKeywords(ajv);
for (const schema of Object.values(EVENT_CONTRACT_JSON_SCHEMAS)) {
  ajv.addSchema(schema);
}
```
